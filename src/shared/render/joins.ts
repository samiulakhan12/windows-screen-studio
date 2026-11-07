/**
 * Smooth cuts (docs/design/editing-polish.md §5): the cuts of an edit, the join each one gets, the
 * windows a crossfade, a slide or a dip runs over, the still A* each needs, the punch-in's scale,
 * and the feeds that keep the export's decoder going forward. Pure; preview and export share it.
 *
 * Every function returns at once for a project without `joins` (no cut has a join, the punch-in's
 * scale is 1, a camera is returned as it is, the feeds are the pictures as they are), so old
 * projects draw exactly as before.
 */
import type { Clip, CutJoin, Project, SlideFrom } from '../types'
import { cubicBezier } from '../engine/easing'
import { editToVideo, planOf, type FreezePlan } from '../engine/freeze'
import { JOIN_LENGTHS, PUNCH_LIMITS } from '../engine/joinData'
import { layoutPhaseAt, layoutsApply } from '../engine/layout'
import { outputDuration, playableFrom } from '../engine/timeline'
import type { Camera } from '../engine/zoom'
import { frameDuration } from './frameTiming'

export const JOIN_DEFAULTS: Readonly<Record<'crossfade' | 'dip' | 'slide', { duration: number; min: number; max: number }>> = JOIN_LENGTHS
export const PUNCH_SCALE: { default: 1.1; min: 1.05; max: 1.2 } = PUNCH_LIMITS
/** A dip less than this many seconds of video after the previous dip draws as a crossfade (§5.2 rule 5). */
export const FLASH_GAP = 1.0

/** Neighbouring clips further apart than this (source s) have a cut between them (editHasCuts' test). */
const CUT_GAP = 1e-6
/** A crossfade, slide or dip shorter than two frames at 30 fps is a hard cut (§5.2 rule 3). */
const SHORTEST = 2 / 30
/** Calm motion's crossfade in place of a slide is at most this long (§5.2 rule 4). */
const CALM_MAX = 0.5
/** The instant just before A's end that A's last kept frame holds (§5.3). */
const BEFORE_END = 1e-6
/** Edit or video times closer than this are the same moment (freeze.ts). */
const EPS = 1e-9

const clipLength = (c: Clip): number => (c.end - c.start) / c.speed
const clamp = (v: number, min: number, max: number): number => Math.min(max, Math.max(min, v))
/** Material's standard easing (§5.5). */
const standard = cubicBezier(0.2, 0, 0, 1)

/** A cut: the clip after it (B) by index and id, B's start in edit and in video time (T). */
export interface CutRef {
  index: number
  clip: string
  edit: number
  video: number
}

const cutMemo = new WeakMap<readonly Clip[], { plan: FreezePlan; cuts: readonly CutRef[] }>()

/**
 * Each cut of `clips` once, in order (a gap of more than 1e-6 s between neighbours): B's index and
 * id, B's start in edit time (the summed lengths of the clips before it) and T, its video time (a
 * pause hold at that instant comes first, so T is then the hold's start). Memoised on `clips` and
 * `plan`.
 */
export function cutsOf(clips: readonly Clip[], plan: FreezePlan): readonly CutRef[] {
  const memo = cutMemo.get(clips)
  if (memo && memo.plan === plan) return memo.cuts
  const cuts: CutRef[] = []
  const holds = plan.holds.length > 0
  let edit = 0
  for (let i = 0; i < clips.length; i++) {
    if (i > 0 && clips[i].start - clips[i - 1].end > CUT_GAP) cuts.push({ index: i, clip: clips[i].id, edit, video: holds ? editToVideo(plan, edit) : edit })
    edit += clipLength(clips[i])
  }
  const frozen = Object.freeze(cuts)
  cutMemo.set(clips, { plan, cuts: frozen })
  return frozen
}

/** Whether the camera leads the picture at source time `t` (camera-only or camera-large, the camera showing). */
export function cameraLed(project: Project, t: number): boolean {
  if (!layoutsApply(project)) return false
  const to = layoutPhaseAt(project, t).to
  return to === 'camera-only' || to === 'camera-large'
}

/** The layouts in which a punch-in zooms the camera's framing rather than the screen (§5.6). */
function cameraPunched(project: Project, t: number): boolean {
  if (!layoutsApply(project)) return false
  const to = layoutPhaseAt(project, t).to
  return to === 'camera-only' || to === 'camera-large' || to === 'side-by-side'
}

/** Everything the joins of a project come from: the memo is kept while none of it changes. */
type Inputs = readonly unknown[]
const inputsOf = (p: Project): Inputs => [p.clips, p.joins, p.freezes, p.effects, p.layouts, p.webcam, p.webcamOffset, p.hasWebcam, p.duration]
const sameInputs = (a: Inputs, b: Inputs): boolean => a.length === b.length && a.every((x, i) => x === b[i])

interface Resolved {
  inputs: Inputs
  cuts: readonly CutRef[]
  /** The join each cut draws with, by cut. */
  joins: readonly (CutJoin | null)[]
  /** The cut each clip follows (its position in `cuts`), or -1. */
  cutOf: Int32Array
  /** The punch-in's scale each clip is drawn at. */
  scales: Float64Array
  windows: readonly JoinWindow[] | null
}

let memo: Resolved | null = null

function lengthOf(kind: 'crossfade' | 'dip' | 'slide', stored: number | undefined): number {
  const r = JOIN_DEFAULTS[kind]
  return typeof stored === 'number' && Number.isFinite(stored) ? clamp(stored, r.min, r.max) : r.duration
}

function scaleOf(stored: number | undefined): number {
  return typeof stored === 'number' && Number.isFinite(stored) ? clamp(stored, PUNCH_SCALE.min, PUNCH_SCALE.max) : PUNCH_SCALE.default
}

/** What Smooth gives the cut between `a` and `b`: a punch-in when the camera leads on both sides (§5.2 rule 2). */
function smoothKind(project: Project, a: Clip, b: Clip): 'crossfade' | 'punch' {
  return cameraLed(project, a.end - BEFORE_END) && cameraLed(project, b.start) ? 'punch' : 'crossfade'
}

/**
 * The joins of every cut in order (§5.2): a cut's own style, else every cut's; Smooth resolved by the
 * layout; lengths clamped to the clips; Calm motion's crossfade for a slide; the flash rule. Then the
 * punch-in's scale of every clip (§5.4).
 */
function resolveAll(project: Project, inputs: Inputs): Resolved {
  const clips = project.clips
  const cuts = cutsOf(clips, planOf(project))
  const own = new Map<string, CutJoin>()
  for (const c of project.joins?.cuts ?? []) if (!own.has(c.clip)) own.set(c.clip, c)
  const all = project.joins?.all ?? null
  const calm = project.effects?.calm === true
  const joins: (CutJoin | null)[] = []
  const cutOf = new Int32Array(clips.length).fill(-1)
  let lastDip = -Infinity
  cuts.forEach((cut, k) => {
    cutOf[cut.index] = k
    const a = clips[cut.index - 1]
    const b = clips[cut.index]
    const stored = own.get(cut.clip) ?? all
    let join: CutJoin | null = null
    if (stored && stored.kind !== 'cut') {
      const kind = stored.kind === 'smooth' ? smoothKind(project, a, b) : stored.kind
      if (kind === 'punch') {
        join = { kind: 'punch', scale: scaleOf(stored.scale) }
      } else if (kind === 'crossfade' || kind === 'slide') {
        let d = Math.min(lengthOf(kind, stored.duration), clipLength(b) / 2)
        if (d >= SHORTEST) {
          if (kind === 'slide' && !calm) join = { kind: 'slide', duration: d, from: stored.from ?? 'right' }
          else {
            if (kind === 'slide') d = Math.min(d, CALM_MAX)
            join = { kind: 'crossfade', duration: d }
          }
        }
      } else if (kind === 'dip') {
        const h = Math.min(lengthOf('dip', stored.duration) / 2, clipLength(a) / 2, clipLength(b) / 2)
        if (2 * h >= SHORTEST) {
          if (cut.video - lastDip < FLASH_GAP) {
            // The flash rule: a dip so soon after the last one draws as a crossfade.
            const d = Math.min(JOIN_DEFAULTS.crossfade.duration, clipLength(b) / 2)
            join = d >= SHORTEST ? { kind: 'crossfade', duration: d } : null
          } else {
            lastDip = cut.video
            join = { kind: 'dip', duration: 2 * h, color: stored.color ?? '#000000' }
          }
        }
      }
    }
    joins.push(join)
  })
  // The punch-in: each punched cut toggles it, any other cut ends it, a touching clip keeps it.
  const scales = new Float64Array(clips.length).fill(1)
  let on = false
  let scale = 1
  for (let i = 0; i < clips.length; i++) {
    const k = cutOf[i]
    if (k >= 0) {
      const j = joins[k]
      if (j?.kind === 'punch') {
        on = !on
        scale = j.scale ?? PUNCH_SCALE.default
      } else on = false
    }
    scales[i] = on ? scale : 1
  }
  return { inputs, cuts, joins, cutOf, scales, windows: null }
}

/** The project's resolved joins, memoised on what they come from (one entry: the preview asks every frame). */
function resolved(project: Project): Resolved {
  const inputs = inputsOf(project)
  if (memo && sameInputs(memo.inputs, inputs)) return memo
  memo = resolveAll(project, inputs)
  return memo
}

/**
 * The join cut `index` (B's clip index, CutRef.index) draws with: its own, else every cut's,
 * resolved by §5.2 (never 'smooth': a crossfade or a punch-in); null: a hard cut, or no cut there.
 * Every field is filled in with what is drawn (a dip's `duration` is both halves).
 */
export function resolvedJoin(project: Project, index: number): CutJoin | null {
  if (!project.joins) return null
  const r = resolved(project)
  const k = index >= 0 && index < r.cutOf.length ? r.cutOf[index] : -1
  return k >= 0 ? r.joins[k] : null
}

/** What Smooth gives the cut before clip `index`: a punch-in when the camera leads on both sides, else a crossfade. */
export function smoothAt(project: Project, index: number): 'crossfade' | 'punch' {
  const clips = project.clips
  if (index <= 0 || index >= clips.length) return 'crossfade'
  return smoothKind(project, clips[index - 1], clips[index])
}

/** The window a crossfade, slide or dip runs over (video seconds), and the still it needs (§5.4). */
export interface JoinWindow {
  index: number
  clip: string
  kind: 'crossfade' | 'dip' | 'slide'
  from: number
  to: number
  at: number
  still: { screen: number; held: boolean; camera: number | null } | null
  color?: string
  dir?: SlideFrom
}

/**
 * A*'s instants (§5.3): the screen's just before A's end, or the picture of a continue freeze that
 * holds A's end; the camera's on its own clock (none when the camera's layouts do not apply).
 */
function stillOf(project: Project, plan: FreezePlan, a: Clip, edit: number): JoinWindow['still'] {
  const o = edit - BEFORE_END / a.speed
  const s = plan.stills.find((x) => o >= x.editStart - EPS && o < x.editEnd - EPS)
  const camera = layoutsApply(project) ? a.end - project.webcamOffset - BEFORE_END : null
  return s ? { screen: s.at, held: true, camera } : { screen: a.end - BEFORE_END, held: false, camera }
}

/** The windows of every cut with a crossfade, slide or dip, in order (memoised per project). */
export function joinPlan(project: Project): readonly JoinWindow[] {
  if (!project.joins) return []
  const r = resolved(project)
  if (r.windows) return r.windows
  const clips = project.clips
  const plan = planOf(project)
  const windows: JoinWindow[] = []
  r.cuts.forEach((cut, k) => {
    const j = r.joins[k]
    if (!j || (j.kind !== 'crossfade' && j.kind !== 'slide' && j.kind !== 'dip')) return
    const T = cut.video
    const d = j.duration ?? 0
    const base = { index: cut.index, clip: cut.clip, at: T }
    let w: JoinWindow
    if (j.kind === 'dip') w = { ...base, kind: 'dip', from: T - d / 2, to: T + d / 2, still: null, color: j.color ?? '#000000' }
    else if (j.kind === 'slide') w = { ...base, kind: 'slide', from: T, to: T + d, still: stillOf(project, plan, clips[cut.index - 1], cut.edit), dir: j.from ?? 'right' }
    else w = { ...base, kind: 'crossfade', from: T, to: T + d, still: stillOf(project, plan, clips[cut.index - 1], cut.edit) }
    // Windows never overlap (§5.4); where two meet, rounding may not say so: the earlier one ends there.
    const prev = windows[windows.length - 1]
    if (prev && prev.to > w.from) prev.to = w.from
    windows.push(w)
  })
  r.windows = Object.freeze(windows)
  return r.windows
}

export interface JoinAt {
  window: JoinWindow
  /** Progress through the window, 0..1. */
  p: number
}

/** The window holding video time `video` (binary search), or null. */
export function joinAt(windows: readonly JoinWindow[], video: number): JoinAt | null {
  let lo = 0
  let hi = windows.length - 1
  let found = -1
  while (lo <= hi) {
    const mid = (lo + hi) >> 1
    if (windows[mid].from <= video) {
      found = mid
      lo = mid + 1
    } else hi = mid - 1
  }
  if (found < 0) return null
  const w = windows[found]
  if (!(video < w.to)) return null
  return { window: w, p: (video - w.from) / (w.to - w.from) }
}

/** A track's presentation-ordered frame starts and half its median frame duration. */
export interface TrackTimes {
  starts: Float64Array
  half: number
}

/**
 * A track's frame times from its samples (the decoder's own: presentation order, half the median
 * frame duration, feedPlan's rule), or a constant-rate grid at `fallbackFps` over `seconds` (the
 * rate the seeking path falls back to when the track cannot be indexed).
 */
export function trackTimes(samples: readonly { time: number; duration: number }[] | null, fallbackFps: number, seconds: number): TrackTimes {
  if (samples && samples.length > 0) {
    const starts = Float64Array.from(samples, (s) => s.time).sort()
    return { starts, half: (frameDuration([...samples]) ?? 1 / 60) / 2 }
  }
  const fps = fallbackFps > 0 ? fallbackFps : 60
  const n = Math.max(1, Math.ceil(Math.max(0, seconds) * fps) + 2)
  return { starts: Float64Array.from({ length: n }, (_, k) => k / fps), half: 0.5 / fps }
}

/** The last frame of `starts` that starts at or before `t` (0 when none does). */
function lastAtOrBefore(starts: Float64Array, t: number): number {
  let lo = 0
  let hi = starts.length - 1
  let best = 0
  while (lo <= hi) {
    const mid = (lo + hi) >> 1
    if (starts[mid] <= t) {
      best = mid
      lo = mid + 1
    } else hi = mid - 1
  }
  return best
}

/** The frame the export's decoder shows for time `t` (mp4.presentationIndex with half a frame of slack). */
export function decodedIndex(track: TrackTimes, t: number): number {
  return lastAtOrBefore(track.starts, t + track.half)
}

/** The time that asks for frame `k` (§5.3): presentationIndex and, on a constant-rate track, frameIndexAt both give k. */
export function askTime(track: TrackTimes, k: number): number {
  const start = track.starts[k] ?? 0
  return Math.max(0, start - track.half + 1e-6)
}

/**
 * The frame k* that holds `instant` (§5.3): the last frame that starts at or before it, never before
 * the frame that holds `aStart`; under a continue freeze (`held`), the frame the freeze itself shows
 * (the decoder's rule at the instant). `ask` is the time that asks the decoder for exactly k*.
 */
export function stillFrame(track: TrackTimes, instant: number, held: boolean, aStart: number): { index: number; ask: number } {
  if (track.starts.length === 0) return { index: 0, ask: Math.max(0, instant) }
  const index = held ? decodedIndex(track, instant) : Math.max(lastAtOrBefore(track.starts, instant), lastAtOrBefore(track.starts, aStart))
  return { index, ask: askTime(track, index) }
}

/** The clip holding source time `t` (its end included, so the edit's last instant is its last clip's), or -1. */
function clipAt(clips: readonly Clip[], t: number): number {
  let lo = 0
  let hi = clips.length - 1
  let found = -1
  while (lo <= hi) {
    const mid = (lo + hi) >> 1
    if (clips[mid].start <= t) {
      found = mid
      lo = mid + 1
    } else hi = mid - 1
  }
  return found >= 0 && t <= clips[found].end ? found : -1
}

/** The punch-in's scale at source time `t`: 1 without one (a pause hold passes its held frame's time). */
export function punchAt(project: Project, t: number): number {
  if (!project.joins) return 1
  const r = resolved(project)
  const i = clipAt(project.clips, t)
  return i >= 0 ? r.scales[i] : 1
}

/**
 * `cam` shown `punchAt` times closer about its own centre (§5.6), or `cam` itself when there is no
 * punch-in at `t`, when the layout there punches the camera's framing instead (camera-led or side by
 * side), or while the camera pulls back (the card would change size). The view stays inside the
 * recording.
 */
export function punchedCamera(cam: Camera, project: Project, t: number): Camera {
  if (!project.joins) return cam
  const s = punchAt(project, t)
  if (s === 1 || !(cam.scale >= 1) || cameraPunched(project, t)) return cam
  const scale = cam.scale * s
  const half = 0.5 / scale
  return { ...cam, scale, cx: clamp(cam.cx, half, 1 - half), cy: clamp(cam.cy, half, 1 - half) }
}

/** How the live picture, A* and a dip's colour are drawn at `at` in a w × h frame (§5.5). */
export function joinPose(
  at: JoinAt,
  w: number,
  h: number
): {
  live: { dx: number; dy: number }
  still: { alpha: number; dx: number; dy: number } | null
  fill: { color: string; alpha: number } | null
} {
  const { window: win } = at
  const p = clamp(at.p, 0, 1)
  if (win.kind === 'crossfade') return { live: { dx: 0, dy: 0 }, still: { alpha: 1 - p, dx: 0, dy: 0 }, fill: null }
  if (win.kind === 'dip') return { live: { dx: 0, dy: 0 }, still: null, fill: { color: win.color ?? '#000000', alpha: p < 0.5 ? 2 * p : 2 - 2 * p } }
  const e = standard(p)
  switch (win.dir ?? 'right') {
    case 'left':
      return { live: { dx: -w * (1 - e), dy: 0 }, still: { alpha: 1, dx: w * e, dy: 0 }, fill: null }
    case 'top':
      return { live: { dx: 0, dy: -h * (1 - e) }, still: { alpha: 1, dx: 0, dy: h * e }, fill: null }
    case 'bottom':
      return { live: { dx: 0, dy: h * (1 - e) }, still: { alpha: 1, dx: 0, dy: -h * e }, fill: null }
    default:
      return { live: { dx: w * (1 - e), dy: 0 }, still: { alpha: 1, dx: -w * e, dy: 0 }, fill: null }
  }
}

/** Edit time of a playhead at source time `t`: where playback goes on from in a cut, the edit's end past it. */
function editTimeAt(clips: Clip[], t: number): number {
  const from = playableFrom(clips, t)
  if (!from) return outputDuration(clips)
  let acc = 0
  for (let i = 0; i < from.index; i++) acc += clipLength(clips[i])
  const c = clips[from.index]
  return acc + (from.time - c.start) / c.speed
}

/**
 * The video time of the preview's frame at source time `t` (§5.7): inside a hold its start plus the
 * time spent in it; otherwise editToVideo, plus the whole length of the hold at that very instant
 * once the player has left it (`leftHoldAt`: its source time), as the player's holdElapsed counts it.
 */
export function frameVideoTime(clips: Clip[], plan: FreezePlan, t: number, hold: { start: number; elapsed: number } | null, leftHoldAt: number | null): number {
  if (hold) return hold.start + hold.elapsed
  const o = editTimeAt(clips, t)
  const v = plan.holds.length > 0 ? editToVideo(plan, o) : o
  if (leftHoldAt === null) return v
  const left = plan.holds.find((h) => h.at === leftHoldAt)
  return left && !(left.edit < o - EPS) ? v + left.length : v
}

/** The export's decoder feeds with the stills inserted where their frames fall (§5.8). */
export interface JoinFeed {
  screen: number[]
  camera: number[]
  draw: { screen: Int32Array; camera: Int32Array }
  /** Each still's window (its position in `windows`) and its positions in the feeds. */
  stills: { window: number; screen: number; camera: number | null }[]
}

/** Where a still goes in a feed: shared with the entry at `at` (`share`), or inserted right before it. */
interface Slot {
  at: number
  share: boolean
  index: number
  ask: number
}

/** The first position of `idx` (non-decreasing) whose value is at least `k`. */
function firstAtLeast(idx: Int32Array, k: number): number {
  let lo = 0
  let hi = idx.length
  while (lo < hi) {
    const mid = (lo + hi) >> 1
    if (idx[mid] < k) lo = mid + 1
    else hi = mid
  }
  return lo
}

function slotOf(idx: Int32Array, track: TrackTimes, instant: number, held: boolean): Slot {
  const { index, ask } = stillFrame(track, instant, held, -Infinity)
  const at = firstAtLeast(idx, index)
  return { at, share: at < idx.length && idx[at] === index, index, ask }
}

/** One feed with its stills placed: the times, each original entry's new position, and each slot's position. */
function placeStills(times: readonly number[], slots: readonly (Slot | null)[]): { feed: number[]; moved: Int32Array; placed: (number | null)[] } {
  const inserts = slots
    .map((s, n) => ({ s, n }))
    .filter((x): x is { s: Slot; n: number } => !!x.s && !x.s.share)
    .sort((a, b) => a.s.at - b.s.at || a.s.index - b.s.index)
  const feed: number[] = []
  const moved = new Int32Array(times.length)
  const placed: (number | null)[] = slots.map(() => null)
  let next = 0
  let last: Slot | null = null
  let lastPos = -1
  const emitUpTo = (j: number): void => {
    while (next < inserts.length && inserts[next].s.at <= j) {
      const { s, n } = inserts[next++]
      // Two stills of the same frame at the same place share one entry.
      if (!(last && last.at === s.at && last.index === s.index)) {
        lastPos = feed.length
        feed.push(s.ask)
        last = s
      }
      placed[n] = lastPos
    }
  }
  for (let j = 0; j < times.length; j++) {
    emitUpTo(j)
    moved[j] = feed.length
    feed.push(times[j])
  }
  emitUpTo(times.length)
  slots.forEach((s, n) => {
    if (s?.share) placed[n] = moved[s.at]
  })
  return { feed, moved, placed }
}

/**
 * The feeds of both sources (§5.8): each window's still frame goes in at its sorted place by
 * presentation index, right before the first entry past it, or shares an entry of the same frame,
 * so each feed's indices never decrease and the decoder never skips. Returns the feeds, the
 * position each output frame draws from, and each still's positions. A window with no output frame
 * adds no still; a still the feed reaches only after the window's first output frame makes it hard.
 * Without stills: the pictures and camera times as they are, each output frame drawing its own entry.
 */
export function joinFeed(input: {
  pictures: readonly number[]
  cameraTimes: readonly number[] | null
  windows: readonly JoinWindow[]
  fps: number
  screen: TrackTimes
  camera: TrackTimes | null
}): JoinFeed {
  const { pictures, cameraTimes, windows, fps, screen, camera } = input
  const n = pictures.length
  const identity = (): JoinFeed => {
    const draw = Int32Array.from({ length: n }, (_, i) => i)
    return {
      screen: [...pictures],
      camera: cameraTimes ? [...cameraTimes] : [],
      draw: { screen: draw, camera: cameraTimes ? Int32Array.from(draw) : new Int32Array(0) },
      stills: []
    }
  }
  if (n === 0 || !windows.some((w) => w.still)) return identity()
  const screenIdx = Int32Array.from(pictures, (t) => decodedIndex(screen, t))
  const cam = cameraTimes && camera ? { times: cameraTimes, track: camera, idx: Int32Array.from(cameraTimes, (t) => decodedIndex(camera, t)) } : null
  const screenSlots: (Slot | null)[] = []
  const cameraSlots: (Slot | null)[] = []
  const owners: number[] = []
  windows.forEach((w, at) => {
    if (!w.still) return
    const i0 = Math.max(0, Math.ceil(w.at * fps - 1e-9))
    // No output frame inside the window: nothing to draw it on.
    if (i0 >= n || !(i0 / fps < w.to - EPS)) return
    const s = slotOf(screenIdx, screen, w.still.screen, w.still.held)
    // Reached only after the window's first frame (a cut shorter than half a frame): a hard cut.
    if (s.at > i0) return
    let c: Slot | null = null
    if (cam && w.still.camera !== null) {
      c = slotOf(cam.idx, cam.track, w.still.camera, false)
      if (c.at > i0) return
    }
    owners.push(at)
    screenSlots.push(s)
    cameraSlots.push(c)
  })
  if (owners.length === 0) return identity()
  const s = placeStills(pictures, screenSlots)
  const c = cam ? placeStills(cam.times, cameraSlots) : null
  return {
    screen: s.feed,
    camera: c ? c.feed : cameraTimes ? [...cameraTimes] : [],
    draw: { screen: s.moved, camera: c ? c.moved : cameraTimes ? Int32Array.from({ length: n }, (_, i) => i) : new Int32Array(0) },
    stills: owners.map((w, k) => ({ window: w, screen: s.placed[k]!, camera: c ? c.placed[k] : null }))
  }
}
