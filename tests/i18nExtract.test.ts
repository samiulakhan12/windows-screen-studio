/**
 * The extraction codemod (docs/design/output-and-languages.md §10.2, §10.3): on a fixture component
 * the proposed source renders exactly what the original renders (text, attributes and notices, for
 * several counts and states), JSX whitespace is React's, templates become messages with named
 * placeholders, `n === 1 ? …` becomes a plural that chooses as the condition did, keycaps stay, and
 * what cannot be made identical is listed for a hand edit. The command writes a patch and a proposal
 * and changes no source file.
 */
import { spawnSync } from 'node:child_process'
import fs from 'node:fs'
import path from 'node:path'
import ts from 'typescript'
import { afterAll, describe, expect, it } from 'vitest'
import { formatIcu, parseIcu } from '../src/shared/i18n/icu'
import { englishTree, makeTree, removeTree, REPO, toolsTree } from './i18nFixtures'

type Row = { key: string; file: string; line: number; english: string | string[]; sample: object | object[] }
type Result = { edits: object[]; messages: Record<string, string>; meta: Record<string, { description: string }>; log: Row[]; manual: { line: number; reason: string }[]; needsImport: boolean }
const extract = require('../scripts/i18n/lib/extract.cjs') as {
  extractSource(o: { file: string; text: string; ns: string; taken?: Set<string>; english?: Record<string, string> }): Result
  applyEdits(file: string, text: string, r: Result): string
  logProblems(rows: Row[], format: (key: string, values: Record<string, unknown>) => string): string[]
  jsxRenderedText(raw: string): string
}

const trees: string[] = []
afterAll(() => trees.forEach(removeTree))

const FILE = 'src/renderer/src/editor/ClipCard.tsx'
const SOURCE = `import { showNotice } from './notice'
const TITLE = 'Module title'
export function ClipCard({ name, n, busy }: { name: string; n: number; busy: boolean }) {
  showNotice(\`Saved \${name}\`, { action: { label: 'Undo' } })
  showNotice(TITLE)
  return (
    <div title="Close panel" aria-label={busy ? 'Saving…' : 'Save'}>
      <b>Bold</b> and more&nbsp;text
      {n} {n === 1 ? 'clip' : 'clips'}
      <p>{\`\${n} \${n === 1 ? 'file' : 'files'} in \${name}\`}</p>
      <kbd>Esc</kbd>
      {'Joined ' + name}
      <ul>{[1, 2].map((i) => <li key={i} title="Item">Row</li>)}</ul>
    </div>
  )
}
`

/** Runs a component's source with a tiny JSX runtime and returns what it renders and the notices it shows. */
function render(source: string, messages: Record<string, string>, props: object): string {
  const js = ts.transpileModule(source, { compilerOptions: { jsx: ts.JsxEmit.React, jsxFactory: 'h', jsxFragmentFactory: 'Frag', module: ts.ModuleKind.CommonJS, target: ts.ScriptTarget.ES2022 } }).outputText
  const notices: string[] = []
  const t = (key: string, values: Record<string, unknown> = {}) => formatIcu<string>(parseIcu(messages[key]), values, { language: 'en', formatLocale: 'en-US' }).join('')
  const req = (spec: string) => (spec.endsWith('i18n/t') ? { t } : { showNotice: (m: string, o?: { action?: { label: string } }) => notices.push(`${m}|${o?.action?.label ?? ''}`) })
  const h = (type: unknown, attrs: Record<string, unknown> | null, ...children: unknown[]) => ({ type, attrs: attrs ?? {}, children })
  const mod = { exports: {} as Record<string, (p: object) => unknown> }
  new Function('h', 'Frag', 'require', 'module', 'exports', js)(h, 'Frag', req, mod, mod.exports)
  const flat = (node: unknown): string => {
    if (node === null || node === undefined || typeof node === 'boolean') return ''
    if (Array.isArray(node)) return node.map(flat).join('')
    if (typeof node !== 'object') return String(node)
    const n = node as { type: string; attrs: Record<string, unknown>; children: unknown[] }
    const attrs = Object.entries(n.attrs)
      .filter(([k]) => k !== 'key')
      .map(([k, v]) => ` ${k}=${JSON.stringify(v)}`)
      .join('')
    return `<${n.type}${attrs}>${n.children.map(flat).join('')}</${n.type}>`
  }
  return flat(mod.exports.ClipCard(props)) + '\n' + notices.join('\n')
}

describe('the extraction codemod', () => {
  const r = extract.extractSource({ file: FILE, text: SOURCE, ns: 'editor', taken: new Set(['editor.clipCard.save']) })
  const after = extract.applyEdits(FILE, SOURCE, r)

  it('proposes messages with named placeholders, plurals on count and keys by component', () => {
    expect(r.messages).toEqual({
      'editor.clipCard.saved': 'Saved {name}',
      'editor.clipCard.undo': 'Undo',
      'editor.clipCard.closePanel': 'Close panel',
      'editor.clipCard.saving': 'Saving…',
      'editor.clipCard.save2': 'Save',
      'editor.clipCard.bold': 'Bold',
      'editor.clipCard.andMoreText': ' and more\u00a0text',
      'editor.clipCard.clips': '{count, plural, =1 {clip} other {clips}}',
      'editor.clipCard.inFiles': '{n} {count, plural, =1 {file} other {files}} in {name}',
      'editor.clipCard.item': 'Item',
      'editor.clipCard.row': 'Row'
    })
    expect(r.meta['editor.clipCard.closePanel'].description).toBe(`clipCard, the title of <div> (${FILE}:7).`)
    expect(after).toContain("import { t } from '../../../shared/i18n/t'")
    expect(after).toContain("{t('editor.clipCard.inFiles', { n: String(n), name: String(name), count: n })}")
    expect(after).toContain('<kbd>Esc</kbd>')
  })

  it('renders exactly what the original rendered, for each count and state', () => {
    for (const n of [0, 1, 2, 1000]) {
      for (const busy of [true, false]) {
        const props = { name: 'Demo «x»', n, busy }
        expect(render(after, r.messages, props), `n=${n} busy=${busy}`).toBe(render(SOURCE, {}, props))
      }
    }
  })

  it('lists for a hand edit what it cannot make identical', () => {
    expect(r.manual.map((m) => [m.line, m.reason.split(':')[0]])).toEqual([
      [2, 'made when the module loads'],
      [12, 'a sentence joined with +']
    ])
    expect(after).toContain("const TITLE = 'Module title'")
    expect(after).toContain("{'Joined ' + name}")
  })

  it('logs each literal with the samples that reproduce it, which test 69 formats back', () => {
    const format = (key: string, values: Record<string, unknown>) => formatIcu<string>(parseIcu(r.messages[key]), values, { language: 'en', formatLocale: 'en-US' }).join('')
    expect(extract.logProblems(r.log, format)).toEqual([])
    const plural = r.log.find((row) => row.key === 'editor.clipCard.inFiles')!
    expect(plural.english).toEqual(['0 files in «name»', '1 file in «name»', '2 files in «name»', '1000 files in «name»'])
    // A message that no longer gives the literal, and a plural without its four samples, are reported.
    const broken: Record<string, string> = { ...r.messages, 'editor.clipCard.undo': 'Undo it' }
    const formatBroken = (key: string, values: Record<string, unknown>) => formatIcu<string>(parseIcu(broken[key]), values, { language: 'en', formatLocale: 'en-US' }).join('')
    expect(extract.logProblems(r.log, formatBroken)).toEqual([`editor.clipCard.undo (${FILE}:4): gives "Undo it" where the code showed "Undo"`])
    const short = [{ ...plural, english: (plural.english as string[]).slice(0, 2), sample: (plural.sample as object[]).slice(0, 2) }]
    expect(extract.logProblems(short, format)).toEqual([`editor.clipCard.inFiles (${FILE}:10): a plural needs the samples 0, 1, 2, 1000`])
  })

  it('takes JSX whitespace and entities as React renders them', () => {
    expect(extract.jsxRenderedText('\n    Export the video\n  ')).toBe('Export the video')
    expect(extract.jsxRenderedText(' and ')).toBe(' and ')
    expect(extract.jsxRenderedText('a&nbsp;b &amp; c')).toBe('a\u00a0b & c')
    expect(extract.jsxRenderedText('\n  first line\n  second line\n')).toBe('first line second line')
  })

  it('writes a patch and a proposal through the command and changes no source file', () => {
    const root = makeTree({ ...englishTree({ editor: {} }), ...toolsTree(), [FILE]: SOURCE, 'src/renderer/src/editor/notice.ts': 'export const showNotice = (m: string): void => void m\n' })
    trees.push(root)
    const out = path.join(root, 'out')
    const r2 = spawnSync(process.execPath, [path.join(REPO, 'scripts/i18n/extract.mjs'), '--root', root, '--ns', 'editor', '--files', FILE, '--out', out], { encoding: 'utf8' })
    expect(r2.status).toBe(0)
    expect(fs.readFileSync(path.join(root, FILE), 'utf8')).toBe(SOURCE)
    const patch = fs.readFileSync(path.join(out, 'extract.patch'), 'utf8')
    expect(patch).toContain(`--- a/${FILE}`)
    expect(patch).toContain(`+++ b/${FILE}`)
    expect(patch).toContain("+    <div title={t('editor.clipCard.closePanel')}")
    const proposal = JSON.parse(fs.readFileSync(path.join(out, 'proposal.json'), 'utf8')) as { messages: Record<string, string>; log: Row[]; manual: object[] }
    expect(Object.keys(proposal.messages).length).toBe(11)
    expect(proposal.manual.length).toBe(2)
    const bad = spawnSync(process.execPath, [path.join(REPO, 'scripts/i18n/extract.mjs'), '--root', root, '--ns', 'editor', '--files', '../outside.ts', '--out', out], { encoding: 'utf8' })
    expect(bad.status).toBe(1)
  })
})
