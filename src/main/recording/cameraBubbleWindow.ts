import { BrowserWindow, screen, type BrowserWindowConstructorOptions, type Rectangle } from 'electron'
import { bubbleBounds, DEFAULT_BUBBLE_SIZE, nearestCorner, type BubbleSize } from '../../shared/recording/cameraBubble'
import type { Corner } from '../../shared/types'
import { captureExclusionSupported } from './captureExclusion'

/**
 * The live camera bubble shown while recording. Its window is opened by the recorder's own page
 * (window.open with this name) so that the page that already holds the camera shows it there:
 * the camera is never opened a second time. This module decides whether one may open, places it,
 * keeps it out of the capture, moves it (drag, snap to the nearest corner, sizes) and reports
 * each corner it goes to. Nothing here can stop or delay the recording: every failure only
 * leaves the bubble out.
 */

/** The window.open name the recorder's page uses for the bubble. */
export const BUBBLE_FRAME = 'ssw-camera-bubble'
/** How long the bubble glides into a corner (ms). */
const SNAP_MS = 180
const SNAP_STEPS = 12

/**
 * Windows 10 2004 (build 19041) is the first to keep a window out of screen captures entirely
 * (WDA_EXCLUDEFROMCAPTURE). Older versions would record it as a black square, so they get no
 * bubble. The rule lives in captureExclusion.ts (the speaker notes use it too).
 */
export { captureExclusionSupported as bubbleSupported }

interface BubbleState {
  token: string
  corner: Corner
  size: BubbleSize
  /** The work area the bubble's corners belong to (the recorded display's, or the one it was dragged to). */
  area: Rectangle
  shown: boolean
}

let state: BubbleState | null = null
let bubble: BrowserWindow | null = null
/** May open: set by allowBubble() until the page opens it. */
let allowed = false
let drag: { dx: number; dy: number } | null = null
let glide: NodeJS.Timeout | null = null
let onCorner: ((corner: Corner) => void) | null = null
let onShown: (() => void) | null = null

const alive = (w: BrowserWindow | null): w is BrowserWindow => !!w && !w.isDestroyed()

function stopGlide(): void {
  if (glide) clearInterval(glide)
  glide = null
}

/** Moves the bubble to `to`, eased (a fraction of a second), or at once when `instant`. */
function glideTo(to: Rectangle, instant = false): void {
  stopGlide()
  const w = bubble
  if (!alive(w)) return
  const from = w.getBounds()
  if (instant || (from.x === to.x && from.y === to.y && from.width === to.width && from.height === to.height)) {
    w.setBounds(to)
    return
  }
  let step = 0
  glide = setInterval(() => {
    step++
    const k = 1 - Math.pow(1 - step / SNAP_STEPS, 3)
    const at = (a: number, b: number): number => Math.round(a + (b - a) * k)
    if (!alive(w) || step >= SNAP_STEPS) {
      stopGlide()
      if (alive(w)) w.setBounds(to)
      return
    }
    w.setBounds({ x: at(from.x, to.x), y: at(from.y, to.y), width: at(from.width, to.width), height: at(from.height, to.height) })
  }, SNAP_MS / SNAP_STEPS)
}

/**
 * Lets the recording `token` open its bubble, in `corner` of `area` (the recorded display's work
 * area). `cornerChanged` is told every corner the bubble then goes to; `shownChanged` when the
 * bubble is hidden or shown again. False when this PC cannot keep it out of the capture.
 */
export function allowBubble(
  token: string,
  area: Rectangle,
  corner: Corner,
  cornerChanged: (corner: Corner) => void,
  shownChanged: () => void
): boolean {
  closeBubble()
  if (!captureExclusionSupported()) return false
  state = { token, corner, size: DEFAULT_BUBBLE_SIZE, area, shown: true }
  allowed = true
  onCorner = cornerChanged
  onShown = shownChanged
  return true
}

/** The window options for the page's window.open of the bubble, or null to refuse it. */
export function bubbleWindowOptions(): BrowserWindowConstructorOptions | null {
  if (!allowed || !state || alive(bubble)) return null
  allowed = false
  return {
    ...bubbleBounds(state.area, state.corner, state.size),
    frame: false,
    transparent: true,
    backgroundColor: '#00000000',
    resizable: false,
    minimizable: false,
    maximizable: false,
    fullscreenable: false,
    alwaysOnTop: true,
    skipTaskbar: true,
    // Dragging the bubble must not pull keyboard focus away from the app being recorded.
    focusable: false,
    hasShadow: false,
    show: false,
    title: 'Camera',
    webPreferences: { sandbox: true, contextIsolation: true, nodeIntegration: false, backgroundThrottling: false }
  }
}

/** The page opened the bubble: keep it on top of everything and out of the recording. */
export function bubbleCreated(win: BrowserWindow): void {
  if (!state) {
    win.destroy()
    return
  }
  bubble = win
  win.setAlwaysOnTop(true, 'screen-saver')
  // Out of the recording (Windows 10 2004+ / macOS), like the control bar.
  win.setContentProtection(true)
  win.on('closed', () => {
    if (bubble === win) bubble = null
    stopGlide()
  })
  if (state.shown) win.showInactive()
}

/** Whether a bubble is open for the recording (hidden or not), and whether it is shown. */
export function bubbleStatus(): { shown: boolean } | null {
  return state && alive(bubble) ? { shown: state.shown } : null
}

const forToken = (token: unknown): BubbleState | null => (state && state.token === token ? state : null)

/** A drag of the bubble by the pointer, in screen DIP; the end snaps it into the nearest corner. */
export function dragBubble(token: unknown, phase: unknown, x: unknown, y: unknown): void {
  const s = forToken(token)
  const w = bubble
  if (!s || !alive(w) || typeof x !== 'number' || typeof y !== 'number' || !Number.isFinite(x) || !Number.isFinite(y)) return
  if (phase === 'start') {
    stopGlide()
    const b = w.getBounds()
    drag = { dx: x - b.x, dy: y - b.y }
  } else if (phase === 'move' && drag) {
    w.setPosition(Math.round(x - drag.dx), Math.round(y - drag.dy))
  } else if (phase === 'end' && drag) {
    drag = null
    const b = w.getBounds()
    // The display it was dropped on (it may go to another one).
    s.area = screen.getDisplayMatching(b).workArea
    setCorner(s, nearestCorner(s.area, b))
  }
}

function setCorner(s: BubbleState, corner: Corner): void {
  glideTo(bubbleBounds(s.area, corner, s.size))
  if (corner === s.corner) return
  s.corner = corner
  onCorner?.(corner)
}

/** Changes the bubble's size; it stays in its corner. */
export function resizeBubble(token: unknown, size: BubbleSize): void {
  const s = forToken(token)
  if (!s || !alive(bubble)) return
  s.size = size
  glideTo(bubbleBounds(s.area, s.corner, size))
}

/** Hides the bubble, or shows it again (the recording bar's camera button). */
export function toggleBubble(): void {
  const s = state
  const w = bubble
  if (!s || !alive(w)) return
  s.shown = !s.shown
  if (s.shown) w.showInactive()
  else w.hide()
  onShown?.()
}

/** Closes the bubble (the recording ended) and forgets it. */
export function closeBubble(): void {
  stopGlide()
  drag = null
  allowed = false
  state = null
  onCorner = null
  onShown = null
  const w = bubble
  bubble = null
  if (alive(w)) w.destroy()
}
