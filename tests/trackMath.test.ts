import { describe, expect, it } from 'vitest'
import { HookClock } from '../src/main/recording/hookClock'
import { buildCursorTrack, clampTrack, holdSamples, toSourceTime, type RawTrack } from '../src/main/recording/trackMath'
import { windowMapping } from '../src/main/recording/windowCapture'
import type { Rect } from '../src/shared/recording/windowGeometry'

const T0 = 1_700_000_000_000
const display = { x: 0, y: 0, width: 1000, height: 500 }

function raw(over: Partial<RawTrack> = {}): RawTrack {
  return { samples: [], clicks: [], keys: [], bounds: display, scale: 1.5, ...over }
}

describe('toSourceTime', () => {
  const pauses = [{ from: T0 + 2000, to: T0 + 5000 }]
  it('removes paused time', () => {
    expect(toSourceTime(T0 + 1000, T0, pauses)).toBe(1)
    expect(toSourceTime(T0 + 6000, T0, pauses)).toBe(3)
  })
  it('maps an instant inside a pause to the pause start', () => {
    expect(toSourceTime(T0 + 3500, T0, pauses)).toBe(2)
  })
})

describe('buildCursorTrack', () => {
  it('normalises positions to the display and keeps the start position', () => {
    const track = buildCursorTrack(
      raw({ samples: [{ at: T0 - 500, x: 100, y: 100 }, { at: T0 + 1000, x: 500, y: 250 }] }),
      { startedAt: T0, pauses: [], duration: 2, region: null }
    )
    expect(track.valid).toBe(true)
    expect(track.scale).toBe(1.5)
    expect(track.samples[0]).toEqual({ t: 0, x: 0.1, y: 0.2 })
    expect(track.samples.at(-1)).toEqual({ t: 1, x: 0.5, y: 0.5 })
  })

  it('holds the cursor still across gaps in event-driven sampling', () => {
    const track = buildCursorTrack(
      raw({ samples: [{ at: T0 + 100, x: 0, y: 0 }, { at: T0 + 3100, x: 1000, y: 500 }] }),
      { startedAt: T0, pauses: [], duration: 4, region: null }
    )
    // Just before the jump the cursor is still where it was.
    const held = track.samples[1]
    expect(held.x).toBe(0)
    expect(held.t).toBeCloseTo(3.1 - 1 / 120, 6)
  })

  it('drops clicks outside the display (other monitors) and after the end', () => {
    const track = buildCursorTrack(
      raw({
        clicks: [
          { at: T0 + 1000, x: 500, y: 250, button: 'left' },
          { at: T0 + 1500, x: 1500, y: 250, button: 'left' },
          { at: T0 + 2500, x: 500, y: 250, button: 'left' }
        ]
      }),
      { startedAt: T0, pauses: [], duration: 2, region: null }
    )
    expect(track.clicks).toEqual([{ t: 1, x: 0.5, y: 0.5, button: 'left' }])
  })

  it('remaps positions into a recorded region and drops clicks outside it', () => {
    const region = { x: 0.5, y: 0.5, w: 0.5, h: 0.5 }
    const track = buildCursorTrack(
      raw({
        samples: [{ at: T0 + 100, x: 750, y: 375 }],
        clicks: [
          { at: T0 + 200, x: 750, y: 375, button: 'left' },
          { at: T0 + 300, x: 100, y: 100, button: 'left' }
        ]
      }),
      { startedAt: T0, pauses: [], duration: 1, region }
    )
    expect(track.samples[0]).toMatchObject({ x: 0.5, y: 0.5 })
    expect(track.clicks).toHaveLength(1)
    expect(track.clicks[0]).toMatchObject({ x: 0.5, y: 0.5 })
  })

  it('uses the pause-adjusted clock for keys and shapes', () => {
    const pauses = [{ from: T0 + 1000, to: T0 + 3000 }]
    const track = buildCursorTrack(
      raw({ keys: [{ at: T0 + 4000, label: 'Ctrl + S' }, { at: T0 + 500, label: 'Enter' }] }),
      {
        startedAt: T0,
        pauses,
        duration: 3,
        region: null,
        shapes: [
          { at: T0 - 100, shape: 'arrow' },
          { at: T0 + 2000, shape: 'text' },
          { at: T0 + 3500, shape: 'text' },
          { at: T0 + 3600, shape: 'pointer' }
        ]
      }
    )
    expect(track.keys).toEqual([
      { t: 0.5, label: 'Enter' },
      { t: 2, label: 'Ctrl + S' }
    ])
    // A change made while paused applies from the pause point; duplicates collapse.
    expect(track.shapes).toEqual([
      { t: 0, shape: 'arrow' },
      { t: 1, shape: 'text' },
      { t: 1.6, shape: 'pointer' }
    ])
  })

  it('drops input made while paused, judged by event time (hook events arrive late)', () => {
    const pauses = [{ from: T0 + 1000, to: T0 + 3000 }]
    const track = buildCursorTrack(
      raw({
        samples: [{ at: T0 + 500, x: 100, y: 100 }, { at: T0 + 2000, x: 900, y: 400 }, { at: T0 + 3500, x: 200, y: 200 }],
        clicks: [
          { at: T0 + 2000, x: 500, y: 250, button: 'left' },
          { at: T0 + 3500, x: 500, y: 250, button: 'left' }
        ],
        keys: [{ at: T0 + 1500, label: 'Ctrl + V' }]
      }),
      { startedAt: T0, pauses, duration: 3, region: null }
    )
    expect(track.clicks.map((c) => c.t)).toEqual([1.5])
    expect(track.keys).toEqual([])
    expect(track.samples.every((s) => s.x !== 0.9)).toBe(true)
  })

  it('records keys but no positions for window captures', () => {
    const track = buildCursorTrack(
      raw({ bounds: null, samples: [{ at: T0, x: 1, y: 1 }], keys: [{ at: T0 + 100, label: 'Esc' }] }),
      { startedAt: T0, pauses: [], duration: 1, region: null }
    )
    expect(track.valid).toBe(false)
    expect(track.samples).toEqual([])
    expect(track.keys).toEqual([{ t: 0.1, label: 'Esc' }])
  })

  it('keeps slack until the final duration is applied', () => {
    const track = buildCursorTrack(raw({ clicks: [{ at: T0 + 2300, x: 10, y: 10, button: 'left' }] }), {
      startedAt: T0,
      pauses: [],
      duration: 2,
      region: null,
      slack: 1
    })
    expect(track.clicks).toHaveLength(1)
    expect(clampTrack(track, 2).clicks).toHaveLength(0)
    expect(clampTrack(track, 2.5).clicks).toHaveLength(1)
  })
})

describe('holdSamples', () => {
  it('leaves regularly spaced samples alone', () => {
    const s = [0, 1, 2].map((i) => ({ t: i / 60, x: i, y: i }))
    expect(holdSamples(s)).toEqual(s)
  })
})

describe('HookClock', () => {
  it('estimates the epoch offset from the least delayed event', () => {
    const c = new HookClock()
    // Both events arrive in one batch; the later one waited least.
    const a = c.observe(1000, T0 + 500)
    const b = c.observe(1100, T0 + 500)
    expect(c.toEpoch(b) - c.toEpoch(a)).toBe(100)
    expect(c.toEpoch(b)).toBe(T0 + 500)
    // A promptly delivered event refines the estimate for all events.
    c.observe(2000, T0 + 1390)
    expect(c.toEpoch(b)).toBe(T0 + 490)
  })

  it('unwraps the 32-bit tick rollover', () => {
    const c = new HookClock()
    const a = c.observe(2 ** 32 - 10, T0)
    const b = c.observe(5, T0 + 15)
    expect(b - a).toBe(15)
    expect(c.toEpoch(b)).toBe(T0 + 15)
  })
})

/**
 * Window recordings: the cursor is tracked in global DIP screen coordinates and mapped
 * through the window's rectangle (physical pixels from the helper/watcher) at each instant,
 * into a video of the window's initial size (resized windows are fitted, centred).
 */
describe('buildCursorTrack for a window', () => {
  const identity = (r: Rect): Rect => r
  /** The window starts at (100, 50), 800 x 400; the video is that size. */
  const VIDEO = { width: 800, height: 400 }
  const rect = (at: number, x: number, y: number, width = 800, height = 400, minimized = false) => ({ at, x, y, width, height, minimized })
  const windowRaw = (over: Partial<RawTrack> = {}): RawTrack => raw({ bounds: null, scale: 1, ...over })
  const build = (r: RawTrack, rects: ReturnType<typeof rect>[], extra: { pauses?: { from: number; to: number }[]; toDip?: (r: Rect) => Rect; duration?: number } = {}) =>
    buildCursorTrack(r, {
      startedAt: T0,
      pauses: extra.pauses ?? [],
      duration: extra.duration ?? 10,
      region: null,
      window: windowMapping(rects, extra.toDip ?? identity, VIDEO)
    })
  const close = (p: { x: number; y: number }, x: number, y: number): boolean => Math.abs(p.x - x) < 1e-9 && Math.abs(p.y - y) < 1e-9

  it('maps positions and clicks through a window that moves mid-recording', () => {
    const track = build(
      windowRaw({
        samples: [
          { at: T0 + 100, x: 500, y: 250 }, // window centre
          { at: T0 + 3000, x: 700, y: 650 } // after the move: centre of the moved window
        ],
        clicks: [
          { at: T0 + 1000, x: 300, y: 150, button: 'left' }, // (200, 100) into the window: a quarter
          { at: T0 + 3500, x: 700, y: 650, button: 'left' }
        ]
      }),
      [rect(T0 - 500, 100, 50), rect(T0 + 2000, 300, 450)]
    )
    expect(track.valid).toBe(true)
    expect(close(track.samples[0], 0.5, 0.5)).toBe(true)
    expect(close(track.samples.at(-1)!, 0.5, 0.5)).toBe(true)
    expect(track.clicks).toHaveLength(2)
    expect(close(track.clicks[0], 0.25, 0.25)).toBe(true)
    expect(close(track.clicks[1], 0.5, 0.5)).toBe(true)
  })

  it('moves a still cursor in the video when the window moves under it', () => {
    // The cursor never moves; the window jumps 400 px right at 2 s.
    const track = build(windowRaw({ samples: [{ at: T0 + 100, x: 500, y: 250 }] }), [rect(T0 - 500, 100, 50), rect(T0 + 2000, 500, 50)])
    const at = (t: number) => {
      const before = track.samples.filter((s) => s.t <= t).pop()!
      return before
    }
    expect(close(at(1.9), 0.5, 0.5)).toBe(true)
    // At the move the cursor is at the window's left edge: x = 0, held until then.
    expect(close(at(2), 0, 0.5)).toBe(true)
    expect(track.samples.filter((s) => s.t > 1 && s.t < 2).every((s) => s.x === 0.5)).toBe(true)
  })

  it('fits a resized window into the initial video size (centred) and maps through the fit', () => {
    // Resized to 1600 x 400 at 1 s: fitted at half scale, letterboxed (bars of 100 px top and bottom).
    const track = build(
      windowRaw({
        samples: [{ at: T0 + 1500, x: 100 + 1600, y: 50 + 400 }],
        clicks: [{ at: T0 + 1500, x: 100 + 400, y: 50 + 200, button: 'left' }]
      }),
      [rect(T0 - 500, 100, 50), rect(T0 + 1000, 100, 50, 1600, 400)]
    )
    // Bottom-right corner of the content: (800, 300) in the 800 x 400 video.
    expect(close(track.samples.find((s) => s.t === 1.5)!, 1, 0.75)).toBe(true)
    // A quarter across and half down the window: (200, 200) in the video.
    expect(close(track.clicks[0], 0.25, 0.5)).toBe(true)
  })

  it('drops clicks outside the window but keeps positions there (mapped outside the video)', () => {
    const track = build(
      windowRaw({
        samples: [{ at: T0 + 100, x: 1300, y: 250 }],
        clicks: [
          { at: T0 + 200, x: 1300, y: 250, button: 'left' },
          { at: T0 + 300, x: 899.99, y: 449.99, button: 'right' }
        ]
      }),
      [rect(T0 - 500, 100, 50)]
    )
    expect(track.samples[0].x).toBeGreaterThan(1)
    expect(track.clicks).toHaveLength(1)
    expect(track.clicks[0].button).toBe('right')
    expect(track.clicks[0].x).toBeLessThanOrEqual(1)
  })

  it('drops positions and clicks while the window is minimised', () => {
    const track = build(
      windowRaw({
        samples: [
          { at: T0 + 100, x: 500, y: 250 },
          { at: T0 + 1500, x: 510, y: 260 },
          { at: T0 + 2500, x: 520, y: 270 }
        ],
        clicks: [
          { at: T0 + 1500, x: 500, y: 250, button: 'left' },
          { at: T0 + 2500, x: 500, y: 250, button: 'left' }
        ]
      }),
      // Windows parks a minimised window at -32000, -32000.
      [rect(T0 - 500, 100, 50), rect(T0 + 1000, -32000, -32000, 160, 28, true), rect(T0 + 2000, 100, 50)]
    )
    // The position seen while minimised is gone; before and after it are kept.
    expect(track.samples.some((s) => close(s, 410 / 800, 210 / 400))).toBe(false)
    expect(track.samples.some((s) => close(s, 400 / 800, 200 / 400))).toBe(true)
    expect(track.samples.some((s) => close(s, 420 / 800, 220 / 400))).toBe(true)
    expect(track.clicks.map((c) => c.t)).toEqual([2.5])
  })

  it('uses the pause-adjusted clock and follows a window moved while paused', () => {
    const pauses = [{ from: T0 + 1000, to: T0 + 3000 }]
    const track = build(
      windowRaw({
        samples: [{ at: T0 + 100, x: 500, y: 250 }],
        clicks: [
          { at: T0 + 2000, x: 500, y: 250, button: 'left' }, // paused: dropped
          { at: T0 + 3500, x: 500, y: 250, button: 'left' }
        ]
      }),
      // Moved 200 px left while paused.
      [rect(T0 - 500, 100, 50), rect(T0 + 2000, -100, 50)],
      { pauses }
    )
    expect(track.clicks).toHaveLength(1)
    expect(track.clicks[0].t).toBeCloseTo(1.5, 9)
    expect(close(track.clicks[0], 0.75, 0.5)).toBe(true)
    // On resume (t = 1 s) the still cursor shows where it now is in the window.
    const resumed = track.samples.filter((s) => s.t <= 1).pop()!
    expect(close(resumed, 0.75, 0.5)).toBe(true)
  })

  it('converts physical rectangles to DIP at 150% before mapping DIP positions', () => {
    // At 150% the window is at (150, 75) physical, 1200 x 600, i.e. (100, 50) DIP, 800 x 400;
    // the video is its physical size.
    const toDip = (r: Rect): Rect => ({ x: r.x / 1.5, y: r.y / 1.5, width: r.width / 1.5, height: r.height / 1.5 })
    const track = buildCursorTrack(
      windowRaw({
        samples: [{ at: T0 + 100, x: 300, y: 150 }],
        clicks: [{ at: T0 + 200, x: 700, y: 350, button: 'left' }]
      }),
      { startedAt: T0, pauses: [], duration: 1, region: null, window: windowMapping([rect(T0 - 10, 150, 75, 1200, 600)], toDip, { width: 1200, height: 600 }) }
    )
    expect(close(track.samples[0], 0.25, 0.25)).toBe(true)
    expect(close(track.clicks[0], 0.75, 0.75)).toBe(true)
  })

  it('has no cursor data without a window rectangle', () => {
    const track = build(windowRaw({ samples: [{ at: T0, x: 1, y: 1 }], keys: [{ at: T0 + 100, label: 'Esc' }] }), [])
    expect(track.valid).toBe(false)
    expect(track.samples).toEqual([])
    expect(track.keys).toEqual([{ t: 0.1, label: 'Esc' }])
  })
})

describe('buildCursorTrack for a window: bars, drags and covering windows', () => {
  type R = { at: number; x: number; y: number; width: number; height: number; minimized?: boolean; cursorOver?: boolean }
  const rect = (at: number, x: number, y: number, width = 1280, height = 720, extra: Partial<R> = {}): R => ({ at, x, y, width, height, ...extra })
  const build = (r: Partial<RawTrack>, rects: R[], video = { width: 1280, height: 720 }, duration = 10) =>
    buildCursorTrack(raw({ bounds: null, scale: 1, ...r }), { startedAt: T0, pauses: [], duration, region: null, window: windowMapping(rects, (x) => x, video) })
  const sampleAt = (track: ReturnType<typeof build>, t: number) => track.samples.find((s) => Math.abs(s.t - t) < 1e-9)!
  const inVideo = (p: { x: number; y: number }): boolean => p.x >= 0 && p.x <= 1 && p.y >= 0 && p.y <= 1

  it('maps the cursor beside a window resized to another shape outside the video, never into the black bars (mapping-2)', () => {
    // 1280 x 720 at (100, 0), resized at 3 s to 640 x 720: its content sits at x 0.25..0.75.
    const track = build(
      {
        samples: [
          { at: T0 + 3100, x: 900, y: 300 },
          { at: T0 + 3200, x: 1000, y: 300 },
          { at: T0 + 3300, x: 50, y: 300 },
          { at: T0 + 3400, x: 400, y: 300 }
        ],
        clicks: [{ at: T0 + 3250, x: 1000, y: 300, button: 'left' }]
      },
      [rect(T0 - 500, 100, 0), rect(T0 + 3000, 100, 0, 640, 720)]
    )
    expect(sampleAt(track, 3.1).x).toBeGreaterThan(1)
    expect(sampleAt(track, 3.2).x).toBeGreaterThan(1)
    expect(sampleAt(track, 3.3).x).toBeLessThan(0)
    // Inside the window: on the fitted content, as before.
    expect(sampleAt(track, 3.4).x).toBeCloseTo(0.25 + (300 / 640) * 0.5, 9)
    expect(track.clicks).toEqual([])
  })

  it('moves a cursor standing still beside the window outside the video when the window is resized under it', () => {
    const track = build({ samples: [{ at: T0 + 100, x: 1500, y: 300 }] }, [rect(T0 - 500, 100, 0), rect(T0 + 3000, 100, 0, 640, 720)])
    expect(sampleAt(track, 3).x).toBeGreaterThan(1)
    expect(track.samples.every((s) => !inVideo(s))).toBe(true)
  })

  it('keeps a cursor that drags the window by its title bar on the title bar (mapping-3)', () => {
    // Dragged right at 1500 px/s: rectangles every 16 ms, cursor samples every 16.67 ms at
    // another phase, the grab point 400 px into the window, 15 px down.
    const rects: R[] = [rect(T0 - 1000, 100, 100)]
    for (let at = 0; at <= 1000; at += 16) rects.push(rect(T0 + at, 100 + 1.5 * at, 100))
    const samples: RawTrack['samples'] = []
    for (let at = 3; at <= 1000; at += 1000 / 60) samples.push({ at: T0 + at, x: 500 + 1.5 * at, y: 115 })
    const track = build({ samples }, rects)
    const during = track.samples.filter((s) => s.t > 0.05 && s.t < 0.98)
    expect(during.length).toBeGreaterThan(50)
    for (const s of during) {
      expect(Math.abs(s.x * 1280 - 400)).toBeLessThan(1)
      expect(Math.abs(s.y * 720 - 15)).toBeLessThan(1e-6)
    }
  })

  it('does not move a still window early: a pose reported 5 s later applies from one poll before it', () => {
    const track = build(
      { samples: [{ at: T0 + 100, x: 740, y: 360 }, { at: T0 + 2500, x: 740, y: 360 }, { at: T0 + 4980, x: 740, y: 360 }] },
      [rect(T0 - 500, 100, 0), rect(T0 + 5000, 500, 0)]
    )
    expect(sampleAt(track, 2.5).x).toBeCloseTo(0.5, 9)
    expect(sampleAt(track, 4.98).x).toBeCloseTo(0.5, 9)
    expect(sampleAt(track, 5).x).toBeCloseTo(240 / 1280, 9)
  })

  it('ignores clicks and hides the cursor while another window covers the recorded one under it (mapping-5)', () => {
    const track = build(
      {
        samples: [
          { at: T0 + 500, x: 740, y: 360 }, // over the window
          { at: T0 + 1500, x: 1200, y: 600 }, // over a chat window covering its lower right corner
          { at: T0 + 2500, x: 740, y: 360 } // back over the window
        ],
        clicks: [
          { at: T0 + 1600, x: 1200, y: 600, button: 'left' },
          { at: T0 + 2600, x: 740, y: 360, button: 'left' }
        ]
      },
      [rect(T0 - 500, 100, 0), rect(T0 + 1400, 100, 0, 1280, 720, { cursorOver: false }), rect(T0 + 2400, 100, 0, 1280, 720, { cursorOver: true })]
    )
    expect(track.clicks.map((c) => c.t)).toEqual([2.6])
    expect(inVideo(sampleAt(track, 0.5))).toBe(true)
    // Hidden past the video edge nearest to where it is (the right edge here).
    const hidden = sampleAt(track, 1.5)
    expect(inVideo(hidden)).toBe(false)
    expect(hidden.x).toBeGreaterThan(1)
    expect(hidden.y).toBeCloseTo(600 / 720, 9)
    // From the instant the cursor went off the window, and shown again on return.
    expect(inVideo(sampleAt(track, 1.4))).toBe(false)
    expect(inVideo(sampleAt(track, 2.4))).toBe(true)
    expect(inVideo(sampleAt(track, 2.5))).toBe(true)
  })

  it('treats a missing cursorOver (older helpers) as over the window', () => {
    const track = build({ samples: [{ at: T0 + 500, x: 740, y: 360 }], clicks: [{ at: T0 + 600, x: 740, y: 360, button: 'left' }] }, [rect(T0 - 500, 100, 0)])
    expect(track.clicks).toHaveLength(1)
    expect(inVideo(track.samples[0])).toBe(true)
  })
})
