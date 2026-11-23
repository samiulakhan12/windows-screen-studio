/**
 * The look pass's data in main (docs/design/auto-blur.md §5.2): per analysed frame, which tiles
 * changed since the analysed frame before and how each changed region moved. It holds no pixels and
 * no text. The helper sends it in batches (`LookFrame`, protocol.ts); planReads, the walks and the
 * notifications read it. Pure.
 *
 * The tile grid (the helper writes it, main reads it): tiles of 8 × 8 look pixels, which are
 * 8k × 8k video pixels at look scale k. The grid has cols = ceil(W / 8k) and rows = ceil(H / 8k);
 * tile (c, r) covers video pixels [8k·c, 8k·(c + 1)) × [8k·r, 8k·(r + 1)), clipped to the frame. A
 * frame's `tiles` is the base64 of its bit string: tile i = r·cols + c (row-major) is bit
 * (byte[i >> 3] >> (i & 7)) & 1, the lowest bit first; missing bytes are unchanged tiles.
 *
 * A move (`LookMove`) at frame f is how the content of its region moved from the analysed frame
 * before f to f: what was at (x, y) is at (x + dx, y + dy) at f, in video pixels; its box is the
 * region at f.
 */
import type { Box, LookFrame } from './protocol'

export interface Size {
  width: number
  height: number
}

export interface LookData {
  /** The look scale: look frames are W/k × H/k. */
  k: number
  /** Every `step`-th source frame is analysed. */
  step: number
  /** The recording's frame rate. */
  fps: number
  size: Size
  /** The analysed frames, in time order. */
  frames: LookFrame[]
  /** Times of the analysed frames that are key frames, in order (reads seek to them, §5.5). */
  keys: number[]
}

/** Look frames are about 480 × 270 (§5.2): k = max(4, ceil(sqrt(W·H / (480·270)))). */
export function lookScale(width: number, height: number): number {
  const area = width * height
  if (!Number.isFinite(area) || area <= 0) return 4
  return Math.max(4, Math.ceil(Math.sqrt(area / (480 * 270)) - 1e-9))
}

/** Every frame up to 30 fps, every second at 60, every fourth at 120 (§5.2): ceil(fps / 30). */
export function lookStep(fps: number): number {
  if (!Number.isFinite(fps) || fps <= 0) return 2
  return Math.max(1, Math.ceil(fps / 30 - 1e-9))
}

/** The tile grid of `data` (see the file's comment). */
export function tileGrid(data: Pick<LookData, 'k' | 'size'>): { cols: number; rows: number; tile: number } {
  const tile = 8 * Math.max(1, data.k)
  return { cols: Math.max(1, Math.ceil(data.size.width / tile)), rows: Math.max(1, Math.ceil(data.size.height / tile)), tile }
}

/** An empty look of a recording. */
export function emptyLook(size: Size, fps: number): LookData {
  return { k: lookScale(size.width, size.height), step: lookStep(fps), fps: Number.isFinite(fps) && fps > 0 ? fps : 60, size: { width: size.width, height: size.height }, frames: [], keys: [] }
}

/** Appends a batch: frames in time order after the last one; a frame at or before it is dropped. */
export function addLookFrames(data: LookData, frames: readonly LookFrame[]): void {
  for (const f of frames) {
    const last = data.frames[data.frames.length - 1]
    if (!Number.isFinite(f.t) || (last && f.t <= last.t)) continue
    data.frames.push(f)
    if (f.key) data.keys.push(f.t)
  }
}

/* ---------- tiles ---------- */

const B64 = new Int16Array(128).fill(-1)
'ABCDEFGHIJKLMNOPQRSTUVWXYZabcdefghijklmnopqrstuvwxyz0123456789+/'.split('').forEach((ch, i) => (B64[ch.charCodeAt(0)] = i))

/** The bytes of a base64 string (unknown characters and padding are skipped). */
function fromBase64(s: string): Uint8Array {
  const out = new Uint8Array(Math.floor((s.length * 3) / 4))
  let acc = 0
  let bits = 0
  let n = 0
  for (let i = 0; i < s.length; i++) {
    const c = s.charCodeAt(i)
    const v = c < 128 ? B64[c] : -1
    if (v < 0) continue
    acc = (acc << 6) | v
    bits += 6
    if (bits >= 8) {
      bits -= 8
      out[n++] = (acc >> bits) & 0xff
    }
  }
  return out.subarray(0, n)
}

const packedOf = new WeakMap<LookFrame, Uint8Array>()

/** A frame's changed tiles as packed bits (decoded once per frame and kept). */
function packed(frame: LookFrame): Uint8Array {
  let p = packedOf.get(frame)
  if (!p) {
    p = fromBase64(frame.tiles)
    packedOf.set(frame, p)
  }
  return p
}

const bitAt = (p: Uint8Array, i: number): number => ((i >> 3) < p.length ? (p[i >> 3] >> (i & 7)) & 1 : 0)

/** Whether tile `i` (row-major over tileGrid) changed at `frame`. */
export function tileChanged(frame: LookFrame, i: number): boolean {
  return bitAt(packed(frame), i) === 1
}

/** Frame `frame`'s changed tiles: one byte a tile, 1 for changed, row-major over tileGrid(data). */
export function changedTiles(frame: LookFrame, data: Pick<LookData, 'k' | 'size'>): Uint8Array {
  const { cols, rows } = tileGrid(data)
  const p = packed(frame)
  const out = new Uint8Array(cols * rows)
  for (let i = 0; i < out.length; i++) out[i] = bitAt(p, i)
  return out
}

/** The tile range [c0, c1] × [r0, r1] (inclusive) a box in video pixels touches, or null when it is outside the frame. */
function tileRange(box: Box, data: Pick<LookData, 'k' | 'size'>): [number, number, number, number] | null {
  const { cols, rows, tile } = tileGrid(data)
  const x0 = Math.max(0, box[0])
  const y0 = Math.max(0, box[1])
  const x1 = Math.min(data.size.width, box[0] + box[2])
  const y1 = Math.min(data.size.height, box[1] + box[3])
  if (!(x1 > x0 && y1 > y0)) return null
  return [Math.floor(x0 / tile), Math.floor(y0 / tile), Math.min(cols - 1, Math.ceil(x1 / tile) - 1), Math.min(rows - 1, Math.ceil(y1 / tile) - 1)]
}

/** How many tiles of `box` (video pixels) changed at frame `frame`. */
export function changedUnder(frame: LookFrame, data: Pick<LookData, 'k' | 'size'>, box: Box): number {
  const r = tileRange(box, data)
  if (!r) return 0
  const { cols } = tileGrid(data)
  const p = packed(frame)
  let n = 0
  for (let y = r[1]; y <= r[3]; y++) for (let x = r[0]; x <= r[2]; x++) n += bitAt(p, y * cols + x)
  return n
}

const shareOf = new WeakMap<LookFrame, number>()

/** The share of the frame's tiles that changed at `frame` (0..1). */
export function changedShare(frame: LookFrame, data: Pick<LookData, 'k' | 'size'>): number {
  const hit = shareOf.get(frame)
  if (hit !== undefined) return hit
  const { cols, rows } = tileGrid(data)
  const p = packed(frame)
  let n = 0
  const total = cols * rows
  for (let i = 0; i < p.length && i * 8 < total; i++) {
    let b = p[i]
    if ((i + 1) * 8 > total) b &= (1 << (total - i * 8)) - 1
    while (b) {
      n += b & 1
      b >>= 1
    }
  }
  const share = n / total
  shareOf.set(frame, share)
  return share
}

/** Index of the first analysed frame at or after `t` (frames.length when none). */
export function frameAtOrAfter(data: Pick<LookData, 'frames'>, t: number): number {
  let lo = 0
  let hi = data.frames.length
  while (lo < hi) {
    const m = (lo + hi) >> 1
    if (data.frames[m].t < t - 1e-9) lo = m + 1
    else hi = m
  }
  return lo
}

/** Index of the analysed frame nearest `t` (-1 when there is none). */
export function frameNear(data: Pick<LookData, 'frames'>, t: number): number {
  const n = data.frames.length
  if (!n) return -1
  const i = frameAtOrAfter(data, t)
  if (i >= n) return n - 1
  if (i > 0 && t - data.frames[i - 1].t < data.frames[i].t - t) return i - 1
  return i
}

/** Indices of the analysed frames in [from, to] (seconds) at which a tile under `box` (video pixels) changed. */
export function changedIn(data: LookData, box: Box, from: number, to: number): number[] {
  const out: number[] = []
  for (let i = frameAtOrAfter(data, from); i < data.frames.length && data.frames[i].t <= to + 1e-9; i++) if (changedUnder(data.frames[i], data, box) > 0) out.push(i)
  return out
}

/** The latest key frame at or before `t` (seconds), or 0 (the start of the recording) when none is known. */
export function keyBefore(data: Pick<LookData, 'keys'>, t: number): number {
  let lo = 0
  let hi = data.keys.length
  while (lo < hi) {
    const m = (lo + hi) >> 1
    if (data.keys[m] <= t + 1e-9) lo = m + 1
    else hi = m
  }
  return lo ? data.keys[lo - 1] : 0
}

/* ---------- regions ---------- */

const regionsOf = new WeakMap<LookFrame, Box[]>()

/** Two tile boxes [c0, r0, c1, r1] at most `gap` tiles apart on both axes. */
const near = (a: number[], b: number[], gap: number): boolean => b[0] - a[2] - 1 <= gap && a[0] - b[2] - 1 <= gap && b[1] - a[3] - 1 <= gap && a[1] - b[3] - 1 <= gap

/**
 * The changed regions of analysed frame `index` (§5.2): changed tiles joined by 8-connectivity,
 * merged when within 2 tiles, each as its bounding box in video pixels (clipped to the frame).
 * Worked out once per frame.
 */
export function regionsAt(data: LookData, index: number): Box[] {
  const frame = data.frames[index]
  if (!frame) return []
  const hit = regionsOf.get(frame)
  if (hit) return hit
  const { cols, rows, tile } = tileGrid(data)
  const p = packed(frame)
  const seen = new Uint8Array(cols * rows)
  const boxes: number[][] = []
  const stack: number[] = []
  for (let i = 0; i < cols * rows; i++) {
    if (seen[i] || !bitAt(p, i)) continue
    const box = [cols, rows, -1, -1]
    seen[i] = 1
    stack.push(i)
    while (stack.length) {
      const j = stack.pop()!
      const x = j % cols
      const y = (j - x) / cols
      if (x < box[0]) box[0] = x
      if (y < box[1]) box[1] = y
      if (x > box[2]) box[2] = x
      if (y > box[3]) box[3] = y
      for (let dy = -1; dy <= 1; dy++)
        for (let dx = -1; dx <= 1; dx++) {
          const nx = x + dx
          const ny = y + dy
          if (nx < 0 || ny < 0 || nx >= cols || ny >= rows) continue
          const k = ny * cols + nx
          if (!seen[k] && bitAt(p, k)) {
            seen[k] = 1
            stack.push(k)
          }
        }
    }
    boxes.push(box)
  }
  // Merge boxes within 2 tiles of each other until none are.
  let merged = true
  while (merged && boxes.length > 1) {
    merged = false
    boxes.sort((a, b) => a[0] - b[0])
    for (let a = 0; a < boxes.length; a++) {
      for (let b = a + 1; b < boxes.length; b++) {
        if (boxes[b][0] - boxes[a][2] - 1 > 2) break
        if (!near(boxes[a], boxes[b], 2)) continue
        const A = boxes[a]
        const B = boxes[b]
        boxes[a] = [Math.min(A[0], B[0]), Math.min(A[1], B[1]), Math.max(A[2], B[2]), Math.max(A[3], B[3])]
        boxes.splice(b, 1)
        merged = true
        b = a
      }
    }
  }
  const out: Box[] = boxes.map((b) => {
    const x = b[0] * tile
    const y = b[1] * tile
    return [x, y, Math.min(data.size.width, (b[2] + 1) * tile) - x, Math.min(data.size.height, (b[3] + 1) * tile) - y]
  })
  regionsOf.set(frame, out)
  return out
}

/* ---------- boxes ---------- */

export const right = (b: Box): number => b[0] + b[2]
export const bottom = (b: Box): number => b[1] + b[3]

/** Whether two boxes overlap (touching edges do not). */
export function overlaps(a: Box, b: Box): boolean {
  return a[0] < right(b) && b[0] < right(a) && a[1] < bottom(b) && b[1] < bottom(a)
}

/** The smallest box holding both. */
export function union(a: Box, b: Box): Box {
  const x = Math.min(a[0], b[0])
  const y = Math.min(a[1], b[1])
  return [x, y, Math.max(right(a), right(b)) - x, Math.max(bottom(a), bottom(b)) - y]
}

/** The overlap of two boxes, or null. */
export function intersect(a: Box, b: Box): Box | null {
  const x = Math.max(a[0], b[0])
  const y = Math.max(a[1], b[1])
  const x1 = Math.min(right(a), right(b))
  const y1 = Math.min(bottom(a), bottom(b))
  return x1 > x && y1 > y ? [x, y, x1 - x, y1 - y] : null
}

/** `box` grown by `px` on every side and clipped to the frame. */
export function pad(box: Box, px: number, size: Size): Box {
  return clip([box[0] - px, box[1] - px, box[2] + 2 * px, box[3] + 2 * px], size)
}

/** `box` clipped to the frame (at least one pixel inside it). */
export function clip(box: Box, size: Size): Box {
  const x = Math.min(Math.max(0, box[0]), Math.max(0, size.width - 1))
  const y = Math.min(Math.max(0, box[1]), Math.max(0, size.height - 1))
  const x1 = Math.max(x + 1, Math.min(size.width, right(box)))
  const y1 = Math.max(y + 1, Math.min(size.height, bottom(box)))
  return [x, y, x1 - x, y1 - y]
}

export const areaOf = (b: Box): number => Math.max(0, b[2]) * Math.max(0, b[3])
