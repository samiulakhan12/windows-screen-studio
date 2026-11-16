/**
 * Tests 61 and 86 (docs/design/output-and-languages.md §16.1, §16.2, §23.1): the string scanner finds
 * every kind of UI text without a key in fixture files, and lets through what is keyed, allowed or not
 * text; it sorts findings into failures, a report and the other account's pending texts; and main's
 * run-time import graph uses only the common, errors and main namespaces, the preload none, and no
 * source file imports a meta file.
 */
import fs from 'node:fs'
import path from 'node:path'
import { afterAll, describe, expect, it } from 'vitest'
import { englishTree, makeTree, removeTree, REPO, toolsTree, writeTree } from './i18nFixtures'

type Finding = { file: string; line: number; kind: string; text: string }
const scan = require('../scripts/i18n/lib/scan.cjs') as {
  scanSource(file: string, text: string, rules?: { keys?: Set<string>; allow?: object }): Finding[]
  scanTree(root: string, opts?: { mode?: string }): { failures: Finding[]; report: Finding[]; pending: Finding[]; allowed: Finding[]; words: Finding[]; files: number }
  mainNamespaces(entry: string, root?: string): Set<string>
  importGraph(entry: string): Set<string>
  metaImporters(root?: string): string[]
}

const trees: string[] = []
afterAll(() => trees.forEach(removeTree))

const T_IMPORT = "import { t } from '../../shared/i18n/t'\nimport { T } from '../i18n/T'\n"
const found = (file: string, text: string, keys?: Set<string>) => scan.scanSource(file, text, keys ? { keys } : {})
const kinds = (list: Finding[]) => list.map((f) => `${f.kind}:${f.text}`)

describe('test 61: the scanner finds UI text without a key', () => {
  it('finds JSX text and literal children, and not whitespace, symbols, keycaps or keyed text', () => {
    const src = `${T_IMPORT}export function A({ n }: { n: number }) {
  return (
    <div>
      Export the video
      {' '}·{' '}
      {n === 1 ? 'file' : 'files'}
      <T k="codecs.row.codec" />
      {t('codecs.row.codec')}
      <kbd>Esc</kbd>
    </div>
  )
}`
    expect(kinds(found('src/renderer/src/editor/A.tsx', src))).toEqual(['jsx:Export the video', 'jsx:file', 'jsx:files'])
  })

  it('finds each listed attribute with a literal or a template, and both branches of a condition', () => {
    const src = `export const B = ({ name, busy }: { name: string; busy: boolean }) => (
  <>
    <button aria-label="Close" />
    <span title={\`Rename \${name}\`} />
    <input placeholder={busy ? 'Saving…' : 'Name'} />
    <img alt="Camera preview" />
    <div role="slider" aria-valuetext="50 percent" aria-roledescription="Volume knob" />
    <option label="Fastest" />
    <span title={name} data-testid="not-text" className="also not text" />
  </>
)`
    expect(kinds(found('src/renderer/src/B.tsx', src))).toEqual([
      'attr:Close',
      'attr:Rename ${…}',
      'attr:Saving…',
      'attr:Name',
      'attr:Camera preview',
      'attr:50 percent',
      'attr:Volume knob',
      'attr:Fastest'
    ])
  })

  it('finds every sink: notices, status, errors, dialogs, notifications, taskbar tooltips and confirmations', () => {
    const src = `import { dialog } from 'electron'
const LEAVE = 'Leave the editor anyway?'
export function run(win: unknown, deps: { confirm(m: string): boolean }, showNotice: (m: string, o?: object) => void, setStatus: (s: object | string) => void) {
  showNotice('Zoom added', { action: { label: 'Undo' }, ms: 4000 })
  setStatus('Saving…')
  setStatus({ state: 'error', message: 'Could not save' })
  dialog.showSaveDialog(win as never, { title: 'Save video', buttonLabel: 'Export', filters: [{ name: 'MP4 video', extensions: ['mp4'] }] })
  dialog.showMessageBox({ message: 'Replace it?', detail: 'The old file goes away.', buttons: ['Replace', 'Cancel'] })
  new Notification({ title: 'Export finished', body: 'Your video is ready.' })
  ;(win as { setThumbarButtons(b: object[]): void }).setThumbarButtons([{ tooltip: 'Pause', click: () => undefined }])
  if (!confirm('Delete this project?')) return
  window.confirm('Delete this recording?')
  alert('Done')
  deps.confirm(LEAVE)
  throw new Error('The export failed.')
}`
    expect(kinds(found('src/main/run.ts', src))).toEqual([
      'sink:Leave the editor anyway?',
      'sink:Zoom added',
      'sink:Undo',
      'sink:Saving…',
      'sink:Could not save',
      'sink:Save video',
      'sink:Export',
      'sink:MP4 video',
      'sink:Replace it?',
      'sink:The old file goes away.',
      'sink:Replace',
      'sink:Cancel',
      'sink:Export finished',
      'sink:Your video is ready.',
      'sink:Pause',
      'sink:Delete this project?',
      'sink:Delete this recording?',
      'sink:Done',
      'sink:The export failed.'
    ])
    // The constant is reported where it is written.
    expect(found('src/main/run.ts', src)[0].line).toBe(2)
  })

  it('finds t() and <T> made when a module loads, and not inside functions or instance fields', () => {
    const src = `${T_IMPORT}const TITLE = t('codecs.row.codec')
const NODE = <T k="codecs.row.codec" />
const later = () => t('codecs.row.codec')
class Panel { label = t('codecs.row.codec'); static heading = t('codecs.row.codec') }
export function F() { return <T k="codecs.row.codec" /> }
void TITLE; void NODE; void later; void Panel`
    expect(found('src/renderer/src/editor/F.tsx', src).map((f) => [f.kind, f.line])).toEqual([
      ['module-scope-t', 3],
      ['module-scope-t', 4],
      ['module-scope-t', 6]
    ])
  })

  it('finds a locale-less toLocaleString and Intl constructor, and ignores Intl.Segmenter and given locales', () => {
    const src = `export function G(n: number, d: Date) {
  const a = n.toLocaleString()
  const b = d.toLocaleDateString(undefined, { month: 'short' })
  const c = new Intl.NumberFormat()
  const d2 = new Intl.DateTimeFormat(undefined, { hour: 'numeric' })
  const e = n.toLocaleString('en-US')
  const f = new Intl.Segmenter(undefined, { granularity: 'word' })
  const g = new Intl.NumberFormat('en-US')
  const h = Intl.DateTimeFormat().format(d)
  return [a, b, c, d2, e, f, g, h]
}`
    expect(found('src/shared/G.ts', src).map((f) => [f.kind, f.line])).toEqual([
      ['locale', 2],
      ['locale', 3],
      ['locale', 4],
      ['locale', 5],
      ['locale', 9]
    ])
  })

  it('finds a key English does not have', () => {
    const src = `${T_IMPORT}export const H = () => <p title={t('codecs.nope')}>{t('codecs.row.codec')}<T k="codecs.gone" /></p>`
    expect(kinds(found('src/renderer/src/H.tsx', src, new Set(['codecs.row.codec'])))).toEqual(['key:codecs.nope', 'key:codecs.gone'])
  })

  it('leaves out what allow.json explains', () => {
    const src = `export function check(ok: boolean) {
  if (!ok) throw new Error('Not allowed')
  throw new Error('The export failed.')
}`
    const allow = { texts: [{ pattern: '^Not allowed$', kinds: ['sink'] }], sites: [{ file: 'src/main/*.ts', kind: 'sink', text: 'The export failed.' }] }
    expect(scan.scanSource('src/main/x.ts', src, { allow })).toEqual([])
    expect(kinds(scan.scanSource('src/main/x.ts', src, { allow: { texts: [{ pattern: '^Not allowed$', kinds: ['jsx'] }] } }))).toEqual(['sink:Not allowed', 'sink:The export failed.'])
  })

  it('reports the other account’s files as pending, fails a failFor file before S4 and reports the rest', () => {
    const root = makeTree({
      ...englishTree({ codecs: { 'row.codec': 'Codec' } }),
      ...toolsTree({ failFor: ['src/renderer/src/editor/New.tsx'], pending: { files: [{ path: 'src/main/recording/**', reason: 'other account' }] } }),
      'src/renderer/src/editor/New.tsx': 'export const N = () => <b>New text</b>\n',
      'src/renderer/src/editor/Old.tsx': 'export const O = () => <b>Old text</b>\n',
      'src/main/recording/session.ts': "export const fail = () => { throw new Error('Recording failed') }\n",
      'src/renderer/src/editor/Keyed.tsx': "import { t } from '../../../shared/i18n/t'\nexport const K = () => <b>{t('codecs.row.codec')}</b>\n"
    })
    trees.push(root)
    const r = scan.scanTree(root)
    expect(r.files).toBe(4)
    expect(kinds(r.failures)).toEqual(['jsx:New text'])
    expect(kinds(r.report)).toEqual(['jsx:Old text'])
    expect(kinds(r.pending)).toEqual(['sink:Recording failed'])
    // After S4 the whole tree fails, and the other account's files stay pending.
    const after = scan.scanTree(root, { mode: 'fail' })
    expect(kinds(after.failures)).toEqual(['jsx:New text', 'jsx:Old text'])
    expect(kinds(after.pending)).toEqual(['sink:Recording failed'])
    writeTree(root, toolsTree({ scan: 'fail', pending: { files: [{ path: 'src/main/recording/**' }] } }))
    expect(kinds(scan.scanTree(root).failures)).toEqual(['jsx:New text', 'jsx:Old text'])
  })

  it('holds every file the parts create to the rule, and lists the other account’s files as pending', () => {
    const cfg = JSON.parse(fs.readFileSync(path.join(REPO, 'scripts/i18n/config.json'), 'utf8')) as { failFor: string[] }
    const r = scan.scanTree(REPO)
    expect(r.failures.filter((f) => cfg.failFor.includes(f.file))).toEqual([])
    const pendingFiles = new Set(r.pending.map((f) => f.file))
    for (const f of pendingFiles) expect(f).toMatch(/^src\/(main\/recording\/|main\/recordingIpc\.ts|main\/windows\.ts|main\/appSettings\.ts|shared\/recording\/|renderer\/src\/views\/Toolbar\.|renderer\/src\/recorder\/)/)
    expect([...pendingFiles].some((f) => f.startsWith('src/renderer/src/recorder/'))).toBe(true)
  })

  it('from step S4 holds the whole tree to the rule, and from S4b to its words rule: config.json says fail, and no UI text of ours is without a key', () => {
    const cfg = JSON.parse(fs.readFileSync(path.join(REPO, 'scripts/i18n/config.json'), 'utf8')) as { scan: string; words: string }
    expect(cfg.scan).toBe('fail')
    // Step S4b: word tables, copy and sentences made of pieces fail too (scan.cjs WORD_KINDS).
    expect(cfg.words).toBe('fail')
    const r = scan.scanTree(REPO)
    expect(r.failures.map((f) => `${f.file}:${f.line} ${f.kind}: ${f.text}`)).toEqual([])
    expect(r.report).toEqual([])
    expect(r.words).toEqual([])
    // Only the other account's files wait (section 9.5).
    expect(r.pending.length).toBeGreaterThan(0)
  })
})

describe('test 86: bundles carry only their own messages', () => {
  it('main’s run-time graph uses only the common, errors and main namespaces', () => {
    const used = scan.mainNamespaces('src/main/index.ts', REPO)
    for (const ns of used) expect(['common', 'errors', 'main']).toContain(ns)
    expect(used.has('main')).toBe(true)
  })

  it('the preload imports nothing from src/shared/i18n, and no source file imports a meta file', () => {
    const graph = [...scan.importGraph(path.join(REPO, 'src/preload/index.ts'))]
    expect(graph.length).toBeGreaterThan(5)
    expect(graph.filter((f) => f.split(path.sep).join('/').includes('/src/shared/i18n/'))).toEqual([])
    expect(scan.metaImporters(REPO)).toEqual([])
  })

  it('notices a main that carries the renderer’s namespaces, a renderer key in main, and a meta import', () => {
    const root = makeTree({
      ...englishTree({ common: { x: 'X' }, errors: { a: 'A' }, main: { b: 'B' }, export: { c: 'C' }, codecs: { d: 'D' } }),
      'src/shared/i18n/t.ts': 'export const t = (k: string): string => k\n',
      'src/shared/i18n/messages/en/index.ts': "import e from './export.json'\nimport c from './codecs.json'\nexport default [e, c]\n",
      'src/shared/i18n/messages/en/main.ts': "import m from './main.json'\nexport default m\n",
      'src/main/index.ts': "import { t } from '../shared/i18n/t'\nconst KEYS = ['errors.a']\nexport const go = (x: string) => [t(`common.${x}`), KEYS]\n",
      'src/main/late.ts': "import { t } from '../shared/i18n/t'\nexport const late = () => t('codecs.d')\n",
      'src/renderer/src/x.ts': "import type m from '../../shared/i18n/messages/en/export.meta.json'\nexport type M = typeof m\n"
    })
    trees.push(root)
    // A key in a table, and a key template's namespace.
    expect([...scan.mainNamespaces('src/main/index.ts', root)].sort()).toEqual(['common', 'errors'])
    writeTree(root, { 'src/main/index.ts': "import '../shared/i18n/messages/en/main'\nexport const go = 1\n" })
    expect([...scan.mainNamespaces('src/main/index.ts', root)].sort()).toEqual(['main'])
    writeTree(root, { 'src/main/index.ts': "import '../shared/i18n/messages/en/index'\nimport { late } from './late'\nexport const go = late\n" })
    expect([...scan.mainNamespaces('src/main/index.ts', root)].sort()).toEqual(['codecs', 'export'])
    expect(scan.metaImporters(root)).toEqual(['src/renderer/src/x.ts'])
  })
})
