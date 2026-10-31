/**
 * Word sprites (docs/design/captions-studio.md §9.7): one LRU of canvases, capped by bytes (64 MB
 * at 1080p, growing with the output's pixels up to 256 MB at 4K), keyed by content.
 *
 * CONTRACT (part P2): signatures are frozen; bodies are to be written.
 */

/** The body of a frozen signature part P2 writes. */
function notImplemented(name: string, ...args: unknown[]): never {
  void args
  throw new Error(`${name}: not implemented (Captions Studio part P2)`)
}

export class SpriteCache {
  private cap: number

  constructor(maxBytes: number) {
    this.cap = maxBytes
  }

  setCap(maxBytes: number): void {
    return notImplemented('SpriteCache.setCap', maxBytes, this.cap)
  }

  /** The sprite `key` (w x h), painted by `paint` when it is not cached; null without a canvas. */
  get(key: string, w: number, h: number, paint: (c: CanvasRenderingContext2D) => void): HTMLCanvasElement | null {
    return notImplemented('SpriteCache.get', key, w, h, paint)
  }

  clear(): void {
    return notImplemented('SpriteCache.clear')
  }

  bytes(): number {
    return notImplemented('SpriteCache.bytes')
  }
}

/** The cache's cap for an output of `outW` x `outH` (64 MB at 1920x1080, up to 256 MB at 4K). */
export function spriteCap(outW: number, outH: number): number {
  return notImplemented('spriteCap', outW, outH)
}

/** The Studio layer's sprites. */
export const STUDIO_SPRITES: SpriteCache = new SpriteCache(64 * 1024 * 1024)
