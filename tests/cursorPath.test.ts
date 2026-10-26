/**
 * Straightened cursor paths (docs/design/smarter-auto-zoom.md part 2): rests and moves, the
 * reasons that keep a move as recorded, which moves the option and the path ranges straighten,
 * and the replacement glide.
 */
import { describe, expect, it } from 'vitest'
import { buildCursorTrack, type RawTrack } from '../src/main/recording/trackMath'
import { cursorAt } from '../src/shared/engine/cursor'
import { cursorMoves, minJerk, moveAt, PATH, planCursorPath, straightenSamples, type CursorMove } from '../src/shared/engine/cursorPath'
import type { ClickEvent, CursorSample, CursorTrack, PathRange, ScrollEvent } from '../src/shared/types'

const ASPECT = 16 / 9
const NO_PATHS: PathRange[] = []

/**
 * The §5.6 path: a rest at A = (0.2, 0.5) (samples at 0, 0.5, 1.0), a move every 1/60 s for
 * 1.0 < t < 1.0 + span along `shape(u)`, a rest at B = (0.6, 0.5) (samples at t1, t1 + 0.4, t1 + 1.4).
 */
function fixture(
  opts: { span?: number; hz?: number; shape?: (u: number) => { x: number; y: number }; patch?: (s: CursorSample[]) => void } = {}
): CursorSample[] {
  const span = opts.span ?? 0.6
  const hz = opts.hz ?? 60
  const shape = opts.shape ?? ((u: number) => ({ x: 0.2 + 0.4 * u, y: 0.5 + 0.02 * Math.sin(3 * Math.PI * u) }))
  const t1 = 1 + span
  const samples: CursorSample[] = [
    { t: 0, x: 0.2, y: 0.5 },
    { t: 0.5, x: 0.2, y: 0.5 },
    { t: 1, x: 0.2, y: 0.5 }
  ]
  for (let k = 1; k < Math.round(span * hz); k++) {
    const t = 1 + k / hz
    samples.push({ t, ...shape((t - 1) / span) })
  }
  samples.push({ t: t1, x: 0.6, y: 0.5 }, { t: t1 + 0.4, x: 0.6, y: 0.5 }, { t: t1 + 1.4, x: 0.6, y: 0.5 })
  opts.patch?.(samples)
  return samples
}

const track = (samples: CursorSample[], clicks: ClickEvent[] = [], scrolls?: ScrollEvent[]): CursorTrack => ({
  samples,
  clicks,
  valid: true,
  ...(scrolls ? { scrolls } : {})
})
const click = (t: number, extra: Partial<ClickEvent> = {}): ClickEvent => ({ t, x: 0.2, y: 0.5, button: 'left', ...extra })
const only = (t: CursorTrack): CursorMove => {
  const moves = cursorMoves(t, ASPECT)
  expect(moves).toHaveLength(1)
  return moves[0]
}
const straight = (t: CursorTrack, straighten: boolean, paths: readonly PathRange[] = NO_PATHS) =>
  planCursorPath(t, { aspect: ASPECT, straighten, paths }).straightened.length

describe('minJerk', () => {
  it('goes from 0 to 1 symmetrically', () => {
    expect(minJerk(0)).toBe(0)
    expect(minJerk(1)).toBe(1)
    expect(minJerk(0.5)).toBeCloseTo(0.5, 12)
    expect(minJerk(0.1)).toBeCloseTo(0.00856, 12)
    expect(minJerk(0.25) + minJerk(0.75)).toBeCloseTo(1, 12)
  })

  it('has zero speed and acceleration at both ends', () => {
    const h = 1e-4
    const speed = (s: number): number => (minJerk(s + h) - minJerk(s - h)) / (2 * h)
    expect(Math.abs(minJerk(h) - minJerk(0)) / h).toBeLessThan(1e-6)
    expect(Math.abs(minJerk(1) - minJerk(1 - h)) / h).toBeLessThan(1e-6)
    // Analytic: speed 30 s^2 (1 - s)^2, acceleration 60 s (1 - s) (1 - 2 s); they match the profile.
    expect(speed(0.3)).toBeCloseTo(30 * 0.09 * 0.49, 6)
    const accel = (s: number): number => 60 * s * (1 - s) * (1 - 2 * s)
    expect(Math.abs(accel(0))).toBeLessThan(1e-6)
    expect(Math.abs(accel(1))).toBeLessThan(1e-6)
    expect((speed(0.3 + h) - speed(0.3 - h)) / (2 * h)).toBeCloseTo(accel(0.3), 4)
  })
})

describe('the worked example (§5.6)', () => {
  const samples = fixture()
  const t = track(samples)

  it('finds the two rests and the one move between them', () => {
    const m = only(t)
    expect([m.t0, m.t1]).toEqual([1, 1.6])
    expect([samples[m.i0], samples[m.i1]]).toEqual([samples[2], samples[samples.length - 3]])
    expect(m.from).toEqual({ x: 0.2, y: 0.5 })
    expect(m.to).toEqual({ x: 0.6, y: 0.5 })
    expect(m.wobble).toBeCloseTo(0.02 / (0.4 * ASPECT), 3)
    expect(m.auto).toBeNull()
    expect(m.manual).toBeNull()
    expect(moveAt(cursorMoves(t, ASPECT), 1.3)).toBe(m)
    expect(moveAt(cursorMoves(t, ASPECT), 0.9)).toBeNull()
    expect(moveAt(cursorMoves(t, ASPECT), 2)).toBeNull()
  })

  it('straightens it into a minimum-jerk glide along A-B', () => {
    const plan = planCursorPath(t, { aspect: ASPECT, straighten: true, paths: NO_PATHS })
    expect(plan.straightened).toEqual(plan.moves)
    const out = plan.samples
    const at = (time: number) => cursorAt(out, time)!
    expect(cursorAt(samples, 1.3)!.y).toBeCloseTo(0.48, 9)
    expect(at(1.3).x).toBeCloseTo(0.4, 9)
    expect(at(1.3).y).toBeCloseTo(0.5, 9)
    expect(Math.abs(at(1.06).x - 0.20342)).toBeLessThan(1e-4)
    expect(at(1.06).y).toBe(0.5)
    expect(at(1).x).toBe(0.2)
    expect(at(1.6).x).toBe(0.6)
    // Synthetic samples every 1/120 s strictly inside the move, exactly on the profile.
    const inner = out.filter((s) => s.t > 1 && s.t < 1.6)
    expect(inner).toHaveLength(71)
    inner.forEach((s, k) => {
      expect(s.t).toBeCloseTo(1 + (k + 1) / PATH.hz, 12)
      expect(s.x).toBeCloseTo(0.2 + 0.4 * minJerk((s.t - 1) / 0.6), 12)
      expect(s.y).toBe(0.5)
    })
  })

  it('keeps every sample outside the move, and the samples at t0 and t1, as the same objects', () => {
    const out = planCursorPath(t, { aspect: ASPECT, straighten: true, paths: NO_PATHS }).samples
    const outside = samples.filter((s) => s.t <= 1 || s.t >= 1.6)
    expect(out.filter((s) => s.t <= 1 || s.t >= 1.6)).toEqual(outside)
    outside.forEach((s, i) => expect(out.filter((o) => o.t <= 1 || o.t >= 1.6)[i]).toBe(s))
    // The recorded samples are untouched.
    expect(samples).toEqual(fixture())
  })

  it('returns the recorded samples themselves when nothing is straightened', () => {
    expect(planCursorPath(t, { aspect: ASPECT, straighten: false, paths: NO_PATHS }).samples).toBe(samples)
    expect(straightenSamples(samples, [])).toBe(samples)
    expect(planCursorPath({ ...t, valid: false }, { aspect: ASPECT, straighten: true, paths: NO_PATHS }).samples).toBe(samples)
    expect(cursorMoves({ ...t, valid: false }, ASPECT)).toEqual([])
  })

  it('is cached per input arrays', () => {
    expect(cursorMoves(t, ASPECT)).toBe(cursorMoves(t, ASPECT))
    expect(cursorMoves({ ...t }, ASPECT)).toBe(cursorMoves(t, ASPECT))
    const ctx = { aspect: ASPECT, straighten: true, paths: NO_PATHS }
    expect(planCursorPath(t, ctx)).toBe(planCursorPath(t, { ...ctx }))
    expect(planCursorPath(t, ctx).samples).not.toBe(planCursorPath(t, { ...ctx, straighten: false }).samples)
  })
})

describe('the variants (§5.6)', () => {
  it('a press held into the move is a drag: never straightened', () => {
    const t = track(fixture(), [click(0.95, { up: 1.45 })])
    expect(only(t).auto).toBe('drag')
    expect(only(t).manual).toBe('drag')
    expect(straight(t, true, [{ start: 0, end: 3, mode: 'straight' }])).toBe(0)
  })

  it('a release that cannot be trusted is no drag', () => {
    expect(only(track(fixture(), [click(0.95, { up: 0.9 })])).auto).toBe('drag-guess')
    expect(only(track(fixture(), [click(0.95, { up: Number.NaN })])).auto).toBe('drag-guess')
    // A short press ending before the move is neither.
    expect(only(track(fixture(), [click(0.5, { up: 0.6 })])).auto).toBeNull()
  })

  it('a click just before the move without a release is a guessed drag: kept by the option, straightened by a range', () => {
    const t = track(fixture(), [click(0.9)])
    expect(only(t).auto).toBe('drag-guess')
    expect(only(t).manual).toBeNull()
    expect(straight(t, true)).toBe(0)
    expect(straight(t, false, [{ start: 0.8, end: 1.8, mode: 'straight' }])).toBe(1)
    // 0.25 s before t0 still counts; earlier does not.
    expect(only(track(fixture(), [click(0.75)])).auto).toBe('drag-guess')
    expect(only(track(fixture(), [click(0.74)])).auto).toBeNull()
  })

  it('a click inside the move blocks it, an ignored-or-not click of any button', () => {
    expect(only(track(fixture(), [click(1.3)])).auto).toBe('click')
    expect(only(track(fixture(), [click(1.3, { button: 'right' })])).manual).toBe('click')
  })

  it('a scroll inside the move blocks it', () => {
    expect(only(track(fixture(), [], [{ t: 1.3, x: 0.4, y: 0.5, dx: 0, dy: 1 }])).auto).toBe('scroll')
    expect(only(track(fixture(), [], [{ t: 2, x: 0.6, y: 0.5, dx: 0, dy: 1 }])).auto).toBeNull()
  })

  it('a sample off the frame keeps the move as recorded, whatever the range says', () => {
    const t = track(fixture({ patch: (s) => (s[20] = { ...s[20], y: 1.05 }) }))
    expect(only(t).auto).toBe('off-frame')
    expect(only(t).manual).toBe('off-frame')
    expect(straight(t, true, [{ start: 0, end: 3, mode: 'straight' }])).toBe(0)
  })

  it('a detour is wobbly', () => {
    const detour = (u: number) => (u < 0.5 ? { x: 0.2 + 0.8 * u, y: 0.5 - 0.6 * u } : { x: 0.6, y: 0.2 + 0.6 * (u - 0.5) })
    const m = only(track(fixture({ shape: detour })))
    expect(m.wobble).toBeGreaterThan(PATH.wobbleMax)
    expect(m.auto).toBe('wobbly')
    expect(m.manual).toBeNull()
  })

  it('a 3 s move is long for the option; a range can force it', () => {
    const t = track(fixture({ span: 3 }))
    expect(only(t).auto).toBe('long')
    expect(straight(t, true)).toBe(0)
    expect(straight(t, true, [{ start: 0, end: 5, mode: 'straight' }])).toBe(1)
    expect(only(track(fixture({ span: 10.5 }))).manual).toBe('long')
  })

  it('short and small moves are left alone by the option', () => {
    expect(only(track(fixture({ span: 0.08, hz: 120 }))).auto).toBe('short')
    const tiny = (u: number) => ({ x: 0.2 + 0.4 * u, y: 0.5 })
    const small = fixture({ shape: tiny, patch: (s) => s.forEach((p) => p.x > 0.2 && (p.x = 0.2 + (p.x - 0.2) * 0.04)) })
    const m = only(track(small))
    expect(m.auto).toBe('small')
    expect(m.manual).toBeNull()
  })

  it('an overshoot and return is straightened; a 0.05 loop is a gesture', () => {
    const overshoot = (u: number) => ({ x: u < 0.85 ? 0.2 + (0.45 * u) / 0.85 : 0.65 - (0.05 * (u - 0.85)) / 0.15, y: 0.5 })
    expect(only(track(fixture({ shape: overshoot }))).auto).toBeNull()
    const r = 0.05
    const loop = (u: number) => {
      if (u < 1 / 3) return { x: 0.2 + 0.6 * u, y: 0.5 }
      if (u > 2 / 3) return { x: 0.4 + 0.6 * (u - 2 / 3), y: 0.5 }
      const th = (u - 1 / 3) * 3 * 2 * Math.PI
      return { x: (0.4 * ASPECT + r * Math.sin(th)) / ASPECT, y: 0.5 - r + r * Math.cos(th) }
    }
    const m = only(track(fixture({ shape: loop, hz: 120 })))
    expect(m.wobble).toBeLessThanOrEqual(PATH.wobbleMax)
    expect(m.auto).toBe('gesture')
    expect(m.manual).toBeNull()
  })
})

describe('which moves are straightened', () => {
  const t = track(fixture())

  it('the option alone', () => {
    expect(straight(t, false)).toBe(0)
    expect(straight(t, true)).toBe(1)
  })

  it("a 'recorded' range keeps the path, a 'straight' range straightens it, whatever the option", () => {
    expect(straight(t, true, [{ start: 1.2, end: 1.4, mode: 'recorded' }])).toBe(0)
    expect(straight(t, false, [{ start: 1.2, end: 1.4, mode: 'straight' }])).toBe(1)
  })

  it('the range containing the midpoint decides (start <= mid < end)', () => {
    // The midpoint is 1.3: a range ending there does not contain it, one starting there does.
    expect(straight(t, true, [{ start: 0, end: 1.3, mode: 'recorded' }])).toBe(1)
    expect(straight(t, true, [{ start: 1.3, end: 2, mode: 'recorded' }])).toBe(0)
    expect(straight(t, false, [{ start: 0.5, end: 1.25, mode: 'straight' }])).toBe(0)
  })
})

describe('tracker-style sparse samples', () => {
  it('still periods stored sparsely (two polls, or one plus the hold sample before the next move) are rests', () => {
    const T0 = 1_000_000
    const raw: RawTrack = {
      samples: [
        // Still at A: only its first poll; the tracker reports the next movement 1016 ms in.
        { at: T0, x: 384, y: 540 },
        ...Array.from({ length: 35 }, (_, k) => ({
          at: T0 + 1000 + Math.round(((k + 1) * 1000) / 60),
          x: 384 + ((k + 1) * 768) / 36,
          y: 540 + 20 * Math.sin(((k + 1) * Math.PI) / 36)
        })),
        // Still at B: its first and last poll.
        { at: T0 + 1600, x: 1152, y: 540 },
        { at: T0 + 3000, x: 1152, y: 540 }
      ],
      clicks: [],
      keys: [],
      bounds: { x: 0, y: 0, width: 1920, height: 1080 },
      scale: 1
    }
    const built = buildCursorTrack(raw, { startedAt: T0, pauses: [], duration: 3, region: null })
    const hold = 1.017 - 1 / 120
    expect(built.samples.slice(0, 2).map((s) => [s.t, s.x, s.y])).toEqual([
      [0, 0.2, 0.5],
      [hold, 0.2, 0.5]
    ])
    const m = only(built)
    expect(m.t0).toBeCloseTo(hold, 9)
    expect(m.t1).toBeCloseTo(1.6, 9)
    expect(m.auto).toBeNull()
    const plan = planCursorPath(built, { aspect: ASPECT, straighten: true, paths: NO_PATHS })
    expect(cursorAt(plan.samples, 1.3)!.y).toBeCloseTo(0.5, 9)
    expect(cursorAt(built.samples, 1.3)!.y).toBeGreaterThan(0.51)
  })
})
