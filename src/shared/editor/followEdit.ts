/**
 * Steering the view that follows the action (docs/design/vertical-video.md §2.6): Hold the view
 * here (a 1× zoom with a fixed point, or the zoom at the playhead fixed), dragging the picture,
 * and the state the Vertical framing section shows. Pure: each edit is one project out (one
 * store.update), positions in full-frame coordinates (through crop.ts fromCrop). A new hold is a 1×
 * zoom with a fixed point that never joins a neighbouring zoom, so it changes nothing in a frame
 * that does not follow (a 16:9 file); fixing or moving the point of a zoom that is there already
 * changes that zoom in every frame, as editing it in the Zoom tab does.
 */
import { cropProject, fromCrop, toCrop, visibleSize, zoomFromView, zoomInView } from '../engine/crop'
import { bandSide, outputSize } from '../engine/layout'
import { clamp } from '../engine/math'
import { followLimits, framedZooms } from '../engine/reframe'
import { canFollow, followApplies, reframeOn, withReframe } from '../engine/reframeData'
import { connectGap, DEFAULT_NEW_ZOOM, insertZoom, zoomAt, zoomStyleOf } from '../engine/zoom'
import type { AspectRatio, NormRect, Project, ZoomSegment } from '../types'
import { dragRegion } from './zoomEdit'

/** A view-space point kept on the recording. */
const inUnit = (p: { x: number; y: number }): { x: number; y: number } => ({ x: clamp(p.x, 0, 1), y: clamp(p.y, 0, 1) })

/** `p` with zoom `id` replaced by `next` (the same project when nothing changed). */
function withZoom(p: Project, id: string, next: ZoomSegment): Project {
  return { ...p, zooms: p.zooms.map((z) => (z.id === id ? next : z)) }
}

/**
 * Holds the view at `centre` (view space) at source time `t`: outside any zoom, a new 1× zoom with
 * that fixed point (3 s, fitted into the free gap like insertZoom, at least 1 s); inside one, that
 * zoom's focus fixed there (a region keeps its rectangle, so the project is returned as it is). The
 * zoom is no longer automatic, so regenerating auto zooms keeps it. `crop`: the project's crop
 * (cropOf), null without.
 *
 * The new zoom keeps a connect gap (zoom.ts connectGap) from the zooms on either side: joined to
 * one, the camera of a frame that does not follow would pan from that zoom into the hold (or break
 * a pan between the two) instead of zooming out where it did. A playhead within that gap of a zoom
 * has no room.
 */
export function holdViewAt(
  project: Project,
  t: number,
  centre: { x: number; y: number },
  crop: NormRect | null
): { project: Project; zoomId: string } | { project: null; reason: 'no-room' } {
  const at = fromCrop(crop, inUnit(centre))
  const z = zoomAt(project.zooms, t)
  if (z) {
    if (z.focus.mode === 'region') return { project, zoomId: z.id }
    return { project: withZoom(project, z.id, { ...z, focus: { mode: 'fixed', x: at.x, y: at.y }, auto: false }), zoomId: z.id }
  }
  const options = { lead: 0, length: DEFAULT_NEW_ZOOM, scale: 1, focus: { mode: 'fixed' as const, x: at.x, y: at.y } }
  // Each zoom widened by its connect gap with the new one: the free gap left is where the hold
  // cannot join it (the gap is the same on both sides, the average of the two transitions).
  const style = zoomStyleOf(project)
  const fresh: ZoomSegment = { id: '', start: t, end: t + DEFAULT_NEW_ZOOM, scale: 1, focus: options.focus, auto: false }
  const kept = project.zooms.map((o) => ({ ...o, start: o.start - connectGap(o, fresh, style), end: o.end + connectGap(o, fresh, style) }))
  const r = insertZoom(kept, t, project.duration, options)
  if (!r.ok) return { project: null, reason: 'no-room' }
  const hold = r.zooms.find((o) => o.id === r.id)
  if (!hold) return { project: null, reason: 'no-room' }
  return { project: { ...project, zooms: [...project.zooms, hold].sort((a, b) => a.start - b.start) }, zoomId: r.id }
}

/**
 * The picture dragged by `delta` (view units: shares of the recording as drawn, after the crop;
 * the content follows the pointer, so the view moves the other way) at source time `t`: the zoom
 * there moves its fixed point (a region its rectangle, kept inside the recording). Without cursor
 * data (`noData`) and no zoom, the rest point moves (from the centre of what is shown when none is
 * set). A zoom that follows the cursor, or no zoom while there is cursor data, has no point to
 * move: the project comes back as it is, and the caller holds the view first (holdViewAt at the
 * view's centre, in the same gesture), then drags that.
 */
export function dragView(project: Project, t: number, delta: { x: number; y: number }, crop: NormRect | null, noData: boolean): Project {
  const dx = Number.isFinite(delta.x) ? delta.x : 0
  const dy = Number.isFinite(delta.y) ? delta.y : 0
  const z = zoomAt(project.zooms, t)
  if (z) {
    const view = zoomInView(crop, z)
    const f = view.focus
    if (f.mode === 'fixed') {
      const p = inUnit({ x: f.x - dx, y: f.y - dy })
      return withZoom(project, z.id, zoomFromView(crop, { ...view, focus: { mode: 'fixed', x: p.x, y: p.y }, auto: false }))
    }
    if (f.mode === 'region') {
      const box = dragRegion(f, 'move', -dx, -dy)
      return withZoom(project, z.id, zoomFromView(crop, { ...view, focus: { mode: 'region', ...box }, auto: false }))
    }
    return project
  }
  if (!noData) return project
  const rest = toCrop(crop, project.reframe?.rest ?? fromCrop(crop, { x: 0.5, y: 0.5 }))
  return withReframe(project, { rest: fromCrop(crop, inUnit({ x: rest.x - dx, y: rest.y - dy })) })
}

/**
 * What the Vertical framing section says (§2.5): a frame that cannot follow ('unavailable': not
 * narrower than the recording as cropped, vw × vh), following turned off ('off'), following
 * without cursor data ('no-input': the view stays where it is put) or following.
 */
export function followStatus(project: Project, cursorValid: boolean, vw: number, vh: number): 'off' | 'following' | 'no-input' | 'unavailable' {
  if (!canFollow(project.style.aspectRatio, vw, vh)) return 'unavailable'
  if (project.reframe?.mode !== 'follow') return 'off'
  return cursorValid ? 'following' : 'no-input'
}

/**
 * Following turned on (reframeOn: the stored settings with mode 'follow', else the defaults for the
 * frame) or off (the settings kept with mode 'fit', which draws exactly as before; the same project
 * when it does not follow), for the section's toggle and the Follow the action command. vw × vh:
 * the recording as cropped.
 */
export function withFollowing(project: Project, on: boolean, vw: number, vh: number): Project {
  if (!on) return project.reframe && project.reframe.mode !== 'fit' ? { ...project, reframe: { ...project.reframe, mode: 'fit' } } : project
  const frame = outputSize(project.style.aspectRatio, vw, vh, 1080)
  return { ...project, reframe: reframeOn(project, frame.width, frame.height) }
}

/** Keep text clear of app buttons, on or off: it never turns following on (a project without settings gets them with mode 'fit'). */
export function withAppSafe(project: Project, on: boolean): Project {
  return withReframe(project, { mode: project.reframe?.mode ?? 'fit', appSafe: on })
}

/** The project's own frame (its aspect at the canonical 1080 size) and the recording as cropped, as the panels measure it. */
export function editorFrame(project: Project): { outW: number; outH: number; vw: number; vh: number } {
  const { width: vw, height: vh } = visibleSize(project)
  const out = outputSize(project.style.aspectRatio, vw, vh, 1080)
  return { outW: out.width, outH: out.height, vw, vh }
}

/** Whether the project's own frame follows the action (the panels' hints: device frame, tilt, zoom levels). */
export function followsAction(project: Project): boolean {
  const f = editorFrame(project)
  return followApplies(project, f.outW, f.outH, f.vw, f.vh)
}

/** The side of the camera band in the project's own frame while it follows, else null (the Camera tab's hint). */
export function bandOf(project: Project): 'top' | 'bottom' | null {
  const f = editorFrame(project)
  return followApplies(project, f.outW, f.outH, f.vw, f.vh) ? bandSide(project, f.outW, f.outH, f.vw, f.vh) : null
}

/**
 * The level zoom `id` shows at in the project's followed frame (§5.12: half strength, capped so the
 * picture stays sharp, a region framed in the view), or null when the frame does not follow: the
 * Zoom tab's line about the selected zoom.
 */
export function framedLevel(project: Project, id: string): number | null {
  if (!followsAction(project)) return null
  const drawn = cropProject(project)
  const limits = followLimits(drawn)
  if (!limits) return null
  return framedZooms(drawn.zooms, limits).find((z) => z.id === id)?.scale ?? null
}

/**
 * What the Export dialog suggests (§2.2): 'vertical' when a 9:16 output is chosen (`aspects`: the
 * preset or aspect of the file, or of any batch item) that could follow a vw × vh recording while
 * the project does not follow, else 'square' for such a 1:1 output, else null.
 */
export function followSuggestion(project: Pick<Project, 'reframe'>, aspects: readonly AspectRatio[], vw: number, vh: number): 'vertical' | 'square' | null {
  if (project.reframe?.mode === 'follow') return null
  if (aspects.includes('9:16') && canFollow('9:16', vw, vh)) return 'vertical'
  if (aspects.includes('1:1') && canFollow('1:1', vw, vh)) return 'square'
  return null
}
