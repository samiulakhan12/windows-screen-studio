/**
 * Editing a Captions Studio look (docs/design/captions-studio.md §5.7, §5.8): picking a tile, the
 * Studio twin of a legacy look, edits that set `picked`, the size shown in tall frames, line
 * lengths and speaker names.
 *
 * CONTRACT (part P1): signatures are frozen; bodies are to be written.
 */
import type { CaptionPreset, CaptionSettings, CaptionStudio } from '../types'

/** The body of a frozen signature part P1 writes. */
function notImplemented(name: string, ...args: unknown[]): never {
  void args
  throw new Error(`${name}: not implemented (Captions Studio part P1)`)
}

/** The Studio look that draws a legacy look the same way (§5.8), with `legacyAnchor`. */
export function legacyTwin(settings: CaptionSettings): CaptionStudio {
  return notImplemented('legacyTwin', settings)
}

/** Settings with gallery tile `tile` picked (§5.8): its look, its fallback preset, `picked`; show, showSpeaker, track and a dragged place kept. */
export function withStudioTile(
  settings: CaptionSettings,
  tile: string,
  frame: { w: number; h: number },
  opts?: { saved?: readonly { id: string; look: CaptionStudio }[]; brand?: CaptionStudio }
): CaptionSettings {
  return notImplemented('withStudioTile', settings, tile, frame, opts)
}

/** Settings with a legacy tile picked: withPreset, `picked`, no `studio`. */
export function withLegacyTile(settings: CaptionSettings, preset: CaptionPreset): CaptionSettings {
  return notImplemented('withLegacyTile', settings, preset)
}

/** Settings with the look changed by `patch` (made from the Studio twin on a legacy look), `picked` set. */
export function editStudio(settings: CaptionSettings, patch: (s: CaptionStudio) => CaptionStudio): CaptionSettings {
  return notImplemented('editStudio', settings, patch)
}

/** Whether the look differs from its tile's (the name line's "(edited)", §5.7). */
export function studioEdited(studio: CaptionStudio, saved?: readonly { id: string; look: CaptionStudio }[]): boolean {
  return notImplemented('studioEdited', studio, saved)
}

/** The size shown and drawn in a `w` x `h` frame (`size × tall` in tall frames). */
export function studioSize(studio: CaptionStudio, w: number, h: number): number {
  return notImplemented('studioSize', studio, w, h)
}

/** The look with the size shown in a `w` x `h` frame set to `shown`. */
export function setStudioSize(studio: CaptionStudio, shown: number, w: number, h: number): CaptionStudio {
  return notImplemented('setStudioSize', studio, shown, w, h)
}

/** The Line length chip the look's characters match, or null (§2.6). */
export function lineLengthOf(studio: CaptionStudio): 'short' | 'medium' | 'long' | null {
  return notImplemented('lineLengthOf', studio)
}

/** The look with line length `l` (LINE_LENGTHS). */
export function withLineLength(studio: CaptionStudio, l: 'short' | 'medium' | 'long'): CaptionStudio {
  return notImplemented('withLineLength', studio, l)
}

/** Speaker names on or off; off also turns speaker colours off (§2.6). */
export function withSpeakerNames(settings: CaptionSettings, on: boolean): CaptionSettings {
  return notImplemented('withSpeakerNames', settings, on)
}
