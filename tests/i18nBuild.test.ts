/**
 * Tests 65 and 85 (docs/design/output-and-languages.md §15.6, §9.2, §9.3, §23.1): the build ships only
 * approved, current strings reviewed and approved by two different people listed for the language;
 * `--check` fails on a built file that is stale or should not be there; shipped.json follows the 95%
 * and core rules and marks a preview while the recording namespace is not approved; and the build
 * reports the merge groups per namespace and keeps out a language whose core whole sentence is not
 * approved.
 */
import { spawnSync } from 'node:child_process'
import fs from 'node:fs'
import path from 'node:path'
import { afterAll, describe, expect, it } from 'vitest'
import { englishTree, makeTree, removeTree, REPO, toolsTree, writeTree } from './i18nFixtures'

type Entry = { text: string; state: string; sourceHash: string; reviewedBy?: string; approvedBy?: string }
type Built = { language: string; messages: Record<string, string>; ships: boolean; preview: boolean; share: number; coreMissing: string[]; wholeMissing: string[]; dropped: { key: string; reason: string }[] }
const build = require('../scripts/i18n/lib/build.cjs') as {
  buildLanguage(lang: string, o: { english: Record<string, string>; meta: Record<string, object>; translations: Record<string, Entry>; reviewers: object[] }): Built
  buildCatalogues(root: string): { files: Record<string, string>; languages: Built[]; merge: Record<string, number> }
}
const files = require('../scripts/i18n/lib/files.cjs') as { sourceHash(s: string): string }

const trees: string[] = []
afterAll(() => trees.forEach(removeTree))

const REVIEWERS = [
  { id: 'rina', name: 'Rina', languages: ['bn'], agreement: 'licence', signed: '2026-11-01' },
  { id: 'tanvir', name: 'Tanvir', languages: ['bn'], agreement: 'assignment', signed: '2026-11-02' },
  { id: 'lucia', name: 'Lucía', languages: ['es'], agreement: 'contract', signed: '2026-11-03' }
]
const approved = (english: string, text: string, more: Partial<Entry> = {}): Entry => ({ text, state: 'approved', sourceHash: files.sourceHash(english), reviewedBy: 'rina', approvedBy: 'tanvir', ...more })

describe('test 65: what ships', () => {
  const english = { 'export.a': 'Export', 'export.b': 'Save', 'export.c': 'Copy', 'export.d': 'Close', 'export.e': 'Open', 'export.f': 'Done' }
  const meta = Object.fromEntries(Object.keys(english).map((k) => [k, { description: k }]))

  it('takes only approved, current strings of two different listed people', () => {
    const translations: Record<string, Entry> = {
      'export.a': approved('Export', 'এক্সপোর্ট'),
      'export.b': approved('Save', 'সেভ', { approvedBy: 'rina' }),
      'export.c': approved('Copy', 'কপি', { approvedBy: 'stranger' }),
      'export.d': approved('Close', 'বন্ধ', { approvedBy: 'lucia' }),
      'export.e': approved('Open file', 'খুলুন'),
      'export.f': { ...approved('Done', 'হয়েছে'), state: 'reviewed' }
    }
    const b = build.buildLanguage('bn', { english, meta, translations, reviewers: REVIEWERS })
    expect(b.messages).toEqual({ 'export.a': 'এক্সপোর্ট' })
    expect(b.dropped).toEqual([
      { key: 'export.b', reason: 'approved by its own reviewer' },
      { key: 'export.c', reason: 'reviewer or approver not listed for the language' },
      { key: 'export.d', reason: 'reviewer or approver not listed for the language' },
      { key: 'export.e', reason: 'stale' },
      { key: 'export.f', reason: 'state reviewed' }
    ])
    const missingApprover = build.buildLanguage('bn', { english, meta, translations: { 'export.a': { ...approved('Export', 'এক্সপোর্ট'), approvedBy: undefined } }, reviewers: REVIEWERS })
    expect(missingApprover.dropped).toEqual([{ key: 'export.a', reason: 'reviewer or approver missing' }])
    const failing = build.buildLanguage('bn', { english, meta, translations: { 'export.a': approved('Export', 'Export করুন') }, reviewers: REVIEWERS })
    expect(failing.dropped).toEqual([{ key: 'export.a', reason: 'fails the checks (latin)' }])
  })

  it('ships a language at 95% with every core key, and marks a preview while recording is not approved', () => {
    // 40 non-core command texts, 2 core export texts, 3 recording texts.
    const en: Record<string, string> = { 'export.a': 'Export', 'export.b': 'Save', 'recording.stop': 'Stop', 'recording.pause': 'Pause', 'recording.resume': 'Resume' }
    for (let i = 0; i < 40; i++) en[`commands.c${i}`] = `Command ${i}`
    const m = Object.fromEntries(Object.keys(en).map((k) => [k, { description: k }]))
    const all = (skip: (k: string) => boolean) => Object.fromEntries(Object.keys(en).filter((k) => !skip(k)).map((k) => [k, approved(en[k], `অনুবাদ ${k.length}`)]))
    const lang = (t: Record<string, Entry>) => build.buildLanguage('bn', { english: en, meta: m, translations: t, reviewers: REVIEWERS })

    const full = lang(all(() => false))
    expect([full.ships, full.preview]).toEqual([true, false])
    // Two of 42 counted keys missing (95.2%) and every core key: ships. The recording side alone missing
    // does not count against the 95% (it would be 93.3%): it ships, as a preview.
    expect(lang(all((k) => k === 'commands.c1' || k === 'commands.c2')).ships).toBe(true)
    const noRec = lang(all((k) => k.startsWith('recording.')))
    expect([noRec.ships, noRec.preview, noRec.share]).toEqual([true, true, 1])
    // Three missing (92.9%): below 95%.
    const low = lang(all((k) => ['commands.c1', 'commands.c2', 'commands.c3'].includes(k)))
    expect([low.ships, low.share < 0.95]).toEqual([false, true])
    // One core key missing at 97.6%: not shipped.
    const core = lang(all((k) => k === 'export.b'))
    expect([core.ships, core.coreMissing]).toEqual([false, ['export.b']])
    // An English without recording texts: the recording side is English, so a preview.
    const noRecording = build.buildLanguage('bn', { english: { 'export.a': 'Export' }, meta: { 'export.a': { description: 'a' } }, translations: { 'export.a': approved('Export', 'এক্সপোর্ট') }, reviewers: REVIEWERS })
    expect([noRecording.ships, noRecording.preview]).toEqual([true, true])
  })

  it('writes catalogues for the renderer and for main with latn and user, and --check fails on a stale or extra built file', () => {
    const root = makeTree({
      ...englishTree(
        { export: { size: '{width}×{height}', name: 'Export {name}' }, main: { title: 'Save {name}' }, errors: {}, common: {} },
        { export: { size: { description: 's', digits: 'latn' }, name: { description: 'n', user: ['name'] } }, main: { title: { description: 't', user: ['name'] } } }
      ),
      ...toolsTree(),
      'translations/reviewers.json': { reviewers: REVIEWERS },
      'translations/bn/export.json': { size: approved('{width}×{height}', '{width}×{height}'), name: approved('Export {name}', '{name} এক্সপোর্ট') },
      'translations/bn/main.json': { title: approved('Save {name}', '{name} সেভ') }
    })
    trees.push(root)
    const out = build.buildCatalogues(root)
    expect(Object.keys(out.files)).toEqual(['bn.json', 'bn.main.json', 'shipped.json'])
    expect(JSON.parse(out.files['bn.json'])).toEqual({
      messages: { 'export.size': '{width}×{height}', 'export.name': '{name} এক্সপোর্ট', 'main.title': '{name} সেভ' },
      latn: ['export.size'],
      user: { 'export.name': ['name'], 'main.title': ['name'] }
    })
    expect(JSON.parse(out.files['bn.main.json'])).toEqual({ messages: { 'main.title': '{name} সেভ' }, latn: [], user: { 'main.title': ['name'] } })
    expect(JSON.parse(out.files['shipped.json'])).toEqual([{ language: 'bn', preview: true }])

    const run = (...args: string[]) => spawnSync(process.execPath, [path.join(REPO, 'scripts/i18n/build-catalogues.mjs'), '--root', root, ...args], { encoding: 'utf8' })
    expect(run('--check').status).toBe(1)
    expect(run().status).toBe(0)
    expect(run('--check').status).toBe(0)
    const built = path.join(root, 'src/shared/i18n/built')
    // English changed: the approved string is stale and leaves, so a core key is missing and Bangla no
    // longer ships; the committed files no longer match.
    writeTree(root, { 'src/shared/i18n/messages/en/main.json': { title: 'Save {name} now' } })
    const stale = run('--check')
    expect(stale.status).toBe(1)
    expect(stale.stderr).toContain('shipped.json differs from what the translations give')
    expect(stale.stderr).toContain('bn.json should not be there')
    // A non-core change: the file's text differs.
    writeTree(root, { 'src/shared/i18n/messages/en/main.json': { title: 'Save {name}' }, 'translations/bn/export.json': { size: approved('{width}×{height}', '{width} × {height}'), name: approved('Export {name}', '{name} এক্সপোর্ট') } })
    expect(run('--check').stderr).toContain('bn.json differs from what the translations give')
    expect(run().status).toBe(0)
    fs.writeFileSync(path.join(built, 'es.json'), '{}\n')
    const extra = run('--check')
    expect(extra.status).toBe(1)
    expect(extra.stderr).toContain('es.json should not be there')
    expect(run().status).toBe(0)
    expect(fs.readdirSync(built).sort()).toEqual(['bn.json', 'bn.main.json', 'shipped.json'])
  })

  it('matches the committed built catalogues of this repository', () => {
    const out = build.buildCatalogues(REPO)
    const dir = path.join(REPO, 'src/shared/i18n/built')
    expect(fs.readdirSync(dir).filter((f) => f.endsWith('.json')).sort()).toEqual(Object.keys(out.files).sort())
    for (const [name, text] of Object.entries(out.files)) expect(fs.readFileSync(path.join(dir, name), 'utf8')).toBe(text)
  })
})

describe('test 85: merge groups', () => {
  it('reports the groups per namespace and keeps out a language whose core whole sentence is not approved', () => {
    const en = { 'export.split.one': 'Split', 'export.split.two': ' the clip', 'export.split.whole': 'Split the clip', 'commands.join.one': 'Join', 'commands.join.whole': 'Join them' }
    const meta: Record<string, object> = {}
    for (const k of Object.keys(en)) meta[k] = k.endsWith('.whole') ? { description: 'w' } : { description: 'p', merge: true }
    const root = makeTree({
      ...englishTree({ export: { 'split.one': 'Split', 'split.two': ' the clip', 'split.whole': 'Split the clip' }, commands: { 'join.one': 'Join', 'join.whole': 'Join them' } }, {
        export: { 'split.one': { description: 'p', merge: true }, 'split.two': { description: 'p', merge: true }, 'split.whole': { description: 'w' } },
        commands: { 'join.one': { description: 'p', merge: true }, 'join.whole': { description: 'w' } }
      }),
      ...toolsTree(),
      'translations/reviewers.json': { reviewers: REVIEWERS }
    })
    trees.push(root)
    expect(build.buildCatalogues(root).merge).toEqual({ commands: 1, export: 1 })
    const all = (skip: string[]) => Object.fromEntries(Object.entries(en).filter(([k]) => !skip.includes(k)).map(([k, v]) => [k, approved(v, `অংশ ${k.length}`)]))
    const ships = build.buildLanguage('bn', { english: en, meta, translations: all([]), reviewers: REVIEWERS })
    expect(ships.ships).toBe(true)
    const noWhole = build.buildLanguage('bn', { english: en, meta, translations: all(['export.split.whole']), reviewers: REVIEWERS })
    expect([noWhole.ships, noWhole.wholeMissing]).toEqual([false, ['export.split.whole']])
    const cli = spawnSync(process.execPath, [path.join(REPO, 'scripts/i18n/build-catalogues.mjs'), '--root', root, '--check'], { encoding: 'utf8' })
    expect(cli.stdout).toContain('merge groups: commands 1, export 1.')
  })
})
