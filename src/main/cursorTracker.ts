import { screen, type Point, type Rectangle } from 'electron'
import type { ClickEvent } from '../shared/types'
import { HookClock } from './recording/hookClock'
import { KeystrokeFilter, type KeyInput } from './recording/keystrokes'
import type { RawTrack } from './recording/trackMath'

interface HookMouseEvent {
  time: number
  x: number
  y: number
  button: unknown
}

interface HookKeyEvent extends KeyInput {
  time: number
}

/** uiohook's wheel event: `rotation` is signed notches (+ = down / right), `direction` 3 = vertical, 4 = horizontal. */
interface HookWheelEvent {
  time: number
  x: number
  y: number
  rotation: number
  amount: number
  direction: number
  ctrlKey: boolean
  metaKey: boolean
}

export type HookModule = {
  uIOhook: {
    on(event: 'mousedown' | 'mouseup' | 'mousemove', cb: (e: HookMouseEvent) => void): void
    on(event: 'wheel', cb: (e: HookWheelEvent) => void): void
    on(event: 'keydown' | 'keyup', cb: (e: HookKeyEvent) => void): void
    removeAllListeners(event?: string): void
    start(): void
    stop(): void
  }
}

let hook: HookModule | null | undefined

/** Loads the optional native global input hook; returns null when unavailable. */
function loadHook(): HookModule | null {
  if (hook !== undefined) return hook
  try {
    // eslint-disable-next-line @typescript-eslint/no-require-imports
    hook = require('uiohook-napi') as HookModule
  } catch (err) {
    console.warn('uiohook-napi unavailable, click and keystroke capture disabled:', err)
    hook = null
  }
  return hook
}

const HOOK_EVENTS = ['mousedown', 'mouseup', 'mousemove', 'wheel', 'keydown', 'keyup']
/** How often the cursor is checked for movement when only auto-pause needs to know (ms). */
const ACTIVITY_POLL_MS = 250
const BUTTONS: Record<number, ClickEvent['button']> = { 1: 'left', 2: 'right', 3: 'middle' }
/** Wheel events less than this far apart (hook ms) on the same axis are stored as one. */
const WHEEL_MERGE_MS = 50
/** uiohook's horizontal wheel direction (WheelDirection.HORIZONTAL). */
const WHEEL_HORIZONTAL = 4

/**
 * Where cursor positions come from. Windows (and macOS) report the cursor reliably
 * through polling. On Linux/X11 the polled position is frozen while no app window
 * has focus, so positions come from the hook's motion events instead.
 */
const POLL_CURSOR = process.platform !== 'linux'

/** Hook coordinates are physical pixels; Electron's DIP conversion handles mixed-DPI setups. */
function hookPointToDip(e: { x: number; y: number }): Point {
  if (process.platform === 'win32' || process.platform === 'linux') return screen.screenToDipPoint({ x: e.x, y: e.y })
  return screen.getCursorScreenPoint()
}

export interface TrackerOptions {
  /** The captured display; null for window captures. */
  display: { bounds: Rectangle; scaleFactor: number } | null
  /**
   * Window captures whose position on screen is known (native window capture, or a window
   * watcher): record the cursor and clicks in global DIP screen coordinates, mapped into
   * the window when the recording is finalised. Without it (and without a display) only
   * keystrokes are recorded.
   */
  global?: boolean
  /**
   * Record keyboard activity: shortcut keystrokes for the keystroke overlay, and when typing
   * happened (typing bursts for auto zoom). Which keys were typed is never recorded.
   */
  captureKeys: boolean
  /**
   * Called on any mouse or keyboard input (auto-pause), also while paused. Nothing is
   * stored for it. Keep it cheap: it runs for every input event.
   */
  onActivity?: () => void
  /**
   * True for points over the app's own windows (the toolbar, the speaker notes): such clicks and
   * wheel events are dropped. `at` is when the event happened (epoch ms): hook events arrive late,
   * and a window may have moved or hidden since.
   */
  isOwnPoint: (p: Point, at: number) => boolean
  /** Shortcut labels never recorded (the app's own hotkeys). */
  ignoreKeys: string[]
}

/**
 * Captures the cursor, clicks and shortcut keystrokes while recording, stamped in
 * epoch ms. Pause handling and conversion to the video timeline happen later
 * (buildCursorTrack), so the same data can be rebuilt after a crash.
 */
export class CursorTracker {
  /** `loadHookModule` and `pollCursor` are injectable so tests can drive the tracker with synthetic input. */
  constructor(
    private readonly loadHookModule: () => HookModule | null = loadHook,
    private readonly pollCursor: boolean = POLL_CURSOR
  ) {}

  private opts: TrackerOptions | null = null
  private timer: NodeJS.Timeout | null = null
  private paused = false
  private clock = new HookClock()
  private samples: { at: number; x: number; y: number }[] = []
  private moves: { tick: number; x: number; y: number }[] = []
  private clicks: { tick: number; x: number; y: number; button: ClickEvent['button']; upTick?: number }[] = []
  /** Index in `clicks` of the stored press of each button (1–3) not released yet. */
  private pressed = new Map<number, number>()
  /** Wheel input: signed notches on one axis per event (merged within WHEEL_MERGE_MS). */
  private scrolls: { tick: number; x: number; y: number; horizontal: boolean; notches: number }[] = []
  private keys: { tick: number; label: string }[] = []
  /** Hook ticks of typing key presses (only the instants, never the keys). */
  private typing: number[] = []
  /** "Zoom here" hotkey presses, epoch ms. */
  private marks: number[] = []
  private keyFilter: KeystrokeFilter | null = null
  /** Where the cursor was at the last poll (movement means activity). */
  private seen: { x: number; y: number } | null = null
  private activityTimer: NodeJS.Timeout | null = null
  /** Time of the last poll that found the cursor where the last stored sample is. */
  private stillSince: number | null = null
  private hookStarted = false

  get active(): boolean {
    return this.opts !== null
  }

  /** The global input hook is running (without it keyboard input cannot be seen). */
  get hookRunning(): boolean {
    return this.hookStarted
  }

  /** Cursor positions and clicks are recorded (a display, or global coordinates for a window). */
  private static tracksPointer(opts: TrackerOptions): boolean {
    return opts.display !== null || opts.global === true
  }

  start(opts: TrackerOptions): void {
    this.halt()
    this.opts = opts
    this.paused = false
    this.clock = new HookClock()
    this.samples = []
    this.moves = []
    this.clicks = []
    this.pressed = new Map()
    this.scrolls = []
    this.keys = []
    this.typing = []
    this.marks = []
    this.keyFilter = null
    this.stillSince = null
    this.seen = null
    const pointer = CursorTracker.tracksPointer(opts)
    if (pointer) {
      const p = screen.getCursorScreenPoint()
      this.samples.push({ at: Date.now(), x: p.x, y: p.y })
      this.seen = { x: p.x, y: p.y }
      if (this.pollCursor) this.timer = setInterval(() => this.poll(), 1000 / 60)
    } else if (opts.onActivity && this.pollCursor) {
      // Nothing to record, but auto-pause needs to see the mouse move: a slow check is enough.
      this.seen = screen.getCursorScreenPoint()
      this.activityTimer = setInterval(() => this.checkMoved(), ACTIVITY_POLL_MS)
    }
    if (pointer || opts.captureKeys || opts.onActivity) this.startHook(opts)
  }

  /** Remembers a "zoom here" hotkey press (epoch ms); pause-adjusted when the track is built. */
  mark(at = Date.now()): void {
    if (this.opts) this.marks.push(at)
  }

  /** Reads the cursor position; a change since the last check is reported as activity. */
  private checkMoved(): { x: number; y: number } {
    const c = screen.getCursorScreenPoint()
    const s = this.seen
    if (!s || s.x !== c.x || s.y !== c.y) {
      this.seen = { x: c.x, y: c.y }
      if (s) this.opts?.onActivity?.()
    }
    return c
  }

  /**
   * Stores a position only when the cursor moved: a still cursor adds nothing, so long
   * idle stretches cost no memory and the track stays small. When it moves again, the
   * last poll that still saw the old position is stored first, so interpolation between
   * the samples is exactly what polling every frame would have given.
   */
  private poll(at = Date.now()): void {
    if (this.paused) {
      // Auto-pause resumes on the next movement; otherwise a paused recording reads nothing.
      if (this.opts?.onActivity) this.checkMoved()
      return
    }
    const c = this.opts?.onActivity ? this.checkMoved() : screen.getCursorScreenPoint()
    const last = this.samples[this.samples.length - 1]
    if (last && last.x === c.x && last.y === c.y) {
      this.stillSince = at
      return
    }
    this.flushStill()
    this.samples.push({ at, x: c.x, y: c.y })
  }

  /** Stores the end of a still period (the last poll that saw the cursor unmoved). */
  private flushStill(): void {
    const last = this.samples[this.samples.length - 1]
    if (last && this.stillSince !== null && this.stillSince > last.at) this.samples.push({ at: this.stillSince, x: last.x, y: last.y })
    this.stillSince = null
  }

  private startHook(opts: TrackerOptions): void {
    const mod = this.loadHookModule()
    if (!mod) return
    const { uIOhook } = mod
    for (const e of HOOK_EVENTS) uIOhook.removeAllListeners(e)
    const observe = (time: number): number => this.clock.observe(time, Date.now())
    const activity = opts.onActivity ?? null
    const pointer = CursorTracker.tracksPointer(opts)
    // Hook events arrive in delayed batches, so pauses are applied later by their
    // precise times (buildCursorTrack) rather than by the state at delivery.
    if (pointer || activity) {
      uIOhook.on('mousedown', (e) => {
        activity?.()
        if (!pointer) return
        const tick = observe(e.time)
        const p = hookPointToDip(e)
        const button = e.button as number
        // A new press of this button: an earlier unreleased one can no longer pair.
        this.pressed.delete(button)
        if (opts.isOwnPoint(p, this.clock.toEpoch(tick))) return
        if (BUTTONS[button]) this.pressed.set(button, this.clicks.length)
        this.clicks.push({ tick, x: p.x, y: p.y, button: BUTTONS[button] ?? 'left' })
      })
      // The wheel also counts as activity (auto-pause), whether or not it is stored.
      uIOhook.on('wheel', (e) => {
        activity?.()
        if (!pointer) return
        // Ctrl/Meta + wheel zooms the app under the cursor; it does not scroll.
        if (e.ctrlKey || e.metaKey) return
        const tick = observe(e.time)
        const p = hookPointToDip(e)
        if (opts.isOwnPoint(p, this.clock.toEpoch(tick))) return
        this.addWheel(tick, p, Number.isFinite(e.rotation) ? e.rotation : 0, e.direction === WHEEL_HORIZONTAL)
      })
    }
    if (pointer) {
      uIOhook.on('mouseup', (e) => {
        const tick = observe(e.time)
        const button = e.button as number
        const i = this.pressed.get(button)
        if (i === undefined) return
        this.pressed.delete(button)
        if (this.clicks[i]) this.clicks[i].upTick = tick
      })
    }
    // Where the cursor is polled (Windows), motion events are not needed: polling sees movement.
    if (!this.pollCursor && (pointer || activity)) {
      uIOhook.on('mousemove', (e) => {
        activity?.()
        if (!pointer) return
        const tick = observe(e.time)
        const p = hookPointToDip(e)
        const last = this.moves[this.moves.length - 1]
        // At most one stored position per 8 ms, always the latest one.
        if (last && tick - last.tick < 8) Object.assign(last, { x: p.x, y: p.y })
        else this.moves.push({ tick, x: p.x, y: p.y })
      })
    }
    if (opts.captureKeys) {
      const filter = new KeystrokeFilter(new Set(opts.ignoreKeys))
      this.keyFilter = filter
      uIOhook.on('keydown', (e) => {
        activity?.()
        const tick = observe(e.time)
        const { label, typing } = filter.classify(e, tick)
        if (label) this.keys.push({ tick, label })
        // Backspace, Enter, … are both: a keystroke to show and part of typing.
        if (typing) this.typing.push(tick)
      })
      uIOhook.on('keyup', (e) => {
        observe(e.time)
        filter.keyup(e)
      })
    } else if (activity) {
      // Keyboard activity keeps a recording from auto-pausing; nothing about it is stored.
      uIOhook.on('keydown', () => activity())
    }
    try {
      uIOhook.start()
      this.hookStarted = true
    } catch (err) {
      console.warn('Failed to start the input hook:', err)
      for (const e of HOOK_EVENTS) uIOhook.removeAllListeners(e)
    }
  }

  /**
   * Stores wheel notches at `tick`: merged into the last stored event when that one is less
   * than WHEEL_MERGE_MS older, on the same axis and not scrolling the other way (0, a
   * sub-notch step, goes with anything); the merged event keeps its time and takes the new
   * position.
   */
  private addWheel(tick: number, p: Point, notches: number, horizontal: boolean): void {
    const last = this.scrolls[this.scrolls.length - 1]
    if (last && tick - last.tick < WHEEL_MERGE_MS && last.horizontal === horizontal && last.notches * notches >= 0) {
      Object.assign(last, { x: p.x, y: p.y, notches: last.notches + notches })
      return
    }
    this.scrolls.push({ tick, x: p.x, y: p.y, horizontal, notches })
  }

  /** Pauses cursor polling (hook events are filtered by time later). */
  setPaused(paused: boolean): void {
    // A still period ends at the pause, as it did when every poll was stored.
    if (paused) this.flushStill()
    this.paused = paused
    // Keyups can be missed while paused (the user may lock the PC); start clean.
    this.keyFilter?.reset()
  }

  /** Stops tracking and discards what was captured. */
  stop(): void {
    this.halt()
    this.opts = null
  }

  private halt(): void {
    if (this.timer) clearInterval(this.timer)
    this.timer = null
    if (this.activityTimer) clearInterval(this.activityTimer)
    this.activityTimer = null
    if (this.hookStarted) {
      const mod = this.loadHookModule()
      if (mod) {
        for (const e of HOOK_EVENTS) mod.uIOhook.removeAllListeners(e)
        try {
          mod.uIOhook.stop()
        } catch (err) {
          console.warn('Failed to stop the input hook:', err)
        }
      }
      this.hookStarted = false
    }
  }

  /** Stops tracking and returns everything captured (epoch ms, DIP coordinates). */
  collect(): RawTrack {
    this.halt()
    this.flushStill()
    const track = this.snapshot()
    this.opts = null
    return track
  }

  /** Everything captured so far (epoch ms, DIP coordinates), while tracking goes on. */
  snapshot(): RawTrack {
    const display = this.opts?.display ?? null
    const at = (tick: number): number => this.clock.toEpoch(tick)
    const last = this.samples[this.samples.length - 1]
    // The still period so far, as flushStill() would end it now.
    const still = last && this.stillSince !== null && this.stillSince > last.at ? [{ at: this.stillSince, x: last.x, y: last.y }] : []
    return {
      samples: [...this.samples, ...still, ...this.moves.map((m) => ({ at: at(m.tick), x: m.x, y: m.y }))].sort((a, b) => a.at - b.at),
      clicks: this.clicks.map((c) => ({ at: at(c.tick), x: c.x, y: c.y, button: c.button, ...(c.upTick !== undefined ? { up: at(c.upTick) } : {}) })),
      scrolls: this.scrolls.map((s) => ({ at: at(s.tick), x: s.x, y: s.y, dx: s.horizontal ? s.notches : 0, dy: s.horizontal ? 0 : s.notches })),
      keys: this.keys.map((k) => ({ at: at(k.tick), label: k.label })),
      typing: this.typing.map(at),
      marks: [...this.marks],
      bounds: display ? { ...display.bounds } : null,
      scale: display?.scaleFactor ?? 1
    }
  }
}
