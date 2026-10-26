/**
 * The crop tool's maths and the crop edit (E-10, docs/design/crop-in-editor.md §4.7–4.9): drags
 * in recorded pixels with aspect locks, edge magnets and whole-pixel snapping, the taskbar and
 * browser-bar presets, and applying a crop as one undo step (rebasing the automatic zooms).
 *
 * Contracts commit: types and constants are final; the tool's functions return their input and
 * setCrop is not implemented until E-10 lands (TODO(E-10) below). Only E-10's UI calls them.
 */
import type { CursorTrack, NormRect, Project } from '../types'
import type { RegionHandle } from './zoomEdit'

export type CropAspect = 'free' | 'original' | '16:9' | '4:3' | '1:1' | '9:16'
/** The crop being edited (held by the Editor until Done). */
export interface CropDraft {
  rect: NormRect
  aspect: CropAspect
}
/** Items left outside a crop (they come back when it is widened). */
export interface OutsideCount {
  zooms: number
  shapes: number
  spotlights: number
}
/** What applying a crop did. */
export interface CropOutcome {
  project: Project
  removedAutoZooms: number
  restoredAutoZooms: number
  outside: OutsideCount
}

/** The aspect chips, in order. */
export const CROP_ASPECTS: readonly CropAspect[] = ['free', 'original', '16:9', '4:3', '1:1', '9:16']
/** Height of the Windows taskbar at 100% scaling (DIP). */
export const TASKBAR_DIP = 48
/** Height of a maximised browser's tabs and address bar at 100% scaling (DIP). */
export const BROWSER_BAR_DIP = 88
/** A crop shorter than this (recorded px) gets the "larger exports will be upscaled" hint. */
export const SMALL_CROP_PX = 720

const FIXED_RATIOS: Record<Exclude<CropAspect, 'free' | 'original'>, number> = { '16:9': 16 / 9, '4:3': 4 / 3, '1:1': 1, '9:16': 9 / 16 }

/** The pixel ratio (width / height) an aspect locks to; null for free. */
export function cropRatio(a: CropAspect, width: number, height: number): number | null {
  if (a === 'free') return null
  if (a === 'original') return width > 0 && height > 0 ? width / height : null
  return FIXED_RATIOS[a]
}

/** The draft after dragging `handle` by (dx, dy) (normalised), kept inside the frame and at least MIN_CROP_PX a side. */
export function dragCrop(r: NormRect, handle: RegionHandle, dx: number, dy: number, size: { width: number; height: number }, ratio: number | null): NormRect {
  // TODO(E-10): move, free and locked edges and corners (design §4.7).
  void handle
  void dx
  void dy
  void size
  void ratio
  return r
}

/** The largest rectangle of pixel ratio `ratio` inside `r`, around its centre. */
export function fitCropAspect(r: NormRect, ratio: number, size: { width: number; height: number }): NormRect {
  // TODO(E-10): design §4.7.
  void ratio
  void size
  return r
}

/** `r` with edges near the frame's edges snapped to them, then rounded to whole pixels (and to `ratio`). */
export function snapCrop(r: NormRect, size: { width: number; height: number }, magnet: { x: number; y: number }, ratio: number | null): NormRect {
  // TODO(E-10): design §4.7.
  void size
  void magnet
  void ratio
  return r
}

/** The draft with its bottom edge above the Windows taskbar, or null when the recording does not show it. */
export function taskbarCrop(r: NormRect, p: Pick<Project, 'capture' | 'width' | 'height'>, scale: number | undefined): NormRect | null {
  // TODO(E-10): design §4.8.
  void r
  void p
  void scale
  return null
}

/** The draft with its top edge below a maximised browser's tabs and address bar, or null when not offered. */
export function browserBarCrop(r: NormRect, p: Pick<Project, 'capture' | 'width' | 'height'>, scale: number | undefined): NormRect | null {
  // TODO(E-10): design §4.8.
  void r
  void p
  void scale
  return null
}

/** Zooms, shapes and region spotlights of `p` outside `crop`. */
export function outsideCrop(p: Project, crop: NormRect | null): OutsideCount {
  // TODO(E-10): design §4.9 step 5.
  void p
  void crop
  return { zooms: 0, shapes: 0, spotlights: 0 }
}

/** Applies a crop (null: the whole recording) as one edit, rebasing the automatic zooms when `track` is given. */
export function setCrop(p: Project, crop: NormRect | null, track: CursorTrack | null): CropOutcome {
  // TODO(E-10): design §4.9.
  void p
  void crop
  void track
  throw new Error('setCrop: not implemented yet (E-10)')
}

/** The notice after Done: "Cropped to 1920 × 1032." plus what happened to zooms and items. */
export function cropNotice(o: CropOutcome): string {
  // TODO(E-10): design §5, Notices.
  void o
  return ''
}
