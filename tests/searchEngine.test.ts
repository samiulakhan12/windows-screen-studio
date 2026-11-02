import { describe, expect, it } from 'vitest'
import { SearchIndex } from '../src/shared/search/engine'
import { indexedProject, projectUnits } from '../src/shared/search/extract'
import { tokenize } from '../src/shared/search/normalize'
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
/** How wide text is drawn, in Latin letters: a Chinese or Japanese character counts two. */
const columns = (s: string): number => [...s].reduce((n, c) => n + (/[\u3000-\u9fff]/.test(c) ? 2 : 1), 0)

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
      { kind: 'file', start: null, end: null, text: 'Zoom call' },
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

  it('finds an imported video by its file name, not by its extension', () => {
    const imported = indexedProject({ name: 'Budget', source: { kind: 'import', fileName: 'Quarterly review.mp4' } }, 's') as IndexedProject
    const r = index({ imp: imported, rec: entry('Marketing sync', []) })
    expect(r.search('quarterly').map((h) => h.id)).toEqual(['imp'])
    expect(r.search('m').map((h) => h.id)).toEqual(['rec'])
    expect(r.search('mp4')).toEqual([])
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

  it('puts the word as typed above typo matches, however many captions they fill', () => {
    const typos = (name: string): IndexedProject => entry(name, [said(1, 'come here'), said(5, 'come back'), said(9, 'come on'), said(12, 'the model and the node')])
    const r = index({ exact: entry('A', [said(1, 'open the code')], { createdAt: '2025-01-01T00:00:00.000Z' }), typo: typos('B') })
    expect(r.search('code').map((h) => h.id)).toEqual(['exact', 'typo'])
    // Sixty recordings of guesses do not push it out of the 50 returned.
    const many: Record<string, IndexedProject> = { exact: entry('A', [said(1, 'the code for the login page')], { createdAt: '2025-01-01T00:00:00.000Z' }) }
    for (let i = 0; i < 60; i++) many[`t${i}`] = typos(`T${i}`)
    expect(index(many).search('code')[0].id).toBe('exact')
    // Bangla: "আমার" (my) above three of "আমরা" (we).
    const bn = index({ exact: entry('A', [said(1, 'আমার নাম')], { createdAt: '2025-01-01T00:00:00.000Z' }), typo: entry('B', [said(1, 'আমরা যাই'), said(3, 'আমরা খাই'), said(5, 'আমরা পড়ি')]) })
    expect(bn.search('আমার').map((h) => h.id)).toEqual(['exact', 'typo'])
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

  it('a first Thai or kana letter matches by prefix only in names, titles and chapters', () => {
    const r = index({ th: entry('Demo', [said(1, 'ต่อไปเปิดการตั้งค่า')]), ja: entry('Trip', [said(1, 'すしを食べました')]) })
    expect(r.search('ต')).toEqual([])
    expect(r.search('ต่อ').map((h) => h.id)).toEqual(['th'])
    expect(r.search('す')).toEqual([])
    expect(r.search('すし').map((h) => h.id)).toEqual(['ja'])
    // In a name it is found from the first letter, as in Latin.
    expect(index({ n: entry('ตั้งค่า', []) }).search('ต').map((h) => h.id)).toEqual(['n'])
  })

  it('a kana letter split from a word being typed matches by prefix everywhere', () => {
    // The word breaker cuts a half-typed word into pieces, the last often one kana: 進みま → 進み + ま,
    // すご → す + ご. Those pieces are the word being typed, not a first letter.
    const r = index({ a: entry('Demo', [said(1, 'では次に進みます')]), b: entry('Tips', [said(1, 'すごく簡単です')]), c: entry('End', [said(1, 'ありがとうございました')]) })
    expect(r.search('進みま').map((h) => h.id)).toEqual(['a'])
    expect(r.search('すご').map((h) => h.id)).toEqual(['b'])
    expect(r.search('ありがとうござい').map((h) => h.id)).toEqual(['c'])
    // Alone it is still a first letter.
    expect(r.search('ま')).toEqual([])
  })

  it('finds a Thai or Japanese word while it is typed, letter by letter', () => {
    const r = index({
      th: entry('Demo', [said(1, 'วันนี้เราจะมาตั้งค่าโปรแกรมบันทึกหน้าจอ'), said(5, 'ขอบคุณที่รับชมครับ')]),
      ja: entry('Trip', [said(1, '東京タワーに行きました')])
    })
    for (const [word, id] of [['โปรแกรม', 'th'], ['บันทึก', 'th'], ['ขอบคุณ', 'th'], ['ตั้งค่าโปรแกรม', 'th'], ['東京タワー', 'ja']]) {
      const letters = [...word]
      // A first letter alone is looked for only in names (above); a Han character is a word.
      for (let n = /\p{Script=Han}/u.test(letters[0]) ? 1 : 2; n <= letters.length; n++) {
        const typed = letters.slice(0, n).join('')
        expect(r.search(typed).map((h) => h.id), typed).toContain(id)
      }
    }
    // The word it found is marked whole.
    expect(hits(r.search('โปรแก')[0].moments[0].snippet)).toEqual(['โปรแกรม'])
    // A word typed in one piece is read only one way.
    expect(r.search('ขอบคุณ').map((h) => h.id)).toEqual(['th'])
  })

  it('still finds the word being typed when another recording holds its split pieces', () => {
    const r = index({
      th: entry('Demo', [said(1, 'วันนี้เราจะมาตั้งค่าโปรแกรมบันทึกหน้าจอ'), said(5, 'ขอบคุณที่รับชมครับ')]),
      // โปร + แก start โปรด (please) and แก้ไข (edit); ขอบ + คุ start ขอบ (edge) and คุณ (you).
      other: entry('Other', [said(1, 'สวัสดีครับคุณผู้ชม'), said(5, 'โปรดกดปุ่มแก้ไขที่ขอบหน้าต่าง')]),
      ja: entry('旅行', [said(1, '東京タワーに行きました')]),
      // 東京 + タ: a name starting with タ, and 東京 said.
      ja2: entry('タスク管理', [said(1, '東京で会議があります')])
    })
    for (const [word, id] of [['โปรแกรม', 'th'], ['ขอบคุณ', 'th'], ['東京タワー', 'ja']]) {
      const letters = [...word]
      for (let n = /\p{Script=Han}/u.test(letters[0]) ? 1 : 2; n <= letters.length; n++) {
        const typed = letters.slice(0, n).join('')
        expect(r.search(typed).map((h) => h.id), typed).toContain(id)
      }
    }
    // The word being typed comes first; the recording holding only the pieces follows.
    expect(r.search('โปรแก').map((h) => h.id)).toEqual(['th', 'other'])
    expect(hits(r.search('โปรแก')[0].moments[0].snippet)).toEqual(['โปรแกรม'])
    expect(r.search('東京タ').map((h) => h.id)).toEqual(['ja', 'ja2'])
    // A recording found both ways is listed once.
    const both = index({ both: entry('Both', [said(1, 'โปรแกรมแก้ไขวิดีโอ')]), other: entry('Other', [said(1, 'โปรดกดปุ่มแก้ไข')]) })
    expect(both.search('โปรแก').map((h) => h.id)).toEqual(['both', 'other'])
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

  it('gives each moment its time in the edited video: cuts, speed and pauses counted', () => {
    const project = {
      name: 'Demo',
      duration: 600,
      clips: [{ id: 'a', start: 120, end: 600, speed: 1 }],
      chapters: [{ id: 'c', t: 300, title: 'Settings chapter' }],
      transcript: { segments: [{ id: 's', start: 300, end: 302, text: 'open the settings page' }, { id: 'x', start: 60, end: 62, text: 'cut settings' }] },
      script: { text: 'settings notes' }
    }
    // The first 2:00 trimmed: 5:00 of the recording is 3:00 of the video; a cut moment is where the editor opens.
    const [trimmed] = index({ p: indexedProject(project, 's') as IndexedProject }).search('settings')
    expect(trimmed.moments.map((m) => [m.kind, m.start, m.video])).toEqual([['chapter', 300, 180], ['said', 60, 0], ['said', 300, 180], ['notes', null, null]])
    // At 2x, with a 3 s pause before it.
    const fast = indexedProject({ ...project, clips: [{ id: 'a', start: 0, end: 600, speed: 2 }], freezes: [{ id: 'f', at: 100, length: 3, sound: 'pause' }] }, 's') as IndexedProject
    expect(index({ p: fast }).search('chapter')[0].moments[0]).toMatchObject({ start: 300, video: 153 })
    // Not edited: the source time, and nothing more is stored.
    const plainEntry = indexedProject({ ...project, clips: [{ id: 'a', start: 0, end: 600, speed: 1 }] }, 's') as IndexedProject
    expect(plainEntry.units.some((u) => u.video !== undefined)).toBe(false)
    expect(index({ p: plainEntry }).search('chapter')[0].moments[0]).toMatchObject({ start: 300, video: 300 })
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

describe('SearchIndex vocabulary', () => {
  it('drops terms no recording holds once most of the vocabulary is dead', () => {
    const r = new SearchIndex()
    r.add('keep', entry('Keep', [said(1, 'stable words here')]))
    for (let round = 0; round < 6; round++) {
      const words = Array.from({ length: 1000 }, (_, i) => `w${round}x${i}`).join(' ')
      r.add('edited', entry('Edited', [said(1, words)]))
    }
    expect(r.vocabularySize).toBeLessThan(2600)
    expect(r.search('stable').map((h) => h.id)).toEqual(['keep'])
    expect(r.search('w5x999').map((h) => h.id)).toEqual(['edited'])
    const [hit] = r.search('stable')
    expect(hits(hit.moments[0].snippet)).toEqual(['stable'])
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

  it('keeps the text before a match in scripts without spaces, never splitting a character', () => {
    const text = `${'录屏很好'.repeat(30)}目标${'很'.repeat(200)}`
    const at = text.indexOf('目标')
    const s = plain(snippetOf(text, [[at, at + 2]]))
    expect(s.startsWith('…录') || s.startsWith('…屏') || s.startsWith('…很') || s.startsWith('…好')).toBe(true)
    expect(s.length).toBeGreaterThan(100)
    // A cut 60 units before the hit lands inside a surrogate pair here.
    const emoji = `${'😀'.repeat(40)}xhit`
    const e = emoji.indexOf('hit')
    const parts = snippetOf(emoji, [[e, e + 3]])
    expect(plain(parts)).not.toMatch(/[\uDC00-\uDFFF]…|…[\uDC00-\uDFFF]/)
    expect(plain(parts).slice(1).codePointAt(0)).toBe(0x1f600)
  })

  it('never parts a Thai letter from its vowel and tone marks, nor an emoji sequence', () => {
    const thai = 'วันนี้เราจะมาเรียนรู้วิธีการบันทึกหน้าจอคอมพิวเตอร์อย่างง่ายดายและรวดเร็วที่สุดสำหรับผู้เริ่มต้นใช้งานโปรแกรมนี้เป็นครั้งแรกนะครับ'
    for (const t of tokenize(thai)) {
      const s = plain(snippetOf(thai, [[t.start, t.end]]))
      const body = s.replace(/^…|…$/g, '')
      const at = thai.indexOf(body)
      expect(at, s).toBeGreaterThanOrEqual(0)
      expect(/^\p{M}/u.test(body), s).toBe(false)
      expect(/^\p{M}/u.test(thai.slice(at + body.length)), s).toBe(false)
    }
    const family = '👨\u200D👩\u200D👧'
    // Cuts that fall inside a family emoji and inside a flag.
    for (let pad = 0; pad < 8; pad++) {
      const emoji = `${family.repeat(12)}${'x'.repeat(pad)}hit${'y'.repeat(pad)}${'🇧🇩'.repeat(40)}`
      const e = emoji.indexOf('hit')
      const parts = plain(snippetOf(emoji, [[e, e + 3]]))
      expect(parts, `${pad}`).toMatch(/^…(👨\u200D👩\u200D👧)+x*hity*(🇧🇩)+…$/u)
    }
  })

  it('keeps the text around a match when the only space is next to it', () => {
    const before = 'วันนี้เราจะมาดูวิธีการตั้งค่าโปรแกรมบันทึกหน้าจอให้ทำงานได้อย่างมีประสิทธิภาพมากที่สุด'
    const after = 'ระบบจะบันทึกทุกอย่างที่เกิดขึ้นบนหน้าจอของคุณโดยอัตโนมัติและสามารถแก้ไขได้ภายหลังในโปรแกรมตัดต่อที่มาพร้อมกับแอปพลิเคชันนี้ซึ่งช่วยให้คุณประหยัดเวลาได้มากขึ้น'
    const zh = '今天我们来看一下如何使用这个录屏软件来制作教学视频以及如何在编辑器里面调整画面的缩放效果和光标的大小还有'
    for (const text of [`${before} ทดสอบ ${after}`, `${zh}我们今天要介绍的工具是 Flown ${zh}${zh}`]) {
      const word = text.includes('Flown') ? 'Flown' : 'ทดสอบ'
      const at = text.indexOf(word)
      const parts = snippetOf(text, [[at, at + word.length]])
      expect(hits(parts)).toEqual([word])
      expect(columns(parts[0].text), plain(parts)).toBeGreaterThan(40)
      expect(parts[parts.length - 1].text.length, plain(parts)).toBeGreaterThan(80)
    }
  })

  it('keeps a match after Chinese or Japanese text in the one line a row shows', () => {
    // A caption read as one segment: the match came after 55 characters, about 715 px at 13 px, and
    // the row (one line, cut with an ellipsis) has about 460 px for the snippet at the smallest window.
    const ja = 'それでは今日はこのアプリケーションの基本的な使い方について順番にご説明していきますので画面の右上をクリックして設定を開いてください'
    const zh = `${'大家好，今天我们来介绍一下这个应用程序的基本使用方法，首先打开主页面，'.repeat(3)}然后点击右上角的按钮，接着打开设置页面选择录制质量。`
    for (const [text, word] of [[ja, '設定'], [zh, '设置']]) {
      const at = text.indexOf(word)
      const parts = snippetOf(text, [[at, at + word.length]])
      expect(hits(parts)).toEqual([word])
      const lead = parts[0].text
      expect(lead.startsWith('…'), plain(parts)).toBe(true)
      expect(columns(lead), plain(parts)).toBeLessThanOrEqual(61)
      expect(columns(lead), plain(parts)).toBeGreaterThan(50)
      expect(text.slice(0, at).endsWith(lead.slice(1)), plain(parts)).toBe(true)
    }
    // Latin text keeps its 60 characters before the match.
    const latin = `${'a'.repeat(100)} ${'word '.repeat(20)}target`
    const t = latin.indexOf('target')
    expect(plain(snippetOf(latin, [[t, t + 6]])).indexOf('target')).toBeGreaterThan(50)
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

  it('round-trips the time in the edited video, and drops one that is not a time', () => {
    const edited = new Map([['rec-1', entry('One', [{ ...said(300, 'hello'), video: 180 }], { kept: [[120, 600]] })]])
    expect(parseIndexFile(JSON.parse(serializeIndex(edited)))).toEqual(edited)
    const file = (unit: unknown[]): unknown => ({ version: SEARCH_INDEX_VERSION, projects: { 'rec-1': { stamp: 's', name: 'n', createdAt: '', duration: 1, hasTranscript: true, kept: [], units: [unit] } } })
    expect(parseIndexFile(file(['said', 1, 2, 'x', 0.5])).get('rec-1')?.units[0].video).toBe(0.5)
    for (const bad of [['said', 1, 2, 'x', -1], ['said', 1, 2, 'x', 'soon'], ['notes', null, null, 'x', 3], ['said', 1, 2, 'x', null]]) expect(parseIndexFile(file(bad)).size).toBe(0)
  })

  it('keeps a project folder named __proto__', () => {
    const odd = new Map([['__proto__', entry('Odd', [])]])
    expect([...parseIndexFile(JSON.parse(serializeIndex(odd))).keys()]).toEqual(['__proto__'])
  })

  it('drops an entry over the caps Flown writes (a damaged or hostile file)', () => {
    const big = (units: unknown[], kept: unknown[] = []): unknown => ({ version: SEARCH_INDEX_VERSION, projects: { 'rec-1': { stamp: 's', name: 'n', createdAt: '', duration: 1, hasTranscript: true, kept, units } } })
    expect(parseIndexFile(big(Array.from({ length: 250 }, () => ['said', 1, 2, 'y'.repeat(2000)]))).size).toBe(0)
    expect(parseIndexFile(big(Array.from({ length: 201 }, () => ['notes', null, null, 'n']))).size).toBe(0)
    expect(parseIndexFile(big([], Array.from({ length: 10_001 }, (_, i) => [i, i + 0.5]))).size).toBe(0)
    expect(parseIndexFile(big(Array.from({ length: 200 }, () => ['said', 1, 2, 'y'.repeat(2000)]))).size).toBe(1)
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

  it('says a moment was cut only when none of it is kept, as its result does', () => {
    const kept = [{ start: 0, end: 9 }, { start: 12, end: 20 }]
    // A caption at 10-14 s whose first words were cut: the editor goes to where the rest is, with no notice.
    expect(momentTarget(kept, 10, 14)).toEqual({ t: 12, cut: false })
    expect(momentTarget(kept, 9.5, 11.5)).toEqual({ t: 12, cut: true })
    expect(momentTarget(kept, 25, 26)).toEqual({ t: 19.95, cut: true })
    const r = index({ p: entry('P', [{ kind: 'said', start: 10, end: 14, text: 'pricing plans' }, { kind: 'said', start: 9.5, end: 11.5, text: 'pricing table' }], { kept: [[0, 9], [12, 20]] }) })
    const moments = r.search('pricing')[0].moments
    expect(moments).toHaveLength(2)
    for (const m of moments) expect(momentTarget(kept, m.start as number, m.end as number).cut).toBe(m.cut)
  })

  it('writes times for the eye and the ear', () => {
    expect(clockTime(83.9)).toBe('1:23')
    expect(clockTime(3723)).toBe('1:02:03')
    expect(spokenTime(83)).toBe('1 minute 23 seconds')
    expect(spokenTime(0)).toBe('0 seconds')
    expect(spokenTime(3601)).toBe('1 hour 1 second')
    expect(resultsSummary(1, 'x')).toBe('1 recording found')
    expect(resultsSummary(0, 'xy')).toBe('No recordings match "xy".')
    expect(resultsSummary(50, 'x', 50)).toBe('The first 50 recordings found. Add a word to narrow them.')
    expect(resultsSummary(49, 'x', 50)).toBe('49 recordings found')
  })
})
