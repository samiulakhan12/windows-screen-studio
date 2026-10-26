/**
 * Face framing for the camera director (docs/design/camera-director.md, "Face framing"): one
 * static webcam framing (zoom, cropX, cropY) that centres the face, found from the person masks
 * of the bundled person segmentation (cameraLook.maskPixels: RGBA, alpha = person) on sampled camera
 * frames. No new model: the head is the top of the person's silhouette. Coordinates are
 * normalised to the unmirrored camera picture, which is what cropX/cropY address. Pure.
 */
import { mergeRanges, type Range } from '../audio/activity'

/**
 * - mask: a pixel is the person at alpha >= `alphaOn`; under `minArea` of the picture nobody is there.
 * - body: columns with at least `bodyShare` of the fullest column's person pixels in the lower
 *   half; the head is searched within the body's centre +- `bandWidth` of its width.
 * - head top: the first row with at least max(2, `topRow` * width) person pixels in that band;
 *   below `maxTop` of the height it is only shoulders or a hand.
 * - shoulders: from `minHead` of the height below the top, the first of `shoulderRows` rows in a
 *   row each wider than `shoulder` x the widest row above it; without them the head is
 *   `headRows` of the height tall.
 * - head width: the `widthPercentile` of the row widths between the top and the shoulders (a
 *   median would read a round head too narrow); its height at most `headRatio` x its width;
 *   centre: the median of those rows' centres; the eyes `eye` of the way down the head.
 * - framing: the head fills `headShare` of the bubble's visible side; zoom at most `maxZoom`
 *   (the caller lowers it when the camera is shown large); under `minZoom` no zoom; a person
 *   whose centre moves more than `spread` (IQR of cx) gets at most `spreadZoom`; zoom steps of
 *   `zoomStep` (the slider's); the eyes `headroom` of the visible height above the crop centre.
 * - sampling: one frame per `secondsPerSample` s of camera time shown, `minSamples`..`maxSamples`;
 *   a framing needs at least max(`minFound`, `minFoundShare` of the samples) faces.
 * - a framing within `nearZoom` / `nearCrop` of the current one changes nothing.
 */
export const FACE = {
  alphaOn: 128,
  minArea: 0.02,
  bodyShare: 0.2,
  bandWidth: 0.6,
  topRow: 0.015,
  maxTop: 0.6,
  minHead: 0.1,
  shoulder: 1.6,
  shoulderRows: 3,
  headRows: 0.2,
  widthPercentile: 0.8,
  headRatio: 1.4,
  eye: 0.45,
  headShare: 0.42,
  maxZoom: 1.6,
  largeCameraZoom: 1.3,
  minZoom: 1.1,
  spread: 0.12,
  spreadZoom: 1.25,
  zoomStep: 0.05,
  headroom: 0.08,
  secondsPerSample: 6,
  minSamples: 6,
  maxSamples: 16,
  minFound: 4,
  minFoundShare: 0.4,
  nearZoom: 0.05,
  nearCrop: 0.01
} as const

/** Where the head is in one camera picture, normalised (0..1) to it. */
export interface FaceBox {
  /** Centre of the head. */
  cx: number
  cy: number
  /** Width and height of the head. */
  w: number
  h: number
  /** Height of the eyes. */
  eyeY: number
}

/**
 * The head in a person mask (RGBA pixels, alpha = person, `width` x `height`, the camera's
 * shape), or null when no one is there or only shoulders or a hand show (FACE).
 */
export function faceBoxOfMask(rgba: ArrayLike<number>, width: number, height: number): FaceBox | null {
  const W = Math.floor(width)
  const H = Math.floor(height)
  if (!(W > 0 && H > 0) || rgba.length < W * H * 4) return null
  const on = new Uint8Array(W * H)
  let area = 0
  for (let i = 0; i < W * H; i++) {
    if (rgba[i * 4 + 3] < FACE.alphaOn) continue
    on[i] = 1
    area++
  }
  if (area < FACE.minArea * W * H) return null

  // The body: the longest run of well-filled columns of the lower half (the whole picture when
  // only the top shows someone). Chair backs and hands at the edges make shorter runs.
  const band = bodyBand(on, W, H, Math.floor(H / 2)) ?? bodyBand(on, W, H, 0)
  if (!band) return null
  const x0 = Math.max(0, Math.floor(band.centre - FACE.bandWidth * band.width))
  const x1 = Math.min(W - 1, Math.ceil(band.centre + FACE.bandWidth * band.width))

  // Width and centre of each row within the band.
  const widths = new Float64Array(H)
  const centres = new Float64Array(H)
  for (let y = 0; y < H; y++) {
    let n = 0
    let sum = 0
    for (let x = x0; x <= x1; x++) {
      if (on[y * W + x]) {
        n++
        sum += x + 0.5
      }
    }
    widths[y] = n
    centres[y] = n > 0 ? sum / n : NaN
  }

  const minRow = Math.max(2, FACE.topRow * W)
  let top = -1
  for (let y = 0; y < H && top < 0; y++) if (widths[y] >= minRow) top = y
  if (top < 0 || top > FACE.maxTop * H) return null

  // Shoulders: the first rows clearly wider than everything above them (the head).
  let shoulders = -1
  let widest = 0
  for (let y = top; y < H; y++) {
    if (y >= top + FACE.minHead * H && y + FACE.shoulderRows <= H) {
      let wide = true
      for (let k = 0; k < FACE.shoulderRows && wide; k++) wide = widths[y + k] > FACE.shoulder * widest
      if (wide) {
        shoulders = y
        break
      }
    }
    widest = Math.max(widest, widths[y])
  }
  if (shoulders < 0) shoulders = Math.min(H, Math.round(top + FACE.headRows * H))

  const rows: number[] = []
  const mids: number[] = []
  for (let y = top; y < shoulders; y++) {
    if (widths[y] <= 0) continue
    rows.push(widths[y])
    mids.push(centres[y])
  }
  if (rows.length === 0) return null
  const w = quantile(rows, FACE.widthPercentile)
  const h = Math.min(shoulders - top, FACE.headRatio * w)
  const cx = quantile(mids, 0.5)
  return { cx: cx / W, cy: (top + h / 2) / H, w: w / W, h: h / H, eyeY: (top + FACE.eye * h) / H }
}

/** Centre and width (columns) of the longest run of columns well filled from row `from` down, or null. */
function bodyBand(on: Uint8Array, W: number, H: number, from: number): { centre: number; width: number } | null {
  const counts = new Uint32Array(W)
  for (let y = from; y < H; y++) for (let x = 0; x < W; x++) counts[x] += on[y * W + x]
  let fullest = 0
  for (const c of counts) fullest = Math.max(fullest, c)
  if (fullest === 0) return null
  let best = { start: 0, end: 0 }
  let start = -1
  for (let x = 0; x <= W; x++) {
    const filled = x < W && counts[x] >= FACE.bodyShare * fullest
    if (filled && start < 0) start = x
    else if (!filled && start >= 0) {
      if (x - start > best.end - best.start) best = { start, end: x }
      start = -1
    }
  }
  return { centre: (best.start + best.end) / 2, width: best.end - best.start }
}

/** The `q` quantile (0..1, linear between neighbours) of `values`. */
function quantile(values: readonly number[], q: number): number {
  const sorted = [...values].sort((a, b) => a - b)
  const at = (sorted.length - 1) * q
  const lo = Math.floor(at)
  const hi = Math.min(sorted.length - 1, lo + 1)
  return sorted[lo] + (sorted[hi] - sorted[lo]) * (at - lo)
}

/** A webcam framing that centres the face, and how it was found. */
export interface FaceFraming {
  zoom: number
  cropX: number
  cropY: number
  /** Faces found, of the pictures sampled. */
  found: number
  sampled: number
  /** False when the person moves around (the zoom was held back). */
  steady: boolean
}

/**
 * The framing for the faces of the sampled pictures (null where none was found) of a `camW` x
 * `camH` camera: medians of the head centre, eyes and width; zoom so the head fills
 * FACE.headShare of a square bubble, at most `maxZoom`; rounded as the Framing section does
 * (zoom to FACE.zoomStep, crops to 4 decimals). Null when too few faces were found.
 */
export function framingFromFaces(faces: readonly (FaceBox | null)[], camW: number, camH: number, maxZoom: number): FaceFraming | null {
  const found = faces.filter((f): f is FaceBox => f !== null && [f.cx, f.eyeY, f.w].every(Number.isFinite) && f.w > 0)
  const sampled = faces.length
  if (found.length < FACE.minFound || found.length < FACE.minFoundShare * sampled || !(camW > 0 && camH > 0)) return null
  const cx = quantile(found.map((f) => f.cx), 0.5)
  const eyeY = quantile(found.map((f) => f.eyeY), 0.5)
  const width = quantile(found.map((f) => f.w), 0.5)
  const xs = found.map((f) => f.cx)
  const steady = quantile(xs, 0.75) - quantile(xs, 0.25) <= FACE.spread
  const cap = Math.max(1, Number.isFinite(maxZoom) ? maxZoom : FACE.maxZoom)
  const side = Math.min(camW, camH)
  let zoom = Math.min(cap, Math.max(1, (FACE.headShare * side) / (width * camW)))
  if (zoom < FACE.minZoom) zoom = 1
  if (!steady) zoom = Math.min(zoom, FACE.spreadZoom)
  zoom = Math.min(cap, round(Math.round(zoom / FACE.zoomStep) * FACE.zoomStep, 4))
  const cropY = Math.min(1, Math.max(0, eyeY + (FACE.headroom * (side / zoom)) / camH))
  return { zoom, cropX: round(Math.min(1, Math.max(0, cx)), 4), cropY: round(cropY, 4), found: found.length, sampled, steady }
}

const round = (v: number, digits: number): number => Number(v.toFixed(digits))

/**
 * Camera times (seconds of the camera video) to sample: `shown` (source ranges where the result
 * shows the camera) split into equal slots by length, FACE.secondsPerSample each
 * (FACE.minSamples..maxSamples); in each slot the middle of its longest speech (people face
 * the camera while they talk), else the slot's middle. Source time t is camera time
 * t - webcamOffset; times outside [0, cameraDuration - 0.05] are skipped. Sorted.
 */
export function faceSampleTimes(shown: readonly Range[], speech: readonly Range[] | null, webcamOffset: number, cameraDuration: number): number[] {
  const parts = mergeRanges(shown.filter((r) => Number.isFinite(r.start) && Number.isFinite(r.end)))
  const total = parts.reduce((sum, r) => sum + (r.end - r.start), 0)
  if (!(total > 0)) return []
  const talk = mergeRanges((speech ?? []).filter((r) => Number.isFinite(r.start) && Number.isFinite(r.end)))
  const n = Math.min(FACE.maxSamples, Math.max(FACE.minSamples, Math.round(total / FACE.secondsPerSample)))
  const last = cameraDuration - 0.05
  const times = new Set<number>()
  for (let k = 0; k < n; k++) {
    const slot = slice(parts, (k * total) / n, ((k + 1) * total) / n)
    let best: Range | null = null
    for (const r of slot) {
      for (const s of talk) {
        const a = Math.max(r.start, s.start)
        const b = Math.min(r.end, s.end)
        if (b > a && (!best || b - a > best.end - best.start + 1e-9)) best = { start: a, end: b }
      }
    }
    const t = best ? (best.start + best.end) / 2 : pointAt(slot, slot.reduce((sum, r) => sum + (r.end - r.start), 0) / 2)
    const cam = t - webcamOffset
    if (cam >= 0 && cam <= last) times.add(cam)
  }
  return [...times].sort((a, b) => a - b)
}

/** The pieces of sorted, separate `parts` between `from` and `to` seconds of their joined length. */
function slice(parts: readonly Range[], from: number, to: number): Range[] {
  const out: Range[] = []
  let acc = 0
  for (const r of parts) {
    const len = r.end - r.start
    const a = Math.max(from, acc)
    const b = Math.min(to, acc + len)
    if (b > a) out.push({ start: r.start + (a - acc), end: r.start + (b - acc) })
    acc += len
  }
  return out
}

/** The time `offset` seconds into the joined length of `parts`. */
function pointAt(parts: readonly Range[], offset: number): number {
  let left = offset
  for (const r of parts) {
    if (left <= r.end - r.start) return r.start + left
    left -= r.end - r.start
  }
  return parts[parts.length - 1].end
}

/** What face framing came to, as the director applies it and the Camera panel reports it. */
export type FramingOutcome =
  /** A framing was found (it is applied unless it is within FACE.nearZoom / nearCrop of the current one). */
  | { status: 'framed'; zoom: number; cropX: number; cropY: number; found: number; sampled: number; steady: boolean }
  /** Too few faces in the sampled pictures: the framing is left as it is. */
  | { status: 'not-found'; found: number; sampled: number }
  /** Person detection cannot run here (no WebGL, the worker failed): `reason` as segmenterState says it. */
  | { status: 'unavailable'; reason: string }
  /** Not asked for (the option is off, or the framing is the user's). */
  | { status: 'skipped' }
