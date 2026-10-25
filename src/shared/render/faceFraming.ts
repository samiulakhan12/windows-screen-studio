/**
 * Face framing for the camera director (docs/design/camera-director.md, "Face framing"): one
 * static webcam framing (zoom, cropX, cropY) that centres the face, found from the person masks
 * of the bundled person segmentation (cameraLook.maskPixels: RGBA, alpha = person) on sampled camera
 * frames. No new model: the head is the top of the person's silhouette. Coordinates are
 * normalised to the unmirrored camera picture, which is what cropX/cropY address. Pure.
 *
 * CONTRACT (workstream B): signatures and constants are frozen; bodies are to be written.
 */
import type { Range } from '../audio/activity'

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
  return notImplemented(rgba, width, height)
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
  return notImplemented(faces, camW, camH, maxZoom)
}

/**
 * Camera times (seconds of the camera video) to sample: `shown` (source ranges where the result
 * shows the camera) split into equal slots by length, FACE.secondsPerSample each
 * (FACE.minSamples..maxSamples); in each slot the middle of its longest speech (people face
 * the camera while they talk), else the slot's middle. Source time t is camera time
 * t - webcamOffset; times outside [0, cameraDuration - 0.05] are skipped. Sorted.
 */
export function faceSampleTimes(shown: readonly Range[], speech: readonly Range[] | null, webcamOffset: number, cameraDuration: number): number[] {
  return notImplemented(shown, speech, webcamOffset, cameraDuration)
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

/** Placeholder of the contract; the implementation replaces every call. */
function notImplemented(...args: unknown[]): never {
  void args
  throw new Error('not implemented')
}
