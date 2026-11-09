/**
 * Straight-alpha frames for transparent exports (docs/design/output-and-languages.md §6.3): the
 * canvas reads back premultiplied, ffmpeg receives straight 'bgra' or 'rgba'. Part P2 writes it;
 * the contracts' stub refuses, so no transparent export can start before P2.
 */
import type { FrameSink, StartJob } from './encoders'

/** The raw sink of a transparent job: each frame read back and unpremultiplied as getImageData rounds (§6.3). Part P2. */
export function alphaRawSink(canvas: HTMLCanvasElement, ctx: CanvasRenderingContext2D, startJob: StartJob, readback?: 'videoframe' | 'imagedata'): FrameSink {
  void canvas
  void ctx
  void startJob
  void readback
  throw new Error('Transparent videos are not available yet.')
}

/** Premultiplied 4-byte pixels of `src` to straight ones in `out`: c' = round(c × 255 / a), 0 where a is 0. Part P2. */
export function unpremultiply(src: Uint8ClampedArray | Uint8Array, out: Uint8Array): void {
  void src
  void out
}
