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

type HookModule = {
  uIOhook: {
    on(event: 'mousedown' | 'mousemove', cb: (e: HookMouseEvent) => void): void
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

const HOOK_EVENTS = ['mousedown', 'mousemove', 'keydown', 'keyup']
const BUTTONS: Record<number, ClickEvent['button']> = { 1: 'left', 2: 'right', 3: 'middle' }

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
  /** The captured display; null for window captures (positions are then not recorded). */
  display: { bounds: Rectangle; scaleFactor: number } | null
  /** Record shortcut keystrokes for the keystroke overlay. */
  captureKeys: boolean
  /** True for points over the app's own windows (the toolbar): such clicks are dropped. */
  isOwnPoint: (p: Point) => boolean
  /** Shortcut labels never recorded (the app's own stop shortcut). */
  ignoreKeys: string[]
}

/**
 * Captures the cursor, clicks and shortcut keystrokes while recording, stamped in
 * epoch ms. Pause handling and conversion to the video timeline happen later
 * (buildCursorTrack), so the same data can be rebuilt after a crash.
 */
export class CursorTracker {
  private opts: TrackerOptions | null = null
  private timer: NodeJS.Timeout | null = null
  private paused = false
  private clock = new HookClock()
  private samples: { at: number; x: number; y: number }[] = []
  private moves: { tick: number; x: number; y: number }[] = []
  private clicks: { tick: number; x: number; y: number; button: ClickEvent['button'] }[] = []
  private keys: { tick: number; label: string }[] = []
  private hookStarted = false

  get active(): boolean {
    return this.opts !== null
  }

  start(opts: TrackerOptions): void {
    this.stop()
    this.opts = opts
    this.paused = false
    this.clock = new HookClock()
    this.samples = []
    this.moves = []
    this.clicks = []
    this.keys = []
    if (opts.display) {
      const p = screen.getCursorScreenPoint()
      this.samples.push({ at: Date.now(), x: p.x, y: p.y })
      if (POLL_CURSOR) {
        this.timer = setInterval(() => {
          if (this.paused) return
          const c = screen.getCursorScreenPoint()
          this.samples.push({ at: Date.now(), x: c.x, y: c.y })
        }, 1000 / 60)
      }
    }
    if (opts.display || opts.captureKeys) this.startHook(opts)
  }

  private startHook(opts: TrackerOptions): void {
    const mod = loadHook()
    if (!mod) return
    const { uIOhook } = mod
    for (const e of HOOK_EVENTS) uIOhook.removeAllListeners(e)
    const observe = (time: number): number => this.clock.observe(time, Date.now())
    if (opts.display) {
      uIOhook.on('mousedown', (e) => {
        const tick = observe(e.time)
        if (this.paused) return
        const p = hookPointToDip(e)
        if (opts.isOwnPoint(p)) return
        this.clicks.push({ tick, x: p.x, y: p.y, button: BUTTONS[e.button as number] ?? 'left' })
      })
      if (!POLL_CURSOR) {
        uIOhook.on('mousemove', (e) => {
          const tick = observe(e.time)
          if (this.paused) return
          const p = hookPointToDip(e)
          const last = this.moves[this.moves.length - 1]
          // At most one stored position per 8 ms, always the latest one.
          if (last && tick - last.tick < 8) Object.assign(last, { x: p.x, y: p.y })
          else this.moves.push({ tick, x: p.x, y: p.y })
        })
      }
    }
    if (opts.captureKeys) {
      const filter = new KeystrokeFilter(new Set(opts.ignoreKeys))
      uIOhook.on('keydown', (e) => {
        const tick = observe(e.time)
        const label = filter.keydown(e)
        if (label && !this.paused) this.keys.push({ tick, label })
      })
      uIOhook.on('keyup', (e) => {
        observe(e.time)
        filter.keyup(e)
      })
    }
    try {
      uIOhook.start()
      this.hookStarted = true
    } catch (err) {
      console.warn('Failed to start the input hook:', err)
      for (const e of HOOK_EVENTS) uIOhook.removeAllListeners(e)
    }
  }

  setPaused(paused: boolean): void {
    this.paused = paused
  }

  stop(): void {
    if (this.timer) clearInterval(this.timer)
    this.timer = null
    if (this.hookStarted) {
      const mod = loadHook()
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
    this.stop()
    const display = this.opts?.display ?? null
    const at = (tick: number): number => this.clock.toEpoch(tick)
    const track: RawTrack = {
      samples: [...this.samples, ...this.moves.map((m) => ({ at: at(m.tick), x: m.x, y: m.y }))].sort((a, b) => a.at - b.at),
      clicks: this.clicks.map((c) => ({ at: at(c.tick), x: c.x, y: c.y, button: c.button })),
      keys: this.keys.map((k) => ({ at: at(k.tick), label: k.label })),
      bounds: display ? { ...display.bounds } : null,
      scale: display?.scaleFactor ?? 1
    }
    this.opts = null
    return track
  }
}
