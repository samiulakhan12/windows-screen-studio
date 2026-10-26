/**
 * Where the speaker notes window goes, and whether it may be shown during a recording on a PC
 * that cannot keep it out of the capture (docs/design/teleprompter.md, "Window" and "Older
 * Windows"). Pure; all geometry in DIP screen coordinates.
 */
import type { Rect } from '../recording/windowGeometry'
import { NOTES_HEIGHT, NOTES_TOP_MARGIN, NOTES_WIDTH, type NotesPlacement, type NotesSettings } from './notes'

/** A display as the placement needs it (from Electron's screen.getAllDisplays()). */
export interface NotesDisplay {
  id: string
  bounds: Rect
  workArea: Rect
  primary: boolean
}

/** What a recording captures: a whole screen, an area of one, or a window. */
export type CaptureKind = 'screen' | 'area' | 'window'

/** `v` within the limits (the default when not a number), then no larger than `room`, whole DIP. */
function sizeIn(v: number, limits: { min: number; max: number; default: number }, room: number): number {
  const n = Number.isFinite(v) ? Math.min(limits.max, Math.max(limits.min, v)) : limits.default
  return Math.max(1, Math.floor(Math.min(n, room)))
}

const unitShare = (v: number): number => (Number.isFinite(v) ? Math.min(1, Math.max(0, v)) : 0.5)

const primaryOf = (displays: readonly NotesDisplay[]): NotesDisplay => displays.find((d) => d.primary) ?? displays[0]

/**
 * The window's rectangle: its size (settings, clamped to the limits and to the work area), at the
 * saved placement on its display when that display still exists, else at the top centre of the
 * primary display's work area, NOTES_TOP_MARGIN below its top. Always whole DIP and fully inside
 * one work area (never across two displays). `displays` is never empty.
 */
export function notesBounds(
  displays: readonly NotesDisplay[],
  settings: Pick<NotesSettings, 'width' | 'height' | 'placement'>
): { displayId: string; rect: Rect } {
  const saved = settings.placement ? displays.find((d) => d.id === settings.placement!.displayId) : undefined
  const display = saved ?? primaryOf(displays)
  const wa = display.workArea
  const width = sizeIn(settings.width, NOTES_WIDTH, wa.width)
  const height = sizeIn(settings.height, NOTES_HEIGHT, wa.height)
  const roomX = wa.width - width
  const roomY = wa.height - height
  if (saved && settings.placement) {
    const x = wa.x + Math.round(unitShare(settings.placement.x) * roomX)
    const y = wa.y + Math.round(unitShare(settings.placement.y) * roomY)
    return { displayId: display.id, rect: { x, y, width, height } }
  }
  const x = wa.x + Math.round(roomX / 2)
  const y = wa.y + Math.min(NOTES_TOP_MARGIN, roomY)
  return { displayId: display.id, rect: { x, y, width, height } }
}

/** The area two rectangles share (0 when they do not overlap). */
function overlapArea(a: Rect, b: Rect): number {
  const w = Math.min(a.x + a.width, b.x + b.width) - Math.max(a.x, b.x)
  const h = Math.min(a.y + a.height, b.y + b.height) - Math.max(a.y, b.y)
  return w > 0 && h > 0 ? w * h : 0
}

const contains = (r: Rect, p: { x: number; y: number }): boolean => p.x >= r.x && p.x < r.x + r.width && p.y >= r.y && p.y < r.y + r.height

/**
 * The placement that puts a window of `rect`'s size back at `rect` (the inverse of notesBounds):
 * on the display holding the rectangle's centre (else the one it overlaps most), as shares 0..1
 * of the room left on that work area (0.5 when there is no room on an axis).
 */
export function placementOf(displays: readonly NotesDisplay[], rect: Rect): NotesPlacement {
  const centre = { x: rect.x + rect.width / 2, y: rect.y + rect.height / 2 }
  let display = displays.find((d) => contains(d.bounds, centre))
  if (!display) {
    let best = 0
    for (const d of displays) {
      const a = overlapArea(d.bounds, rect)
      if (a > best) {
        best = a
        display = d
      }
    }
  }
  display ??= primaryOf(displays)
  const wa = display.workArea
  const share = (offset: number, room: number): number => (room > 0 ? Math.min(1, Math.max(0, offset / room)) : 0.5)
  return {
    displayId: display.id,
    x: share(rect.x - wa.x, wa.width - rect.width),
    y: share(rect.y - wa.y, wa.height - rect.height)
  }
}

/** Whether two rectangles share any area (touching edges do not). */
export function rectsOverlap(a: Rect, b: Rect): boolean {
  return overlapArea(a, b) > 0
}

/**
 * What a recording captures, on the displays as they are now: `captured` was that share of the
 * recorded display `was` (its id, and its bounds when `captured` was found), so it is the same
 * share of that display now (a resolution, scaling or layout change moves and scales it). null
 * when the display is gone.
 */
export function capturedNow(displays: readonly NotesDisplay[], was: { id: string; bounds: Rect }, captured: Rect): Rect | null {
  const now = displays.find((d) => d.id === was.id)?.bounds
  if (!now) return null
  const sx = now.width / was.bounds.width
  const sy = now.height / was.bounds.height
  return {
    x: now.x + (captured.x - was.bounds.x) * sx,
    y: now.y + (captured.y - was.bounds.y) * sy,
    width: captured.width * sx,
    height: captured.height * sy
  }
}

/**
 * Whether the notes may be shown during a recording. Where the PC keeps them out of the capture
 * (`excluded`): always. Otherwise never for a window recording (the window can move under them),
 * and for a screen or an area only when the notes do not overlap what is captured (`captured`:
 * the display's bounds, or the area's rectangle; null = unknown, so no).
 */
export function notesAllowed(o: { excluded: boolean; kind: CaptureKind; notes: Rect; captured: Rect | null }): boolean {
  if (o.excluded) return true
  if (o.kind === 'window' || !o.captured) return false
  return !rectsOverlap(o.notes, o.captured)
}
