/**
 * Freeze frame edits (E-11, docs/design/freeze-frame.md §4.8): add at the playhead, change the
 * length or the sound, move, remove. Each returns the next project (the same object when nothing
 * changes), so each is one undo step through store.update.
 */
import { clamp } from '../engine/math'
import { anchorEdit, atEditEnd, DEFAULT_FREEZE_SOUND, FREEZE, FREEZE_EPS, MAX_FREEZES, newFreezeId, planOf } from '../engine/freeze'
import { clipIndexAt, outputToSource } from '../engine/timeline'
import type { Clip, Freeze, FreezeSound, Project } from '../types'

export { atEditEnd }

/** Why a freeze was not added: the playhead is in a cut, a freeze is there, the picture is already frozen there, the limit. */
export type FreezeRefusal = 'cut' | 'taken' | 'frozen' | 'full'

/** What the editor says when a freeze is refused (the notice, and why the button or the command is unavailable). */
export const FREEZE_REFUSAL_TEXT: Record<FreezeRefusal, string> = {
  cut: 'The playhead is in a cut: move it onto a clip to freeze a frame',
  taken: 'There is already a freeze frame here',
  frozen: 'The picture is already frozen here',
  full: `A project can have at most ${MAX_FREEZES} freeze frames`
}

/** Proxy frame rate when the project does not say (the player uses the same). */
const SOURCE_FPS = 60
/** Seconds of the edit before and after the frozen moment that a text added on a freeze shows. */
const TEXT_AROUND = 0.5

/** A length in tenths within FREEZE.min..max. */
const tenths = (v: number): number => clamp(Math.round(v * 10) / 10, FREEZE.min, FREEZE.max)

/**
 * The anchor of the frame under the playhead `t`: the start of its source frame, rounded up to whole
 * ms (project.json keeps anchors in whole ms) and never before its clip; the edit's end when `t` is
 * within 1 ms of it (atEditEnd: rounded to whole ms on the next load, it is still the end). Null
 * when `t` is in a cut (or trimmed off).
 */
function anchorAt(p: Pick<Project, 'clips' | 'capture'>, t: number): number | null {
  const { clips } = p
  if (atEditEnd(clips, t)) return clips[clips.length - 1].end
  const i = clipIndexAt(clips, t)
  if (i < 0) return null
  const c = clips[i]
  const fps = p.capture?.fps ?? SOURCE_FPS
  const k = Math.floor(t * fps + 1e-6)
  const at = Math.ceil(Math.max(c.start, k / fps) * 1000 - 1e-6) / 1000
  // A clip ending less than 1 ms after that: its last whole ms.
  return at < c.end ? at : Math.floor(c.end * 1000 - 1e-6) / 1000
}

/** The freeze (other than `except`) whose anchor is within FREEZE_EPS of `at`. */
const freezeNear = (freezes: readonly Freeze[], at: number, except?: string): Freeze | undefined =>
  freezes.find((f) => f.id !== except && Math.abs(f.at - at) < FREEZE_EPS)

/** Why no freeze can be added at the playhead `t` (with the freeze in the way), or null when one can. */
export function freezeRefusal(p: Project, t: number): { refused: FreezeRefusal; id?: string } | null {
  const at = anchorAt(p, t)
  if (at === null) return { refused: 'cut' }
  const freezes = p.freezes ?? []
  const near = freezeNear(freezes, at)
  if (near) return { refused: 'taken', id: near.id }
  const e = anchorEdit(p.clips, at)
  const still = e === null ? undefined : planOf(p).stills.find((s) => e >= s.editStart && e < s.editEnd)
  if (still) return { refused: 'frozen', id: still.id }
  if (freezes.length >= MAX_FREEZES) return { refused: 'full' }
  return null
}

/** The freeze the playhead `t` is on: the one of its frame, or the one holding the picture there; null when none. */
export function freezeIdAt(p: Project, t: number): string | null {
  const r = freezeRefusal(p, t)
  return r?.id ?? null
}

/** A freeze of the frame under the playhead `t` (snapped to the frame's start), or why not (with the freeze in the way). */
export function freezeAtPlayhead(
  p: Project,
  t: number,
  init?: Partial<Pick<Freeze, 'length' | 'sound'>>
): { project: Project; id: string } | { refused: FreezeRefusal; id?: string } {
  const refused = freezeRefusal(p, t)
  if (refused) return refused
  const at = anchorAt(p, t)!
  // Nothing plays after the end of the video: a freeze there holds the last frame with the sound paused.
  const sound = atEditEnd(p.clips, at) ? 'pause' : (init?.sound ?? DEFAULT_FREEZE_SOUND)
  const f: Freeze = { id: newFreezeId(), at, length: tenths(init?.length ?? FREEZE.default), sound }
  return { project: { ...p, freezes: byAnchor([...(p.freezes ?? []), f]) }, id: f.id }
}

const byAnchor = (list: Freeze[]): Freeze[] => list.sort((a, b) => a.at - b.at)

/** `p` with freeze `id` changed by `patch`; the same project when it is not there or nothing changes. */
function patchFreeze(p: Project, id: string, patch: Partial<Freeze>): Project {
  const f = p.freezes?.find((x) => x.id === id)
  if (!f || (Object.keys(patch) as (keyof Freeze)[]).every((k) => patch[k] === f[k])) return p
  return { ...p, freezes: byAnchor(p.freezes!.map((x) => (x.id === id ? { ...x, ...patch } : x))) }
}

/** The freeze's length, rounded to tenths within FREEZE.min..max. */
export function setFreezeLength(p: Project, id: string, length: number): Project {
  return Number.isFinite(length) ? patchFreeze(p, id, { length: tenths(length) }) : p
}

/** The freeze's sound mode ('continue' is refused at the edit's end, where nothing plays on). */
export function setFreezeSound(p: Project, id: string, sound: FreezeSound): Project {
  const f = p.freezes?.find((x) => x.id === id)
  if (f && sound === 'continue' && atEditEnd(p.clips, f.at)) return p
  return patchFreeze(p, id, { sound })
}

/**
 * The freeze moved to the frame at `t` (the same project when that frame is cut or taken). A clip's
 * end with a cut after it, where a drag snaps to the cut, is in no clip: it takes that clip's last frame.
 */
export function moveFreeze(p: Project, id: string, t: number): Project {
  const cutEdge = clipIndexAt(p.clips, t) < 0 && p.clips.some((c) => c.end === t)
  const at = anchorAt(p, cutEdge ? t - 1e-6 : t)
  if (at === null || freezeNear(p.freezes ?? [], at, id)) return p
  return patchFreeze(p, id, { at })
}

/** The project without the freeze (no `freezes` key when it was the last). */
export function removeFreeze(p: Project, id: string): Project {
  const list = p.freezes ?? []
  const rest = list.filter((f) => f.id !== id)
  if (rest.length === list.length) return p
  if (rest.length > 0) return { ...p, freezes: rest }
  const { freezes: _gone, ...without } = p
  void _gone
  return without
}

/** Source range of a text that shows through the whole freeze ("Add text on the freeze"); null when it is inactive. */
export function freezeTextRange(clips: Clip[], f: Freeze): { start: number; end: number } | null {
  const e = anchorEdit(clips, f.at)
  if (e === null) return null
  return { start: outputToSource(clips, Math.max(0, e - TEXT_AROUND)).time, end: outputToSource(clips, e + TEXT_AROUND).time }
}
