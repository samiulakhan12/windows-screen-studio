/**
 * The Captions Studio layout (docs/design/captions-studio.md §8): sizes, chunks, phrase breaks,
 * positions and keeping clear of the action, the camera, lower thirds and key presses. Pure.
 * Signatures frozen by the contracts step (§14.1); part P1 implements them.
 */
import type { Rect } from '../engine/layout'
import type { CaptionSegment, CaptionSettings, CaptionStudio, Project, StudioPosition } from '../types'
import type { ScriptTag, StudioToken } from './words'

/** A word's font as drawn: the stack (its script's font first, §6.5), weight and letter spacing (em). */
export interface StudioFace {
  stack: string
  weight: number
  tracking: number
  /** The font's width (wdth axis, percent; canvas fontStretch) when the look asks for one (§0.2: Stacked's Anek Bangla at 75); absent: 100. */
  stretch?: number
}

/** Width of `text` at `px` pixels in `face`. */
export type StudioMeasure = (text: string, px: number, face: StudioFace) => number

export interface StudioWordBox {
  /** Index into StudioLayout.tokens. */
  token: number
  text: string
  /** Left edge from the line's left edge, px. */
  x: number
  w: number
  /** Its own size, px (emphasised words are bigger, stacked lines differ). */
  px: number
  face: StudioFace
  role: 'text' | 'emphasis'
  tone?: 2
}

export interface StudioLine {
  words: StudioWordBox[]
  width: number
  height: number
  px: number
}

export interface StudioChunk {
  start: number
  end: number
  lines: StudioLine[]
  first: number
  last: number
  width: number
  height: number
}

export interface StudioLayout {
  tokens: StudioToken[]
  chunks: StudioChunk[]
  px: number
  lineHeight: number
  rtl: boolean
  /** Each token's own reading direction (layout.ts tokenDirs), for fills, wipes and typewriters. */
  dirs: ('l' | 'r')[]
  /** 0: not emphasised; 1 or 2: the emphasis tone. */
  emphasis: (0 | 1 | 2)[]
}

/** What a caption keeps clear of (§8.6), in output px. */
export interface CaptionObstacles {
  camera: readonly Rect[]
  titles: readonly Rect[]
  keys: Rect | null
  action: readonly { t: number; rect: Rect }[]
}

/** The body of a frozen signature part P1 writes. */
function notImplemented(name: string, ...args: unknown[]): never {
  void args
  throw new Error(`${name}: not implemented (Captions Studio part P1)`)
}

/** The text size, line height, room and character limit of `studio` in a `w` x `h` frame (§8.4). */
export function studioMetrics(studio: CaptionStudio, w: number, h: number, area?: Rect | null, script?: ScriptTag): { px: number; lineHeight: number; maxWidth: number; maxChars: number; tall: boolean } {
  return notImplemented('studioMetrics', studio, w, h, area, script)
}

/** Caption `seg` laid out for `studio`: tokens, chunks (§8.2) and lines broken at natural phrases (§8.3). */
export function studioLayout(
  seg: CaptionSegment,
  studio: CaptionStudio,
  w: number,
  h: number,
  measure: StudioMeasure,
  opts: { faceOf: (token: StudioToken, role: 'text' | 'emphasis') => StudioFace; area?: Rect | null; marks?: readonly { from: number; to: number; tone?: 2 }[]; language?: string; showSpeaker?: boolean; spoken?: boolean }
): StudioLayout {
  return notImplemented('studioLayout', seg, studio, w, h, measure, opts)
}

/** The lines of each chunk as [from, to] word ranges, chosen by the phrase cost of §8.3. */
export function breakPhrases(widths: number[], tokens: StudioToken[], room: number, maxChars: number, lines: number, language?: string): [number, number][][] {
  return notImplemented('breakPhrases', widths, tokens, room, maxChars, lines, language)
}

/** Index of the chunk showing at source time `t`, or -1. */
export function studioChunkAt(layout: StudioLayout, t: number): number {
  return notImplemented('studioChunkAt', layout, t)
}

/** Where `chunk` goes (§8.5, §8.6): its lines, block and the edge key presses keep clear of. */
export function placeStudio(
  layout: StudioLayout,
  chunk: StudioChunk,
  studio: CaptionStudio,
  w: number,
  h: number,
  opts: { area?: Rect | null; obstacles?: CaptionObstacles; forced?: 'top' | 'bottom'; legacyAnchor?: (position: CaptionSettings['position']) => number }
): { lines: { x: number; y: number; width: number }[]; top: number; height: number; box: Rect; edge: 'top' | 'middle' | 'bottom' } {
  return notImplemented('placeStudio', layout, chunk, studio, w, h, opts)
}

/** The obstacles of caption `seg` (§8.6): the camera over its time, the placed title boxes, key presses and the action passed in by the renderer. */
export function captionObstacles(
  project: Project,
  seg: CaptionSegment,
  w: number,
  h: number,
  given: { titles: readonly { start: number; end: number; box: Rect }[]; keys: Rect | null; action: readonly { t: number; rect: Rect }[] }
): CaptionObstacles {
  return notImplemented('captionObstacles', project, seg, w, h, given)
}

/** The edge a block reports to key presses (captionBlockAt, §8.5). */
export function blockEdge(position: StudioPosition | null, centreY: number, h: number): 'top' | 'middle' | 'bottom' {
  return notImplemented('blockEdge', position, centreY, h)
}
