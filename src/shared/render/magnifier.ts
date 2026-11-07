/**
 * The magnifier (docs/design/editing-polish.md §6): a spotlight with `magnify`, a round loupe that
 * shows a detail larger from the recording's own pixels. Pure: preview and export ask the same
 * functions of the same time, so they draw the same lens.
 */
import { EASE } from '../captions/motion'
import { createSpotlight, playheadTimes } from '../editor/shapes'
import { cropOf, geometryFromCrop, visibleSize } from '../engine/crop'
import type { Rect } from '../engine/layout'
import { clamp } from '../engine/math'
import type { Camera } from '../engine/zoom'
import type { Clip, Project, Spotlight } from '../types'
import { speedAt, viewingTime } from './overlays'

export const MAGNIFIER: {
  enter: 0.3
  exit: 0.22
  size: 0.3
  min: 1.5
  max: 4
  step: 0.25
  defaultMin: 1.5
  defaultMax: 2.5
  targetPpr: 2
  softAbove: 2.5
  ring: 0.004
  shadowY: 0.006
  shadowBlur: 0.02
  shadowAlpha: 0.35
  corner: 0.18
} = {
  enter: 0.3,
  exit: 0.22,
  size: 0.3,
  min: 1.5,
  max: 4,
  step: 0.25,
  defaultMin: 1.5,
  defaultMax: 2.5,
  targetPpr: 2,
  softAbove: 2.5,
  ring: 0.004,
  shadowY: 0.006,
  shadowBlur: 0.02,
  shadowAlpha: 0.35,
  corner: 0.18
}

/** The shortest fade of Calm motion (§6.2, as Captions Studio's calm durations). */
const CALM_FADE = 0.2

/** Viewing seconds of source time `t` (Captions Studio's viewAt): cuts and clip speeds neither jump nor stretch a motion. */
const viewAt = (clips: Clip[], t: number): number => (clips.length ? viewingTime(clips, t) : t)

/** Whether a spotlight is a magnifier. */
export function isMagnifier(s: Spotlight): boolean {
  return typeof s.magnify === 'number'
}

/**
 * The lens's size factor `r`, zoom `z` and opacity at source time `t`, or null outside the item
 * (§6.2). Everything runs in viewing time, so a cut or a speed change neither jumps nor stretches
 * it: it grows in over 0.30 s and shrinks away over 0.22 s (each at most half the item) and is
 * fully shown in between. With Calm motion the size and the zoom hold and only the opacity fades,
 * linearly over at least 0.2 s. A cursor magnifier's fade while the cursor is off the recording is
 * the drawing code's (cursorSpotlightPresence), as for a cursor spotlight.
 */
export function magnifierPhase(s: Spotlight, t: number, clips: Clip[], calm: boolean): { r: number; z: number; alpha: number } | null {
  if (!isMagnifier(s) || !(t >= s.start && t < s.end)) return null
  const magnify = clamp(s.magnify as number, MAGNIFIER.min, MAGNIFIER.max)
  const from = viewAt(clips, s.start)
  const to = viewAt(clips, s.end)
  const now = viewAt(clips, t)
  const half = Math.max(0, (to - from) / 2)
  const sinceIn = now - from
  const untilOut = to - now
  if (calm) {
    const dIn = Math.min(Math.max(CALM_FADE, MAGNIFIER.enter), half)
    const dOut = Math.min(Math.max(CALM_FADE, MAGNIFIER.exit), half)
    const a = Math.min(dIn > 0 ? clamp(sinceIn / dIn, 0, 1) : 1, dOut > 0 ? clamp(untilOut / dOut, 0, 1) : 1)
    return { r: 1, z: magnify, alpha: a }
  }
  const dIn = Math.min(MAGNIFIER.enter, half)
  const dOut = Math.min(MAGNIFIER.exit, half)
  let g = 1
  if (dIn > 0 && sinceIn < dIn) g = Math.min(g, EASE.emphDecel(sinceIn / dIn))
  if (dOut > 0 && untilOut < dOut) g = Math.min(g, 1 - EASE.emphAccel(1 - untilOut / dOut))
  g = clamp(g, 0, 1)
  return { r: 0.6 + 0.4 * g, z: 1 + (magnify - 1) * g, alpha: Math.min(1, 2.5 * g) }
}

/**
 * The camera that shows `z` times more around `centre` (normalised to the recording), which stays
 * where it is on screen (§6.3): toOutput(rect, lensCamera(cam, P, z))(P) equals
 * toOutput(rect, cam)(P), and every other point lands z times further from it.
 */
export function lensCamera(cam: Camera, centre: { x: number; y: number }, z: number): Camera {
  const scale = cam.scale * z
  const axis = (p: number, c: number): number => p + 0.5 / scale - (p - c + 0.5 / cam.scale) / z
  return { ...cam, scale, cx: axis(centre.x, cam.cx), cy: axis(centre.y, cam.cy) }
}

/**
 * The lens on screen at size factor `r`: its centre (where `toOut` puts `centre`) and its half
 * sizes in output px, the magnifier's box (w, h) as the camera shows it.
 */
export function lensBox(
  s: Spotlight,
  centre: { x: number; y: number },
  rect: Rect,
  cam: Camera,
  r: number,
  toOut: (x: number, y: number) => { x: number; y: number }
): { cx: number; cy: number; rx: number; ry: number } {
  const c = toOut(centre.x, centre.y)
  return { cx: c.x, cy: c.y, rx: (r * s.w * rect.w * cam.scale) / 2, ry: (r * s.h * rect.h * cam.scale) / 2 }
}

/** Where the lens is centred (normalised): on the visible cursor in cursor mode when it is known, else on its box's centre. */
export function lensCentre(s: Spotlight, cursor: { x: number; y: number } | null): { x: number; y: number } {
  return s.mode === 'cursor' && cursor ? cursor : { x: s.x + s.w / 2, y: s.y + s.h / 2 }
}

/**
 * A new magnifier's zoom from `ppr`, the output pixels per recorded pixel where it is added
 * (§6.1): the largest step of 0.25 in 1.5..2.5 that shows at most 2 output pixels per recorded
 * pixel, else 1.5. A recording shown 1:1 gets 2×.
 */
export function defaultZoom(ppr: number): number {
  if (!(Number.isFinite(ppr) && ppr > 0)) return 2
  const steps = Math.round((MAGNIFIER.defaultMax - MAGNIFIER.defaultMin) / MAGNIFIER.step)
  for (let i = steps; i >= 0; i--) {
    const z = MAGNIFIER.defaultMin + i * MAGNIFIER.step
    if (z * ppr <= MAGNIFIER.targetPpr + 1e-9) return z
  }
  return MAGNIFIER.defaultMin
}

/** Output pixels per recorded pixel of a recording `width` px wide, drawn `rect.w` px wide through `cam` (§6.1). */
export function pixelsPerRecorded(rect: Rect, cam: Camera, width: number): number {
  return width > 0 ? (rect.w * cam.scale) / width : 1
}

/** Whether a lens of zoom `z` where the recording shows `ppr` output pixels per recorded pixel may look soft (§2.2). */
export const looksSoft = (ppr: number, z: number): boolean => ppr * z > MAGNIFIER.softAbove + 1e-9

/** The visible part of the recording through `cam` (normalised, inside 0..1). */
function viewBounds(cam: Camera): { x0: number; y0: number; x1: number; y1: number } {
  const half = 0.5 / cam.scale
  return { x0: Math.max(0, cam.cx - half), y0: Math.max(0, cam.cy - half), x1: Math.min(1, cam.cx + half), y1: Math.min(1, cam.cy + half) }
}

/**
 * A magnifier added at source time `t` (§2.2, §6.1): round, with no darkness and no soft edge,
 * 0.30 S across in the view there (`view`: the frame's rect and camera at `t`, the frame's size,
 * the view's centre and the visible cursor, all in the drawn crop's coordinates), centred on the
 * cursor when it shows inside the view, else on the view's centre, at the zoom `defaultZoom` picks.
 * It lasts 3 s and is fully grown at `t`: it starts one grow-in earlier, inside the kept part, as a
 * spotlight starts one fade earlier, so the lens shows at the playhead the moment it is added.
 * Stored in the full frame, like every spotlight. One project out.
 */
export function newMagnifier(
  project: Project,
  t: number,
  view: {
    rect: Rect
    cam: Camera
    w: number
    h: number
    centre: { x: number; y: number }
    cursor: { x: number; y: number } | null
  },
  mode: 'region' | 'cursor'
): { project: Project; id: string } {
  const across = MAGNIFIER.size * Math.min(view.w, view.h)
  const sx = view.rect.w * view.cam.scale
  const sy = view.rect.h * view.cam.scale
  const w = sx > 0 ? across / sx : MAGNIFIER.size
  const h = sy > 0 ? across / sy : MAGNIFIER.size
  const b = viewBounds(view.cam)
  const c = view.cursor
  const onCursor = !!c && Number.isFinite(c.x) && Number.isFinite(c.y) && c.x >= b.x0 && c.x <= b.x1 && c.y >= b.y0 && c.y <= b.y1
  const at = onCursor && c ? c : view.centre
  const magnify = defaultZoom(pixelsPerRecorded(view.rect, view.cam, visibleSize(project).width))
  const lead = MAGNIFIER.enter * speedAt(project.clips, t)
  const inView = createSpotlight(mode, t, project.duration, {
    x: at.x - w / 2,
    y: at.y - h / 2,
    w,
    h,
    shape: 'ellipse',
    dim: 0,
    feather: 0,
    magnify,
    ...playheadTimes(t, lead, project)
  })
  const s = geometryFromCrop(cropOf(project), inView)
  return { project: { ...project, spotlights: [...(project.spotlights ?? []), s] }, id: s.id }
}

/** "2 times", "2.25 times": a zoom as the panel's value text and the timeline's name say it. */
export function timesText(z: number): string {
  return `${Number(z.toFixed(2))} times`
}

/** A spotlight's name on the timeline, its tooltip and accessible name: "Magnifier, 2 times", or today's spotlight name. */
export function spotlightName(s: Spotlight): string {
  if (isMagnifier(s)) return `Magnifier, ${timesText(clamp(s.magnify as number, MAGNIFIER.min, MAGNIFIER.max))}`
  return s.mode === 'cursor' ? 'Cursor spotlight' : 'Spotlight'
}

/** A spotlight's icon on the timeline: a magnifying glass for a magnifier. */
export function spotlightIcon(s: Spotlight): 'spotlight' | 'magnifier' {
  return isMagnifier(s) ? 'magnifier' : 'spotlight'
}
