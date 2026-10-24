import type { ColorTags, RawPixelFormat } from '../api/export'

/** 32-bit VideoFrame layouts ffmpeg takes as they are. */
const RAW_FORMATS: Record<string, RawPixelFormat> = { BGRX: 'bgr0', BGRA: 'bgra', RGBX: 'rgb0', RGBA: 'rgba' }

/**
 * How to read a canvas VideoFrame of layout `format` as raw 32-bit pixels: as it
 * is when it already is one of those layouts, else converted by copyTo to RGBX (a
 * frame in a YUV layout, or with no CPU-visible layout at all, which some GPU
 * canvases report as null).
 */
export function rawReadback(format: string | null): { copyFormat?: 'RGBX'; pixelFormat: RawPixelFormat } {
  const native = format ? RAW_FORMATS[format] : undefined
  return native ? { pixelFormat: native } : { copyFormat: 'RGBX', pixelFormat: 'rgb0' }
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
