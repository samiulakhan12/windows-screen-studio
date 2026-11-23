/**
 * Editing covers (docs/design/auto-blur.md §2.1-2.4, §5.9, §14): adding one at the playhead, turning
 * blur and pixelate shapes into covers, the box at the playhead and along the whole path, the times,
 * the colour, Keep covered and Uncover, nudging, copy and paste within one project, duplicating, and
 * a followed path. Pure: every function returns a new project (the same project when nothing
 * changes) and is one `store.update`.
 *
 * There is no settle step for covers (§14.1): every function here drops `found`, `missed` and
 * `thin` from the covers it changes, so an edited suggestion is the user's inside the edit itself,
 * and undo, redo or a version never settle anything.
 */
import type { FollowResult } from '../api/privacy'
import { MAX_COVERS, mergeCovers, widenShort } from '../privacy/coverData'
import { keysWithin, MAX_KEYS_PER_COVER, parsePath, pathKeys, unionBox, writePath, type CoverKey } from '../privacy/coverPath'
import { COVER_DARK } from '../privacy/kinds'
import type { Cover, NormRect, Project, RejectedPlace, Shape } from '../types'

export type CoverLength = 'three' | 'toEnd' | 'whole'

/** A new cover's length for *For 3 seconds* (§2.1). */
export const COVER_SECONDS = 3
/** A new cover's box: 30% × 10% of the frame (§2.1). */
export const NEW_COVER_SIZE = { w: 0.3, h: 0.1 }
/** Shortest cover an edit leaves (one frame at 60 fps is 16.7 ms; readCovers widens shorter ones to this). */
export const MIN_COVER_LENGTH = 0.02
/** Smallest side of a cover's box, normalised (as readCovers keeps it). */
export const MIN_COVER_SIDE = 0.002
/** Most keys a removed suggestion's path keeps in privacy.rejected (readPrivacy's limit). */
const MAX_REJECTED_KEYS = 400
/** Most removed places privacy.rejected keeps (readPrivacy's limit): the oldest go first. */
const MAX_REJECTED = 5000

const HEX = /^#[0-9a-f]{6}$/i
const finite = (v: number): boolean => Number.isFinite(v)
const clamp = (v: number, lo: number, hi: number): number => Math.min(hi, Math.max(lo, v))
const floorMs = (v: number): number => Math.floor(v * 1000 + 1e-6) / 1000
const ceilMs = (v: number): number => Math.ceil(v * 1000 - 1e-6) / 1000

/** A fresh cover id: 'cv' and ten base-36 characters (readCovers takes 1-64 of [A-Za-z0-9_-]). */
export function newCoverId(random: () => number): string {
  let s = ''
  for (let i = 0; i < 10; i++) s += Math.floor(clamp(random(), 0, 0.999999) * 36).toString(36)
  return `cv${s}`
}

/** A box held inside the frame: x and y in 0..1 − side, w and h at least MIN_COVER_SIDE and up to the frame's edge. */
export function boxInFrame(b: NormRect): NormRect {
  const w = clamp(finite(b.w) ? Math.abs(b.w) : NEW_COVER_SIZE.w, MIN_COVER_SIDE, 1)
  const h = clamp(finite(b.h) ? Math.abs(b.h) : NEW_COVER_SIZE.h, MIN_COVER_SIDE, 1)
  const x0 = finite(b.x) ? (b.w < 0 ? b.x + b.w : b.x) : 0
  const y0 = finite(b.y) ? (b.h < 0 ? b.y + b.h : b.y) : 0
  return { x: clamp(x0, 0, 1 - w), y: clamp(y0, 0, 1 - h), w, h }
}

/**
 * A new cover's box (§2.1): 30% × 10% of the frame, centred where the cursor is (normalised to the
 * whole recorded frame), or on the frame's centre when the cursor is hidden or invalid (null);
 * moved inside the frame.
 */
export function coverBoxAt(cursor: { x: number; y: number } | null): NormRect {
  const c = cursor && finite(cursor.x) && finite(cursor.y) ? cursor : { x: 0.5, y: 0.5 }
  return boxInFrame({ x: c.x - NEW_COVER_SIZE.w / 2, y: c.y - NEW_COVER_SIZE.h / 2, w: NEW_COVER_SIZE.w, h: NEW_COVER_SIZE.h })
}

/** A cover the user owns from now on: without `found`, `missed` and `thin` (the same object when it has none). */
export function settled(c: Cover): Cover {
  if (c.found === undefined && c.missed === undefined && c.thin === undefined) return c
  const { found: _f, missed: _m, thin: _t, ...rest } = c
  void _f
  void _m
  void _t
  return rest
}

/** The project with `covers` (no key at all once the last cover is gone, as a project from before has none). */
function withCovers(p: Project, covers: Cover[]): Project {
  if (covers.length) return { ...p, covers: covers.length > MAX_COVERS ? mergeCovers(covers, MAX_COVERS) : covers }
  if (p.covers === undefined) return p
  const { covers: _c, ...rest } = p
  void _c
  return rest
}

/** The project with cover `id` replaced by `fn(cover)`; the same project when it is missing or unchanged. */
function mapCover(p: Project, id: string, fn: (c: Cover) => Cover): Project {
  const list = p.covers ?? []
  const i = list.findIndex((c) => c.id === id)
  if (i < 0) return p
  const next = fn(list[i])
  if (next === list[i]) return p
  const out = list.slice()
  out[i] = next
  return { ...p, covers: out }
}

/** The project with every cover of `ids` replaced by `fn(cover)`, in one pass. */
function mapCovers(p: Project, ids: readonly string[], fn: (c: Cover) => Cover): Project {
  const want = new Set(ids)
  const list = p.covers ?? []
  let out: Cover[] | null = null
  for (let i = 0; i < list.length; i++) {
    if (!want.has(list[i].id)) continue
    const next = fn(list[i])
    if (next === list[i]) continue
    out ??= list.slice()
    out[i] = next
  }
  return out ? { ...p, covers: out } : p
}

/** A cover's keys as a mutable list (an unreadable path: one key of the frame's centre box, never nothing). */
function keysOf(c: Cover): CoverKey[] {
  const keys = pathKeys(c)
  return keys.length ? keys.map((k) => ({ ...k })) : [{ t: c.start, ...coverBoxAt(null) }]
}

/** Index of the key in effect at `t`: the last with key.t <= t, or 0 before the first. */
function keyIndexAt(keys: readonly CoverKey[], t: number): number {
  let i = 0
  for (let k = 0; k < keys.length && keys[k].t <= t; k++) i = k
  return i
}

const boxOfKey = (k: CoverKey): NormRect => ({ x: k.x, y: k.y, w: k.w, h: k.h })

/** The box of `keys` at `t` (holding from one key to the next; before the first, the first). */
function boxOfAt(keys: readonly CoverKey[], t: number): NormRect {
  return boxOfKey(keys[keyIndexAt(keys, t)])
}

/** `keys` (sorted) as a path starting at `start`: the key in effect at `start` moved there, earlier ones dropped. */
function keysFrom(keys: readonly CoverKey[], start: number, end: number): CoverKey[] {
  const i = keyIndexAt(keys, start)
  const out: CoverKey[] = [{ ...keys[i], t: start }]
  for (let k = i + 1; k < keys.length && keys[k].t < end; k++) if (keys[k].t > start) out.push({ ...keys[k] })
  return out
}

/** A cover made of `keys` over [start, end): times to the millisecond (start down, end up), the path written, at least MIN_COVER_LENGTH. */
function withPath(c: Cover, keys: readonly CoverKey[], start: number, end: number, duration: number): Cover {
  const s = Math.max(0, floorMs(start))
  const e = Math.min(duration > 0 ? duration : end, ceilMs(end))
  const kept = keysFrom([...keys].sort((a, b) => a.t - b.t), s, e)
  const path = writePath(kept.length > MAX_KEYS_PER_COVER ? keysWithin(kept, MAX_KEYS_PER_COVER) : kept)
  return widenShort({ ...c, start: s, end: Math.max(e, s), path }, duration)
}

/** Times of a new cover of `length` at source time `t` (§2.1): 3 s from the playhead (earlier near the end, so it keeps 3 s), to the end, or the whole video. */
export function coverTimes(t: number, length: CoverLength, duration: number): { start: number; end: number } {
  const d = Math.max(0, duration)
  if (length === 'whole') return { start: 0, end: d }
  const at = clamp(finite(t) ? t : 0, 0, d)
  if (length === 'toEnd') return { start: at, end: d }
  const len = Math.min(COVER_SECONDS, d)
  const start = clamp(at, 0, Math.max(0, d - len))
  return { start, end: Math.min(d, start + len) }
}

/** A new cover of the user's: one key at its start. */
function newCover(id: string, start: number, end: number, box: NormRect, color: string, duration: number): Cover {
  const b = boxInFrame(box)
  const c: Cover = { id, start, end, path: '', color: HEX.test(color) ? color.toLowerCase() : COVER_DARK }
  return withPath(c, [{ t: start, ...b }], start, end, duration)
}

/**
 * *Add cover* and the *Cover* tool (§2.1): a cover at `at.t` (source seconds, the frame the preview
 * shows) of `at.length` over `at.box` (normalised to the whole recorded frame, moved inside it) in
 * `at.color`. The caller selects it. One update.
 */
export function addCover(project: Project, at: { t: number; box: NormRect; length: CoverLength; color: string }, random: () => number = Math.random): { project: Project; id: string } {
  const { start, end } = coverTimes(at.t, at.length, project.duration)
  const id = newCoverId(random)
  const cover = newCover(id, start, end, at.box, at.color, project.duration)
  return { project: withCovers(project, [...(project.covers ?? []), cover]), id }
}

/**
 * A cover of the user's over `at.box` from `at.start` to `at.end` (the guide's *Blur an area…* and
 * *Blur the typed text*, §2.11: the box and times their blur shape had), held inside the recording. One update.
 */
export function addCoverSpan(project: Project, at: { start: number; end: number; box: NormRect; color: string }, random: () => number = Math.random): { project: Project; id: string } {
  const start = clamp(finite(at.start) ? at.start : 0, 0, project.duration)
  const end = clamp(finite(at.end) ? at.end : project.duration, start, project.duration)
  const id = newCoverId(random)
  const cover = newCover(id, start, end, at.box, at.color, project.duration)
  return { project: withCovers(project, [...(project.covers ?? []), cover]), id }
}

const isWeak = (s: Shape): boolean => s.kind === 'blur' || s.kind === 'pixelate'

/** A shape's box normalised (a negative width or height turned around). */
const shapeBox = (s: Shape): NormRect => ({ x: Math.min(s.x, s.x + s.w), y: Math.min(s.y, s.y + s.h), w: Math.abs(s.w), h: Math.abs(s.h) })

/**
 * *Turn into covers* and *Turn them all into covers* (§2.1, §2.4): each blur or pixelate shape of
 * `shapeIds` replaced by a cover over its box and times, in `colours[shapeId]` (Dark without one).
 * Other shapes are left. One update.
 */
export function coversFromShapes(project: Project, shapeIds: readonly string[], colours: Readonly<Record<string, string>>, random: () => number = Math.random): { project: Project; ids: string[] } {
  const want = new Set(shapeIds)
  const shapes = project.shapes ?? []
  const made: Cover[] = []
  const ids: string[] = []
  const kept: Shape[] = []
  const taken = new Set((project.covers ?? []).map((c) => c.id))
  for (const s of shapes) {
    if (!want.has(s.id) || !isWeak(s) || !(s.end > s.start)) {
      kept.push(s)
      continue
    }
    let id = newCoverId(random)
    while (taken.has(id)) id = newCoverId(random)
    taken.add(id)
    made.push(newCover(id, Math.max(0, s.start), Math.min(project.duration, s.end), shapeBox(s), colours[s.id] ?? COVER_DARK, project.duration))
    ids.push(id)
  }
  if (!made.length) return { project, ids }
  const withShapes: Project = { ...project, shapes: kept }
  return { project: withCovers(withShapes, [...(project.covers ?? []), ...made]), ids }
}

/** *Turn into a cover* (§2.4): the blur or pixelate shape `shapeId` replaced by a cover over its box and times; null for any other shape. */
export function coverFromShape(project: Project, shapeId: string, color: string, random: () => number = Math.random): { project: Project; id: string } | null {
  const r = coversFromShapes(project, [shapeId], { [shapeId]: color }, random)
  return r.ids.length ? { project: r.project, id: r.ids[0] } : null
}

/** How a box changes (§2.2): a move (normalised), and edges moved (normalised; positive is right or down). */
export interface BoxEdit {
  move?: { dx: number; dy: number }
  edges?: { left?: number; top?: number; right?: number; bottom?: number }
}

/** A key's box with its edges moved by `e`, held inside the frame and at least MIN_COVER_SIDE. */
function movedEdges(k: CoverKey, e: NonNullable<BoxEdit['edges']>): CoverKey {
  let x0 = k.x + (e.left ?? 0)
  let y0 = k.y + (e.top ?? 0)
  let x1 = k.x + k.w + (e.right ?? 0)
  let y1 = k.y + k.h + (e.bottom ?? 0)
  x0 = clamp(x0, 0, 1 - MIN_COVER_SIDE)
  y0 = clamp(y0, 0, 1 - MIN_COVER_SIDE)
  x1 = clamp(x1, 0, 1)
  y1 = clamp(y1, 0, 1)
  if (x1 - x0 < MIN_COVER_SIDE) {
    if (e.left !== undefined && e.right === undefined) x0 = x1 - MIN_COVER_SIDE
    else x1 = x0 + MIN_COVER_SIDE
  }
  if (y1 - y0 < MIN_COVER_SIDE) {
    if (e.top !== undefined && e.bottom === undefined) y0 = y1 - MIN_COVER_SIDE
    else y1 = y0 + MIN_COVER_SIDE
  }
  return { t: k.t, x: x0, y: y0, w: x1 - x0, h: y1 - y0 }
}

/** A key's box moved by (dx, dy), held inside the frame. */
const movedKey = (k: CoverKey, dx: number, dy: number): CoverKey => ({ t: k.t, x: clamp(k.x + dx, 0, 1 - k.w), y: clamp(k.y + dy, 0, 1 - k.h), w: k.w, h: k.h })

/**
 * The box of cover `id` changed at source time `t` (§2.2). Edges move at every key, whatever
 * `wholePath` says, so widening a followed cover holds wherever the playhead is. A move applies at
 * every key with `wholePath`, else to the span the playhead is in (the key in effect at `t`, until
 * the next key). Drops `found`, `missed` and `thin`.
 */
export function editCoverBox(project: Project, id: string, t: number, edit: BoxEdit, wholePath: boolean): Project {
  const hasEdges = !!edit.edges && Object.values(edit.edges).some((v) => typeof v === 'number' && v !== 0 && finite(v))
  const hasMove = !!edit.move && (edit.move.dx !== 0 || edit.move.dy !== 0) && finite(edit.move.dx) && finite(edit.move.dy)
  if (!hasEdges && !hasMove) return project
  return mapCover(project, id, (c) => {
    let keys = keysOf(c)
    if (hasEdges) keys = keys.map((k) => movedEdges(k, edit.edges!))
    if (hasMove) {
      const { dx, dy } = edit.move!
      if (wholePath) keys = keys.map((k) => movedKey(k, dx, dy))
      else {
        const i = keyIndexAt(keys, t)
        keys[i] = movedKey(keys[i], dx, dy)
      }
    }
    const path = writePath(keys)
    return path === c.path ? settled(c) : settled({ ...c, path })
  })
}

/** The box of cover `id` at source time `t` (its first or last box outside its times); null when it is missing. */
export function coverBoxAtTime(project: Project, id: string, t: number): NormRect | null {
  const c = (project.covers ?? []).find((x) => x.id === id)
  if (!c) return null
  const keys = pathKeys(c)
  return keys.length ? boxOfAt(keys, clamp(t, c.start, c.end)) : null
}

/**
 * Cover `id` from `start` to `end` (§2.2, §2.3), holding its first and last boxes: a start moved
 * earlier takes the first box there, one moved later the box in effect there; an end moved later
 * holds the last box. Kept inside the recording and at least MIN_COVER_LENGTH long. Drops `found`.
 */
export function setCoverEnds(project: Project, id: string, start: number, end: number): Project {
  if (!finite(start) || !finite(end)) return project
  const d = project.duration
  return mapCover(project, id, (c) => {
    let s = clamp(start, 0, d)
    let e = clamp(end, 0, d)
    if (e - s < MIN_COVER_LENGTH) {
      if (start !== c.start) s = Math.max(0, e - MIN_COVER_LENGTH)
      else e = Math.min(d, s + MIN_COVER_LENGTH)
    }
    const next = withPath(c, keysOf(c), s, e, d)
    if (next.start === c.start && next.end === c.end && next.path === c.path) return settled(c)
    return settled(next)
  })
}

/** *Start here* (§2.2): cover `id` starts at `t`; null when `t` is outside it (the button is disabled with privacy.cover.outside). */
export function coverStartHere(project: Project, id: string, t: number): Project | null {
  const c = (project.covers ?? []).find((x) => x.id === id)
  if (!c || !(t >= c.start && t < c.end) || c.end - t < MIN_COVER_LENGTH) return null
  return setCoverEnds(project, id, t, c.end)
}

/** *End here* (§2.2): cover `id` ends at `t`; null when `t` is outside it. */
export function coverEndHere(project: Project, id: string, t: number): Project | null {
  const c = (project.covers ?? []).find((x) => x.id === id)
  if (!c || !(t >= c.start && t < c.end) || t - c.start < MIN_COVER_LENGTH) return null
  return setCoverEnds(project, id, c.start, t)
}

/**
 * Cover `id` moved `dt` seconds in time, its length kept and held inside the recording; null for
 * a cover whose path has more than one key (it follows moving text: privacy.cover.timeKept, §2.3).
 */
export function moveCoverTime(project: Project, id: string, dt: number): Project | null {
  const c = (project.covers ?? []).find((x) => x.id === id)
  if (!c) return null
  const keys = pathKeys(c)
  if (keys.length > 1) return null
  if (!finite(dt) || dt === 0) return project
  const len = c.end - c.start
  const start = clamp(c.start + dt, 0, Math.max(0, project.duration - len))
  if (start === c.start) return project
  const box = keys.length ? boxOfKey(keys[0]) : coverBoxAt(null)
  return mapCover(project, id, (x) => settled(withPath(x, [{ t: start, ...box }], start, start + len, project.duration)))
}

/** *Keep it for the whole video* (§2.2): cover `id` from 0 to the recording's end, its first and last boxes held to the ends. */
export function coverWholeVideo(project: Project, id: string): Project {
  return setCoverEnds(project, id, 0, project.duration)
}

/** A colour chip or *Match the background* on covers `ids` (§2.2). */
export function setCoverColour(project: Project, ids: readonly string[], color: string): Project {
  if (!HEX.test(color)) return project
  const lower = color.toLowerCase()
  return mapCovers(project, ids, (c) => settled(c.color === lower ? c : { ...c, color: lower }))
}

/** *Keep covered* (§2.2): covers `ids` become the user's (no `found`, `missed` or `thin`). */
export function keepCovers(project: Project, ids: readonly string[]): Project {
  return mapCovers(project, ids, settled)
}

/** A removed suggestion's place (§5.10): its kind, times and own path (at most 400 keys). Null for a cover of the user's. */
export function rejectedPlaceOf(c: Cover): RejectedPlace | null {
  if (!c.found || !c.kind) return null
  const keys = parsePath(c.path)
  if (!keys?.length) return null
  return { kind: c.kind, start: c.start, end: c.end, path: keys.length > MAX_REJECTED_KEYS ? writePath(keysWithin(keys, MAX_REJECTED_KEYS)) : c.path }
}

/**
 * *Uncover* (§2.2, §5.10): covers `ids` removed, each suggestion's place written to
 * `privacy.rejected` in the same update, so Find again does not suggest its kind there. A cover of
 * the user's leaves nothing behind.
 */
export function deleteCovers(project: Project, ids: readonly string[]): Project {
  const want = new Set(ids)
  const list = project.covers ?? []
  if (!list.some((c) => want.has(c.id))) return project
  const places: RejectedPlace[] = []
  const rest: Cover[] = []
  for (const c of list) {
    if (!want.has(c.id)) {
      rest.push(c)
      continue
    }
    const place = rejectedPlaceOf(c)
    if (place) places.push(place)
  }
  let q = withCovers(project, rest)
  if (places.length) {
    const rejected = [...(project.privacy?.rejected ?? []), ...places]
    q = { ...q, privacy: { ...(project.privacy ?? {}), rejected: rejected.length > MAX_REJECTED ? rejected.slice(rejected.length - MAX_REJECTED) : rejected } }
  }
  return q
}

/**
 * Covers `ids` moved by (dx, dy) pixels of the recording (the arrow keys on the preview: 1, Shift
 * 10), as normalised units of the whole frame, at every key of their paths; each box held inside the frame.
 */
export function nudgeCovers(project: Project, ids: readonly string[], dx: number, dy: number): Project {
  if (!finite(dx) || !finite(dy) || (dx === 0 && dy === 0)) return project
  const nx = dx / Math.max(1, project.width || 1)
  const ny = dy / Math.max(1, project.height || 1)
  return mapCovers(project, ids, (c) => {
    const path = writePath(keysOf(c).map((k) => movedKey(k, nx, ny)))
    return settled(path === c.path ? c : { ...c, path })
  })
}

/** Copied covers (§14.4, finding 18): a snapshot of each at copy time, for their own project only. */
export interface CoverClip {
  projectId: string
  /** The playhead when copied: a paste keeps each cover's distance to it. */
  at: number
  covers: Cover[]
}

/** Covers `ids` copied as they are now (deep copies: a later edit of the source never changes the clip). */
export function copyCovers(project: Project, ids: readonly string[], at: number): CoverClip {
  const want = new Set(ids)
  return { projectId: project.id, at, covers: (project.covers ?? []).filter((c) => want.has(c.id)).map((c) => structuredClone(c)) }
}

/** A cover of the user's: a copy's own (a new id, no group, kept as the user's). */
function ownCopy(c: Cover, id: string): Cover {
  const { group: _g, ...rest } = settled(c)
  void _g
  return { ...rest, id }
}

/**
 * The clip's covers pasted with their distance to the copy's playhead kept, at `at`, moved so they
 * fit in the recording: fresh ids, the user's. Null for another project (covers paste only into the
 * video they were copied from: privacy.cover.oneProject).
 */
export function pasteCovers(project: Project, clip: CoverClip, at: number, random: () => number = Math.random): { project: Project; ids: string[] } | null {
  if (clip.projectId !== project.id) return null
  if (!clip.covers.length) return { project, ids: [] }
  const first = Math.min(...clip.covers.map((c) => c.start))
  const last = Math.max(...clip.covers.map((c) => c.end))
  const offset = clamp(at - clip.at, -first, Math.max(-first, project.duration - last))
  const taken = new Set((project.covers ?? []).map((c) => c.id))
  const ids: string[] = []
  const made = clip.covers.map((c) => {
    let id = newCoverId(random)
    while (taken.has(id)) id = newCoverId(random)
    taken.add(id)
    ids.push(id)
    const keys = keysOf(c).map((k) => ({ ...k, t: k.t + offset }))
    return withPath(ownCopy(c, id), keys, c.start + offset, c.end + offset, project.duration)
  })
  return { project: withCovers(project, [...(project.covers ?? []), ...made]), ids }
}

/** A copy of cover `id` with a new id and the same path and times, the user's. */
export function duplicateCover(project: Project, id: string, random: () => number = Math.random): { project: Project; id: string } {
  const c = (project.covers ?? []).find((x) => x.id === id)
  if (!c) return { project, id }
  const taken = new Set((project.covers ?? []).map((x) => x.id))
  let next = newCoverId(random)
  while (taken.has(next)) next = newCoverId(random)
  return { project: withCovers(project, [...(project.covers ?? []), ownCopy(structuredClone(c), next)]), id: next }
}

/** Spans "a b;c d" read as pairs (the followed result's lost spans). */
function spansOf(text: string): { start: number; end: number }[] {
  if (!text) return []
  const out: { start: number; end: number }[] = []
  for (const pair of text.split(';')) {
    const [a, b] = pair.split(' ').map(Number)
    if (finite(a) && finite(b) && b > a) out.push({ start: a, end: b })
  }
  return out
}

/**
 * *Follow what is under it* landed (§5.9): inside the time the walks reached (`walked`), the
 * followed path replaces the old box wherever the walk placed it; where it was lost
 * (`lostSpans`) the old box stays, joined with the followed one; before and after `walked` the old
 * path stays. So the cover never covers less than before where the walk was lost or outside it.
 * The times are the union of both. `thin` when the result is. Drops `found` and `missed`.
 */
export function withFollowedPath(project: Project, id: string, result: Extract<FollowResult, { ok: true }>): Project {
  const followed = parsePath(result.path)
  if (!followed?.length) return project
  return mapCover(project, id, (c) => {
    const old = keysOf(c)
    const lost = spansOf(result.lostSpans)
    const w0 = result.walked.start
    const w1 = result.walked.end
    const start = Math.min(c.start, result.start)
    const end = Math.max(c.end, result.end)
    const inLost = (t: number): boolean => lost.some((s) => t >= s.start && t < s.end)
    const times = new Set<number>([start, w0, w1])
    for (const k of old) times.add(k.t)
    for (const k of followed) times.add(k.t)
    for (const s of lost) {
      times.add(s.start)
      times.add(s.end)
    }
    const keys: CoverKey[] = []
    for (const t of [...times].filter((x) => x >= start && x < end).sort((a, b) => a - b)) {
      const inside = t >= w0 && t < w1
      const box = !inside ? boxOfAt(old, t) : inLost(t) ? unionBox(boxOfAt(old, t), boxOfAt(followed, t)) : boxOfAt(followed, t)
      const last = keys[keys.length - 1]
      if (last && last.x === box.x && last.y === box.y && last.w === box.w && last.h === box.h) continue
      keys.push({ t, ...box })
    }
    const { found: _f, missed: _m, thin: _t, ...rest } = c
    void _f
    void _m
    void _t
    const next = withPath(rest, keys, start, end, project.duration)
    return result.thin ? { ...next, thin: true } : next
  })
}

/** Whether cover `id` is active at source time `t` (*Start here* and *End here* need the playhead inside it). */
export function coverActiveAt(project: Project, id: string, t: number): boolean {
  const c = (project.covers ?? []).find((x) => x.id === id)
  return !!c && t >= c.start && t < c.end
}
