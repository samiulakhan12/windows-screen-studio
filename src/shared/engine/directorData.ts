/**
 * The camera director's saved options (Project.director): the defaults of a project that was
 * never directed, sanitising of stored values (a hand-edited or damaged project.json still opens),
 * and who owns the webcam framing, the director or the user. Pure and small; the director itself
 * is shared/editor/cameraDirector.ts.
 */
import type { DirectorHideAfter, DirectorSettings, LayoutSegment, Project, WebcamSettings } from '../types'
import { clamp } from './math'

/** Silences (output seconds) after which the director can hide the camera; 0 = never. */
export const HIDE_AFTER_CHOICES: readonly DirectorHideAfter[] = [0, 5, 10, 20]
export const DEFAULT_HIDE_AFTER: DirectorHideAfter = 10

/** The options of a project that was never directed, before they are resolved against it (directorSettingsOf). */
export const DEFAULT_DIRECTOR: Readonly<DirectorSettings> = Object.freeze({
  intro: 'camera-only',
  corners: 'auto',
  hideAfter: DEFAULT_HIDE_AFTER,
  frameFace: true
})

/** Webcam framing values (zoom, crop) closer than this are the same framing. */
export const FRAMING_EPS = 1e-4

const INTROS: readonly DirectorSettings['intro'][] = ['camera-only', 'camera-large', 'off']

const finite = (v: unknown): v is number => typeof v === 'number' && Number.isFinite(v)

/**
 * Stored director options, sanitised: undefined when there are none (or they are not an object);
 * otherwise every field valid, an invalid one replaced by its default (a threshold the director
 * does not offer becomes DEFAULT_HIDE_AFTER), and `framed` kept only with finite values, clamped
 * as the webcam's framing is (zoom 1..3, crops 0..1).
 */
export function readDirectorSettings(raw: unknown): DirectorSettings | undefined {
  if (!raw || typeof raw !== 'object' || Array.isArray(raw)) return undefined
  const d = raw as Record<string, unknown>
  const out: DirectorSettings = {
    intro: INTROS.includes(d.intro as DirectorSettings['intro']) ? (d.intro as DirectorSettings['intro']) : DEFAULT_DIRECTOR.intro,
    corners: d.corners === 'auto' || d.corners === 'keep' ? d.corners : DEFAULT_DIRECTOR.corners,
    hideAfter: HIDE_AFTER_CHOICES.includes(d.hideAfter as DirectorHideAfter) ? (d.hideAfter as DirectorHideAfter) : DEFAULT_HIDE_AFTER,
    frameFace: typeof d.frameFace === 'boolean' ? d.frameFace : DEFAULT_DIRECTOR.frameFace
  }
  const f = d.framed as Record<string, unknown> | undefined
  if (f && typeof f === 'object' && !Array.isArray(f) && finite(f.zoom) && finite(f.cropX) && finite(f.cropY)) {
    out.framed = { zoom: clamp(f.zoom, 1, 3), cropX: clamp(f.cropX, 0, 1), cropY: clamp(f.cropY, 0, 1) }
  }
  return out
}

type Framing = Pick<WebcamSettings, 'zoom' | 'cropX' | 'cropY'>

const near = (v: number | undefined, to: number): boolean => v === undefined || (finite(v) && Math.abs(v - to) <= FRAMING_EPS)

/** Whether the webcam shows its whole picture, centred: no zoom and no crop (absent counts as untouched). */
export function framingUntouched(w: Framing): boolean {
  return near(w.zoom, 1) && near(w.cropX, 0.5) && near(w.cropY, 0.5)
}

/** Whether the webcam's framing is still exactly the one the director last applied (`director.framed`). */
export function framingIsDirectors(w: Framing, director: Pick<DirectorSettings, 'framed'> | undefined): boolean {
  const f = director?.framed
  if (!f) return false
  const same = (v: number | undefined, to: number, rest: number): boolean => Math.abs((finite(v) ? v : rest) - to) <= FRAMING_EPS
  return same(w.zoom, f.zoom, 1) && same(w.cropX, f.cropX, 0.5) && same(w.cropY, f.cropY, 0.5)
}

/** Whether the director may set the framing without being asked: it is untouched, or still the director's. */
export function directorMayFrame(w: Framing, director: Pick<DirectorSettings, 'framed'> | undefined): boolean {
  return framingUntouched(w) || framingIsDirectors(w, director)
}

/**
 * Whether `layouts` hold camera positions of the user's: corner-only segments (the default
 * layout with a corner) the director did not make, recorded from the live bubble while
 * recording or placed with "Move camera here".
 */
export function hasCameraPositions(layouts: readonly LayoutSegment[] | undefined): boolean {
  return (layouts ?? []).some((s) => s.layout === 'default' && !!s.corner && !s.auto)
}

/**
 * Whether the director's changes are in `project`: a segment it made, or a framing it set that
 * the webcam still shows. The Camera panel then offers "Direct again" and "Remove automatic changes".
 */
export function hasDirectorChanges(project: Pick<Project, 'director' | 'layouts' | 'webcam'>): boolean {
  if ((project.layouts ?? []).some((s) => s.auto)) return true
  return !framingUntouched(project.webcam) && framingIsDirectors(project.webcam, project.director)
}

/**
 * The options the director works with for `project`: the saved ones, or for a project never
 * directed the defaults, with the bubble kept where it is ('keep') when the user already placed
 * the camera (hasCameraPositions). Face framing is offered (on) only while the director may set
 * the framing (directorMayFrame): a framing the user set by hand is kept unless they turn it on.
 * `framed` stays as saved (the director's provenance of the current framing).
 */
export function directorSettingsOf(project: Pick<Project, 'director' | 'layouts' | 'webcam'>): DirectorSettings {
  const saved = project.director
  const base: DirectorSettings = saved ?? { ...DEFAULT_DIRECTOR, corners: hasCameraPositions(project.layouts) ? 'keep' : 'auto' }
  return { ...base, frameFace: base.frameFace && directorMayFrame(project.webcam, saved) }
}
