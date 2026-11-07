import { displayTime } from '../../../shared/editor/clips'
import { revealKeptTime, shapeForPlayhead, spotlightForPlayhead } from '../../../shared/editor/shapes'
import { cropOf, cropProject, cropTrack, cropView, geometryFromCrop } from '../../../shared/engine/crop'
import { magnifierView } from '../../../shared/editor/magnifierEdit'
import { newMagnifier } from '../../../shared/render/magnifier'
import { SmoothedTrack } from '../../../shared/engine/cursor'
import { speedAt } from '../../../shared/render/overlays'
import { cursorOverVideoAt, visibleCursorAt } from '../../../shared/render/shapes'
import type { Clip, CursorSample, CursorTrack, Project, Shape, ShapeKind, Spotlight } from '../../../shared/types'
import type { EditorServices } from './context'
import type { PreviewPlayer } from './player'
import type { Selection } from './selection'

/*
 * Adding shapes and spotlights at the playhead, and moving the playhead to show one: the one
 * code path for the Shapes panel, the shapes track of the timeline and the editor's commands
 * (palette and shortcuts), so they all place and show items alike.
 */

const smoothed = new WeakMap<CursorSample[], { duration: number; smoothing: number; track: SmoothedTrack }>()

/**
 * The smoothed cursor path the cursor layer draws (the same track the editor's scene builds),
 * made on first use: only adding an arrow or switching a spotlight to a region reads it.
 */
function smoothedPath(samples: CursorSample[], duration: number, smoothing: number): SmoothedTrack {
  let hit = smoothed.get(samples)
  if (!hit || hit.duration !== duration || hit.smoothing !== smoothing) {
    hit = { duration, smoothing, track: new SmoothedTrack(samples, duration, smoothing) }
    smoothed.set(samples, hit)
  }
  return hit.track
}

/**
 * Where viewers see the cursor at source time `t` (the drawn cursor, or the real one baked into
 * the video: what a cursor spotlight follows and a new arrow points at), or null when they do
 * not see it there because it is off the recording.
 */
export function cursorPosFor(project: Project, cursor: CursorTrack, t: number): { x: number; y: number } | null {
  if (!cursor.valid) return null
  const path = { at: (s: number) => smoothedPath(cursor.samples, project.duration, project.cursor.smoothing).at(s) }
  return cursorOverVideoAt(project, cursor.samples, path, t) ? visibleCursorAt(project, cursor.samples, path, t) : null
}

/**
 * Moves the playhead as little as needed for `item` (a shape of `kind`, or a spotlight) to show
 * fully on the preview, on a kept frame (revealKeptTime), starting from `from`. False when the
 * edit keeps none of it, so no frame shows it.
 */
export function revealItem(player: PreviewPlayer, clips: Clip[], item: { start: number; end: number }, kind: ShapeKind | 'spotlight', from = player.time): boolean {
  const to = revealKeptTime(item, kind, clips, from)
  if (to === null) return false
  if (to !== player.time) player.seek(to)
  return true
}

interface AddOptions {
  /** Source time to add at (where the timeline was double-clicked); the playhead by default. */
  at?: number
  onSelect: (sel: Selection) => void
}

/**
 * Where an item added at source time `t` goes: on the frame the preview shows there (in a cut,
 * the next kept one), with that clip's speed.
 */
function anchor(clips: Clip[], t: number): { t: number; speed: number } {
  const at = displayTime(clips, t)
  return { t: at, speed: speedAt(clips, at) }
}

/**
 * Adds a shape of `kind` fully shown at the playhead (see shapeForPlayhead: it starts one fade
 * earlier and stays inside the kept part; an arrow points at the cursor when `cursor` says where
 * it is), selects it and moves the playhead as little as needed to show it. It is placed in the
 * part of the recording that is shown (built in the crop's view, stored in the full frame).
 */
export function addShapeAt({ store, player }: EditorServices, kind: ShapeKind, cursor: CursorTrack | null, opts: AddOptions): Shape {
  const p = store.state
  const { t, speed } = anchor(p.clips, opts.at ?? player.time)
  const crop = cropOf(p)
  const view = cropProject(p)
  const s = geometryFromCrop(crop, shapeForPlayhead(kind, t, view, cursor ? cursorPosFor(view, cropTrack(cursor, crop), t) : null, speed))
  store.update((q) => ({ ...q, shapes: [...(q.shapes ?? []), s] }))
  opts.onSelect({ kind: 'shape', id: s.id })
  revealItem(player, p.clips, s, kind, t)
  return s
}

/** Adds a spotlight fully faded in at the playhead (round on screen around the cursor), like addShapeAt. */
export function addSpotlightAt({ store, player }: EditorServices, mode: Spotlight['mode'], opts: AddOptions): Spotlight {
  const p = store.state
  const { t, speed } = anchor(p.clips, opts.at ?? player.time)
  const s = geometryFromCrop(cropOf(p), spotlightForPlayhead(mode, t, cropProject(p), speed))
  store.update((q) => ({ ...q, spotlights: [...(q.spotlights ?? []), s] }))
  opts.onSelect({ kind: 'spotlight', id: s.id })
  revealItem(player, p.clips, s, 'spotlight', t)
  return s
}

/**
 * Adds a magnifier (docs/design/editing-polish.md §2.2, §6.1) fully grown at the playhead: 0.30 S
 * across in the view the preview shows there, on the cursor when it shows in that view (else on
 * the view's centre), at the zoom picked from the recording's resolution; `mode` 'cursor' makes it
 * follow the cursor. Selected and shown like addSpotlightAt, in one undo step.
 */
export function addMagnifierAt({ store, player }: EditorServices, mode: Spotlight['mode'], cursor: CursorTrack | null, opts: AddOptions): Spotlight {
  const p = store.state
  const { t } = anchor(p.clips, opts.at ?? player.time)
  const view = magnifierView(p, cursor, t)
  const drawn = cursor ? cropView(p, cursor) : null
  const at = drawn ? cursorPosFor(drawn.project, drawn.cursor, t) : null
  const { project, id } = newMagnifier(p, t, { rect: view.rect, cam: view.cam, w: view.w, h: view.h, centre: view.centre, cursor: at }, mode)
  const s = project.spotlights!.find((x) => x.id === id)!
  store.update((q) => ({ ...q, spotlights: [...(q.spotlights ?? []), s] }))
  opts.onSelect({ kind: 'spotlight', id: s.id })
  revealItem(player, p.clips, s, 'spotlight', t)
  return s
}
