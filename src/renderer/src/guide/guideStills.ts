/**
 * The guide's screenshots (docs/design/smart-tools.md §5.5.2, §5.5.6): each drawn by the export's
 * own path (prepareFrames, openSource, drawFrame) from the guide's project (guideProject: every blur
 * and pixelate shape, nothing laid over the recording), at the cropped recording's own size, then
 * cut to the shot's part of the frame, scaled down with high-quality smoothing, the ring or arrow
 * drawn into it, and encoded. One decoder pass serves every shot.
 */
import type { Rect } from '../../../shared/engine/layout'
import { visibleSize } from '../../../shared/engine/crop'
import type { GuideImage } from '../../../shared/guide/guideDoc'
import { arrowOf, ringColour, ringOf, shotSize, SHOT, visibleRect } from '../../../shared/guide/shots'
import type { ExportSettings } from '../../../shared/types'
import { drawFrame } from '../render/compositor'
import { releaseGrade } from '../render/gradeLayer'
import { releaseTilt } from '../render/tiltLayer'
import { openSource, prepareFrames, type ThumbnailInput } from '../editor/exporter'
import { SCREEN_PROXY_FPS } from '../editor/media'

const even = (v: number): number => Math.max(2, Math.round(v / 2) * 2)

/** The bytes of a canvas encoded as `mime`. */
export async function canvasBytes(canvas: HTMLCanvasElement, mime: GuideImage['mime'], quality: number): Promise<Uint8Array> {
  const blob = await new Promise<Blob | null>((resolve) => canvas.toBlob(resolve, mime, quality))
  if (!blob) throw new Error('Could not make the screenshot.')
  return new Uint8Array(await blob.arrayBuffer())
}

/** The ring (a halo outside it) and the arrow (a halo around it) drawn into a shot. */
export function drawMarks(ctx: CanvasRenderingContext2D, colour: string, ring: ReturnType<typeof ringOf>, arrow: ReturnType<typeof arrowOf>): void {
  ctx.save()
  ctx.lineCap = 'round'
  ctx.lineJoin = 'round'
  if (arrow) {
    const angle = Math.atan2(arrow.y1 - arrow.y0, arrow.x1 - arrow.x0)
    const head = (): void => {
      ctx.beginPath()
      ctx.moveTo(arrow.x1, arrow.y1)
      ctx.lineTo(arrow.x1 - arrow.head * Math.cos(angle - Math.PI / 7), arrow.y1 - arrow.head * Math.sin(angle - Math.PI / 7))
      ctx.lineTo(arrow.x1 - arrow.head * Math.cos(angle + Math.PI / 7), arrow.y1 - arrow.head * Math.sin(angle + Math.PI / 7))
      ctx.closePath()
    }
    const halo = arrow.width * 0.75
    for (const [stroke, width] of [
      ['#ffffff', arrow.width + 2 * halo],
      [colour, arrow.width]
    ] as const) {
      ctx.strokeStyle = stroke
      ctx.fillStyle = stroke
      ctx.lineWidth = width
      ctx.beginPath()
      ctx.moveTo(arrow.x0, arrow.y0)
      ctx.lineTo(arrow.x1, arrow.y1)
      ctx.stroke()
      head()
      ctx.fill()
      ctx.stroke()
    }
  }
  if (ring) {
    ctx.beginPath()
    ctx.arc(ring.cx, ring.cy, ring.r + ring.width / 2 + ring.halo / 2, 0, Math.PI * 2)
    ctx.strokeStyle = '#ffffff'
    ctx.lineWidth = ring.halo
    ctx.stroke()
    ctx.beginPath()
    ctx.arc(ring.cx, ring.cy, ring.r, 0, Math.PI * 2)
    ctx.strokeStyle = colour
    ctx.lineWidth = ring.width
    ctx.stroke()
  }
  ctx.restore()
}

/**
 * The shots of `input` (its `project` the guide's project, guideProject), in time order, one decoder
 * pass: each frame drawn as the export draws it at the cropped recording's size (at most 3840 px
 * wide), cut to the shot's `rect` (pixels of the recorded frame), at most `maxWidth` wide, with its
 * ring and arrow (computed for that width), as `mime` at `quality`. Stops at `signal`.
 */
export async function* renderGuideStills(
  input: ThumbnailInput,
  shots: readonly { key: string; t: number; rect: Rect; ring: ReturnType<typeof ringOf>; arrow: ReturnType<typeof arrowOf> }[],
  opts: { mime: GuideImage['mime']; quality: number; maxWidth: number; signal: AbortSignal }
): AsyncGenerator<{ key: string; image: GuideImage }> {
  if (!shots.length || opts.signal.aborted) return
  const raw = input.project
  const shown = visibleSize(raw)
  const scale = Math.min(1, SHOT.maxSource / Math.max(1, shown.width))
  const fps = raw.capture?.fps ?? 60
  const settings: ExportSettings = { format: 'mp4', resolution: even(shown.height * scale) as ExportSettings['resolution'], fps: fps >= 45 ? 60 : 30, quality: 'high', encoder: 'auto' }
  const prepared = await prepareFrames({ ...input, settings: { ...settings, aspect: undefined } })
  const drawW = even(shown.width * scale)
  const drawH = even(shown.height * scale)
  const frame = { w: raw.width, h: raw.height }
  const vis = visibleRect(frame, raw.crop ?? null)
  const colour = ringColour(raw)
  const order = [...shots].sort((a, b) => a.t - b.t)
  const caps = await window.api.exportCapabilities()
  const videos: HTMLVideoElement[] = []
  const source = await openSource(prepared.screenUrl, order.map((s) => s.t), caps, videos, SCREEN_PROXY_FPS)
  const canvas = document.createElement('canvas')
  canvas.width = drawW
  canvas.height = drawH
  const ctx = canvas.getContext('2d', { alpha: false })
  if (!ctx) throw new Error('Could not create a drawing surface')
  const out = document.createElement('canvas')
  const octx = out.getContext('2d', { alpha: false })
  if (!octx) throw new Error('Could not create a drawing surface')
  const placeholder = document.createElement('video')
  try {
    for (let i = 0; i < order.length; i++) {
      if (opts.signal.aborted) return
      const s = order[i]
      const screenFrame = await source.get(i)
      drawFrame(ctx, drawW, drawH, s.t, prepared.scene, { screen: placeholder, webcam: null, background: null, screenFrame, webcamFrame: null }, { frameInterval: 1 / fps, blurSamples: 1 }, s.t)
      source.next()
      const size = shotSize(s.rect, opts.maxWidth)
      out.width = size.w
      out.height = size.h
      octx.imageSmoothingEnabled = true
      octx.imageSmoothingQuality = 'high'
      const kx = drawW / vis.w
      const ky = drawH / vis.h
      octx.drawImage(canvas, (s.rect.x - vis.x) * kx, (s.rect.y - vis.y) * ky, s.rect.w * kx, s.rect.h * ky, 0, 0, size.w, size.h)
      drawMarks(octx, colour, s.ring, s.arrow)
      const bytes = await canvasBytes(out, opts.mime, opts.quality)
      if (opts.signal.aborted) return
      yield { key: s.key, image: { bytes, mime: opts.mime, width: size.w, height: size.h } }
    }
  } finally {
    releaseTilt(ctx)
    releaseGrade(ctx)
    source.close()
    for (const v of videos) {
      v.removeAttribute('src')
      v.load()
    }
  }
}

/**
 * `image` as `mime` at most `maxWidth` wide (§5.5.5: JPEG for the PDF, WebP for HTML and demos, PNG
 * for Markdown and the clipboard): the same image when it already is.
 */
export async function encodeImage(image: GuideImage, mime: GuideImage['mime'], quality: number, maxWidth: number): Promise<GuideImage> {
  if (image.mime === mime && image.width <= maxWidth) return image
  const bitmap = await createImageBitmap(new Blob([new Uint8Array(image.bytes)], { type: image.mime }))
  try {
    const w = Math.max(1, Math.min(maxWidth, bitmap.width))
    const h = Math.max(1, Math.round((w * bitmap.height) / bitmap.width))
    const canvas = document.createElement('canvas')
    canvas.width = w
    canvas.height = h
    const ctx = canvas.getContext('2d', { alpha: false })
    if (!ctx) throw new Error('Could not create a drawing surface')
    ctx.imageSmoothingEnabled = true
    ctx.imageSmoothingQuality = 'high'
    ctx.drawImage(bitmap, 0, 0, w, h)
    return { bytes: await canvasBytes(canvas, mime, quality), mime, width: w, height: h }
  } finally {
    bitmap.close()
  }
}
