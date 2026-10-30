import { describe, expect, it } from 'vitest'
import { SearchIndex } from '../src/shared/search/engine'
import { indexedProject, projectUnits } from '../src/shared/search/extract'
import { parseIndexFile, serializeIndex } from '../src/shared/search/indexFile'
import { clockTime, momentTarget, resultsSummary, spokenTime } from '../src/shared/search/moment'
import { snippetOf } from '../src/shared/search/snippet'
import { SEARCH_INDEX_VERSION, type IndexedProject, type SearchUnit } from '../src/shared/search/types'

const said = (start: number, text: string): SearchUnit => ({ kind: 'said', start, end: start + 2, text })
const entry = (name: string, units: SearchUnit[], over: Partial<IndexedProject> = {}): IndexedProject => ({
  stamp: '1:1',
  name,
  createdAt: '2026-10-01T10:00:00.000Z',
  duration: 100,
  units: [{ kind: 'name', start: null, end: null, text: name }, ...units],
  hasTranscript: units.some((u) => u.kind === 'said'),
  kept: [],
  ...over
})
const plain = (parts: { text: string }[]): string => parts.map((p) => p.text).join('')
const hits = (parts: { text: string; hit: boolean }[]): string[] => parts.filter((p) => p.hit).map((p) => p.text)

function index(entries: Record<string, IndexedProject>): SearchIndex {
  const ix = new SearchIndex()
  for (const [id, e] of Object.entries(entries)) ix.add(id, e)
  return ix
}

describe('projectUnits', () => {
  const project = {
    name: '  Product demo ',
    source: { kind: 'import', fileName: 'Zoom call.mp4' },
    chapters: [{ id: 'c', t: 12, title: 'Settings' }, { id: 'x', t: -1, title: 'bad time' }, { id: 'y', t: 3, title: '   ' }],
    titles: [{ id: 't', start: 0, end: 4, title: 'Welcome', subtitle: 'to Flown' }, { id: 'u', start: 'x', end: 2, title: 'no time' }],
    annotations: [{ id: 'a', start: 5, end: 9, text: 'Click here' }],
    transcript: { segments: [{ id: 's', start: 1.5, end: 3, text: 'So the first thing' }, null, { id: 'z', start: 4, end: 2, text: 'end before start' }] },
    script: { text: 'Intro line\r\n\r\nSecond paragraph\n' },
    clips: [{ id: 'k', start: 0, end: 50, speed: 1 }]
  }

  it('reads every kind with its time, in a stable order', () => {
    expect(projectUnits(project)).toEqual([
      { kind: 'name', start: null, end: null, text: 'Product demo' },
      { kind: 'file', start: null, end: null, text: 'Zoom call.mp4' },
      { kind: 'chapter', start: 12, end: 12, text: 'Settings' },
      { kind: 'title', start: 0, end: 4, text: 'Welcome · to Flown' },
      { kind: 'text', start: 5, end: 9, text: 'Click here' },
      { kind: 'said', start: 1.5, end: 3, text: 'So the first thing' },
      { kind: 'said', start: 4, end: 4, text: 'end before start' },
      { kind: 'notes', start: null, end: null, text: 'Intro line' },
      { kind: 'notes', start: null, end: null, text: 'Second paragraph' }
    ])
  })

  it('reads old, empty and damaged projects without throwing', () => {
    expect(projectUnits(null)).toEqual([])
    expect(projectUnits([])).toEqual([])
    expect(projectUnits({})).toEqual([])
    expect(projectUnits({ name: 5, chapters: 'x', titles: [1, 2], transcript: { segments: {} }, script: { text: 7 }, source: { kind: 'other', fileName: 'a' } })).toEqual([])
  })

  it('caps a unit at 2,000 characters, a project at 400,000 and notes at 200 paragraphs', () => {
    const long = projectUnits({ name: 'x'.repeat(5000) })
    expect(long[0].text).toHaveLength(2000)
    const segments = Array.from({ length: 300 }, (_, i) => ({ start: i, end: i + 1, text: 'y'.repeat(2000) }))
    const units = projectUnits({ transcript: { segments } })
    expect(units).toHaveLength(200)
    const notes = projectUnits({ script: { text: Array.from({ length: 300 }, (_, i) => `line ${i}`).join('\n') } })
    expect(notes).toHaveLength(200)
  })

  it('makes an index entry with the kept clips and whether there is a transcript', () => {
    const e = indexedProject(project, '5:6')
    expect(e).toMatchObject({ stamp: '5:6', name: '  Product demo ', duration: 0, hasTranscript: true, kept: [[0, 50]] })
    expect(indexedProject({ name: 'n', clips: [{ start: 3, end: 1 }, { start: 'a' }] }, 's')).toMatchObject({ hasTranscript: false, kept: [] })
    expect(indexedProject('nope', 's')).toBeNull()
  })
})

describe('SearchIndex', () => {
  const ix = index({
    demo: entry('Product demo', [said(10, 'So the first thing you do is open settings.'), said(20, 'Then click save.'), { kind: 'chapter', start: 30, end: 30, text: 'Settings tour' }]),
    call: entry('Weekly call', [said(5, 'We recorded the settings page last week.')], { createdAt: '2026-10-02T10:00:00.000Z' }),
    bangla: entry('বাংলা ডেমো', [said(3, 'আমি বাংলায় কথা বলি।')]),
    notes: entry('Talk', [{ kind: 'notes', start: null, end: null, text: 'Remember the pricing slide' }])
  })

  it('needs every word, anywhere in the recording', () => {
    expect(ix.search('settings save').map((h) => h.id)).toEqual(['demo'])
    expect(ix.search('settings week').map((h) => h.id)).toEqual(['call'])
    expect(ix.search('settings nothinglikethis')).toEqual([])
  })

  it('finds words by prefix while typing', () => {
    expect(ix.search('sett').map((h) => h.id).sort()).toEqual(['call', 'demo'])
    expect(ix.search('record').map((h) => h.id)).toEqual(['call'])
  })

  it('forgives a typo from 4 letters and two from 8', () => {
    expect(ix.search('setings').map((h) => h.id).sort()).toEqual(['call', 'demo'])
    expect(ix.search('recrod').map((h) => h.id)).toEqual(['call'])
    expect(ix.search('settigns').map((h) => h.id).sort()).toEqual(['call', 'demo'])
    // Two edits (a swap and a wrong letter): only from 8 letters.
    expect(ix.search('settnigz').map((h) => h.id).sort()).toEqual(['call', 'demo'])
    expect(ix.search('stetinz')).toEqual([])
    // Three letters: no typos.
    expect(ix.search('svae')).toHaveLength(1) // 4 letters: save
    expect(ix.search('sae')).toEqual([])
  })

  it('never matches numbers by typo', () => {
    const n = index({ a: entry('Release 2024', []), b: entry('Build', [said(1, 'tag 2024b')]) })
    expect(n.search('2024').map((h) => h.id).sort()).toEqual(['a', 'b'])
    expect(n.search('2025')).toEqual([])
  })

  it('ranks exact above prefix above typo, and a name above a caption', () => {
    const r = index({
      exact: entry('A', [said(1, 'the save button')]),
      prefix: entry('B', [said(1, 'the saved file')]),
      typo: entry('C', [said(1, 'the sove button')]),
      named: entry('Save', [])
    })
    expect(r.search('save').map((h) => h.id)).toEqual(['named', 'exact', 'prefix', 'typo'])
    const scores = r.search('save').map((h) => h.score)
    expect(scores[1]).toBeGreaterThan(scores[2])
    expect(scores[2]).toBeGreaterThan(scores[3])
    // Two typos away from "sove": too far for a 5-letter word.
    expect(r.search('savex').map((h) => h.id)).toEqual(['named', 'exact', 'prefix'])
  })

  it('a one-letter word matches by prefix only in names, titles and chapters', () => {
    const r = index({ a: entry('Onboarding', [said(1, 'open the menu')]), b: entry('Other', [{ kind: 'title', start: 0, end: 1, text: 'Overview' }]) })
    expect(r.search('o').map((h) => h.id).sort()).toEqual(['a', 'b'])
    const moments = r.search('o').flatMap((h) => h.moments.map((m) => m.kind))
    expect(moments).toEqual(['title'])
    // "o" is only in a caption of "Zed": that does not count, so Zed does not hold every word.
    expect(index({ z: entry('Zed', [said(1, 'open the menu')]) }).search('zed o')).toEqual([])
  })

  it('a one-character Chinese word matches by prefix everywhere', () => {
    const r = index({ zh: entry('Demo', [said(1, '我喜欢录屏')]) })
    expect(r.search('喜')).toHaveLength(1)
  })

  it('puts moments with more of the words first, and a phrase above scattered words', () => {
    const r = index({
      p: entry('P', [said(1, 'open now the settings'), said(5, 'open settings now'), said(9, 'settings')])
    })
    const [hit] = r.search('open settings')
    expect(hit.moments.map((m) => m.start)).toEqual([5, 1, 9])
    expect(hit.moments[0].terms).toBe(2)
    expect(hit.moments[2].terms).toBe(1)
  })

  it('ranks recordings by score, then newest first', () => {
    const r = index({
      old: entry('Old', [said(1, 'deploy')], { createdAt: '2025-01-01T00:00:00.000Z' }),
      new: entry('New', [said(1, 'deploy')], { createdAt: '2026-01-01T00:00:00.000Z' })
    })
    expect(r.search('deploy').map((h) => h.id)).toEqual(['new', 'old'])
  })

  it('marks matched words in the snippet and in the name', () => {
    const [hit] = ix.search('product open')
    expect(hits(hit.title)).toEqual(['Product'])
    expect(plain(hit.moments[0].snippet)).toBe('So the first thing you do is open settings.')
    expect(hits(hit.moments[0].snippet)).toEqual(['open'])
  })

  it('finds Bangla by a prefix of an inflected word', () => {
    expect(ix.search('বাংলা').map((h) => h.id)).toEqual(['bangla'])
    const [hit] = ix.search('বাংলা কথা')
    expect(hit.moments[0].start).toBe(3)
    // A different vowel sign is a different word, not an accent.
    expect(ix.search('কাথা')).toHaveLength(1) // one typo
    expect(index({ k: entry('X', [said(1, 'কাল')]) }).search('কল')).toEqual([])
  })

  it('finds speaker notes (no time) and says when only the name matched', () => {
    const [n] = ix.search('pricing')
    expect(n.moments[0]).toMatchObject({ kind: 'notes', start: null })
    const [name] = ix.search('weekly')
    expect(name.nameOnly).toBe(true)
    expect(name.moments).toEqual([])
  })

  it('says a moment is cut when no kept clip holds it', () => {
    const r = index({ c: entry('C', [said(10, 'cut words'), said(40, 'kept words')], { kept: [[30, 60]] }) })
    const [hit] = r.search('words')
    expect(hit.moments.map((m) => [m.start, m.cut])).toEqual([[10, true], [40, false]])
  })

  it('limits recordings and moments, and counts the rest', () => {
    const many: Record<string, IndexedProject> = {}
    for (let i = 0; i < 60; i++) many[`r${i}`] = entry(`R${i}`, Array.from({ length: 70 }, (_, k) => said(k, 'the word again')))
    const r = index(many)
    const found = r.search('again')
    expect(found).toHaveLength(50)
    expect(found[0].moments).toHaveLength(50)
    expect(found[0].more).toBe(20)
    expect(r.search('again', { hits: 3, moments: 4 })[0].moments).toHaveLength(4)
  })

  it('searches only the recordings asked for, and forgets removed ones', () => {
    const r = index({ a: entry('A', [said(1, 'hello')]), b: entry('B', [said(1, 'hello')]) })
    expect(r.search('hello', { only: new Set(['b']) }).map((h) => h.id)).toEqual(['b'])
    r.remove('b')
    expect(r.search('hello').map((h) => h.id)).toEqual(['a'])
    r.add('a', entry('A', [said(1, 'goodbye')]))
    expect(r.search('hello')).toEqual([])
    expect(r.search('goodbye')).toHaveLength(1)
  })

  it('counts recordings without a transcript', () => {
    expect(ix.withoutTranscript()).toBe(1)
    expect(ix.withoutTranscript(new Set(['demo']))).toBe(0)
  })

  it('returns nothing for an empty query', () => {
    expect(ix.search('')).toEqual([])
    expect(ix.search(' ,. ')).toEqual([])
  })
})

describe('snippetOf', () => {
  it('shows the text around the first match, cut on words, with ellipses', () => {
    const text = `${'word '.repeat(30)}xx target ${'tail '.repeat(40)}`
    const at = text.indexOf('target')
    const parts = snippetOf(text, [[at, at + 6]])
    const s = plain(parts)
    expect(s.startsWith('…word')).toBe(true)
    expect(s.endsWith('tail…')).toBe(true)
    expect(hits(parts)).toEqual(['target'])
    expect(s.length).toBeLessThanOrEqual(60 + 6 + 120 + 2)
  })

  it('stays on the line of the match', () => {
    const parts = snippetOf('first line\nthe match here\nlast line', [[15, 20]])
    expect(plain(parts)).toBe('the match here')
  })

  it('keeps markup as text', () => {
    const parts = snippetOf('<b>bold</b> & co', [[3, 7]])
    expect(parts).toEqual([
      { text: '<b>', hit: false },
      { text: 'bold', hit: true },
      { text: '</b> & co', hit: false }
    ])
  })

  it('merges overlapping ranges and shows the start without a match', () => {
    expect(hits(snippetOf('abcdef', [[0, 3], [2, 5]]))).toEqual(['abcde'])
    expect(plain(snippetOf('short text', []))).toBe('short text')
  })
})

describe('index file', () => {
  const projects = new Map([['rec-1', entry('One', [said(1, 'hello')], { kept: [[0, 5]] })]])

  it('round-trips', () => {
    expect(parseIndexFile(JSON.parse(serializeIndex(projects)))).toEqual(projects)
  })

  it('drops a file of another version whole, and entries that do not validate', () => {
    const file = JSON.parse(serializeIndex(projects))
    expect(parseIndexFile({ ...file, version: SEARCH_INDEX_VERSION + 1 }).size).toBe(0)
    expect(parseIndexFile(null).size).toBe(0)
    const bad = { ...file.projects['rec-1'], units: [['said', 1, 2, 'x'], ['shout', 1, 2, 'y']] }
    const parsed = parseIndexFile({ ...file, projects: { 'rec-1': file.projects['rec-1'], 'rec-2': bad, '../x': file.projects['rec-1'], 'rec-3': { ...bad, stamp: 5 } } })
    expect([...parsed.keys()]).toEqual(['rec-1'])
  })
})

describe('moments', () => {
  const clips = [{ start: 0, end: 10 }, { start: 20, end: 30 }]

  it('goes to the moment when it is kept, else the next kept part', () => {
    expect(momentTarget(clips, 5)).toEqual({ t: 5, cut: false })
    expect(momentTarget(clips, 15)).toEqual({ t: 20, cut: true })
    expect(momentTarget(clips, 30)).toEqual({ t: 29.95, cut: true })
    expect(momentTarget([], 7)).toEqual({ t: 7, cut: false })
  })

  it('writes times for the eye and the ear', () => {
    expect(clockTime(83.9)).toBe('1:23')
    expect(clockTime(3723)).toBe('1:02:03')
    expect(spokenTime(83)).toBe('1 minute 23 seconds')
    expect(spokenTime(0)).toBe('0 seconds')
    expect(spokenTime(3601)).toBe('1 hour 1 second')
    expect(resultsSummary(1, 'x')).toBe('1 recording found')
    expect(resultsSummary(0, 'xy')).toBe('No recordings match "xy".')
  })
})
