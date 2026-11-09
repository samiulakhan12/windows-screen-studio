/**
 * Codec levels and WebCodecs codec strings of HEVC and AV1 (docs/design/output-and-languages.md §5.4,
 * §5.6). Pure. Part P1 writes it; the contracts' stubs give nothing usable, so no WebCodecs HEVC or
 * AV1 configuration is made before P1.
 */

/** The lowest HEVC Main-tier level that holds the export, × 30 (1080p60 → 123). Part P1. */
export function hevcLevel(width: number, height: number, fps: number): number {
  void width
  void height
  void fps
  return 0
}

/** The AV1 level and its seq_level_idx (1080p60 → 4.0, 8). Part P1. */
export function av1Level(width: number, height: number, fps: number): { level: string; seqLevelIdx: number } {
  void width
  void height
  void fps
  return { level: '', seqLevelIdx: 0 }
}

/** 'hvc1.1.6.L{level}.B0'. Part P1. */
export function hevcCodecString(width: number, height: number, fps: number): string {
  void width
  void height
  void fps
  return ''
}

/** 'av01.0.{level}M.08'. Part P1. */
export function av1CodecString(width: number, height: number, fps: number): string {
  void width
  void height
  void fps
  return ''
}

/** Whether H.264 at level 5.2 or lower holds the export (4K at 120 fps does not). Part P1. */
export function h264Fits(width: number, height: number, fps: number): boolean {
  void width
  void height
  void fps
  return true
}
