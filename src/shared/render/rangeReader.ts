/** Size of one ranged read. */
export const BLOCK = 4 << 20

/**
 * Reads a media URL in large ranged blocks, prefetching the next block while the
 * current one is used. Sequential reads fetch every block exactly once; only the
 * blocks of the current read and the next one are kept.
 */
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

  /** Block `index`, fetched once and kept until a read no longer needs it. */
  private block(index: number): Promise<Uint8Array> {
    let p = this.blocks.get(index)
    if (!p) {
      const start = index * BLOCK
      const fetched = this.fetchRange(start, Math.min(this.size, start + BLOCK))
      // A failed fetch (say, a prefetch nobody awaited) is retried by the next read.
      fetched.catch(() => this.blocks.get(index) === fetched && this.blocks.delete(index))
      this.blocks.set(index, fetched)
      p = fetched
    }
    return p
  }

  async read(offset: number, length: number): Promise<Uint8Array> {
    if (length > BLOCK) return this.fetchRange(offset, offset + length)
    const first = Math.floor(offset / BLOCK)
    const last = Math.floor((offset + length - 1) / BLOCK)
    // Keep this read's blocks and the next one only. Evicting here, before the
    // prefetch, never drops a block this read is about to use.
    for (const k of this.blocks.keys()) if (k < first || k > last + 1) this.blocks.delete(k)
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
