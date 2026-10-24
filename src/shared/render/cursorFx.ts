/**
 * Pure maths for the cursor's look and motion effects: the look with defaults filled in,
 * "loop home" (glide back to the start for seamless loops), tilt and the motion trail.
 * No DOM, so it is unit-tested directly; renderer/render/cursorLayer.ts draws with it, and
 * preview and export both go through that one code path.
 */
import { clamp, lerp } from '../engine/math'
import { DEFAULT_CURSOR_EXTRAS } from '../engine/project'
import { clipIndexAt, keptBounds, outputDuration } from '../engine/timeline'
import type { ClickStyle, Clip, CursorSettings, CursorStyle } from '../types'
import { viewingTime } from './overlays'

/* ---------- look ---------- */

export type CursorLook = typeof DEFAULT_CURSOR_EXTRAS

export const CURSOR_STYLES: CursorStyle[] = ['auto', 'mac', 'windows', 'white', 'black', 'custom']
export const CLICK_STYLES: ClickStyle[] = ['ripple', 'ring', 'pulse']

const HEX = /^#[0-9a-f]{6}$/i

/**
 * The cursor look of `c` with every optional field filled in: older projects (and
 * hand-edited ones with unknown values) get the defaults, so they look as they always did.
 */
export function cursorLook(c: CursorSettings): CursorLook {
  const d = DEFAULT_CURSOR_EXTRAS
  const h = c.highlight
  const num = (v: unknown, fallback: number, min: number, max: number): number => (typeof v === 'number' && Number.isFinite(v) ? clamp(v, min, max) : fallback)
  return {
    style: CURSOR_STYLES.includes(c.style as CursorStyle) ? (c.style as CursorStyle) : d.style,
    highlight: {
      enabled: typeof h?.enabled === 'boolean' ? h.enabled : d.highlight.enabled,
      color: typeof h?.color === 'string' && HEX.test(h.color) ? h.color : d.highlight.color,
      size: num(h?.size, d.highlight.size, 0.2, 5),
      opacity: num(h?.opacity, d.highlight.opacity, 0, 1)
    },
    clickStyle: CLICK_STYLES.includes(c.clickStyle as ClickStyle) ? (c.clickStyle as ClickStyle) : d.clickStyle,
    clickColor: typeof c.clickColor === 'string' && HEX.test(c.clickColor) ? c.clickColor : d.clickColor,
    clickSound: typeof c.clickSound === 'boolean' ? c.clickSound : d.clickSound,
    clickSoundVolume: num(c.clickSoundVolume, d.clickSoundVolume, 0, 1),
    loopHome: typeof c.loopHome === 'boolean' ? c.loopHome : d.loopHome,
    tilt: typeof c.tilt === 'boolean' ? c.tilt : d.tilt,
    trail: typeof c.trail === 'boolean' ? c.trail : d.trail
  }
}

/** Size of each style relative to the recorded cursor: the high-contrast ones are large, like Windows' "large" schemes. */
export const CURSOR_STYLE_SCALE: Record<CursorStyle, number> = { auto: 1, mac: 1, windows: 1, white: 1.3, black: 1.3, custom: 1 }

/** "#rrggbb" -> [r, g, b]; anything else is white. */
export function hexRgb(hex: string): [number, number, number] {
  if (!HEX.test(hex)) return [255, 255, 255]
  const n = parseInt(hex.slice(1), 16)
  return [(n >> 16) & 255, (n >> 8) & 255, n & 255]
}

/** CSS rgba() of a "#rrggbb" colour at `alpha` (clamped to 0..1). */
export function rgba(hex: string, alpha: number): string {
  const [r, g, b] = hexRgb(hex)
  return `rgba(${r},${g},${b},${+clamp(alpha, 0, 1).toFixed(4)})`
}

export const smoothstep = (a: number, b: number, v: number): number => {
  const x = clamp((v - a) / (b - a), 0, 1)
  return x * x * (3 - 2 * x)
}

/* ---------- loop home ---------- */

export const LOOP_HOME = {
  /** Output seconds the glide back takes at the end of the edit. */
  seconds: 1,
  /** Never more than this share of a short edit. */
  maxShare: 1 / 3
}

/** Source time whose cursor the edit ends on with "loop home": its first kept frame. */
export const loopHomeTime = (clips: Clip[]): number => keptBounds(clips).start

/**
 * How far (0..1, eased) the cursor has glided back to its position at the start of the
 * edit, at source time `t`. 0 until the last LOOP_HOME.seconds of OUTPUT time, 1 at the
 * very end, so the last frame matches the first one and a GIF loops without a jump.
 * Measured in output time, so cuts and speed changes keep the glide one second long.
 */
export function loopHomeWeight(clips: Clip[], t: number, seconds = LOOP_HOME.seconds): number {
  const total = outputDuration(clips)
  const span = Math.min(seconds, total * LOOP_HOME.maxShare)
  if (!(span > 0)) return 0
  const x = clamp((viewingTime(clips, t) - (total - span)) / span, 0, 1)
  // Smoothstep-like ease (zero velocity at both ends): leaves and lands without a kink.
  return x * x * x * (x * (x * 6 - 15) + 10)
}

type Pos = { x: number; y: number }

/** Blends `pos` toward `home` by weight `w`. */
export const blendHome = (pos: Pos, home: Pos, w: number): Pos => (w <= 0 ? pos : { x: lerp(pos.x, home.x, w), y: lerp(pos.y, home.y, w) })

/* ---------- tilt ---------- */

export const TILT = {
  /** Largest lean, in degrees. */
  maxDeg: 10,
  /** On-screen speed (content widths per output second) at which the lean reaches ~76% of the maximum. */
  refSpeed: 0.6,
  /** Half-width (output seconds) of the window the velocity is measured over. */
  window: 1 / 30
}

/**
 * Lean (radians, clockwise positive) for a horizontal on-screen velocity `vx` (content
 * widths per output second): leans into the movement, saturates smoothly at TILT.maxDeg,
 * and is 0 when the cursor is still. The smoothed cursor path decelerates like a spring,
 * so the lean eases back to upright as it settles.
 */
export function tiltAngle(vx: number, maxDeg = TILT.maxDeg, refSpeed = TILT.refSpeed): number {
  if (!Number.isFinite(vx)) return 0
  return ((maxDeg * Math.PI) / 180) * Math.tanh(vx / refSpeed)
}

/**
 * Velocity of `pos` at source time `t` in normalised units per OUTPUT second (a 2x clip
 * moves twice as fast on screen), measured over ±TILT.window inside the clip containing
 * `t`, so movement during a cut never shows up.
 */
export function cursorVelocity(pos: (t: number) => Pos, clips: Clip[], t: number, window = TILT.window): { vx: number; vy: number } {
  const i = clipIndexAt(clips, t)
  const clip = i >= 0 ? clips[i] : null
  const speed = clip ? clip.speed : 1
  let a = t - window * speed
  let b = t + window * speed
  if (clip) {
    a = Math.max(a, clip.start)
    b = Math.min(b, clip.end)
  }
  if (b - a < 1e-6) return { vx: 0, vy: 0 }
  const pa = pos(a)
  const pb = pos(b)
  const dt = (b - a) / speed
  return { vx: (pb.x - pa.x) / dt, vy: (pb.y - pa.y) / dt }
}

/* ---------- trail ---------- */

export const TRAIL = {
  /** Ghost cursors behind the real one: close enough together to read as one smooth streak. */
  ghosts: 8,
  /** Output seconds between ghosts (whatever the export frame rate): the trail spans ~70 ms. */
  spacing: 1 / 120,
  /** Opacity of the newest ghost; older ones fade linearly. */
  alpha: 0.34,
  /** Output pixels per ghost step below which there is no trail, and at which it is full. */
  minStepPx: 1.2,
  fullStepPx: 5
}

export interface TrailGhost {
  /** Source time the ghost shows. */
  t: number
  x: number
  y: number
  /** 0..1 opacity factor. */
  alpha: number
}

/**
 * Ghost positions of a short trail behind the cursor at source time `t`, newest first.
 * One ghost per TRAIL.spacing of output time, only inside the current clip, fading with
 * age, and only when the cursor moves fast enough on screen: `toPx` maps a normalised
 * position to output pixels (through the zoom camera), so a still cursor has no trail.
 */
export function trailGhosts(pos: (t: number) => Pos, clips: Clip[], t: number, toPx: (x: number, y: number) => Pos, opts = TRAIL): TrailGhost[] {
  const i = clipIndexAt(clips, t)
  if (i < 0 || opts.ghosts <= 0) return []
  const clip = clips[i]
  const now = pos(t)
  const p0 = toPx(now.x, now.y)
  const out: TrailGhost[] = []
  for (let g = 1; g <= opts.ghosts; g++) {
    const tg = t - g * opts.spacing * clip.speed
    if (tg < clip.start) break
    const q = pos(tg)
    const pq = toPx(q.x, q.y)
    // Average on-screen distance per ghost step since that ghost's time.
    const step = Math.hypot(pq.x - p0.x, pq.y - p0.y) / g
    const alpha = opts.alpha * (1 - g / (opts.ghosts + 1)) * smoothstep(opts.minStepPx, opts.fullStepPx, step)
    if (alpha > 0.01) out.push({ t: tg, x: q.x, y: q.y, alpha })
  }
  return out
}
