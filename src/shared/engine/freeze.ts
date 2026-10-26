/**
 * Freeze frames (E-11, docs/design/freeze-frame.md): the plan and the time maps. Pure.
 *
 * Times: source time stays the base (timeline.ts, unchanged). "Edit time" is today's output time
 * (the clips played back to back). "Video time" is edit time plus the pause holds inserted before
 * it, the clock of the exported video. Only the player clock, export frames and sound, the times
 * written into files and the displayed positions read video time; everything else stays in source
 * or edit time.
 *
 * One rule covers ranges and points: something that starts exactly at a hold includes the hold, a
 * range that ends exactly at a hold ends before it, and a range with a hold inside stretches across.
 *
 * A project without freezes plans to NO_FREEZES, and every map below is then the identity, so it
 * previews and exports exactly as before.
 */
import type { Clip, Freeze, FreezeSound, Project } from '../types'
import { exportFrameTimes, outputDuration, outputToSource, playableFrom, sourceToOutput } from './timeline'

/** Hold length (seconds of the exported video): 0.5..30 in tenths, 3 by default. */
export const FREEZE = { min: 0.5, max: 30, step: 0.1, default: 3 } as const
export const DEFAULT_FREEZE_SOUND: FreezeSound = 'pause'
/** Anchors closer than this (source s) are the same frame: half a 60 fps frame. */
export const FREEZE_EPS = 1 / 120
/** Most freezes a project keeps (bounds the audio graph). */
export const MAX_FREEZES = 200
/** Smart speed and remove silences keep this much (source s) on each side of an anchor. */
export const FREEZE_KEEP = 0.25

let idCounter = 0
export const newFreezeId = (): string => `f${Date.now().toString(36)}${(idCounter++).toString(36)}`

/** A pause freeze in the plan. */
export interface Hold {
  id: string
  /** Source second of the held frame. */
  at: number
  /** Edit second the hold is inserted at. */
  edit: number
  /** Video second the hold begins. */
  start: number
  /** Seconds it lasts. */
  length: number
  /** At the edit's end (holds the last frame). */
  end: boolean
}

/** A continue freeze in the plan: the picture shows `at` over edit [editStart, editEnd). */
export interface Still {
  id: string
  at: number
  editStart: number
  editEnd: number
}

export interface FreezePlan {
  /** Pause freezes in edit order. */
  holds: Hold[]
  /** Continue freezes. */
  stills: Still[]
  /** Sum of the hold lengths: seconds the video is longer than the edit. */
  added: number
  /** Ids whose frame is cut, or whose continue span is under 0.05 s. */
  inactive: string[]
}

const frozen = <T>(list: T[]): T[] => Object.freeze(list) as T[]

/** Shortest continue span (edit s) that is shown; a shorter one is inactive. */
const MIN_STILL = 0.05
/** Edit or video times closer than this are the same moment. */
const EPS = 1e-9
/**
 * An anchor this close to the edit's end (source s) is the end: project.json keeps anchors in whole
 * ms and an edit's end often is not (a trim leaves the pointer's time), so a stored end anchor comes
 * back up to half a ms off it. The playhead's snap to the end (freezeEdit) and the export's sound
 * (audioPlan HOLD_SNAP) use the same 1 ms.
 */
const END_SNAP = 1e-3

const clipLength = (c: Clip): number => (c.end - c.start) / c.speed

/** True when anchor `at` is the edit's end (within END_SNAP): a freeze there holds the last frame. */
export function atEditEnd(clips: readonly Clip[], at: number): boolean {
  return Math.abs(at - clips[clips.length - 1].end) <= END_SNAP
}

/** Edit second of anchor `at`: the edit's end for one at it (atEditEnd), null when its frame is cut. */
export function anchorEdit(clips: readonly Clip[], at: number): number | null {
  const list = clips as Clip[]
  return atEditEnd(list, at) ? outputDuration(list) : sourceToOutput(list, at)
}

/** The plan of a project without freezes (every map is the identity for it). */
export const NO_FREEZES: FreezePlan = Object.freeze({ holds: frozen<Hold>([]), stills: frozen<Still>([]), added: 0, inactive: frozen<string>([]) })

/**
 * The plan for `freezes` on `clips` (docs/design/freeze-frame.md §4.1): a freeze whose frame is cut
 * is inactive; the active ones in edit order become holds (pause: each inserted at its edit time,
 * after the holds before it; one at the edit's end, atEditEnd, holds the last frame) and stills
 * (continue: the span ends at the next active freeze, at the end of the video, or after its length,
 * whichever comes first; a span under MIN_STILL is inactive).
 */
export function freezePlan(clips: readonly Clip[], freezes: readonly Freeze[] | undefined): FreezePlan {
  if (!freezes || freezes.length === 0 || clips.length === 0) return NO_FREEZES
  const list = clips as Clip[]
  const total = outputDuration(list)
  const inactive: string[] = []
  const active: { f: Freeze; edit: number }[] = []
  for (const f of [...freezes].sort((a, b) => a.at - b.at)) {
    const edit = anchorEdit(list, f.at)
    if (edit === null) inactive.push(f.id)
    else active.push({ f, edit })
  }
  active.sort((a, b) => a.edit - b.edit)
  const holds: Hold[] = []
  const stills: Still[] = []
  let added = 0
  active.forEach(({ f, edit }, i) => {
    if (f.sound === 'pause') {
      holds.push({ id: f.id, at: f.at, edit, start: edit + added, length: f.length, end: atEditEnd(list, f.at) })
      added += f.length
      return
    }
    const editEnd = Math.min(edit + f.length, i + 1 < active.length ? active[i + 1].edit : total, total)
    if (editEnd - edit < MIN_STILL) inactive.push(f.id)
    else stills.push({ id: f.id, at: f.at, editStart: edit, editEnd })
  })
  return { holds, stills, added, inactive }
}

let memo: { clips: Clip[]; freezes: Freeze[]; plan: FreezePlan } | null = null

/** The project's plan: NO_FREEZES without freezes, else freezePlan memoised on (clips, freezes) identity (one entry). */
export function planOf(p: Pick<Project, 'clips' | 'freezes'>): FreezePlan {
  const freezes = p.freezes
  if (!freezes || freezes.length === 0) return NO_FREEZES
  if (memo && memo.clips === p.clips && memo.freezes === freezes) return memo.plan
  const plan = freezePlan(p.clips, freezes)
  memo = { clips: p.clips, freezes, plan }
  return plan
}

/** Length of the exported video: the edit plus the holds. */
export function videoDuration(clips: Clip[], plan: FreezePlan): number {
  return outputDuration(clips) + plan.added
}

/** Video time of edit time `o`: plus the holds before it (a hold AT `o` comes first: `o` maps to its start). */
export function editToVideo(plan: FreezePlan, o: number): number {
  let v = o
  for (const h of plan.holds) {
    if (!(h.edit < o - EPS)) break
    v += h.length
  }
  return v
}

/** Edit time of video time `v`; inside a hold, the hold's edit time and how far into it `v` is. */
export function videoToEdit(plan: FreezePlan, v: number): { edit: number; hold: Hold | null; elapsed: number } {
  let added = 0
  for (const h of plan.holds) {
    if (v < h.start - EPS) break
    if (v < h.start + h.length - EPS) return { edit: h.edit, hold: h, elapsed: Math.max(0, v - h.start) }
    added += h.length
  }
  return { edit: v - added, hold: null, elapsed: 0 }
}

/** Source time shown at video time `v` (the held frame inside a hold), its clip, and the hold. */
export function videoToSource(clips: Clip[], plan: FreezePlan, v: number): { time: number; index: number; hold: Hold | null } {
  const { edit, hold } = videoToEdit(plan, v)
  const { time, index } = outputToSource(clips, edit)
  return hold ? { time: hold.at, index, hold } : { time, index, hold: null }
}

/** Edit time for a playhead at source time `t` (editor/clips.ts outputTimeAt; engine does not import editor/). */
function editTimeAt(clips: Clip[], t: number): number {
  const from = playableFrom(clips, t)
  const s = from ? from.time : clips[clips.length - 1].end
  return sourceToOutput(clips, s) ?? outputDuration(clips)
}

/** Video time for a playhead at source time `t` (the edit's end is the video's end). */
export function videoTimeAt(clips: Clip[], plan: FreezePlan, t: number): number {
  const o = editTimeAt(clips, t)
  if (plan.holds.length === 0) return o
  return o >= outputDuration(clips) - EPS ? videoDuration(clips, plan) : editToVideo(plan, o)
}

/** The still whose span holds edit time `o`, or null. */
function stillAt(plan: FreezePlan, o: number): Still | null {
  return plan.stills.find((s) => o >= s.editStart - EPS && o < s.editEnd - EPS) ?? null
}

/**
 * Source frames of an export at `fps`: `times` drive the clock (sound, camera), `pictures` the
 * screen frame drawn (the still during a continue freeze), `held` marks frames inside a freeze
 * (drawn without motion blur). Without freezes: exportFrameTimes, `pictures === times`, `held` null.
 *
 * Frame i shows video time i / fps. Inside a hold it repeats the held frame; a hold at the edit's
 * end repeats the last frame the edit exported (its source time at the edit's end could decode as
 * the first frame trimmed off). Neither list ever decreases (feedPlan handles repeats and jumps).
 */
export function videoFrames(clips: Clip[], plan: FreezePlan, fps: number): { times: number[]; pictures: number[]; held: Uint8Array | null } {
  const { holds, stills } = plan
  if (holds.length === 0) {
    const times = exportFrameTimes(clips, fps)
    if (stills.length === 0) return { times, pictures: times, held: null }
    // No time added: the video's clock is the edit's, only the pictures of the spans change.
    const pictures = times.slice()
    const held = new Uint8Array(times.length)
    for (let i = 0; i < times.length; i++) {
      const s = stillAt(plan, i / fps)
      if (s) {
        pictures[i] = s.at
        held[i] = 1
      }
    }
    return { times, pictures, held }
  }
  const count = Math.max(1, Math.round(videoDuration(clips, plan) * fps))
  const times: number[] = new Array(count)
  const pictures: number[] = new Array(count)
  const held = new Uint8Array(count)
  // One pointer walks the holds (with the time they added so far), one the clips, one the stills.
  let hi = 0
  let added = 0
  let ci = 0
  let clipOutStart = 0
  let si = 0
  let shown = { time: clips[clips.length - 1].start, picture: clips[clips.length - 1].start }
  for (let i = 0; i < count; i++) {
    const v = i / fps
    while (hi < holds.length && v >= holds[hi].start + holds[hi].length - EPS) added += holds[hi++].length
    const h = holds[hi]
    if (h && v >= h.start - EPS) {
      const at = h.end ? shown : { time: h.at, picture: h.at }
      times[i] = at.time
      pictures[i] = at.picture
      held[i] = 1
      continue
    }
    const o = v - added
    while (ci < clips.length - 1 && o >= clipOutStart + clipLength(clips[ci]) - EPS) {
      clipOutStart += clipLength(clips[ci])
      ci++
    }
    const c = clips[ci]
    const t = Math.min(c.start + (o - clipOutStart) * c.speed, c.end)
    while (si < stills.length && o >= stills[si].editEnd - EPS) si++
    const s = stills[si]
    const still = !!s && o >= s.editStart - EPS
    times[i] = t
    pictures[i] = still ? s.at : t
    if (still) held[i] = 1
    shown = { time: t, picture: pictures[i] }
  }
  return { times, pictures, held }
}

/**
 * Texts ending at or after this source time do not fade out (E-11): the edit's end, when a pause
 * freeze holds a moment of the edit's last `fade` seconds (edit time) and a text running to the end
 * would be drawn part faded out through the whole hold ("Add text on the freeze" on a freeze at or
 * near the end ends its text there). Infinity otherwise: every text fades out as before.
 */
export function noFadeOutFrom(clips: Clip[], plan: FreezePlan, fade: number): number {
  const last = plan.holds[plan.holds.length - 1]
  return last && outputDuration(clips) - last.edit < fade ? clips[clips.length - 1].end - END_SNAP : Infinity
}

/** The source time whose picture is drawn at source time `t`: a still's anchor inside its span, else `t`. */
export function pictureTime(clips: Clip[], plan: FreezePlan, t: number): number {
  if (plan.stills.length === 0) return t
  const o = sourceToOutput(clips, t)
  const s = o === null ? null : stillAt(plan, o)
  return s ? s.at : t
}

/**
 * Source ranges smart speed, remove silences and polish keep as they are: FREEZE_KEEP on each side
 * of every anchor. Structural ({ start, end }), so engine does not import editor/smartSpeed.
 */
export function freezeKeepRanges(freezes: readonly Freeze[] | undefined): { start: number; end: number }[] {
  return (freezes ?? []).map((f) => ({ start: f.at - FREEZE_KEEP, end: f.at + FREEZE_KEEP }))
}

/** Source seconds snapping catches (E-05): active anchors and still ends, sorted, once each. */
export function freezeSnapTargets(clips: Clip[], plan: FreezePlan): number[] {
  const times = [...plan.holds.map((h) => h.at), ...plan.stills.flatMap((s) => [s.at, outputToSource(clips, s.editEnd).time])]
  return [...new Set(times)].sort((a, b) => a - b)
}
