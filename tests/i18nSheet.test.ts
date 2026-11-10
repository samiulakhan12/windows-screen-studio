/**
 * Test 66 (docs/design/output-and-languages.md §15.4, §23.1): the review sheet. Export writes a
 * byte-order mark and puts an apostrophe before "-3 dB" and "=SUM(A1)"; import removes it and
 * round-trips without loss; it refuses a file with U+FFFD or invalid UTF-8, a row of "????", a Bangla
 * row with no Bengali letter and a row that fails the checks; it records who and when, and refuses one
 * person as reviewer and approver.
 */
import { spawnSync } from 'node:child_process'
import fs from 'node:fs'
import path from 'node:path'
import { afterAll, describe, expect, it } from 'vitest'
import { englishTree, makeTree, removeTree, REPO, toolsTree } from './i18nFixtures'

type Entry = { text: string; state: string; sourceHash: string; reviewedBy?: string; reviewedAt?: string; approvedBy?: string; approvedAt?: string; note?: string }
type Imported = { entries: Record<string, Entry>; changed: string[]; refused: { key: string; reason: string }[] }
const sheet = require('../scripts/i18n/lib/sheet.cjs') as {
  exportSheet(o: { lang: string; english: Record<string, string>; meta: Record<string, object>; translations: Record<string, Entry> }): string
  importSheet(o: { lang: string; bytes: Uint8Array; english: Record<string, string>; meta: Record<string, object>; translations: Record<string, Entry>; reviewers: object[]; by: string; date: string }): Imported
}
const csv = require('../scripts/i18n/lib/csv.cjs') as { parseCsv(t: string): string[][]; formatCsv(r: string[][]): string }
const files = require('../scripts/i18n/lib/files.cjs') as { sourceHash(s: string): string }

const trees: string[] = []
afterAll(() => trees.forEach(removeTree))

const REVIEWERS = [
  { id: 'rina', name: 'Rina', languages: ['bn'], agreement: 'licence', signed: '2026-11-01' },
  { id: 'tanvir', name: 'Tanvir', languages: ['bn'], agreement: 'assignment', signed: '2026-11-02' }
]
const english = { 'sound.level': '-3 dB', 'sound.sum': '=SUM(A1)', 'export.name': 'Export {name}', 'export.done': 'Done', 'export.new': 'New' }
const meta = { 'sound.level': { description: 'level', dnt: ['dB'] }, 'sound.sum': { description: 'odd', dnt: ['SUM', 'A1'] }, 'export.name': { description: 'n', screen: 'export-settings' }, 'export.done': { description: 'd' }, 'export.new': { description: 'n' } }
const draft = (en: string, text: string, more: Partial<Entry> = {}): Entry => ({ text, state: 'draft', sourceHash: files.sourceHash(en), ...more })
const translations: Record<string, Entry> = {
  'sound.level': draft('-3 dB', '-3 dB কম'),
  'sound.sum': draft('=SUM(A1)', '=SUM(A1) যোগফল'),
  'export.name': draft('Export {name}', '{name} এক্সপোর্ট'),
  'export.done': draft('Old done', 'হয়েছে')
}
const bytes = (s: string) => new TextEncoder().encode(s)
const run = (text: string, by = 'rina', base = translations) => sheet.importSheet({ lang: 'bn', bytes: bytes(text), english, meta, translations: base, reviewers: REVIEWERS, by, date: '2026-11-10' })

/** The exported sheet with some cells changed: key → { column: value }. */
function edited(changes: Record<string, Record<string, string>>, base = translations): string {
  const rows = csv.parseCsv(sheet.exportSheet({ lang: 'bn', english, meta, translations: base }))
  const head = rows[0]
  for (const r of rows.slice(1)) for (const [col, v] of Object.entries(changes[r[0]] ?? {})) r[head.indexOf(col)] = v
  return '\ufeff' + csv.formatCsv(rows)
}

describe('test 66: the review sheet', () => {
  it('writes a byte-order mark, the columns, stale strings first, and an apostrophe before a formula', () => {
    const text = sheet.exportSheet({ lang: 'bn', english, meta, translations })
    expect(text.charCodeAt(0)).toBe(0xfeff)
    const rows = csv.parseCsv(text)
    expect(rows[0]).toEqual(['key', 'English', 'description', 'screen', 'draft', 'final', 'state', 'reviewer', 'approver', 'note'])
    expect(rows.slice(1).map((r) => r[0])).toEqual(['export.done', 'sound.level', 'sound.sum', 'export.name', 'export.new'])
    expect(rows[1][6]).toBe('stale')
    expect(rows[2].slice(0, 2)).toEqual(['sound.level', "'-3 dB"])
    expect(rows[2][5]).toBe("'-3 dB কম")
    expect(rows[3].slice(0, 2)).toEqual(['sound.sum', "'=SUM(A1)"])
    expect(rows[4][3]).toBe('pack/export-settings.png')
    expect(text).toContain('\r\n')
  })

  it('round-trips an untouched sheet without loss, and removes the apostrophes', () => {
    const same = run(sheet.exportSheet({ lang: 'bn', english, meta, translations }))
    expect(same).toEqual({ entries: translations, changed: [], refused: [] })
    const r = run(edited({ 'sound.level': { final: "'-3 dB কমান", state: 'reviewed' } }))
    expect(r.refused).toEqual([])
    expect(r.entries['sound.level'].text).toBe('-3 dB কমান')
  })

  it('leaves an untouched stale row alone, and asks for a state when a stale row is corrected', () => {
    expect(run(edited({ 'export.done': { note: '' } })).changed).toEqual([])
    const corrected = run(edited({ 'export.done': { final: 'হয়ে গেছে' } }))
    expect(corrected.refused).toEqual([{ key: 'export.done', reason: 'has the state "stale"; use draft, reviewed or approved' }])
    const reviewed = run(edited({ 'export.done': { final: 'হয়ে গেছে', state: 'reviewed' } }))
    expect(reviewed.entries['export.done']).toMatchObject({ text: 'হয়ে গেছে', state: 'reviewed', sourceHash: files.sourceHash('Done'), reviewedBy: 'rina' })
  })

  it('records who reviewed and approved, and when, and refuses one person as both', () => {
    const reviewed = run(edited({ 'export.name': { final: '{name} এক্সপোর্ট করুন', state: 'reviewed' } }))
    expect(reviewed.changed).toEqual(['export.name'])
    expect(reviewed.entries['export.name']).toEqual({ text: '{name} এক্সপোর্ট করুন', state: 'reviewed', sourceHash: files.sourceHash('Export {name}'), reviewedBy: 'rina', reviewedAt: '2026-11-10' })
    const same = run(edited({ 'export.name': { state: 'approved' } }, reviewed.entries), 'rina', reviewed.entries)
    expect(same.refused).toEqual([{ key: 'export.name', reason: 'was reviewed by rina, who cannot also approve it' }])
    expect(same.entries).toBe(reviewed.entries)
    const approved = run(edited({ 'export.name': { state: 'approved' } }, reviewed.entries), 'tanvir', reviewed.entries)
    expect(approved.entries['export.name']).toMatchObject({ state: 'approved', reviewedBy: 'rina', approvedBy: 'tanvir', approvedAt: '2026-11-10' })
    expect(() => run(sheet.exportSheet({ lang: 'bn', english, meta, translations }), 'stranger')).toThrow(/not listed for bn/)
  })

  it('refuses a file with U+FFFD or invalid UTF-8', () => {
    expect(() => run(edited({ 'export.done': { final: 'হয়েছে\ufffd' } }))).toThrow(/U\+FFFD/)
    const broken = new Uint8Array([...bytes('key,English\r\n'), 0xff, 0xfe, 0x41])
    expect(() => sheet.importSheet({ lang: 'bn', bytes: broken, english, meta, translations, reviewers: REVIEWERS, by: 'rina', date: '2026-11-10' })).toThrow(/not UTF-8/)
  })

  it('refuses a row of ????, a Bangla row with no Bengali letter, a spreadsheet error and a row that fails the checks', () => {
    const r = run(
      edited({
        'export.done': { final: '???? ????', state: 'reviewed' },
        'export.new': { final: 'Nuevo', state: 'draft' },
        'sound.sum': { final: '#NAME?', state: 'draft' },
        'export.name': { final: 'এক্সপোর্ট', state: 'reviewed' }
      })
    )
    expect(r.refused).toEqual([
      { key: 'export.done', reason: 'has a run of "?" (the text lost its letters on the way)' },
      { key: 'sound.sum', reason: 'starts with # (a spreadsheet error, such as #NAME?)' },
      { key: 'export.name', reason: 'lacks the placeholder(s) {name}' },
      { key: 'export.new', reason: "has no letter of the language's script" }
    ])
    expect(r.changed).toEqual([])
    expect(r.entries).toBe(translations)
  })

  it('exports and imports through the command, writing nothing when a row is refused', () => {
    const root = makeTree({
      ...englishTree({ export: { name: 'Export {name}', done: 'Done' } }),
      ...toolsTree(),
      'translations/reviewers.json': { reviewers: REVIEWERS },
      'translations/bn/export.json': { name: draft('Export {name}', '{name} এক্সপোর্ট') }
    })
    trees.push(root)
    const cli = (...args: string[]) => spawnSync(process.execPath, [path.join(REPO, 'scripts/i18n/sheet.mjs'), ...args, '--root', root], { encoding: 'utf8' })
    expect(cli('export', '--lang', 'bn').status).toBe(0)
    const file = path.join(root, 'translations/bn/review.csv')
    const rows = csv.parseCsv(fs.readFileSync(file, 'utf8'))
    rows[1][5] = '{name} এক্সপোর্ট করুন'
    rows[1][6] = 'reviewed'
    rows[2][5] = 'Done'
    rows[2][6] = 'draft'
    fs.writeFileSync(file, '\ufeff' + csv.formatCsv(rows))
    const before = fs.readFileSync(path.join(root, 'translations/bn/export.json'), 'utf8')
    const refused = cli('import', '--lang', 'bn', '--file', file, '--by', 'rina', '--date', '2026-11-10')
    expect(refused.status).toBe(1)
    expect(refused.stderr).toContain("export.done: has no letter of the language's script")
    expect(fs.readFileSync(path.join(root, 'translations/bn/export.json'), 'utf8')).toBe(before)
    rows[2][5] = 'হয়েছে'
    fs.writeFileSync(file, '\ufeff' + csv.formatCsv(rows))
    expect(cli('import', '--lang', 'bn', '--file', file, '--by', 'rina', '--date', '2026-11-10').status).toBe(0)
    const saved = JSON.parse(fs.readFileSync(path.join(root, 'translations/bn/export.json'), 'utf8')) as Record<string, Entry>
    expect(Object.keys(saved)).toEqual(['name', 'done'])
    expect(saved.name).toMatchObject({ text: '{name} এক্সপোর্ট করুন', state: 'reviewed', reviewedBy: 'rina', reviewedAt: '2026-11-10' })
    expect(saved.done).toMatchObject({ text: 'হয়েছে', state: 'draft' })
  })
})
