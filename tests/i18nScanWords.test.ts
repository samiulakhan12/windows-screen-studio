/**
 * Test 61, the words rule of step S4b (docs/design/output-and-languages.md §9.1, §9.3, §16.1): the
 * scanner sees UI words the sink rules cannot see. It finds each kind of word table (labels, names,
 * hints and sentences in object and array literals, maps keyed by ids, tables named for their words,
 * getters, functions a table holds, Map entries, a component's own text prop), copy a function returns
 * or builds, and each kind of sentence made of pieces; it passes ids, CSS values, file-format words,
 * paths, logs, comparisons, message keys and tables already extracted. Its findings were a report
 * (config.json "words") while S4b's builders worked; since S4b's integration they fail, and the whole
 * tree has none (tests/i18nScan.test.ts holds the tree to it).
 */
import fs from 'node:fs'
import path from 'node:path'
import { afterAll, describe, expect, it } from 'vitest'
import { englishTree, makeTree, removeTree, REPO, toolsTree, writeTree } from './i18nFixtures'

type Finding = { file: string; line: number; kind: string; text: string }
type Rules = { keys?: Set<string>; messages?: Record<string, string>; merge?: Set<string>; words?: boolean; allow?: object }
const scan = require('../scripts/i18n/lib/scan.cjs') as {
  WORD_KINDS: readonly string[]
  scanSource(file: string, text: string, rules?: Rules): Finding[]
  scanTree(root: string, opts?: { mode?: string; wordsMode?: string }): { failures: Finding[]; report: Finding[]; pending: Finding[]; allowed: Finding[]; words: Finding[]; files: number }
}
const checks = require('../scripts/i18n/lib/checks.cjs') as { runChecks(root: string, o?: { report?: boolean }): { errors: string[]; notes: string[] } }

const trees: string[] = []
afterAll(() => trees.forEach(removeTree))

const T_IMPORT = "import { t } from '../../shared/i18n/t'\n"
/** The words rule's findings in a source, as kind:text, with the English messages and merge keys given. */
function words(file: string, src: string, messages: Record<string, string> = {}, merge: string[] = []): string[] {
  const rules = { words: true, keys: new Set(Object.keys(messages)), messages, merge: new Set(merge) }
  return scan
    .scanSource(file, src, rules)
    .filter((f) => scan.WORD_KINDS.includes(f.kind))
    .map((f) => `${f.kind}:${f.text}`)
}

describe('test 61, words rule: word tables', () => {
  it('finds labels, names, titles, hints, notes and sentences in object and array literals', () => {
    const src = `export const TIERS = [
  { id: 'fast', label: 'Fast', hint: 'Quickest; for slower PCs.' },
  { id: 'best', label: 'Most accurate', note: 'Needs 12 GB of memory.' }
]
export const LOOKS = [{ id: 'glass', name: 'Glass Pill', description: 'Frosted glass behind each line' }]
export const steps = { waiting: (name: string) => \`Waiting to copy to \${name}\`, saved: 'Saved to your folder.' }`
    expect(words('src/shared/speech/x.ts', src)).toEqual([
      'table:Fast',
      'table:Quickest; for slower PCs.',
      'table:Most accurate',
      'table:Needs 12 GB of memory.',
      'table:Glass Pill',
      'table:Frosted glass behind each line',
      'table:Waiting to copy to ${…}',
      'table:Saved to your folder.'
    ])
  })

  it('finds maps keyed by ids, tables named for their words, getters, functions a table holds, Map entries and lists of names', () => {
    const src = `export const SPEECH_TIER_NAMES = { fast: 'Fast', standard: 'Standard', best: 'Most accurate' }
export const KIND_WORDS = { zoom: ['zoom', 'zooms'], shape: ['shape', 'shapes'] }
export const FIND = {
  get label() { return 'Find chapters' },
  get hint() { return 'Runs on this PC: nothing is uploaded.' }
}
export const COPY = { offline: (size: string): string => \`This PC is offline. Connect to download the model (\${size}).\` }
export const PURPOSE = new Map([['fast', 'Quickest; for slower PCs.']])
export const MOODS = ['Calm', 'Upbeat', 'Lo-fi']`
    expect(words('src/shared/speech/y.ts', src)).toEqual([
      'table:Fast',
      'table:Standard',
      'table:Most accurate',
      'table:zoom',
      'table:zooms',
      'table:shape',
      'table:shapes',
      'table:Find chapters',
      'table:Runs on this PC: nothing is uploaded.',
      'table:This PC is offline. Connect to download the model (${…}).',
      'table:Quickest; for slower PCs.',
      'table:Calm',
      'table:Upbeat',
      'table:Lo-fi'
    ])
  })

  it("finds a failure's words and a save dialog's file type, and passes their ids and CSS filters", () => {
    const src = `export function fail(id: string) {
  patch(id, { status: 'error', error: 'The provider wrote nothing; try again.' })
  return { ok: false, error: 'The file could not be read.' }
}
export const KINDS = { html: { ext: 'html', filter: 'Web page' }, pdf: { ext: 'pdf', filter: 'PDF' } }
export const LOOK = { filter: 'blur(4px) saturate(1.2)', error: 'error' }`
    expect(words('src/main/guide/save.ts', src)).toEqual(['table:The provider wrote nothing; try again.', 'table:The file could not be read.', 'table:Web page'])
  })

  it("finds a component's own text prop and copy a function returns, builds or throws", () => {
    const src = `class VersionError extends Error {}
export function phase(p: string, what: string, where: string, local: boolean): string {
  if (p === 'gone') throw new VersionError('This version could not be read.')
  const head = local ? 'Stays on this PC' : \`Sends \${what} to \${where}\`
  if (p === 'loading') return 'Loading the speech model…'
  return head
}
export const Row = () => <Section hint="Only before a pause: back-to-back captions replace each other." />`
    expect(words('src/renderer/src/editor/Row.tsx', src)).toEqual([
      'copy:This version could not be read.',
      'copy:Stays on this PC',
      'copy:Sends ${…} to ${…}',
      'copy:Loading the speech model…',
      'table:Only before a pause: back-to-back captions replace each other.'
    ])
  })

  it('finds copy in lower case, one capitalised word returned or handed on, a sentence that starts "A ", an Error class’s message and a warning', () => {
    const src = `import { AiOutputError } from '../captions/transcriptText'
class StopError extends Error {}
export function run(busy: boolean, on: boolean, cut: boolean, label: string): string {
  if (cut) throw new AiOutputError(cut ? 'it was cut off' : 'no list')
  if (!busy) throw new StopError('stopped early')
  setSaid(\`\${label}'s screenshot \${on ? 'will be sent' : 'will not be sent'}.\`)
  onCopy(label, 'Tags')
  setWarning('The file could not be read.')
  const note = 'A new version'
  return busy ? 'Stop' : note
}
export const Blur = () => <Slider format={(v: number) => (v === 0 ? 'Off' : String(v))} />`
    expect(words('src/renderer/src/editor/run.tsx', src)).toEqual([
      'copy:it was cut off',
      'copy:no list',
      'copy:stopped early',
      'copy:will be sent',
      'copy:will not be sent',
      'copy:Tags',
      'copy:The file could not be read.',
      'copy:A new version',
      'copy:Stop',
      'copy:Off'
    ])
  })

  it('passes a key’s name for shortcutLabel, logs and two lower-case words that are not an Error’s message', () => {
    const src = `export function keys(e: KeyboardEvent): string {
  console.warn('it was cut off here')
  warnOnce('the cache is gone now')
  const mode = 'fit width'
  if (e.key === 'Enter') return shortcutLabel('Delete')
  return mode
}`
    expect(words('src/renderer/src/editor/keys.ts', src)).toEqual([])
  })

  it('passes ids, CSS values, fonts, file-format words, paths, logs, comparisons, keys and extracted tables', () => {
    const src = `${T_IMPORT}const log = (m: string) => m
export const DATA = [
  { id: 'top-left', kind: 'zoom', value: 'auto', easing: 'ease-in-out', keywords: 'start stop playback preview' },
  { background: 'linear-gradient(90deg, #fff, #000)', font: "600 14px 'Segoe UI', sans-serif", boxShadow: '0 0 4px rgba(0,0,0,.4)', position: 'top left' },
  { mime: 'image/png', fileName: 'flown-export.mp4', url: 'https://example.com/x', ext: '.mp4' },
  { stack: "'Segoe UI Variable Display', 'Segoe UI', system-ui, sans-serif", args: ['-c:v', 'libx264'] },
  ['mp4', 'webm', 'video/mp4', 'pop\${1}', \`\${2}px\`]
]
export const FFMPEG_TEXTS = { 'The disk is full.': 'errors.diskFull', 'The file is in use by another app.': 'errors.export.inUse' }
export const KEYED = [{ id: 'aurora', label: 'style.look.aurora' }, { id: 'ocean', get label() { return t('codecs.row.codec') } }]
export function check(message: string): boolean {
  console.warn('The export could not start.')
  log('Saving the project now.')
  return message === 'Cancelled.' || message.startsWith('Something went wrong')
}
export const SHOWN = { title: 'Make captions on this PC' }`
    expect(words('src/shared/render/z.ts', src, { 'codecs.row.codec': 'Codec' })).toEqual(['table:Make captions on this PC'])
  })

  it('leaves to the sink rules what they report, and reads no type, import or switch case as text', () => {
    const src = `import { showNotice } from './notice'
type Mode = 'Make captions' | 'Use anyway'
export function run(mode: Mode): string {
  showNotice('Zoom added', { action: { label: 'Undo' }, ms: 4000 })
  switch (mode) {
    case 'Make captions':
      return 'Captions are made on this PC.'
    default:
      return ''
  }
}`
    expect(scan.scanSource('src/renderer/src/editor/run.ts', src, { words: true }).map((f) => `${f.kind}:${f.text}`)).toEqual([
      'sink:Zoom added',
      'sink:Undo',
      'copy:Captions are made on this PC.'
    ])
  })
})

describe('test 61, words rule: sentences made of pieces', () => {
  const messages = {
    'x.press': 'Press {key} to split at the playhead,',
    'x.select': 'select a clip and',
    'x.cut': 'to cut it.',
    'x.suffix': ' · automatic: change it to keep it when you direct again',
    'x.capped': 'limited to {side} px on the long side',
    'x.upscaled': 'larger than the recording: it will be upscaled',
    'x.one': 'Window recordings get auto zoom.',
    'x.two': 'Moving the window is fine.',
    'x.name': 'Codec',
    'x.hold': 'Hold for',
    'x.lead': 'Export',
    'x.noun': 'file'
  }

  it('finds a message joined with English words, English words in a placeholder, pieces side by side, joined pieces and a piece on its own', () => {
    const src = `${T_IMPORT}import { Rich } from './Rich'
export const tier = (): string => \`\${t('x.name')} (slow)\`
export const only = (): string => t('x.name') + ' only'
export const what = (): string => t('x.capped', { side: 'the long side' })
export const Hint = () => (
  <p>
    {t('x.press', { key: 'S' })}{' '}
    {t('x.select')}{' '}
    <Rich k="x.cut" />
  </p>
)
export function resolution(): string {
  const notes: string[] = []
  notes.push(t('x.capped', { side: '1080' }))
  notes.push(t('x.upscaled'))
  return notes.join('; ')
}
export const sentence = (): string => [t('x.select'), t('x.cut')].join(' ')
export const title = (auto: boolean): string => \`\${t('x.name')}\${auto ? t('x.suffix') : ''}\``
    expect(words('src/renderer/src/editor/panels/Hint.tsx', src, messages)).toEqual([
      'fragment:x.name with "${…} (slow)"',
      'fragment:x.name with "only"',
      'fragment:x.capped with "the long side" in {side}',
      'fragment:x.press + x.select + x.cut side by side in one element',
      'fragment:x.capped + x.upscaled joined by "; "',
      'fragment:x.select + x.cut joined by " "',
      'fragment:x.suffix reads as a piece: " · automatic: change it to keep it when you direct again"'
    ])
  })

  it('passes merge groups, whole sentences side by side, lists of facts, punctuation, ids in placeholders and labels before a control', () => {
    const src = `${T_IMPORT}export const Button = ({ n }: { n: number }) => (
  <button>
    {t('x.lead')}
    {n}
    {t('x.noun')}
  </button>
)
export const Hint = () => (
  <p>
    {t('x.one')} {t('x.two')}
  </p>
)
export const facts = (): string => [t('x.one'), t('x.two')].join(' · ')
export const label = (n: number): string => \`\${t('x.name')}: \${n}\`
export const kind = (): string => t('x.capped', { side: 'zoom' })
export const Hold = () => <label>{t('x.hold')} <input /></label>
export const shown = { title: 'Make captions on this PC' }`
    expect(words('src/renderer/src/editor/panels/Pass.tsx', src, messages, ['x.lead', 'x.noun'])).toEqual(['table:Make captions on this PC'])
  })
})

describe('test 61, words rule: a report while S4b’s builders worked, failures since its integration', () => {
  it('sorts the words apart from the other findings: a report, failures once config.json says fail, the other account’s pending', () => {
    const root = makeTree({
      ...englishTree({ codecs: { 'row.codec': 'Codec' } }),
      ...toolsTree({ scan: 'fail', pending: { files: [{ path: 'src/main/recording/**', reason: 'other account' }] } }),
      'src/shared/speech/copy.ts': "export const COPY = { checking: 'Checking this PC…', quality: 'Quality' }\n",
      'src/main/recording/names.ts': "export const NAMES = { top: 'Top left corner' }\n",
      'src/renderer/src/a.tsx': "import { t } from '../../shared/i18n/t'\nexport const A = () => <b>{t('codecs.row.codec')}</b>\n",
      'src/shared/i18n/built/shipped.json': []
    })
    trees.push(root)
    const r = scan.scanTree(root)
    expect(r.failures).toEqual([])
    expect(r.report).toEqual([])
    expect(r.words.map((f) => `${f.file} ${f.kind}:${f.text}`)).toEqual(['src/shared/speech/copy.ts table:Checking this PC…', 'src/shared/speech/copy.ts table:Quality'])
    expect(r.pending.map((f) => `${f.kind}:${f.text}`)).toEqual(['table:Top left corner'])
    // npm run i18n:check reports them and passes.
    const report = checks.runChecks(root)
    expect(report.errors).toEqual([])
    expect(report.notes.some((n) => n.startsWith('scan: words report: 2 table text(s), 0 copy text(s) and 0 sentence(s) in pieces in 1 file(s)'))).toBe(true)
    // Once config.json says "words": "fail", they fail.
    writeTree(root, { 'scripts/i18n/config.json': { scan: 'fail', words: 'fail', failFor: [] } })
    expect(scan.scanTree(root).failures.map((f) => `${f.kind}:${f.text}`)).toEqual(['table:Checking this PC…', 'table:Quality'])
    expect(checks.runChecks(root).errors).toEqual([
      'src/shared/speech/copy.ts:1: UI text without a key (table): "Checking this PC…"',
      'src/shared/speech/copy.ts:1: UI text without a key (table): "Quality"'
    ])
    // allow.json's sites take a pattern over the text.
    writeTree(root, { 'scripts/i18n/allow.json': { files: [], texts: [], sites: [{ file: 'src/shared/speech/*.ts', kind: 'table', pattern: '^Qual', reason: 'test' }] } })
    expect(scan.scanTree(root).failures.map((f) => `${f.kind}:${f.text}`)).toEqual(['table:Checking this PC…'])
  })

  it('fails for the whole tree since S4b: config.json says fail, and no word table, copy or sentence in pieces of ours is left', () => {
    const cfg = JSON.parse(fs.readFileSync(path.join(REPO, 'scripts/i18n/config.json'), 'utf8')) as { words?: string }
    expect(cfg.words).toBe('fail')
    const r = scan.scanTree(REPO)
    expect(r.words).toEqual([])
    expect(r.failures.filter((f) => scan.WORD_KINDS.includes(f.kind)).map((f) => `${f.file}:${f.line} ${f.kind}: ${f.text}`)).toEqual([])
  })
})
