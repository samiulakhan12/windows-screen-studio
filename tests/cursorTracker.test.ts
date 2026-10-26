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

import { CursorTracker, type HookModule, type TrackerOptions } from '../src/main/cursorTracker'
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

  it('records the cursor and clicks in global DIP coordinates for a window whose position is known', () => {
    const hook = fakeHook()
    const t = new CursorTracker(() => hook.mod, false)
    cursor.x = 100
    t.start({ ...options, display: null, global: true })
    hook.emit('mousemove', { time: 0, x: 3000, y: 1600, button: 0 }) // beyond any one display: kept
    hook.emit('mousedown', { time: 10, x: 4000, y: 2000, button: 1 })
    hook.emit('mousedown', { time: 20, x: 1000, y: 900, button: 1 }) // the toolbar: dropped
    hook.emit('keydown', key(28, {}, 30))
    const raw = t.collect()
    // Mapped into the window when the recording is finalised.
    expect(raw.bounds).toBeNull()
    expect(raw.samples).toHaveLength(2)
    expect(raw.samples.map((s) => [s.x, s.y])).toEqual(
      expect.arrayContaining([
        [100, 50],
        [1500, 800]
      ])
    )
    expect(raw.clicks.map((c) => [c.x, c.y, c.button])).toEqual([[2000, 1000, 'left']])
    expect(raw.keys.map((k) => k.label)).toEqual(['Enter'])
    expect(hook.state.started).toBe(1)
  })
})

describe('CursorTracker: wheel scrolling', () => {
  const wheel = (time: number, rotation: number, over: Record<string, unknown> = {}) => ({ time, x: 200, y: 100, rotation, amount: 3, direction: 3, ctrlKey: false, metaKey: false, ...over })
  const start = (opts: Partial<TrackerOptions> = {}) => {
    const hook = fakeHook()
    const t = new CursorTracker(() => hook.mod, false)
    t.start({ ...options, ...opts })
    return { hook, t }
  }

  it('stores a wheel event in DIP with its signed notches on y', () => {
    const { hook, t } = start()
    hook.emit('wheel', wheel(1000, 1))
    const raw = t.collect()
    expect(raw.scrolls).toHaveLength(1)
    expect(raw.scrolls![0]).toMatchObject({ x: 100, y: 50, dx: 0, dy: 1 })
  })

  it('merges events under 50 ms apart on the same axis, taking the new position; 60 ms apart stays separate', () => {
    const { hook, t } = start()
    hook.emit('wheel', wheel(1000, 1))
    hook.emit('wheel', wheel(1030, 2, { x: 220, y: 120 })) // 30 ms later: merged
    hook.emit('wheel', wheel(1090, 1)) // 90 ms after the stored event (60 ms after the last one): separate
    hook.emit('wheel', wheel(1139, 1)) // 49 ms: merged
    hook.emit('wheel', wheel(1189, 1)) // 50 ms after the stored event: not under 50, separate
    const raw = t.collect()
    expect(raw.scrolls!.map((s) => [s.x, s.y, s.dx, s.dy])).toEqual([
      [110, 60, 0, 3],
      [100, 50, 0, 2],
      [100, 50, 0, 1]
    ])
    // The merged event keeps the time of its first wheel event.
    expect(raw.scrolls![1].at - raw.scrolls![0].at).toBe(90)
  })

  it('puts horizontal wheel notches on dx, and never merges across axes or opposite signs', () => {
    const { hook, t } = start()
    hook.emit('wheel', wheel(1000, -2, { direction: 4 }))
    hook.emit('wheel', wheel(1010, -1, { direction: 4 })) // same axis, same sign: merged
    hook.emit('wheel', wheel(1020, 1)) // vertical: separate
    hook.emit('wheel', wheel(1030, -1)) // opposite sign: separate
    hook.emit('wheel', wheel(1040, 0)) // a sub-notch step goes with anything
    hook.emit('wheel', wheel(1045, -1))
    const raw = t.collect()
    expect(raw.scrolls!.map((s) => [s.dx, s.dy])).toEqual([
      [-3, 0],
      [0, 1],
      [0, -2]
    ])
  })

  it('a sub-notch or malformed rotation is stored as 0 notches (still scrolling)', () => {
    const { hook, t } = start()
    hook.emit('wheel', wheel(1000, 0))
    hook.emit('wheel', wheel(1100, Number.NaN))
    hook.emit('wheel', { time: 1200, x: 200, y: 100 })
    const raw = t.collect()
    expect(raw.scrolls!.map((s) => [s.dx, s.dy])).toEqual([
      [0, 0],
      [0, 0],
      [0, 0]
    ])
  })

  it('drops Ctrl+wheel and Meta+wheel (app zoom) and a wheel over the toolbar, but reports activity for every wheel event', () => {
    const onActivity = vi.fn()
    const { hook, t } = start({ onActivity })
    hook.emit('wheel', wheel(1000, 1, { ctrlKey: true }))
    hook.emit('wheel', wheel(1100, 1, { metaKey: true }))
    hook.emit('wheel', wheel(1200, 1, { x: 1000, y: 900 })) // (500, 450): the toolbar
    hook.emit('wheel', wheel(1300, 1))
    expect(onActivity).toHaveBeenCalledTimes(4)
    const raw = t.collect()
    expect(raw.scrolls).toHaveLength(1)
    expect(raw.scrolls![0]).toMatchObject({ x: 100, y: 50, dy: 1 })
  })

  it('stores no scrolling for a keys-only capture, but still reports activity', () => {
    const onActivity = vi.fn()
    const { hook, t } = start({ display: null, onActivity })
    hook.emit('wheel', wheel(1000, 1))
    expect(onActivity).toHaveBeenCalledTimes(1)
    expect(t.collect().scrolls).toEqual([])
  })

  it('records scrolling in global DIP for a window whose position is known', () => {
    const { hook, t } = start({ display: null, global: true })
    hook.emit('wheel', wheel(1000, -1, { x: 4000, y: 2000 }))
    expect(t.collect().scrolls!.map((s) => [s.x, s.y, s.dy])).toEqual([[2000, 1000, -1]])
  })

  it('snapshots and start() reset the scrolls; a checkpoint keeps them', () => {
    const { hook, t } = start()
    hook.emit('wheel', wheel(1000, 2))
    expect(t.snapshot().scrolls).toHaveLength(1)
    hook.emit('wheel', wheel(1200, 1))
    expect(t.snapshot().scrolls).toHaveLength(2)
    t.start(options)
    expect(t.snapshot().scrolls).toEqual([])
    t.stop()
  })
})

describe('CursorTracker: button releases', () => {
  const start = () => {
    const hook = fakeHook()
    const t = new CursorTracker(() => hook.mod, false)
    t.start(options)
    return { hook, t }
  }

  it('pairs each stored press with its release (epoch ms), per button', () => {
    const { hook, t } = start()
    hook.emit('mousedown', { time: 1000, x: 200, y: 100, button: 1 })
    hook.emit('mousedown', { time: 1050, x: 300, y: 100, button: 2 })
    hook.emit('mouseup', { time: 1080, x: 300, y: 100, button: 1 })
    hook.emit('mouseup', { time: 1500, x: 300, y: 100, button: 2 })
    hook.emit('mousedown', { time: 2000, x: 200, y: 100, button: 1 }) // never released
    const raw = t.collect()
    expect(raw.clicks).toHaveLength(3)
    expect(raw.clicks[0].up! - raw.clicks[0].at).toBe(80)
    expect(raw.clicks[1].up! - raw.clicks[1].at).toBe(450)
    expect(raw.clicks[2].up).toBeUndefined()
    expect('up' in raw.clicks[2]).toBe(false)
  })

  it('a release after a dropped toolbar press pairs with nothing, not with an earlier click', () => {
    const { hook, t } = start()
    hook.emit('mousedown', { time: 1000, x: 200, y: 100, button: 1 })
    hook.emit('mousedown', { time: 1100, x: 1000, y: 900, button: 1 }) // the toolbar: dropped (its release was missed)
    hook.emit('mouseup', { time: 1200, x: 1000, y: 900, button: 1 })
    hook.emit('mouseup', { time: 1300, x: 1000, y: 900, button: 1 }) // a stray second release
    const raw = t.collect()
    expect(raw.clicks).toHaveLength(1)
    expect(raw.clicks[0].up).toBeUndefined()
  })

  it('a release without any press, or of another button, pairs with nothing', () => {
    const { hook, t } = start()
    hook.emit('mouseup', { time: 900, x: 200, y: 100, button: 1 })
    hook.emit('mousedown', { time: 1000, x: 200, y: 100, button: 1 })
    hook.emit('mouseup', { time: 1100, x: 200, y: 100, button: 3 })
    const raw = t.collect()
    expect(raw.clicks[0].up).toBeUndefined()
  })

  it('stores no presses or releases for a keys-only capture', () => {
    const hook = fakeHook()
    const t = new CursorTracker(() => hook.mod, false)
    t.start({ ...options, display: null })
    hook.emit('mousedown', { time: 1000, x: 200, y: 100, button: 1 })
    hook.emit('mouseup', { time: 1100, x: 200, y: 100, button: 1 })
    expect(t.collect().clicks).toEqual([])
  })

  it('stop() removes the release and wheel listeners with the others', () => {
    const emitter = new EventEmitter()
    const mod = {
      uIOhook: {
        on: (event: string, cb: (...a: unknown[]) => void) => emitter.on(event, cb),
        removeAllListeners: (event?: string) => emitter.removeAllListeners(event),
        start: () => undefined,
        stop: () => undefined
      }
    } as unknown as HookModule
    const t = new CursorTracker(() => mod, false)
    t.start(options)
    expect(emitter.listenerCount('mouseup')).toBe(1)
    expect(emitter.listenerCount('wheel')).toBe(1)
    t.stop()
    expect(emitter.eventNames()).toEqual([])
  })

  it('releases and scrolls go through buildCursorTrack on the pause-adjusted clock', () => {
    const { hook, t } = start()
    hook.emit('mousedown', { time: 1000, x: 200, y: 100, button: 1 })
    hook.emit('mouseup', { time: 1250, x: 200, y: 100, button: 1 })
    hook.emit('wheel', { time: 1500, x: 600, y: 300, rotation: 3, amount: 3, direction: 3, ctrlKey: false, metaKey: false })
    const raw = t.collect()
    const startedAt = raw.clicks[0].at - 1000
    const track = buildCursorTrack(raw, { startedAt, pauses: [], duration: 5, region: null })
    expect(track.clicks[0].t).toBeCloseTo(1, 9)
    expect(track.clicks[0].up).toBeCloseTo(1.25, 9)
    expect(track.scrolls).toEqual([{ t: 1.5, x: 0.3, y: 0.3, dx: 0, dy: 3 }])
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

describe('CursorTracker: own windows are judged at the time of the event', () => {
  afterEach(() => vi.useRealTimers())

  it('isOwnPoint gets the epoch time the hook clock gives the event, not its delivery time', () => {
    vi.useFakeTimers({ toFake: ['Date'] })
    const T = 1_700_000_000_000
    vi.setSystemTime(T)
    const hook = fakeHook()
    const seen: { p: { x: number; y: number }; at: number }[] = []
    const t = new CursorTracker(() => hook.mod, false)
    t.start({
      ...options,
      isOwnPoint: (p, at) => {
        seen.push({ p, at })
        return false
      }
    })
    // Delivered at once: the hook clock's origin.
    hook.emit('mousedown', { time: 5000, x: 200, y: 100, button: 1 })
    // Happened 100 ms later, delivered 300 ms later (a late batch).
    vi.setSystemTime(T + 300)
    hook.emit('mousedown', { time: 5100, x: 200, y: 100, button: 1 })
    hook.emit('wheel', { time: 5150, x: 200, y: 100, rotation: 1, amount: 3, direction: 3, ctrlKey: false, metaKey: false })
    expect(seen.map((s) => s.at - T)).toHaveLength(3)
    expect(Math.abs(seen[0].at - T)).toBeLessThanOrEqual(5)
    expect(Math.abs(seen[1].at - (T + 100))).toBeLessThanOrEqual(5)
    expect(Math.abs(seen[2].at - (T + 150))).toBeLessThanOrEqual(5)
    expect(seen[0].p).toEqual({ x: 100, y: 50 })
    t.collect()
  })

  it('a click and a wheel where a window was when they happened are dropped, even when delivered after it left', () => {
    vi.useFakeTimers({ toFake: ['Date'] })
    const T = 1_700_000_000_000
    vi.setSystemTime(T)
    const hook = fakeHook()
    const t = new CursorTracker(() => hook.mod, false)
    // The notes covered everything until T + 50.
    t.start({ ...options, isOwnPoint: (_p, at) => at < T + 50 })
    hook.emit('mousedown', { time: 5000, x: 200, y: 100, button: 1 })
    vi.setSystemTime(T + 400)
    // Happened at T + 20 (over the notes), delivered at T + 400 (after they hid).
    hook.emit('mousedown', { time: 5020, x: 300, y: 100, button: 1 })
    hook.emit('wheel', { time: 5030, x: 300, y: 100, rotation: 1, amount: 3, direction: 3, ctrlKey: false, metaKey: false })
    // Happened at T + 200: content.
    hook.emit('mousedown', { time: 5200, x: 400, y: 100, button: 1 })
    hook.emit('wheel', { time: 5210, x: 400, y: 100, rotation: 1, amount: 3, direction: 3, ctrlKey: false, metaKey: false })
    const raw = t.collect()
    // Only the events at T + 200 (400 physical px = 200 DIP); the first click, at T, was over the notes too.
    expect(raw.clicks.map((c) => c.x)).toEqual([200])
    expect(raw.scrolls!.map((s) => s.x)).toEqual([200])
  })
})
