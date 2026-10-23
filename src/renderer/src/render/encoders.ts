import type { ColorTags, ExportJob } from '../../../shared/api/export'
import { avcLevel, colorTagsFrom } from '../../../shared/render/codec'

/**
 * Where rendered frames go. `push` snapshots the canvas synchronously (the caller
 * may draw the next frame as soon as it returns a promise) and only awaits back-pressure.
 */
export interface FrameSink {
  push(index: number): Promise<void>
  /** Sends everything still buffered and finalises the file. */
  finish(): Promise<void>
  close(): void
}

/** Strips Electron's "Error invoking remote method 'x': Error: " wrapper from IPC errors. */
export function cleanIpcError(e: unknown): Error {
  if (e instanceof DOMException && e.name === 'AbortError') return e as unknown as Error
  const msg = e instanceof Error ? e.message : String(e)
  return new Error(msg.replace(/^Error invoking remote method '[^']+':\s*(\w*Error:\s*)?/, ''))
}

const MAX_IN_FLIGHT = 2

/** Raw RGBA frames to ffmpeg over IPC; up to two frames in flight so reading back overlaps encoding. */
export class RawFrameSink implements FrameSink {
  private inFlight = new Set<Promise<void>>()
  private error: Error | null = null

  constructor(
    private readonly ctx: CanvasRenderingContext2D,
    private readonly width: number,
    private readonly height: number
  ) {}

  async push(): Promise<void> {
    if (this.error) throw this.error
    const data = this.ctx.getImageData(0, 0, this.width, this.height).data
    const p: Promise<void> = window.api
      .exportFrame(new Uint8Array(data.buffer, data.byteOffset, data.byteLength))
      .catch((e: unknown) => {
        this.error ??= cleanIpcError(e)
      })
      .finally(() => this.inFlight.delete(p))
    this.inFlight.add(p)
    while (this.inFlight.size >= MAX_IN_FLIGHT && !this.error) await Promise.race(this.inFlight)
    if (this.error) throw this.error
  }

  async finish(): Promise<void> {
    await Promise.all(this.inFlight)
    if (this.error) throw this.error
    await window.api.exportFinish().catch((e: unknown) => {
      throw cleanIpcError(e)
    })
  }

  close(): void {
    this.inFlight.clear()
  }
}

/* ---------- WebCodecs ---------- */

const BPP: Record<ExportJob['quality'], number> = { high: 0.12, medium: 0.07, small: 0.04 }

/** WebCodecs encoder configurations to try, best first (High, then Main profile). */
export function avcConfigs(width: number, height: number, fps: number, quality: ExportJob['quality'], hardware: boolean): VideoEncoderConfig[] {
  const level = avcLevel(width, height, fps).toString(16).padStart(2, '0')
  return ['6400', '4d00'].map((profile) => ({
    codec: `avc1.${profile}${level}`,
    width,
    height,
    framerate: fps,
    bitrate: Math.round(width * height * fps * BPP[quality]),
    bitrateMode: 'variable',
    latencyMode: 'quality',
    hardwareAcceleration: hardware ? 'prefer-hardware' : 'prefer-software',
    avc: { format: 'annexb' }
  }))
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
 * streams the small H.264 chunks to ffmpeg, which only muxes them. The ffmpeg job
 * starts once the first chunk reveals the stream's colour description.
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

  constructor(
    private readonly canvas: HTMLCanvasElement,
    config: VideoEncoderConfig,
    private readonly fps: number,
    private readonly startJob: (color: ColorTags) => Promise<void>
  ) {
    this.encoder = new VideoEncoder({
      output: (chunk, meta) => this.onChunk(chunk, meta),
      error: (e) => this.fail(new Error(`The GPU video encoder failed: ${e.message}`))
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
    if (!this.started) {
      this.started = this.startJob(colorTagsFrom(meta?.decoderConfig?.colorSpace)).then(
        () => this.startedResolve(),
        (e: unknown) => this.fail(cleanIpcError(e))
      )
    }
    const bytes = new Uint8Array(chunk.byteLength)
    chunk.copyTo(bytes)
    this.batch.push(bytes)
    this.batchBytes += bytes.byteLength
    if (this.batchBytes >= SEND_BYTES) this.send()
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

  async finish(): Promise<void> {
    if (this.error) throw this.error
    await this.encoder.flush().catch((e: unknown) => this.fail(e instanceof Error ? e : new Error(String(e))))
    this.send()
    await this.sends
    if (this.error) throw this.error
    if (!this.started) throw new Error('The GPU video encoder produced no output')
    await this.started
    if (this.error) throw this.error
    await window.api.exportFinish().catch((e: unknown) => {
      throw cleanIpcError(e)
    })
  }

  close(): void {
    if (this.encoder.state !== 'closed') this.encoder.close()
    this.startedResolve()
  }
}
