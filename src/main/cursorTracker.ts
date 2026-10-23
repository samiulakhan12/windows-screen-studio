import { screen, type Rectangle } from 'electron'
import type { ClickEvent, CursorSample, CursorTrack } from '../shared/types'

type HookModule = {
  uIOhook: {
    on(event: 'mousedown', cb: (e: { button: number }) => void): void
    removeAllListeners(event?: string): void
    start(): void
    stop(): void
  }
}

let hook: HookModule | null | undefined

/** Loads the optional native global-mouse hook; returns null when unavailable. */
function loadHook(): HookModule | null {
  if (hook !== undefined) return hook
  try {
    // eslint-disable-next-line @typescript-eslint/no-require-imports
    hook = require('uiohook-napi') as HookModule
  } catch (err) {
    console.warn('uiohook-napi unavailable, click tracking disabled:', err)
    hook = null
  }
  return hook
}

const BUTTONS: Record<number, ClickEvent['button']> = { 1: 'left', 2: 'right', 3: 'middle' }

/**
 * Samples the cursor at ~60 Hz while recording. Timestamps are recorded on the
 * shared epoch clock and converted to recording time (excluding pauses) at the end.
 */
export class CursorTracker {
  private bounds: Rectangle | null = null
  private timer: NodeJS.Timeout | null = null
  private raw: { at: number; x: number; y: number }[] = []
  private rawClicks: { at: number; x: number; y: number; button: ClickEvent['button'] }[] = []
  private pauses: { from: number; to: number }[] = []
  private pausedAt: number | null = null
  private hookStarted = false

  /** `displayId` is the captured display; window captures have none (track becomes invalid). */
  start(displayId: string | undefined): void {
    this.stop()
    this.raw = []
    this.rawClicks = []
    this.pauses = []
    this.pausedAt = null
    const display = displayId ? screen.getAllDisplays().find((d) => String(d.id) === displayId) : undefined
    this.bounds = display?.bounds ?? null
    if (!this.bounds) return

    this.timer = setInterval(() => {
      if (this.pausedAt !== null) return
      const p = screen.getCursorScreenPoint()
      this.raw.push({ at: Date.now(), x: p.x, y: p.y })
    }, 1000 / 60)

    const mod = loadHook()
    if (mod) {
      mod.uIOhook.removeAllListeners('mousedown')
      mod.uIOhook.on('mousedown', (e) => {
        if (this.pausedAt !== null) return
        // Use the DIP cursor position rather than the hook's physical pixels.
        const p = screen.getCursorScreenPoint()
        this.rawClicks.push({ at: Date.now(), x: p.x, y: p.y, button: BUTTONS[e.button] ?? 'left' })
      })
      try {
        mod.uIOhook.start()
        this.hookStarted = true
      } catch (err) {
        console.warn('Failed to start mouse hook:', err)
      }
    }
  }

  pause(): void {
    if (this.pausedAt === null) this.pausedAt = Date.now()
  }

  resume(): void {
    if (this.pausedAt !== null) {
      this.pauses.push({ from: this.pausedAt, to: Date.now() })
      this.pausedAt = null
    }
  }

  stop(): void {
    if (this.timer) clearInterval(this.timer)
    this.timer = null
    if (this.hookStarted) {
      const mod = loadHook()
      mod?.uIOhook.removeAllListeners('mousedown')
      mod?.uIOhook.stop()
      this.hookStarted = false
    }
    this.resume()
  }

  /** Converts collected samples to a track relative to `startedAt` (epoch ms). */
  finish(startedAt: number, duration: number): CursorTrack {
    this.stop()
    const b = this.bounds
    if (!b) return { samples: [], clicks: [], valid: false }
    const toT = (at: number): number => {
      let paused = 0
      for (const p of this.pauses) if (p.to <= at) paused += p.to - p.from
      return (at - startedAt - paused) / 1000
    }
    const norm = (x: number, y: number): { x: number; y: number } => ({
      x: (x - b.x) / b.width,
      y: (y - b.y) / b.height
    })
    const inRange = (t: number): boolean => t >= 0 && t <= duration + 0.5
    const samples: CursorSample[] = this.raw
      .map((s) => ({ t: toT(s.at), ...norm(s.x, s.y) }))
      .filter((s) => inRange(s.t))
    const clicks: ClickEvent[] = this.rawClicks
      .map((c) => ({ t: toT(c.at), button: c.button, ...norm(c.x, c.y) }))
      .filter((c) => inRange(c.t))
    return { samples, clicks, valid: true }
  }
}
