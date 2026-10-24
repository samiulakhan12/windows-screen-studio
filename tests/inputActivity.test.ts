import { EventEmitter } from 'node:events'
import { afterEach, describe, expect, it, vi } from 'vitest'

const cursor = vi.hoisted(() => ({ x: 100, y: 50 }))
vi.mock('electron', () => ({
  screen: {
    getCursorScreenPoint: () => ({ ...cursor }),
    screenToDipPoint: (p: { x: number; y: number }) => ({ x: p.x / 2, y: p.y / 2 })
  }
}))

import { CursorTracker, type HookModule } from '../src/main/cursorTracker'
import { isTypingKey, KeystrokeFilter } from '../src/main/recording/keystrokes'
import { buildCursorTrack, clampTrack, typingBursts, TYPING_GAP_MS, type RawTrack } from '../src/main/recording/trackMath'
import { inputEvents } from '../src/main/projects'

function fakeHook() {
  const emitter = new EventEmitter()
  const mod = {
    uIOhook: {
      on: (event: string, cb: (...a: unknown[]) => void) => emitter.on(event, cb),
      removeAllListeners: (event?: string) => emitter.removeAllListeners(event),
      start: () => undefined,
      stop: () => undefined
    }
  } as unknown as HookModule
  return { mod, emit: (event: string, e: object) => emitter.emit(event, e), listeners: (event: string) => emitter.listenerCount(event) }
}

const display = { bounds: { x: 0, y: 0, width: 1000, height: 500 }, scaleFactor: 2 }
const base = { display, captureKeys: true, isOwnPoint: () => false, ignoreKeys: ['Ctrl + Shift + 2', 'F9'] }
const key = (keycode: number, mods: Record<string, boolean> = {}, time = 0) => ({ time, keycode, ctrlKey: false, altKey: false, shiftKey: false, metaKey: false, ...mods })

const T0 = 1_700_000_000_000
const raw = (over: Partial<RawTrack>): RawTrack => ({ samples: [], clicks: [], keys: [], bounds: { x: 0, y: 0, width: 1000, height: 500 }, scale: 1, ...over })

describe('typing keys', () => {
  it('counts characters and editing keys without Ctrl, Alt or Win as typing', () => {
    expect(isTypingKey(key(30))).toBe(true) // a
    expect(isTypingKey(key(30, { shiftKey: true }))).toBe(true) // A
    expect(isTypingKey(key(57))).toBe(true) // space
    expect(isTypingKey(key(14))).toBe(true) // Backspace
    expect(isTypingKey(key(28))).toBe(true) // Enter
    expect(isTypingKey(key(79))).toBe(true) // Num 1
    expect(isTypingKey(key(30, { ctrlKey: true }))).toBe(false) // Ctrl + A
    expect(isTypingKey(key(30, { metaKey: true }))).toBe(false)
    expect(isTypingKey(key(42, { shiftKey: true }))).toBe(false) // Shift alone
    expect(isTypingKey(key(1))).toBe(false) // Esc
    expect(isTypingKey(key(59))).toBe(false) // F1
    expect(isTypingKey(key(57416))).toBe(false) // ↑
    expect(isTypingKey(key(3666))).toBe(false) // Insert
    // AltGr + Q types "@" on German layouts.
    expect(isTypingKey(key(16, { ctrlKey: true, altKey: true }), true)).toBe(true)
  })

  it('the filter reports each new typing press once, never auto-repeats', () => {
    const f = new KeystrokeFilter()
    expect(f.classify(key(30), 0)).toEqual({ label: null, typing: true })
    expect(f.classify(key(30), 500)).toEqual({ label: null, typing: false }) // held: auto-repeat
    f.keyup(key(30))
    expect(f.classify(key(14), 600)).toEqual({ label: 'Backspace', typing: true })
    expect(f.classify(key(31, { ctrlKey: true }), 700)).toEqual({ label: 'Ctrl + S', typing: false })
    // keydown() keeps returning the label only.
    expect(f.keydown(key(1), 800)).toBe('Esc')
  })
})

describe('typingBursts', () => {
  it('groups close presses, drops short runs and presses made while paused', () => {
    const presses = [0, 200, 400, 600, /* gap */ 5000, 5100, /* too few */ 9000, 9300, 9600, 9900, 10_100]
    expect(typingBursts(presses.map((p) => T0 + p), [])).toEqual([
      { from: T0, to: T0 + 600 },
      { from: T0 + 9000, to: T0 + 10_100 }
    ])
    // A pause splits a burst even when the presses are close; presses inside it are not recorded.
    const pauses = [{ from: T0 + 9400, to: T0 + 9800 }]
    expect(typingBursts([9000, 9100, 9200, 9300, 9500, 9900, 10_000, 10_100].map((p) => T0 + p), pauses)).toEqual([
      { from: T0 + 9000, to: T0 + 9300 },
      { from: T0 + 9900, to: T0 + 10_100 }
    ])
    expect(typingBursts([T0 + 2 * TYPING_GAP_MS, T0, T0 + TYPING_GAP_MS], [])).toEqual([{ from: T0, to: T0 + 2 * TYPING_GAP_MS }])
    expect(typingBursts([], [])).toEqual([])
  })
})

describe('marks and typing in the cursor track', () => {
  it('are pause-adjusted like clicks and keys, and kept inside the recording', () => {
    const pauses = [{ from: T0 + 2000, to: T0 + 5000 }]
    const track = buildCursorTrack(
      raw({
        clicks: [{ at: T0 + 6000, x: 500, y: 250, button: 'left' }],
        marks: [T0 - 500, T0 + 1000, T0 + 3000 /* paused */, T0 + 6000, T0 + 30_000 /* after the end */],
        typing: [T0 - 900, T0 - 700, T0 - 400, T0 + 100, /* burst across the start */ T0 + 1700, T0 + 1800, T0 + 1900, T0 + 5200, T0 + 5400, T0 + 5600]
      }),
      { startedAt: T0, pauses, duration: 10, region: null }
    )
    expect(track.clicks.map((c) => c.t)).toEqual([3])
    expect(track.marks).toEqual([{ t: 1 }, { t: 3 }])
    // The burst through the start is cut at 0; typing before and after the pause are two bursts.
    expect(track.typing).toEqual([
      { t: 0, end: 0.1 },
      { t: 1.7, end: 1.9 },
      { t: 2.2, end: expect.closeTo(2.6, 9) }
    ])
  })

  it('stay with tracks that cannot place the cursor (window without position data)', () => {
    const track = buildCursorTrack(raw({ bounds: null, marks: [T0 + 500], typing: [T0, T0 + 100, T0 + 200] }), {
      startedAt: T0,
      pauses: [],
      duration: 5,
      region: null
    })
    expect(track.valid).toBe(false)
    expect(track.marks).toEqual([{ t: 0.5 }])
    expect(track.typing).toEqual([{ t: 0, end: 0.2 }])
  })

  it('are absent when nothing captured them (older code paths), and clamped to the final duration', () => {
    const plain = buildCursorTrack(raw({}), { startedAt: T0, pauses: [], duration: 5, region: null })
    expect('marks' in plain).toBe(false)
    expect('typing' in plain).toBe(false)
    const clamped = clampTrack({ ...plain, marks: [{ t: 1 }, { t: 4.9 }], typing: [{ t: 1, end: 2 }, { t: 3.5, end: 4.8 }, { t: 4.7, end: 4.9 }] }, 4)
    expect(clamped.marks).toEqual([{ t: 1 }])
    expect(clamped.typing).toEqual([
      { t: 1, end: 2 },
      { t: 3.5, end: 4 }
    ])
    expect('marks' in clampTrack(plain, 4)).toBe(false)
  })

  it('are read back from cursor.json, validated (they survive migrateCursor)', () => {
    expect(inputEvents({ marks: [{ t: 1 }, { t: 'x' }, null, { t: 2, extra: 1 }], typing: [{ t: 1, end: 2 }, { t: 3, end: 2 }, { t: 1 }] })).toEqual({
      marks: [{ t: 1 }, { t: 2 }],
      typing: [{ t: 1, end: 2 }]
    })
    expect(inputEvents({})).toEqual({})
    expect(inputEvents(undefined)).toEqual({})
  })
})

describe('CursorTracker: marks, typing and activity', () => {
  afterEach(() => {
    vi.useRealTimers()
  })

  it('records typing instants (never the keys) and marks; not the app hotkeys', () => {
    const hook = fakeHook()
    const t = new CursorTracker(() => hook.mod, false)
    t.start(base)
    for (const [i, code] of [30, 48, 46, 57, 14].entries()) {
      hook.emit('keydown', key(code, {}, 1000 + i * 100))
      hook.emit('keyup', key(code, {}, 1050 + i * 100))
    }
    hook.emit('keydown', key(67, {}, 2000)) // F9: an app hotkey, neither a keystroke nor typing
    hook.emit('keydown', key(31, { ctrlKey: true }, 2100)) // Ctrl + S: a shortcut, not typing
    t.mark(T0 + 5)
    const r = t.collect()
    expect(r.typing).toHaveLength(5)
    expect(r.typing![4] - r.typing![0]).toBe(400)
    expect(r.keys.map((k) => k.label)).toEqual(['Backspace', 'Ctrl + S'])
    expect(r.marks).toEqual([T0 + 5])
    // Only numbers: nothing about which keys were typed.
    expect(r.typing!.every((v) => typeof v === 'number')).toBe(true)
  })

  it('records no keyboard data when keyboard activity is off, but still reports activity', () => {
    const hook = fakeHook()
    const t = new CursorTracker(() => hook.mod, false)
    const onActivity = vi.fn()
    t.start({ ...base, captureKeys: false, onActivity })
    hook.emit('keydown', key(30, {}, 10))
    hook.emit('keydown', key(31, { ctrlKey: true }, 20))
    expect(onActivity).toHaveBeenCalledTimes(2)
    const r = t.collect()
    expect(r.keys).toEqual([])
    expect(r.typing).toEqual([])
  })

  it('reports mouse and keyboard activity from the hook, also while paused', () => {
    const hook = fakeHook()
    const t = new CursorTracker(() => hook.mod, false)
    const onActivity = vi.fn()
    t.start({ ...base, onActivity })
    hook.emit('mousemove', { time: 1, x: 10, y: 10, button: 0 })
    hook.emit('mousedown', { time: 2, x: 10, y: 10, button: 1 })
    hook.emit('wheel', { time: 3, x: 10, y: 10, button: 0 })
    hook.emit('keydown', key(30, {}, 4))
    t.setPaused(true)
    hook.emit('mousemove', { time: 5, x: 20, y: 10, button: 0 })
    expect(onActivity).toHaveBeenCalledTimes(5)
    t.stop()
  })

  it('without auto-pause registers no extra listeners (no cost)', () => {
    const hook = fakeHook()
    const t = new CursorTracker(() => hook.mod, true)
    t.start(base)
    expect(hook.listeners('mousemove')).toBe(0)
    expect(hook.listeners('wheel')).toBe(0)
    t.stop()
  })

  it('polling sees the mouse move (Windows), also while paused, but stores nothing then', () => {
    vi.useFakeTimers({ now: T0 })
    Object.assign(cursor, { x: 100, y: 50 })
    const hook = fakeHook()
    const t = new CursorTracker(() => hook.mod, true)
    const onActivity = vi.fn()
    t.start({ ...base, onActivity })
    vi.advanceTimersByTime(500)
    expect(onActivity).not.toHaveBeenCalled()
    cursor.x = 120
    vi.advanceTimersByTime(20)
    expect(onActivity).toHaveBeenCalledTimes(1)
    t.setPaused(true)
    cursor.x = 140
    vi.advanceTimersByTime(20)
    expect(onActivity).toHaveBeenCalledTimes(2)
    const r = t.collect()
    expect(r.samples.map((s) => s.x)).not.toContain(140)
  })

  it('a window without position data is still watched for movement, slowly', () => {
    vi.useFakeTimers({ now: T0 })
    Object.assign(cursor, { x: 100, y: 50 })
    const t = new CursorTracker(() => null, true)
    const onActivity = vi.fn()
    t.start({ ...base, display: null, onActivity })
    cursor.y = 70
    vi.advanceTimersByTime(100)
    expect(onActivity).not.toHaveBeenCalled()
    vi.advanceTimersByTime(200)
    expect(onActivity).toHaveBeenCalledTimes(1)
    t.stop()
    cursor.y = 90
    vi.advanceTimersByTime(1000)
    expect(onActivity).toHaveBeenCalledTimes(1)
  })
})
