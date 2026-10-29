import { clickPulse, cursorOpacity } from '../../../shared/engine/cursor'
import { clamp, easeOutCubic, lerp } from '../../../shared/engine/math'
import { projectMediaUrl } from '../../../shared/mediaUrl'
import {
  blendHome,
  CURSOR_STYLE_SCALE,
  cursorLook,
  cursorVelocity,
  loopHomeTime,
  loopHomeWeight,
  rgba,
  tiltAngle,
  trailGhosts,
  type CursorLook
} from '../../../shared/render/cursorFx'
import { cursorHeight, shapeAt, speedAt } from '../../../shared/render/overlays'
import { cursorOverVideoAt } from '../../../shared/render/shapes'
import type { ClickStyle, CursorShape, Project } from '../../../shared/types'
import { drawCursorImage, drawCursorSprite, type SpriteTheme } from './cursorSprites'
import { inVideo, type FrameContext } from './frameContext'

/** Seconds (at 1x) a click effect plays. */
export const CLICK_EFFECT_SECONDS = 0.45

/**
 * Highlight halo, click effects, motion trail and the synthetic cursor, drawn inside the
 * recording card (clipped to it) through the zoom camera. Everything is a function of the
 * frame's source time, so preview, scrubbing and export agree.
 */
export function drawCursorLayer(fc: FrameContext): void {
  const { project, cursor } = fc
  if (!cursor.valid) return
  const look = cursorLook(project.cursor)
  // With the OS cursor baked into the video (Chromium capture), a synthetic cursor
  // and idle-hiding would only draw a second, lagging cursor next to it.
  const state = project.cursor.show && !project.capture?.cursorInVideo && cursor.samples.length > 0 ? cursorState(fc, look) : null
  if (state && look.highlight.enabled) drawHighlight(fc, look, state)
  // Click effects also mark clicks over the OS cursor baked into the video.
  if (project.cursor.clickEffect && cursor.clicks.length > 0) drawClickEffects(fc, look.clickStyle, look.clickColor)
  if (state) {
    if (look.trail) drawTrail(fc, look, state)
    drawCursor(fc, look, state, state.pos, state.opacity, state.angle, false)
  }
}

/* ---------- cursor state ---------- */

interface CursorState {
  /** Normalised position (smoothed, glided home at the end with "loop home"). */
  pos: { x: number; y: number }
  /** Position at any source time, with the same rules. */
  posAt: (t: number) => { x: number; y: number }
  opacity: number
  shape: CursorShape
  /** Drawn height in output pixels, before the click pulse. */
  height: number
  pulse: number
  angle: number
}

/** Where and how the synthetic cursor is drawn at fc.t, or null when it is not visible. */
function cursorState(fc: FrameContext, look: CursorLook): CursorState | null {
  const { project, cursor, t, cam, rect, vh } = fc
  const path = fc.scene.cursorPath
  const clips = project.clips
  const homeT = look.loopHome ? loopHomeTime(clips) : 0
  const home = look.loopHome ? path.at(homeT) : null
  const posAt = (s: number): { x: number; y: number } => (home ? blendHome(path.at(s), home, loopHomeWeight(clips, s)) : path.at(s))
  const w = home ? loopHomeWeight(clips, t) : 0
  let opacity = project.cursor.hideWhenIdle ? cursorOpacity(cursor.samples, t) : 1
  if (w > 0) opacity = lerp(opacity, project.cursor.hideWhenIdle ? cursorOpacity(cursor.samples, homeT) : 1, w)
  const pos = posAt(t)
  // Hide as soon as the recorded position leaves the video (cursor outside a window or
  // area, or over a window covering the recorded one) instead of letting the smoothed
  // cursor slide to the edge first. A cursor spotlight fades out by the same rule.
  if (opacity <= 0.01 || !cursorOverVideoAt(project, cursor.samples, path, t)) return null
  const height = cursorHeight(rect.h, vh, cursor.scale, cam.scale, project.cursor.size) * CURSOR_STYLE_SCALE[look.style]
  // On-screen velocity in content widths per output second (zooming in makes it faster).
  const angle = look.tilt ? tiltAngle(cursorVelocity(posAt, clips, t).vx * cam.scale) : 0
  return {
    pos,
    posAt,
    opacity,
    // With "loop home" the last frames take the first frame's shape, so the loop matches.
    shape: shapeAt(cursor.shapes, w >= 0.5 ? homeT : t),
    height,
    pulse: clickPulse(cursor.clicks, t),
    angle
  }
}

/** The cursor (sprite or custom image) at normalised `pos`. */
function drawCursor(fc: FrameContext, look: CursorLook, s: CursorState, pos: { x: number; y: number }, alpha: number, angle: number, ghost: boolean): void {
  const p = fc.toOut(pos.x, pos.y)
  const height = s.height * s.pulse
  if (look.style === 'custom') {
    const img = fc.project.cursor.customImage ? cursorImage(fc.project.id, fc.project.cursor.customImage) : null
    if (img) {
      drawCursorImage(fc.ctx, img.source, img.aspect, p.x, p.y, height, alpha, { angle, shadow: !ghost })
      return
    }
  }
  const theme: SpriteTheme = look.style === 'custom' ? 'auto' : look.style
  drawCursorSprite(fc.ctx, s.shape, p.x, p.y, height, alpha, fc.t, { theme, angle, ghost })
}

/* ---------- highlight ---------- */

/** A soft halo centred on the cursor's hotspot; it swells a little on clicks. */
function drawHighlight(fc: FrameContext, look: CursorLook, s: CursorState): void {
  const { ctx } = fc
  const { color, size, opacity } = look.highlight
  const a = opacity * s.opacity
  if (a <= 0.005) return
  const p = fc.toOut(s.pos.x, s.pos.y)
  // The pulse dips to 0.8 at a click: the halo grows by up to ~30% meanwhile.
  const r = s.height * 0.95 * size * (1 + (1 - s.pulse) * 1.5)
  if (!(r > 0.5)) return
  const g = ctx.createRadialGradient(p.x, p.y, 0, p.x, p.y, r)
  g.addColorStop(0, rgba(color, a))
  g.addColorStop(0.55, rgba(color, a * 0.88))
  g.addColorStop(0.8, rgba(color, a * 0.4))
  g.addColorStop(1, rgba(color, 0))
  ctx.beginPath()
  ctx.arc(p.x, p.y, r, 0, Math.PI * 2)
  ctx.fillStyle = g
  ctx.fill()
}

/* ---------- trail ---------- */

/** Fading ghost cursors behind a fast-moving cursor (none while it is still). */
function drawTrail(fc: FrameContext, look: CursorLook, s: CursorState): void {
  const ghosts = trailGhosts(s.posAt, fc.project.clips, fc.t, fc.toOut)
  // Oldest first, so newer ghosts sit on top.
  for (let i = ghosts.length - 1; i >= 0; i--) {
    const g = ghosts[i]
    if (!inVideo(g)) continue
    drawCursor(fc, look, s, g, s.opacity * g.alpha, s.angle, true)
  }
}

/* ---------- clicks ---------- */

const easeOutBack = (x: number): number => {
  const c = 1.9
  const v = clamp(x, 0, 1) - 1
  return 1 + (c + 1) * v * v * v + c * v * v
}

/**
 * Click effects (any button), timed in viewing time: they last as long on screen in a
 * sped-up or slowed-down clip as at 1x.
 * - ripple: a translucent disc with a rim that expands and fades (the original effect);
 * - ring: two thin outlines expanding one after the other;
 * - pulse: a filled dot that pops out and fades.
 */
function drawClickEffects(fc: FrameContext, style: ClickStyle, color: string): void {
  const { ctx, cursor, t, k, cam } = fc
  const duration = CLICK_EFFECT_SECONDS * speedAt(fc.project.clips, t)
  // While following, larger by the view's magnification, as the cursor is (fc.fxGain, 1 otherwise).
  const s = k * cam.scale * 0.8 * fc.fxGain
  for (const click of cursor.clicks) {
    const dt = t - click.t
    if (dt < 0 || dt > duration || !inVideo(click)) continue
    const raw = dt / duration
    const p = fc.toOut(click.x, click.y)
    if (style === 'ring') {
      const e = easeOutCubic(raw)
      ring(ctx, p, (6 + 40 * e) * s, (3.6 * (1 - e) + 1) * k, rgba(color, 0.95 * (1 - raw)))
      const raw2 = (raw - 0.2) / 0.8
      if (raw2 > 0) {
        const e2 = easeOutCubic(raw2)
        ring(ctx, p, (4 + 26 * e2) * s, (2.6 * (1 - e2) + 0.8) * k, rgba(color, 0.7 * (1 - raw2)))
      }
    } else if (style === 'pulse') {
      const r = 28 * s * (0.3 + 0.7 * easeOutBack(raw / 0.45))
      const a = 0.62 * (1 - raw * raw)
      const g = ctx.createRadialGradient(p.x, p.y, 0, p.x, p.y, r)
      g.addColorStop(0, rgba(color, a))
      g.addColorStop(0.7, rgba(color, a * 0.9))
      g.addColorStop(1, rgba(color, 0))
      ctx.beginPath()
      ctx.arc(p.x, p.y, r, 0, Math.PI * 2)
      ctx.fillStyle = g
      ctx.fill()
    } else {
      const progress = easeOutCubic(raw)
      ctx.beginPath()
      ctx.arc(p.x, p.y, (8 + 34 * progress) * s, 0, Math.PI * 2)
      ctx.fillStyle = rgba(color, 0.35 * (1 - progress))
      ctx.fill()
      ctx.lineWidth = 2.5 * k
      ctx.strokeStyle = rgba(color, 0.8 * (1 - progress))
      ctx.stroke()
    }
  }
}

function ring(ctx: CanvasRenderingContext2D, p: { x: number; y: number }, r: number, width: number, style: string): void {
  ctx.beginPath()
  ctx.arc(p.x, p.y, r, 0, Math.PI * 2)
  ctx.lineWidth = width
  ctx.strokeStyle = style
  ctx.stroke()
}

/* ---------- custom cursor image ---------- */

interface LoadedImage {
  source: CanvasImageSource
  /** Width / height. */
  aspect: number
}

interface ImageEntry {
  url: string
  image: LoadedImage | null
  failed: boolean
  done: Promise<void>
}

/** Raster images taller than this are scaled down once, so per-frame draws stay cheap. */
const MAX_IMAGE_HEIGHT = 512

const images = new Map<string, ImageEntry>()
const listeners = new Set<() => void>()
const imageKey = (projectId: string, file: string): string => `${projectId}/${file}`

/** Calls `listener` whenever a cursor image finished loading (or failed); returns an unsubscribe function. */
export function onCursorAssetsChanged(listener: () => void): () => void {
  listeners.add(listener)
  return () => listeners.delete(listener)
}

function decode(url: string, svg: boolean): Promise<LoadedImage> {
  return new Promise((resolve, reject) => {
    const img = new Image()
    img.crossOrigin = 'anonymous'
    img.decoding = 'async'
    img.onload = () => {
      const w = img.naturalWidth
      const h = img.naturalHeight
      // An SVG without a size has no natural size: draw it square.
      if (!(w > 0 && h > 0)) return svg ? resolve({ source: img, aspect: 1 }) : reject(new Error('Empty image'))
      // Vector images stay vectors (crisp at any size); big raster images are reduced once.
      if (svg || h <= MAX_IMAGE_HEIGHT) return resolve({ source: img, aspect: w / h })
      resolve({ source: downscale(img, w, h), aspect: w / h })
    }
    img.onerror = () => reject(new Error('Could not load the cursor image'))
    img.src = url
  })
}

/** Halves the image until it is at most MAX_IMAGE_HEIGHT tall (good quality, done once). */
function downscale(img: HTMLImageElement, w: number, h: number): HTMLCanvasElement {
  let src: CanvasImageSource = img
  let sw = w
  let sh = h
  let canvas = document.createElement('canvas')
  while (sh > MAX_IMAGE_HEIGHT) {
    const nh = Math.max(MAX_IMAGE_HEIGHT, Math.round(sh / 2))
    const nw = Math.max(1, Math.round((sw * nh) / sh))
    const next = document.createElement('canvas')
    next.width = nw
    next.height = nh
    const c = next.getContext('2d')!
    c.imageSmoothingEnabled = true
    c.imageSmoothingQuality = 'high'
    c.drawImage(src, 0, 0, nw, nh)
    src = next
    canvas = next
    sw = nw
    sh = nh
  }
  return canvas
}

function load(projectId: string, file: string, url: string): ImageEntry {
  const key = imageKey(projectId, file)
  const entry: ImageEntry = { url, image: null, failed: false, done: Promise.resolve() }
  entry.done = decode(url, /\.svg$/i.test(file)).then(
    (image) => {
      if (images.get(key) !== entry) return
      entry.image = image
      for (const l of [...listeners]) l()
    },
    (err: unknown) => {
      if (images.get(key) !== entry) return
      entry.failed = true
      console.warn(`Custom cursor ${file} could not be loaded:`, err)
      for (const l of [...listeners]) l()
    }
  )
  images.set(key, entry)
  return entry
}

/**
 * The decoded custom cursor image, or null while it loads or when it cannot be read (the
 * cursor is then drawn with the built-in arrow). The first request starts loading it;
 * onCursorAssetsChanged listeners hear when it is ready (the preview redraws then).
 */
function cursorImage(projectId: string, file: string): LoadedImage | null {
  const entry = images.get(imageKey(projectId, file)) ?? load(projectId, file, projectMediaUrl(projectId)(file))
  return entry.image
}

/**
 * Loads `file` again from `url` (or a fresh URL), e.g. after the user picked a new image
 * that was copied over the old file of the same name. Resolves once it is decoded;
 * rejects when it cannot be read.
 */
export async function reloadCursorImage(projectId: string, file: string, url?: string): Promise<void> {
  const entry = load(projectId, file, url ?? projectMediaUrl(projectId)(file))
  await entry.done
  if (entry.failed) throw new Error('This image could not be read')
}

/**
 * Loads images the cursor layer needs (a custom cursor image) before frames are rendered.
 * CONTRACT: the exporter awaits this before its first frame; the editor may call it when the
 * project's cursor settings change. Never rejects: a missing or unreadable image falls back
 * to the built-in cursor. Cached: a second call for the same image costs nothing.
 */
export async function prepareCursorAssets(project: Project, mediaUrl: (file: string) => string): Promise<void> {
  const file = project.cursor.customImage
  if (cursorLook(project.cursor).style !== 'custom' || !file) return
  const key = imageKey(project.id, file)
  const entry = images.get(key) ?? load(project.id, file, mediaUrl(file))
  await entry.done
}
