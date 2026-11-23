import { describe, expect, it } from 'vitest'
import { changedIn, keyBefore, lookScale, lookStep, regionsAt } from '../src/shared/privacy/look'
import { BUCKETS, firstEstimate, hintsOf, packAreas, planReads, readBudget, secondEstimate, spansOf, type ReadHints } from '../src/shared/privacy/plan'
import type { Box } from '../src/shared/privacy/protocol'
import type { CursorTrack } from '../src/shared/types'
import { HD, inside, lookOf, move } from './autoBlurScanFixtures'

/*
 * The look data and the read plan (docs/design/auto-blur.md §5.2-5.4, §5.11; §17.1 tests 136-140 and
 * 236).
 */

const NO_HINTS: ReadHints = hintsOf(null)
const cursor = (over: Partial<CursorTrack>): CursorTrack => ({ samples: [], clicks: [], valid: true, ...over })
const covers = (areas: readonly Box[], box: Box): boolean => areas.some((a) => inside(box, a))

describe('auto-blur P4: look and plan', () => {
  it('136. lookScale and lookStep: 1080p looks at 480×270 (k 4), 4K at 480×270 (k 8), 7680×2160 at 640×180 (k 12); every frame at 30 fps, every second at 60 (and every fourth at 120)', () => {
    expect(lookScale(1920, 1080)).toBe(4)
    expect(lookScale(3840, 2160)).toBe(8)
    expect(lookScale(7680, 2160)).toBe(12)
    expect([1920 / 4, 1080 / 4, 3840 / 8, 2160 / 8, 7680 / 12, 2160 / 12]).toEqual([480, 270, 480, 270, 640, 180])
    // Small recordings never look at more than a quarter of their size a side.
    expect(lookScale(1280, 720)).toBe(4)
    for (const [w, h] of [
      [1920, 1080],
      [3840, 2160],
      [7680, 2160]
    ]) {
      expect(lookStep(30), `${w}×${h} at 30`).toBe(1)
      expect(lookStep(60), `${w}×${h} at 60`).toBe(2)
    }
    expect(lookStep(120)).toBe(4)
    expect(lookStep(29.97)).toBe(1)
    expect(lookStep(59.94)).toBe(2)
  })

  it('137. changedIn and keyBefore on synthetic look data: the frames whose tiles under a box changed, in a time range; the key frame at or before a time', () => {
    const field: Box = [400, 300, 300, 40]
    const elsewhere: Box = [1500, 900, 200, 100]
    const look = lookOf(HD, 30, 4, (i) => ({ changed: i === 10 || i === 50 ? [field] : i === 20 ? [elsewhere] : i === 70 ? [[420, 310, 20, 20]] : [], key: i % 30 === 0 }))
    expect(changedIn(look, field, 0, 4)).toEqual([10, 50, 70])
    expect(changedIn(look, field, 0.5, 2)).toEqual([50])
    expect(changedIn(look, elsewhere, 0, 4)).toEqual([20])
    expect(changedIn(look, [0, 0, 100, 100], 0, 4)).toEqual([])
    expect(look.keys).toEqual([0, 1, 2, 3])
    expect(keyBefore(look, 2.5)).toBe(2)
    expect(keyBefore(look, 2)).toBe(2)
    expect(keyBefore(look, 1.999)).toBe(1)
    expect(keyBefore({ keys: [] }, 5)).toBe(0)
    // Regions: changed tiles joined, as boxes in video pixels on the tile grid (32 px at 1080p).
    expect(regionsAt(look, 10)).toEqual([[384, 288, 320, 64]])
  })

  it('138. planReads: the first frame; settle reads 0.3 s after bursts; reveals every 0.75 s in a long scroll; typing reads after bursts and pastes with valid and invalid cursor data; periodic reads; at display scale 1.5 and 2 the typing box and the settle padding grow by that scale', () => {
    // The first frame: the first analysed frame after the opening's page change (a black frame, then the screen).
    const opening = lookOf(HD, 30, 10, (i) => ({ changed: i === 6 ? [[0, 0, 1920, 1080]] : [] }))
    const first = planReads(opening, NO_HINTS, HD, 30, 1e9).reads.find((r) => r.why === 'first')!
    expect(first.t).toBeCloseTo(0.2, 6)
    expect(first.areas).toEqual([[0, 0, 1920, 1080]])

    // A burst of changes in a field from 2.0 s to 2.5 s: one settle read at least 0.3 s after its last change, over the field padded by 64 px.
    const field: Box = [600, 400, 320, 64]
    const burst = lookOf(HD, 30, 6, (_i, t) => ({ changed: t >= 2 && t <= 2.5 ? [field] : [] }))
    const settle = planReads(burst, NO_HINTS, HD, 30, 1e9).reads.filter((r) => r.why === 'settle')
    expect(settle).toHaveLength(1)
    expect(settle[0].t).toBeGreaterThanOrEqual(2.8 - 1e-9)
    expect(settle[0].t).toBeLessThan(2.9)
    expect(covers(settle[0].areas, [576 - 64 + 64, 384, 384, 96])).toBe(true)
    expect(covers(settle[0].areas, [field[0] - 64, field[1] - 64, field[2] + 128, field[3] + 128])).toBe(true)

    // A scroll of a list for 4 s: reveals every 0.75 s once it has lasted 1 s, each the strip that came in at the bottom.
    const list: Box = [200, 100, 800, 800]
    const scroll = lookOf(HD, 30, 6, (_i, t) => (t >= 1 && t < 5 ? { changed: [list], moves: [move(list, 0, -10)] } : {}))
    const reveals = planReads(scroll, NO_HINTS, HD, 30, 1e9).reads.filter((r) => r.why === 'reveal')
    expect(reveals.length).toBeGreaterThanOrEqual(3)
    expect(reveals[0].t).toBeGreaterThan(2)
    for (let i = 1; i < reveals.length; i++) expect(reveals[i].t - reveals[i - 1].t).toBeCloseTo(0.7667, 2)
    for (const r of reveals) {
      expect(r.areas).toHaveLength(1)
      expect(r.areas[0][1] + r.areas[0][3]).toBe(900)
      expect(r.areas[0][3]).toBeLessThan(400)
    }

    // Typing: a read 0.3 s after the burst ends and after the paste, around the click before them (640×200) when positions hold.
    const typed: Box = [900, 500, 200, 32]
    const hints = (valid: boolean, scale?: number): ReadHints => hintsOf(cursor({ valid, scale, clicks: [{ t: 2.5, x: 0.5, y: 0.5, button: 'left' }], typing: [{ t: 3, end: 4 }], keys: [{ t: 6, label: 'Ctrl + V' }] }))
    const quiet = lookOf(HD, 30, 8)
    const byClick = planReads(quiet, hints(true), HD, 30, 1e9).reads.filter((r) => r.why === 'typing')
    expect(byClick.map((r) => r.t)).toEqual([expect.closeTo(4.3, 1), expect.closeTo(6.3, 1)])
    expect(byClick[0].areas).toEqual([[640, 440, 640, 200]])
    // Without positions: the regions that changed since the burst started (padded), and nothing for a paste that changed nothing.
    const typing = lookOf(HD, 30, 8, (_i, t) => ({ changed: t >= 3 && t <= 4 ? [typed] : [] }))
    const byChanges = planReads(typing, hints(false), HD, 30, 1e9).reads.filter((r) => r.why === 'typing')
    expect(byChanges.map((r) => r.t)).toEqual([expect.closeTo(4.3, 1)])
    expect(byChanges[0].areas).toHaveLength(1)
    expect(covers(byChanges[0].areas, typed)).toBe(true)
    expect(byChanges[0].areas[0][2]).toBeLessThan(640)
    // With positions, the typing read and the burst's settle read are one read over both areas.
    const both = planReads(typing, hints(true), HD, 30, 1e9).reads.filter((r) => r.t > 4 && r.t < 5)
    expect(both).toHaveLength(1)
    expect(covers(both[0].areas, [640, 440, 640, 200]) && covers(both[0].areas, typed)).toBe(true)

    // Display scale 1.5 and 2: the typing box and the settle padding grow by it (finding 6).
    for (const scale of [1.5, 2]) {
      const box = planReads(quiet, hints(true, scale), HD, 30, 1e9).reads.find((r) => r.why === 'typing')!.areas[0]
      expect(box[2]).toBe(640 * scale)
      expect(box[3]).toBe(200 * scale)
      const s = planReads(typing, hintsOf(cursor({ valid: true, scale })), HD, 30, 1e9).reads.find((r) => r.why === 'settle')!.areas[0]
      expect(s[0]).toBe(896 - 64 * scale)
      expect(s[2]).toBe(224 + 2 * 64 * scale)
    }

    // Periodic: a still 3-minute recording gets a whole frame in each minute no read covered half of.
    const still = lookOf(HD, 30, 180)
    const periodic = planReads(still, NO_HINTS, HD, 30, 1e9).reads.filter((r) => r.why === 'periodic')
    expect(periodic.map((r) => Math.round(r.t))).toEqual([90, 150])
    for (const r of periodic) expect(r.areas).toEqual([[0, 0, 1920, 1080]])
  })

  it('139. The budget: settle and typing areas less than 1 s apart are always merged; over budget, reveals, then periodic reads, then 3 s and 5 s merging thin in that order; thinning stops once it fits, no read is dropped (a plan over twice its budget after every step runs whole), and thinSpans holds every thinned span', () => {
    const a: Box = [100, 100, 300, 40]
    const b: Box = [120, 110, 300, 40]
    // Two bursts in one field 0.6 s apart: one read, at the later one's frame, over both.
    const close = lookOf(HD, 30, 5, (_i, t) => ({ changed: (t >= 1 && t <= 1.1) || (t >= 1.7 && t <= 1.8) ? [t < 1.5 ? a : b] : [] }))
    const merged = planReads(close, NO_HINTS, HD, 30, 1e9).reads.filter((r) => r.why === 'settle')
    expect(merged).toHaveLength(1)
    expect(merged[0].t).toBeGreaterThan(2)
    expect(covers(merged[0].areas, a) && covers(merged[0].areas, b)).toBe(true)

    // A busy recording: a long scroll (reveals), long still stretches (periodic reads), and bursts in one field 2 s and 4 s apart.
    const list: Box = [1100, 100, 700, 800]
    const field: Box = [100, 600, 400, 40]
    const bursts = [10, 12, 14, 18, 22]
    const busy = lookOf(HD, 30, 400, (_i, t) => {
      if (t >= 30 && t < 60) return { changed: [list], moves: [move(list, 0, -8)] }
      if (bursts.some((s) => t >= s && t <= s + 0.2)) return { changed: [field] }
      return {}
    })
    const plan = (budget: number) => planReads(busy, NO_HINTS, HD, 30, budget)
    const usual = plan(1e9)
    const count = (p: ReturnType<typeof plan>, why: string) => p.reads.filter((r) => r.why === why).length
    expect(usual.thinned).toBe(0)
    expect(usual.thinSpans).toBe('')
    expect(count(usual, 'settle')).toBeGreaterThanOrEqual(bursts.length)
    // Just under the usual units: only the reveals thin (every 1.5 s).
    const step1 = plan(usual.units - 0.01)
    expect(count(step1, 'reveal')).toBeLessThan(count(usual, 'reveal'))
    expect(count(step1, 'periodic')).toBe(count(usual, 'periodic'))
    expect(count(step1, 'settle')).toBe(count(usual, 'settle'))
    expect(step1.units).toBeLessThanOrEqual(usual.units - 0.01)
    expect(step1.thinSpans).not.toBe('')
    expect(step1.reads.filter((r) => r.thin).every((r) => r.why === 'reveal')).toBe(true)
    // Lower: periodic reads every 120 s too, the settle reads still apart.
    const step2 = plan(step1.units - 0.01)
    expect(count(step2, 'periodic')).toBeLessThan(count(usual, 'periodic'))
    expect(count(step2, 'settle')).toBe(count(usual, 'settle'))
    // Lower: settle areas less than 3 s apart merge, then less than 5 s.
    const step3 = plan(step2.units - 0.01)
    expect(count(step3, 'settle')).toBeLessThan(count(usual, 'settle'))
    const step4 = plan(step3.units - 0.01)
    expect(count(step4, 'settle')).toBeLessThan(count(step3, 'settle'))
    // Thinning stops once the plan fits.
    expect(plan(step2.units).units).toBe(step2.units)
    // A budget a tenth of what is left after every step: still over twice the budget, and every read's areas are kept (merged, never dropped).
    const last = plan(step4.units / 10)
    expect(last.units).toBe(step4.units)
    expect(last.units).toBeGreaterThan(2 * (step4.units / 10))
    for (const r of usual.reads.filter((x) => x.why === 'settle')) for (const area of r.areas) expect(last.reads.some((x) => x.t >= r.t && covers(x.areas, area)), `settle at ${r.t}`).toBe(true)
    expect(last.thinned).toBeGreaterThan(0)
    // Every thinned span is recorded: the merged bursts, the thinned reveals and the periodic windows.
    const spans = spansOf(last.thinSpans)
    const within = (t: number) => spans.some(([s, e]) => t >= s - 1e-6 && t <= e + 1e-6)
    expect(within(11) && within(16) && within(20)).toBe(true)
    expect(within(45)).toBe(true)
    expect(last.reads.filter((r) => r.why === 'periodic').every((r) => within(r.t) && r.thin)).toBe(true)
  })

  it('140. Estimates: firstEstimate from length, size and rate; secondEstimate from the plan and the measured speeds', () => {
    // 20 minutes at 1080p60: 72,000 frames × 1.85 ms / 1.8 + 150 units × 2.9 s + 0.05 × 1,200 s.
    expect(readBudget(1200, HD)).toBe(150)
    expect(firstEstimate(1200, 60, HD, null)).toBeCloseTo((72000 * 1.85) / 1000 / 1.8 + 150 * 2.9 + 60, 6)
    expect(firstEstimate(1200, 60, HD, null) / 60).toBeGreaterThan(9)
    expect(firstEstimate(1200, 60, HD, null) / 60).toBeLessThan(11)
    // This PC's own decode speed replaces the 1.85 ms; 30 fps decodes half the frames; 4K reads twice the units and decodes four times the pixels.
    expect(firstEstimate(1200, 60, HD, 1)).toBeCloseTo((72000 * 1) / 1000 / 1.8 + 435 + 60, 6)
    expect(firstEstimate(1200, 30, HD, null)).toBeLessThan(firstEstimate(1200, 60, HD, null))
    const k4 = { width: 3840, height: 2160 }
    expect(readBudget(1200, k4)).toBe(300)
    expect(firstEstimate(1200, 60, k4, null)).toBeCloseTo((72000 * 1.85 * 4) / 1000 / 1.8 + 300 * 2.9 + 60, 6)
    expect(firstEstimate(0, 60, HD, null)).toBe(0)

    const look = lookOf(HD, 60, 120, (_i, t) => ({ changed: t >= 10 && t <= 11 ? [[0, 0, 400, 100]] : [] }))
    const plan = planReads(look, NO_HINTS, HD, 60, 1e9)
    const assumed = secondEstimate(plan, look, { readSeconds: null })
    const measured = secondEstimate(plan, look, { readSeconds: 2 })
    expect(assumed - measured).toBeCloseTo(plan.units * 0.9, 6)
    expect(assumed).toBeGreaterThan(plan.units * 2.9)
    const longer = planReads(look, NO_HINTS, HD, 60, 1e9)
    longer.units *= 2
    expect(secondEstimate(longer, look, { readSeconds: 2 })).toBeGreaterThan(measured)
  })

  it('236. Buckets and packing: packAreas puts three 300×80 areas in one 640×352 bucket at 0.1 unit and a 1200×500 area in the 1920×1088 bucket at 1 unit; the plan units are the sum', () => {
    expect(BUCKETS.map((b) => [b.w, b.h, b.units])).toEqual([
      [640, 352, 0.1],
      [960, 544, 0.2],
      [1920, 1088, 1]
    ])
    const small: Box[] = [
      [10, 10, 300, 80],
      [900, 500, 300, 80],
      [1500, 900, 300, 80]
    ]
    const packed = packAreas(small)
    expect(packed).toHaveLength(1)
    expect(packed[0].bucket).toBe(0)
    expect(packed[0].areas).toHaveLength(3)
    const big = packAreas([[100, 100, 1200, 500]])
    expect(big).toEqual([{ bucket: 2, areas: [[100, 100, 1200, 500]] }])
    // Larger than the largest bucket: cut into 1920×1088 tiles.
    expect(packAreas([[0, 0, 3840, 2160]]).map((b) => b.bucket)).toEqual([2, 2, 2, 2, 2, 2])
    // The plan: every read's units are its buckets' units, and the plan's units their sum.
    const look = lookOf(HD, 30, 20, (_i, t) => ({ changed: t >= 5 && t <= 5.5 ? small : t >= 10 && t <= 10.5 ? [[100, 100, 1072, 372]] : [] }))
    const plan = planReads(look, NO_HINTS, HD, 30, 1e9)
    for (const r of plan.reads) expect(r.units).toBeCloseTo(r.packed.reduce((s, b) => s + BUCKETS[b.bucket].units, 0), 6)
    expect(plan.units).toBeCloseTo(plan.reads.reduce((s, r) => s + r.units, 0), 6)
    const settle = plan.reads.filter((r) => r.why === 'settle')
    // Each small area is its own burst, read alone in the smallest bucket; the large one is padded to 1200×500, one unit.
    expect(settle.map((r) => r.units)).toEqual([0.1, 0.1, 0.1, 1])
  })
})
