/**
 * Where the speaker notes window goes, and whether it may be shown during a recording on a PC
 * that cannot keep it out of the capture (docs/design/teleprompter.md, "Window" and "Older
 * Windows"). Pure; all geometry in DIP screen coordinates.
 *
 * STUB (contracts commit): signatures and doc comments frozen, bodies by workstream A.
 */
import type { Rect } from '../recording/windowGeometry'
import type { NotesPlacement, NotesSettings } from './notes'

/** A display as the placement needs it (from Electron's screen.getAllDisplays()). */
export interface NotesDisplay {
  id: string
  bounds: Rect
  workArea: Rect
  primary: boolean
}

/** What a recording captures: a whole screen, an area of one, or a window. */
export type CaptureKind = 'screen' | 'area' | 'window'

/**
 * The window's rectangle: its size (settings, clamped to the limits and to the work area), at the
 * saved placement on its display when that display still exists, else at the top centre of the
 * primary display's work area, NOTES_TOP_MARGIN below its top. Always whole DIP and fully inside
 * one work area (never across two displays). `displays` is never empty.
 */
export function notesBounds(
  _displays: readonly NotesDisplay[],
  _settings: Pick<NotesSettings, 'width' | 'height' | 'placement'>
): { displayId: string; rect: Rect } {
  throw new Error('notesBounds: not implemented yet (workstream A)')
}

/**
 * The placement that puts a window of `rect`'s size back at `rect` (the inverse of notesBounds):
 * on the display holding the rectangle's centre (else the one it overlaps most), as shares 0..1
 * of the room left on that work area (0.5 when there is no room on an axis).
 */
export function placementOf(_displays: readonly NotesDisplay[], _rect: Rect): NotesPlacement {
  throw new Error('placementOf: not implemented yet (workstream A)')
}

/** Whether two rectangles share any area (touching edges do not). */
export function rectsOverlap(_a: Rect, _b: Rect): boolean {
  throw new Error('rectsOverlap: not implemented yet (workstream A)')
}

/**
 * Whether the notes may be shown during a recording. Where the PC keeps them out of the capture
 * (`excluded`): always. Otherwise never for a window recording (the window can move under them),
 * and for a screen or an area only when the notes do not overlap what is captured (`captured`:
 * the display's bounds, or the area's rectangle; null = unknown, so no).
 */
export function notesAllowed(_o: { excluded: boolean; kind: CaptureKind; notes: Rect; captured: Rect | null }): boolean {
  throw new Error('notesAllowed: not implemented yet (workstream A)')
}
