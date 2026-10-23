import { planFeed, type FeedPlan } from '../../../shared/render/feedPlan'
import { demuxVideoTrack, type VideoTrackInfo } from '../../../shared/render/mp4'
import { seekToFrame } from '../editor/media'
import type { FrameImage } from './compositor'

/**
 * Supplies the source frame for each export frame, in order. Frame `i` is the
 * frame shown at `times[i]`. `get(i)`'s image stays valid until `next()`, which
 * also lets the source start preparing frame i + 1 while the caller encodes.
 */
export interface FrameSource {
  readonly kind: 'decoder' | 'element'
  get(i: number): Promise<FrameImage | null>
  next(): void
  close(): void
}

/* ---------- ranged file reads ---------- */

const BLOCK = 4 << 20

/** Reads a media URL in large ranged blocks, prefetching the next block while the current one is used. */
export class RangeReader {
  private blocks = new Map<number, Promise<Uint8Array>>()

  private constructor(
    private readonly url: string,
    readonly size: number,
    first: Uint8Array
  ) {
    this.blocks.set(0, Promise.resolve(first))
  }

  static async open(url: string): Promise<RangeReader> {
    const res = await fetch(url, { headers: { Range: `bytes=0-${BLOCK - 1}` } })
    // Without range support the whole file would be loaded into memory.
    if (res.status !== 206) throw new Error(`Media server does not support ranges (${res.status})`)
    const range = /\/(\d+)\s*$/.exec(res.headers.get('Content-Range') ?? '')
    const bytes = new Uint8Array(await res.arrayBuffer())
    const size = range ? Number(range[1]) : bytes.length
    return new RangeReader(url, size, bytes)
  }

  private async fetchRange(start: number, end: number): Promise<Uint8Array> {
    const res = await fetch(this.url, { headers: { Range: `bytes=${start}-${end - 1}` } })
    if (!res.ok) throw new Error(`Could not read media (${res.status})`)
    return new Uint8Array(await res.arrayBuffer())
  }

  private block(index: number): Promise<Uint8Array> {
    let p = this.blocks.get(index)
    if (!p) {
      const start = index * BLOCK
      p = this.fetchRange(start, Math.min(this.size, start + BLOCK))
      this.blocks.set(index, p)
      // Keep only the blocks around the read position.
      for (const k of this.blocks.keys()) if (k < index - 1) this.blocks.delete(k)
    }
    return p
  }

  async read(offset: number, length: number): Promise<Uint8Array> {
    if (length > BLOCK) return this.fetchRange(offset, offset + length)
    const first = Math.floor(offset / BLOCK)
    const last = Math.floor((offset + length - 1) / BLOCK)
    if ((offset % BLOCK) + length > BLOCK / 2 && (last + 1) * BLOCK < this.size) void this.block(last + 1).catch(() => undefined)
    if (first === last) {
      const b = await this.block(first)
      const at = offset - first * BLOCK
      return b.subarray(at, at + length)
    }
    const out = new Uint8Array(length)
    let written = 0
    for (let i = first; i <= last; i++) {
      const b = await this.block(i)
      const from = Math.max(offset, i * BLOCK) - i * BLOCK
      const to = Math.min(offset + length, (i + 1) * BLOCK) - i * BLOCK
      out.set(b.subarray(from, to), written)
      written += to - from
    }
    return out
  }
}

/* ---------- WebCodecs decoding ---------- */

/** Chunk timestamps carry the presentation index (in µs units) so output frames map back exactly. */
const TS_UNIT = 1000
const MAX_READY = 3
const MAX_QUEUE = 6

export class DecoderFrameSource implements FrameSource {
  readonly kind = 'decoder'
  private readonly decoder: VideoDecoder
  private readonly order: number[]
  private readonly plan: FeedPlan
  private readonly unique: number[]
  private matchPtr = 0
  private feedPos = 0
  private flushed = false
  private drained = false
  private pumping = false
  private ready = new Map<number, VideoFrame>()
  private current: { p: number; frame: VideoFrame } | null = null
  private target = 0
  private waiter: { p: number; resolve: () => void; reject: (e: Error) => void } | null = null
  private error: Error | null = null
  private closed = false

  private constructor(
    private readonly track: VideoTrackInfo,
    private readonly reader: RangeReader,
    times: number[],
    config: VideoDecoderConfig
  ) {
    // Presentation index of every sample (decode order -> presentation order).
    const byTime = track.samples.map((s, d) => ({ t: s.time, d })).sort((a, b) => a.t - b.t || a.d - b.d)
    this.order = new Array(track.samples.length)
    byTime.forEach((x, p) => (this.order[x.d] = p))
    this.plan = planFeed(track.samples, times)
    this.unique = [...new Set(this.plan.wanted)]
    this.decoder = new VideoDecoder({ output: (f) => this.onFrame(f), error: (e) => this.fail(new Error(`Video decoding failed: ${e.message}`)) })
    this.decoder.configure(config)
    void this.pump()
  }

  /** Opens `url` for decoding, or returns null when WebCodecs cannot decode it here. */
  static async open(url: string, times: number[]): Promise<DecoderFrameSource | null> {
    if (typeof VideoDecoder === 'undefined' || times.length === 0) return null
    const reader = await RangeReader.open(url)
    const track = await demuxVideoTrack((o, l) => reader.read(o, l), reader.size)
    if (track.samples.length === 0) return null
    const config: VideoDecoderConfig = {
      codec: track.codec,
      description: track.description,
      codedWidth: track.codedWidth,
      codedHeight: track.codedHeight,
      optimizeForLatency: false
    }
    const support = await VideoDecoder.isConfigSupported(config)
    if (!support.supported) return null
    return new DecoderFrameSource(track, reader, times, config)
  }

  private fail(e: Error): void {
    if (this.error) return
    this.error = e
    this.waiter?.reject(e)
    this.waiter = null
  }

  private onFrame(frame: VideoFrame): void {
    const p = Math.round(frame.timestamp / TS_UNIT)
    if (this.closed) {
      frame.close()
      return
    }
    while (this.matchPtr < this.unique.length && this.unique[this.matchPtr] < p) this.matchPtr++
    if (this.matchPtr < this.unique.length && this.unique[this.matchPtr] === p) {
      this.ready.set(p, frame)
      this.matchPtr++
    } else {
      frame.close()
    }
    const w = this.waiter
    if (w) {
      if (this.ready.has(w.p)) {
        this.waiter = null
        w.resolve()
      } else if (p > w.p) {
        this.fail(new Error('The video decoder skipped a frame'))
      }
    }
    void this.pump()
  }

  /** Feeds samples while the decoder and the ready buffer have room. */
  private async pump(): Promise<void> {
    if (this.pumping) return
    this.pumping = true
    try {
      const { feed } = this.plan
      while (!this.error && !this.closed && this.feedPos < feed.length && this.decoder.decodeQueueSize < MAX_QUEUE && this.ready.size < MAX_READY) {
        const d = feed[this.feedPos++]
        const s = this.track.samples[d]
        const data = await this.reader.read(s.offset, s.size)
        if (this.closed || this.error) return
        this.decoder.decode(
          new EncodedVideoChunk({ type: s.key ? 'key' : 'delta', timestamp: this.order[d] * TS_UNIT, duration: TS_UNIT, data })
        )
      }
      if (!this.flushed && this.feedPos >= feed.length && !this.error && !this.closed) {
        this.flushed = true
        this.decoder.flush().then(
          () => {
            // Every frame is out: anyone still waiting would wait forever.
            this.drained = true
            if (this.waiter && !this.ready.has(this.waiter.p)) this.fail(new Error('The video decoder did not return a frame'))
          },
          (e: unknown) => {
            if (!this.closed) this.fail(e instanceof Error ? e : new Error(String(e)))
          }
        )
      }
    } catch (e) {
      this.fail(e instanceof Error ? e : new Error(String(e)))
    } finally {
      this.pumping = false
    }
    // Room may have opened up while a read was in flight.
    if (!this.error && !this.closed && this.feedPos < this.plan.feed.length && this.decoder.decodeQueueSize < MAX_QUEUE && this.ready.size < MAX_READY) {
      void this.pump()
    }
  }

  async get(i: number): Promise<FrameImage | null> {
    if (this.error) throw this.error
    this.target = i
    const p = this.plan.wanted[i]
    if (this.current?.p !== p) {
      this.current?.frame.close()
      this.current = null
      if (!this.ready.has(p)) {
        // Frames come out in presentation order: once a later one arrived (or decoding ended), p never will.
        const passed = this.matchPtr >= this.unique.length || this.unique[this.matchPtr] > p
        if (passed || this.drained) throw new Error('The video decoder skipped a frame')
        await new Promise<void>((resolve, reject) => {
          this.waiter = { p, resolve, reject }
          void this.pump()
        })
      }
      const frame = this.ready.get(p)!
      this.ready.delete(p)
      this.current = { p, frame }
      void this.pump()
    }
    const f = this.current.frame
    return { image: f, width: f.displayWidth, height: f.displayHeight }
  }

  next(): void {
    // Keep the current frame while the next target shows the same one (slow motion).
    const nextP = this.plan.wanted[this.target + 1]
    if (this.current && nextP !== this.current.p) {
      this.current.frame.close()
      this.current = null
    }
    void this.pump()
  }

  close(): void {
    if (this.closed) return
    this.closed = true
    this.waiter?.reject(new Error('closed'))
    this.waiter = null
    this.current?.frame.close()
    this.current = null
    for (const f of this.ready.values()) f.close()
    this.ready.clear()
    if (this.decoder.state !== 'closed') this.decoder.close()
  }
}

/* ---------- <video> element fallback ---------- */

/** Seeks a <video> element to each target; the next seek starts as soon as a frame is consumed. */
export class ElementFrameSource implements FrameSource {
  readonly kind = 'element'
  private pending: { i: number; done: Promise<void> } | null = null
  private target = 0

  constructor(
    private readonly video: HTMLVideoElement,
    private readonly times: number[]
  ) {}

  private seek(i: number): { i: number; done: Promise<void> } {
    const done = seekToFrame(this.video, this.times[i])
    // A prefetch nobody waits for must not become an unhandled rejection.
    done.catch(() => undefined)
    return { i, done }
  }

  async get(i: number): Promise<FrameImage | null> {
    this.target = i
    if (!this.pending || this.pending.i !== i) this.pending = this.seek(i)
    await this.pending.done
    const v = this.video
    if (v.readyState < 2 || v.videoWidth === 0) return null
    return { image: v, width: v.videoWidth, height: v.videoHeight }
  }

  next(): void {
    const i = this.target + 1
    if (i < this.times.length) this.pending = this.seek(i)
  }

  close(): void {
    this.pending = null
  }
}

/**
 * A decoder source that switches to seeking a <video> element if decoding fails
 * part-way (an unusual stream, a GPU decoder reset), instead of failing the export.
 */
export class ResilientFrameSource implements FrameSource {
  private switched = false

  constructor(
    private source: FrameSource,
    private readonly fallback: () => Promise<FrameSource>
  ) {}

  get kind(): FrameSource['kind'] {
    return this.source.kind
  }

  async get(i: number): Promise<FrameImage | null> {
    try {
      return await this.source.get(i)
    } catch (e) {
      if (this.switched) throw e
      console.warn(`Decoding failed at frame ${i}, seeking the video element instead:`, e)
      this.switched = true
      this.source.close()
      this.source = await this.fallback()
      return this.source.get(i)
    }
  }

  next(): void {
    this.source.next()
  }

  close(): void {
    this.source.close()
  }
}
