/**
 * Image overlays: decoding the images, GIFs and stickers once, and drawing the ones visible at a
 * frame (docs/design/brand-kit.md §4). Preview and export use the same decoded pictures (same
 * window, same cache) and the same pure timing, so they draw the same pixels; a GIF shows the
 * frame gifFrameAt picks for the frame's time, never whatever an <img> element happens to show.
 */
import { mediaUrl } from '../../../shared/mediaUrl'
import {
  gifFrameAt,
  gifScale,
  gifScreenSize,
  gifTiming,
  GIF_MAX_FRAMES,
  imageSizeProblem,
  IMAGE_MAX_SIDE,
  overlayAlpha,
  overlayBox,
  overlayClockMs,
  overlayVisibleAt,
  type GifTiming
} from '../../../shared/render/imageOverlays'
import { stickerOf, stickerUrl } from '../../../shared/render/stickers'
import type { ImageOverlay, Project } from '../../../shared/types'
import type { FrameContext } from './frameContext'
import { notifyStyleAssetsChanged } from './watermarkLayer'

/* ---------- decoding ---------- */

export type DecodedOverlay = { kind: 'still'; source: CanvasImageSource; width: number; height: number } | { kind: 'gif'; frames: ImageBitmap[]; timing: GifTiming; width: number; height: number }

interface Entry {
  image: DecodedOverlay | null
  /** Why it cannot be drawn (shown in the panel), once decoding failed. */
  error: string | null
  done: Promise<void>
}

const cache = new Map<string, Entry>()
let currentProject: string | null = null

const STICKER_SIDE = 512

/** Cache key of what an overlay shows: a sticker is the same in every project. */
const keyOf = (projectId: string, o: Pick<ImageOverlay, 'file' | 'sticker'>): string => (o.sticker ? `sticker:${o.sticker}` : `${projectId}/${o.file}`)

function release(e: Entry): void {
  if (e.image?.kind === 'gif') for (const f of e.image.frames) f.close()
}

/** Forgets the pictures of other projects (one editor is open at a time). */
function switchProject(projectId: string): void {
  if (currentProject === projectId) return
  currentProject = projectId
  for (const [key, e] of cache) {
    if (key.startsWith('sticker:') || key.startsWith(`${projectId}/`)) continue
    release(e)
    cache.delete(key)
  }
}

function loadImage(url: string): Promise<HTMLImageElement> {
  return new Promise((resolve, reject) => {
    const img = new Image()
    img.crossOrigin = 'anonymous'
    img.decoding = 'async'
    img.onload = () => resolve(img)
    img.onerror = () => reject(new Error('This image could not be read.'))
    img.src = url
  })
}

/** `source` drawn into a canvas `w` x `h` (high quality): the one raster preview and export share. */
function raster(source: CanvasImageSource, w: number, h: number): HTMLCanvasElement {
  const c = document.createElement('canvas')
  c.width = Math.max(1, Math.round(w))
  c.height = Math.max(1, Math.round(h))
  const ctx = c.getContext('2d')
  if (!ctx) throw new Error('This image could not be read.')
  ctx.imageSmoothingEnabled = true
  ctx.imageSmoothingQuality = 'high'
  ctx.drawImage(source, 0, 0, c.width, c.height)
  return c
}

/** An SVG (a file or a sticker) rasterised once at IMAGE_MAX_SIDE (or `side`) on its long side; square without a size. */
async function decodeSvg(url: string, side = IMAGE_MAX_SIDE): Promise<DecodedOverlay> {
  const img = await loadImage(url)
  const w = img.naturalWidth
  const h = img.naturalHeight
  const aspect = w > 0 && h > 0 ? w / h : 1
  const rw = aspect >= 1 ? side : side * aspect
  const rh = aspect >= 1 ? side / aspect : side
  return { kind: 'still', source: raster(img, rw, rh), width: rw, height: rh }
}

/** A PNG, JPEG or WebP, refused when too large to show, kept at most IMAGE_MAX_SIDE on its long side. */
async function decodeStill(url: string): Promise<DecodedOverlay> {
  const img = await loadImage(url)
  const w = img.naturalWidth
  const h = img.naturalHeight
  const problem = imageSizeProblem(w, h)
  if (problem) throw new Error(problem)
  const s = Math.min(1, IMAGE_MAX_SIDE / Math.max(w, h))
  return { kind: 'still', source: raster(img, w * s, h * s), width: w * s, height: h * s }
}

/** Every frame of a GIF, composited, scaled to gifScale, with its delay. A one-frame GIF is a still. */
async function decodeGif(url: string): Promise<DecodedOverlay> {
  if (typeof ImageDecoder === 'undefined') throw new Error('This GIF could not be read.')
  const res = await fetch(url)
  if (!res.ok) throw new Error('This image could not be read.')
  const data = await res.arrayBuffer()
  const screen = gifScreenSize(new Uint8Array(data, 0, Math.min(16, data.byteLength)))
  if (!screen) throw new Error('This GIF could not be read.')
  const tooLarge = imageSizeProblem(screen.width, screen.height)
  if (tooLarge) throw new Error(tooLarge)
  const decoder = new ImageDecoder({ data, type: 'image/gif' })
  const frames: ImageBitmap[] = []
  try {
    await decoder.tracks.ready
    await decoder.completed
    const count = decoder.tracks.selectedTrack?.frameCount ?? 0
    if (count < 1) throw new Error('This GIF could not be read.')
    if (count > GIF_MAX_FRAMES) throw new Error(`This GIF has too many frames (${count}; ${GIF_MAX_FRAMES} at most).`)
    const delays: number[] = []
    let width = 0
    let height = 0
    let scale = 1
    for (let i = 0; i < count; i++) {
      const { image } = await decoder.decode({ frameIndex: i, completeFramesOnly: true })
      try {
        if (i === 0) {
          width = image.displayWidth
          height = image.displayHeight
          const problem = imageSizeProblem(width, height)
          if (problem) throw new Error(problem)
          scale = gifScale(width, height, count)
        }
        delays.push((image.duration ?? 0) / 1000)
        frames.push(
          await createImageBitmap(image, {
            resizeWidth: Math.max(1, Math.round(width * scale)),
            resizeHeight: Math.max(1, Math.round(height * scale)),
            resizeQuality: 'high'
          })
        )
      } finally {
        image.close()
      }
    }
    if (frames.length === 1) return { kind: 'still', source: frames[0], width, height }
    return { kind: 'gif', frames, timing: gifTiming(delays), width, height }
  } catch (err) {
    for (const f of frames) f.close()
    throw err instanceof Error && /GIF|image/.test(err.message) ? err : new Error('This GIF could not be read.')
  } finally {
    decoder.close()
  }
}

function decode(o: Pick<ImageOverlay, 'file' | 'sticker'>, url: string): Promise<DecodedOverlay> {
  if (o.sticker) return decodeSvg(url, STICKER_SIDE)
  const ext = (o.file ?? '').split('.').pop()?.toLowerCase()
  if (ext === 'gif') return decodeGif(url)
  if (ext === 'svg') return decodeSvg(url)
  return decodeStill(url)
}

function urlOf(projectId: string, o: Pick<ImageOverlay, 'file' | 'sticker'>): string | null {
  if (o.sticker) {
    const s = stickerOf(o.sticker)
    return s ? stickerUrl(s) : null
  }
  return o.file ? mediaUrl(projectId, o.file) : null
}

function entryOf(projectId: string, o: Pick<ImageOverlay, 'file' | 'sticker'>, url?: string): Entry | null {
  if (typeof document === 'undefined' || typeof Image === 'undefined') return null
  switchProject(projectId)
  const key = keyOf(projectId, o)
  const hit = cache.get(key)
  if (hit) return hit
  const src = url ?? urlOf(projectId, o)
  const entry: Entry = { image: null, error: null, done: Promise.resolve() }
  cache.set(key, entry)
  if (!src) {
    entry.error = 'This image could not be read.'
    return entry
  }
  entry.done = decode(o, src).then(
    (image) => {
      if (cache.get(key) !== entry) return release({ image, error: null, done: entry.done })
      entry.image = image
      notifyStyleAssetsChanged()
    },
    (err: unknown) => {
      if (cache.get(key) !== entry) return
      entry.error = err instanceof Error ? err.message : 'This image could not be read.'
      console.warn(`Overlay ${o.file ?? o.sticker} could not be loaded:`, err)
      notifyStyleAssetsChanged()
    }
  )
  return entry
}

/**
 * Decodes an image newly copied into the project before the project uses it, and returns its
 * aspect (width / height). Rejects with a readable message when it cannot be shown; a failed
 * attempt is forgotten, so nothing points at it. An image that failed before is read again: its
 * file may be back under the same name.
 */
export async function preloadOverlay(projectId: string, o: Pick<ImageOverlay, 'file' | 'sticker'>, url?: string): Promise<number> {
  if (cache.get(keyOf(projectId, o))?.error) cache.delete(keyOf(projectId, o))
  const entry = entryOf(projectId, o, url)
  if (!entry) return 1
  await entry.done
  if (!entry.image) {
    cache.delete(keyOf(projectId, o))
    throw new Error(entry.error ?? 'This image could not be read.')
  }
  return entry.image.width / entry.image.height
}

/** What the panel says about an overlay's picture: decoding, ready (with its aspect) or why it cannot be shown. */
export function overlayStatus(
  projectId: string,
  o: Pick<ImageOverlay, 'file' | 'sticker'>
): { state: 'loading' } | { state: 'ready'; aspect: number; frames: number } | { state: 'failed'; error: string } {
  const e = entryOf(projectId, o)
  if (!e) return { state: 'loading' }
  if (e.image) return { state: 'ready', aspect: e.image.width / e.image.height, frames: e.image.kind === 'gif' ? e.image.frames.length : 1 }
  if (e.error) return { state: 'failed', error: e.error }
  return { state: 'loading' }
}

/** Overlays whose picture cannot be shown (a missing or unreadable file): left out of the video. */
export function missingOverlays(project: Pick<Project, 'id' | 'overlays'>): ImageOverlay[] {
  return (project.overlays ?? []).filter((o) => !!entryOf(project.id, o)?.error)
}

/** Waits for the pictures of every overlay (export: before the first frame). Never rejects. */
export async function prepareOverlays(project: Pick<Project, 'id' | 'overlays'>): Promise<void> {
  const waits: Promise<void>[] = []
  for (const o of project.overlays ?? []) {
    const e = entryOf(project.id, o)
    if (e) waits.push(e.done)
  }
  await Promise.all(waits)
}

/* ---------- drawing ---------- */

/** The picture of `image` at source time `t` for overlay `o` (a GIF's frame for that moment). */
function pictureAt(image: DecodedOverlay, o: ImageOverlay, t: number, project: Project): CanvasImageSource {
  if (image.kind === 'still') return image.source
  return image.frames[gifFrameAt(image.timing, overlayClockMs(o, t, project.clips))]
}

/**
 * The overlays visible at fc.t, in list order (later ones on top), over the finished frame in
 * output space: zoom never moves them. A picture still decoding is skipped (the preview repaints
 * when it arrives; the export waits for it in prepareOverlays).
 */
export function drawOverlaysLayer(fc: FrameContext): void {
  const overlays = fc.project.overlays
  if (!overlays?.length) return
  const { ctx, w, h, t, project } = fc
  for (const o of overlays) {
    if (!overlayVisibleAt(o, t)) continue
    const alpha = overlayAlpha(o, t, project.clips)
    if (alpha <= 0.002) continue
    const image = entryOf(project.id, o)?.image
    if (!image) continue
    const b = overlayBox(o, w, h)
    ctx.save()
    ctx.globalAlpha = alpha
    ctx.imageSmoothingEnabled = true
    ctx.imageSmoothingQuality = 'high'
    ctx.translate(b.cx, b.cy)
    if (b.angle) ctx.rotate(b.angle)
    ctx.drawImage(pictureAt(image, o, t, project), -b.w / 2, -b.h / 2, b.w, b.h)
    ctx.restore()
  }
}
