/**
 * Word sprites (docs/design/captions-studio.md §9.7): one LRU of canvases, capped by bytes (64 MB
 * at 1080p, growing with the output's pixels up to 256 MB at 4K), keyed by content.
 *
 * Every key is content (text, font, size, look and state), never time, so a seek or an eviction
 * paints the same pixels again. The most recently used sprite is kept last; when the bytes pass the
 * cap the oldest go first, and their canvases are kept (a few) to be reused, so playing does not
 * allocate canvases once some exist.
 */

/** 64 MB: the cap for outputs up to 1920 x 1080. */
const BASE_CAP = 64 * 1024 * 1024
/** 256 MB: the cap at 4K and above. */
const MAX_CAP = 256 * 1024 * 1024
/** 1920 x 1080. */
const BASE_PIXELS = 1920 * 1080
/** Canvases of evicted sprites kept for reuse. */
const POOL = 8

interface Entry {
  canvas: HTMLCanvasElement
  bytes: number
}

/** The bytes a w x h RGBA canvas holds. */
const bytesOf = (w: number, h: number): number => w * h * 4

export class SpriteCache {
  private cap: number
  private readonly entries = new Map<string, Entry>()
  private readonly pool: HTMLCanvasElement[] = []
  private used = 0
  /** The raster mode sprite contexts are made in: a CPU export reads its frame back, so its sprites are CPU canvases too (§9.7). */
  private readFrequently = false

  constructor(maxBytes: number) {
    this.cap = Math.max(0, maxBytes)
  }

  setCap(maxBytes: number): void {
    this.cap = Math.max(0, maxBytes)
    this.evict()
  }

  /**
   * Sprite contexts in the target's raster mode (`willReadFrequently` in a CPU export,
   * exporter.ts), so drawing a sprite never forces a GPU readback. Changing it drops the sprites
   * and the kept canvases (a canvas keeps the mode of its first context).
   */
  setReadFrequently(on: boolean): void {
    if (on === this.readFrequently) return
    this.readFrequently = on
    this.clear()
    this.pool.length = 0
  }

  /** The sprite `key` (w x h), painted by `paint` when it is not cached; null without a canvas. */
  get(key: string, w: number, h: number, paint: (c: CanvasRenderingContext2D) => void): HTMLCanvasElement | null {
    const width = Math.max(1, Math.ceil(w))
    const height = Math.max(1, Math.ceil(h))
    const hit = this.entries.get(key)
    if (hit && hit.canvas.width === width && hit.canvas.height === height) {
      // The most recently used last: the oldest goes first.
      this.entries.delete(key)
      this.entries.set(key, hit)
      return hit.canvas
    }
    if (hit) this.drop(key, hit)
    if (typeof document === 'undefined') return null
    const bytes = bytesOf(width, height)
    // Room first, so the canvas of the sprite that leaves is the one this sprite takes.
    const kept = bytes <= this.cap
    if (kept) this.evict(this.cap - bytes)
    const canvas = this.pool.pop() ?? document.createElement('canvas')
    // Setting the size clears a reused canvas (and resets its context's state).
    canvas.width = width
    canvas.height = height
    const c = (this.readFrequently ? canvas.getContext('2d', { willReadFrequently: true }) : canvas.getContext('2d')) as CanvasRenderingContext2D | null
    if (!c) return null
    paint(c)
    // A sprite larger than the whole cap is drawn but not kept.
    if (!kept) return canvas
    this.entries.set(key, { canvas, bytes })
    this.used += bytes
    return canvas
  }

  clear(): void {
    for (const e of this.entries.values()) if (this.pool.length < POOL) this.pool.push(e.canvas)
    this.entries.clear()
    this.used = 0
  }

  bytes(): number {
    return this.used
  }

  private drop(key: string, e: Entry): void {
    this.entries.delete(key)
    this.used -= e.bytes
    if (this.pool.length < POOL) this.pool.push(e.canvas)
  }

  /** Evicts the oldest sprites until the cached bytes are `limit` or fewer (the cap by default). */
  private evict(limit = this.cap): void {
    for (const [key, e] of this.entries) {
      if (this.used <= limit) return
      this.drop(key, e)
    }
  }
}

/** The cache's cap for an output of `outW` x `outH` (64 MB at 1920x1080, up to 256 MB at 4K). */
export function spriteCap(outW: number, outH: number): number {
  const pixels = outW * outH
  if (!Number.isFinite(pixels) || pixels <= BASE_PIXELS) return BASE_CAP
  return Math.min(MAX_CAP, Math.round((BASE_CAP * pixels) / BASE_PIXELS))
}

/** The Studio layer's sprites. */
export const STUDIO_SPRITES: SpriteCache = new SpriteCache(BASE_CAP)
