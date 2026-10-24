/**
 * Person masks for the camera pictures the webcam layer draws. drawFrame never waits, so masks
 * are made ahead of it:
 * - export and thumbnails: CameraMaskPreparer segments each decoded camera frame before it is
 *   drawn and attaches the mask to that frame (maskOf finds it);
 * - preview: the camera is a playing or paused <video>; livePicture() hands the layer the latest
 *   camera frame together with its own mask, segmented in the background, so the picture and
 *   its mask always belong together (the preview may show the camera one frame late while
 *   playing; the export never does). A new pair is announced through onCameraMasksChanged.
 * A frame without a mask (its picture failed, or segmentation cannot run) is drawn unblurred.
 */
import type { FrameImage } from '../compositor'
import { ensureSegmenter, onSegmenterState, segmentPicture, segmenterState, type PersonMask } from './personSegmenter'

const attached = new WeakMap<object, PersonMask | null>()

/**
 * The mask prepared for a camera frame the export draws: null when that frame has none (it is
 * drawn unblurred), undefined when it was not prepared (the preview's camera).
 */
export const maskOf = (image: CanvasImageSource): PersonMask | null | undefined => attached.get(image)

/** Which camera frame an image shows: a decoded frame's timestamp, a seeked element's time (µs); NaN when unknown. */
function stampOf(image: CanvasImageSource): number {
  if (typeof VideoFrame !== 'undefined' && image instanceof VideoFrame) return image.timestamp
  if (typeof HTMLVideoElement !== 'undefined' && image instanceof HTMLVideoElement) return Math.round(image.currentTime * 1e6)
  return NaN
}

const usable = (): boolean => segmenterState().status !== 'failed'

/** Segments the camera frames of one export, once per camera frame (a frame shown twice is segmented once). */
export class CameraMaskPreparer {
  private last: { stamp: number; mask: PersonMask } | null = null

  /** Loads segmentation; false when it cannot run (the export then draws the camera unblurred, like the preview). */
  start(): Promise<boolean> {
    return ensureSegmenter()
  }

  async prepare(frame: FrameImage | null): Promise<void> {
    if (!frame) return
    const stamp = stampOf(frame.image)
    const known = !Number.isNaN(stamp) && this.last?.stamp === stamp ? this.last.mask : null
    if (known) {
      attached.set(frame.image, known)
      return
    }
    // A decoded frame is a new image each time; a seeked element is the same one showing another frame.
    if (Number.isNaN(stamp) && attached.get(frame.image)) return
    // A picture that failed is tried once more (the segmenter is made afresh after a failure).
    let mask = await segmentPicture(frame.image, frame.width, frame.height)
    if (!mask && usable()) mask = await segmentPicture(frame.image, frame.width, frame.height)
    attached.set(frame.image, mask)
    if (mask) this.last = Number.isNaN(stamp) ? null : { stamp, mask }
  }
}

/* ---------- preview ---------- */

const listeners = new Set<() => void>()

function changed(): void {
  for (const l of [...listeners]) l()
}

/** Calls `listener` when a preview camera picture got its mask or lost it (redraw); returns the unsubscribe function. */
export function onCameraMasksChanged(listener: () => void): () => void {
  listeners.add(listener)
  return () => listeners.delete(listener)
}

let watching = false

/** When segmentation stops working, the preview redraws at once: its camera live and unblurred. */
function watchFailure(): void {
  if (watching) return
  watching = true
  onSegmenterState(() => {
    if (!usable()) changed()
  })
}

/** A camera frame and its mask, drawn together. */
export interface MaskedPicture extends FrameImage {
  mask: PersonMask
}

/** Longest wait (ms) for a paused camera to show the frame it was seeked to. */
const SEEK_WAIT = 60
/** Tries per camera frame: a frame whose picture failed is segmented once more. */
const TRIES = 2

/**
 * The background segmentation of one preview camera element. It works only when a draw asks for
 * it (livePicture), so nothing runs while the blur is off or the camera is hidden.
 */
class LiveCamera {
  pair: (MaskedPicture & { frame: VideoFrame }) | null = null
  private busy = false
  private queued = false
  private closed = false
  private lastTime = NaN
  private lastStamp = NaN
  /** Failed tries at the frame at lastTime. */
  private misses = 0
  /** Seconds one camera frame lasts, learned from the frames seen (cameras record 15..60 fps). */
  private frameDur = 1 / 30

  constructor(private readonly video: HTMLVideoElement) {
    video.addEventListener('emptied', this.close)
  }

  /** Segments the frame the camera shows now, unless that frame already has its mask (or failed twice). */
  kick(): void {
    if (this.closed || this.busy || this.queued) return
    const v = this.video
    if (v.readyState < 2 || (v.currentTime === this.lastTime && (this.pair || this.misses >= TRIES))) return
    this.queued = true
    // Never inside a draw: the next task.
    setTimeout(() => {
      this.queued = false
      void this.capture()
    }, 0)
  }

  /** The frame the camera shows, waiting briefly after a seek for the new frame to arrive. */
  private async currentFrame(): Promise<VideoFrame | null> {
    const v = this.video
    const deadline = performance.now() + SEEK_WAIT
    for (;;) {
      let frame: VideoFrame
      try {
        frame = new VideoFrame(v)
      } catch {
        return null
      }
      const t = frame.timestamp / 1e6
      const covers = t <= v.currentTime + 1e-3 && v.currentTime < t + this.frameDur + 1e-3
      if (!v.paused || covers || frame.timestamp !== this.lastStamp || performance.now() >= deadline) return frame
      frame.close()
      await new Promise((r) => setTimeout(r, 4))
    }
  }

  private async capture(): Promise<void> {
    if (this.busy || this.closed || typeof VideoFrame === 'undefined') return
    this.busy = true
    try {
      const time = this.video.currentTime
      const frame = await this.currentFrame()
      if (!frame) return
      if (this.closed) {
        frame.close()
        return
      }
      if (time !== this.lastTime) this.misses = 0
      this.lastTime = time
      if (frame.timestamp === this.lastStamp && this.pair) {
        frame.close()
        return
      }
      if (Number.isFinite(this.lastStamp) && frame.timestamp !== this.lastStamp) {
        const d = Math.abs(frame.timestamp - this.lastStamp) / 1e6
        if (d > 1 / 121 && d < this.frameDur) this.frameDur = Math.max(1 / 120, d)
      }
      const mask = await segmentPicture(frame, frame.displayWidth, frame.displayHeight)
      if (this.closed || !this.video.src) {
        frame.close()
        this.close()
        return
      }
      if (!mask) {
        // This frame is drawn unblurred, never as an older frame; a redraw tries it once more.
        frame.close()
        this.misses++
        this.drop()
        changed()
        return
      }
      this.pair?.frame.close()
      this.pair = { frame, image: frame, width: frame.displayWidth, height: frame.displayHeight, mask }
      this.lastStamp = frame.timestamp
      changed()
    } finally {
      this.busy = false
    }
    // The camera moved on while this frame was segmented.
    if (this.video.currentTime !== this.lastTime) this.kick()
  }

  private drop(): void {
    this.pair?.frame.close()
    this.pair = null
  }

  /** Stops and lets go of the held frame (blur off, camera hidden, segmentation broken, the video closed). */
  close = (): void => {
    if (this.closed) return
    this.closed = true
    this.video.removeEventListener('emptied', this.close)
    if (live.get(this.video) === this) live.delete(this.video)
    this.drop()
  }
}

const live = new WeakMap<HTMLVideoElement, LiveCamera>()

/**
 * The preview camera's latest frame with its mask, or null while there is none (the layer then
 * draws the camera as it is now, unblurred). Starts segmenting the frame shown now when it is new.
 */
export function livePicture(video: HTMLVideoElement): MaskedPicture | null {
  if (!usable()) {
    releaseLivePicture(video)
    return null
  }
  watchFailure()
  let cam = live.get(video)
  if (!cam) {
    cam = new LiveCamera(video)
    live.set(video, cam)
  }
  cam.kick()
  return cam.pair
}

/** Stops segmenting the preview camera and drops its held frame (background blur off, or the camera not drawn). */
export function releaseLivePicture(video: HTMLVideoElement): void {
  live.get(video)?.close()
}
