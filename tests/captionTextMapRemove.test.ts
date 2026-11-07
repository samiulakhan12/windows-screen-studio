/**
 * Review's Remove of a text fix by the record's word map (docs/design/captions-studio.md §11.1
 * rule 1, §11.8): kept and pending marks, keyword and emoji anchors and caption places go back
 * onto exactly the words the tidied words came from, with exact, estimated or no word times; a
 * tidy moves marks onto the words made from theirs; a record saved without a map falls back to
 * finding the words again.
 */
import { describe, expect, it } from 'vitest'
import { settleCaptionAuto } from '../src/shared/captions/captionAutoSettle'
import { DEFAULT_CLEANUP, tidyCaptions, type CleanupChoices, type WordListEntry } from '../src/shared/captions/cleanup'
import { DEFAULT_GREAT_OPTIONS, planCaptionsGreat } from '../src/shared/captions/great'
import { studioWordTexts } from '../src/shared/captions/words'
import { EditStore } from '../src/shared/editor/editStore'
import { settleDeletedWords } from '../src/shared/editor/transcript'
import { migrateProject } from '../src/shared/engine/project'
import { settleAutoCuts } from '../src/shared/review/autoCuts'
import { EMPHASIS_GROUP, TEXT_GROUP } from '../src/shared/review/captionReview'
import { keepItems, removeItems, reviewItems, type ReviewItem } from '../src/shared/review/review'
import type { CaptionMark, CaptionSegment, Graphic, Project } from '../src/shared/types'
import { captions, studioProject, TALL, WIDE } from './p4Fixtures'

type Times = 'exact' | 'estimated' | 'none'
const TIMES: Times[] = ['exact', 'estimated', 'none']

/** Captions with one stored time per word, exact or estimated, or none. */
const segmentsOf = (texts: string[], times: Times): CaptionSegment[] =>
  captions(texts).map((s) => {
    if (times === 'none') return s
    const words = s.text.split(' ')
    const step = (s.end - s.start) / words.length
    return { ...s, words: words.map((text, i) => ({ text, start: s.start + i * step, end: s.start + (i + 1) * step, ...(times === 'estimated' ? { estimated: true as const } : {}) })) }
  })

const storeOf = (p: Project): EditStore<Project> => new EditStore(p, undefined, undefined, undefined, (next, prev) => settleAutoCuts(settleCaptionAuto(settleDeletedWords(next, prev), prev), prev))
const row = (q: Project, key: string): ReviewItem => reviewItems(q).find((x) => x.key === key)!
const wordsOf = (q: Project, id = 'c0'): string[] => studioWordTexts(q.transcript!.segments.find((s) => s.id === id)!.text, q.transcript!.language)
const mark = (q: Project, from: number, to = from, auto = true, id = 'm'): CaptionMark => ({ id, caption: 'c0', from, to, text: wordsOf(q).slice(from, to + 1).join(' '), ...(auto ? { auto: true as const } : {}) })
const pop = (q: Project, kind: 'keyword' | 'emoji', from: number, to = from): Graphic => {
  const seg = q.transcript!.segments[0]
  const anchor = { caption: 'c0', from, to, text: wordsOf(q).slice(from, to + 1).join(' ') }
  const base = { id: kind, start: seg.start, end: seg.end, place: 'auto' as const, size: 0.1, enter: { kind: 'pop' as const, duration: 0.3, strength: 1 }, exit: { kind: 'fade' as const, duration: 0.3, strength: 1 }, anchor, auto: { by: 'keyword' as const, via: 'rules' as const, caption: 'c0' } }
  return (kind === 'keyword' ? { ...base, kind, text: anchor.text, look: 'card' } : { ...base, kind, emoji: '1f680', auto: { by: 'emoji', via: 'rules', caption: 'c0' } }) as Graphic
}
const anchorText = (q: Project, id: string): string | undefined => {
  const g = q.graphics?.find((x) => x.id === id)
  return g && (g.kind === 'keyword' || g.kind === 'emoji') ? g.anchor?.text : undefined
}

/** The finding's captions and others: the text, the word list, the tidied text, and for each tidied word the words it came from. */
const CASES: { text: string; words: WordListEntry[]; cleanup?: Partial<CleanupChoices>; tidied: string; back: string[] }[] = [
  {
    text: 'our q and a and fifty google dogs users',
    words: [{ term: 'Q&A', heard: ['q and a'] }, { term: 'Google Docs', heard: ['google dogs'] }],
    tidied: 'Our Q&A and 50 Google Docs users',
    back: ['our', 'q and a', 'and', 'fifty', 'google dogs', 'google dogs', 'users']
  },
  {
    text: 'the r and d and ops teams use google dogs',
    words: [{ term: 'R&D', heard: ['r and d'] }, { term: 'DevOps', heard: ['ops'] }, { term: 'Google Docs', heard: ['google dogs'] }],
    tidied: 'The R&D and DevOps teams use Google Docs',
    back: ['the', 'r and d', 'and', 'ops', 'teams', 'use', 'google dogs', 'google dogs']
  },
  // The limit §11.1 named for captions without word times: "Flown" back on "flow" alone.
  { text: 'open flow in in twenty seconds', words: [{ term: 'Flown', heard: ['flow in'] }], tidied: 'Open Flown in 20 seconds', back: ['open', 'flow in', 'in', 'twenty', 'seconds'] },
  {
    text: 'prices were a hundred and ten and a hundred and twenty',
    words: [],
    tidied: 'Prices were 110 and 120',
    back: ['prices', 'were', 'a hundred and ten', 'and', 'a hundred and twenty']
  },
  { text: 'the q and a and ten others', words: [{ term: 'Q&A', heard: ['q and a'] }], cleanup: { digits: 'all' }, tidied: 'The Q&A and 10 others', back: ['the', 'q and a', 'and', 'ten', 'others'] },
  { text: 'open flow in in visual studio today', words: [{ term: 'Flown', heard: ['flow in'] }, { term: 'Visual Studio', heard: [] }], tidied: 'Open Flown in Visual Studio today', back: ['open', 'flow in', 'in', 'visual studio', 'visual studio', 'today'] }
]

/** A two-caption project with the case tidied through the store (the second caption is unchanged by the word list). */
function tidied(c: (typeof CASES)[number], times: Times): EditStore<Project> {
  const s = storeOf(studioProject({ segments: segmentsOf([c.text, 'click save and you are done'], times) }))
  s.update((q) => tidyCaptions(q, { ...DEFAULT_CLEANUP, ...c.cleanup, words: c.words }).project)
  return s
}

describe('Remove of a text fix by its word map', () => {
  it('a kept or pending mark on any tidied word goes back onto exactly the words it came from, with exact, estimated or no word times', () => {
    for (const c of CASES) {
      for (const times of TIMES) {
        for (const auto of [true, false]) {
          for (let j = 0; j < c.back.length; j++) {
            const s = tidied(c, times)
            expect(s.state.transcript!.segments[0].text.replace(/\.$/, '')).toBe(c.tidied)
            s.update((q) => ({ ...q, captionMarks: [mark(q, j, j, auto)] }))
            s.update((q) => removeItems(q, [row(q, TEXT_GROUP)]))
            expect(s.state.transcript!.segments[0].text).toBe(c.text)
            expect(s.state.captionMarks, `${c.text} (${times}${auto ? '' : ', kept'}) word ${j}`).toEqual([expect.objectContaining({ caption: 'c0', text: c.back[j], ...(auto ? { auto: true } : {}) })])
            expect(!!s.state.captionMarks![0].auto).toBe(auto)
          }
        }
      }
    }
  })

  it('a mark over several tidied words, a keyword and an emoji anchor go back too; the caption keeps its place', () => {
    for (const times of TIMES) {
      const s = tidied(CASES[0], times)
      // "Q&A and 50" emphasised (pending, then kept), a pop-up on "Google Docs", an emoji on "50", the caption at the top.
      s.update((q) => ({ ...q, captionMarks: [mark(q, 1, 3)], graphics: [pop(q, 'keyword', 4, 5), pop(q, 'emoji', 3)], captionPlaces: [{ caption: 'c0', position: 'top' }] }))
      s.update((q) => keepItems(q, [row(q, EMPHASIS_GROUP)]))
      s.update((q) => removeItems(q, [row(q, TEXT_GROUP)]))
      expect(s.state.captionMarks, times).toEqual([{ id: 'm', caption: 'c0', from: 1, to: 5, text: 'q and a and fifty' }])
      expect(anchorText(s.state, 'keyword')).toBe('google dogs')
      expect(anchorText(s.state, 'emoji')).toBe('fifty')
      expect(s.state.graphics!.every((g) => !!g.auto)).toBe(true)
      expect(s.state.captionPlaces).toEqual([{ caption: 'c0', position: 'top' }])
      // As saving and reopening gives.
      expect(migrateProject(JSON.parse(JSON.stringify(s.state))).captionMarks).toEqual(s.state.captionMarks)
    }
  })

  it('Make my captions great: its picks and the marks it moved go back with Keep then Remove, in wide and tall frames', () => {
    for (const [times, frame] of TIMES.flatMap((t) => [WIDE, TALL].map((f) => [t, f] as const))) {
      const segments = segmentsOf(['our q and a and fifty google dogs users', 'the r and d and ops teams use google dogs'], times)
      const words = [...CASES[0].words, ...CASES[1].words]
      const p0 = studioProject({ segments })
      // The user's mark on "fifty", made before the run, moves onto "50" with the tidy.
      const before = { ...p0, captionMarks: [{ id: 'u', caption: 'c0', from: 5, to: 5, text: 'fifty' }] }
      const run = planCaptionsGreat({ project: before, frame, cleanup: DEFAULT_CLEANUP, words, by: 'great' }, DEFAULT_GREAT_OPTIONS).project
      expect(run.transcript!.segments.map((s) => s.text)).toEqual(['Our Q&A and 50 Google Docs users', 'the R&D and DevOps teams use Google Docs.'])
      expect(run.captionMarks!.find((m) => m.id === 'u')).toMatchObject({ from: 3, to: 3, text: '50' })
      const s = storeOf(run)
      s.update((q) => ({ ...q, captionMarks: [...(q.captionMarks ?? []), { id: 'a', caption: 'c1', from: 1, to: 1, text: 'R&D', auto: true as const }] }))
      s.update((q) => keepItems(q, [row(q, EMPHASIS_GROUP)]))
      s.update((q) => removeItems(q, [row(q, TEXT_GROUP)]))
      expect(s.state.transcript!.segments.map((x) => x.text)).toEqual(['our q and a and fifty google dogs users', 'the r and d and ops teams use google dogs'])
      expect(s.state.captionMarks!.find((m) => m.id === 'u')?.text, `${times} ${frame.w}`).toBe('fifty')
      expect(s.state.captionMarks!.find((m) => m.caption === 'c1')?.text, `${times} ${frame.w}`).toBe('r and d')
    }
  })
})

describe('a tidy moves marks onto the words made from theirs', () => {
  it('marks on words a tidy writes as one go onto it, and Remove puts them back on their own words', () => {
    for (const times of TIMES) {
      const c = CASES[0]
      // our q and a and fifty google dogs users: "fifty", "q and a", "dogs" and "a" alone (inside "q and a").
      const spans: [number, number, string, string][] = [
        [5, 5, '50', 'fifty'],
        [1, 3, 'Q&A', 'q and a'],
        [7, 7, 'Google Docs', 'google dogs'],
        [3, 3, 'Q&A', 'q and a'],
        [8, 8, 'users', 'users']
      ]
      for (const [from, to, now, back] of spans) {
        const s = storeOf(studioProject({ segments: segmentsOf([c.text, 'click save and you are done'], times) }))
        s.update((q) => ({ ...q, captionMarks: [mark(q, from, to, false)] }))
        s.update((q) => tidyCaptions(q, { ...DEFAULT_CLEANUP, words: c.words }).project)
        expect(s.state.captionMarks?.map((m) => m.text), `${times} ${back}`).toEqual([now])
        s.update((q) => removeItems(q, [row(q, TEXT_GROUP)]))
        expect(s.state.captionMarks?.map((m) => m.text), `${times} ${back}`).toEqual([back])
      }
    }
  })

  it('two tidies in a row: marks from before the first and after the second go back onto the words before the first', () => {
    for (const times of TIMES) {
      const s = storeOf(studioProject({ segments: segmentsOf(['open google dogs with flow in two hundred times', 'click save and you are done'], times) }))
      s.update((q) => ({ ...q, captionMarks: [mark(q, 6, 7, false, 'early')] }))
      s.update((q) => tidyCaptions(q, { ...DEFAULT_CLEANUP, digits: 'off', words: [{ term: 'Google Docs', heard: ['google dogs'] }] }).project)
      expect(s.state.transcript!.segments[0].text).toBe('Open Google Docs with flow in two hundred times')
      s.update((q) => tidyCaptions(q, { ...DEFAULT_CLEANUP, digits: 'all', words: [{ term: 'Flown', heard: ['flow in'] }] }).project)
      expect(s.state.transcript!.segments[0].text).toBe('Open Google Docs with Flown 200 times')
      expect(s.state.captionMarks!.map((m) => m.text)).toEqual(['200'])
      s.update((q) => ({ ...q, captionMarks: [...q.captionMarks!, mark(q, 4, 4, true, 'late'), mark(q, 2, 2, true, 'docs')] }))
      s.update((q) => removeItems(q, [row(q, TEXT_GROUP)]))
      expect(s.state.transcript!.segments[0].text).toBe('open google dogs with flow in two hundred times')
      expect(Object.fromEntries(s.state.captionMarks!.map((m) => [m.id, m.text])), times).toEqual({ docs: 'google dogs', late: 'flow in', early: 'two hundred' })
    }
  })
})

describe('records saved before maps were written', () => {
  /** The tidied project with its text records as an older version saved them: no map. */
  const withoutMaps = (q: Project): Project => ({ ...q, captionAuto: { ...q.captionAuto, text: q.captionAuto!.text!.map(({ map: _m, ...r }) => r) } })

  it('load and save as before; Remove finds the words again, with the documented limit where the map is exact', () => {
    const s = tidied(CASES[3], 'none')
    const old = migrateProject(JSON.parse(JSON.stringify(withoutMaps(s.state))))
    expect(JSON.stringify(migrateProject(JSON.parse(JSON.stringify(old))))).toBe(JSON.stringify(old))
    expect(old.captionAuto!.text!.every((r) => !('map' in r))).toBe(true)
    // "110 and 120": found again, each mark on its own words.
    const t = storeOf(old)
    t.update((q) => ({ ...q, captionMarks: [mark(q, 2, 2, true, 'a'), mark(q, 4, 4, true, 'b')] }))
    t.update((q) => removeItems(q, [row(q, TEXT_GROUP)]))
    expect(t.state.captionMarks!.map((m) => m.text)).toEqual(['a hundred and ten', 'a hundred and twenty'])
    // §11.1's limit for a caption without word times: "Flown" back on "flow" alone without the map.
    const c = CASES[2]
    const guessed = storeOf(withoutMaps(tidied(c, 'none').state))
    guessed.update((q) => ({ ...q, captionMarks: [mark(q, 1)] }))
    guessed.update((q) => removeItems(q, [row(q, TEXT_GROUP)]))
    expect(guessed.state.captionMarks!.map((m) => m.text)).toEqual(['flow'])
    // The same with the map, saved and read back: exact.
    const now = storeOf(migrateProject(JSON.parse(JSON.stringify(tidied(c, 'none').state))))
    expect(now.state.captionAuto!.text![0].map).toEqual([[0, 0, 0, 0], [1, 1, 1, 2], [2, 4, 3, 5]])
    now.update((q) => ({ ...q, captionMarks: [mark(q, 1)] }))
    now.update((q) => removeItems(q, [row(q, TEXT_GROUP)]))
    expect(now.state.captionMarks!.map((m) => m.text)).toEqual(['flow in'])
  })
})
