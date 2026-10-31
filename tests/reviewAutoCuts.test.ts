import { describe, expect, it } from 'vitest'
import { EditStore } from '../src/shared/editor/editStore'
import { applySmartSpeed } from '../src/shared/editor/smartSpeed'
import { cutWords, settleDeletedWords, transcriptWords } from '../src/shared/editor/transcript'
import { createProject, migrateProject } from '../src/shared/engine/project'
import { cutRange, removeClip, setTrimEnd, setTrimStart } from '../src/shared/engine/timeline'
import { MAX_AUTO_CUTS, readAutoCuts, wordsText } from '../src/shared/review/autoCutData'
import { autoCutIntact, footageBack, liveAutoCuts, recordAutoCuts, settleAutoCuts, undoAutoCut, withAutoCuts } from '../src/shared/review/autoCuts'
import { mergeSnapshot, pendingCount, removeItems, reviewItems } from '../src/shared/review/review'
import { suggestionRanges } from '../src/shared/review/wordCuts'
import type { AutoCut, Clip, Project } from '../src/shared/types'

const clip = (start: number, end: number, speed = 1, id = `c${start}`): Clip => ({ id, start, end, speed })
const spans = (clips: Clip[]): [number, number, number][] => clips.map((c) => [+c.start.toFixed(4), +c.end.toFixed(4), c.speed])

function counter(prefix = 'r'): () => string {
  let n = 0
  return () => `${prefix}${++n}`
}

function project(clips: Clip[] = [clip(0, 20)], over: Partial<Project> = {}): Project {
  const p = createProject({
    id: 'p',
    name: 'p',
    duration: 20,
    width: 1280,
    height: 720,
    hasWebcam: false,
    hasAudio: true,
    webcamOffset: 0,
    zooms: [],
    cursorValid: true,
    capture: { method: 'chromium', cursorInVideo: false, region: null }
  })
  return { ...p, clips, ...over }
}

const cut = (over: Partial<AutoCut> = {}): AutoCut => ({ id: 'a', by: 'silences', action: 'cut', start: 4, end: 6, was: [{ start: 4, end: 6, speed: 1 }], ...over })

describe('readAutoCuts (migration)', () => {
  it('is undefined for anything but an array, and for an empty result', () => {
    for (const raw of [undefined, null, 3, 'x', {}, []]) expect(readAutoCuts(raw, 20)).toBeUndefined()
    expect(readAutoCuts([null, 1, 'x', [], { id: 'a' }], 20)).toBeUndefined()
  })

  it('keeps well-formed records and drops malformed ones', () => {
    const good = cut()
    const out = readAutoCuts(
      [
        good,
        { ...good, id: 'a' }, // duplicate id
        { ...good, id: '' },
        { ...good, id: 'x'.repeat(65) },
        { ...good, id: 'b', by: 'magic' },
        { ...good, id: 'c', action: 3 },
        { ...good, id: 'd', start: Number.NaN },
        { ...good, id: 'e', was: [] },
        { ...good, id: 'f', was: [{ start: 1, end: 2, speed: 1 }] }, // outside the range
        { ...good, id: 'g', start: 7, end: 7 },
        { ...good, id: 'h', by: 'smart-speed', action: 4, words: 42 }
      ],
      20
    )
    expect(out?.map((c) => c.id)).toEqual(['a', 'h'])
    expect(out?.[1]).toEqual({ id: 'h', by: 'smart-speed', action: 4, start: 4, end: 6, was: [{ start: 4, end: 6, speed: 1 }] })
  })

  it('clamps ranges, pieces and speeds, cuts the words and copies only known fields', () => {
    const raw = [{ id: 'a', by: 'filler', action: 'cut', start: -3, end: 99, was: [{ start: -1, end: 30, speed: 100, x: 1 }], words: '  um   '.repeat(40), extra: true, __proto__: { polluted: 1 } }]
    const [c] = readAutoCuts(raw, 20)!
    expect(c).toEqual({ id: 'a', by: 'filler', action: 'cut', start: 0, end: 20, was: [{ start: 0, end: 20, speed: 8 }], words: expect.any(String) })
    expect(c.words!.length).toBeLessThanOrEqual(80)
    expect(c.words!.endsWith('…')).toBe(true)
    expect(Object.keys(c)).not.toContain('extra')
  })

  it('keeps the newest MAX_AUTO_CUTS records and at most 64 pieces each', () => {
    const many = Array.from({ length: MAX_AUTO_CUTS + 5 }, (_, i) => cut({ id: `r${i}` }))
    const out = readAutoCuts(many, 20)!
    expect(out).toHaveLength(MAX_AUTO_CUTS)
    expect(out[0].id).toBe('r5')
    const pieces = Array.from({ length: 70 }, (_, i) => ({ start: i * 0.1, end: i * 0.1 + 0.05, speed: 1 }))
    expect(readAutoCuts([cut({ start: 0, end: 10, was: pieces })], 20)![0].was).toHaveLength(64)
  })

  it('is idempotent', () => {
    const once = readAutoCuts([cut(), cut({ id: 'b', words: 'so so', by: 'repeat' })], 20)
    expect(readAutoCuts(once, 20)).toEqual(once)
  })

  it('an old project migrates byte for byte as before: no autoCuts key', () => {
    const old = JSON.parse(JSON.stringify(project()))
    delete old.autoCuts
    const migrated = migrateProject(old)
    expect('autoCuts' in migrated).toBe(false)
    expect(JSON.stringify(migrateProject(JSON.parse(JSON.stringify(migrated))))).toBe(JSON.stringify(migrated))
  })

  it('a project with records keeps them through the migration', () => {
    const p = { ...project([clip(0, 4), clip(6, 20)]), autoCuts: [cut()] }
    expect(migrateProject(JSON.parse(JSON.stringify(p))).autoCuts).toEqual([cut()])
  })

  it('wordsText squeezes spaces and drops empty text', () => {
    expect(wordsText('  um,\n  uh ')).toBe('um, uh')
    expect(wordsText('   ')).toBeUndefined()
  })
})

describe('recordAutoCuts', () => {
  it('records exactly the footage a silence cut removed, with its speed', () => {
    const p = project([clip(0, 10), clip(10, 20, 2)])
    const ranges = [
      { start: 3, end: 5 },
      { start: 12, end: 14 }
    ]
    const next = recordAutoCuts(p, applySmartSpeed(p.clips, ranges, 'cut'), ranges, 'cut', 'silences', counter())
    expect(spans(next.clips)).toEqual([
      [0, 3, 1],
      [5, 10, 1],
      [10, 12, 2],
      [14, 20, 2]
    ])
    expect(next.autoCuts).toEqual([
      { id: 'r1', by: 'silences', action: 'cut', start: 3, end: 5, was: [{ start: 3, end: 5, speed: 1 }] },
      { id: 'r2', by: 'silences', action: 'cut', start: 12, end: 14, was: [{ start: 12, end: 14, speed: 2 }] }
    ])
  })

  it('a sliver cutRange takes next to a range belongs to that range', () => {
    const p = project([clip(0, 5.05), clip(6, 20)])
    // Cutting 4..5 leaves 5..5.05 (shorter than MIN_CLIP): cutRange takes it too.
    const next = recordAutoCuts(p, cutRange(p.clips, 4, 5), [{ start: 4, end: 5 }], 'cut', 'silences', counter())
    expect(next.autoCuts).toEqual([{ id: 'r1', by: 'silences', action: 'cut', start: 4, end: 5.05, was: [{ start: 4, end: 5.05, speed: 1 }] }])
  })

  it('records nothing for a refused cut or unchanged clips', () => {
    const p = project([clip(0, 20)])
    expect(recordAutoCuts(p, p.clips, [{ start: 0, end: 20 }], 'cut', 'silences')).toBe(p)
    // cutRange refuses to cut the whole video: the same clips come back.
    const whole = cutRange(p.clips, 0, 20)
    expect(recordAutoCuts(p, whole, [{ start: 0, end: 20 }], 'cut', 'silences')).toBe(p)
    // A range that changed nothing gets no record while another does.
    const next = recordAutoCuts(p, cutRange(p.clips, 2, 3), [{ start: 2, end: 3 }, { start: 8, end: 9 }], 'cut', 'silences', counter())
    expect(next.autoCuts?.map((c) => [c.start, c.end])).toEqual([[2, 3]])
  })

  it('records only the parts a speed-up changed', () => {
    const p = project([clip(0, 6), clip(6, 10, 8), clip(10, 20)])
    const ranges = [{ start: 4, end: 12 }]
    const next = recordAutoCuts(p, applySmartSpeed(p.clips, ranges, 4), ranges, 4, 'smart-speed', counter())
    expect(next.autoCuts).toEqual([
      {
        id: 'r1',
        by: 'smart-speed',
        action: 4,
        start: 4,
        end: 12,
        was: [
          { start: 4, end: 6, speed: 1 },
          { start: 10, end: 12, speed: 1 }
        ]
      }
    ])
  })

  it('takes `by` and `words` from a range', () => {
    const p = project()
    const next = recordAutoCuts(p, cutRange(p.clips, 2, 3), [{ start: 2, end: 3, by: 'retake', words: 'so the' }], 'cut', 'filler', counter())
    expect(next.autoCuts?.[0]).toMatchObject({ by: 'retake', words: 'so the' })
  })

  it('drops stale records when it writes', () => {
    const p = { ...project([clip(0, 20)]), autoCuts: [cut()] } // 4..6 is not cut: stale
    const next = recordAutoCuts(p, cutRange(p.clips, 10, 11), [{ start: 10, end: 11 }], 'cut', 'silences', counter())
    expect(next.autoCuts?.map((c) => c.id)).toEqual(['r1'])
  })
})

describe('intact, footage back, live', () => {
  it('a cut is intact while none of it plays', () => {
    expect(autoCutIntact(cut(), [clip(0, 4), clip(6, 20)])).toBe(true)
    expect(autoCutIntact(cut(), [clip(0, 4.5), clip(6, 20)])).toBe(false)
    expect(footageBack(cut(), [clip(0, 20)])).toBe(true)
    expect(footageBack(cut(), [clip(0, 20, 2)])).toBe(false)
  })

  it('a speed-up is intact while all of it plays at its speed', () => {
    const fast = cut({ action: 4 })
    expect(autoCutIntact(fast, [clip(0, 4), clip(4, 6, 4), clip(6, 20)])).toBe(true)
    expect(autoCutIntact(fast, [clip(0, 4), clip(4, 6, 2), clip(6, 20)])).toBe(false)
  })

  it('liveAutoCuts lists only intact records', () => {
    const p = { ...project([clip(0, 4), clip(6, 20)]), autoCuts: [cut(), cut({ id: 'b', start: 8, end: 9, was: [{ start: 8, end: 9, speed: 1 }] })] }
    expect(liveAutoCuts(p).map((c) => c.id)).toEqual(['a'])
  })

  it('withAutoCuts leaves no key for an empty list', () => {
    const p = { ...project(), autoCuts: [cut()] }
    expect('autoCuts' in withAutoCuts(p, [])).toBe(false)
    const none = project()
    expect(withAutoCuts(none, [])).toBe(none)
  })
})

describe('undoAutoCut', () => {
  it('restores a cut at 1x', () => {
    expect(spans(undoAutoCut([clip(0, 4), clip(6, 20)], cut(), 20))).toEqual([[0, 20, 1]])
  })

  it('restores a 2x piece next to 1x clips at 2x', () => {
    const c = cut({ was: [{ start: 4, end: 6, speed: 2 }] })
    expect(spans(undoAutoCut([clip(0, 4), clip(6, 20)], c, 20))).toEqual([
      [0, 4, 1],
      [4, 6, 2],
      [6, 20, 1]
    ])
  })

  it('restores a 1x piece between 2x clips at 1x', () => {
    const out = undoAutoCut([clip(0, 4, 2), clip(6, 20, 2)], cut(), 20)
    expect(spans(out)).toEqual([
      [0, 4, 2],
      [4, 6, 1],
      [6, 20, 2]
    ])
  })

  it('takes a speed-up back to 1x and to 0.5x, leaving parts re-timed since', () => {
    const fast = cut({ action: 4, start: 4, end: 10, was: [{ start: 4, end: 6, speed: 1 }, { start: 8, end: 10, speed: 0.5 }] })
    const out = undoAutoCut([clip(0, 4), clip(4, 6, 4), clip(6, 8, 2), clip(8, 10, 4), clip(10, 20)], fast, 20)
    expect(spans(out)).toEqual([
      [0, 4, 1],
      [4, 6, 1],
      [6, 8, 2],
      [8, 10, 0.5],
      [10, 20, 1]
    ])
  })
})

describe('review findings (regressions)', () => {
  it('a cut across a 1x/2x boundary by less than MIN_CLIP comes back exactly', () => {
    const p = project([clip(0, 10.55), clip(10.55, 20, 2)])
    const ranges = [{ start: 9.76, end: 10.57 }]
    const next = recordAutoCuts(p, cutRange(p.clips, 9.76, 10.57), ranges, 'cut', 'silences', counter())
    const [rec] = next.autoCuts!
    expect(rec.was).toEqual([
      { start: 9.76, end: 10.55, speed: 1 },
      { start: 10.55, end: 10.57, speed: 2 }
    ])
    const back = undoAutoCut(next.clips, rec, 20)
    expect(spans(back)).toEqual([
      [0, 10.55, 1],
      [10.55, 20, 2]
    ])
    expect(footageBack(rec, back)).toBe(true)
  })

  it('a sliver piece joins the clip it was part of, never a clip shorter than MIN_CLIP', () => {
    const p = project([clip(16.55, 17.16, 1.5), clip(17.37, 20, 1.5)], { duration: 20 })
    const next = recordAutoCuts(p, cutRange(p.clips, 17.14, 18.85), [{ start: 17.14, end: 18.85 }], 'cut', 'silences', counter())
    const back = undoAutoCut(next.clips, next.autoCuts![0], 20)
    expect(spans(back)).toEqual([
      [16.55, 17.16, 1.5],
      [17.37, 20, 1.5]
    ])
    expect(back.every((c) => c.end - c.start >= 0.1 - 1e-9)).toBe(true)
  })

  it('putting a cut back keeps a split of yours next to it', () => {
    const clips = [clip(0, 4, 1, 'a'), clip(6, 10, 1, 'b'), clip(10, 20, 1, 'c')]
    expect(undoAutoCut(clips, cut(), 20).map((c) => [c.id, c.start, c.end])).toEqual([
      ['a', 0, 10],
      ['c', 10, 20]
    ])
  })

  it('a speed-up stays listed when part of it is cut later, and Remove gives the rest back', () => {
    const p = project([clip(0, 20)])
    const fast = recordAutoCuts(p, applySmartSpeed(p.clips, [{ start: 5, end: 10 }], 4), [{ start: 5, end: 10 }], 4, 'smart-speed', counter())
    const later = recordAutoCuts(fast, cutRange(fast.clips, 7, 7.5), [{ start: 7, end: 7.5, words: 'um' }], 'cut', 'filler', counter('f'))
    expect(liveAutoCuts(later).map((c) => c.by)).toEqual(['smart-speed', 'filler'])
    const speed = later.autoCuts!.find((c) => c.by === 'smart-speed')!
    const back = undoAutoCut(later.clips, speed, 20)
    expect(spans(back)).toEqual([
      [0, 5, 1],
      [5, 7, 1],
      [7.5, 10, 1],
      [10, 20, 1]
    ])
    expect(footageBack(speed, back)).toBe(true)
  })

  it('stale records are dropped by the settle step, so a later hand cut cannot bring one back', () => {
    const p = { ...project([clip(0, 5), clip(6, 20)]), autoCuts: [cut({ start: 5, end: 6, was: [{ start: 5, end: 6, speed: 1 }] })] }
    const restored = settleAutoCuts({ ...p, clips: [clip(0, 20)] }, p)
    expect('autoCuts' in restored).toBe(false)
    const handCut = settleAutoCuts({ ...restored, clips: [clip(0, 4), clip(8, 20)] }, restored)
    expect(liveAutoCuts(handCut)).toEqual([])
    // An edit that leaves the change in place keeps the record (same object back).
    const named = { ...p, name: 'x' }
    expect(settleAutoCuts(named, p)).toBe(named)
  })

  it('two fillers whose cuts meet keep a record each', () => {
    const p = project()
    const ranges = [
      { start: 2, end: 2.5, words: 'um' },
      { start: 2.5, end: 3, words: 'uh' }
    ]
    let clips = p.clips
    for (const r of ranges) clips = cutRange(clips, r.start, r.end)
    const next = recordAutoCuts(p, clips, ranges, 'cut', 'filler', counter())
    expect(next.autoCuts?.map((c) => [c.words, c.start, c.end, c.was])).toEqual([
      ['um', 2, 2.5, [{ start: 2, end: 2.5, speed: 1 }]],
      ['uh', 2.5, 3, [{ start: 2.5, end: 3, speed: 1 }]]
    ])
  })

  it('a range over more than 64 pieces gets several records, and removing them all gives it all back', () => {
    const many = Array.from({ length: 80 }, (_, i) => clip(i * 0.2, i * 0.2 + 0.15, i % 2 ? 1 : 2, `m${i}`))
    const p = project([...many, clip(16, 20)])
    const next = recordAutoCuts(p, cutRange(p.clips, 0, 16), [{ start: 0, end: 16 }], 'cut', 'smart-speed', counter())
    expect(next.autoCuts!.length).toBe(2)
    let clips = next.clips
    for (const c of [...next.autoCuts!].reverse()) clips = undoAutoCut(clips, c, 20)
    expect(spans(clips)).toEqual(spans(p.clips))
  })
})

describe('a hand edit that takes in an automatic cut (settle)', () => {
  // The editor's store: settleDeletedWords, then settleAutoCuts (Editor.tsx).
  const store = (p: Project): EditStore<Project> => new EditStore(p, 200, 800, () => 0, (next: Project, prev: Project) => settleAutoCuts(settleDeletedWords(next, prev), prev))
  const silenceAt = (p: Project, start: number, end: number, newId = counter()): Project => recordAutoCuts(p, cutRange(p.clips, start, end), [{ start, end }], 'cut', 'silences', newId)
  const edit = (s: EditStore<Project>, fn: (clips: Clip[], p: Project) => Clip[]): void => s.update((p) => ({ ...p, clips: fn(p.clips, p) }))

  it('trimming the end over a cut makes it yours: nothing to review, nothing comes back', () => {
    const s = store(silenceAt(project(), 15, 16))
    edit(s, (c, p) => setTrimEnd(c, 10, p.duration))
    expect(spans(s.state.clips)).toEqual([[0, 10, 1]])
    expect('autoCuts' in s.state).toBe(false)
    expect(pendingCount(s.state)).toBe(0)
    // Undo brings the record back with the clips.
    s.undo()
    expect(liveAutoCuts(s.state).map((c) => [c.start, c.end])).toEqual([[15, 16]])
  })

  it('trimming the start over a cut makes it yours', () => {
    const s = store(silenceAt(project(), 2, 3))
    edit(s, (c) => setTrimStart(c, 6))
    expect(spans(s.state.clips)).toEqual([[6, 20, 1]])
    expect(pendingCount(s.state)).toBe(0)
  })

  it('a hand cut around an automatic cut makes it yours', () => {
    const s = store(silenceAt(project(), 5, 6))
    edit(s, (c) => cutRange(c, 3, 9))
    expect(spans(s.state.clips)).toEqual([
      [0, 3, 1],
      [9, 20, 1]
    ])
    expect(pendingCount(s.state)).toBe(0)
  })

  it('deleting the clip next to an automatic cut makes it yours', () => {
    const s = store(silenceAt(project(), 5, 6))
    edit(s, (c) => removeClip(c, c[0].id))
    expect(spans(s.state.clips)).toEqual([[6, 20, 1]])
    expect(pendingCount(s.state)).toBe(0)
  })

  it('a hand cut elsewhere leaves the record listed, and Remove gives back only its own footage', () => {
    const s = store(silenceAt(project(), 5, 6))
    edit(s, (c) => cutRange(c, 12, 14))
    expect(pendingCount(s.state)).toBe(1)
    s.update((p) => removeItems(p, reviewItems(p)))
    expect(spans(s.state.clips)).toEqual([
      [0, 12, 1],
      [14, 20, 1]
    ])
  })

  it('deleting a sentence in the Transcript tab that holds a filler cut makes it yours', () => {
    const transcript = {
      provider: 'test',
      language: 'en',
      createdAt: '',
      segments: [
        {
          id: 's',
          start: 2,
          end: 6,
          text: 'so um hello there',
          words: [
            { text: 'so', start: 2, end: 2.4 },
            { text: 'um', start: 3, end: 3.3 },
            { text: 'hello', start: 4, end: 4.6 },
            { text: 'there', start: 5, end: 5.5 }
          ]
        }
      ]
    }
    const p = project([clip(0, 20)], { transcript: transcript as never })
    const words = transcriptWords(p.transcript!)
    const ranges = suggestionRanges(words, [{ kind: 'filler', first: 1, last: 1 }], p.duration)
    const s = store(recordAutoCuts(p, cutWords(p.clips, words, [[1, 1]], p.duration), ranges, 'cut', 'filler', counter()))
    expect(pendingCount(s.state)).toBe(1)
    edit(s, (c, q) => cutWords(c, words, [[0, 3]], q.duration))
    expect(pendingCount(s.state)).toBe(0)
  })

  it('a tool writing a record next to an earlier one keeps both', () => {
    const s = store(silenceAt(project(), 5, 6, counter('a')))
    s.update((p) => silenceAt(p, 6, 7, counter('b')))
    s.update((p) => silenceAt(p, 4, 5, counter('c')))
    expect(liveAutoCuts(s.state).map((c) => [c.id, c.start, c.end])).toEqual([
      ['a1', 5, 6],
      ['b1', 6, 7],
      ['c1', 4, 5]
    ])
    // Two fillers cut one after the other by two Remove alls, touching.
    const f = store(recordAutoCuts(project(), cutRange(project().clips, 2, 2.5), [{ start: 2, end: 2.5, words: 'um' }], 'cut', 'filler', counter('u')))
    f.update((p) => recordAutoCuts(p, cutRange(p.clips, 2.5, 3), [{ start: 2.5, end: 3, words: 'uh' }], 'cut', 'filler', counter('h')))
    expect(liveAutoCuts(f.state).map((c) => c.words)).toEqual(['um', 'uh'])
  })
})

describe('an automatic change over an earlier automatic speed-up', () => {
  /** Touching spans at the same speed joined: how the video plays. */
  const plays = (clips: Clip[]): [number, number, number][] =>
    spans(clips).reduce<[number, number, number][]>((out, s) => {
      const last = out[out.length - 1]
      if (last && Math.abs(last[1] - s[0]) < 1e-6 && last[2] === s[2]) last[1] = s[1]
      else out.push([...s])
      return out
    }, [])
  const auto = (p: Project, start: number, end: number, action: AutoCut['action'], by: AutoCut['by'], prefix: string): Project =>
    recordAutoCuts(p, applySmartSpeed(p.clips, [{ start, end }], action), [{ start, end }], action, by, counter(prefix))
  /** Removes each listed item in list order, one at a time, as the panel's Delete does. */
  const removeOneByOne = (p: Project): Project => {
    let shown = reviewItems(p)
    for (let k = 0; k < shown.length; k++) {
      const item = shown[k]
      p = removeItems(p, [item])
      shown = mergeSnapshot(shown, reviewItems(p))
    }
    return p
  }

  it('2x and then a cut of the same silence: one record, and Remove brings it back at 1x', () => {
    const fast = auto(project(), 5, 7, 2, 'silences', 'f')
    const cut2 = auto(fast, 5, 7, 'cut', 'silences', 'c')
    expect(cut2.autoCuts).toEqual([{ id: 'c1', by: 'silences', action: 'cut', start: 5, end: 7, was: [{ start: 5, end: 7, speed: 1 }] }])
    const back = removeItems(cut2, reviewItems(cut2))
    expect(plays(back.clips)).toEqual([[0, 20, 1]])
    expect(reviewItems(back)).toEqual([])
  })

  it('2x and then 4x over the same part: Remove brings it back at 1x', () => {
    const p = auto(auto(project(), 5, 9, 2, 'smart-speed', 'f'), 5, 9, 4, 'smart-speed', 'g')
    expect(p.autoCuts?.map((c) => [c.id, c.action, c.was])).toEqual([['g1', 4, [{ start: 5, end: 9, speed: 1 }]]])
    expect(plays(removeItems(p, reviewItems(p)).clips)).toEqual([[0, 20, 1]])
  })

  it('a part of a 2x re-timed to 4x: the 2x keeps the rest, both listed, and removing both gives it all back', () => {
    const p = auto(auto(project(), 5, 15, 2, 'smart-speed', 'f'), 8, 10, 4, 'silences', 'g')
    expect(liveAutoCuts(p).map((c) => [c.id, c.was])).toEqual([
      [
        'f1',
        [
          { start: 5, end: 8, speed: 1 },
          { start: 10, end: 15, speed: 1 }
        ]
      ],
      ['g1', [{ start: 8, end: 10, speed: 1 }]]
    ])
    expect(plays(removeOneByOne(p).clips)).toEqual([[0, 20, 1]])
  })

  it('a cut inside a 2x that a 4x then takes over comes back at 1x', () => {
    const p = auto(auto(auto(project(), 5, 9, 2, 'smart-speed', 'f'), 6, 7, 'cut', 'silences', 'c'), 5, 9, 4, 'smart-speed', 'g')
    expect(liveAutoCuts(p).map((c) => c.id)).toEqual(['c1', 'g1'])
    expect(plays(removeOneByOne(p).clips)).toEqual([[0, 20, 1]])
  })
})
