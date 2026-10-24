import type { VideoSample } from './mp4'

/** Typical frame duration (seconds) of a track: the median sample duration, or null when unknown. */
export function frameDuration(samples: Pick<VideoSample, 'duration'>[]): number | null {
  const durations = samples.map((s) => s.duration).filter((d) => d > 0).sort((a, b) => a - b)
  return durations.length ? durations[durations.length >> 1] : null
}

/** Frame rate of a track from its sample durations, or null when unknown. */
export function frameRate(samples: Pick<VideoSample, 'duration'>[]): number | null {
  const d = frameDuration(samples)
  return d ? 1 / d : null
}

/**
 * Index of the frame a constant-rate video (first frame at 0) shows at `t`, picked
 * like the WebCodecs path does (mp4.presentationIndex with half a frame of slack):
 * a time within half a frame of a frame's start shows that frame.
 */
export function frameIndexAt(t: number, fps: number): number {
  return Math.max(0, Math.floor(t * fps + 0.5 + 1e-6))
}

/**
 * Where to seek a <video> so it shows the frame for `t`: the middle of that frame.
 * A seek to a frame boundary may show either neighbour, so the target never lies
 * on one, whatever the export rate, clip offsets or webcam offset make `t`.
 */
export function frameSeekTime(t: number, fps: number): number {
  return (frameIndexAt(t, fps) + 0.5) / fps
}

/** Whether a frame starting at `start` (seconds) is the one a seek to `target` shows. */
export function frameCovers(start: number, target: number, fps: number): boolean {
  return start > target - 1 / fps + 1e-4 && start <= target + 1e-4
}

/**
 * Decides when the seeking path stops verifying frame timestamps: once 3 of the
 * last 8 checked frames never matched, the file's timestamps are not trusted (each
 * miss waits up to 100 ms). Counting over a window rather than consecutive misses
 * also catches a pattern of every other frame missing.
 */
export class MissCounter {
  static readonly WINDOW = 8
  static readonly LIMIT = 3
  private readonly recent: boolean[] = []
  private on = true

  get checking(): boolean {
    return this.on
  }

  /** Records one checked frame; returns false once checking has been switched off. */
  record(verified: boolean): boolean {
    if (!this.on) return false
    this.recent.push(!verified)
    if (this.recent.length > MissCounter.WINDOW) this.recent.shift()
    if (this.recent.filter(Boolean).length >= MissCounter.LIMIT) this.on = false
    return this.on
  }
}
