import { cameraBoxShown, cameraSourceRect, layoutPhaseAt, sceneCameraBox, type Rect } from '../../../shared/engine/layout'
import { webcamLook } from '../../../shared/engine/webcamData'
import { backgroundBlurRadius, BLUR_DOWNSCALE, cameraShadow, shadowReach } from '../../../shared/render/cameraLook'
import type { FrameImage } from './compositor'
import type { FrameContext } from './frameContext'
import { livePicture, maskOf, releaseLivePicture } from './segmentation/cameraMasks'
import type { PersonMask } from './segmentation/personSegmenter'
import { roundRectPath } from './staticLayer'

type Ctx = CanvasRenderingContext2D
type Shadow = NonNullable<ReturnType<typeof cameraShadow>>

/**
 * What one target keeps between frames: the shadow sprite, the background-blur composite, and
 * the preview camera it draws blurred (segmented in the background while it does).
 */
interface LayerState {
  shadow?: { canvas: HTMLCanvasElement; key: string; x: number; y: number }
  blur?: BlurState
  live?: HTMLVideoElement
}

interface BlurState {
  /**
   * The finished picture (camera pixels, unmirrored): the person cut out along the mask over the
   * blurred background, so a fading camera is drawn once at its opacity, never one over the other.
   */
  person: HTMLCanvasElement
  /** The picture small, with a stretched margin so the blur does not fade at the edges; then blurred. */
  tmp: HTMLCanvasElement
  blurred: HTMLCanvasElement
  /** The mask as segmentation returned it, and softened by a pixel so its steps do not show when scaled up. */
  rawMask: HTMLCanvasElement
  mask: HTMLCanvasElement
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

/** Gives `c` this size (at least 1 x 1); true when that changed it (which clears it). */
function resize(c: HTMLCanvasElement, w: number, h: number): boolean {
  const cw = Math.max(1, Math.ceil(w))
  const ch = Math.max(1, Math.ceil(h))
  if (c.width === cw && c.height === ch) return false
  c.width = cw
  c.height = ch
  return true
}

/**
 * The camera: a bubble over the frame or a card of the camera layout in effect (not affected by
 * the zoom camera), with its shape, border, drop shadow, mirroring, framing (zoom and crop) and
 * background blur. Old projects (none of these set) draw the original mirrored circle with a
 * white ring and a soft shadow.
 */
export function drawWebcamLayer(fc: FrameContext, camera: FrameImage | null): void {
  const { ctx, project, w, h, k } = fc
  if (!project.webcam.show) {
    // Hidden: the preview camera stops being segmented.
    if (states.has(ctx)) drawLive(stateOf(ctx), null)
    return
  }
  if (!camera) return
  const box = sceneCameraBox(project, w, h, fc.vw, fc.vh, fc.t)
  // The export prepares person masks with the same test (cameraShownAt): a hidden frame has none.
  if (!cameraBoxShown(box)) return
  const look = webcamLook(project.webcam)
  const state = stateOf(ctx)
  const { picture, mask } = pictureOf(camera, look.backgroundBlur, state)
  const r = box.rect
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
 * The picture to draw and its person mask. Frames the export draws carry a mask prepared before
 * they were drawn (or none: that frame is drawn unblurred); the preview's camera element hands
 * over its latest frame with its own mask. Without a mask the camera is drawn unblurred.
 */
function pictureOf(camera: FrameImage, blur: number, state: LayerState): { picture: FrameImage; mask: PersonMask | null } {
  const img = camera.image
  const prepared = blur > 0 ? maskOf(img) : null
  const element = typeof HTMLVideoElement !== 'undefined' && img instanceof HTMLVideoElement ? img : null
  if (prepared !== undefined || !element) {
    drawLive(state, null)
    if (element) releaseLivePicture(element)
    return { picture: camera, mask: prepared ?? null }
  }
  drawLive(state, element)
  const live = livePicture(element)
  return live ? { picture: live, mask: live.mask } : { picture: camera, mask: null }
}

/** Notes the preview camera this target draws blurred (null: none); one it no longer draws so stops being segmented. */
function drawLive(state: LayerState, video: HTMLVideoElement | null): void {
  if (state.live && state.live !== video) releaseLivePicture(state.live)
  state.live = video ?? undefined
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
    const canvas = sprite?.canvas ?? document.createElement('canvas')
    resize(canvas, fx + r.w + reach, fy + r.h + reach)
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
 * Background blur: the blurred picture with the sharp person on top, put together at the
 * camera's own size (unmirrored, uncropped) once per camera frame, so a paused preview, a crop
 * or a layout change reuses it; the shown part is then drawn into the box like the plain picture.
 */
function drawBlurred(ctx: Ctx, state: LayerState, pic: FrameImage, mask: PersonMask, amount: number, src: Rect, r: Rect): void {
  const W = pic.width
  const H = pic.height
  const sw = Math.max(1, Math.ceil(W * BLUR_DOWNSCALE))
  const sh = Math.max(1, Math.ceil(H * BLUR_DOWNSCALE))
  const sigma = Math.max(0.5, backgroundBlurRadius(amount, W, H) * BLUR_DOWNSCALE)
  const margin = Math.ceil(sigma * 3)
  if (!state.blur) {
    const c = (): HTMLCanvasElement => document.createElement('canvas')
    state.blur = { person: c(), tmp: c(), blurred: c(), rawMask: c(), mask: c(), image: null, pixels: null, amount: NaN }
  }
  const b = state.blur
  // A resized canvas is cleared: what it held is made again.
  let cleared = resize(b.person, W, H)
  cleared = resize(b.tmp, sw + margin * 2, sh + margin * 2) || cleared
  cleared = resize(b.blurred, sw + margin * 2, sh + margin * 2) || cleared
  if (cleared) b.image = null
  let maskCleared = resize(b.rawMask, mask.pixels.width, mask.pixels.height)
  maskCleared = resize(b.mask, mask.pixels.width, mask.pixels.height) || maskCleared
  if (maskCleared) b.pixels = null
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
    // The background: the picture small, stretched under the margins, then blurred once.
    tctx.imageSmoothingEnabled = true
    tctx.drawImage(pic.image, 0, 0, W, H, 0, 0, b.tmp.width, b.tmp.height)
    tctx.drawImage(pic.image, 0, 0, W, H, margin, margin, sw, sh)
    bctx.clearRect(0, 0, b.blurred.width, b.blurred.height)
    bctx.filter = `blur(${sigma.toFixed(2)}px)`
    bctx.drawImage(b.tmp, 0, 0)
    bctx.filter = 'none'
    // The person: the picture, kept only where the (smoothly scaled-up) mask is, then the blurred
    // background behind it. The mask and the background are soft pictures scaled up from small
    // ones: bilinear looks the same as cubic there and costs a fraction without a GPU (perf audit F1).
    pctx.imageSmoothingEnabled = true
    pctx.imageSmoothingQuality = 'low'
    pctx.globalCompositeOperation = 'copy'
    pctx.drawImage(pic.image, 0, 0, W, H, 0, 0, W, H)
    pctx.globalCompositeOperation = 'destination-in'
    pctx.drawImage(b.mask, 0, 0, b.mask.width, b.mask.height, 0, 0, W, H)
    pctx.globalCompositeOperation = 'destination-over'
    pctx.drawImage(b.blurred, margin, margin, sw, sh, 0, 0, W, H)
    pctx.globalCompositeOperation = 'source-over'
    b.image = pic.image
    b.pixels = mask.pixels
    b.amount = amount
  }
  // One draw of the sharp picture (with the caller's 'high' smoothing), at the camera's opacity.
  ctx.drawImage(b.person, src.x, src.y, src.w, src.h, r.x, r.y, r.w, r.h)
}
