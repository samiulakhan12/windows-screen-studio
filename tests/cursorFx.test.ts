import { describe, expect, it } from 'vitest'
import { DEFAULT_CURSOR_EXTRAS } from '../src/shared/engine/project'
import { outputDuration, outputToSource } from '../src/shared/engine/timeline'
import {
  blendHome,
  cursorLook,
  cursorVelocity,
  hexRgb,
  LOOP_HOME,
  loopHomeTime,
  loopHomeWeight,
  rgba,
  TILT,
  tiltAngle,
  TRAIL,
  trailGhosts
} from '../src/shared/render/cursorFx'
import type { Clip, CursorSettings } from '../src/shared/types'

const legacy: CursorSettings = { show: true, size: 1.4, smoothing: 0.6, clickEffect: true, hideWhenIdle: true }
const full: Clip[] = [{ id: 'a', start: 0, end: 10, speed: 1 }]
const edited: Clip[] = [
  { id: 'a', start: 1, end: 3, speed: 1 },
  { id: 'b', start: 5, end: 9, speed: 2 }
]

describe('cursorLook', () => {
  it('gives older projects the defaults (they look as before)', () => {
    expect(cursorLook(legacy)).toEqual(DEFAULT_CURSOR_EXTRAS)
    expect(cursorLook(legacy).style).toBe('auto')
    expect(cursorLook(legacy).clickStyle).toBe('ripple')
    expect(cursorLook(legacy).clickColor).toBe('#ffffff')
  })

  it('keeps valid values and replaces invalid ones field by field', () => {
    const c = cursorLook({
      ...legacy,
      style: 'mac',
      clickStyle: 'bogus' as never,
      clickColor: 'red',
      highlight: { enabled: true, color: '#00ff00', size: 99, opacity: NaN },
      clickSound: true,
      clickSoundVolume: 3,
      tilt: true
    })
    expect(c.style).toBe('mac')
    expect(c.clickStyle).toBe('ripple')
    expect(c.clickColor).toBe('#ffffff')
    expect(c.highlight).toEqual({ enabled: true, color: '#00ff00', size: 5, opacity: DEFAULT_CURSOR_EXTRAS.highlight.opacity })
    expect(c.clickSound).toBe(true)
    expect(c.clickSoundVolume).toBe(1)
    expect(c.tilt).toBe(true)
    expect(c.trail).toBe(false)
  })
})

describe('colours', () => {
  it('parses #rrggbb and falls back to white', () => {
    expect(hexRgb('#facc15')).toEqual([250, 204, 21])
    expect(hexRgb('nope')).toEqual([255, 255, 255])
    expect(rgba('#000000', 0.5)).toBe('rgba(0,0,0,0.5)')
    expect(rgba('#ffffff', 2)).toBe('rgba(255,255,255,1)')
  })
})

describe('loop home', () => {
  it('is 0 until the last second of output time and 1 at the end', () => {
    expect(loopHomeWeight(full, 0)).toBe(0)
    expect(loopHomeWeight(full, 8.99)).toBe(0)
    expect(loopHomeWeight(full, 9.5)).toBeCloseTo(0.5, 5)
    expect(loopHomeWeight(full, 10)).toBe(1)
    // The last exported frame (60 fps) is already home, give or take a hair.
    expect(loopHomeWeight(full, 10 - 1 / 60)).toBeGreaterThan(0.999)
  })

  it('rises monotonically and smoothly', () => {
    let prev = 0
    let maxStep = 0
    for (let t = 9; t <= 10; t += 0.01) {
      const w = loopHomeWeight(full, t)
      expect(w).toBeGreaterThanOrEqual(prev - 1e-12)
      maxStep = Math.max(maxStep, w - prev)
      prev = w
    }
    // Eased: no frame jumps more than ~2% of the way.
    expect(maxStep).toBeLessThan(0.02)
    // Zero velocity at both ends: the first step is tiny.
    expect(loopHomeWeight(full, 9.01)).toBeLessThan(1e-4)
  })

  it('measures the last second in output time across cuts and speed changes', () => {
    // Output: clip a 0..2, clip b (4 s at 2x) 2..4. The last output second is source 7..9.
    expect(outputDuration(edited)).toBe(4)
    expect(loopHomeWeight(edited, 6.9)).toBe(0)
    expect(loopHomeWeight(edited, 8)).toBeCloseTo(0.5, 5)
    expect(loopHomeWeight(edited, 9)).toBe(1)
    // The home position is the first kept frame.
    expect(loopHomeTime(edited)).toBe(1)
    // A time inside a cut uses the frame shown there (the next clip's start).
    expect(loopHomeWeight(edited, 4)).toBe(0)
  })

  it('takes at most a third of a very short edit', () => {
    const short: Clip[] = [{ id: 'a', start: 0, end: 1.5, speed: 1 }]
    expect(loopHomeWeight(short, 0.9)).toBe(0)
    expect(loopHomeWeight(short, 1.25)).toBeCloseTo(0.5, 5)
    expect(LOOP_HOME.maxShare).toBeCloseTo(1 / 3)
  })

  it('blends a position toward home', () => {
    expect(blendHome({ x: 1, y: 1 }, { x: 0, y: 0.5 }, 0)).toEqual({ x: 1, y: 1 })
    expect(blendHome({ x: 1, y: 1 }, { x: 0, y: 0.5 }, 0.5)).toEqual({ x: 0.5, y: 0.75 })
    expect(blendHome({ x: 1, y: 1 }, { x: 0, y: 0.5 }, 1)).toEqual({ x: 0, y: 0.5 })
  })
})

describe('tilt', () => {
  const max = (TILT.maxDeg * Math.PI) / 180
  it('stays within the maximum lean and is 0 when still', () => {
    expect(tiltAngle(0)).toBe(0)
    for (const v of [-1e9, -50, -3, -0.2, 0.2, 3, 50, 1e9]) expect(Math.abs(tiltAngle(v))).toBeLessThanOrEqual(max + 1e-12)
    expect(tiltAngle(NaN)).toBe(0)
    expect(tiltAngle(Infinity)).toBe(0)
  })

  it('leans into the movement, more when faster', () => {
    expect(tiltAngle(0.3)).toBeGreaterThan(0)
    expect(tiltAngle(-0.3)).toBeLessThan(0)
    expect(tiltAngle(0.6)).toBeGreaterThan(tiltAngle(0.3))
    expect(tiltAngle(5)).toBeGreaterThan(max * 0.99)
    // A few degrees at a typical speed.
    expect((tiltAngle(0.3) * 180) / Math.PI).toBeGreaterThan(2)
    expect((tiltAngle(0.3) * 180) / Math.PI).toBeLessThan(6)
  })

  it('measures velocity per output second, inside the clip', () => {
    const pos = (t: number): { x: number; y: number } => ({ x: 0.1 * t, y: 0.5 })
    expect(cursorVelocity(pos, full, 5).vx).toBeCloseTo(0.1, 6)
    // Twice as fast on screen in a 2x clip.
    expect(cursorVelocity(pos, edited, 7).vx).toBeCloseTo(0.2, 6)
    // A jump during the cut (3..5) does not leak into the velocity at the clip's edge.
    const jumpy = (t: number): { x: number; y: number } => ({ x: t < 4 ? 0 : 1, y: 0 })
    expect(cursorVelocity(jumpy, edited, 5).vx).toBe(0)
    expect(cursorVelocity(jumpy, edited, 2.99).vx).toBe(0)
  })
})

describe('trail', () => {
  const px = (x: number, y: number): { x: number; y: number } => ({ x: x * 1280, y: y * 720 })
  it('has no ghosts while the cursor is still or slow', () => {
    expect(trailGhosts(() => ({ x: 0.5, y: 0.5 }), full, 5, px)).toEqual([])
    // ~1 px per 1/60 s: below the threshold.
    expect(trailGhosts((t) => ({ x: (t * 60) / 1280, y: 0.5 }), full, 5, px)).toEqual([])
  })

  it('samples ghosts behind a fast cursor, fading with age', () => {
    // 1280 px/s = ~21 px per ghost step.
    const g = trailGhosts((t) => ({ x: t - 4.5, y: 0.5 }), full, 5, px)
    expect(g).toHaveLength(TRAIL.ghosts)
    for (let i = 0; i < g.length; i++) {
      expect(g[i].t).toBeCloseTo(5 - (i + 1) * TRAIL.spacing, 9)
      expect(g[i].x).toBeLessThan(0.5)
      if (i > 0) expect(g[i].alpha).toBeLessThan(g[i - 1].alpha)
    }
    expect(g[0].alpha).toBeLessThanOrEqual(TRAIL.alpha)
  })

  it('spaces ghosts in output time (a 2x clip covers twice the source time) and never crosses a cut', () => {
    const pos = (t: number): { x: number; y: number } => ({ x: t / 2, y: 0.5 })
    const g = trailGhosts(pos, edited, 7, px)
    expect(g[0].t).toBeCloseTo(7 - 2 * TRAIL.spacing, 9)
    // Right after the cut, the trail is limited to the new clip.
    const atStart = trailGhosts(pos, edited, 5 + 2 * 2 * TRAIL.spacing + 1e-6, px)
    expect(atStart.every((x) => x.t >= 5)).toBe(true)
    expect(atStart.length).toBe(2)
    // Inside a cut there is no cursor, so no trail.
    expect(trailGhosts(pos, edited, 4, px)).toEqual([])
  })

  it('ghost source times map to the frames just before (output time)', () => {
    const g = trailGhosts((t) => ({ x: t / 2, y: 0.5 }), edited, 8, px)
    const o = (t: number): number => {
      // Output time of a source time in clip b.
      return 2 + (t - 5) / 2
    }
    g.forEach((x, i) => expect(o(8) - o(x.t)).toBeCloseTo((i + 1) * TRAIL.spacing, 9))
    expect(outputToSource(edited, o(g[0].t)).time).toBeCloseTo(g[0].t, 9)
  })
})
