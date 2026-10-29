import { describe, expect, it } from 'vitest'
import { cropView } from '../src/shared/engine/crop'
import { sceneLayout } from '../src/shared/engine/layout'
import { createProject } from '../src/shared/engine/project'
import {
  FOLLOW,
  followAttention,
  followCentre,
  followPlanFor,
  glide,
  glideInverse,
  PACE,
  panDuration,
  planFollow,
  type FollowPlan,
  type FollowSegment,
  type PaceParams
} from '../src/shared/engine/reframe'
import { DEFAULT_REFRAME } from '../src/shared/engine/reframeData'
import { clampCamera } from '../src/shared/engine/zoom'
import type { ClickEvent, CursorSample, CursorTrack, LayoutSegment, Project, ReframePace, ReframeSettings, Shape } from '../src/shared/types'
import { rng } from './verticalFixtures'

/*
 * The follow planner (docs/design/vertical-video.md §5.4-5.11, §5.15-5.18; tests 20-40): the
 * glide, pan durations, shots, confirmation, short visits, deadlines, cuts, joined glides,
 * determinism and robustness. Fixtures are literals: a 1920x1080 recording in a padding-free 9:16
 * frame without camera, where the view is base.w = 0.31640625 of the recording wide.
 */

const BASE_W = 0.31640625
const DT = 1 / 60

function project(over: Partial<Project> = {}, reframe: Partial<ReframeSettings> = {}, duration = 12): Project {
  const p = createProject({
    id: 'p',
    name: 'p',
    duration,
    width: 1920,
    height: 1080,
    hasWebcam: false,
    hasAudio: false,
    webcamOffset: 0,
    zooms: [],
    cursorValid: true,
    capture: { method: 'native', cursorInVideo: false, region: null }
  })
  return {
    ...p,
    clips: [{ id: 'c1', start: 0, end: duration, speed: 1 }],
    style: { ...p.style, aspectRatio: '9:16', padding: 0 },
    reframe: { ...DEFAULT_REFRAME, ...reframe },
    ...over
  }
}

type Path = (t: number) => [number, number]
/** Samples every 1/60 s from 0 to `end` along `path`. */
function samples(end: number, path: Path): CursorSample[] {
  const out: CursorSample[] = []
  for (let i = 0; i * DT <= end + 1e-9; i++) {
    const [x, y] = path(i * DT)
    out.push({ t: i * DT, x, y })
  }
  return out
}
/** Rests at `a`, moves in a straight line to `b` between t0 and t1, rests at `b`. */
const flight =
  (a: [number, number], b: [number, number], t0: number, t1: number): Path =>
  (t) => {
    const k = t <= t0 ? 0 : t >= t1 ? 1 : (t - t0) / (t1 - t0)
    return [a[0] + (b[0] - a[0]) * k, a[1] + (b[1] - a[1]) * k]
  }
/** Rests at `a`, visits `b` (a 0.1 s move each way) from t0 for `stay` seconds of the view's target. */
const visit = (a: [number, number], b: [number, number], t0: number, stay: number): Path => {
  const out = flight(a, b, t0, t0 + 0.1)
  const back = flight(b, a, t0 + stay, t0 + stay + 0.1)
  return (t) => (t < t0 + stay ? out(t) : back(t))
}
const track = (s: CursorSample[], clicks: ClickEvent[] = [], extra: Partial<CursorTrack> = {}): CursorTrack => ({ samples: s, clicks, valid: true, ...extra })
const click = (t: number, x: number, y = 0.5): ClickEvent => ({ t, x, y, button: 'left' })

const moves = (plan: FollowPlan): FollowSegment[] => plan.segments.filter((s) => s.kind !== 'hold')
/** The view's centre in views of the 9:16 frame. */
const views = (x: number): number => x / BASE_W
/** Peak speed (views/s) of a pan or glide, measured. */
function peakSpeed(seg: FollowSegment): number {
  let peak = 0
  const n = 400
  for (let i = 0; i < n; i++) {
    const a = glide(i / n, seg.ramp)
    const b = glide((i + 1) / n, seg.ramp)
    peak = Math.max(peak, (Math.abs(seg.to.x - seg.from.x) * (b - a)) / ((seg.o1 - seg.o0) / n))
  }
  return views(peak)
}

describe('the glide (test 20)', () => {
  it('has the checked values of §5.10', () => {
    for (const r of [0.05, 0.1, 0.25, 0.4, 0.5]) expect(glide(0.5, r)).toBeCloseTo(0.5, 12)
    expect(glide(0.25, 0.5)).toBeCloseTo(0.09375, 12)
    expect(glide(0.25, 0.25)).toBeCloseTo(0.16667, 5)
    expect(glide(0.1, 0.5)).toBeCloseTo(0.0072, 12)
    expect(glide(-1, 0.5)).toBe(0)
    expect(glide(0, 0.5)).toBe(0)
    expect(glide(1, 0.5)).toBe(1)
    expect(glide(3, 0.2)).toBe(1)
  })

  for (const r of [0.1, 0.25, 0.5]) {
    it(`is continuous at r and 1 − r, monotone, with peak speed 1/(1 − r) and peak acceleration 1.5/(r(1 − r)) (r = ${r})`, () => {
      const h = 1e-6
      for (const u of [r, 1 - r]) expect(Math.abs(glide(u + h, r) - glide(u - h, r))).toBeLessThan((2 * h) / (1 - r) + 1e-12)
      let prev = 0
      let vPeak = 0
      let aPeak = 0
      const n = 20000
      const step = 1 / n
      for (let i = 1; i < n; i++) {
        const u = i * step
        const g = glide(u, r)
        expect(g).toBeGreaterThanOrEqual(prev)
        prev = g
        const v = (glide(u + step, r) - glide(u - step, r)) / (2 * step)
        const a = (glide(u + step, r) - 2 * g + glide(u - step, r)) / (step * step)
        vPeak = Math.max(vPeak, v)
        aPeak = Math.max(aPeak, Math.abs(a))
      }
      expect(Math.abs(vPeak - 1 / (1 - r))).toBeLessThan(1e-3)
      expect(Math.abs(aPeak - 1.5 / (r * (1 - r)))).toBeLessThan(1e-3 * aPeak)
      // Speed and acceleration are zero at both ends.
      expect(glide(step, r) / step).toBeLessThan(1e-3)
    })
  }

  it('glideInverse undoes it (1e-9)', () => {
    for (const r of [0.1, 0.3, 0.5])
      for (let u = 0.01; u < 1; u += 0.0731) expect(Math.abs(glideInverse(glide(u, r), r) - u)).toBeLessThan(1e-9)
    expect(glideInverse(0, 0.5)).toBe(0)
    expect(glideInverse(1, 0.5)).toBe(1)
  })
})

describe('panDuration (test 21)', () => {
  it('gives the Balanced table of §5.9', () => {
    const table: [number, number, number, number][] = [
      [0.3, 0.6, 1.0, 5.0],
      [0.5, 0.775, 1.29, 5.0],
      [0.75, 1.0, 1.5, 4.5],
      [1, 1.333, 1.5, 3.38],
      [1.5, 1.5, 2.0, 4.0],
      [2, 1.5, 2.67, 5.33],
      [3.16, 2.107, 3.0, 4.27]
    ]
    for (const [d, D, speed, accel] of table) {
      const got = panDuration(d)
      expect(Math.abs(got - D), `d ${d}`).toBeLessThan(1e-3)
      expect(Math.abs((2 * d) / got - speed)).toBeLessThan(0.01)
      expect(Math.abs((6 * d) / (got * got) - accel)).toBeLessThan(0.01)
    }
  })

  it('Calm is slower and Lively faster; never faster than hardSpeed', () => {
    expect(panDuration(1, PACE.calm)).toBeGreaterThan(panDuration(1))
    expect(panDuration(1, PACE.lively)).toBeLessThan(panDuration(1))
    for (const d of [0, 0.01, 0.4, 2, 5, 9]) for (const p of Object.values(PACE)) expect((2 * d) / panDuration(d, p)).toBeLessThanOrEqual(p.hardSpeed + 1e-12)
    expect(panDuration(0)).toBe(0.5)
  })
})

describe('shots and pans (tests 22-28)', () => {
  it('a still cursor: one hold at the cursor, clamped (test 22)', () => {
    const plan = planFollow(project(), track(samples(12, () => [0.4, 0.3])))
    expect(plan.segments).toHaveLength(1)
    expect(plan.segments[0]).toMatchObject({ kind: 'hold', o0: 0 })
    expect(plan.segments[0].from.x).toBeCloseTo(0.4, 6)
    expect(plan.segments[0].from.y).toBe(0.5)
    expect(plan.segments[0].o1).toBeCloseTo(12, 9)
    const edge = planFollow(project(), track(samples(12, () => [0.05, 0.5])))
    expect(edge.segments).toHaveLength(1)
    expect(edge.segments[0].from).toEqual({ x: BASE_W / 2, y: 0.5 })
    expect(followCentre(edge, 6)).toEqual({ x: BASE_W / 2, y: 0.5 })
  })

  it('rest, flight, rest: exactly one pan from the flight’s start (output time), lasting panDuration (test 23)', () => {
    const p = project({ clips: [{ id: 'c1', start: 0.5, end: 12, speed: 1 }] })
    const plan = planFollow(p, track(samples(12, flight([0.3, 0.5], [0.7, 0.5], 3, 3.4))))
    const [pan, ...rest] = moves(plan)
    expect(rest).toEqual([])
    expect(pan.kind).toBe('pan')
    expect(pan.o0).toBeCloseTo(2.5, 9)
    expect(pan.from.x).toBeCloseTo(0.3, 6)
    expect(pan.to.x).toBeCloseTo(0.7, 6)
    expect(pan.o1 - pan.o0).toBeCloseTo(panDuration(views(0.4)), 6)
    expect(followCentre(plan, 2).x).toBeCloseTo(0.3, 6)
    expect(followCentre(plan, 11).x).toBeCloseTo(0.7, 6)
  })

  it('the dead zone: a destination 0.29 views away moves nothing, 0.31 views away pans (test 24)', () => {
    const go = (d: number): FollowSegment[] => moves(planFollow(project(), track(samples(12, flight([0.5, 0.5], [0.5 + d * BASE_W, 0.5], 4, 4.2)))))
    expect(go(0.29)).toEqual([])
    expect(go(0.31)).toHaveLength(1)
  })

  it('confirmation: a far visit out and back within 0.45 s gives no pan, 0.6 s two; Calm ignores 0.65 s, Lively follows 0.4 s (test 25)', () => {
    const a: [number, number] = [0.3, 0.5]
    const b: [number, number] = [0.3 + 1.2 * BASE_W, 0.5]
    const pans = (stay: number, pace: ReframePace = 'balanced'): number => moves(planFollow(project({}, { pace }), track(samples(12, visit(a, b, 4, stay))))).length
    expect(pans(0.45)).toBe(0)
    expect(pans(0.6)).toBe(2)
    expect(pans(0.65, 'calm')).toBe(0)
    expect(pans(0.4, 'lively')).toBe(2)
    expect(pans(0.3, 'lively')).toBe(0)
  })

  it('a short visit the view already shows is dropped; a short far visit with a click is kept (test 26)', () => {
    const a: [number, number] = [0.4, 0.5]
    const near: [number, number] = [0.4 + 0.4 * BASE_W, 0.5]
    const other: [number, number] = [0.4 - 0.4 * BASE_W, 0.5]
    // 0.4 views right (out of the dead zone, within `visible`) for 0.6 s, then 0.4 views left of
    // where it started: too far apart for one view, so the visit is a shot of its own, shorter
    // than minHold. It is dropped: one pan, straight to the left.
    const via = (stay: number): Path => {
      const out = flight(a, near, 4, 4.1)
      const on = flight(near, other, 4 + stay, 4.1 + stay)
      return (t) => (t < 4 + stay ? out(t) : on(t))
    }
    const short = moves(planFollow(project(), track(samples(12, via(0.6)))))
    expect(short).toHaveLength(1)
    expect(short[0].to.x).toBeCloseTo(other[0], 6)
    // Held longer it is a real stop on the way.
    expect(moves(planFollow(project(), track(samples(12, via(1.0)))))).toHaveLength(2)
    const far: [number, number] = [0.4 + 1.2 * BASE_W, 0.5]
    const plan = planFollow(project(), track(samples(12, visit(a, far, 4, 0.3)), [click(4.2, far[0])]))
    expect(moves(plan).length).toBeGreaterThanOrEqual(1)
    expect(plan.shots.some((s) => s.firm && Math.abs(s.centre.x - far[0]) < 0.01)).toBe(true)
  })

  it('the worked example of §5.17: anticipates the click, pan [1.604, 3.104], the click 0.35 views from the centre, peak 2.32 views/s (test 27)', () => {
    const plan = planFollow(project({}, {}, 8), track(samples(8, flight([0.2, 0.5], [0.75, 0.5], 2, 2.4)), [click(2.6, 0.75)]))
    const [pan, ...rest] = moves(plan)
    expect(rest).toEqual([])
    expect(pan.o0).toBeCloseTo(1.604, 3)
    expect(pan.o1).toBeCloseTo(3.104, 3)
    expect(pan.from.x).toBeCloseTo(0.2, 6)
    expect(pan.to.x).toBeCloseTo(0.75, 6)
    expect(views(Math.abs(0.75 - followCentre(plan, 2.6).x))).toBeCloseTo(0.35, 3)
    expect(followCentre(plan, 2.6).x).toBeCloseTo(0.639, 3)
    expect(peakSpeed(pan)).toBeCloseTo(2.32, 2)
    // Shot 0 sees 0.20 until the flight: the destination would spread the view too wide.
    expect(plan.shots[0].centre.x).toBeCloseTo(0.2, 6)
    expect(plan.shots[1]).toMatchObject({ firm: true, cut: false, late: false, kind: 'cursor' })
    expect(plan.shots[1].firstFirm).toBeCloseTo(2.6, 9)
  })

  it('hurry and late: two clicks 0.5 s and 1.74 views apart (test 28)', () => {
    const x1 = 0.2
    const x2 = x1 + 1.738 * BASE_W
    const plan = planFollow(project({}, {}, 8), track(samples(8, flight([x1, 0.5], [x2, 0.5], 3.1, 3.3)), [click(3, x1), click(3.5, x2)]))
    const [pan, ...rest] = moves(plan)
    expect(rest).toEqual([])
    expect(pan.o0).toBeCloseTo(3.1, 9)
    expect(pan.o1 - pan.o0).toBeCloseTo((2 * 1.738) / 3, 6)
    expect(pan.o1 - pan.o0).toBeCloseTo(1.159, 3)
    expect(peakSpeed(pan)).toBeCloseTo(3, 2)
    const second = plan.shots.find((s) => s.firstFirm > 3.4)!
    expect(second.late).toBe(true)
  })

  it('anticipation leaves at most maxLead before the shot; past that the pan hurries, here to hardSpeed and late (test 28)', () => {
    // Calm: the click at 4.3 s is 2.15 views away and its shot starts at 3.9 s (clickBefore). To
    // have it in view by then the view would leave at 3.26 s, 0.64 s early: more than maxLead.
    const plan = planFollow(project({}, { pace: 'calm' }, 8), track(samples(8, flight([0.16, 0.5], [0.84, 0.5], 4, 4.1)), [click(4.3, 0.84)]))
    const [pan, ...rest] = moves(plan)
    expect(rest).toEqual([])
    expect(plan.shots[1].o0).toBeCloseTo(3.9, 9)
    expect(pan.o0).toBeCloseTo(3.9 - PACE.calm.maxLead, 9)
    expect(pan.o1 - pan.o0).toBeCloseTo((2 * views(0.68)) / PACE.calm.hardSpeed, 6)
    expect(plan.shots[1].late).toBe(true)
  })

  it('backlog: a shot whose pan could only start after the next shot began gets none; the view goes straight on to the next (test 28)', () => {
    // Clicks at 0.84, 0.5 and 0.75, 0.4 s and 0.3 s apart: the long pan to 0.84 is still under way
    // when the shots of 0.5 (4.0 s) and 0.75 (4.3 s) begin.
    const path: Path = (t) => (t < 3.5 ? [0.2, 0.5] : t < 4.3 ? flight([0.2, 0.5], [0.84, 0.5], 3.5, 3.6)(t) : t < 4.6 ? flight([0.84, 0.5], [0.5, 0.5], 4.3, 4.4)(t) : flight([0.5, 0.5], [0.75, 0.5], 4.6, 4.7)(t))
    const plan = planFollow(project({}, {}, 8), track(samples(8, path), [click(4, 0.84), click(4.4, 0.5), click(4.7, 0.75)]))
    expect(plan.shots.map((s) => Math.round(s.centre.x * 100) / 100)).toEqual([0.2, 0.84, 0.5, 0.75])
    const all = moves(plan)
    expect(all).toHaveLength(2)
    expect(all[0].to.x).toBeCloseTo(0.84, 6)
    expect(all[1].from.x).toBeCloseTo(0.84, 6)
    expect(all[1].to.x).toBeCloseTo(0.75, 6)
    expect(all[1].o0).toBeCloseTo(all[0].o1, 9)
  })
})

describe('what holds and what moves the view (tests 29, 31-34)', () => {
  it('typing holds: the cursor wandering ±0.3 during a typing session does not move the view (test 29)', () => {
    const field: [number, number] = [0.3, 0.4]
    const path: Path = (t) => (t < 3 || t > 7.3 ? field : [0.3 + 0.3 * Math.sin(2 * Math.PI * 0.7 * (t - 3)), 0.5])
    const t = track(samples(12, path), [click(3, field[0], field[1])], { typing: [{ t: 3.5, end: 4.5 }, { t: 5, end: 7 }] })
    expect(moves(planFollow(project(), t))).toEqual([])
    // Without the typing the wandering cursor is followed.
    expect(moves(planFollow(project(), { ...t, typing: [] })).length).toBeGreaterThan(0)
  })

  it('zoom aims: a fixed-point zoom is in view when it starts and held through it; an auto zoom’s anchor is in view by its start (test 31)', () => {
    const P = 0.3 + 0.6 * BASE_W
    const fixed = project({ zooms: [{ id: 'z', start: 5, end: 9, scale: 1.5, focus: { mode: 'fixed', x: P, y: 0.5 }, auto: false }] })
    const plan = planFollow(fixed, track(samples(12, () => [0.3, 0.5])))
    expect(views(Math.abs(followCentre(plan, 5).x - P))).toBeLessThanOrEqual(FOLLOW.inView + 1e-6)
    const [pan] = moves(plan)
    for (let t = pan.o1; t < 9; t += 0.1) expect(followCentre(plan, t).x).toBeCloseTo(P, 6)
    expect(plan.shots.find((s) => s.kind === 'zoom')).toMatchObject({ firm: true, late: false })

    const Q = 0.7
    const auto = project({ zooms: [{ id: 'a', start: 5, end: 8, scale: 1.8, focus: { mode: 'cursor' }, auto: true, anchor: { t: 5.9, x: Q, y: 0.5 } }] })
    const toQ = planFollow(auto, track(samples(12, flight([0.3, 0.5], [Q, 0.5], 5.8, 5.9))))
    expect(views(Math.abs(followCentre(toQ, 5).x - Q))).toBeLessThanOrEqual(FOLLOW.inView + 1e-6)
  })

  it('inside a framed 1.4x zoom a 0.25-view step (0.35 zoomed views) moves the view; outside a zoom it does not (test 31)', () => {
    const step = flight([0.5, 0.5], [0.5 + 0.25 * BASE_W, 0.5], 6, 6.1)
    const zoomed = project({ zooms: [{ id: 'z', start: 2, end: 11, scale: 1.8, focus: { mode: 'cursor' }, auto: false }] })
    expect(moves(planFollow(zoomed, track(samples(12, step))))).toHaveLength(1)
    expect(moves(planFollow(project(), track(samples(12, step))))).toEqual([])
  })

  it('a pull-back aims at nothing, fixed or anchored: the still cursor keeps the view (test 31)', () => {
    const zooms: Project['zooms'] = [
      { id: 'f', start: 3, end: 5, scale: 0.75, focus: { mode: 'fixed', x: 0.9, y: 0.5 }, auto: false },
      { id: 'c', start: 7, end: 9, scale: 0.75, focus: { mode: 'cursor' }, auto: true, anchor: { t: 7.5, x: 0.9, y: 0.5 } }
    ]
    const p = project({ zooms })
    const t = track(samples(12, () => [0.3, 0.5]))
    const att = followAttention(p, t)
    for (let k = 0; k < att.o.length; k++) expect(att.kind[k], `at ${att.o[k]} s`).toBe(6)
    expect(moves(planFollow(p, t))).toEqual([])
  })

  it('shapes: an arrow shown 3-6 s keeps its head in view while the cursor wanders; a blur shape does not move the view (test 32)', () => {
    const head = { x: 0.75, y: 0.4 }
    const arrow: Shape = { id: 's', start: 3, end: 6, kind: 'arrow', x: 0.6, y: 0.6, w: 0.15, h: -0.2, color: '#ef4444', strokeWidth: 6, fill: false, opacity: 1, strength: 0.5 }
    const wander: Path = (t) => [0.3 + 0.12 * Math.sin(2 * Math.PI * 0.4 * t), 0.5 + 0.2 * Math.sin(2 * Math.PI * 0.3 * t)]
    const plan = planFollow(project({ shapes: [arrow] }), track(samples(12, wander)))
    // The wandering cursor moves the view before; from 3 s it goes to the arrow's head.
    const arrive = moves(plan).find((m) => Math.abs(m.to.x - head.x) < 1e-6)!
    expect(arrive.o0).toBeGreaterThanOrEqual(3)
    expect(arrive.o0).toBeLessThan(3.5)
    for (let t = arrive.o1; t < 6; t += 0.05) expect(views(Math.abs(followCentre(plan, t).x - head.x))).toBeLessThanOrEqual(0.5)
    const blur: Shape = { ...arrow, kind: 'blur', x: 0.7, y: 0.2, w: 0.2, h: 0.2 }
    expect(moves(planFollow(project({ shapes: [blur] }), track(samples(12, () => [0.3, 0.5]))))).toEqual([])
    // A region spotlight draws the eye like a box.
    const lit = planFollow(project({ spotlights: [{ id: 'l', start: 3, end: 6, mode: 'region', x: 0.7, y: 0.3, w: 0.1, h: 0.2, shape: 'rect', dim: 0.6, feather: 0.3 }] }), track(samples(12, () => [0.3, 0.5])))
    expect(moves(lit)[0].to.x).toBeCloseTo(0.75, 6)
  })

  it('off the frame: a cursor at x = 1.7 for 10 s gives a hold; its return gives one pan (test 33)', () => {
    const path: Path = (t) => (t < 2 ? [0.6, 0.5] : t < 12 ? [1.7, 0.5] : t < 12.1 ? [1.7 - (t - 12) * 14, 0.5] : [0.3, 0.5])
    const plan = planFollow(project({}, {}, 16), track(samples(16, path)))
    const all = moves(plan)
    expect(all).toHaveLength(1)
    expect(all[0].o0).toBeGreaterThanOrEqual(11.9)
    expect(all[0].to.x).toBeCloseTo(0.3, 6)
    expect(followCentre(plan, 8).x).toBeCloseTo(0.6, 6)
  })

  it('typing with the cursor off the frame and no click into a field: no target, the view stays (test 33)', () => {
    // A window recording: the cursor rests at 0.3, leaves the window at 4 s and the user types 6-12 s.
    const path: Path = (t) => (t < 4 ? [0.3, 0.6] : t < 4.1 ? [0.3 + (t - 4) * 10, 0.6] : [1.3, 0.6])
    const typing = [{ t: 6, end: 9 }, { t: 9.5, end: 12 }]
    const p = project({}, {}, 16)
    const plan = planFollow(p, track(samples(16, path), [], { typing }))
    expect(moves(plan)).toEqual([])
    expect(followCentre(plan, 14).x).toBeCloseTo(0.3, 6)
    const att = followAttention(p, track(samples(16, path), [], { typing }))
    for (let k = 6 * 30; k <= 12 * 30; k++) expect(att.kind[k], `at ${att.o[k]} s`).toBe(0)
    // With the cursor on the frame where typing began, the typing holds the view there.
    const inside: Path = (t) => (t < 4 ? [0.3, 0.6] : t < 4.1 ? [0.3 + (t - 4) * 5, 0.6] : t < 9 ? [0.8, 0.6] : [0.2, 0.6])
    const typed = planFollow(p, track(samples(16, inside), [], { typing }))
    expect(followCentre(typed, 11).x).toBeCloseTo(0.8, 6)
  })

  it('a rest outside the crop gives no target (test 33)', () => {
    const p = project({ crop: { x: 0.2, y: 0, w: 0.75, h: 1 } })
    const stored = track(samples(12, (t) => (t < 4 ? [0.05, 0.5] : [0.6, 0.5])))
    const view = cropView(p, stored)
    expect(view.cursor.samples[0].x).toBeCloseTo(-0.2, 9)
    const att = followAttention(view.project, view.cursor)
    expect(att.kind[30]).toBe(0)
    expect(Number.isNaN(att.x[30])).toBe(true)
    expect(att.kind[150]).toBe(6)
  })

  it('no cursor data: one hold at the rest point (after the crop) or the centre; a fixed-point zoom gives two pans (test 34)', () => {
    const none: CursorTrack = { samples: [], clicks: [], valid: false }
    const centre = planFollow(project(), none)
    expect(centre.segments).toHaveLength(1)
    expect(centre.segments[0].from).toEqual({ x: 0.5, y: 0.5 })
    // Rest point 0.3 of the whole frame is 0.4 of a crop keeping the left three quarters.
    const cropped = project({ crop: { x: 0, y: 0, w: 0.75, h: 1 } }, { rest: { x: 0.3, y: 0.5 } })
    const view = cropView(cropped, none)
    const rest = planFollow(view.project, view.cursor)
    expect(rest.segments).toHaveLength(1)
    expect(rest.segments[0].from.x).toBeCloseTo(0.4, 9)
    // Window recordings with a zoom aimed somewhere: there and back.
    const zoom = project({ zooms: [{ id: 'z', start: 4, end: 8, scale: 1.8, focus: { mode: 'fixed', x: 0.8, y: 0.5 }, auto: true }] })
    const both = moves(planFollow(zoom, none))
    expect(both).toHaveLength(2)
    expect(both[0].to.x).toBeCloseTo(0.8, 6)
    expect(both[1].to.x).toBeCloseTo(0.5, 6)
    expect(followCentre(planFollow(zoom, { ...none, valid: true }), 11)).toEqual({ x: 0.5, y: 0.5 })
  })
})

describe('cuts and speed (test 35)', () => {
  const cut = (d: number): { plan: FollowPlan; a: number; b: number } => {
    const a = 0.4
    const b = a + d * BASE_W
    const p = project({ clips: [{ id: 'c1', start: 0, end: 5, speed: 1 }, { id: 'c2', start: 8, end: 15, speed: 1 }] }, {}, 15)
    return { plan: planFollow(p, track(samples(15, (t) => (t < 6.5 ? [a, 0.5] : [b, 0.5])))), a, b }
  }

  it('after a cut a target 0.6 views away changes the view at the cut, and no segment crosses it', () => {
    const { plan, a, b } = cut(0.6)
    for (const s of plan.segments) expect(s.o0 < 5 - 1e-9 && s.o1 > 5 + 1e-9).toBe(false)
    expect(moves(plan)).toEqual([])
    expect(followCentre(plan, 4.99).x).toBeCloseTo(a, 6)
    expect(followCentre(plan, 8).x).toBeCloseTo(b, 6)
    expect(plan.shots[1]).toMatchObject({ cut: true, o0: 5 })
  })

  it('0.4 views away nothing changes at the cut: the view moves after it as it would anyway', () => {
    const { plan, a } = cut(0.4)
    expect(plan.shots.some((s) => s.cut)).toBe(false)
    expect(followCentre(plan, 8).x).toBeCloseTo(a, 6)
    expect(followCentre(plan, 4.999).x).toBeCloseTo(a, 6)
  })

  it('a shutter past a clip’s end samples that clip’s last view, never the next clip’s', () => {
    const { plan, a, b } = cut(0.6)
    expect(followCentre(plan, 5 + 0.05, 5 - 0.01)).toEqual(followCentre(plan, 5 - 1e-9))
    expect(followCentre(plan, 5 + 0.05, 5 - 0.01).x).toBeCloseTo(a, 6)
    expect(followCentre(plan, 5, 5).x).toBeCloseTo(b, 6)
    // A time inside the cut belongs to the next clip.
    expect(followCentre(plan, 6.5).x).toBeCloseTo(b, 6)
  })

  it('on a 4x clip a pan lasts the same output seconds and covers 4x the source time', () => {
    const one = planFollow(project({}, {}, 10), track(samples(10, flight([0.3, 0.5], [0.7, 0.5], 2, 2.1))))
    const four = planFollow(project({ clips: [{ id: 'c1', start: 0, end: 40, speed: 4 }] }, {}, 40), track(samples(40, flight([0.3, 0.5], [0.7, 0.5], 8, 8.4))))
    const [p1] = moves(one)
    const [p4] = moves(four)
    expect(p4.o0).toBeCloseTo(p1.o0, 9)
    expect(p4.o1 - p4.o0).toBeCloseTo(p1.o1 - p1.o0, 9)
    for (const u of [0.1, 0.4, 0.8]) expect(followCentre(four, (p4.o0 + u * (p4.o1 - p4.o0)) * 4).x).toBeCloseTo(followCentre(one, p1.o0 + u * (p1.o1 - p1.o0)).x, 9)
  })
})

describe('joined glides (test 36)', () => {
  // A drag across the whole screen in 6 s: about 0.5 views/s.
  const drag: Path = (t) => [0.02 + 0.96 * clamp01((t - 2) / 6), 0.5]
  const press = { t: 2, x: 0.02, y: 0.5, button: 'left' as const, up: 8 }

  it('a slow drag is one glide, the cursor always in view', () => {
    const s = samples(12, drag)
    const plan = planFollow(project(), track(s, [press]))
    const all = moves(plan)
    expect(all).toHaveLength(1)
    expect(all[0].kind).toBe('glide')
    expect(all[0].ramp).toBeCloseTo(PACE.balanced.glideRamp / (all[0].o1 - all[0].o0), 9)
    expect(peakSpeed(all[0])).toBeLessThan(0.75)
    for (const q of s) expect(views(Math.abs(Math.min(Math.max(q.x, BASE_W / 2), 1 - BASE_W / 2) - followCentre(plan, q.t).x))).toBeLessThan(0.5)
  })

  it('with a click the glide would leave beyond inView: no join there, and the click is in view', () => {
    const plan = planFollow(project(), track(samples(12, drag), [press, click(5, 0.5)]))
    expect(moves(plan).length).toBeGreaterThan(1)
    expect(views(Math.abs(followCentre(plan, 5).x - 0.5))).toBeLessThanOrEqual(FOLLOW.inView + 1e-6)
  })
})

/** A seeded random walk with rests, quick jumps and clicks over `duration` seconds. */
function walk(seed: number, duration: number): CursorTrack {
  const r = rng(seed)
  const s: CursorSample[] = []
  const clicks: ClickEvent[] = []
  let x = 0.5
  let y = 0.5
  let vx = 0
  let vy = 0
  for (let i = 0; i * DT <= duration; i++) {
    const t = i * DT
    const k = r()
    if (k < 0.004) {
      // A quick jump somewhere else, often with a click there.
      x = 0.05 + r() * 0.9
      y = 0.05 + r() * 0.9
      vx = 0
      vy = 0
      if (r() < 0.6) clicks.push({ t: t + 0.3 + r() * 0.5, x, y, button: 'left' })
    } else if (k < 0.02) {
      vx = (r() - 0.5) * 0.01
      vy = (r() - 0.5) * 0.01
    } else if (k < 0.03) {
      vx = 0
      vy = 0
    }
    x = Math.min(1, Math.max(0, x + vx))
    y = Math.min(1, Math.max(0, y + vy))
    s.push({ t, x, y })
  }
  return track(s, clicks.filter((c) => c.t < duration))
}

const clamp01 = (v: number): number => Math.min(1, Math.max(0, v))

describe('determinism and robustness (tests 37, 38)', () => {
  const p = project({ zooms: [{ id: 'z', start: 20, end: 26, scale: 2, focus: { mode: 'cursor' }, auto: true, anchor: { t: 21, x: 0.7, y: 0.4 } }] }, {}, 60)
  const t = walk(37, 60)

  it('planFollow twice is deep-equal; followPlanFor reuses it until an input changes', () => {
    expect(planFollow(p, t)).toEqual(planFollow(p, t))
    const cached = followPlanFor(p, t)
    expect(followPlanFor(p, t)).toBe(cached)
    expect(followPlanFor({ ...p }, { ...t })).toBe(cached)
    expect(cached).toEqual(planFollow(p, t))
    expect(followPlanFor({ ...p, reframe: { ...p.reframe!, pace: 'calm' } }, t)).not.toBe(cached)
    expect(followPlanFor({ ...p, zooms: [...p.zooms] }, t)).not.toBe(cached)
    expect(followPlanFor({ ...p, style: { ...p.style, aspectRatio: '1:1' } }, t)).not.toBe(cached)
  })

  it('10,000 evaluations in random order equal the sequential ones', () => {
    const plan = planFollow(p, t)
    const times = Array.from({ length: 10_000 }, (_, i) => (i / 10_000) * 61 - 0.5)
    const sequential = times.map((u) => followCentre(plan, u))
    const r = rng(38)
    const order = times.map((_, i) => i).sort(() => r() - 0.5)
    for (const i of order) expect(followCentre(plan, times[i])).toEqual(sequential[i])
  })

  it('the same plan for a 1080p, a 720p and a 405x720 frame of the same shape', () => {
    const plan = followPlanFor(p, t)
    for (const u of [3, 17.5, 22, 40.25]) {
      const c = followCentre(plan, u)
      const at = [1080, 720, 405].map((w) => {
        const h = Math.round((w * 16) / 9)
        const base = sceneLayout(p, w, h, p.width, p.height, u).follow!.base
        return clampCamera({ scale: 1, cx: c.x, cy: c.y }, base).cx
      })
      expect(Math.abs(at[1] - at[0])).toBeLessThan(1e-3)
      expect(Math.abs(at[2] - at[0])).toBeLessThan(1e-3)
    }
  })

  it('shuffled samples give the plan of the sorted ones', () => {
    const r = rng(380)
    const shuffled = { ...t, samples: [...t.samples].sort(() => r() - 0.5), clicks: [...t.clicks].reverse() }
    expect(planFollow(p, shuffled)).toEqual(planFollow(p, t))
  })

  it('NaN samples, clicks, scrolls, typing and shapes give no throw and the plan without them', () => {
    const shapes: Shape[] = [{ id: 's', start: 40, end: 45, kind: 'arrow', x: 0.6, y: 0.6, w: 0.15, h: -0.2, color: '#ef4444', strokeWidth: 6, fill: false, opacity: 1, strength: 0.5 }]
    const bad: Shape = { ...shapes[0], id: 'bad', x: Number.NaN }
    // Four seconds of scrolling at the top right.
    const wheel = Array.from({ length: 10 }, (_, i) => ({ t: 50 + i * 0.4, x: 0.85, y: 0.2, dx: 0, dy: 1 }))
    const broken: CursorTrack = {
      ...t,
      samples: [...t.samples.slice(0, 500), { t: Number.NaN, x: 0.5, y: 0.5 }, { t: 9, x: Number.POSITIVE_INFINITY, y: 0.5 }, ...t.samples.slice(500)],
      clicks: [...t.clicks, { t: Number.NaN, x: 0.5, y: 0.5, button: 'left' }, { t: 12, x: Number.NaN, y: 0.5, button: 'left' }],
      scrolls: [{ t: Number.NaN, x: 0.5, y: 0.5, dx: 0, dy: 1 }, ...wheel],
      typing: [{ t: Number.NaN, end: 3 }]
    }
    const clean: CursorTrack = { ...t, scrolls: wheel, typing: [] }
    expect(planFollow({ ...p, shapes: [...shapes, bad] }, broken)).toEqual(planFollow({ ...p, shapes }, clean))
    // The scrolling and the shape are followed (they change the plan).
    expect(planFollow({ ...p, shapes }, clean)).not.toEqual(planFollow({ ...p, shapes }, { ...clean, scrolls: [] }))
    expect(planFollow({ ...p, shapes }, clean)).not.toEqual(planFollow(p, clean))
    expect(() => planFollow(project({}, {}, 0.1), track([]))).not.toThrow()
    expect(planFollow(project({ duration: 0.1, clips: [{ id: 'c', start: 0, end: 0.1, speed: 1 }] }, {}, 0.1), track([])).segments).toHaveLength(1)
    expect(followCentre(planFollow(p, t), Number.NaN)).toBeDefined()
  })
})

describe('a layout change while following (test 39)', () => {
  it('band to screen-only at 8 s and back at 14 s: the clamped centre never jumps more than maxSpeed/60 views beyond the planned motion', () => {
    const layouts: LayoutSegment[] = [{ id: 'l', start: 8, end: 14, layout: 'screen-only' }]
    const p = project({ hasWebcam: true, webcam: { show: true, corner: 'bottom-right', size: 0.24, shape: 'circle' }, layouts }, {}, 20)
    // At the edges, where the band's wider view and the narrower one clamp the centre differently.
    const plan = planFollow(p, track(samples(20, (t) => [t < 6 || t > 16 ? 0.9 : 0.12, 0.5])))
    expect(sceneLayout(p, 1080, 1920, 1920, 1080, 10).follow!.base.w).toBeLessThan(sceneLayout(p, 1080, 1920, 1920, 1080, 6).follow!.base.w)
    let prev: { planned: number; drawn: number; w: number } | null = null
    // Every frame of the 20 s video (frames start before its end).
    for (let i = 0; i < 20 * 60; i++) {
      const u = i / 60
      const c = followCentre(plan, u)
      const base = sceneLayout(p, 1080, 1920, 1920, 1080, u).follow!.base
      const drawn = clampCamera({ scale: 1, cx: c.x, cy: c.y }, base).cx
      if (prev) expect(Math.abs(drawn - prev.drawn - (c.x - prev.planned)) / base.w).toBeLessThanOrEqual(PACE.balanced.maxSpeed / 60)
      prev = { planned: c.x, drawn, w: base.w }
    }
  })

  it('during the change the plan measures in the smaller of the two views: a click in view only in the band’s wider one counts as outside', () => {
    const webcam: Project['webcam'] = { ...project().webcam, show: true, corner: 'bottom-right', size: 0.24, shape: 'circle' }
    const p = project({ hasWebcam: true, webcam, layouts: [{ id: 'l', start: 2, end: 8, layout: 'screen-only' }] })
    const band = sceneLayout(p, 1080, 1920, 1920, 1080, 1).follow!.base.w
    const narrow = sceneLayout(p, 1080, 1920, 1920, 1080, 5).follow!.base.w
    expect(narrow).toBeCloseTo(BASE_W, 9)
    expect(band).toBeGreaterThan(narrow * 1.2)
    // 0.3 views of the band's view is 0.36 views of screen-only's: outside the dead zone only there.
    const x = 0.5 + 0.15 * (band + narrow)
    const still = samples(12, () => [0.5, 0.5])
    // Screen-only animates in over 2-2.4 s: a click at 2.41 s draws attention from 2.01 s.
    const into = planFollow(p, track(still, [click(2.41, x)]))
    const first = into.shots.find((s) => s.firm)!
    expect(first.kind).toBe('click')
    expect(first.o0).toBeGreaterThan(2)
    expect(first.o0).toBeLessThan(2.4)
    // And back to the band over 7.6-8 s: a click at 8.01 s draws attention from 7.61 s, during the change only.
    const out = planFollow(p, track(still, [click(8.01, x)]))
    const back = out.shots.find((s) => s.firm)!
    expect(back.kind).toBe('click')
    expect(back.o0).toBeGreaterThan(7.6)
    expect(back.o0).toBeLessThan(8)
    expect(moves(out)).toHaveLength(1)
  })
})

describe('smoothness (test 40)', () => {
  const paces: ReframePace[] = ['calm', 'balanced', 'lively']
  const counts: Record<ReframePace, number> = { calm: 0, balanced: 0, lively: 0 }

  for (const pace of paces) {
    it(`${pace}: ten minutes of random walk with jumps and clicks move the view smoothly`, () => {
      const P: PaceParams = PACE[pace]
      const duration = 600
      const plan = planFollow(project({}, { pace }, duration), walk(4000, duration))
      const all = moves(plan)
      counts[pace] = all.length
      expect(all.length).toBeGreaterThan(10)
      expect(all.length).toBeLessThanOrEqual(30 * (duration / 60))
      for (let i = 1; i < plan.segments.length; i++) expect(plan.segments[i].o0).toBeCloseTo(plan.segments[i - 1].o1, 9)
      for (const m of all) {
        const d = views(Math.max(Math.abs(m.to.x - m.from.x), 0)) || 0
        const D = m.o1 - m.o0
        expect(D).toBeGreaterThan(0)
        // Peak speed at most hardSpeed; per-frame acceleration and jerk within the glide's bounds.
        // The jerk of y³ − y⁴/2 peaks at 6 (its third derivative 6 − 12y), so the bound is
        // 6/(r²(1 − r)) × d/D³ (§5.10 gives half of that).
        expect(peakSpeed(m)).toBeLessThanOrEqual(P.hardSpeed + 1e-6)
        const r = m.ramp
        const aMax = ((1.5 / (r * (1 - r))) * d) / (D * D)
        const jMax = ((6 / (r * r * (1 - r))) * d) / (D * D * D)
        const h = 1 / 120
        const xs: number[] = []
        for (let t = m.o0; t <= m.o1 + 1e-9; t += h) xs.push(views(m.from.x + (m.to.x - m.from.x) * glide((t - m.o0) / D, r)))
        let dir = 0
        for (let i = 1; i < xs.length; i++) {
          const v = xs[i] - xs[i - 1]
          if (Math.abs(v) > 1e-12) {
            if (dir === 0) dir = Math.sign(v)
            expect(Math.sign(v)).toBe(dir)
          }
        }
        for (let i = 1; i + 1 < xs.length; i++) expect(Math.abs(xs[i + 1] - 2 * xs[i] + xs[i - 1]) / (h * h)).toBeLessThanOrEqual(aMax * 1.01 + 1e-9)
        for (let i = 1; i + 2 < xs.length; i++) expect(Math.abs(xs[i + 2] - 3 * xs[i + 1] + 3 * xs[i] - xs[i - 1]) / (h * h * h)).toBeLessThanOrEqual(jMax * 1.01 + 1e-6)
      }
    })
  }

  it('Calm makes no more pans than Balanced, Balanced no more than Lively', () => {
    expect(counts.calm).toBeLessThanOrEqual(counts.balanced)
    expect(counts.balanced).toBeLessThanOrEqual(counts.lively)
  })
})

describe('performance (test 30)', () => {
  it('plans a synthetic hour under 400 ms and evaluates 1e6 times under 300 ms', () => {
    const duration = 3600
    const r = rng(30)
    const s: CursorSample[] = new Array(216_000)
    let x = 0.5
    let y = 0.5
    for (let i = 0; i < s.length; i++) {
      if (r() < 0.003) {
        x = r()
        y = r()
      }
      x = clamp01(x + (r() - 0.5) * 0.004)
      y = clamp01(y + (r() - 0.5) * 0.004)
      s[i] = { t: i / 60, x, y }
    }
    const clicks: ClickEvent[] = Array.from({ length: 600 }, (_, i) => ({ t: 3 + i * 6, x: r(), y: r(), button: 'left' as const }))
    const zooms = Array.from({ length: 40 }, (_, i) => ({ id: `z${i}`, start: 10 + i * 88, end: 14 + i * 88, scale: 1.8, focus: { mode: 'cursor' as const }, auto: true, anchor: { t: 11 + i * 88, x: r(), y: r() } }))
    const clips = Array.from({ length: 21 }, (_, i) => ({ id: `c${i}`, start: i * 171, end: i * 171 + 169, speed: 1 }))
    const layouts: LayoutSegment[] = [600, 1400, 2200, 3000].map((t, i) => ({ id: `l${i}`, start: t, end: t + 120, layout: i % 2 ? 'camera-only' : 'screen-only' }))
    const p = project({ zooms, clips, layouts, hasWebcam: true, webcam: { show: true, corner: 'bottom-right', size: 0.24, shape: 'circle' } }, {}, duration)
    const t = track(s, clicks)
    planFollow(p, track(s.slice(0, 600)))
    const start = performance.now()
    const plan = planFollow(p, t)
    const took = performance.now() - start
    expect(plan.segments.length).toBeGreaterThan(20)
    expect(took).toBeLessThan(400)
    const t0 = performance.now()
    let sum = 0
    for (let i = 0; i < 1_000_000; i++) sum += followCentre(plan, (i * 0.0036) % duration).x
    expect(performance.now() - t0).toBeLessThan(300)
    expect(Number.isFinite(sum)).toBe(true)
  })
})
