/**
 * Tests 62 and 63 (docs/design/output-and-languages.md §16.2, §9.3, §23.1): the catalogue checks
 * refuse every broken translation the design names and accept ZWJ and ZWNJ; the English checks find
 * an unused key, a used key English lacks, a missing meta entry and a merge group without its whole
 * sentence; and the full run fails on any of them.
 */
import { afterAll, describe, expect, it } from 'vitest'
import { englishTree, makeTree, removeTree, toolsTree, writeTree } from './i18nFixtures'

type Problem = { code: string; message: string; level: 'error' | 'stale'; key?: string }
type Entry = { text: string; state: string; sourceHash: string; reviewedBy?: string; approvedBy?: string }
const catalogue = require('../scripts/i18n/lib/catalogue.cjs') as {
  checkMessage(lang: string, english: string, meta: object, translated: Entry, glossary?: object[], reviewers?: object[]): Problem[]
  checkEnglish(messages: Record<string, string>, meta: Record<string, object>, usedKeys: { has(k: string): boolean; called?: Set<string> }): Problem[]
  usedKeysOf(root: string): { called: Set<string>; mentioned: Set<string>; has(k: string): boolean }
}
const files = require('../scripts/i18n/lib/files.cjs') as { sourceHash(s: string): string }
const checks = require('../scripts/i18n/lib/checks.cjs') as { runChecks(root: string, o?: { report?: boolean }): { errors: string[]; warnings: string[] } }

const trees: string[] = []
afterAll(() => trees.forEach(removeTree))

const REVIEWERS = [
  { id: 'rina', name: 'Rina', languages: ['bn'], agreement: 'licence', signed: '2026-11-01' },
  { id: 'tanvir', name: 'Tanvir', languages: ['bn'], agreement: 'assignment', signed: '2026-11-02' },
  { id: 'lucia', name: 'Lucía', languages: ['es'], agreement: 'contract', signed: '2026-11-03' }
]
const entry = (english: string, text: string, more: Partial<Entry> = {}): Entry => ({ text, state: 'draft', sourceHash: files.sourceHash(english), ...more })
/** The error codes of one translation. */
const codes = (lang: string, english: string, text: string, meta: object = { description: 'x' }, more: Partial<Entry> = {}, glossary: object[] = []) =>
  catalogue
    .checkMessage(lang, english, meta, entry(english, text, more), glossary, REVIEWERS)
    .filter((p) => p.level === 'error')
    .map((p) => p.code)

const FILES = '{count, plural, one {{n} file} other {{n} files}}'

describe('test 62: the catalogue checks refuse broken translations', () => {
  it('accepts a good Bangla translation, ZWJ and ZWNJ included', () => {
    expect(codes('bn', 'Export {name}', '{name} এক্সপোর্ট করুন')).toEqual([])
    expect(codes('bn', FILES, '{count, plural, other {{n}টি ফাইল}}')).toEqual([])
    expect(codes('bn', '{size} of RAM', '{size} র‍্যাম')).toEqual([])
    expect(codes('bn', 'Clear', 'ক্লি‌য়ার')).toEqual([])
    expect(codes('es', FILES, '{count, plural, one {{n} archivo} many {{n} de archivos} other {{n} archivos}}')).toEqual([])
  })

  it('refuses a parse error, a missing or extra placeholder and changed rich tags', () => {
    expect(codes('bn', FILES, '{count, plural, other {{n}টি ফাইল}')).toEqual(['parse'])
    expect(codes('bn', 'Export {name}', 'এক্সপোর্ট করুন')).toEqual(['placeholders'])
    expect(codes('bn', 'Export {name}', '{name} {format} এক্সপোর্ট')).toEqual(['placeholders'])
    expect(codes('bn', 'Press <kbd>{key}</kbd>', '{key} চাপুন')).toEqual(['tags'])
  })

  it('refuses a plural without other, a category the language lacks and a Bangla one branch with একটি', () => {
    expect(codes('bn', FILES, '{count, plural, one {{n}টি ফাইল}}')).toEqual(['plural-other'])
    expect(codes('bn', FILES, '{count, plural, few {{n}টি ফাইল} other {{n}টি ফাইল}}')).toEqual(['plural-category'])
    expect(codes('es', FILES, '{count, plural, two {{n} archivos} other {{n} archivos}}')).toEqual(['plural-category'])
    expect(codes('bn', FILES, '{count, plural, one {একটি ফাইল} other {{n}টি ফাইল}}')).toEqual(['plural-one'])
    expect(codes('bn', FILES, '{count, plural, one {{n}টি ফাইল} other {{n}টি ফাইল}}')).toEqual([])
  })

  it('refuses #, {x, number} and quoted braces', () => {
    expect(codes('bn', FILES, '{count, plural, other {# ফাইল}}')).toEqual(['pound', 'placeholders'])
    expect(codes('bn', 'Export {name}', "'{'{name} এক্সপোর্ট")).toEqual(['quote'])
    expect(codes('bn', 'Export {name}', '{name} এক্সপোর্ট {n, number}')).toContain('number')
  })

  it('refuses a dropped do-not-translate term, from the meta or the glossary', () => {
    const meta = { description: 'x', dnt: ['MP4'] }
    expect(codes('bn', 'Export as MP4', 'এমপি৪ হিসেবে এক্সপোর্ট', meta)).toEqual(['dnt'])
    expect(codes('bn', 'Export as MP4', 'MP4 হিসেবে এক্সপোর্ট', meta)).toEqual([])
    const glossary = [{ term: 'Flown', dnt: true }]
    expect(codes('bn', 'Restart Flown', 'ফ্লোন আবার চালু করুন', { description: 'x' }, {}, glossary)).toEqual(['dnt'])
    expect(codes('bn', 'Restart Flown', 'Flown আবার চালু করুন', { description: 'x' }, {}, glossary)).toEqual([])
  })

  it('refuses a bidi control, a text not in NFC, HTML and a native digit in a Latin-digit line', () => {
    expect(codes('bn', 'Export', '‮এক্সপোর্ট')).toEqual(['bidi'])
    expect(codes('bn', 'Export', 'এক্সপোর্ট⁦')).toEqual(['bidi'])
    expect(codes('bn', 'Saved', 'সংরক্ষিত হয়েছেয়')).toEqual(['nfc'])
    expect(codes('bn', 'Export', 'এক্সপোর্ট<script>alert(1)</script>')).toContain('html')
    expect(codes('bn', 'Export', '<b>এক্সপোর্ট</b>')).toEqual(['tags'])
    const latn = { description: 'x', digits: 'latn', dnt: ['fps'] }
    expect(codes('bn', '{width}×{height} · 30 fps', '{width}×{height} · ৩০ fps', latn)).toEqual(['digits'])
    expect(codes('bn', '{width}×{height} · 30 fps', '{width}×{height} · 30 fps', latn)).toEqual([])
    expect(codes('bn', '30 seconds', '৩০ সেকেন্ড')).toEqual([])
  })

  it('refuses a text over maxLength, counted in graphemes', () => {
    expect(codes('bn', 'Cut', 'ক্ষক্ষক্ষ', { description: 'x', maxLength: 3 })).toEqual([])
    expect(codes('bn', 'Cut', 'ক্ষক্ষক্ষ', { description: 'x', maxLength: 2 })).toEqual(['length'])
    expect(codes('es', 'Cut', 'Cortar el clip', { description: 'x', maxLength: 6 })).toEqual(['length'])
  })

  it('refuses a lost blank line, Latin words and a run of ? in Bangla', () => {
    expect(codes('bn', 'The export failed.\n\n{detail}', 'এক্সপোর্ট হয়নি। {detail}')).toEqual(['blank-lines'])
    expect(codes('bn', 'The export failed.\n\n{detail}', 'এক্সপোর্ট হয়নি।\n\n{detail}')).toEqual([])
    expect(codes('bn', 'Export the video', 'video এক্সপোর্ট করুন')).toEqual(['latin'])
    expect(codes('bn', 'Export the video', '??? ????')).toEqual(['question'])
    expect(codes('es', 'Export the video', 'Exportar el video')).toEqual([])
  })

  it('requires listed, different people for reviewed and approved strings, and reports a stale one', () => {
    expect(codes('bn', 'Export', 'এক্সপোর্ট', undefined, { state: 'reviewed', reviewedBy: 'rina' })).toEqual([])
    expect(codes('bn', 'Export', 'এক্সপোর্ট', undefined, { state: 'reviewed', reviewedBy: 'lucia' })).toEqual(['reviewer'])
    expect(codes('bn', 'Export', 'এক্সপোর্ট', undefined, { state: 'approved', reviewedBy: 'rina', approvedBy: 'tanvir' })).toEqual([])
    expect(codes('bn', 'Export', 'এক্সপোর্ট', undefined, { state: 'approved', reviewedBy: 'rina', approvedBy: 'rina' })).toEqual(['same-person'])
    expect(codes('bn', 'Export', 'এক্সপোর্ট', undefined, { state: 'approved', reviewedBy: 'rina', approvedBy: 'someone' })).toEqual(['approver'])
    const stale = catalogue.checkMessage('bn', 'Export the video', { description: 'x' }, entry('Export', 'এক্সপোর্ট'), [], REVIEWERS)
    expect(stale.map((p) => [p.code, p.level])).toEqual([['stale', 'stale']])
  })
})

describe('test 63: the English checks', () => {
  const messages = { 'export.a': 'Export', 'export.b': 'Saved {n}', 'export.split.one': 'Split', 'export.split.two': ' the clip' }
  const meta = { 'export.a': { description: 'a' }, 'export.split.one': { description: 's', merge: true }, 'export.split.two': { description: 's', merge: true } }
  const used = (keys: string[], called: string[] = []) => ({ has: (k: string) => keys.includes(k), called: new Set(called) })

  it('finds an unused key, a used key that does not exist, a missing meta entry and a merge group without .whole', () => {
    const found = catalogue.checkEnglish(messages, meta, used(['export.a', 'export.b', 'export.split.one', 'export.split.two'], ['export.a', 'export.gone']))
    expect(found.map((p) => [p.code, p.key])).toEqual([
      ['meta', 'export.b'],
      ['missing-key', 'export.gone'],
      ['merge-whole', 'export.split']
    ])
    const unused = catalogue.checkEnglish({ ...messages, 'export.split.whole': 'Split the clip' }, { ...meta, 'export.b': { description: 'b' }, 'export.split.whole': { description: 'w' } }, used(['export.a', 'export.split.one', 'export.split.two', 'export.split.whole']))
    expect(unused.map((p) => [p.code, p.key])).toEqual([['unused', 'export.b']])
  })

  it('refuses English that does not parse, is not NFC, or uses # or {x, number}', () => {
    const all = { has: () => true }
    const bad = { 'e.a': '{n, plural, one {x}', 'e.b': 'নয়য়', 'e.c': '{n, plural, other {# files}}', 'e.d': 'Size {n, number}' }
    const m = Object.fromEntries(Object.keys(bad).map((k) => [k, { description: k }]))
    expect(catalogue.checkEnglish(bad, m, all).map((p) => [p.code, p.key])).toEqual([
      ['parse', 'e.a'],
      ['nfc', 'e.b'],
      ['pound', 'e.c'],
      ['number', 'e.d']
    ])
  })

  it('reads what the code uses: t() and <T> keys, keys in tables and key templates', () => {
    const root = makeTree({
      ...englishTree({ codecs: { 'codec.hevc.label': 'HEVC', 'codec.av1.label': 'AV1', 'row.codec': 'Codec', unused: 'Nobody' } }),
      'src/renderer/src/a.tsx':
        "import { t } from '../../shared/i18n/t'\nimport { T } from './i18n/T'\nconst TABLE = ['codecs.row.codec']\nexport const A = (c: string) => <p title={t(`codecs.codec.${c}.label`)}><T k=\"codecs.nothing\" />{TABLE}</p>\n"
    })
    trees.push(root)
    const u = catalogue.usedKeysOf(root)
    expect([...u.called]).toEqual(['codecs.nothing'])
    expect([...u.mentioned]).toEqual(['codecs.row.codec'])
    expect(['codecs.codec.hevc.label', 'codecs.codec.av1.label', 'codecs.row.codec', 'codecs.unused'].map((k) => u.has(k))).toEqual([true, true, true, false])
  })

  it('fails the full run on any English or translation problem, and passes a clean tree', () => {
    const english = { codecs: { 'row.codec': 'Codec {name}' } }
    const root = makeTree({
      ...englishTree(english),
      ...toolsTree(),
      'src/shared/i18n/built/shipped.json': [],
      'translations/reviewers.json': { reviewers: REVIEWERS },
      'src/renderer/src/a.ts': "import { t } from '../../shared/i18n/t'\nexport const a = () => t('codecs.row.codec', { name: 'x' })\n"
    })
    trees.push(root)
    expect(checks.runChecks(root).errors).toEqual([])
    writeTree(root, { 'translations/bn/codecs.json': { 'row.codec': entry('Codec {name}', 'কোডেক', { state: 'draft' }) } })
    expect(checks.runChecks(root).errors).toEqual(['bn codecs.row.codec: lacks the placeholder(s) {name}'])
    writeTree(root, { 'translations/bn/codecs.json': { 'row.codec': entry('Codec', '{name} কোডেক', { state: 'draft' }) } })
    const stale = checks.runChecks(root)
    expect(stale.errors).toEqual([])
    expect(stale.warnings).toEqual(['bn: 1 translation(s) are stale (English changed); they are left out until approved again'])
    writeTree(root, { 'translations/reviewers.json': { reviewers: [{ id: 'X', languages: ['xx'] }] } })
    expect(checks.runChecks(root).errors.length).toBe(5)
  })
})
