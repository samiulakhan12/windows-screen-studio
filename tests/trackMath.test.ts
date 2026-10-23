import { describe, expect, it } from 'vitest'
import { HookClock } from '../src/main/recording/hookClock'
import { buildCursorTrack, clampTrack, holdSamples, toSourceTime, type RawTrack } from '../src/main/recording/trackMath'

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
