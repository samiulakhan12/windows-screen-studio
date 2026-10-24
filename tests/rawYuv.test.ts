// Raw-frame exports send 4:2:0 YUV converted in the renderer (rgbToI420) instead of 32-bit
// RGB: the IPC copies of each frame cost far more than the conversion. GIFs keep RGB.
import { spawnSync } from 'node:child_process'
import { afterEach, describe, expect, it, vi } from 'vitest'
import { exportArgs } from '../src/main/exportArgs'
import { validateJob } from '../src/main/exportJob'
import { ffmpegPath } from '../src/main/ffmpeg'
import type { ExportJob, RawPixelFormat } from '../src/shared/api/export'
import { rgbToI420 } from '../src/shared/render/codec'

interface Sink {
  push(index: number): Promise<void>
}
type SinkClass = new (canvas: unknown, ctx: unknown, startJob: (format: RawPixelFormat) => Promise<void>, yuv?: boolean) => Sink
// Renderer code (DOM types): imported at run time so the Node typecheck of tests/ does not follow it.
const ENCODERS = '../src/renderer/src/render/encoders'
const { RawFrameSink } = (await import(/* @vite-ignore */ ENCODERS)) as { RawFrameSink: SinkClass }

const ff = ffmpegPath()
const W = 640
const H = 360

/** One frame of ffmpeg's colourful test pattern as RGBA. */
const pattern = (): Uint8Array => {
  const r = spawnSync(ff, ['-v', 'error', '-f', 'lavfi', '-i', `testsrc2=size=${W}x${H}`, '-frames:v', '1', '-pix_fmt', 'rgba', '-f', 'rawvideo', '-'], { maxBuffer: 1 << 26 })
  return new Uint8Array(r.stdout.buffer, r.stdout.byteOffset, r.stdout.length)
}

/** The export's own video filter (from exportArgs) run on one raw frame of `pix`: its yuv420p output. */
function exportFilter(frame: Uint8Array, pix: RawPixelFormat): Buffer {
  const job: ExportJob = { width: W, height: H, fps: 30, frames: 1, format: 'mp4', quality: 'high', video: { kind: 'raw', encoder: 'libx264', pixelFormat: pix }, outputPath: '/o.mp4' }
  const args = exportArgs(job, { audioInput: null, output: '/o.mp4' })
  expect(args.slice(args.indexOf('-pix_fmt'), args.indexOf('-pix_fmt') + 2)).toEqual(['-pix_fmt', pix])
  const graph = args[args.indexOf('-filter_complex') + 1]
  const r = spawnSync(ff, ['-v', 'error', '-f', 'rawvideo', '-pix_fmt', pix, '-s', `${W}x${H}`, '-i', '-', '-filter_complex', graph, '-map', '[vout]', '-f', 'rawvideo', '-'], { input: frame, maxBuffer: 1 << 26 })
  expect(r.status, r.stderr.toString()).toBe(0)
  return r.stdout
}

/** Largest and mean difference of [from, to). */
function diff(a: Uint8Array, b: Uint8Array, from: number, to: number): { max: number; mean: number } {
  let max = 0
  let sum = 0
  for (let i = from; i < to; i++) {
    const d = Math.abs(a[i] - b[i])
    sum += d
    max = Math.max(max, d)
  }
  return { max, mean: sum / (to - from) }
}

describe('rgbToI420', () => {
  it('is the conversion ffmpeg made from the RGB frame: BT.601, limited range', () => {
    const rgba = pattern()
    const ours = rgbToI420(rgba, W, H, 'rgba')
    expect(ours.length).toBe((W * H * 3) / 2)
    const theirs = exportFilter(rgba, 'rgba')
    const luma = diff(ours, theirs, 0, W * H)
    expect(luma.max).toBeLessThanOrEqual(1)
    // Chroma differs only along sharp colour edges (a 2x2 mean instead of swscale's filter).
    const chroma = diff(ours, theirs, W * H, ours.length)
    expect(chroma.mean).toBeLessThan(0.5)
    // Reference points: black, white and pure red.
    const px = (r: number, g: number, b: number): number[] => [...rgbToI420(new Uint8Array([r, g, b, 255, r, g, b, 255, r, g, b, 255, r, g, b, 255]), 2, 2, 'rgba')]
    expect(px(0, 0, 0)).toEqual([16, 16, 16, 16, 128, 128])
    expect(px(255, 255, 255)).toEqual([235, 235, 235, 235, 128, 128])
    expect(px(255, 0, 0)).toEqual([81, 81, 81, 81, 90, 240])
  })

  it('reads either byte order', () => {
    const rgba = pattern()
    const bgra = new Uint8Array(rgba)
    for (let i = 0; i < bgra.length; i += 4) [bgra[i], bgra[i + 2]] = [bgra[i + 2], bgra[i]]
    expect(rgbToI420(bgra, W, H, 'bgr0')).toEqual(rgbToI420(rgba, W, H, 'rgb0'))
  })

  it('reaches the encoder unchanged: the export filter leaves I420 input as it is', () => {
    const i420 = rgbToI420(pattern(), W, H, 'rgba')
    expect(diff(exportFilter(i420, 'yuv420p'), i420, 0, i420.length).max).toBe(0)
  })
})

describe('raw frames over IPC', () => {
  afterEach(() => vi.unstubAllGlobals())

  /** A sink over a fake opaque canvas (getImageData, as without VideoFrame): the job's pixel format and the bytes of each frame sent. */
  async function send(yuv: boolean): Promise<{ format: RawPixelFormat | null; sizes: number[] }> {
    const sizes: number[] = []
    vi.stubGlobal('window', { api: { exportFrame: async (data: Uint8Array) => void sizes.push(data.length) } })
    const canvas = { width: W, height: H }
    const rgba = pattern()
    const ctx = { getImageData: () => ({ data: new Uint8ClampedArray(rgba.buffer, rgba.byteOffset, rgba.length) }) }
    let format: RawPixelFormat | null = null
    const sink = new RawFrameSink(canvas, ctx, async (f) => void (format = f), yuv)
    for (let i = 0; i < 3; i++) await sink.push(i)
    await Promise.resolve()
    return { format, sizes }
  }

  it('sends 1.5 bytes a pixel as YUV for videos, 4 as RGB for GIFs', async () => {
    const video = await send(true)
    expect(video.format).toBe('yuv420p')
    expect(video.sizes).toEqual([1, 2, 3].map(() => (W * H * 3) / 2))
    const gif = await send(false)
    expect(gif.format).toBe('rgba')
    expect(gif.sizes).toEqual([1, 2, 3].map(() => W * H * 4))
  })

  it('the main process takes YUV frames for videos only', () => {
    const job: ExportJob = { width: W, height: H, fps: 30, frames: 1, format: 'mp4', quality: 'high', video: { kind: 'raw', encoder: 'libx264', pixelFormat: 'yuv420p' }, outputPath: '/o.mp4' }
    expect(() => validateJob(job)).not.toThrow()
    expect(() => validateJob({ ...job, format: 'webm', video: { kind: 'raw', encoder: 'libvpx-vp9', pixelFormat: 'yuv420p' } })).not.toThrow()
    expect(() => validateJob({ ...job, format: 'gif' })).toThrow()
    expect(() => validateJob({ ...job, format: 'gif', video: { kind: 'raw', encoder: 'libx264', pixelFormat: 'rgba' } })).not.toThrow()
  })
})
