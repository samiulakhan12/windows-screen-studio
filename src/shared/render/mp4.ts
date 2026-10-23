/**
 * Minimal MP4 (ISO BMFF) demuxer for the H.264 proxies the app produces: finds the
 * video track and returns its sample table, so frames can be decoded in order with
 * WebCodecs instead of seeking a <video> element once per exported frame.
 *
 * Pure (no DOM): bytes come from a `read(offset, length)` callback.
 */

export type ReadBytes = (offset: number, length: number) => Promise<Uint8Array>

export interface VideoSample {
  /** Byte offset and size of the sample in the file. */
  offset: number
  size: number
  /** Presentation time in seconds (after the edit list), as a <video> element reports it. */
  time: number
  /** Duration in seconds. */
  duration: number
  key: boolean
}

export interface VideoTrackInfo {
  /** WebCodecs codec string, e.g. "avc1.640028". */
  codec: string
  /** avcC record (VideoDecoderConfig.description). */
  description: Uint8Array
  codedWidth: number
  codedHeight: number
  /** Samples in decode order. */
  samples: VideoSample[]
}

interface Box {
  type: string
  start: number
  /** Payload start (after the header). */
  data: number
  end: number
}

class Reader {
  private readonly view: DataView
  constructor(readonly bytes: Uint8Array) {
    this.view = new DataView(bytes.buffer, bytes.byteOffset, bytes.byteLength)
  }
  u8(at: number): number {
    return this.view.getUint8(at)
  }
  u16(at: number): number {
    return this.view.getUint16(at)
  }
  u32(at: number): number {
    return this.view.getUint32(at)
  }
  i32(at: number): number {
    return this.view.getInt32(at)
  }
  u64(at: number): number {
    return this.u32(at) * 2 ** 32 + this.u32(at + 4)
  }
  i64(at: number): number {
    return this.view.getInt32(at) * 2 ** 32 + this.u32(at + 4)
  }
  type(at: number): string {
    return String.fromCharCode(this.u8(at), this.u8(at + 1), this.u8(at + 2), this.u8(at + 3))
  }
}

function children(r: Reader, from: number, to: number): Box[] {
  const out: Box[] = []
  let at = from
  while (at + 8 <= to) {
    let size = r.u32(at)
    const type = r.type(at + 4)
    let data = at + 8
    if (size === 1) {
      size = r.u64(at + 8)
      data = at + 16
    } else if (size === 0) {
      size = to - at
    }
    if (size < 8 || at + size > to) break
    out.push({ type, start: at, data, end: at + size })
    at += size
  }
  return out
}

const find = (r: Reader, parent: Box, type: string): Box | undefined => children(r, parent.data, parent.end).find((b) => b.type === type)

function path(r: Reader, parent: Box, ...types: string[]): Box | undefined {
  let box: Box | undefined = parent
  for (const t of types) {
    if (!box) return undefined
    box = find(r, box, t)
  }
  return box
}

const hex2 = (n: number): string => n.toString(16).padStart(2, '0')

/** Locates the top-level `moov` box with ranged reads (works whether or not it precedes `mdat`). */
async function readMoov(read: ReadBytes, fileSize: number): Promise<Reader> {
  let at = 0
  while (at + 8 <= fileSize) {
    const head = new Reader(await read(at, Math.min(16, fileSize - at)))
    let size = head.u32(0)
    const type = head.type(4)
    if (size === 1) size = head.u64(8)
    else if (size === 0) size = fileSize - at
    if (size < 8) throw new Error('Corrupt MP4 box header')
    if (type === 'moov') return new Reader(await read(at, size))
    at += size
  }
  throw new Error('MP4 has no moov box')
}

interface EditList {
  /** Media time (track timescale) where presentation starts; 0 when there is no edit. */
  mediaStart: number
}

function parseEditList(r: Reader, trak: Box): EditList {
  const elst = path(r, trak, 'edts', 'elst')
  if (!elst) return { mediaStart: 0 }
  const version = r.u8(elst.data)
  const count = r.u32(elst.data + 4)
  let at = elst.data + 8
  for (let i = 0; i < count; i++) {
    const mediaTime = version === 1 ? r.i64(at + 8) : r.i32(at + 4)
    at += version === 1 ? 20 : 12
    // Like Chromium, skip empty edits and use the first real one as the start offset.
    if (mediaTime >= 0) return { mediaStart: mediaTime }
  }
  return { mediaStart: 0 }
}

function parseSampleEntry(r: Reader, stsd: Box): { codec: string; description: Uint8Array; width: number; height: number } {
  // stsd: version/flags (4) + entry count (4), then sample entries.
  const entries = children(r, stsd.data + 8, stsd.end)
  const entry = entries.find((e) => e.type === 'avc1' || e.type === 'avc3')
  if (!entry) throw new Error(`Unsupported video codec (${entries.map((e) => e.type).join(', ') || 'none'})`)
  // VisualSampleEntry: 6 reserved + 2 data_reference_index + 16 pre-defined/reserved, then width/height.
  const width = r.u16(entry.data + 24)
  const height = r.u16(entry.data + 26)
  const avcC = children(r, entry.data + 78, entry.end).find((b) => b.type === 'avcC')
  if (!avcC) throw new Error('H.264 track has no avcC record')
  const description = r.bytes.slice(avcC.data, avcC.end)
  const codec = `avc1.${hex2(description[1])}${hex2(description[2])}${hex2(description[3])}`
  return { codec, description, width, height }
}

/** Parses the first video track's sample table. */
export async function demuxVideoTrack(read: ReadBytes, fileSize: number): Promise<VideoTrackInfo> {
  const r = await readMoov(read, fileSize)
  const moov: Box = { type: 'moov', start: 0, data: 8, end: r.bytes.length }
  const trak = children(r, moov.data, moov.end).find((b) => {
    if (b.type !== 'trak') return false
    const hdlr = path(r, b, 'mdia', 'hdlr')
    return !!hdlr && r.type(hdlr.data + 8) === 'vide'
  })
  if (!trak) throw new Error('MP4 has no video track')
  const mdhd = path(r, trak, 'mdia', 'mdhd')
  const stbl = path(r, trak, 'mdia', 'minf', 'stbl')
  if (!mdhd || !stbl) throw new Error('Incomplete video track')
  const timescale = r.u8(mdhd.data) === 1 ? r.u32(mdhd.data + 20) : r.u32(mdhd.data + 12)
  const box = (t: string): Box | undefined => find(r, stbl, t)
  const stsd = box('stsd')
  const stts = box('stts')
  const stsz = box('stsz')
  const stsc = box('stsc')
  const stco = box('stco') ?? box('co64')
  if (!stsd || !stts || !stsz || !stsc || !stco) throw new Error('Incomplete sample table')
  const entry = parseSampleEntry(r, stsd)

  // Sizes.
  const fixedSize = r.u32(stsz.data + 4)
  const count = r.u32(stsz.data + 8)
  const sizes = new Array<number>(count)
  for (let i = 0; i < count; i++) sizes[i] = fixedSize || r.u32(stsz.data + 12 + i * 4)

  // Decode timestamps.
  const dts = new Array<number>(count)
  const durations = new Array<number>(count)
  {
    const n = r.u32(stts.data + 4)
    let i = 0
    let t = 0
    for (let e = 0; e < n && i < count; e++) {
      const c = r.u32(stts.data + 8 + e * 8)
      const d = r.u32(stts.data + 12 + e * 8)
      for (let k = 0; k < c && i < count; k++, i++) {
        dts[i] = t
        durations[i] = d
        t += d
      }
    }
    for (; i < count; i++) {
      dts[i] = t
      durations[i] = 0
    }
  }

  // Composition offsets (B-frames).
  const cts = dts.slice()
  const ctts = box('ctts')
  if (ctts) {
    const version = r.u8(ctts.data)
    const n = r.u32(ctts.data + 4)
    let i = 0
    for (let e = 0; e < n && i < count; e++) {
      const c = r.u32(ctts.data + 8 + e * 8)
      const off = version === 1 ? r.i32(ctts.data + 12 + e * 8) : r.u32(ctts.data + 12 + e * 8)
      for (let k = 0; k < c && i < count; k++, i++) cts[i] = dts[i] + off
    }
  }

  // Keyframes (no stss = every sample is a sync sample).
  const stss = box('stss')
  const key = new Array<boolean>(count).fill(!stss)
  if (stss) {
    const n = r.u32(stss.data + 4)
    for (let e = 0; e < n; e++) {
      const s = r.u32(stss.data + 8 + e * 4) - 1
      if (s >= 0 && s < count) key[s] = true
    }
  }

  // Chunk offsets -> sample offsets.
  const co64 = stco.type === 'co64'
  const chunkCount = r.u32(stco.data + 4)
  const chunkOffset = (c: number): number => (co64 ? r.u64(stco.data + 8 + c * 8) : r.u32(stco.data + 8 + c * 4))
  const offsets = new Array<number>(count)
  {
    const n = r.u32(stsc.data + 4)
    let sample = 0
    for (let e = 0; e < n; e++) {
      const first = r.u32(stsc.data + 8 + e * 12) - 1
      const perChunk = r.u32(stsc.data + 12 + e * 12)
      const last = e + 1 < n ? r.u32(stsc.data + 8 + (e + 1) * 12) - 1 : chunkCount
      for (let c = first; c < last && sample < count; c++) {
        let at = chunkOffset(c)
        for (let k = 0; k < perChunk && sample < count; k++, sample++) {
          offsets[sample] = at
          at += sizes[sample]
        }
      }
    }
    if (sample < count) throw new Error('Sample-to-chunk table does not cover every sample')
  }

  const { mediaStart } = parseEditList(r, trak)
  const samples: VideoSample[] = new Array(count)
  for (let i = 0; i < count; i++) {
    samples[i] = {
      offset: offsets[i],
      size: sizes[i],
      time: (cts[i] - mediaStart) / timescale,
      duration: durations[i] / timescale,
      key: key[i]
    }
  }
  return { codec: entry.codec, description: entry.description, codedWidth: entry.width, codedHeight: entry.height, samples }
}

/**
 * Index (into `order`, the samples sorted by presentation time) of the frame shown
 * at time `t`: the last frame starting at or before `t + epsilon`. `epsilon` is half
 * a frame, so a time on a frame boundary picks that frame, never the previous one.
 */
export function presentationIndex(order: VideoSample[], t: number, epsilon: number): number {
  let lo = 0
  let hi = order.length - 1
  let best = 0
  while (lo <= hi) {
    const mid = (lo + hi) >> 1
    if (order[mid].time <= t + epsilon) {
      best = mid
      lo = mid + 1
    } else {
      hi = mid - 1
    }
  }
  return best
}
