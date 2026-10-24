import { EventEmitter } from 'node:events'
import { afterEach, describe, expect, it, vi } from 'vitest'

const cursor = vi.hoisted(() => ({ x: 100, y: 50 }))
/** Every position the tracker read: what storing every poll used to keep. */
const reads = vi.hoisted(() => [] as { at: number; x: number; y: number }[])
vi.mock('electron', () => ({
  screen: {
    getCursorScreenPoint: () => {
      reads.push({ at: Date.now(), x: cursor.x, y: cursor.y })
      return { ...cursor }
    },
    // Pretend a 2x display: hook events are physical pixels.
    screenToDipPoint: (p: { x: number; y: number }) => ({ x: p.x / 2, y: p.y / 2 })
  }
}))

import { CursorTracker, type HookModule } from '../src/main/cursorTracker'
import { buildCursorTrack, type PauseSpan } from '../src/main/recording/trackMath'
import { cursorAt, cursorOpacity } from '../src/shared/engine/cursor'

/** Stands in for uiohook-napi: tests emit the events a real hook would. */
function fakeHook() {
  const emitter = new EventEmitter()
  const state = { started: 0, stopped: 0 }
  const mod = {
    uIOhook: {
      on: (event: string, cb: (...a: unknown[]) => void) => emitter.on(event, cb),
      removeAllListeners: (event?: string) => emitter.removeAllListeners(event),
      start: () => void state.started++,
      stop: () => void state.stopped++
    }
  } as unknown as HookModule
  return { mod, emit: (event: string, e: object) => emitter.emit(event, e), state }
}

const display = { bounds: { x: 0, y: 0, width: 1000, height: 500 }, scaleFactor: 2 }
const toolbar = { x: 400, y: 440, width: 200, height: 50 }
const options = {
  display,
  captureKeys: true,
  isOwnPoint: (p: { x: number; y: number }) => p.x >= toolbar.x && p.x < toolbar.x + toolbar.width && p.y >= toolbar.y && p.y < toolbar.y + toolbar.height,
  ignoreKeys: ['Ctrl + Shift + 2']
}
const key = (keycode: number, mods: Record<string, boolean> = {}, time = 0) => ({ time, keycode, ctrlKey: false, altKey: false, shiftKey: false, metaKey: false, ...mods })

describe('CursorTracker', () => {
  it('collects what it captured, with the display bounds and scale', () => {
    const t = new CursorTracker(() => null)
    t.start(options)
    expect(t.active).toBe(true)
    const raw = t.collect()
    expect(t.active).toBe(false)
    expect(raw.bounds).toEqual(display.bounds)
    expect(raw.scale).toBe(2)
    expect(raw.samples[0]).toMatchObject({ x: 100, y: 50 })
  })

  it('stop() discards, so a later start (e.g. after a native fallback) tracks again', () => {
    const hook = fakeHook()
    const t = new CursorTracker(() => hook.mod)
    t.start(options)
    t.stop()
    expect(t.active).toBe(false)
    expect(hook.state.stopped).toBe(1)
    cursor.x = 700
    t.start(options)
    expect(t.active).toBe(true)
    const raw = t.collect()
    expect(raw.samples[0].x).toBe(700)
    expect(hook.state.started).toBe(2)
  })

  it('records clicks in DIP, but not on the toolbar', () => {
    const hook = fakeHook()
    const t = new CursorTracker(() => hook.mod)
    t.start(options)
    hook.emit('mousedown', { time: 1000, x: 200, y: 100, button: 1 })
    hook.emit('mousedown', { time: 1100, x: 1000, y: 900, button: 1 }) // (500, 450): on the toolbar
    hook.emit('mousedown', { time: 1300, x: 600, y: 600, button: 2 })
    const raw = t.collect()
    expect(raw.clicks.map((c) => [c.x, c.y, c.button])).toEqual([
      [100, 50, 'left'],
      [300, 300, 'right']
    ])
    // Hook times are converted to epoch milliseconds, 300 ms apart.
    expect(raw.clicks[1].at - raw.clicks[0].at).toBe(300)
  })

  it('keeps shortcuts only, skipping typing and the stop shortcut', () => {
    const hook = fakeHook()
    const t = new CursorTracker(() => hook.mod)
    t.start(options)
    hook.emit('keydown', key(31, { ctrlKey: true }, 10)) // Ctrl + S
    hook.emit('keyup', key(31, {}, 20))
    hook.emit('keydown', key(30, {}, 30)) // a
    hook.emit('keydown', key(3, { ctrlKey: true, shiftKey: true }, 40)) // the stop shortcut
    hook.emit('keydown', key(1, {}, 60)) // Esc
    expect(t.collect().keys.map((k) => k.label)).toEqual(['Ctrl + S', 'Esc'])
  })

  it('records keys but no positions for window captures', () => {
    const hook = fakeHook()
    const t = new CursorTracker(() => hook.mod)
    t.start({ ...options, display: null })
    hook.emit('mousedown', { time: 1, x: 10, y: 10, button: 1 })
    hook.emit('keydown', key(28, {}, 2))
    const raw = t.collect()
    expect(raw.bounds).toBeNull()
    expect(raw.samples).toEqual([])
    expect(raw.clicks).toEqual([])
    expect(raw.keys.map((k) => k.label)).toEqual(['Enter'])
  })
})

describe('CursorTracker polling (perf-3)', () => {
  afterEach(() => {
    vi.useRealTimers()
  })

  it('stores positions only when the cursor moved, with exactly the same interpolated track', () => {
    const T0 = 1_700_000_000_000
    vi.useFakeTimers({ now: T0 })
    reads.length = 0
    Object.assign(cursor, { x: 100, y: 50 })
    const t = new CursorTracker(() => null, true)
    t.start(options)
    const pauses: PauseSpan[] = []
    const moveTo = (x: number, y: number, ms: number): void => {
      Object.assign(cursor, { x, y })
      vi.advanceTimersByTime(ms)
    }
    vi.advanceTimersByTime(1000) // still
    for (let i = 1; i <= 6; i++) moveTo(100 + 20 * i, 50 + 5 * i, 17) // a quick move
    vi.advanceTimersByTime(2000) // still again
    const pausedAt = Date.now()
    t.setPaused(true)
    moveTo(300, 300, 500) // moved while paused
    t.setPaused(false)
    pauses.push({ from: pausedAt, to: Date.now() })
    vi.advanceTimersByTime(1000)
    for (let i = 1; i <= 3; i++) moveTo(300 - 30 * i, 300, 17)
    vi.advanceTimersByTime(700)
    const raw = t.collect()

    // What storing every poll kept (the previous behaviour), minus reads while paused.
    const everyPoll = reads.filter((r) => !pauses.some((p) => r.at > p.from && r.at < p.to))
    expect(raw.samples.length).toBeLessThan(everyPoll.length / 10)

    const duration = (Date.now() - T0 - 500) / 1000
    const build = (samples: { at: number; x: number; y: number }[]) =>
      buildCursorTrack({ ...raw, samples }, { startedAt: T0, pauses, duration, region: null }).samples
    const before = build(everyPoll)
    const after = build(raw.samples)
    for (let s = 0; s <= duration; s += 0.004) {
      expect(cursorAt(after, s)).toEqual(cursorAt(before, s))
      expect(cursorOpacity(after, s)).toBeCloseTo(cursorOpacity(before, s), 9)
    }
  })
})
