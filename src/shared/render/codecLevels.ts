/**
 * Codec levels and WebCodecs codec strings of HEVC and AV1 (docs/design/output-and-languages.md §5.4,
 * §5.6), and whether H.264 can carry an export at all. Pure.
 */
import { avcLevel } from './codec'

/**
 * HEVC Main-tier levels (H.265 Table A.8) from 3.1 up: level × 30, the largest luma picture size and
 * the largest luma sample rate. Each side may be at most √(8 × picture size) (A.4.1).
 */
const HEVC_LEVELS: readonly (readonly [level: number, pictureSize: number, sampleRate: number])[] = [
  [93, 983_040, 33_177_600],
  [120, 2_228_224, 66_846_720],
  [123, 2_228_224, 133_693_440],
  [150, 8_912_896, 267_386_880],
  [153, 8_912_896, 534_773_760],
  [156, 8_912_896, 1_069_547_520],
  [180, 35_651_584, 1_069_547_520],
  [183, 35_651_584, 2_139_095_040],
  [186, 35_651_584, 4_278_190_080]
]

/** A side as an HEVC encoder codes it: padded to a multiple of 8 luma samples. */
const coded = (v: number): number => Math.ceil(Math.max(1, v) / 8) * 8

/** The lowest HEVC Main-tier level that holds the export, × 30 (1080p60 → 123, 2160p60 → 153). */
export function hevcLevel(width: number, height: number, fps: number): number {
  const w = coded(width)
  const h = coded(height)
  const size = w * h
  const rate = size * Math.max(1, fps)
  for (const [level, maxSize, maxRate] of HEVC_LEVELS) {
    const side = Math.sqrt(maxSize * 8)
    if (size <= maxSize && rate <= maxRate && w <= side && h <= side) return level
  }
  return HEVC_LEVELS[HEVC_LEVELS.length - 1][0]
}

/**
 * AV1 levels (AV1 Annex A.3) from 2.0 up: the name, seq_level_idx, the largest picture size, the
 * largest width and height, and the largest display rate (luma samples a second).
 */
const AV1_LEVELS: readonly (readonly [level: string, idx: number, pictureSize: number, maxW: number, maxH: number, displayRate: number])[] = [
  ['2.0', 0, 147_456, 2048, 1152, 4_423_680],
  ['2.1', 1, 278_784, 2816, 1584, 8_363_520],
  ['3.0', 4, 665_856, 4352, 2448, 19_975_680],
  ['3.1', 5, 1_065_024, 5504, 3096, 31_950_720],
  ['4.0', 8, 2_359_296, 6144, 3456, 70_778_880],
  ['4.1', 9, 2_359_296, 6144, 3456, 141_557_760],
  ['5.0', 12, 8_912_896, 8192, 4352, 267_386_880],
  ['5.1', 13, 8_912_896, 8192, 4352, 534_773_760],
  ['5.2', 14, 8_912_896, 8192, 4352, 1_069_547_520],
  ['6.0', 16, 35_651_584, 16384, 8704, 1_069_547_520],
  ['6.1', 17, 35_651_584, 16384, 8704, 2_139_095_040],
  ['6.2', 18, 35_651_584, 16384, 8704, 4_278_190_080]
]

/**
 * The lowest AV1 level that holds the export, with its seq_level_idx (Annex A.3's display rates):
 * 4.0 (8) up to 1080p30, 4.1 (9) at 1080p60, 5.0 (12) for 1080p120, 1440p60 and 2160p30, 5.1 (13) for
 * 2160p60, 5.2 (14) for 2160p120. A tall frame is held to the same limits on its long and short side.
 */
export function av1Level(width: number, height: number, fps: number): { level: string; seqLevelIdx: number } {
  const long = Math.max(width, height)
  const short = Math.min(width, height)
  const size = width * height
  const rate = size * Math.max(1, fps)
  for (const [level, seqLevelIdx, maxSize, maxW, maxH, maxRate] of AV1_LEVELS) {
    if (size <= maxSize && long <= maxW && short <= maxH && rate <= maxRate) return { level, seqLevelIdx }
  }
  const [level, seqLevelIdx] = AV1_LEVELS[AV1_LEVELS.length - 1]
  return { level, seqLevelIdx }
}

/** The WebCodecs codec string of HEVC Main, Main tier: 'hvc1.1.6.L{level × 30}.B0' ('hvc1.1.6.L123.B0' at 1080p60). */
export function hevcCodecString(width: number, height: number, fps: number): string {
  return `hvc1.1.6.L${hevcLevel(width, height, fps)}.B0`
}

/** The WebCodecs codec string of AV1 Main, Main tier, 8-bit: 'av01.0.{seq_level_idx}M.08' ('av01.0.09M.08' at 1080p60). */
export function av1CodecString(width: number, height: number, fps: number): string {
  return `av01.0.${String(av1Level(width, height, fps).seqLevelIdx).padStart(2, '0')}M.08`
}

/** H.264 level 5.2 in `avcLevel`'s code: the highest the GPU and WebCodecs H.264 encoders take. */
const AVC_LEVEL_52 = 0x34

/** Whether H.264 at level 5.2 or lower holds the export (2560×1440 at 120 fps does, 4K at 120 fps does not). */
export function h264Fits(width: number, height: number, fps: number): boolean {
  return avcLevel(width, height, fps) <= AVC_LEVEL_52
}
