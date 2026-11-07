/**
 * Editing magnifiers (docs/design/editing-polish.md §2.2, §6.1): the view a new one is sized and
 * placed in, how many output pixels a recorded pixel takes where one starts (the panel's softness
 * note), and its settings changed in one update. Pure.
 */
import { cropOf, cropProject, cropTrack } from '../engine/crop'
import type { SmoothedTrack } from '../engine/cursor'
import { frameView } from '../engine/frameView'
import type { Rect } from '../engine/layout'
import { clamp } from '../engine/math'
import { focusPathFor, type Camera } from '../engine/zoom'
import { looksSoft, MAGNIFIER, pixelsPerRecorded } from '../render/magnifier'
import { punchedCamera } from '../render/joins'
import type { CursorTrack, Project, Spotlight } from '../types'
import { editorFrame } from './followEdit'

const NO_TRACK: CursorTrack = { samples: [], clicks: [], keys: [], shapes: [], scale: 1, valid: false }

const focusPaths = new WeakMap<CursorTrack['samples'], { duration: number; path: SmoothedTrack }>()

/** The path cursor zooms follow (the editor scene's focusPath), made once per track. */
function focusOf(track: CursorTrack, duration: number): SmoothedTrack {
  let hit = focusPaths.get(track.samples)
  if (!hit || hit.duration !== duration) {
    hit = { duration, path: focusPathFor(track.samples, duration) }
    focusPaths.set(track.samples, hit)
  }
  return hit.path
}

/**
 * What the project's own frame (editorFrame: its output at 1080 px) shows at source time `t`: the
 * recording's rect and the camera (a punch-in included), the frame's size, the view's centre (the
 * middle of the slot while following, else of the recording's rect, normalised to the drawn crop),
 * and the drawn recording's width. `cursor` is the recorded track, or null.
 */
export function magnifierView(project: Project, cursor: CursorTrack | null, t: number): { rect: Rect; cam: Camera; w: number; h: number; centre: { x: number; y: number }; vw: number } {
  const f = editorFrame(project)
  const drawn = cropProject(project)
  const track = cursor ? cropTrack(cursor, cropOf(project)) : NO_TRACK
  const v = frameView({ project: drawn, cursor: track, focusPath: focusOf(track, project.duration) }, f.outW, f.outH, f.vw, f.vh, t)
  const cam = punchedCamera(v.cam, v.project, t)
  const rect = v.layout.screen
  const shown = v.layout.follow?.slot ?? rect
  const ox = shown.x + shown.w / 2
  const oy = shown.y + shown.h / 2
  const sx = cam.scale * rect.w
  const sy = cam.scale * rect.h
  const centre = {
    x: clamp(cam.cx - 0.5 / cam.scale + (sx > 0 ? (ox - rect.x) / sx : 0.5), 0, 1),
    y: clamp(cam.cy - 0.5 / cam.scale + (sy > 0 ? (oy - rect.y) / sy : 0.5), 0, 1)
  }
  return { rect, cam, w: f.outW, h: f.outH, centre, vw: f.vw }
}

/** Output pixels per recorded pixel where magnifier `s` starts, in the project's own frame (§6.4). */
export function magnifierPpr(project: Project, s: Spotlight, cursor: CursorTrack | null = null): number {
  const v = magnifierView(project, cursor, s.start)
  return pixelsPerRecorded(v.rect, v.cam, v.vw)
}

/** Whether magnifier `s` shows more than 2.5 output pixels per recorded pixel where it starts: "it may look soft" (§2.2). */
export function magnifierLooksSoft(project: Project, s: Spotlight, cursor: CursorTrack | null = null): boolean {
  return looksSoft(magnifierPpr(project, s, cursor), clamp(s.magnify ?? MAGNIFIER.min, MAGNIFIER.min, MAGNIFIER.max))
}

/** Magnifier `id` with `patch`, in one project out (the project itself when it has no such spotlight). */
export function withMagnifier(project: Project, id: string, patch: Partial<Omit<Spotlight, 'id'>>): Project {
  const list = project.spotlights ?? []
  if (!list.some((s) => s.id === id)) return project
  return { ...project, spotlights: list.map((s) => (s.id === id ? { ...s, ...patch } : s)) }
}

/** A zoom set from the panel: a step of 0.25 in 1.5..4. */
export function magnifyStep(z: number): number {
  return clamp(Math.round(z / MAGNIFIER.step) * MAGNIFIER.step, MAGNIFIER.min, MAGNIFIER.max)
}

/** The panel's Darkness: 0..40 % (§2.2). */
export const MAGNIFIER_DARKNESS = { min: 0, max: 0.4, step: 0.05 } as const
