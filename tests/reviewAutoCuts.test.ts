import { describe, expect, it } from 'vitest'
import { applySmartSpeed } from '../src/shared/editor/smartSpeed'
import { createProject, migrateProject } from '../src/shared/engine/project'
import { cutRange } from '../src/shared/engine/timeline'
import { MAX_AUTO_CUTS, readAutoCuts, wordsText } from '../src/shared/review/autoCutData'
import { autoCutIntact, footageBack, liveAutoCuts, recordAutoCuts, undoAutoCut, withAutoCuts } from '../src/shared/review/autoCuts'
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
