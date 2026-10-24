import type { Background, Clip } from '../types'
import { fillLinear, softBlob, type Draw2D } from './draw2d'
import { clamp } from './math'
import { keptBounds, outputDuration, playableFrom, sourceToOutput } from './timeline'
import { wallpaperById } from './wallpapers'

export interface GradientPreset {
  id: string
  name: string
  angle: number
  stops: string[]
}

export const GRADIENTS: GradientPreset[] = [
  { id: 'aurora', name: 'Aurora', angle: 135, stops: ['#5b21b6', '#db2777', '#f59e0b'] },
  { id: 'ocean', name: 'Ocean', angle: 135, stops: ['#0ea5e9', '#2563eb', '#1e1b4b'] },
  { id: 'mint', name: 'Mint', angle: 120, stops: ['#34d399', '#06b6d4', '#3b82f6'] },
  { id: 'sunset', name: 'Sunset', angle: 160, stops: ['#f97316', '#ef4444', '#7c3aed'] },
  { id: 'peach', name: 'Peach', angle: 135, stops: ['#fde68a', '#fca5a5', '#f472b6'] },
  { id: 'midnight', name: 'Midnight', angle: 145, stops: ['#0f172a', '#1e293b', '#334155'] },
  { id: 'forest', name: 'Forest', angle: 135, stops: ['#14532d', '#15803d', '#a3e635'] },
  { id: 'candy', name: 'Candy', angle: 120, stops: ['#a855f7', '#ec4899', '#fb7185'] },
  { id: 'steel', name: 'Steel', angle: 135, stops: ['#e2e8f0', '#94a3b8', '#475569'] },
  { id: 'lava', name: 'Lava', angle: 135, stops: ['#450a0a', '#b91c1c', '#fb923c'] }
]

export const gradientById = (id: string): GradientPreset => GRADIENTS.find((g) => g.id === id) ?? GRADIENTS[0]

export const gradientCss = (g: GradientPreset): string => `linear-gradient(${g.angle}deg, ${g.stops.join(', ')})`

/* ---------- animated gradients ---------- */

/** A gradient that drifts while the video plays: soft blobs of `colors` moving over `base`. */
export interface AnimatedPreset {
  id: string
  name: string
  base: string
  colors: string[]
}

export const ANIMATED_GRADIENTS: AnimatedPreset[] = [
  { id: 'aurora', name: 'Aurora flow', base: '#2e1065', colors: ['#7c3aed', '#db2777', '#f59e0b', '#2563eb'] },
  { id: 'ocean', name: 'Ocean drift', base: '#0c1e3e', colors: ['#0ea5e9', '#2563eb', '#14b8a6', '#6366f1'] },
  { id: 'sunset', name: 'Sunset glow', base: '#7c2d12', colors: ['#f97316', '#e11d48', '#a855f7', '#facc15'] },
  { id: 'mint', name: 'Mint breeze', base: '#064e3b', colors: ['#34d399', '#06b6d4', '#3b82f6', '#a3e635'] },
  { id: 'candy', name: 'Candy swirl', base: '#831843', colors: ['#ec4899', '#a855f7', '#fb7185', '#38bdf8'] },
  { id: 'midnight', name: 'Midnight pulse', base: '#020617', colors: ['#1e40af', '#6d28d9', '#0f766e', '#312e81'] }
]

export const animatedById = (id: string): AnimatedPreset => ANIMATED_GRADIENTS.find((g) => g.id === id) ?? ANIMATED_GRADIENTS[0]

/** Seconds one loop of an animated gradient takes at speed 1 (it then repeats seamlessly). */
export const ANIMATED_PERIOD = 20
export const ANIMATED_SPEED = { min: 0.25, max: 2 } as const

export const animatedSpeed = (bg: Background): number =>
  bg.type === 'animated' && typeof bg.speed === 'number' && Number.isFinite(bg.speed) ? clamp(bg.speed, ANIMATED_SPEED.min, ANIMATED_SPEED.max) : 1

export const isAnimated = (bg: Background): boolean => bg.type === 'animated'

export interface Blob {
  /** Centre, fractions of the frame. */
  x: number
  y: number
  /** Radius, fraction of the frame's longer side. */
  r: number
  color: string
}

/**
 * Where the blobs of an animated gradient are at `time` seconds. Every motion is a whole
 * number of turns per loop, so the picture at `time` and `time + ANIMATED_PERIOD / speed`
 * is the same: the animation loops without a seam.
 */
export function animatedBlobs(preset: AnimatedPreset, time: number, speed = 1): Blob[] {
  const phase = ((time * speed) / ANIMATED_PERIOD) * Math.PI * 2
  return preset.colors.map((color, i) => {
    const a = i * 1.7 + 0.4
    const fx = 1 + (i % 2)
    const fy = 1 + ((i + 1) % 2)
    const dir = i % 3 === 1 ? -1 : 1
    return {
      x: 0.5 + 0.36 * Math.cos(dir * phase * fx + a),
      y: 0.5 + 0.32 * Math.sin(dir * phase * fy + a * 1.3),
      r: 0.5 + 0.1 * Math.sin(phase + i * 2.1),
      color
    }
  })
}

/** Paints an animated gradient at `time` (seconds into the video). */
export function drawAnimated(ctx: Draw2D, w: number, h: number, preset: AnimatedPreset, time: number, speed = 1): void {
  ctx.fillStyle = preset.base
  ctx.fillRect(0, 0, w, h)
  for (const b of animatedBlobs(preset, time, speed)) softBlob(ctx, w, h, b.x, b.y, b.r, b.color, 0.85)
}

/**
 * The clock animated backgrounds run on: output time, so they keep moving smoothly across cuts
 * and at the same pace on sped-up clips. A time inside a cut uses the next kept frame.
 */
export function animationTime(clips: Clip[], t: number): number {
  const out = sourceToOutput(clips, t)
  if (out !== null) return out
  const next = playableFrom(clips, t)
  if (next) return sourceToOutput(clips, next.time) ?? 0
  return t < keptBounds(clips).start ? 0 : outputDuration(clips)
}

/* ---------- blur ---------- */

/** How blurred an image or wallpaper background is, 0..1 (other backgrounds are never blurred). */
export function backgroundBlur(bg: Background): number {
  if (bg.type !== 'image' && bg.type !== 'wallpaper') return 0
  return typeof bg.blur === 'number' && Number.isFinite(bg.blur) ? clamp(bg.blur, 0, 1) : 0
}

/** Blur radius (CSS blur, ~ one standard deviation) in output pixels for a frame of w x h. */
export const blurRadius = (blur: number, w: number, h: number): number => blur * 0.04 * Math.min(w, h)

/** Paints a gradient preset over the whole frame. */
export function drawGradient(ctx: Draw2D, w: number, h: number, preset: GradientPreset): void {
  fillLinear(ctx, w, h, preset.angle, preset.stops)
}

/** True when `bg` names a built-in look (gradient, wallpaper or animated preset) that exists. */
export function isKnownBackground(bg: Background): boolean {
  switch (bg.type) {
    case 'gradient':
      return GRADIENTS.some((g) => g.id === bg.preset)
    case 'wallpaper':
      return !!wallpaperById(bg.id)
    case 'animated':
      return ANIMATED_GRADIENTS.some((g) => g.id === bg.preset)
    default:
      return true
  }
}
