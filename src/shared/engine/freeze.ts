/**
 * Freeze frames (E-11, docs/design/freeze-frame.md): the plan and the time maps. Pure.
 *
 * Times: source time stays the base (timeline.ts, unchanged). "Edit time" is today's output time
 * (the clips played back to back). "Video time" is edit time plus the pause holds inserted before
 * it, the clock of the exported video. Only the player clock, export frames and sound, the times
 * written into files and the displayed positions read video time; everything else stays in source
 * or edit time.
 *
 * A project without freezes plans to NO_FREEZES, and every map below is then the identity, so it
 * previews and exports exactly as before.
 *
 * Contracts commit: the constants, types, NO_FREEZES, planOf and freezeKeepRanges are final; the
 * plan and the maps are the identity until E-11 lands (TODO(E-11) below).
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

/** The plan of a project without freezes (every map is the identity for it). */
export const NO_FREEZES: FreezePlan = Object.freeze({ holds: frozen<Hold>([]), stills: frozen<Still>([]), added: 0, inactive: frozen<string>([]) })

/** The plan for `freezes` on `clips` (docs/design/freeze-frame.md §4.1). */
export function freezePlan(clips: readonly Clip[], freezes: readonly Freeze[] | undefined): FreezePlan {
  // TODO(E-11): holds and stills from the active freezes in edit order.
  void clips
  void freezes
  return NO_FREEZES
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
  // TODO(E-11): o + Σ h.length for holds with h.edit < o − 1e-9.
  void plan
  return o
}

/** Edit time of video time `v`; inside a hold, the hold's edit time and how far into it `v` is. */
export function videoToEdit(plan: FreezePlan, v: number): { edit: number; hold: Hold | null; elapsed: number } {
  // TODO(E-11): subtract the holds before `v`.
  void plan
  return { edit: v, hold: null, elapsed: 0 }
}

/** Source time shown at video time `v` (the held frame inside a hold), its clip, and the hold. */
export function videoToSource(clips: Clip[], plan: FreezePlan, v: number): { time: number; index: number; hold: Hold | null } {
  // TODO(E-11): through videoToEdit; time = h.at inside a hold.
  void plan
  const { time, index } = outputToSource(clips, v)
  return { time, index, hold: null }
}

/** Edit time for a playhead at source time `t` (editor/clips.ts outputTimeAt; engine does not import editor/). */
function editTimeAt(clips: Clip[], t: number): number {
  const from = playableFrom(clips, t)
  const s = from ? from.time : clips[clips.length - 1].end
  return sourceToOutput(clips, s) ?? outputDuration(clips)
}

/** Video time for a playhead at source time `t` (the edit's end is the video's end). */
export function videoTimeAt(clips: Clip[], plan: FreezePlan, t: number): number {
  // TODO(E-11): videoDuration at the edit's end, else editToVideo(plan, edit time).
  void plan
  return editTimeAt(clips, t)
}

/**
 * Source frames of an export at `fps`: `times` drive the clock (sound, camera), `pictures` the
 * screen frame drawn (the still during a continue freeze), `held` marks frames inside a freeze
 * (drawn without motion blur). Without freezes: exportFrameTimes, `pictures === times`, `held` null.
 */
export function videoFrames(clips: Clip[], plan: FreezePlan, fps: number): { times: number[]; pictures: number[]; held: Uint8Array | null } {
  // TODO(E-11): hold frames and still pictures.
  void plan
  const times = exportFrameTimes(clips, fps)
  return { times, pictures: times, held: null }
}

/** The source time whose picture is drawn at source time `t`: a still's anchor inside its span, else `t`. */
export function pictureTime(clips: Clip[], plan: FreezePlan, t: number): number {
  // TODO(E-11): still.at when sourceToOutput(clips, t) is in [editStart, editEnd).
  void clips
  void plan
  return t
}

/**
 * Source ranges smart speed, remove silences and polish keep as they are: FREEZE_KEEP on each side
 * of every anchor. Structural ({ start, end }), so engine does not import editor/smartSpeed.
 */
export function freezeKeepRanges(freezes: readonly Freeze[] | undefined): { start: number; end: number }[] {
  return (freezes ?? []).map((f) => ({ start: f.at - FREEZE_KEEP, end: f.at + FREEZE_KEEP }))
}

/** Source seconds snapping catches (E-05): active anchors and still ends. */
export function freezeSnapTargets(clips: Clip[], plan: FreezePlan): number[] {
  // TODO(E-11): from the plan's holds and stills.
  void clips
  void plan
  return []
}
