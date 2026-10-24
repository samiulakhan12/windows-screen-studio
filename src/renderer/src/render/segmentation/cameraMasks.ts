/**
 * Person masks for the camera pictures the webcam layer draws. drawFrame never waits, so masks
 * are made ahead of it:
 * - export and thumbnails: CameraMaskPreparer segments each decoded camera frame before it is
 *   drawn and attaches the mask to that frame (maskOf finds it);
 * - preview: the camera is a playing or paused <video>; livePicture() hands the layer the latest
 *   camera frame together with its own mask, segmented in the background, so the picture and
 *   its mask always belong together (the preview may show the camera one frame late while
 *   playing; the export never does). A new pair is announced through onCameraMasksChanged.
 */
import type { FrameImage } from '../compositor'
import { ensureSegmenter, segmentPicture, segmenterState, type PersonMask } from './personSegmenter'

const attached = new WeakMap<object, PersonMask>()

/** The mask prepared for a decoded camera frame, if any. */
export const maskOf = (image: CanvasImageSource): PersonMask | null => attached.get(image) ?? null

/** Which camera frame an image shows: a decoded frame's timestamp, a seeked element's time (µs); NaN when unknown. */
function stampOf(image: CanvasImageSource): number {
  if (typeof VideoFrame !== 'undefined' && image instanceof VideoFrame) return image.timestamp
  if (typeof HTMLVideoElement !== 'undefined' && image instanceof HTMLVideoElement) return Math.round(image.currentTime * 1e6)
  return NaN
}

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
    if (Number.isNaN(stamp) && attached.has(frame.image)) return
    const mask = await segmentPicture(frame.image, frame.width, frame.height)
    if (!mask) {
      attached.delete(frame.image)
      return
    }
    attached.set(frame.image, mask)
    this.last = Number.isNaN(stamp) ? null : { stamp, mask }
  }
}

/* ---------- preview ---------- */

const listeners = new Set<() => void>()

/** Calls `listener` when a preview camera picture got its mask (redraw); returns the unsubscribe function. */
export function onCameraMasksChanged(listener: () => void): () => void {
  listeners.add(listener)
  return () => listeners.delete(listener)
}

/** A camera frame and its mask, drawn together. */
export interface MaskedPicture extends FrameImage {
  mask: PersonMask
}

/** Longest wait (ms) for a paused camera to show the frame it was seeked to. */
const SEEK_WAIT = 60

class LiveCamera {
  pair: (MaskedPicture & { frame: VideoFrame }) | null = null
  private busy = false
  private queued = false
  private lastTime = NaN
  private lastStamp = NaN
  /** Seconds one camera frame lasts, learned from the frames seen (cameras record 15..60 fps). */
  private frameDur = 1 / 30

  constructor(private readonly video: HTMLVideoElement) {
    video.addEventListener('seeked', this.kick)
    video.addEventListener('emptied', this.dispose)
  }

  /** Segments the frame the camera shows now, unless that frame already has its mask. */
  kick = (): void => {
    if (this.busy || this.queued || segmenterState().status === 'failed') return
    const v = this.video
    if (v.readyState < 2 || (v.currentTime === this.lastTime && this.pair)) return
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
    if (this.busy || typeof VideoFrame === 'undefined') return
    this.busy = true
    try {
      const time = this.video.currentTime
      const frame = await this.currentFrame()
      if (!frame) return
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
      if (!mask || !this.video.src) {
        frame.close()
        return
      }
      this.pair?.frame.close()
      this.pair = { frame, image: frame, width: frame.displayWidth, height: frame.displayHeight, mask }
      this.lastStamp = frame.timestamp
      for (const l of [...listeners]) l()
    } finally {
      this.busy = false
    }
    // The camera moved on while this frame was segmented.
    if (this.video.currentTime !== this.lastTime) this.kick()
  }

  /** Lets go of the held frame (the blur was turned off, or the video closed). */
  dispose = (): void => {
    this.pair?.frame.close()
    this.pair = null
    this.lastTime = NaN
    this.lastStamp = NaN
  }
}

const live = new WeakMap<HTMLVideoElement, LiveCamera>()

/**
 * The preview camera's latest frame with its mask, or null while there is none yet (the layer
 * then draws the camera unblurred). Starts segmenting the frame shown now when it is new.
 */
export function livePicture(video: HTMLVideoElement): MaskedPicture | null {
  let cam = live.get(video)
  if (!cam) {
    cam = new LiveCamera(video)
    live.set(video, cam)
  }
  cam.kick()
  return cam.pair
}

/** Drops the preview camera's held frame (background blur turned off). */
export function releaseLivePicture(video: HTMLVideoElement): void {
  live.get(video)?.dispose()
}
