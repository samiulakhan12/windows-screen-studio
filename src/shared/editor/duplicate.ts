/**
 * Duplicate, Make a vertical version and Make a square version (X-04, NW-05,
 * docs/design/vertical-video.md §4.8): the copy's name, whether a copy can be made, and the
 * project the copy starts as. Pure: the renderer builds the copy from the editor's current state
 * (unsaved edits included); main gives it its new id, copies the files and writes it last
 * (src/main/projectCopy.ts).
 *
 * CONTRACT (part P4): signatures are frozen; bodies are to be written.
 */
import type { Rect } from '../engine/layout'
import type { Project } from '../types'

export type CopyKind = 'copy' | 'vertical' | 'square'

/** "Billing demo (copy)", "(vertical)", "(square)"; a blank name gives "Untitled recording (…)"; at most 120 characters. */
export function copyName(name: string, kind: CopyKind): string {
  return notImplemented(name, kind)
}

/** Measures text as the compositor draws it (px wide). */
export type MeasureText = (text: string, px: number, font: string, weight: number) => number

/** Whether a copy of `kind` can be made, with the menu's reason when not (§2.2). vw × vh: the recording as cropped. */
export function canCopyAs(project: Project, kind: CopyKind, vw: number, vh: number): { ok: true } | { ok: false; reason: string } {
  return notImplemented(project, kind, vw, vh)
}

/**
 * The project as copied (still with `project.id`; main gives the new id):
 *  - 'copy': only the name changes.
 *  - 'vertical' / 'square': aspectRatio '9:16' / '1:1'; reframe = { ...DEFAULT_REFRAME, ...project.reframe,
 *    mode: 'follow', camera: kind === 'vertical' ? (project.reframe?.camera ?? 'top') : 'bubble',
 *    appSafe: kind === 'vertical' }; text annotations and image overlays refitted (refitItems).
 * Never changes clips, zooms, layouts, captions, shapes, crop, freezes or any other field. Pure: the input is not mutated.
 */
export function projectCopy(project: Project, kind: CopyKind, measure: MeasureText | null): Project {
  return notImplemented(project, kind, measure)
}

/**
 * Text and images moved into `area` (output px of a w × h frame; §6.4): each item already inside is the same object;
 * else shifted in; if larger than the area, scaled down to fit but not below 60% of its size; a text still too wide
 * at 60% is broken at the space nearest its middle ("\n"), then shifted.
 */
export function refitItems(
  project: Pick<Project, 'annotations' | 'overlays'>,
  w: number,
  h: number,
  area: Rect,
  measure: MeasureText | null
): Pick<Project, 'annotations' | 'overlays'> {
  return notImplemented(project, w, h, area, measure)
}

/** Placeholder of the contract; the implementation replaces every call. */
function notImplemented(...args: unknown[]): never {
  void args
  throw new Error('not implemented')
}
