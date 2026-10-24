import { cameraSourceRect, layoutPhaseAt, sceneCameraBox, type Rect } from '../../../shared/engine/layout'
import { webcamLook } from '../../../shared/engine/webcamData'
import { backgroundBlurRadius, BLUR_DOWNSCALE, cameraShadow, shadowReach } from '../../../shared/render/cameraLook'
import type { FrameImage } from './compositor'
import type { FrameContext } from './frameContext'
import { livePicture, maskOf, releaseLivePicture } from './segmentation/cameraMasks'
import type { PersonMask } from './segmentation/personSegmenter'
import { roundRectPath } from './staticLayer'

type Ctx = CanvasRenderingContext2D
type Shadow = NonNullable<ReturnType<typeof cameraShadow>>

/** Canvases one target keeps between frames: the shadow sprite and the background-blur composite. */
interface LayerState {
  shadow?: { canvas: HTMLCanvasElement; key: string; x: number; y: number }
  blur?: BlurState
}

interface BlurState {
  /** The camera picture cut out along the person (camera pixels, unmirrored). */
  person: HTMLCanvasElement
  /** The picture small, with a stretched margin so the blur does not fade at the edges; then blurred. */
  tmp: HTMLCanvasElement
  blurred: HTMLCanvasElement
  /** The mask as segmentation returned it, and softened by a pixel so its steps do not show when scaled up. */
  rawMask: HTMLCanvasElement
  mask: HTMLCanvasElement
  margin: number
  /** What the canvases hold now: redone only for a new camera frame, mask or blur amount. */
  image: unknown
  pixels: ImageData | null
  amount: number
}

const states = new WeakMap<Ctx, LayerState>()
const hasDocument = (): boolean => typeof document !== 'undefined'

function stateOf(ctx: Ctx): LayerState {
  let s = states.get(ctx)
  if (!s) {
    s = {}
    states.set(ctx, s)
  }
  return s
}

function sized(c: HTMLCanvasElement | undefined, w: number, h: number): HTMLCanvasElement {
  const canvas = c ?? document.createElement('canvas')
  const cw = Math.max(1, Math.ceil(w))
  const ch = Math.max(1, Math.ceil(h))
  if (canvas.width !== cw || canvas.height !== ch) {
    canvas.width = cw
    canvas.height = ch
  }
  return canvas
}

/**
 * The camera: a bubble over the frame or a card of the camera layout in effect (not affected by
 * the zoom camera), with its shape, border, drop shadow, mirroring, framing (zoom and crop) and
 * background blur. Old projects (none of these set) draw the original mirrored circle with a
 * white ring and a soft shadow.
 */
export function drawWebcamLayer(fc: FrameContext, camera: FrameImage | null): void {
  const { ctx, project, w, h, k } = fc
  if (!project.webcam.show || !camera) return
  const box = sceneCameraBox(project, w, h, fc.vw, fc.vh, fc.t)
  if (!box || box.opacity < 0.004 || box.rect.w < 1 || box.rect.h < 1) return
  const look = webcamLook(project.webcam)
  const { picture, mask } = pictureOf(camera, look.backgroundBlur)
  const r = box.rect
  const state = stateOf(ctx)
  const settled = layoutPhaseAt(project, fc.t).progress >= 1

  ctx.save()
  if (box.opacity < 1) ctx.globalAlpha = box.opacity
  const shadow = cameraShadow(look.shadow, k)
  if (shadow) drawShadow(ctx, state, r, box.radius, shadow, settled && box.opacity >= 1)

  ctx.save()
  roundRectPath(ctx, r, box.radius)
  ctx.clip()
  // Mirrored like a selfie view (the default).
  if (look.mirror) {
    ctx.translate(r.x * 2 + r.w, 0)
    ctx.scale(-1, 1)
  }
  ctx.imageSmoothingEnabled = true
  ctx.imageSmoothingQuality = 'high'
  const src = cameraSourceRect(picture.width, picture.height, r.w, r.h, look)
  if (mask && look.backgroundBlur > 0 && hasDocument()) drawBlurred(ctx, state, picture, mask, look.backgroundBlur, src, r)
  else ctx.drawImage(picture.image, src.x, src.y, src.w, src.h, r.x, r.y, r.w, r.h)
  ctx.restore()

  if (look.border.width > 0) {
    roundRectPath(ctx, r, box.radius)
    ctx.lineWidth = look.border.width * k
    ctx.strokeStyle = look.border.color
    ctx.stroke()
  }
  ctx.restore()
}

/**
 * The picture to draw and its person mask. Decoded frames (export) carry a mask prepared before
 * the frame was drawn; the preview's camera element hands over its latest frame with its mask.
 * Without a mask the camera is drawn unblurred.
 */
function pictureOf(camera: FrameImage, blur: number): { picture: FrameImage; mask: PersonMask | null } {
  const img = camera.image
  if (typeof HTMLVideoElement !== 'undefined' && img instanceof HTMLVideoElement) {
    if (!(blur > 0)) {
      releaseLivePicture(img)
      return { picture: camera, mask: null }
    }
    const live = livePicture(img)
    return live ? { picture: live, mask: live.mask } : { picture: camera, mask: null }
  }
  return { picture: camera, mask: blur > 0 ? maskOf(img) : null }
}

/**
 * The drop shadow (with a black copy of the shape, which the picture covers). A camera standing
 * still uses a sprite made once; a moving or fading one is drawn directly, its shadow kept
 * outside the shape so nothing dark shows through the fading picture.
 */
function drawShadow(ctx: Ctx, state: LayerState, r: Rect, radius: number, s: Shadow, still: boolean): void {
  const paint = (c: Ctx, x: number, y: number): void => {
    c.shadowColor = s.color
    c.shadowBlur = s.blur
    c.shadowOffsetY = s.offsetY
    c.fillStyle = '#000'
    roundRectPath(c, { x, y, w: r.w, h: r.h }, radius)
    c.fill()
  }
  if (!still || !hasDocument()) {
    ctx.save()
    if (!still) {
      const reach = shadowReach(s)
      ctx.beginPath()
      ctx.rect(r.x - reach, r.y - reach, r.w + reach * 2, r.h + reach * 2)
      ctx.roundRect(r.x, r.y, r.w, r.h, Math.max(0, Math.min(radius, r.w / 2, r.h / 2)))
      ctx.clip('evenodd')
    }
    paint(ctx, r.x, r.y)
    ctx.restore()
    return
  }
  const reach = shadowReach(s)
  // Sub-pixel placement is kept inside the sprite, so it lands exactly where a direct draw would.
  const x0 = Math.floor(r.x) - reach
  const y0 = Math.floor(r.y) - reach
  const fx = r.x - x0
  const fy = r.y - y0
  const key = [r.w, r.h, fx, fy, radius, s.color, s.blur, s.offsetY].map((v) => (typeof v === 'number' ? v.toFixed(2) : v)).join()
  let sprite = state.shadow
  if (!sprite || sprite.key !== key) {
    const canvas = sized(sprite?.canvas, fx + r.w + reach, fy + r.h + reach)
    const c = canvas.getContext('2d')
    if (!c) {
      paint(ctx, r.x, r.y)
      return
    }
    c.clearRect(0, 0, canvas.width, canvas.height)
    c.save()
    paint(c, fx, fy)
    c.restore()
    sprite = { canvas, key, x: x0, y: y0 }
    state.shadow = sprite
  }
  ctx.drawImage(sprite.canvas, x0, y0)
}

/**
 * Background blur: the blurred picture with the sharp person on top. Both are made at the
 * camera's own size (unmirrored, uncropped) once per camera frame, so a paused preview, a crop
 * or a layout change reuses them; the shown part is then drawn into the box like the plain picture.
 */
function drawBlurred(ctx: Ctx, state: LayerState, pic: FrameImage, mask: PersonMask, amount: number, src: Rect, r: Rect): void {
  const W = pic.width
  const H = pic.height
  const sw = Math.max(1, Math.ceil(W * BLUR_DOWNSCALE))
  const sh = Math.max(1, Math.ceil(H * BLUR_DOWNSCALE))
  const sigma = Math.max(0.5, backgroundBlurRadius(amount, W, H) * BLUR_DOWNSCALE)
  const margin = Math.ceil(sigma * 3)
  const prev = state.blur
  const b: BlurState = {
    person: sized(prev?.person, W, H),
    tmp: sized(prev?.tmp, sw + margin * 2, sh + margin * 2),
    blurred: sized(prev?.blurred, sw + margin * 2, sh + margin * 2),
    rawMask: sized(prev?.rawMask, mask.pixels.width, mask.pixels.height),
    mask: sized(prev?.mask, mask.pixels.width, mask.pixels.height),
    margin,
    image: prev?.image,
    pixels: prev?.pixels ?? null,
    amount: prev?.amount ?? NaN
  }
  state.blur = b
  if (b.image !== pic.image || b.pixels !== mask.pixels || b.amount !== amount) {
    const pctx = b.person.getContext('2d')
    const tctx = b.tmp.getContext('2d')
    const bctx = b.blurred.getContext('2d')
    const rctx = b.rawMask.getContext('2d')
    const mctx = b.mask.getContext('2d')
    if (!pctx || !tctx || !bctx || !rctx || !mctx) {
      ctx.drawImage(pic.image, src.x, src.y, src.w, src.h, r.x, r.y, r.w, r.h)
      return
    }
    if (b.pixels !== mask.pixels) {
      rctx.putImageData(mask.pixels, 0, 0)
      mctx.clearRect(0, 0, b.mask.width, b.mask.height)
      mctx.filter = 'blur(0.7px)'
      mctx.drawImage(b.rawMask, 0, 0)
      mctx.filter = 'none'
    }
    // The person: the picture, kept only where the (smoothly scaled-up) mask is.
    pctx.globalCompositeOperation = 'copy'
    pctx.drawImage(pic.image, 0, 0, W, H, 0, 0, W, H)
    pctx.globalCompositeOperation = 'destination-in'
    pctx.imageSmoothingEnabled = true
    pctx.imageSmoothingQuality = 'high'
    pctx.drawImage(b.mask, 0, 0, b.mask.width, b.mask.height, 0, 0, W, H)
    pctx.globalCompositeOperation = 'source-over'
    // The background: the picture small, stretched under the margins, then blurred once.
    tctx.imageSmoothingEnabled = true
    tctx.drawImage(pic.image, 0, 0, W, H, 0, 0, b.tmp.width, b.tmp.height)
    tctx.drawImage(pic.image, 0, 0, W, H, margin, margin, sw, sh)
    bctx.clearRect(0, 0, b.blurred.width, b.blurred.height)
    bctx.filter = `blur(${sigma.toFixed(2)}px)`
    bctx.drawImage(b.tmp, 0, 0)
    bctx.filter = 'none'
    b.image = pic.image
    b.pixels = mask.pixels
    b.amount = amount
  }
  const kx = sw / W
  const ky = sh / H
  ctx.drawImage(b.blurred, margin + src.x * kx, margin + src.y * ky, src.w * kx, src.h * ky, r.x, r.y, r.w, r.h)
  ctx.drawImage(b.person, src.x, src.y, src.w, src.h, r.x, r.y, r.w, r.h)
}
