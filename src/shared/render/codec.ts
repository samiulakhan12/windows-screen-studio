import type { ColorTags, Rgb32Format } from '../api/export'

/** 32-bit VideoFrame layouts ffmpeg takes as they are. */
const RAW_FORMATS: Record<string, Rgb32Format> = { BGRX: 'bgr0', BGRA: 'bgra', RGBX: 'rgb0', RGBA: 'rgba' }

/**
 * How to read a canvas VideoFrame of layout `format` as raw 32-bit pixels: as it
 * is when it already is one of those layouts, else converted by copyTo to RGBX (a
 * frame in a YUV layout, or with no CPU-visible layout at all, which some GPU
 * canvases report as null).
 */
export function rawReadback(format: string | null): { copyFormat?: 'RGBX'; pixelFormat: Rgb32Format } {
  const native = format ? RAW_FORMATS[format] : undefined
  return native ? { pixelFormat: native } : { copyFormat: 'RGBX', pixelFormat: 'rgb0' }
}

/**
 * A 32-bit frame (`order`, as rawReadback reports it) as planar 4:2:0 YUV, BT.601 limited
 * range (EXPORT_COLOR), the conversion ffmpeg would otherwise make: 1.5 bytes a pixel instead
 * of 4 to send to ffmpeg. Chroma is the mean of each 2x2 block. Even sizes only (every export
 * size is even). Written into `out` when it is given and large enough.
 */
export function rgbToI420(src: Uint8Array, width: number, height: number, order: Rgb32Format, out?: Uint8Array): Uint8Array {
  const size = width * height
  const dst = out && out.length >= (size * 3) / 2 ? out : new Uint8Array((size * 3) / 2)
  const r = order === 'bgra' || order === 'bgr0' ? 2 : 0
  const b = 2 - r
  const cw = width >> 1
  let u = size
  let v = size + (size >> 2)
  // 16.16 fixed point: Y = 16 + 219/255 (0.299 R + 0.587 G + 0.114 B), Cb and Cr scaled by 224/255.
  for (let y = 0; y < height; y += 2) {
    let i = y * width * 4
    let j = i + width * 4
    let o = y * width
    for (let x = 0; x < cw; x++, i += 8, j += 8, o += 2) {
      // The 2x2 block: (i, i + 4) on this row, (j, j + 4) on the next.
      dst[o] = (16829 * src[i + r] + 33039 * src[i + 1] + 6416 * src[i + b] + 1081344) >> 16
      dst[o + 1] = (16829 * src[i + 4 + r] + 33039 * src[i + 5] + 6416 * src[i + 4 + b] + 1081344) >> 16
      dst[o + width] = (16829 * src[j + r] + 33039 * src[j + 1] + 6416 * src[j + b] + 1081344) >> 16
      dst[o + width + 1] = (16829 * src[j + 4 + r] + 33039 * src[j + 5] + 6416 * src[j + 4 + b] + 1081344) >> 16
      const rs = src[i + r] + src[i + 4 + r] + src[j + r] + src[j + 4 + r]
      const gs = src[i + 1] + src[i + 5] + src[j + 1] + src[j + 5]
      const bs = src[i + b] + src[i + 4 + b] + src[j + b] + src[j + 4 + b]
      dst[u++] = (-9714 * rs - 19070 * gs + 28784 * bs + 33685504) >> 18
      dst[v++] = (28784 * rs - 24103 * gs - 4681 * bs + 33685504) >> 18
    }
  }
  return dst
}

/**
 * Lowest H.264 level that allows this frame size and rate (macroblocks per frame /
 * per second). Each side is also limited to sqrt(8 x max frame size) macroblocks
 * (A.3.1), which matters for very wide or tall frames.
 */
export function avcLevel(width: number, height: number, fps: number): number {
  const mbw = Math.ceil(width / 16)
  const mbh = Math.ceil(height / 16)
  const mbs = mbw * mbh
  const rate = mbs * fps
  const side = Math.max(mbw, mbh)
  const levels: [number, number, number][] = [
    [0x1f, 3600, 108000],
    [0x20, 5120, 216000],
    [0x28, 8192, 245760],
    [0x2a, 8704, 522240],
    [0x32, 22080, 589824],
    [0x33, 36864, 983040],
    [0x34, 36864, 2073600],
    [0x3c, 139264, 4177920],
    [0x3d, 139264, 8355840],
    [0x3e, 139264, 16711680]
  ]
  for (const [level, maxFrame, maxRate] of levels) if (mbs <= maxFrame && rate <= maxRate && side * side <= maxFrame * 8) return level
  return 0x3e
}

/** The parts of WebCodecs' VideoColorSpaceInit this module reads. */
export interface ReportedColorSpace {
  matrix?: string | null
  fullRange?: boolean | null
}

const MATRIX: Record<string, number> = { rgb: 0, bt709: 1, bt470bg: 5, smpte170m: 6, 'bt2020-ncl': 9 }

/**
 * Colour tags for the encoder's output. The YUV matrix and range come from the
 * decoder config the encoder reports (Chromium's software path converts canvas RGB
 * with the BT.601 matrix and says so). Primaries and transfer are always BT.709:
 * the canvas is sRGB and no gamut conversion happens, even when the encoder labels
 * its output "SMPTE 170M" wholesale; tagging those primaries would make colour-managed
 * players shift every colour.
 */
export function colorTagsFrom(space: ReportedColorSpace | undefined | null): ColorTags {
  const matrix = space?.matrix ? MATRIX[space.matrix] : undefined
  return {
    primaries: 1,
    transfer: 1,
    matrix: matrix ?? null,
    fullRange: typeof space?.fullRange === 'boolean' ? space.fullRange : null
  }
}

/**
 * VP9 level (Annex A: luma sample rate and picture size) for the WebCodecs codec
 * string, as its two-digit code (10 = level 1, 41 = level 4.1, ...).
 */
export function vp9Level(width: number, height: number, fps: number): number {
  const size = width * height
  const rate = size * fps
  const levels: [number, number, number][] = [
    [10, 36864, 829440],
    [11, 73728, 2764800],
    [20, 122880, 4608000],
    [21, 245760, 9216000],
    [30, 552960, 20736000],
    [31, 983040, 36864000],
    [40, 2228224, 83558400],
    [41, 2228224, 160432128],
    [50, 8912896, 311951360],
    [51, 8912896, 588251136],
    [52, 8912896, 1176502272],
    [60, 35651584, 1176502272],
    [61, 35651584, 2353004544],
    [62, 35651584, 4706009088]
  ]
  for (const [level, maxSize, maxRate] of levels) if (size <= maxSize && rate <= maxRate) return level
  return 62
}

/** WebCodecs codec string for 8-bit 4:2:0 VP9 (profile 0) at this size and rate. */
export const vp9Codec = (width: number, height: number, fps: number): string => `vp09.00.${vp9Level(width, height, fps)}.08`

/**
 * IVF, the minimal container ffmpeg reads VP9 from a pipe in: a 32-byte file header,
 * then each frame as a 12-byte header (size, timestamp in frames) and its bytes.
 */
export function ivfFileHeader(width: number, height: number, fps: number, frames = 0): Uint8Array {
  const b = new Uint8Array(32)
  const v = new DataView(b.buffer)
  b.set([0x44, 0x4b, 0x49, 0x46]) // 'DKIF'
  v.setUint16(4, 0, true) // version
  v.setUint16(6, 32, true) // header size
  b.set([0x56, 0x50, 0x39, 0x30], 8) // 'VP90'
  v.setUint16(12, width, true)
  v.setUint16(14, height, true)
  v.setUint32(16, fps, true) // time base denominator
  v.setUint32(20, 1, true) // time base numerator
  v.setUint32(24, frames, true)
  return b
}

/** Header of one IVF frame: its size in bytes and its timestamp (in frames). */
export function ivfFrameHeader(size: number, pts: number): Uint8Array {
  const b = new Uint8Array(12)
  const v = new DataView(b.buffer)
  v.setUint32(0, size, true)
  v.setUint32(4, pts >>> 0, true)
  v.setUint32(8, Math.floor(pts / 2 ** 32), true)
  return b
}

/** VP9 bitstream colour space names of ffmpeg's vp9_metadata filter, by H.273 matrix code point. */
const VP9_COLOR_SPACE: Record<number, string> = { 0: 'rgb', 1: 'bt709', 5: 'bt601', 6: 'smpte170', 7: 'smpte240', 9: 'bt2020' }

/** ffmpeg bitstream filter that writes the colour description into a VP9 stream, or null when unknown. */
export function vp9MetadataFilter(c: ColorTags): string | null {
  const opts: string[] = []
  if (c.matrix !== null && VP9_COLOR_SPACE[c.matrix]) opts.push(`color_space=${VP9_COLOR_SPACE[c.matrix]}`)
  if (c.fullRange !== null) opts.push(`color_range=${c.fullRange ? 'pc' : 'tv'}`)
  return opts.length ? `vp9_metadata=${opts.join(':')}` : null
}
