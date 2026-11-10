/**
 * Straight-alpha frames for transparent exports (docs/design/output-and-languages.md §6.3). A canvas
 * with alpha holds premultiplied pixels and a VideoFrame of it reads back premultiplied BGRA (50%
 * red is [0, 0, 128, 128]); getImageData reads back straight. ffmpeg always receives straight
 * 'bgra': each frame read through a VideoFrame is unpremultiplied here with getImageData's own
 * rounding, so both readbacks give the same bytes and there is one convention end to end.
 *
 * The VideoFrame readback is the default on a GPU canvas: reading a 2D canvas back with getImageData
 * on every frame can move it to software rendering, and then every later drawing step of the export
 * runs on the CPU. A canvas already on the CPU (the exporter asks for willReadFrequently when Chromium
 * has no GPU canvas) reads with getImageData: no conversion, and faster there (Electron 44, software
 * canvas, 1080p: 10.6 ms a frame drawn and read against 12.9 ms through a VideoFrame).
 */
import type { ExportFinish } from '../../../shared/api/export'
import { cleanIpcError, type FrameSink } from './encoders'

/**
 * What a transparent raw route starts its ffmpeg job with: straight 'bgra' frames that carry alpha.
 * The caller (rawSinkFor) completes it with the job's base and the route's encoder.
 */
export interface AlphaInput {
  alpha: true
  video: { kind: 'raw'; pixelFormat: 'bgra' }
}

const ALPHA_INPUT: AlphaInput = { alpha: true, video: { kind: 'raw', pixelFormat: 'bgra' } }

/** Frames sent to ffmpeg and not yet acknowledged (reading back overlaps the transfer, as RawFrameSink). */
const MAX_IN_FLIGHT = 2

let table: Uint8Array | null = null

const f32 = Math.fround

/** A float rounded to the nearest whole number, ties to even (as the CPU's float-to-int conversion Skia stores with). */
function roundHalfEven(v: number): number {
  const down = Math.floor(v)
  const rest = v - down
  return rest > 0.5 || (rest === 0.5 && down % 2 === 1) ? down + 1 : down
}

/**
 * STRAIGHT[a × 256 + c]: c × 255 / a as getImageData computes it (Skia's pipeline in 32-bit floats:
 * c / 255 times 1 / (a / 255), times 255, ties to even), at most 255; the row of a = 0 is all 0.
 * Measured in Electron 44 against getImageData for every premultiplied value: no difference.
 */
function straightTable(): Uint8Array {
  if (table) return table
  const t = new Uint8Array(256 * 256)
  const inv255 = f32(1 / 255)
  for (let a = 1; a < 256; a++) {
    const scale = f32(1 / f32(a * inv255))
    for (let c = 0; c < 256; c++) t[a * 256 + c] = Math.min(255, roundHalfEven(f32(f32(f32(c * inv255) * scale) * 255)))
  }
  table = t
  return t
}

/**
 * Premultiplied 4-byte pixels of `src` to straight ones in `out` (which may be `src` itself):
 * c' = round(c × 255 / a) with getImageData's own rounding (straightTable), and 0 where a is 0. The
 * alpha byte is the fourth of each pixel and kept; the colour bytes keep their order (BGRA stays BGRA).
 */
export function unpremultiply(src: Uint8ClampedArray | Uint8Array, out: Uint8Array): void {
  const t = straightTable()
  const n = Math.min(src.length, out.length) & ~3
  for (let i = 0; i < n; i += 4) {
    const a = src[i + 3]
    if (a === 255) {
      out[i] = src[i]
      out[i + 1] = src[i + 1]
      out[i + 2] = src[i + 2]
      out[i + 3] = 255
      continue
    }
    const row = a << 8
    out[i] = t[row + src[i]]
    out[i + 1] = t[row + src[i + 1]]
    out[i + 2] = t[row + src[i + 2]]
    out[i + 3] = a
  }
}

/** Swaps the first and third byte of every pixel: RGBA to BGRA and back. */
function swapRedBlue(data: Uint8Array): void {
  for (let i = 0; i < data.length; i += 4) {
    const r = data[i]
    data[i] = data[i + 2]
    data[i + 2] = r
  }
}

class AlphaFrameSink implements FrameSink {
  private inFlight = new Set<Promise<void>>()
  private error: Error | null = null
  private started: Promise<void> | null = null
  /** Cleared once a VideoFrame readback failed or gave a layout without alpha: later frames use getImageData. */
  private frameReadback: boolean

  constructor(
    private readonly canvas: HTMLCanvasElement,
    private readonly ctx: CanvasRenderingContext2D,
    private readonly startJob: (input: AlphaInput) => Promise<void>,
    readback: 'videoframe' | 'imagedata'
  ) {
    this.frameReadback = readback === 'videoframe' && typeof VideoFrame !== 'undefined'
  }

  /** The frame as premultiplied BGRA or RGBA through a VideoFrame, made straight BGRA; null when its layout has no alpha to keep. */
  private async readFrame(): Promise<Uint8Array | null> {
    const frame = new VideoFrame(this.canvas, { timestamp: 0 })
    try {
      const format = frame.format
      if (format !== 'BGRA' && format !== 'RGBA') return null
      const data = new Uint8Array(frame.allocationSize())
      if (data.length !== this.canvas.width * this.canvas.height * 4) return null
      await frame.copyTo(data)
      unpremultiply(data, data)
      if (format === 'RGBA') swapRedBlue(data)
      return data
    } finally {
      frame.close()
    }
  }

  private async read(): Promise<Uint8Array> {
    if (this.frameReadback) {
      try {
        const data = await this.readFrame()
        if (data) return data
        console.warn('A VideoFrame of the canvas has no alpha layout; reading frames with getImageData.')
      } catch (e) {
        console.warn('Reading the frame through a VideoFrame failed; using getImageData:', e)
      }
      this.frameReadback = false
    }
    // Straight RGBA already: only the byte order changes.
    const img = this.ctx.getImageData(0, 0, this.canvas.width, this.canvas.height).data
    const data = new Uint8Array(img.buffer, img.byteOffset, img.byteLength)
    swapRedBlue(data)
    return data
  }

  async push(): Promise<void> {
    if (this.error) throw this.error
    const data = await this.read()
    this.started ??= this.startJob(ALPHA_INPUT)
    await this.started.catch((e: unknown) => {
      throw cleanIpcError(e)
    })
    const p: Promise<void> = window.api
      .exportFrame(data)
      .catch((e: unknown) => {
        this.error ??= cleanIpcError(e)
      })
      .finally(() => this.inFlight.delete(p))
    this.inFlight.add(p)
    while (this.inFlight.size >= MAX_IN_FLIGHT && !this.error) await Promise.race(this.inFlight)
    if (this.error) throw this.error
  }

  async finish(): Promise<ExportFinish> {
    await Promise.all(this.inFlight)
    if (this.error) throw this.error
    try {
      return await window.api.exportFinish()
    } catch (e) {
      throw cleanIpcError(e)
    }
  }

  close(): void {
    this.inFlight.clear()
  }
}

/**
 * The raw sink of a transparent job (§6.3): each frame read back once, made straight, and sent as
 * 'bgra'. `readback` absent: through a VideoFrame, unless the canvas is on the CPU already
 * (willReadFrequently), then getImageData; both give the same bytes. `startJob` is called once, with
 * the first frame, with the input the job is started with (AlphaInput).
 */
export function alphaRawSink(
  canvas: HTMLCanvasElement,
  ctx: CanvasRenderingContext2D,
  startJob: (input: AlphaInput) => Promise<void>,
  readback?: 'videoframe' | 'imagedata'
): FrameSink {
  const mode = readback ?? (ctx.getContextAttributes?.()?.willReadFrequently ? 'imagedata' : 'videoframe')
  return new AlphaFrameSink(canvas, ctx, startJob, mode)
}
