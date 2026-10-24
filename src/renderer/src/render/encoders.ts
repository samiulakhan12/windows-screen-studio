import type { ColorTags, ExportFinish, ExportJob, RawPixelFormat, Rgb32Format } from '../../../shared/api/export'
import { avcLevel, colorTagsFrom, ivfFileHeader, ivfFrameHeader, rawReadback, rgbToI420, vp9Codec } from '../../../shared/render/codec'

/**
 * Where rendered frames go. `push` has captured the canvas by the time it resolves
 * (the caller may then draw the next frame); it also applies back-pressure.
 */
export interface FrameSink {
  push(index: number): Promise<void>
  /** Sends everything still buffered and finalises the file; resolves with its size in bytes. */
  finish(): Promise<ExportFinish>
  close(): void
}

/** Strips Electron's "Error invoking remote method 'x': Error: " wrapper from IPC errors. */
export function cleanIpcError(e: unknown): Error {
  if (e instanceof DOMException && e.name === 'AbortError') return e as unknown as Error
  const msg = e instanceof Error ? e.message : String(e)
  return new Error(msg.replace(/^Error invoking remote method '[^']+':\s*(\w*Error:\s*)?/, ''))
}

const MAX_IN_FLIGHT = 2

async function finishJob(): Promise<ExportFinish> {
  try {
    return await window.api.exportFinish()
  } catch (e) {
    throw cleanIpcError(e)
  }
}

/**
 * Raw frames to ffmpeg over IPC, up to two in flight so reading back overlaps the
 * transfer. The canvas is a GPU canvas where Chromium has one: each finished frame
 * is read back once, asynchronously, through a VideoFrame in the canvas's native
 * byte order (a plain copy, about 3x faster than getImageData's unpremultiplying
 * RGBA copy, which is only the fallback). With `yuv` (every format but GIF) each frame
 * is converted to 4:2:0 YUV before it is sent: IPC copies cost far more than the
 * conversion, and it is 2.7x less to copy. The ffmpeg job starts with the first frame,
 * once its pixel format is known.
 */
export class RawFrameSink implements FrameSink {
  private inFlight = new Set<Promise<void>>()
  private error: Error | null = null
  private started: Promise<void> | null = null

  constructor(
    private readonly canvas: HTMLCanvasElement,
    private readonly ctx: CanvasRenderingContext2D,
    private readonly startJob: (format: RawPixelFormat) => Promise<void>,
    private readonly yuv = false
  ) {}

  /** Set once a VideoFrame readback failed: later frames use getImageData. */
  private frameReadback = typeof VideoFrame !== 'undefined'
  /** Pixel format of the job (fixed by the first frame). */
  private format: RawPixelFormat | null = null

  private async readFrame(): Promise<{ data: Uint8Array; format: Rgb32Format } | null> {
    const frame = new VideoFrame(this.canvas, { timestamp: 0 })
    try {
      const { copyFormat, pixelFormat } = rawReadback(frame.format)
      // A later frame must not change the byte order the ffmpeg job was started with (frames converted to YUV may).
      if (!this.yuv && this.format && pixelFormat !== this.format) return null
      const options: VideoFrameCopyToOptions = copyFormat ? { format: copyFormat, colorSpace: 'srgb' } : {}
      const data = new Uint8Array(frame.allocationSize(options))
      await frame.copyTo(data, options)
      return { data, format: pixelFormat }
    } finally {
      frame.close()
    }
  }

  private async read(): Promise<{ data: Uint8Array; format: Rgb32Format }> {
    if (this.frameReadback) {
      try {
        const r = await this.readFrame()
        if (r) return r
      } catch (e) {
        console.warn('Reading the frame through a VideoFrame failed; using getImageData:', e)
      }
      this.frameReadback = false
    }
    const img = this.ctx.getImageData(0, 0, this.canvas.width, this.canvas.height).data
    const data = new Uint8Array(img.buffer, img.byteOffset, img.byteLength)
    // A job started from VideoFrames in blue-first order keeps that order (the canvas is opaque, so RGBA also serves as RGB0).
    if (this.format === 'bgra' || this.format === 'bgr0') {
      for (let i = 0; i < data.length; i += 4) {
        const r = data[i]
        data[i] = data[i + 2]
        data[i + 2] = r
      }
    }
    return { data, format: this.format && this.format !== 'yuv420p' ? this.format : 'rgba' }
  }

  async push(): Promise<void> {
    if (this.error) throw this.error
    const frame = await this.read()
    const data = this.yuv ? rgbToI420(frame.data, this.canvas.width, this.canvas.height, frame.format) : frame.data
    const format = this.yuv ? 'yuv420p' : frame.format
    this.format ??= format
    this.started ??= this.startJob(format)
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
    return finishJob()
  }

  close(): void {
    this.inFlight.clear()
  }
}

/* ---------- WebCodecs ---------- */

const BPP: Record<ExportJob['quality'], number> = { high: 0.12, medium: 0.07, small: 0.04 }
/** VP9 needs about 30% fewer bits than H.264 for the same quality. */
const VP9_BPP_FACTOR = 0.7

/**
 * Bit rate settings: a size target is an average the encoder must hold (constant bit
 * rate, the mode hardware encoders keep best), otherwise a quality-based variable rate.
 */
function rateOf(width: number, height: number, fps: number, quality: ExportJob['quality'], bitrate: number | undefined, factor = 1): Pick<VideoEncoderConfig, 'bitrate' | 'bitrateMode'> {
  return bitrate ? { bitrate, bitrateMode: 'constant' } : { bitrate: Math.round(width * height * fps * BPP[quality] * factor), bitrateMode: 'variable' }
}

/** WebCodecs encoder configurations to try, best first (High, then Main profile). */
export function avcConfigs(width: number, height: number, fps: number, quality: ExportJob['quality'], hardware: boolean, bitrate?: number): VideoEncoderConfig[] {
  const level = avcLevel(width, height, fps).toString(16).padStart(2, '0')
  return ['6400', '4d00'].map((profile) => ({
    codec: `avc1.${profile}${level}`,
    width,
    height,
    framerate: fps,
    ...rateOf(width, height, fps, quality, bitrate),
    latencyMode: 'quality',
    hardwareAcceleration: hardware ? 'prefer-hardware' : 'prefer-software',
    avc: { format: 'annexb' }
  }))
}

/** WebCodecs VP9 (profile 0, 8-bit 4:2:0) configuration for WebM. */
export function vp9Configs(width: number, height: number, fps: number, quality: ExportJob['quality'], hardware: boolean, bitrate?: number): VideoEncoderConfig[] {
  return [
    {
      codec: vp9Codec(width, height, fps),
      width,
      height,
      framerate: fps,
      ...rateOf(width, height, fps, quality, bitrate, VP9_BPP_FACTOR),
      latencyMode: 'quality',
      hardwareAcceleration: hardware ? 'prefer-hardware' : 'prefer-software'
    }
  ]
}

/** First configuration this machine can encode, or null. */
export async function supportedAvcConfig(configs: VideoEncoderConfig[]): Promise<VideoEncoderConfig | null> {
  if (typeof VideoEncoder === 'undefined') return null
  for (const c of configs) {
    try {
      const r = await VideoEncoder.isConfigSupported(c)
      if (r.supported) return r.config ?? c
    } catch {
      // Try the next configuration.
    }
  }
  return null
}

const SEND_BYTES = 1 << 20

/**
 * Encodes canvas frames with WebCodecs (GPU when available) in the renderer and
 * streams the small chunks to ffmpeg, which only muxes them: H.264 as an Annex B
 * stream, VP9 framed as IVF. The ffmpeg job starts once the first chunk reveals the
 * stream's colour description.
 */
export class WebCodecsSink implements FrameSink {
  private readonly encoder: VideoEncoder
  private batch: Uint8Array[] = []
  private batchBytes = 0
  private sends: Promise<void> = Promise.resolve()
  private pendingSends = 0
  private started: Promise<void> | null = null
  private startedResolve!: () => void
  private readonly startGate = new Promise<void>((r) => (this.startedResolve = r))
  private error: Error | null = null
  private wake: (() => void) | null = null
  private lastTimestamp = -1
  private chunks = 0
  private frames = 0

  constructor(
    private readonly canvas: HTMLCanvasElement,
    private readonly config: VideoEncoderConfig,
    private readonly fps: number,
    private readonly startJob: (color: ColorTags) => Promise<void>,
    /** How chunks are framed for ffmpeg: Annex B (H.264 as configured) or IVF (VP9). */
    private readonly framing: 'annexb' | 'ivf' = 'annexb'
  ) {
    this.encoder = new VideoEncoder({
      output: (chunk, meta) => this.onChunk(chunk, meta),
      error: (e) => this.fail(new Error(`The video encoder (WebCodecs) failed: ${e.message}`))
    })
    this.encoder.configure(config)
    this.encoder.addEventListener('dequeue', () => this.notify())
  }

  private notify(): void {
    const w = this.wake
    this.wake = null
    w?.()
  }

  private fail(e: Error): void {
    this.error ??= e
    this.startedResolve()
    this.notify()
  }

  private onChunk(chunk: EncodedVideoChunk, meta?: EncodedVideoChunkMetadata): void {
    if (this.error) return
    // ffmpeg numbers the frames in arrival order, so they must arrive one per frame, in order.
    if (chunk.timestamp <= this.lastTimestamp) {
      this.fail(new Error('The video encoder (WebCodecs) reordered frames'))
      return
    }
    this.lastTimestamp = chunk.timestamp
    this.chunks++
    if (!this.started) {
      this.started = this.startJob(colorTagsFrom(meta?.decoderConfig?.colorSpace)).then(
        () => this.startedResolve(),
        (e: unknown) => this.fail(cleanIpcError(e))
      )
    }
    if (this.framing === 'ivf') {
      if (this.chunks === 1) this.add(ivfFileHeader(this.config.width, this.config.height, this.fps))
      this.add(ivfFrameHeader(chunk.byteLength, Math.round((chunk.timestamp * this.fps) / 1e6)))
    }
    const bytes = new Uint8Array(chunk.byteLength)
    chunk.copyTo(bytes)
    this.add(bytes)
    if (this.batchBytes >= SEND_BYTES) this.send()
  }

  private add(bytes: Uint8Array): void {
    this.batch.push(bytes)
    this.batchBytes += bytes.byteLength
  }

  /** Queues the buffered chunks for ffmpeg, in order, after the job has started. */
  private send(): void {
    if (this.batchBytes === 0) return
    const data = new Uint8Array(this.batchBytes)
    let at = 0
    for (const b of this.batch) {
      data.set(b, at)
      at += b.byteLength
    }
    this.batch = []
    this.batchBytes = 0
    this.pendingSends++
    this.sends = this.sends
      .then(() => this.startGate)
      .then(() => (this.error ? undefined : window.api.exportFrame(data)))
      .catch((e: unknown) => this.fail(cleanIpcError(e)))
      .finally(() => {
        this.pendingSends--
        this.notify()
      })
  }

  async push(index: number): Promise<void> {
    if (this.error) throw this.error
    this.frames++
    const frame = new VideoFrame(this.canvas, { timestamp: Math.round((index * 1e6) / this.fps), duration: Math.round(1e6 / this.fps) })
    try {
      this.encoder.encode(frame, { keyFrame: index % (this.fps * 2) === 0 })
    } finally {
      frame.close()
    }
    while (!this.error && (this.encoder.encodeQueueSize > 2 || this.pendingSends > 2)) {
      await new Promise<void>((r) => (this.wake = r))
    }
    if (this.error) throw this.error
  }

  async finish(): Promise<ExportFinish> {
    if (this.error) throw this.error
    await this.encoder.flush().catch((e: unknown) => this.fail(e instanceof Error ? e : new Error(String(e))))
    this.send()
    await this.sends
    if (this.error) throw this.error
    if (!this.started) throw new Error('The video encoder (WebCodecs) produced no output')
    if (this.chunks !== this.frames) throw new Error(`The video encoder (WebCodecs) dropped frames (${this.chunks} of ${this.frames})`)
    await this.started
    if (this.error) throw this.error
    return finishJob()
  }

  close(): void {
    if (this.encoder.state !== 'closed') this.encoder.close()
    this.startedResolve()
  }
}
