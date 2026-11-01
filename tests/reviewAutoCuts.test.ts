import { readdirSync, readFileSync } from 'node:fs'
import path from 'node:path'
import { describe, expect, it } from 'vitest'
import { projectCopy } from '../src/shared/editor/duplicate'
import { setRangeSpeed } from '../src/shared/editor/clips'
import { EditStore } from '../src/shared/editor/editStore'
import { applySmartSpeed } from '../src/shared/editor/smartSpeed'
import { cutWords, settleDeletedWords, transcriptWords } from '../src/shared/editor/transcript'
import { createProject, migrateProject } from '../src/shared/engine/project'
import { cutRange, removeClip, setTrimEnd, setTrimStart } from '../src/shared/engine/timeline'
import { MAX_AUTO_CUT_OUTCOMES, MAX_AUTO_CUT_PIECES, MAX_AUTO_CUTS, MAX_WAS_PIECES, readAutoCutOutcomes, readAutoCuts, withOutcomes, wordsText } from '../src/shared/review/autoCutData'
import { autoCutIntact, changeGone, liveAutoCuts, recordAutoCuts, settleAutoCuts, undoAutoCut, withAutoCuts, withoutSpeedUp } from '../src/shared/review/autoCuts'
import { keepItems, mergeSnapshot, pendingCount, removeItems, reviewItems, reviewStatus, type ReviewItem } from '../src/shared/review/review'
import { suggestionRanges } from '../src/shared/review/wordCuts'
import type { AutoCut, AutoCutOutcome, Clip, Project } from '../src/shared/types'

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

/** `n` pieces spread over [a, b] (all of the video by default), each half of its share. */
const spread = (n: number, speed = 1, a = 0, b = 20): AutoCut['was'] =>
  Array.from({ length: n }, (_, i) => ({ start: a + ((b - a) * i) / n, end: a + ((b - a) * (i + 0.5)) / n, speed }))

/** Three cut records side by side: the newest two fit in MAX_AUTO_CUT_PIECES, the oldest does not. */
const budgetCase = (): AutoCut[] => [
  cut({ id: 'old', start: 0, end: 2, was: spread(100, 1, 0, 2) }),
  cut({ id: 'mid', start: 2, end: 18, was: spread(MAX_AUTO_CUT_PIECES - 50, 1, 2, 18) }),
  cut({ id: 'new', start: 18, end: 20, was: spread(40, 1, 18, 20) })
]

/**
 * The most records of `pieces` pieces each that a project file keeps: MAX_AUTO_CUTS of a few,
 * fewer of more (MAX_AUTO_CUT_PIECES in all).
 */
const most = (pieces: number): number => Math.min(MAX_AUTO_CUTS, Math.floor(MAX_AUTO_CUT_PIECES / pieces))
/** The most pieces each of MAX_AUTO_CUTS records can hold. */
const FEW = Math.floor(MAX_AUTO_CUT_PIECES / MAX_AUTO_CUTS)

/**
 * The pieces of the k-th of `n` records of one action, `per` each, that no other of them shares (a
 * file is read so, as the editor writes it): [a, b] cut into n * per cells, its j-th piece in cell
 * j * n + k, from `off` of the cell for `len` of it. So each record's pieces are spread over all of
 * [a, b], as one record over it would be.
 */
const cells = (n: number, per: number, k: number, a: number, b: number, speed: number, off = 0, len = 1): AutoCut['was'] =>
  Array.from({ length: per }, (_, j) => {
    const w = (b - a) / (n * per)
    return { start: a + (j * n + k + off) * w, end: a + (j * n + k + off + len) * w, speed }
  })

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

  it('keeps the newest records that fit whole: MAX_AUTO_CUTS of them, MAX_AUTO_CUT_PIECES pieces in all', () => {
    const many = Array.from({ length: MAX_AUTO_CUTS + 5 }, (_, i) => {
      const [was] = cells(MAX_AUTO_CUTS + 5, 1, i, 0, 20, 1)
      return cut({ id: `r${i}`, start: was.start, end: was.end, was: [was] })
    })
    const out = readAutoCuts(many, 20)!
    expect(out).toHaveLength(MAX_AUTO_CUTS)
    expect(out[0].id).toBe('r5')
    // A record keeps all its pieces, past the MAX_WAS_PIECES a tool run writes in one (Keep of the
    // speed-ups inside one splits it).
    expect(readAutoCuts([cut({ start: 0, end: 20, was: spread(MAX_WAS_PIECES + 17) })], 20)![0].was).toHaveLength(MAX_WAS_PIECES + 17)
    // The newest records whole, up to the first that does not fit in the pieces left.
    const big = readAutoCuts(budgetCase(), 20)!
    expect(big.map((c) => [c.id, c.was.length])).toEqual([
      ['mid', MAX_AUTO_CUT_PIECES - 50],
      ['new', 40]
    ])
    expect(readAutoCuts(big, 20)).toEqual(big)
    expect(readAutoCuts([cut({ start: 0, end: 20, was: spread(MAX_AUTO_CUT_PIECES + 1) })], 20)).toBeUndefined()
  })

  it('is idempotent', () => {
    const once = readAutoCuts([cut(), cut({ id: 'b', words: 'so so', by: 'repeat', start: 8, end: 9, was: [{ start: 8, end: 9, speed: 1 }] }), cut({ id: 'c', was: [{ start: 5, end: 7, speed: 1 }] })], 20)
    expect(once?.map((c) => c.id)).toEqual(['a', 'b'])
    expect(readAutoCuts(once, 20)).toEqual(once)
  })

  it('keeps of a piece over footage a piece of the same action read before it holds only the part past it, and drops a record left with none', () => {
    // The editor never writes two pieces of one action over the same footage by more than 1 ms: a cut
    // or a speed-up claims footage no other record of its action holds. Below that it can (a record
    // whose footage plays again for under 1 ms stays, and a later run claims it again), so a piece
    // is never dropped for the part it shares: only that part goes.
    const out = readAutoCuts(
      [
        cut({ id: 'a', start: 0, end: 10, was: [{ start: 1, end: 3, speed: 1 }, { start: 2, end: 4, speed: 1 }, { start: 5, end: 6, speed: 1 }] }),
        cut({ id: 'b', start: 0, end: 10, was: [{ start: 5.5, end: 7, speed: 1 }] }),
        cut({ id: 'c', start: 0, end: 10, was: [{ start: 6, end: 7, speed: 2 }] }),
        cut({ id: 'd', start: 0, end: 10, was: [{ start: 1.5, end: 2.5, speed: 1 }] }),
        cut({ id: 's', by: 'smart-speed', action: 2, start: 0, end: 10, was: [{ start: 1, end: 3, speed: 1 }] }),
        cut({ id: 't', by: 'polish', action: 2, start: 0, end: 10, was: [{ start: 2.999, end: 4, speed: 1 }] })
      ],
      20
    )!
    expect(out.map((c) => [c.id, c.was.map((w) => [w.start, w.end])])).toEqual([
      ['a', [[1, 3], [3, 4], [5, 6]]],
      ['b', [[6, 7]]],
      ['s', [[1, 3]]],
      ['t', [[3, 4]]]
    ])
    expect(readAutoCuts(out, 20)).toEqual(out)
  })

  it('a hand-made file with a cut holding all of a speed-up many times over: Delete on the speed-up does not split every copy', () => {
    // A 2x over [1, 481] holding 2000 pieces at 1x, and a filler cut holding 1000 copies of all of it
    // at 2x. Read whole, one Remove split every copy at every piece end of the 2x (2 million pieces;
    // with 8000 and 2000 the editor ran out of memory).
    const D = 500
    const s = cut({ id: 's', by: 'smart-speed', action: 2, start: 1, end: 481, was: Array.from({ length: 2000 }, (_, k) => ({ start: 1 + 0.24 * k, end: 1.12 + 0.24 * k, speed: 1 })) })
    const c = cut({ id: 'c', by: 'filler', start: 1, end: 481, was: Array.from({ length: 1000 }, () => ({ start: 1, end: 481, speed: 2 })) })
    const p = migrateProject(JSON.parse(JSON.stringify(project([clip(0, 1), clip(1, 481, 2), clip(481, D)], { duration: D, autoCuts: [c, s] }))))
    expect(p.autoCuts!.map((x) => [x.id, x.was.length])).toEqual([
      ['c', 1],
      ['s', 2000]
    ])
    const t = performance.now()
    const out = removeItems(p, reviewItems(p))
    expect(performance.now() - t).toBeLessThan(2000)
    expect(out.autoCutOutcomes).toEqual([{ id: 's', outcome: 'removed' }])
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

describe('readAutoCutOutcomes (migration)', () => {
  const kept = (id: string): AutoCutOutcome => ({ id, outcome: 'kept' })
  const removed = (id: string): AutoCutOutcome => ({ id, outcome: 'removed' })

  it('is undefined for anything but an array, and for an empty result', () => {
    for (const raw of [undefined, null, 3, 'x', {}, []]) expect(readAutoCutOutcomes(raw)).toBeUndefined()
    expect(readAutoCutOutcomes([null, 1, 'x', [], { id: 'a' }, { outcome: 'kept' }])).toBeUndefined()
  })

  it('keeps well-formed entries, copies only known fields and drops malformed ones', () => {
    const out = readAutoCutOutcomes([
      kept('a'),
      { id: '', outcome: 'kept' },
      { id: 'x'.repeat(65), outcome: 'kept' },
      { id: 'x'.repeat(64), outcome: 'removed' },
      { id: 7, outcome: 'kept' },
      { id: 'b', outcome: 'maybe' },
      { id: 'c', outcome: 'pending' },
      { id: 'd', outcome: 'KEPT' },
      [kept('e')],
      { id: 'f', outcome: 'removed', extra: true, __proto__: { polluted: 1 } }
    ])
    expect(out).toEqual([kept('a'), removed('x'.repeat(64)), removed('f')])
    expect(Object.keys(out![2])).toEqual(['id', 'outcome'])
  })

  it('keeps one entry per id: a later entry is the newer choice and takes its place', () => {
    expect(readAutoCutOutcomes([kept('a'), removed('b'), removed('a'), kept('c')])).toEqual([removed('b'), removed('a'), kept('c')])
  })

  it('keeps the newest MAX_AUTO_CUT_OUTCOMES', () => {
    const many = Array.from({ length: MAX_AUTO_CUT_OUTCOMES + 5 }, (_, i) => kept(`r${i}`))
    const out = readAutoCutOutcomes(many)!
    expect(out).toHaveLength(MAX_AUTO_CUT_OUTCOMES)
    expect(out[0].id).toBe('r5')
    expect(out[out.length - 1].id).toBe(`r${MAX_AUTO_CUT_OUTCOMES + 4}`)
    // Duplicates are folded before the cap: 1000 distinct ids after them are all kept.
    expect(readAutoCutOutcomes([...many.slice(0, 10), ...many.slice(0, 10), ...many.slice(10, MAX_AUTO_CUT_OUTCOMES)])).toHaveLength(MAX_AUTO_CUT_OUTCOMES)
  })

  it('is idempotent', () => {
    for (const raw of [[kept('a'), removed('b')], [kept('a'), removed('a'), { id: 'z', outcome: 'x' }], Array.from({ length: 1200 }, (_, i) => (i % 3 ? kept(`r${i % 700}`) : removed(`r${i}`)))]) {
      const once = readAutoCutOutcomes(raw)
      expect(readAutoCutOutcomes(once)).toEqual(once)
    }
  })

  it('withOutcomes adds a choice at the end, replaces an older one for its id and keeps the newest 1000', () => {
    expect(withOutcomes([kept('a'), kept('b')], [removed('a')])).toEqual([kept('b'), removed('a')])
    const full = Array.from({ length: MAX_AUTO_CUT_OUTCOMES }, (_, i) => kept(`r${i}`))
    const out = withOutcomes(full, [removed('new')])
    expect(out).toHaveLength(MAX_AUTO_CUT_OUTCOMES)
    expect([out[0].id, out[out.length - 1]]).toEqual(['r1', removed('new')])
  })

  it('an old project, and one with records but no choice, migrate with no autoCutOutcomes key, byte for byte', () => {
    for (const p of [project(), { ...project([clip(0, 4), clip(6, 20)]), autoCuts: [cut()] }]) {
      const old = JSON.parse(JSON.stringify(p))
      const migrated = migrateProject(old)
      expect('autoCutOutcomes' in migrated).toBe(false)
      expect(JSON.stringify(migrated)).toBe(JSON.stringify(migrateProject(JSON.parse(JSON.stringify(p)))))
      expect(JSON.stringify(migrateProject(JSON.parse(JSON.stringify(migrated))))).toBe(JSON.stringify(migrated))
    }
    // An empty or broken list is no choice: no key.
    for (const autoCutOutcomes of [[], [{ id: '', outcome: 'kept' }], 'kept']) expect('autoCutOutcomes' in migrateProject({ ...JSON.parse(JSON.stringify(project())), autoCutOutcomes })).toBe(false)
  })

  it('a project with choices keeps them through the migration, saved and opened again the same', () => {
    const p = { ...project([clip(0, 4), clip(6, 20)]), autoCuts: [cut()], autoCutOutcomes: [kept('gone'), removed('x')] }
    const migrated = migrateProject(JSON.parse(JSON.stringify(p)))
    expect(migrated.autoCutOutcomes).toEqual([kept('gone'), removed('x')])
    expect(JSON.stringify(migrateProject(JSON.parse(JSON.stringify(migrated))))).toBe(JSON.stringify(migrated))
  })

  it('Duplicate and the vertical and square copies carry the choices with the records', () => {
    const p = { ...project([clip(0, 4), clip(6, 20)]), autoCuts: [cut()], autoCutOutcomes: [kept('k1'), removed('r1')] }
    for (const kind of ['copy', 'vertical', 'square'] as const) {
      const copy = projectCopy(p, kind, (s, px) => s.length * px * 0.5)
      expect(copy.autoCuts).toEqual(p.autoCuts)
      expect(copy.autoCutOutcomes).toEqual(p.autoCutOutcomes)
      // Main checks the copy with migrateProject before writing it.
      const written = migrateProject(JSON.parse(JSON.stringify(copy)))
      expect([written.autoCuts, written.autoCutOutcomes]).toEqual([p.autoCuts, p.autoCutOutcomes])
    }
  })

  it('only Review mode and the migration read the choices: never rendering, export, captions or the audio plan', () => {
    const root = path.resolve(__dirname, '../src')
    const files = (dir: string): string[] => readdirSync(dir, { withFileTypes: true }).flatMap((e) => (e.isDirectory() ? files(path.join(dir, e.name)) : /\.tsx?$/.test(e.name) ? [path.join(dir, e.name)] : []))
    const readers = files(root)
      .filter((f) => readFileSync(f, 'utf8').includes('autoCutOutcomes'))
      .map((f) => path.relative(root, f).split(path.sep).join('/'))
      .sort()
    expect(readers.filter((f) => !f.startsWith('shared/review/'))).toEqual(['shared/engine/project.ts', 'shared/types.ts'])
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

describe('intact, change gone, live', () => {
  it('a cut is intact while none of it plays, and gone once all of it plays again, at any speed', () => {
    expect(autoCutIntact(cut(), [clip(0, 4), clip(6, 20)])).toBe(true)
    expect(autoCutIntact(cut(), [clip(0, 4.5), clip(6, 20)])).toBe(false)
    expect(changeGone(cut(), [clip(0, 20)])).toBe(true)
    expect(changeGone(cut(), [clip(0, 20, 2)])).toBe(true)
    expect(changeGone(cut(), [clip(0, 4.5), clip(6, 20)])).toBe(false)
    expect(changeGone(cut(), [clip(0, 4), clip(6, 20)])).toBe(false)
  })

  it('a speed-up is intact while all of it plays at its speed, and gone once none of it does', () => {
    const fast = cut({ action: 4 })
    expect(autoCutIntact(fast, [clip(0, 4), clip(4, 6, 4), clip(6, 20)])).toBe(true)
    expect(autoCutIntact(fast, [clip(0, 4), clip(4, 6, 2), clip(6, 20)])).toBe(false)
    expect(changeGone(fast, [clip(0, 20)])).toBe(true)
    expect(changeGone(fast, [clip(0, 4), clip(4, 6, 2), clip(6, 20)])).toBe(true)
    expect(changeGone(fast, [clip(0, 4), clip(4.5, 20)])).toBe(true)
    expect(changeGone(fast, [clip(0, 4), clip(4, 5, 4), clip(5, 20)])).toBe(false)
    // All of it cut since: none of it plays sped up any more.
    expect(changeGone(fast, [clip(0, 4), clip(6, 20)])).toBe(true)
  })

  it('liveAutoCuts lists only intact records', () => {
    const p = { ...project([clip(0, 4), clip(6, 20)]), autoCuts: [cut(), cut({ id: 'b', start: 8, end: 9, was: [{ start: 8, end: 9, speed: 1 }] })] }
    expect(liveAutoCuts(p).map((c) => c.id)).toEqual(['a'])
  })

  // Hand-written files over a 2000 s video, so that a thousand records' pieces, each spread over the
  // footage, stay far longer than the 1 ms the clips may differ by. A file never holds two pieces of
  // one action over the same footage (readAutoCuts), so the records of each action share it out
  // (cells), as many as a file keeps: ten thousand of a few pieces each, or a thousand of 64.
  const D = 2000
  const at = (t: number): number => (t * D) / 20

  it('records from a project file that hold their footage at their own speed are listed and settled at once', () => {
    // Hand-written 4x records, each holding its pieces at 4x and playing them at 4x, over clips at 1x:
    // none is intact. Walking every order of them took seconds for ten, and ages for a thousand.
    for (const [n, per] of [
      [10, 1],
      [most(FEW), FEW],
      [most(MAX_WAS_PIECES), MAX_WAS_PIECES]
    ]) {
      const list = readAutoCuts(
        Array.from({ length: n }, (_, k) => cut({ id: `r${k}`, action: 4, start: 0, end: D, was: cells(n, per, k, 0, D, 4) })),
        D
      )!
      expect(list).toHaveLength(n)
      const p = project([clip(0, D)], { duration: D, autoCuts: list })
      const t = performance.now()
      expect(reviewItems(p)).toEqual([])
      expect(settleAutoCuts({ ...p, clips: [clip(0, D)] }, p).autoCuts).toBeUndefined()
      expect(performance.now() - t).toBeLessThan(500)
    }
  })

  it('records from a project file over three rising speeds are listed, shown and settled at once', () => {
    // Hand-written records over the same footage: 2x ones holding [0,D] at 1x, 4x ones [D/3,D] at 2x
    // and 8x ones [2D/3,D] at 4x, with the video at 2x, 4x and then 8x from those points, so every 4x
    // and 8x hands on what the slower ones hold. Following each way through them took seconds for a
    // few hundred records and minutes for a thousand.
    const rising = (n: number, per: number): AutoCut[] =>
      readAutoCuts(
        Array.from({ length: n }, (_, k) => {
          const action = ([2, 4, 8] as const)[k % 3]
          const start = ((k % 3) * D) / 3
          return cut({ id: `r${k}`, action, start, end: D, was: cells(n / 3, per, Math.floor(k / 3), start, D, action / 2) })
        }),
        D
      )!
    // A third of them at each speed.
    const thirds = (n: number): number => n - (n % 3)
    for (const [n, per] of [
      [300, 3],
      [thirds(most(FEW)), FEW],
      [thirds(most(MAX_WAS_PIECES)), MAX_WAS_PIECES]
    ]) {
      const p = project([clip(0, D / 3, 2), clip(D / 3, (2 * D) / 3, 4), clip((2 * D) / 3, D, 8)], { duration: D, autoCuts: rising(n, per) })
      expect(p.autoCuts).toHaveLength(n)
      const t = performance.now()
      const list = reviewItems(p)
      expect(list).toHaveLength(n)
      expect(list.every((i) => reviewStatus(p, i) === 'pending')).toBe(true)
      expect(settleAutoCuts({ ...p, clips: [clip(0, D)] }, p).autoCuts).toBeUndefined()
      expect(performance.now() - t).toBeLessThan(500)
    }
  })

  it('as many records as a project file keeps, half of them speed-ups that go and half cuts inside them, are settled at once', () => {
    // Hand-written: 8x records over [1,20] holding it at 4x, and cuts holding all of it at 8x, over a
    // video cut down to [0,1]. Every 8x goes with its change gone, and each cut takes the 4x it held
    // from before them (settledOf), the latest first.
    for (const P of [FEW, MAX_WAS_PIECES]) {
      const n = most(P) / 2
      const list = readAutoCuts(
        [
          ...Array.from({ length: n }, (_, k) => cut({ id: `s${k}`, action: 8, start: at(1), end: D, was: cells(n, P, k, at(1), D, 4) })),
          ...Array.from({ length: n }, (_, k) => cut({ id: `c${k}`, start: at(1), end: D, was: cells(n, P, k, at(1), D, 8) }))
        ],
        D
      )!
      expect(list).toHaveLength(2 * n)
      const p = project([clip(0, at(1))], { duration: D, autoCuts: list })
      const t = performance.now()
      const out = settleAutoCuts({ ...p, clips: [clip(0, at(1))] }, p).autoCuts!
      expect(performance.now() - t).toBeLessThan(500)
      expect(out.map((c) => c.id)).toEqual(list.filter((c) => c.action === 'cut').map((c) => c.id))
      expect(out.every((c) => c.was.length === P && c.was.every((w) => w.speed === 4))).toBe(true)
    }
  })

  it('as many records as a project file keeps, half of them speed-ups that go as kept inside the other half, are settled at once', () => {
    // Hand-written: 2x records over [0,10] and 4x records over [0,20] that sped it up from 2x, their
    // pieces interleaved, with [15,20] set back to 1x by hand: every 4x goes, still playing at 4x in
    // [10,15], and each 2x gives up the parts of them it held. One 4x at a time took seconds.
    for (const P of [FEW, MAX_WAS_PIECES]) {
      const n = most(P) / 2
      const list = readAutoCuts(
        [
          ...Array.from({ length: n }, (_, k) => cut({ id: `t${k}`, action: 2, start: 0, end: at(10), was: cells(n, P, k, 0, at(10), 1, 0, 0.5) })),
          ...Array.from({ length: n }, (_, k) => cut({ id: `f${k}`, action: 4, start: 0, end: D, was: cells(n, P, k, 0, D, 2, 0.5, 0.5) }))
        ],
        D
      )!
      expect(list).toHaveLength(2 * n)
      const p = project([clip(0, at(10), 2), clip(at(10), D, 4)], { duration: D, autoCuts: list })
      const t = performance.now()
      const out = settleAutoCuts({ ...p, clips: [clip(0, at(10), 2), clip(at(10), at(15), 4), clip(at(15), D, 1)] }, p).autoCuts ?? []
      expect(performance.now() - t).toBeLessThan(500)
      expect(out.every((c) => c.action === 2)).toBe(true)
    }
  })

  it('an edit by hand that takes away half the records of a project file, all speed-ups, settles at once, with the records left around them', () => {
    // Hand-written: Polish 4x records over [0,10], each holding small pieces at 1x, with the video at
    // 4x there, and retake cuts over [10,20] holding as many at 4x each. [0,10] set to 1x (or 8x) by
    // hand: every 4x goes, read removed. Taking them back one at a time from every record left,
    // piece by piece, froze the editor for seconds on this one edit.
    for (const P of [FEW, MAX_WAS_PIECES]) {
      const n = most(P) / 2
      const list = readAutoCuts(
        [
          ...Array.from({ length: n }, (_, k) => cut({ id: `g${k}`, by: 'polish', action: 4, start: 0, end: at(10), was: cells(n, P, k, 0, at(10), 1, 0, 0.5) })),
          ...Array.from({ length: n }, (_, k) => cut({ id: `c${k}`, by: 'retake', start: at(10), end: D, was: cells(n, P, k, at(10), D, 4, 0, 0.5) }))
        ],
        D
      )!
      expect(list).toHaveLength(2 * n)
      const p = project([clip(0, at(10), 4)], { duration: D, autoCuts: list })
      for (const speed of [1, 8]) {
        const t = performance.now()
        const out = settleAutoCuts({ ...p, clips: [clip(0, at(10), speed)] }, p).autoCuts!
        expect(performance.now() - t).toBeLessThan(500)
        // The cuts hold nothing inside a speed-up that went: the same records, as they were.
        expect(out).toHaveLength(n)
        expect(out.every((c, k) => c === list[n + k])).toBe(true)
      }
    }
  })

  it('an edit by hand that takes away half the records of a project file, all speed-ups, around as many faster ones, settles at once', () => {
    // Hand-written: 2x records holding pieces at 1x spread over all of the video, and 4x records over
    // the same footage holding each of those pieces and a little more at 2x, with the video at 4x;
    // [10,20] set to 1x by hand. Every 2x goes read removed and every 4x read kept. Each 2x went
    // through every 4x, piece by piece, for seconds.
    for (const P of [FEW, MAX_WAS_PIECES]) {
      const n = most(P) / 2
      const list = readAutoCuts(
        [
          ...Array.from({ length: n }, (_, k) => cut({ id: `t${k}`, action: 2, start: 0, end: D, was: cells(n, P, k, 0, D, 1, 0, 0.9) })),
          ...Array.from({ length: n }, (_, k) => cut({ id: `f${k}`, action: 4, start: 0, end: D, was: cells(n, P, k, 0, D, 2, 0, 0.95) }))
        ],
        D
      )!
      expect(list).toHaveLength(2 * n)
      const p = project([clip(0, D, 4)], { duration: D, autoCuts: list })
      const t = performance.now()
      const out = settleAutoCuts({ ...p, clips: [clip(0, at(10), 4), clip(at(10), D, 1)] }, p)
      expect(performance.now() - t).toBeLessThan(500)
      expect(out.autoCuts).toBeUndefined()
    }
  })

  it('as many speed-ups as a project file keeps, each holding small pieces at every speed, over a video all at 8x, settle at once', () => {
    // Hand-written 2x, 4x and 8x records over all of the video, each with short pieces at 1x, 2x and
    // 4x placed at random in its own share of it; the video plays at 8x. Every 2x and 4x goes when
    // the clips change; taking each back from every record left, piece by piece, took over a second.
    let x = 12345
    const rnd = (): number => {
      x ^= x << 13
      x ^= x >>> 17
      x ^= x << 5
      return ((x >>> 0) % 1000000) / 1000000
    }
    for (const P of [FEW, MAX_WAS_PIECES]) {
      const n = most(P)
      const list = readAutoCuts(
        Array.from({ length: n }, (_, k) =>
          cut({
            id: `r${k}`,
            action: ([2, 4, 8] as const)[k % 3],
            start: 0,
            end: D,
            was: cells(Math.ceil(n / 3), P, Math.floor(k / 3), 0, D, 1).map((c, j) => {
              const a = rnd() * 0.5
              return { start: c.start + a * (c.end - c.start), end: c.start + (a + 0.05 + rnd() * 0.45) * (c.end - c.start), speed: [1, 2, 4][(k + j) % 3] }
            })
          })
        ),
        D
      )!
      expect(list).toHaveLength(n)
      const p = project([clip(0, D, 8)], { duration: D, autoCuts: list })
      const t = performance.now()
      const out = settleAutoCuts({ ...p, clips: [clip(0, D, 8, 'other')] }, p)
      expect(performance.now() - t).toBeLessThan(500)
      expect(out.autoCuts?.every((c) => c.action === 8)).toBe(true)
    }
  })

  it('withAutoCuts leaves no key for an empty list', () => {
    const p = { ...project(), autoCuts: [cut()] }
    expect('autoCuts' in withAutoCuts(p, [])).toBe(false)
    const none = project()
    expect(withAutoCuts(none, [])).toBe(none)
  })

  it('withAutoCuts keeps the records a project file keeps, so the project opens again as it was', () => {
    const p = withAutoCuts(project(), budgetCase())
    expect(p.autoCuts!.map((c) => c.id)).toEqual(['mid', 'new'])
    expect(migrateProject(JSON.parse(JSON.stringify(p))).autoCuts).toEqual(p.autoCuts)
  })

  it('Remove all over chains of slivers from a project file, handed on or joined across one at a time, takes milliseconds', () => {
    // Hand-written: 200 'silences' cuts, each a chain of 64 touching 1.5 ms pieces at 1.25x and 1x in
    // turn (too short to come back alone or together), each chain with a filler cut still to review
    // touching its right end, or a clip at 2x. Remove all on Silences hands the chain to the filler
    // cut (or joins it to the 2x clip) a piece at a time, from the right: one pass over all the
    // pieces for each one took tens of seconds.
    const R = 200
    const P = MAX_WAS_PIECES
    const w = 0.0015
    const cell = P * w + 0.2
    const D = R * cell + 2
    for (const beside of ['filler', 'clip'] as const) {
      const recs: AutoCut[] = []
      const clips: Clip[] = [clip(0, 1)]
      for (let k = 0; k < R; k++) {
        const x0 = 1.01 + k * cell
        const was = Array.from({ length: P }, (_, j) => ({ start: x0 + j * w, end: x0 + (j + 1) * w, speed: j % 2 ? 1 : 1.25 }))
        recs.push(cut({ id: `s${k}`, start: x0, end: x0 + P * w, was }))
        if (beside === 'filler') {
          recs.push(cut({ id: `f${k}`, by: 'filler', start: x0 + P * w, end: x0 + P * w + 0.05, was: [{ start: x0 + P * w, end: x0 + P * w + 0.05, speed: 1 }] }))
          clips.push(clip(x0 + P * w + 0.06, x0 + cell - 0.01, 1, `c${k}`))
        } else clips.push(clip(x0 + P * w, x0 + cell - 0.01, 2, `c${k}`))
      }
      const p = project(clips, { duration: D, autoCuts: readAutoCuts(recs, D) })
      const silences = reviewItems(p).filter((i) => i.kind === 'silence')
      expect(silences).toHaveLength(R)
      const t = performance.now()
      const out = removeItems(p, silences)
      expect(performance.now() - t).toBeLessThan(1000)
      if (beside === 'filler') {
        // Each filler cut holds all but the first piece of its chain (64 pieces at most).
        expect(out.autoCuts!.map((c) => c.was.length)).toEqual(Array.from({ length: R }, () => P))
        expect(out.clips).toHaveLength(R + 1)
      } else {
        // Every piece joins the 2x clip beside its chain.
        expect(out.autoCuts).toBeUndefined()
        expect(out.clips.slice(1).every((c, k) => c.start === 1.01 + k * cell && c.speed === 2)).toBe(true)
      }
    }
  })

  it('two records from a project file with 32,000 pieces each: taking one from under the other and a Keep take milliseconds', () => {
    // Hand-written, over a 600 s video at 2x: a 2x whose pieces cover it all, at 1x and 0.5x in turn,
    // and a cut holding a sliver inside each at 2x. The 2x taken from under the cut (withoutSpeedUp:
    // its Remove, or a later run taking it over): the cut holds its slivers at the 2x's speeds from
    // before. Then a 4x holding those slivers at 2x inside such a 2x, over a video at 4x, the 4x kept:
    // the 2x gives up its parts (withSpeedUpKept). Each compared every piece of one record with every
    // piece of the other: seconds.
    const D = 600
    const n = MAX_AUTO_CUT_PIECES / 2
    const half = (off: number, speed: number) =>
      Array.from({ length: n }, (_, j) => ({ start: (D * (j + off)) / n, end: (D * (j + off + 0.5)) / n, speed }))
    const whole = Array.from({ length: n }, (_, j) => ({ start: (D * j) / n, end: (D * (j + 1)) / n, speed: j % 2 ? 0.5 : 1 }))
    const over = project([clip(0, D, 2)], {
      duration: D,
      autoCuts: readAutoCuts([cut({ id: 'c', by: 'retake', start: 0, end: D, was: half(0.25, 2) }), cut({ id: 's', by: 'smart-speed', action: 2, start: 0, end: D, was: whole })], D)
    })
    expect(over.autoCuts!.map((c) => c.was.length)).toEqual([n, n])
    let t = performance.now()
    const [c, s] = withoutSpeedUp(over.autoCuts!, over.autoCuts![1])
    expect(performance.now() - t).toBeLessThan(500)
    expect(c.was.map((p) => p.speed)).toEqual(whole.map((w) => w.speed))
    expect(s).toBe(over.autoCuts![1])
    const kept = project([clip(0, D, 4)], {
      duration: D,
      autoCuts: readAutoCuts([cut({ id: 't', by: 'smart-speed', action: 2, start: 0, end: D, was: whole }), cut({ id: 'f', by: 'polish', action: 4, start: 0, end: D, was: half(0.25, 2) })], D)
    })
    t = performance.now()
    const listed = reviewItems(kept)
    expect(listed.map((i) => i.key)).toEqual(['cut:f'])
    const after = keepItems(kept, listed)
    expect(performance.now() - t).toBeLessThan(500)
    expect(after.autoCuts!.find((c) => c.id === 't')!.was).toHaveLength(2 * n)
  })
})

describe('a record that grows past MAX_WAS_PIECES opens again with all its pieces', () => {
  const D = 600
  const editor = (): EditStore<Project> =>
    new EditStore(project([clip(0, D)], { duration: D }), 200, 800, () => 0, (n: Project, p: Project) => settleAutoCuts(settleDeletedWords(n, p), p))
  const reopen = (p: Project): Project => migrateProject(JSON.parse(JSON.stringify(p)))
  const covered = (clips: Clip[], a: number, b: number, speed?: number): number =>
    clips.reduce((n, c) => n + (speed === undefined || c.speed === speed ? Math.max(0, Math.min(b, c.end) - Math.max(a, c.start)) : 0), 0)

  it('Smart speed 2x over an idle part, 80 pauses inside it sped up 4x and kept: Remove of the idle part after reopening puts all of it back', () => {
    const s = editor()
    const idle = [{ start: 100, end: 500 }]
    s.update((p) => recordAutoCuts(p, applySmartSpeed(p.clips, idle, 2), idle, 2, 'smart-speed'))
    const pauses = Array.from({ length: 80 }, (_, k) => ({ start: 101 + k * 5, end: 102.5 + k * 5 }))
    s.update((p) => recordAutoCuts(p, applySmartSpeed(p.clips, pauses, 4), pauses, 4, 'polish'))
    s.update((p) => keepItems(p, reviewItems(p).filter((i) => i.cut?.by === 'polish')))
    expect(s.state.autoCuts!.map((c) => [c.by, c.was.length])).toEqual([['smart-speed', 81]])
    const again = reopen(s.state)
    expect(again.autoCuts).toEqual(s.state.autoCuts)
    const out = removeItems(again, reviewItems(again))
    expect(covered(out.clips, 0, D, 2)).toBe(0)
    expect(covered(out.clips, 0, D, 4)).toBeCloseTo(80 * 1.5)
    expect(reviewItems(out)).toEqual([])
  })

  it('a retake cut inside an 8x that an edit by hand took away holds its footage at the speeds from before: all of it comes back after reopening', () => {
    const s = editor()
    const pauses = Array.from({ length: 120 }, (_, k) => ({ start: 51 + k * 4, end: 52.2 + k * 4 }))
    s.update((p) => recordAutoCuts(p, applySmartSpeed(p.clips, pauses, 4), pauses, 4, 'polish'))
    s.update((p) => keepItems(p, reviewItems(p)))
    const idle = [{ start: 100, end: 500 }]
    s.update((p) => recordAutoCuts(p, applySmartSpeed(p.clips, idle, 8), idle, 8, 'smart-speed'))
    s.update((p) => recordAutoCuts(p, cutRange(p.clips, 150, 450), [{ start: 150, end: 450 }], 'cut', 'retake'))
    // By hand, [100, 150] back to 1x: the 8x goes, and the retake holds [150, 450] as it was before it.
    s.update((p) => ({ ...p, clips: setRangeSpeed(p.clips, 100, 150, 1) }))
    const retake = s.state.autoCuts!.find((c) => c.by === 'retake')!
    expect(retake.was.length).toBeGreaterThan(MAX_WAS_PIECES)
    const again = reopen(s.state)
    expect(again.autoCuts).toEqual(s.state.autoCuts)
    const out = removeItems(again, reviewItems(again).filter((i) => i.cut?.by === 'retake'))
    expect(covered(out.clips, 150, 450)).toBeCloseTo(300)
    // The 8x's other records are still to review; with them removed, only the kept 4x pauses stay
    // sped up, but for those inside [100, 150], set to 1x by hand.
    const all = removeItems(out, reviewItems(out))
    expect(reviewItems(all)).toEqual([])
    expect(covered(all.clips, 0, D, 1) + covered(all.clips, 0, D, 4)).toBeCloseTo(D)
    const outsideHand = pauses.reduce((n, r) => n + (r.end - r.start) - Math.max(0, Math.min(150, r.end) - Math.max(100, r.start)), 0)
    expect(covered(all.clips, 0, D, 4)).toBeCloseTo(outsideHand)
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
    expect(changeGone(rec, back)).toBe(true)
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
    expect(changeGone(speed, back)).toBe(true)
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
      shown = mergeSnapshot(shown, p)
    }
    return p
  }

  /** Keeps (K) or removes (R) the listed items in `steps` order, one at a time, as the panel does. */
  const reviewSteps = (p: Project, steps: [number, 'K' | 'R'][]): { p: Project; shown: ReviewItem[] } => {
    let shown = reviewItems(p)
    for (const [k, how] of steps) {
      p = how === 'K' ? keepItems(p, [shown[k]]) : removeItems(p, [shown[k]])
      shown = mergeSnapshot(shown, p)
    }
    return { p, shown }
  }
  const rows = (p: Project, shown: ReviewItem[]): string[] => shown.map((i) => `${i.cut!.id}:${reviewStatus(p, i)}`)

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

  describe('a part of a 2x re-timed to 4x', () => {
    // Smart speed at 2x over [5,15], then Remove silences at 4x over [8,10] inside it.
    const nested = (): Project => auto(auto(project(), 5, 15, 2, 'smart-speed', 'f'), 8, 10, 4, 'silences', 'g')
    const statuses = (p: Project, shown: ReviewItem[]): string[] => shown.map((i) => `${i.cut!.id}:${reviewStatus(p, i)}`)

    it('both listed: the 2x keeps its pieces, the 4x holds its part at 2x, as a cut inside it would', () => {
      const p = nested()
      expect(plays(p.clips)).toEqual([
        [0, 5, 1],
        [5, 8, 2],
        [8, 10, 4],
        [10, 15, 2],
        [15, 20, 1]
      ])
      expect(liveAutoCuts(p).map((c) => [c.id, c.was])).toEqual([
        ['f1', [{ start: 5, end: 15, speed: 1 }]],
        ['g1', [{ start: 8, end: 10, speed: 2 }]]
      ])
      expect(pendingCount(p)).toBe(2)
    })

    it('removing only the 4x puts that part back at 2x, inside the 2x still listed', () => {
      let p = nested()
      let shown = reviewItems(p)
      p = removeItems(p, [shown[1]])
      shown = mergeSnapshot(shown, p)
      expect(plays(p.clips)).toEqual([
        [0, 5, 1],
        [5, 15, 2],
        [15, 20, 1]
      ])
      expect(statuses(p, shown)).toEqual(['f1:pending', 'g1:removed'])
      // Keeping the 2x then leaves it all at 2x.
      p = keepItems(p, [shown[0]])
      expect(plays(p.clips)).toEqual([
        [0, 5, 1],
        [5, 15, 2],
        [15, 20, 1]
      ])
      expect(statuses(p, shown)).toEqual(['f1:kept', 'g1:removed'])
    })

    it('removing them one by one in either order, or both at once, gives it all back at 1x, both rows removed', () => {
      const listOrder = removeOneByOne(nested())
      expect(plays(listOrder.clips)).toEqual([[0, 20, 1]])
      let p = nested()
      let shown = reviewItems(p)
      for (const k of [1, 0]) {
        p = removeItems(p, [shown[k]])
        shown = mergeSnapshot(shown, p)
      }
      expect(plays(p.clips)).toEqual([[0, 20, 1]])
      expect(statuses(p, shown)).toEqual(['f1:removed', 'g1:removed'])
      const both = removeItems(nested(), reviewItems(nested()))
      expect(plays(both.clips)).toEqual([[0, 20, 1]])
      expect(both.autoCuts).toBeUndefined()
    })

    it('removing the 2x first reads removed while the 4x is still to review', () => {
      let p = nested()
      let shown = reviewItems(p)
      p = removeItems(p, [shown[0]])
      shown = mergeSnapshot(shown, p)
      expect(plays(p.clips)).toEqual([
        [0, 8, 1],
        [8, 10, 4],
        [10, 20, 1]
      ])
      expect(statuses(p, shown)).toEqual(['f1:removed', 'g1:pending'])
      // Keeping the 4x then: it stays, and the 2x still reads removed.
      p = keepItems(p, [shown[1]])
      expect(plays(p.clips)).toEqual([
        [0, 8, 1],
        [8, 10, 4],
        [10, 20, 1]
      ])
      expect(statuses(p, shown)).toEqual(['f1:removed', 'g1:kept'])
    })

    it('keeping the 4x makes that part yours: the 2x stays listed for the rest, and Remove leaves the 4x', () => {
      let p = nested()
      let shown = reviewItems(p)
      p = keepItems(p, [shown[1]])
      shown = mergeSnapshot(shown, p)
      expect(statuses(p, shown)).toEqual(['f1:pending', 'g1:kept'])
      p = removeItems(p, [shown[0]])
      shown = mergeSnapshot(shown, p)
      expect(plays(p.clips)).toEqual([
        [0, 8, 1],
        [8, 10, 4],
        [10, 20, 1]
      ])
      expect(statuses(p, shown)).toEqual(['f1:removed', 'g1:kept'])
      expect(p.autoCuts).toBeUndefined()
    })

    it('an 8x over all of both takes both over: one record, and Remove brings it back at 1x', () => {
      const p = auto(nested(), 5, 15, 8, 'smart-speed', 'h')
      expect(p.autoCuts?.map((c) => [c.id, c.was])).toEqual([['h1', [{ start: 5, end: 15, speed: 1 }]]])
      expect(plays(removeItems(p, reviewItems(p)).clips)).toEqual([[0, 20, 1]])
    })
  })

  describe('a 2x, a 4x inside it and an 8x inside that', () => {
    // Smart speed at 2x over [5,15], Remove silences at 4x over [7,12], then again at 8x over [9,10].
    const nested = (): Project => auto(auto(auto(project(), 5, 15, 2, 'smart-speed', 'f'), 7, 12, 4, 'silences', 'g'), 9, 10, 8, 'silences', 'h')

    it('all three are listed, each holding its part at the speed from before it', () => {
      const p = nested()
      expect(plays(p.clips)).toEqual([
        [0, 5, 1],
        [5, 7, 2],
        [7, 9, 4],
        [9, 10, 8],
        [10, 12, 4],
        [12, 15, 2],
        [15, 20, 1]
      ])
      expect(liveAutoCuts(p).map((c) => [c.id, c.was])).toEqual([
        ['f1', [{ start: 5, end: 15, speed: 1 }]],
        ['g1', [{ start: 7, end: 12, speed: 2 }]],
        ['h1', [{ start: 9, end: 10, speed: 4 }]]
      ])
      expect(pendingCount(p)).toBe(3)
    })

    it('removing them all, at once or one by one in either order, gives it all back at 1x, every row removed', () => {
      expect(plays(removeItems(nested(), reviewItems(nested())).clips)).toEqual([[0, 20, 1]])
      for (const order of [
        [0, 1, 2],
        [2, 1, 0]
      ]) {
        const { p, shown } = reviewSteps(
          nested(),
          order.map((k) => [k, 'R'])
        )
        expect(plays(p.clips)).toEqual([[0, 20, 1]])
        expect(rows(p, shown)).toEqual(['f1:removed', 'g1:removed', 'h1:removed'])
      }
    })

    it('removing only the 8x puts that part back at 4x', () => {
      const { p, shown } = reviewSteps(nested(), [[2, 'R']])
      expect(plays(p.clips)).toEqual([
        [0, 5, 1],
        [5, 7, 2],
        [7, 12, 4],
        [12, 15, 2],
        [15, 20, 1]
      ])
      expect(rows(p, shown)).toEqual(['f1:pending', 'g1:pending', 'h1:removed'])
    })

    it('keeping the 8x makes that part yours in the 4x and in the 2x, which stay listed for the rest', () => {
      const kept = reviewSteps(nested(), [[2, 'K']])
      expect(liveAutoCuts(kept.p).map((c) => [c.id, c.was])).toEqual([
        [
          'f1',
          [
            { start: 5, end: 9, speed: 1 },
            { start: 10, end: 15, speed: 1 }
          ]
        ],
        [
          'g1',
          [
            { start: 7, end: 9, speed: 2 },
            { start: 10, end: 12, speed: 2 }
          ]
        ]
      ])
      expect(rows(kept.p, kept.shown)).toEqual(['f1:pending', 'g1:pending', 'h1:kept'])
      const { p, shown } = reviewSteps(nested(), [
        [2, 'K'],
        [0, 'R'],
        [1, 'R']
      ])
      expect(plays(p.clips)).toEqual([
        [0, 9, 1],
        [9, 10, 8],
        [10, 20, 1]
      ])
      expect(rows(p, shown)).toEqual(['f1:removed', 'g1:removed', 'h1:kept'])
    })

    it('removing the 2x and then keeping the 8x: the 2x still reads removed', () => {
      let { p, shown } = reviewSteps(nested(), [
        [0, 'R'],
        [2, 'K']
      ])
      expect(plays(p.clips)).toEqual([
        [0, 7, 1],
        [7, 9, 4],
        [9, 10, 8],
        [10, 12, 4],
        [12, 20, 1]
      ])
      expect(rows(p, shown)).toEqual(['f1:removed', 'g1:pending', 'h1:kept'])
      ;({ p, shown } = reviewSteps(nested(), [
        [0, 'R'],
        [2, 'K'],
        [1, 'K']
      ]))
      expect(rows(p, shown)).toEqual(['f1:removed', 'g1:kept', 'h1:kept'])
    })
  })

  it('a cut inside a 2x that a 4x then takes over comes back at 1x', () => {
    const p = auto(auto(auto(project(), 5, 9, 2, 'smart-speed', 'f'), 6, 7, 'cut', 'silences', 'c'), 5, 9, 4, 'smart-speed', 'g')
    expect(liveAutoCuts(p).map((c) => c.id)).toEqual(['c1', 'g1'])
    expect(plays(removeOneByOne(p).clips)).toEqual([[0, 20, 1]])
  })

  it('a cut inside a 4x inside a 2x: removing the cut, the 4x and then the 2x reads removed for all three', () => {
    const nested = (): Project => auto(auto(auto(project(), 5, 15, 2, 'smart-speed', 'f'), 7, 12, 4, 'silences', 'g'), 9, 10, 'cut', 'silences', 'c')
    expect(liveAutoCuts(nested()).map((c) => [c.id, c.was])).toEqual([
      ['f1', [{ start: 5, end: 15, speed: 1 }]],
      ['g1', [{ start: 7, end: 12, speed: 2 }]],
      ['c1', [{ start: 9, end: 10, speed: 4 }]]
    ])
    const removed = reviewSteps(nested(), [
      [2, 'R'],
      [1, 'R'],
      [0, 'R']
    ])
    expect(plays(removed.p.clips)).toEqual([[0, 20, 1]])
    expect(rows(removed.p, removed.shown)).toEqual(['f1:removed', 'g1:removed', 'c1:removed'])
    // With the 2x kept last, the cut is back at 2x and still reads removed.
    const { p, shown } = reviewSteps(nested(), [
      [2, 'R'],
      [1, 'R'],
      [0, 'K']
    ])
    expect(plays(p.clips)).toEqual([
      [0, 5, 1],
      [5, 15, 2],
      [15, 20, 1]
    ])
    expect(rows(p, shown)).toEqual(['f1:kept', 'g1:removed', 'c1:removed'])
  })

  it('a speed-up made again with the list open after one over the same footage was removed reads kept once kept', () => {
    // Polish at 2x, Delete in the list, Polish again (Shift+P) over the same silence, then K.
    let p = auto(project(), 5, 9, 2, 'polish', 'a')
    let shown = reviewItems(p)
    p = removeItems(p, [shown[0]])
    shown = mergeSnapshot(shown, p)
    p = auto(p, 5, 9, 2, 'polish', 'b')
    shown = mergeSnapshot(shown, p)
    expect(rows(p, shown)).toEqual(['a1:removed', 'b1:pending'])
    p = keepItems(p, [shown[1]])
    shown = mergeSnapshot(shown, p)
    expect(plays(p.clips)).toEqual([
      [0, 5, 1],
      [5, 9, 2],
      [9, 20, 1]
    ])
    expect(rows(p, shown)).toEqual(['a1:removed', 'b1:kept'])
    // The same inside a wider idle part removed first: Smart speed at 2x, Delete, then Polish at 2x and K.
    p = auto(project(), 3, 15, 2, 'smart-speed', 'f')
    shown = reviewItems(p)
    p = removeItems(p, [shown[0]])
    shown = mergeSnapshot(shown, p)
    p = auto(p, 5, 9, 2, 'polish', 'g')
    shown = mergeSnapshot(shown, p)
    p = keepItems(p, [shown[1]])
    shown = mergeSnapshot(shown, p)
    expect(plays(p.clips)).toEqual([
      [0, 5, 1],
      [5, 9, 2],
      [9, 20, 1]
    ])
    expect(rows(p, shown)).toEqual(['f1:removed', 'g1:kept'])
  })

  it('an 8x over a 4x kept earlier and a 2x: removing the 8x and then the 2x reads removed for both', () => {
    // Polish at 4x, Keep all; with the list open, Smart speed at 2x next to it and Polish at 8x over
    // part of both; Delete the 8x, then the 2x. The kept 4x is not one taken back.
    let p = auto(project(), 7.5, 13.5, 4, 'polish', 'k')
    let shown = reviewItems(p)
    p = keepItems(p, shown)
    shown = mergeSnapshot(shown, p)
    p = auto(p, 14.5, 18.5, 2, 'smart-speed', 'f')
    shown = mergeSnapshot(shown, p)
    p = auto(p, 10, 15.5, 8, 'polish', 'e')
    shown = mergeSnapshot(shown, p)
    for (const id of ['e1', 'f1']) {
      p = removeItems(p, [shown.find((i) => i.cut!.id === id)!])
      shown = mergeSnapshot(shown, p)
    }
    expect(plays(p.clips)).toEqual([
      [0, 7.5, 1],
      [7.5, 13.5, 4],
      [13.5, 20, 1]
    ])
    expect(rows(p, shown)).toEqual(['k1:kept', 'e1:removed', 'f1:removed'])
  })

  /** The panel open throughout: each change is merged into the list as it is made. */
  const panel = (start: Project) => {
    const ui = { p: start, shown: reviewItems(start) }
    const step = (p: Project): void => {
      ui.p = p
      ui.shown = mergeSnapshot(ui.shown, p)
    }
    const item = (id: string): ReviewItem => ui.shown.find((i) => i.cut!.id === id)!
    return { ui, step, item }
  }

  it('a 2x kept inside a 4x removed before still reads kept when a 4x run again speeds both up', () => {
    // Polish at 4x, Delete; Polish at 2x inside it (Shift+P), K; Polish at 4x again over both.
    const { ui, step, item } = panel(auto(project(), 12, 18, 4, 'polish', 'a'))
    step(removeItems(ui.p, [item('a1')]))
    step(auto(ui.p, 14, 16, 2, 'polish', 'b'))
    step(keepItems(ui.p, [item('b1')]))
    step(auto(ui.p, 10, 18, 4, 'polish', 'c'))
    expect(plays(ui.p.clips)).toEqual([
      [0, 10, 1],
      [10, 18, 4],
      [18, 20, 1]
    ])
    expect(rows(ui.p, ui.shown)).toEqual(['c1:pending', 'a1:removed', 'b1:kept'])
    // Removing the new 4x puts the 2x back at 2x.
    step(removeItems(ui.p, [item('c1')]))
    expect(plays(ui.p.clips)).toEqual([
      [0, 14, 1],
      [14, 16, 2],
      [16, 20, 1]
    ])
    expect(rows(ui.p, ui.shown)).toEqual(['c1:removed', 'a1:removed', 'b1:kept'])
  })

  it('a speed-up removed still reads removed after one made over it at its speed has a faster one kept inside', () => {
    // Polish at 2x, Delete; Smart speed at 2x over its end; Polish at 4x inside that, K.
    const one = panel(auto(project(), 5.5, 12.5, 2, 'polish', 'a'))
    one.step(removeItems(one.ui.p, [one.item('a1')]))
    one.step(auto(one.ui.p, 11, 16.5, 2, 'smart-speed', 'f'))
    one.step(auto(one.ui.p, 11, 11.5, 4, 'polish', 'g'))
    one.step(keepItems(one.ui.p, [one.item('g1')]))
    expect(plays(one.ui.p.clips)).toEqual([
      [0, 11, 1],
      [11, 11.5, 4],
      [11.5, 16.5, 2],
      [16.5, 20, 1]
    ])
    expect(rows(one.ui.p, one.ui.shown)).toEqual(['a1:removed', 'g1:kept', 'f1:pending'])
    // Polish at 4x, Delete; Polish at 4x over most of it; Polish at 8x over its end, K; then K the 4x.
    const two = panel(auto(project(), 9, 16, 4, 'polish', 'x'))
    two.step(removeItems(two.ui.p, [two.item('x1')]))
    two.step(auto(two.ui.p, 8.5, 15.5, 4, 'polish', 'y'))
    two.step(auto(two.ui.p, 14.5, 16, 8, 'polish', 'z'))
    two.step(keepItems(two.ui.p, [two.item('z1')]))
    expect(rows(two.ui.p, two.ui.shown)).toEqual(['y1:pending', 'x1:removed', 'z1:kept'])
    two.step(keepItems(two.ui.p, [two.item('y1')]))
    expect(plays(two.ui.p.clips)).toEqual([
      [0, 8.5, 1],
      [8.5, 14.5, 4],
      [14.5, 16, 8],
      [16, 20, 1]
    ])
    expect(rows(two.ui.p, two.ui.shown)).toEqual(['y1:kept', 'x1:removed', 'z1:kept'])
  })

  it('a speed-up kept inside one made before it still reads kept after a faster one run over it is kept', () => {
    // Smart speed at 2x, Polish at 4x inside it; Review, Keep all; Polish at 8x over the silence, K.
    const one = panel(auto(auto(project(), 3, 9, 2, 'smart-speed', 'f'), 4, 5.5, 4, 'polish', 'g'))
    one.step(keepItems(one.ui.p, one.ui.shown))
    one.step(auto(one.ui.p, 4, 5.5, 8, 'polish', 'h'))
    one.step(keepItems(one.ui.p, [one.item('h1')]))
    expect(plays(one.ui.p.clips)).toEqual([
      [0, 3, 1],
      [3, 4, 2],
      [4, 5.5, 8],
      [5.5, 9, 2],
      [9, 20, 1]
    ])
    expect(rows(one.ui.p, one.ui.shown)).toEqual(['f1:kept', 'g1:kept', 'h1:kept'])
    // With the list open: Polish at 2x, Polish at 4x over it (taking it over), Ctrl+Z; K the 2x;
    // Polish at 8x over it, K.
    const two = panel(project())
    two.step(auto(two.ui.p, 16.5, 18.5, 2, 'polish', 'a'))
    const before = two.ui.p
    two.step(auto(two.ui.p, 13, 19, 4, 'polish', 'b'))
    two.step(before)
    two.step(keepItems(two.ui.p, [two.item('a1')]))
    two.step(auto(two.ui.p, 16, 19.5, 8, 'polish', 'c'))
    two.step(keepItems(two.ui.p, [two.item('c1')]))
    expect(plays(two.ui.p.clips)).toEqual([
      [0, 16, 1],
      [16, 19.5, 8],
      [19.5, 20, 1]
    ])
    expect(rows(two.ui.p, two.ui.shown)).toEqual(['b1:removed', 'c1:kept', 'a1:kept'])
  })

  it('an 8x removed inside a 4x made over a 2x kept reads removed once that 4x is removed too', () => {
    // With the list open: Polish at 4x, Delete; Polish at 2x, K; Polish at 4x over both; Polish at
    // 8x inside that; Delete the 8x, then the new 4x. The 8x's footage goes out through the 4x it
    // was made in, not through the 4x removed first.
    const { ui, step, item } = panel(project())
    step(auto(ui.p, 7, 13.5, 4, 'polish', 'a'))
    step(removeItems(ui.p, [item('a1')]))
    step(auto(ui.p, 10.5, 16.5, 2, 'polish', 'b'))
    step(keepItems(ui.p, [item('b1')]))
    step(auto(ui.p, 7, 13, 4, 'polish', 'c'))
    step(auto(ui.p, 9.5, 11, 8, 'polish', 'd'))
    step(removeItems(ui.p, [item('d1')]))
    expect(rows(ui.p, ui.shown)).toEqual(['a1:removed', 'c1:pending', 'd1:removed', 'b1:kept'])
    step(removeItems(ui.p, [item('c1')]))
    expect(plays(ui.p.clips)).toEqual([
      [0, 10.5, 1],
      [10.5, 16.5, 2],
      [16.5, 20, 1]
    ])
    expect(rows(ui.p, ui.shown)).toEqual(['a1:removed', 'c1:removed', 'd1:removed', 'b1:kept'])
  })

  it('a speed-up an undo brings back after the panel reopened reads removed once removed', () => {
    // Smart speed at 2x, Polish at 4x inside it; Review, K the idle row; Esc, reopen; Ctrl+Z; Delete
    // the idle row, K the silence row. The idle row comes back after the silence row is listed, but
    // was made before it.
    const made = auto(auto(project(), 3, 15, 2, 'smart-speed', 'f'), 5.5, 10.5, 4, 'polish', 'g')
    const first = panel(made)
    first.step(keepItems(first.ui.p, [first.item('f1')]))
    const one = panel(first.ui.p)
    expect(one.ui.shown.map((i) => i.key)).toEqual(['cut:g1'])
    one.step(made)
    one.step(removeItems(one.ui.p, [one.item('f1')]))
    one.step(keepItems(one.ui.p, [one.item('g1')]))
    expect(plays(one.ui.p.clips)).toEqual([
      [0, 5.5, 1],
      [5.5, 10.5, 4],
      [10.5, 20, 1]
    ])
    expect(rows(one.ui.p, one.ui.shown)).toEqual(['f1:removed', 'g1:kept'])
    // The same with Polish run somewhere else after reopening and undone first (two Ctrl+Z).
    const two = panel(first.ui.p)
    two.step(auto(two.ui.p, 16, 18, 2, 'polish', 'h'))
    two.step(first.ui.p)
    two.step(made)
    two.step(removeItems(two.ui.p, [two.item('f1')]))
    two.step(keepItems(two.ui.p, [two.item('g1')]))
    expect(plays(two.ui.p.clips)).toEqual(plays(one.ui.p.clips))
    expect(rows(two.ui.p, two.ui.shown)).toEqual(['f1:removed', 'g1:kept', 'h1:removed'])
  })

  it('a speed-up removed still reads removed when the one made over it at its speed is kept with faster ones kept all over it', () => {
    // Polish at 4x, Delete; Polish at 4x over it; Polish at 8x over its end, K; K the 4x; Polish at
    // 8x over the rest of it, K. The later 4x plays none of its footage at 4x any more.
    const { ui, step, item } = panel(auto(project(), 9, 15.5, 4, 'polish', 'x'))
    step(removeItems(ui.p, [item('x1')]))
    step(auto(ui.p, 8.5, 15.5, 4, 'polish', 'y'))
    step(auto(ui.p, 14.5, 15.5, 8, 'polish', 'z'))
    step(keepItems(ui.p, [item('z1')]))
    step(keepItems(ui.p, [item('y1')]))
    step(auto(ui.p, 8.5, 14.5, 8, 'polish', 'w'))
    step(keepItems(ui.p, [item('w1')]))
    expect(plays(ui.p.clips)).toEqual([
      [0, 8.5, 1],
      [8.5, 15.5, 8],
      [15.5, 20, 1]
    ])
    expect(rows(ui.p, ui.shown)).toEqual(['w1:kept', 'y1:kept', 'x1:removed', 'z1:kept'])
  })

  it('a speed-up kept after a run over it was undone still reads kept when a run at that speed plays part of it', () => {
    // With the list open: Polish at 2x; Polish at 4x over it; Ctrl+Z; K the 2x; Polish at 8x over
    // its end, K; Polish at 4x over its start. The undone 4x still lists the 2x's footage at 1x, but
    // the new 4x holds it at 2x, so the undone one does not.
    const one = panel(project())
    one.step(auto(one.ui.p, 16.5, 18.5, 2, 'polish', 'a'))
    const before = one.ui.p
    one.step(auto(one.ui.p, 13, 19, 4, 'polish', 'b'))
    one.step(before)
    one.step(keepItems(one.ui.p, [one.item('a1')]))
    one.step(auto(one.ui.p, 17, 19.5, 8, 'polish', 'c'))
    one.step(keepItems(one.ui.p, [one.item('c1')]))
    one.step(auto(one.ui.p, 16, 17, 4, 'polish', 'd'))
    expect(plays(one.ui.p.clips)).toEqual([
      [0, 16, 1],
      [16, 17, 4],
      [17, 19.5, 8],
      [19.5, 20, 1]
    ])
    const read = (u: typeof one, id: string): string => `${id}:${reviewStatus(u.ui.p, u.item(id))}`
    expect(['a1', 'c1', 'd1'].map((id) => read(one, id))).toEqual(['a1:kept', 'c1:kept', 'd1:pending'])
    // The same where the one listed later at the undone run's speed is kept: Polish at 2x, Review,
    // Delete; Polish at 8x over its end; Ctrl+Z twice; K the 2x; Polish at 8x over all of it, K.
    const made = auto(project(), 12, 17, 2, 'polish', 'e')
    const two = panel(made)
    two.step(removeItems(two.ui.p, [two.item('e1')]))
    two.step(auto(two.ui.p, 16.5, 18.5, 8, 'polish', 'f'))
    two.step(made)
    two.step(keepItems(two.ui.p, [two.item('e1')]))
    two.step(auto(two.ui.p, 11.5, 17, 8, 'polish', 'g'))
    two.step(keepItems(two.ui.p, [two.item('g1')]))
    expect(plays(two.ui.p.clips)).toEqual([
      [0, 11.5, 1],
      [11.5, 17, 8],
      [17, 20, 1]
    ])
    expect(['e1', 'g1'].map((id) => read(two, id))).toEqual(['e1:kept', 'g1:kept'])
  })
})
