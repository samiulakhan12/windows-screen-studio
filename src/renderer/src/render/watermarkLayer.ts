import type { Rect } from '../../../shared/engine/layout'
import { activeWatermark, watermarkRect } from '../../../shared/engine/watermark'
import { projectMediaUrl } from '../../../shared/mediaUrl'
import type { Project, WatermarkSettings } from '../../../shared/types'
import type { FrameContext } from './frameContext'

type Ctx = CanvasRenderingContext2D

/* ---------- watermark image ---------- */

interface LoadedImage {
  source: CanvasImageSource
  /** Width / height. */
  aspect: number
  /** Changes whenever a new image is decoded (drawn stamps are rebuilt). */
  version: number
}

interface ImageEntry {
  image: LoadedImage | null
  failed: boolean
  done: Promise<void>
}

/** Raster logos wider than this are reduced once; a watermark is never drawn larger on a 4K frame. */
const MAX_IMAGE_SIDE = 1024

const images = new Map<string, ImageEntry>()
const imageKey = (projectId: string, file: string): string => `${projectId}/${file}`
let imageVersion = 0

function decode(url: string, svg: boolean): Promise<LoadedImage> {
  return new Promise((resolve, reject) => {
    const img = new Image()
    img.crossOrigin = 'anonymous'
    img.decoding = 'async'
    img.onload = () => {
      const w = img.naturalWidth
      const h = img.naturalHeight
      // An SVG without a size has no natural size: draw it square.
      if (!(w > 0 && h > 0)) return svg ? resolve({ source: img, aspect: 1, version: ++imageVersion }) : reject(new Error('Empty image'))
      if (svg || Math.max(w, h) <= MAX_IMAGE_SIDE) return resolve({ source: img, aspect: w / h, version: ++imageVersion })
      const s = MAX_IMAGE_SIDE / Math.max(w, h)
      const c = document.createElement('canvas')
      c.width = Math.max(1, Math.round(w * s))
      c.height = Math.max(1, Math.round(h * s))
      const ctx = c.getContext('2d')
      if (!ctx) return resolve({ source: img, aspect: w / h, version: ++imageVersion })
      ctx.imageSmoothingEnabled = true
      ctx.imageSmoothingQuality = 'high'
      ctx.drawImage(img, 0, 0, c.width, c.height)
      resolve({ source: c, aspect: w / h, version: ++imageVersion })
    }
    img.onerror = () => reject(new Error('Could not load the watermark image'))
    img.src = url
  })
}

function load(projectId: string, file: string, url: string): ImageEntry {
  const key = imageKey(projectId, file)
  const entry: ImageEntry = { image: null, failed: false, done: Promise.resolve() }
  entry.done = decode(url, /\.svg$/i.test(file)).then(
    (image) => {
      if (images.get(key) !== entry) return
      entry.image = image
      notifyStyleAssetsChanged()
    },
    (err: unknown) => {
      if (images.get(key) !== entry) return
      entry.failed = true
      console.warn(`Watermark ${file} could not be loaded:`, err)
      notifyStyleAssetsChanged()
    }
  )
  images.set(key, entry)
  return entry
}

/** The decoded watermark image, or null while it loads (the first request starts loading it) or when it cannot be read. */
function watermarkImage(projectId: string, file: string): LoadedImage | null {
  if (typeof Image === 'undefined') return null
  const entry = images.get(imageKey(projectId, file)) ?? load(projectId, file, projectMediaUrl(projectId)(file))
  return entry.image
}

/**
 * Decodes a newly picked logo before the project switches to it. Resolves once it is ready to
 * draw; rejects when it cannot be read, leaving whatever was cached (and drawn) as it was.
 */
export async function preloadWatermarkImage(projectId: string, file: string, url?: string): Promise<void> {
  const image = await decode(url ?? projectMediaUrl(projectId)(file), /\.svg$/i.test(file)).catch((err: unknown) => {
    console.warn(`Watermark ${file} could not be loaded:`, err)
    return null
  })
  if (!image) throw new Error('This image could not be read')
  images.set(imageKey(projectId, file), { image, failed: false, done: Promise.resolve() })
  notifyStyleAssetsChanged()
}

/* ---------- drawing ---------- */

interface Stamp {
  key: string
  /** The watermark drawn at its final size (null: draw directly, no DOM). */
  canvas: HTMLCanvasElement | null
  /** Where the stamp goes, and how far its canvas reaches past that box (text shadow). */
  rect: Rect
  pad: number
}

const stamps = new WeakMap<Ctx, Stamp>()
const FONT = (px: number): string => `600 ${px}px 'Segoe UI', system-ui, sans-serif`

function paintText(c: Ctx, text: string, px: number, x: number, y: number): void {
  c.font = FONT(px)
  c.textAlign = 'left'
  c.textBaseline = 'middle'
  c.shadowColor = 'rgba(0,0,0,0.45)'
  c.shadowBlur = px * 0.12
  c.shadowOffsetY = px * 0.04
  c.fillStyle = '#ffffff'
  c.fillText(text, x, y)
}

/** Builds the stamp for `wm` in a w x h frame: rendered once, then copied every frame. */
function buildStamp(ctx: Ctx, key: string, w: number, h: number, wm: WatermarkSettings, image: LoadedImage | null): Stamp | null {
  const m = Math.min(w, h)
  if (wm.kind === 'image') {
    if (!image) return null
    const rect = watermarkRect(w, h, wm, image.aspect)
    if (typeof document === 'undefined') return { key, canvas: null, rect, pad: 0 }
    const c = document.createElement('canvas')
    c.width = Math.max(1, Math.round(rect.w))
    c.height = Math.max(1, Math.round(rect.h))
    const sctx = c.getContext('2d')
    if (!sctx) return { key, canvas: null, rect, pad: 0 }
    sctx.imageSmoothingEnabled = true
    sctx.imageSmoothingQuality = 'high'
    sctx.drawImage(image.source, 0, 0, c.width, c.height)
    return { key, canvas: c, rect, pad: 0 }
  }
  const text = (wm.text ?? '').trim()
  const px = wm.size * m
  ctx.save()
  ctx.font = FONT(px)
  const width = ctx.measureText(text).width
  ctx.restore()
  const rect = watermarkRect(w, h, wm, width > 0 ? width / px : 1)
  // The box may have been shrunk to fit the frame: the text follows it.
  const fpx = rect.h
  const pad = Math.ceil(fpx * 0.3)
  if (typeof document === 'undefined') return { key, canvas: null, rect, pad }
  const c = document.createElement('canvas')
  c.width = Math.max(1, Math.ceil(rect.w + pad * 2))
  c.height = Math.max(1, Math.ceil(rect.h + pad * 2))
  const sctx = c.getContext('2d')
  if (!sctx) return { key, canvas: null, rect, pad }
  paintText(sctx, text, fpx, pad, pad + rect.h / 2)
  return { key, canvas: c, rect, pad }
}

/**
 * Stamps the project's watermark (logo image or text) over the finished frame, in output
 * space: zoom, pull-back and device frames never move it. Built once per size and settings,
 * then one image copy per frame. An image that is still loading is skipped (the preview
 * repaints when it arrives; the exporter waits for it in prepareStyleAssets).
 */
export function drawWatermarkLayer(fc: FrameContext): void {
  const wm = activeWatermark(fc.project)
  if (!wm) return
  const { ctx, w, h } = fc
  const image = wm.kind === 'image' && wm.path ? watermarkImage(fc.project.id, wm.path) : null
  if (wm.kind === 'image' && !image) return
  const key = `${w}x${h}|${wm.kind}|${wm.kind === 'image' ? `${wm.path}@${image?.version}` : wm.text}|${wm.position}|${wm.size}|${wm.margin}`
  let stamp = stamps.get(ctx)
  if (!stamp || stamp.key !== key) {
    const built = buildStamp(ctx, key, w, h, wm, image)
    if (!built) return
    stamp = built
    stamps.set(ctx, stamp)
  }
  ctx.save()
  ctx.globalAlpha = wm.opacity
  if (stamp.canvas) {
    ctx.drawImage(stamp.canvas, Math.round(stamp.rect.x) - stamp.pad, Math.round(stamp.rect.y) - stamp.pad)
  } else if (wm.kind === 'image' && image) {
    ctx.drawImage(image.source, stamp.rect.x, stamp.rect.y, stamp.rect.w, stamp.rect.h)
  } else {
    paintText(ctx, (wm.text ?? '').trim(), stamp.rect.h, stamp.rect.x, stamp.rect.y + stamp.rect.h / 2)
  }
  ctx.restore()
}

/**
 * Loads the images a project's style needs that are not passed in RenderSources (the
 * watermark logo; wallpapers are generated and need nothing). Export awaits it before the
 * first frame; the preview loads them lazily and repaints through onStyleAssetsChanged.
 * Never rejects: an unreadable logo is left out. Cached: a second call costs nothing.
 */
export async function prepareStyleAssets(project: Project, mediaUrl: (file: string) => string): Promise<void> {
  const wm = activeWatermark(project)
  if (!wm || wm.kind !== 'image' || !wm.path || typeof Image === 'undefined') return
  const entry = images.get(imageKey(project.id, wm.path)) ?? load(project.id, wm.path, mediaUrl(wm.path))
  await entry.done
}

const listeners = new Set<() => void>()

/** Calls `fn` whenever a style image finishes loading. Returns an unsubscribe function. */
export function onStyleAssetsChanged(fn: () => void): () => void {
  listeners.add(fn)
  return () => listeners.delete(fn)
}

export function notifyStyleAssetsChanged(): void {
  for (const fn of [...listeners]) fn()
}
