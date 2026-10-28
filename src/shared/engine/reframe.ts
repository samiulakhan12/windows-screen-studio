/**
 * The view that follows the action (NW-05, docs/design/vertical-video.md §5): an offline shot
 * plan of holds and C² glides, planned in output time from where the cursor rests and goes,
 * clicks, typing, drawn shapes, scrolls and zooms, and read by source time. Pure: the plan is a
 * function of the drawn project and the drawn track (cropView), so preview, scrubbing and export
 * agree. Also the framed zooms (gentler, capped, relative to the view; §5.12).
 *
 * The planner samples what the view should look at on a grid of output time (attention), finds
 * the held views (shots: dead zone, confirmation, look-ahead), drops and merges short ones, joins
 * them with pans whose speed, acceleration and deadlines are bounded, and joins pans in one
 * direction into glides. Every move is one glide profile, so the view's speed and acceleration
 * are continuous.
 *
 * CONTRACT: signatures and constants are frozen (docs/design/vertical-video.md §9.0).
 */
import type { CameraLayout, Clip, Corner, CursorSample, CursorTrack, Project, ReframePace, ZoomSegment } from '../types'
import { cursorAt } from './cursor'
import { cursorMoves, PATH } from './cursorPath'
import { baseView, followGeometry, followLevel, layoutPhaseAt, outputSize, type ViewSize } from './layout'
import { clamp } from './math'
import { followApplies } from './reframeData'
import { scrollSessions } from './scroll'
import { anchorWeight, cameraAt, typingSessionsOf, ZOOM_MIN_SCALE, zoomSettingsOf, zoomStyleOf, zoomTargetScale } from './zoom'

/** A point in view space (normalised to the drawn recording). */
export interface Pt {
  x: number
  y: number
}

/** Constants every Movement preset shares (§5.18); seconds are output time unless noted. */
export const FOLLOW = {
  /** Attention sampling (s). */
  grid: 1 / 30,
  /** In view with a margin (views): short visits, cuts. */
  visible: 0.45,
  /** Where a click, typing or zoom must be at its time (views). */
  inView: 0.35,
  /** A new view fits what the next lookAhead seconds need. */
  lookAhead: 1.2,
  /** The first view looks this far ahead (s). */
  startAhead: 2.0,
  /** Smaller changes of centre are not made (views). */
  minChange: 0.1,
  /** Click attention window (s). */
  clickBefore: 0.4,
  clickAfter: 0.6,
  /** Attention after the last key or wheel event (source s). */
  typingTail: 0.3,
  scrollTail: 0.3,
  /** Longer moves are tracked, not aimed (source s). */
  maxAimedMove: 2.5,
  /** Lead when tracking (s). */
  trackAhead: 0.3,
  /** Pan duration bounds (s). */
  minPan: 0.5,
  maxPan: 1.5,
  /** Never faster, even to meet a click (views/s). */
  hardSpeed: 3,
  /** A shot is shown this long before the view anticipates the next (s). */
  minShown: 0.3,
  /** After the previous shot's last firm event (s). */
  settle: 0.1,
  /** Pans this close in the same direction join (s). */
  joinGap: 0.6,
  /** Ease in and out of a joined glide (s). */
  glideRamp: 0.5
} as const

/** One Movement preset: a column of the constants table (§5.18). */
export interface PaceParams {
  grid: number
  /** A target this close to the centre needs no move (views). */
  deadZone: number
  visible: number
  inView: number
  /** A soft target must stay out this long (s). */
  confirm: number
  lookAhead: number
  startAhead: number
  minChange: number
  /** Shorter soft visits that stay visible are dropped (s). */
  minHold: number
  clickBefore: number
  clickAfter: number
  typingTail: number
  scrollTail: number
  maxAimedMove: number
  trackAhead: number
  minPan: number
  maxPan: number
  /** Normal peak speed (views/s). */
  maxSpeed: number
  /** Normal peak acceleration (views/s²). */
  maxAccel: number
  hardSpeed: number
  /** Longest anticipation (s). */
  maxLead: number
  minShown: number
  settle: number
  joinGap: number
  glideRamp: number
}

/** The Movement presets: Calm, Balanced (the default) and Lively. */
export const PACE: Readonly<Record<ReframePace, Readonly<PaceParams>>> = Object.freeze({
  calm: Object.freeze({ ...FOLLOW, deadZone: 0.35, confirm: 0.7, minHold: 1.2, maxSpeed: 1.2, maxAccel: 4, maxLead: 0.5 }),
  balanced: Object.freeze({ ...FOLLOW, deadZone: 0.3, confirm: 0.5, minHold: 0.8, maxSpeed: 1.5, maxAccel: 5, maxLead: 0.6 }),
  lively: Object.freeze({ ...FOLLOW, deadZone: 0.25, confirm: 0.35, minHold: 0.5, maxSpeed: 2.0, maxAccel: 6, maxLead: 0.8 })
})

/** Zooms are this strong in a followed view (1 + (s − 1) × ZOOM_STRENGTH). */
export const ZOOM_STRENGTH = 0.5
/** At most this many output pixels per recorded pixel. */
export const MAX_MAGNIFY = 3

/**
 * What the view looks at (§5.6), in rule order after 'none'. followAttention's `kind` holds the
 * index in this list (0: no target, the view holds). Zooms, typing and clicks are firm.
 */
export const ATTENTION_KINDS = ['none', 'zoom', 'typing', 'click', 'shape', 'scroll', 'cursor'] as const
export type AttentionKind = (typeof ATTENTION_KINDS)[number]

/** A hold, a pan or a joined glide, back to back over output time (§5.9-5.11). */
export interface FollowSegment {
  o0: number
  o1: number
  from: Pt
  to: Pt
  ramp: number
  kind: 'hold' | 'pan' | 'glide'
}

/** A held view (§5.7): where it starts (output s), its centre, and why. */
export interface FollowShot {
  o0: number
  centre: Pt
  firm: boolean
  firstFirm: number
  lastFirm: number
  cut: boolean
  late: boolean
  kind: AttentionKind
}

export interface FollowPlan {
  total: number
  clips: readonly Clip[]
  /** Output second at which each clip starts. */
  clipOut: Float64Array
  /** Back to back from 0 to total; holds between moves. */
  segments: FollowSegment[]
  /** segments[i].o0, for the binary search. */
  starts: Float64Array
  /** For tests, diagnostics and the Later "why it moved" view. */
  shots: FollowShot[]
}

/** What the plan depends on (the drawn project: cropView, framed zooms). */
export type FollowProject = Pick<
  Project,
  'clips' | 'zooms' | 'layouts' | 'webcam' | 'hasWebcam' | 'style' | 'reframe' | 'width' | 'height' | 'zoomSettings' | 'duration' | 'shapes' | 'spotlights'
>

/**
 * The view's size and limits at the canonical frame (§5.12): `base` at the effective `level`,
 * the magnification `mag` (output px per recorded px), `fit` (the zoom level showing the whole
 * recording) and `cap` (the highest zoom level within MAX_MAGNIFY).
 */
export interface FollowLimits {
  base: ViewSize
  level: number
  mag: number
  fit: number
  cap: number
}

/** The glide profile (§5.10): progress 0..1 at u in 0..1, ramp r in (0, 0.5]; C², zero speed and acceleration at both ends. */
export function glide(u: number, r: number): number {
  if (!(u > 0)) return 0
  if (u >= 1) return 1
  const k = Number.isFinite(r) ? clamp(r, MIN_RAMP, 0.5) : 0.5
  if (u < k) return (k * ease3(u / k)) / (1 - k)
  if (u <= 1 - k) return (u - k / 2) / (1 - k)
  return 1 - (k * ease3((1 - u) / k)) / (1 - k)
}

/** The u at which glide(u, r) reaches progress p (bisection, 40 steps). */
export function glideInverse(p: number, r: number): number {
  if (!(p > 0)) return 0
  if (p >= 1) return 1
  let lo = 0
  let hi = 1
  for (let i = 0; i < 40; i++) {
    const mid = (lo + hi) / 2
    if (glide(mid, r) < p) lo = mid
    else hi = mid
  }
  return (lo + hi) / 2
}

/** Seconds of a pan of d views (§5.9): within minPan..maxPan by maxSpeed and maxAccel, never faster than hardSpeed. */
export function panDuration(d: number, pace: PaceParams = PACE.balanced): number {
  const v = Math.max(0, d)
  const D = clamp(Math.max(pace.minPan, (2 * v) / pace.maxSpeed, Math.sqrt((6 * v) / pace.maxAccel)), pace.minPan, pace.maxPan)
  return Math.max(D, (2 * v) / pace.hardSpeed)
}

/** The followed view's limits for `project` at its canonical frame, or null when it does not follow (cached per project). */
export function followLimits(project: FollowProject): FollowLimits | null {
  if (limitCache.has(project)) return limitCache.get(project) ?? null
  const frame = outputSize(project.style.aspectRatio, project.width, project.height, 1080)
  const limits = followApplies(project, frame.width, frame.height, project.width, project.height) ? limitsAt(project, project.width, project.height) : null
  limitCache.set(project, limits)
  return limits
}

/**
 * The view's limits at the canonical frame whether or not that frame follows: followLimits when
 * it does, else as if it did. A frame drawn at another shape than the project's own (followApplies
 * of the drawn frame) and the planner, which can be asked for any project, use these.
 */
export function viewLimits(project: FollowProject): FollowLimits {
  const limits = followLimits(project)
  if (limits) return limits
  let hit = anyLimitCache.get(project)
  if (!hit) anyLimitCache.set(project, (hit = limitsAt(project, project.width, project.height)))
  return hit
}

/** `zooms` as a followed view shows them (§5.12): half strength, capped, regions framed in the view, pull-backs to the whole recording. Memoised per array and limits. */
export function framedZooms(zooms: ZoomSegment[], limits: FollowLimits): ZoomSegment[] {
  const key = `${limits.base.w},${limits.base.h},${limits.fit},${limits.cap}`
  const hit = framedCache.get(zooms)
  if (hit && hit.key === key) return hit.out
  const out = zooms.map((z) => ({ ...z, scale: framedScale(z, limits) }))
  framedCache.set(zooms, { key, out })
  return out
}

/** The target of every grid sample (§5.6): output time, position, kind (ATTENTION_KINDS index) and event time (firm kinds). */
export function followAttention(
  project: FollowProject,
  track: CursorTrack
): { o: Float64Array; x: Float32Array; y: Float32Array; kind: Uint8Array; event: Float64Array } {
  const pace = paceOf(project)
  const grid = gridOf(project, pace.grid)
  const att = attentionOn(grid, project, cleanTrack(track), framedZooms(project.zooms, viewLimits(project)), pace)
  return { o: grid.o, ...att }
}

/** The follow plan of the drawn project and track (uncached). */
export function planFollow(project: FollowProject, track: CursorTrack): FollowPlan {
  const pace = paceOf(project)
  const input = cleanTrack(track)
  const limits = viewLimits(project)
  const framed = framedZooms(project.zooms, limits)
  const grid = gridOf(project, pace.grid)
  const att = attentionOn(grid, project, input, framed, pace)
  const view = viewsOn(grid, project, limits, framed)
  const noData = !input.valid || (input.samples.length === 0 && input.clicks.length === 0)
  const rest = restPoint(project)
  const plan = new Planner(grid, pace, att, view, noData ? rest : null)
  const shots = plan.shortShots(plan.shots(rest))
  const moves = plan.joined(plan.pans(shots))
  const segments = segmentsOf(moves, shots[0].centre, grid.total)
  return {
    total: grid.total,
    clips: grid.clips,
    clipOut: grid.clipOut,
    segments,
    starts: Float64Array.from(segments, (s) => s.o0),
    shots: shots.map((s) => ({ o0: s.o0, centre: s.centre, firm: s.firm, firstFirm: s.firstFirm, lastFirm: s.lastFirm, cut: s.cut, late: s.late, kind: ATTENTION_KINDS[s.kind] }))
  }
}

/** The follow plan, cached by the identities and values it depends on (§8.1). */
export function followPlanFor(project: FollowProject, track: CursorTrack): FollowPlan {
  const refs = [project.clips, project.zooms, project.layouts, project.shapes, project.spotlights, track.clicks, track.typing, track.scrolls]
  const key = JSON.stringify([
    project.width,
    project.height,
    project.duration,
    project.style.aspectRatio,
    project.style.padding,
    project.webcam.show,
    project.hasWebcam,
    project.reframe ?? null,
    project.zoomSettings ?? null,
    track.valid
  ])
  let entries = planCache.get(track.samples)
  if (!entries) planCache.set(track.samples, (entries = []))
  const hit = entries.find((e) => e.key === key && e.refs.every((r, i) => r === refs[i]))
  if (hit) return hit.plan
  const plan = planFollow(project, track)
  entries.unshift({ refs, key, plan })
  if (entries.length > PLAN_CACHE_SIZE) entries.pop()
  return plan
}

/**
 * The view's centre at source time `t` (view space): `at` (default `t`) picks the clip, so a
 * motion-blur sub-frame past a clip's end samples that clip's last view (§5.4). Stateless, O(log n).
 */
export function followCentre(plan: FollowPlan, t: number, at?: number): { x: number; y: number } {
  const clips = plan.clips
  const when = at ?? t
  // The clip of `at`: the one containing it (the last one its end too), the next one in a cut.
  let lo = 0
  let hi = clips.length - 1
  let c = 0
  while (lo <= hi) {
    const mid = (lo + hi) >> 1
    if (clips[mid].start <= when) {
      c = mid
      lo = mid + 1
    } else {
      hi = mid - 1
    }
  }
  if (!(when < clips[c].end) && when >= clips[c].start && c < clips.length - 1) c++
  const clip = clips[c]
  const s = clamp(t, clip.start, clip.end)
  const o = plan.clipOut[c] + (s - clip.start) / clip.speed
  // At a clip's end the view is that clip's last one, never the next clip's first.
  const strict = s >= clip.end && c < clips.length - 1
  const starts = plan.starts
  let i = 0
  lo = 0
  hi = starts.length - 1
  while (lo <= hi) {
    const mid = (lo + hi) >> 1
    if (strict ? starts[mid] < o : starts[mid] <= o) {
      i = mid
      lo = mid + 1
    } else {
      hi = mid - 1
    }
  }
  const seg = plan.segments[i]
  if (seg.kind === 'hold' || !(seg.o1 > seg.o0)) return { x: seg.from.x, y: seg.from.y }
  const k = glide((o - seg.o0) / (seg.o1 - seg.o0), seg.ramp)
  return { x: seg.from.x + (seg.to.x - seg.from.x) * k, y: seg.from.y + (seg.to.y - seg.from.y) * k }
}

/* ---------- limits and framed zooms (§5.12) ---------- */

/** The narrowest ramp a glide takes (r = 0 has no ease). */
const MIN_RAMP = 1e-6

/** y³ − y⁴/2: the glide's ease in, zero speed and acceleration at 0, unit speed and zero acceleration at 1. */
const ease3 = (y: number): number => y * y * y - (y * y * y * y) / 2

const limitCache = new WeakMap<object, FollowLimits | null>()
const anyLimitCache = new WeakMap<object, FollowLimits>()
const framedCache = new WeakMap<ZoomSegment[], { key: string; out: ZoomSegment[] }>()

/** The limits of a followed view of a vw x vh recording at its canonical frame (outputSize at 1080), in the default layout. */
function limitsAt(project: FollowProject, vw: number, vh: number): FollowLimits {
  const frame = outputSize(project.style.aspectRatio, vw, vh, 1080)
  const slot = followGeometry('default', project, frame.width, frame.height, vw, vh).slot
  const level = followLevel(project, vw, vh)
  const base = baseView(slot, vw, vh, level)
  const mag = slot.w / (base.w * vw)
  return { base, level, mag, fit: Math.min(base.w, base.h), cap: Math.max(1, MAX_MAGNIFY / (Number.isFinite(mag) && mag > 0 ? mag : 1)) }
}

/** The level a framed zoom moves to: half strength up to `cap`; a region framed in the view; a pull-back 0.5 showing the whole recording. */
function framedScale(z: ZoomSegment, { base, fit, cap }: FollowLimits): number {
  const f = z.focus
  if (f.mode === 'region') {
    const s = Math.min(base.w / Math.max(Math.abs(f.w), 1e-6), base.h / Math.max(Math.abs(f.h), 1e-6))
    return Number.isFinite(s) ? clamp(s, fit, cap) : 1
  }
  const s = zoomTargetScale(z)
  if (s >= 1) return Math.min(1 + (s - 1) * ZOOM_STRENGTH, cap)
  return fit + ((1 - fit) * (s - ZOOM_MIN_SCALE)) / (1 - ZOOM_MIN_SCALE)
}

const paceOf = (project: FollowProject): PaceParams => PACE[project.reframe?.pace ?? 'balanced'] ?? PACE.balanced

/** Where the view rests when nothing calls it elsewhere (view space): the setting, else the centre. */
function restPoint(project: FollowProject): Pt {
  const r = project.reframe?.rest
  return r && Number.isFinite(r.x) && Number.isFinite(r.y) ? { x: clamp(r.x, 0, 1), y: clamp(r.y, 0, 1) } : { x: 0.5, y: 0.5 }
}

/* ---------- input (§5.16) ---------- */

const finiteT = (e: { t: number }): boolean => Number.isFinite(e.t)
const finitePoint = (e: { t: number; x: number; y: number }): boolean => Number.isFinite(e.t) && Number.isFinite(e.x) && Number.isFinite(e.y)
const inUnit = (x: number, y: number): boolean => x >= 0 && x <= 1 && y >= 0 && y <= 1

const cleanArrays = new WeakMap<object, unknown[]>()

/** `list` without unusable entries, sorted by `t` (the same array when it already is). Cached per array. */
function cleaned<T extends { t: number }>(list: T[], usable: (e: T) => boolean): T[] {
  const hit = cleanArrays.get(list)
  if (hit) return hit as T[]
  let ok = true
  for (let i = 0; i < list.length && ok; i++) ok = usable(list[i]) && (i === 0 || list[i - 1].t <= list[i].t)
  const out = ok ? list : list.filter(usable).sort((a, b) => a.t - b.t)
  cleanArrays.set(list, out)
  return out
}

const cleanTracks = new WeakMap<CursorTrack, CursorTrack>()

/**
 * The track the planner reads: samples, clicks, scrolls and typing with non-finite values left
 * out and sorted (a hand-edited cursor.json), each the same array when it needs nothing, so the
 * plan equals the sorted, finite track's and cursorMoves keeps its cache.
 */
function cleanTrack(track: CursorTrack): CursorTrack {
  const hit = cleanTracks.get(track)
  if (hit) return hit
  const samples = cleaned(track.samples, finitePoint)
  const clicks = cleaned(track.clicks, finitePoint)
  const scrolls = track.scrolls && cleaned(track.scrolls, finitePoint)
  const typing = track.typing && cleaned(track.typing, (b) => finiteT(b) && Number.isFinite(b.end))
  const same = samples === track.samples && clicks === track.clicks && scrolls === track.scrolls && typing === track.typing
  const out = same ? track : { ...track, samples, clicks, ...(scrolls ? { scrolls } : {}), ...(typing ? { typing } : {}) }
  cleanTracks.set(track, out)
  return out
}

/* ---------- the grid (§5.4) ---------- */

interface Grid {
  clips: readonly Clip[]
  /** Output second at which each clip starts. */
  clipOut: Float64Array
  total: number
  g: number
  n: number
  /** Output and source time of each sample. */
  o: Float64Array
  s: Float64Array
  /** Its clip, and its clip piece (the clips between two cuts). */
  clip: Int32Array
  piece: Int32Array
  /** 1 on the first sample after a cut. */
  cutStart: Uint8Array
  /** Output times of the cuts, ascending. */
  cuts: number[]
}

function gridOf(project: FollowProject, g: number): Grid {
  const clips: readonly Clip[] = project.clips.length ? project.clips : [{ id: '', start: 0, end: project.duration, speed: 1 }]
  const clipOut = new Float64Array(clips.length)
  const isCut = new Uint8Array(clips.length)
  const cuts: number[] = []
  let acc = 0
  clips.forEach((c, i) => {
    clipOut[i] = acc
    if (i > 0 && Math.abs(c.start - clips[i - 1].end) > CUT_EPS) {
      isCut[i] = 1
      cuts.push(acc)
    }
    acc += (c.end - c.start) / c.speed
  })
  const total = acc
  const n = Math.max(1, Math.ceil(total / g - 1e-9) + 1)
  const o = new Float64Array(n)
  const s = new Float64Array(n)
  const clip = new Int32Array(n)
  const piece = new Int32Array(n)
  const cutStart = new Uint8Array(n)
  let c = 0
  let p = 0
  for (let k = 0; k < n; k++) {
    const t = k * g
    let crossed = false
    while (c < clips.length - 1 && t >= clipOut[c + 1] - 1e-9) {
      c++
      if (isCut[c]) {
        p++
        crossed = true
      }
    }
    const cl = clips[c]
    o[k] = t
    s[k] = Math.min(cl.start + (t - clipOut[c]) * cl.speed, cl.end)
    clip[k] = c
    piece[k] = p
    if (crossed) cutStart[k] = 1
  }
  return { clips, clipOut, total, g, n, o, s, clip, piece, cutStart, cuts }
}

/** A clip starting this far (seconds) from where the previous one ended starts after a cut; nearer, it is a speed change. */
const CUT_EPS = 1e-6

/** Index of the last clip starting at or before source time `t` (-1 before the first). */
function clipBefore(clips: readonly Clip[], t: number): number {
  let lo = 0
  let hi = clips.length - 1
  let found = -1
  while (lo <= hi) {
    const mid = (lo + hi) >> 1
    if (clips[mid].start <= t) {
      found = mid
      lo = mid + 1
    } else {
      hi = mid - 1
    }
  }
  return found
}

/** Output time at which source time `t` is shown, or null when it was cut (sourceToOutput, by binary search). */
function outputAt(grid: Grid, t: number): number | null {
  const i = clipBefore(grid.clips, t)
  if (i < 0) return null
  const c = grid.clips[i]
  if (t < c.end || (i === grid.clips.length - 1 && Math.abs(t - c.end) < 1e-9)) return grid.clipOut[i] + (t - c.start) / c.speed
  return null
}

/** Output time from which source time `t` is shown: its own, or the start of the next kept part when it was cut (the end past the last). */
function outputFrom(grid: Grid, t: number): number {
  const o = outputAt(grid, t)
  if (o !== null) return o
  const i = clipBefore(grid.clips, t)
  return i + 1 < grid.clips.length ? grid.clipOut[i + 1] : grid.total
}

/* ---------- attention (§5.6) ---------- */

const K_ZOOM = 1
const K_TYPING = 2
const K_CLICK = 3
const K_SHAPE = 4
const K_SCROLL = 5
const K_CURSOR = 6
/** Zooms, typing and clicks are firm: they set deadlines and skip the confirmation. */
const isFirm = (kind: number): boolean => kind >= K_ZOOM && kind <= K_CLICK

interface Attention {
  x: Float32Array
  y: Float32Array
  kind: Uint8Array
  event: Float64Array
}

/** A zoom as attention reads it: its aim (fixed or region), or its anchor while it holds it (cursor focus); pull-backs have none. */
interface ZoomAim {
  start: number
  end: number
  seg: ZoomSegment
  event: number
  aim: Pt | null
  anchored: boolean
}

function zoomAims(grid: Grid, framed: ZoomSegment[]): ZoomAim[] {
  const out: ZoomAim[] = []
  for (const z of framed.filter((z) => z.end > z.start).sort((a, b) => a.start - b.start)) {
    // As the camera plan: a zoom entirely inside an earlier one is ignored, an overlapped one lasts until the next starts.
    const last = out[out.length - 1]
    if (last && !(z.end > last.end)) continue
    const f = z.focus
    const aim = f.mode === 'fixed' ? { x: f.x, y: f.y } : f.mode === 'region' ? { x: f.x + f.w / 2, y: f.y + f.h / 2 } : null
    const pullBack = f.mode !== 'region' && z.scale < 1
    out.push({ start: z.start, end: z.end, seg: z, event: outputFrom(grid, z.start), aim: pullBack ? null : aim, anchored: !pullBack && f.mode === 'cursor' && !!z.anchor })
  }
  return out
}

/** Where a shape or region spotlight draws the eye: an arrow's head, a line's middle, a box's centre. */
interface ShapeAim {
  start: number
  end: number
  x: number
  y: number
}

function shapeAims(project: FollowProject): ShapeAim[] {
  const out: ShapeAim[] = []
  const finite = (s: { start: number; end: number; x: number; y: number; w: number; h: number }): boolean =>
    [s.start, s.end, s.x, s.y, s.w, s.h].every(Number.isFinite)
  for (const s of project.shapes ?? []) {
    if (s.kind === 'blur' || s.kind === 'pixelate' || !finite(s)) continue
    const k = s.kind === 'arrow' ? 1 : 0.5
    out.push({ start: s.start, end: s.end, x: s.x + s.w * k, y: s.y + s.h * k })
  }
  for (const s of project.spotlights ?? []) {
    if (s.mode !== 'region' || !finite(s)) continue
    out.push({ start: s.start, end: s.end, x: s.x + s.w / 2, y: s.y + s.h / 2 })
  }
  return out.sort((a, b) => a.start - b.start)
}

/**
 * Where the cursor is going at each sample (§5.6 cursor intent), read with increasing source
 * times: in a rest, the rest's position; in a move no longer than maxAimedMove, its destination;
 * in a longer move, before the first rest and after the last, the recorded cursor trackAhead ahead.
 */
function cursorIntent(track: CursorTrack, aspect: number, pace: PaceParams): (s: number, speed: number, clipEnd: number) => Pt | null {
  const samples = track.samples
  if (samples.length === 0) return () => null
  const A = Number.isFinite(aspect) && aspect > 0 ? aspect : 16 / 9
  const moves = cursorMoves(track, A)
  const first = firstRest(samples, A)
  const lastEnd = moves.length ? restEnd(samples, moves[moves.length - 1].i1, A) : -Infinity
  const tracked = (s: number, speed: number, clipEnd: number): Pt | null => cursorAt(samples, Math.min(s + pace.trackAhead * speed, clipEnd))
  let m = -1
  return (s, speed, clipEnd) => {
    if (moves.length === 0) return first && s >= first.t0 && s <= first.t1 ? first.at : tracked(s, speed, clipEnd)
    while (m + 1 < moves.length && moves[m + 1].t0 <= s) m++
    if (m < 0) return first && s >= first.t0 ? moves[0].from : tracked(s, speed, clipEnd)
    const mv = moves[m]
    if (s <= mv.t1) return mv.t1 - mv.t0 <= pace.maxAimedMove ? mv.to : tracked(s, speed, clipEnd)
    if (m < moves.length - 1 || s <= lastEnd) return mv.to
    return tracked(s, speed, clipEnd)
  }
}

const near = (p: { x: number; y: number }, q: { x: number; y: number }, A: number): boolean => {
  const dx = (p.x - q.x) * A
  const dy = p.y - q.y
  return dx * dx + dy * dy <= PATH.restRadius * PATH.restRadius
}

/** The first rest of `samples` as cursorMoves finds rests (its first and last time, and where it is), or null. */
function firstRest(samples: CursorSample[], A: number): { t0: number; t1: number; at: Pt } | null {
  for (let i = 0; i < samples.length; ) {
    let j = i
    while (j + 1 < samples.length && near(samples[j + 1], samples[i], A)) j++
    if (samples[j].t - samples[i].t >= PATH.restMin - 1e-9) return { t0: samples[i].t, t1: samples[j].t, at: { x: samples[j].x, y: samples[j].y } }
    i++
  }
  return null
}

/** When the rest starting at sample `i` ends (as cursorMoves walks it). */
function restEnd(samples: CursorSample[], i: number, A: number): number {
  let j = i
  while (j + 1 < samples.length && near(samples[j + 1], samples[i], A)) j++
  return samples[j].t
}

function attentionOn(grid: Grid, project: FollowProject, track: CursorTrack, framed: ZoomSegment[], pace: PaceParams): Attention {
  const { n, o, s, clip } = grid
  const x = new Float32Array(n).fill(Number.NaN)
  const y = new Float32Array(n).fill(Number.NaN)
  const kind = new Uint8Array(n)
  const event = new Float64Array(n).fill(Number.NaN)
  const valid = track.valid
  const zooms = zoomAims(grid, framed)
  const typing = valid ? typingSessionsOf(track, zoomSettingsOf(project).auto).map((t) => ({ ...t, event: outputFrom(grid, t.t0) })) : []
  const clicks = valid
    ? track.clicks
        .filter((c) => inUnit(c.x, c.y))
        .map((c) => ({ x: c.x, y: c.y, o: outputAt(grid, c.t) }))
        .filter((c): c is { x: number; y: number; o: number } => c.o !== null)
        .sort((a, b) => a.o - b.o)
    : []
  const shapes = shapeAims(project)
  const wheel = valid && track.scrolls ? track.scrolls : []
  const scrolls = scrollSessions(wheel)
  const intent = valid ? cursorIntent(track, project.width / project.height, pace) : null
  let zi = -1
  let ti = -1
  let ci = -1
  let si = -1
  let sj = -1
  let wi = -1
  let k = 0
  // A target outside the recording gives none from its rule: the next rule is asked.
  const set = (px: number, py: number, kd: number, ev = Number.NaN): boolean => {
    if (!inUnit(px, py)) return false
    x[k] = px
    y[k] = py
    kind[k] = kd
    event[k] = ev
    return true
  }
  for (k = 0; k < n; k++) {
    const t = s[k]
    // 1. A zoom: its aim, or its anchor while it holds it.
    while (zi + 1 < zooms.length && zooms[zi + 1].start <= t) zi++
    const z = zi >= 0 ? zooms[zi] : null
    if (z && t < z.end) {
      const a = z.aim ?? (z.anchored && anchorWeight(z.seg, t) >= 0.5 ? z.seg.anchor! : null)
      if (a && set(a.x, a.y, K_ZOOM, z.event)) continue
    }
    // 2. Typing: the place typed into, until typingTail after the last key.
    while (ti + 1 < typing.length && typing[ti + 1].t0 <= t) ti++
    const ty = ti >= 0 ? typing[ti] : null
    if (ty && t <= ty.t1 + pace.typingTail && set(ty.place.x, ty.place.y, K_TYPING, ty.event)) continue
    // 3. A click, from clickBefore before it to clickAfter after it (output time); the latest wins.
    while (ci + 1 < clicks.length && clicks[ci + 1].o - pace.clickBefore <= o[k]) ci++
    const cl = ci >= 0 ? clicks[ci] : null
    if (cl && o[k] <= cl.o + pace.clickAfter && set(cl.x, cl.y, K_CLICK, cl.o)) continue
    // 4. A shape or region spotlight shown now; the latest start wins.
    while (si + 1 < shapes.length && shapes[si + 1].start <= t) si++
    let shown = false
    for (let i = si; i >= 0 && !shown; i--) if (t < shapes[i].end) shown = set(shapes[i].x, shapes[i].y, K_SHAPE)
    if (shown) continue
    // 5. Scrolling: where the wheel last turned.
    while (sj + 1 < scrolls.length && scrolls[sj + 1].start <= t) sj++
    while (wi + 1 < wheel.length && wheel[wi + 1].t <= t) wi++
    if (sj >= 0 && wi >= 0 && t <= scrolls[sj].end + pace.scrollTail && set(wheel[wi].x, wheel[wi].y, K_SCROLL)) continue
    // 6. Where the cursor is going.
    if (intent) {
      const c = grid.clips[clip[k]]
      const p = intent(t, c.speed, c.end)
      if (p) set(p.x, p.y, K_CURSOR)
    }
  }
  return { x, y, kind, event }
}

/* ---------- the view the planner measures in (§5.5) ---------- */

interface Views {
  w: Float64Array
  h: Float64Array
}

function viewsOn(grid: Grid, project: FollowProject, limits: FollowLimits, framed: ZoomSegment[]): Views {
  const { n, s } = grid
  const vw = project.width
  const vh = project.height
  const frame = outputSize(project.style.aspectRatio, vw, vh, 1080)
  const bases = new Map<string, ViewSize>()
  const baseOf = (layout: CameraLayout, corner: Corner | undefined): ViewSize => {
    const key = `${layout}|${corner ?? ''}`
    let b = bases.get(key)
    if (!b) bases.set(key, (b = baseView(followGeometry(layout, project, frame.width, frame.height, vw, vh, corner).slot, vw, vh, limits.level)))
    return b
  }
  const style = zoomStyleOf(project)
  const unit = { cx: 0.5, cy: 0.5, w: limits.base.w, h: limits.base.h }
  const w = new Float64Array(n)
  const h = new Float64Array(n)
  const shown = project.webcam.show
  for (let k = 0; k < n; k++) {
    let b = baseOf('default', undefined)
    if (shown) {
      const p = layoutPhaseAt(project, s[k])
      const to = baseOf(p.to, p.toCorner)
      // During a change, the smaller of the two views, so the plan stays safe.
      if (p.progress < 1 && (p.from !== p.to || p.fromCorner !== p.toCorner)) {
        const from = baseOf(p.from, p.fromCorner)
        b = { w: Math.min(from.w, to.w), h: Math.min(from.h, to.h) }
      } else {
        b = to
      }
    }
    const z = framed.length ? Math.max(limits.fit, cameraAt(framed, s[k], null, style, unit).scale) : 1
    w[k] = Math.min(1, b.w / z)
    h[k] = Math.min(1, b.h / z)
  }
  return { w, h }
}

/* ---------- shots, pans and glides (§5.7-5.10) ---------- */

/** A shot while planning: FollowShot, with the sample it starts at and its first firm event's sample and place. */
interface Shot {
  o0: number
  k0: number
  centre: Pt
  firm: boolean
  firstFirm: number
  lastFirm: number
  /** The first firm event's target and sample (its deadline, §5.9). */
  firstAt: Pt | null
  firstK: number
  cut: boolean
  late: boolean
  kind: number
}

/** A pan, a joined glide, or a jump at a cut, in output time. */
interface Move {
  o0: number
  o1: number
  from: Pt
  to: Pt
  ramp: number
  kind: 'pan' | 'glide' | 'jump'
}

const GLIDE_RAMP = 0.5
/** A joined glide stays within this many views of every soft target. */
const GLIDE_SOFT = 0.5

class Planner {
  readonly n: number

  constructor(
    readonly grid: Grid,
    readonly pace: PaceParams,
    readonly att: Attention,
    readonly view: Views,
    /** Without cursor data: where the view goes back to when nothing calls it elsewhere (a soft target). */
    readonly rest: Pt | null
  ) {
    this.n = grid.n
  }

  has(k: number): boolean {
    return !Number.isNaN(this.att.x[k]) || this.rest !== null
  }

  tx(k: number): number {
    const v = this.att.x[k]
    return Number.isNaN(v) ? this.rest!.x : v
  }

  ty(k: number): number {
    const v = this.att.y[k]
    return Number.isNaN(v) ? this.rest!.y : v
  }

  firm(k: number): boolean {
    return isFirm(this.att.kind[k])
  }

  /** Distance in views at sample k: the larger of the two axes; an axis whose view is the whole recording counts 0. */
  dist(k: number, ax: number, ay: number, b: Pt): number {
    const w = this.view.w[k]
    const h = this.view.h[k]
    const dx = w >= 1 ? 0 : Math.abs(ax - b.x) / w
    const dy = h >= 1 ? 0 : Math.abs(ay - b.y) / h
    return Math.max(dx, dy)
  }

  /** The sample at output time `o`. */
  sampleAt(o: number): number {
    return clamp(Math.round(o / this.grid.g), 0, this.n - 1)
  }

  /** A centre kept where the view at sample k shows only the recording (0.5 on an axis it covers). */
  clampAt(k: number, x: number, y: number): Pt {
    const w = this.view.w[k]
    const h = this.view.h[k]
    return { x: w >= 1 ? 0.5 : clamp(x, w / 2, 1 - w / 2), y: h >= 1 ? 0.5 : clamp(y, h / 2, 1 - h / 2) }
  }

  /**
   * The centre of a view covering what the next `span` seconds need from sample k on (§5.7 fit):
   * targets in one clip piece, stopping before one that would spread them wider than twice the
   * dead zone on either axis; the midpoint, clamped. Null without any target.
   */
  fit(k: number, span: number): { centre: Pt; first: number } | null {
    const { o, piece } = this.grid
    const dz2 = 2 * this.pace.deadZone
    let x0 = Infinity
    let x1 = -Infinity
    let y0 = Infinity
    let y1 = -Infinity
    let first = -1
    for (let j = k; j < this.n && o[j] - o[k] <= span + 1e-9 && piece[j] === piece[k]; j++) {
      if (!this.has(j)) continue
      const x = this.tx(j)
      const y = this.ty(j)
      const nx0 = Math.min(x0, x)
      const nx1 = Math.max(x1, x)
      const ny0 = Math.min(y0, y)
      const ny1 = Math.max(y1, y)
      const w = this.view.w[j]
      const h = this.view.h[j]
      if (first >= 0 && ((w < 1 && nx1 - nx0 > dz2 * w) || (h < 1 && ny1 - ny0 > dz2 * h))) break
      x0 = nx0
      x1 = nx1
      y0 = ny0
      y1 = ny1
      if (first < 0) first = j
    }
    if (first < 0) return null
    return { centre: this.clampAt(k, (x0 + x1) / 2, (y0 + y1) / 2), first }
  }

  /** Whether a soft target at k that left the comfortable region stays out for `confirm` (§5.7 step 4). */
  confirmed(k: number, centre: Pt): boolean {
    const { piece } = this.grid
    const end = k + Math.round(this.pace.confirm / this.grid.g)
    for (let j = k; j <= end && j < this.n && piece[j] === piece[k]; j++) {
      if (!this.has(j)) continue
      const inside = this.dist(j, this.tx(j), this.ty(j), centre) <= this.pace.deadZone
      if (this.firm(j)) return !inside
      if (inside) return false
    }
    return true
  }

  /** Marks a firm event at sample k as one `shot` shows. */
  markFirm(shot: Shot, k: number): void {
    const e = this.att.event[k]
    shot.firm = true
    shot.lastFirm = Math.max(shot.lastFirm, e)
    if (shot.firstAt === null) {
      shot.firstFirm = e
      shot.firstAt = { x: this.tx(k), y: this.ty(k) }
      shot.firstK = k
    }
  }

  newShot(o0: number, k0: number, centre: Pt, kind: number, cut: boolean): Shot {
    return { o0, k0, centre, firm: false, firstFirm: -Infinity, lastFirm: -Infinity, firstAt: null, firstK: -1, cut, late: false, kind }
  }

  /** The output time of the latest cut at or before `o` (-Infinity when none). */
  cutBefore(o: number): number {
    let c = -Infinity
    for (const cut of this.grid.cuts) {
      if (cut > o + 1e-9) break
      c = cut
    }
    return c
  }

  /** The first cut strictly inside (a, b), or null. */
  cutIn(a: number, b: number): number | null {
    for (const cut of this.grid.cuts) if (cut > a + 1e-9 && cut < b - 1e-9) return cut
    return null
  }

  /** The held views (§5.7): shot 0 looks startAhead ahead (else the rest point), then each sample may start a new one. */
  shots(rest: Pt): Shot[] {
    const { pace } = this
    const { o, cutStart } = this.grid
    const start = this.fit(0, pace.startAhead)
    let cur = this.newShot(0, 0, start ? start.centre : this.clampAt(0, rest.x, rest.y), start ? this.att.kind[start.first] : 0, false)
    const shots = [cur]
    for (let k = 0; k < this.n; k++) {
      if (!this.has(k)) continue
      const ax = this.tx(k)
      const ay = this.ty(k)
      const firm = this.firm(k)
      // 1. After a cut the view changes at once when what it needs is no longer visible.
      if (cutStart[k] && this.dist(k, ax, ay, cur.centre) > pace.visible) {
        cur = this.newShot(this.cutBefore(o[k]), k, this.fit(k, pace.lookAhead)!.centre, this.att.kind[k], true)
        if (firm) this.markFirm(cur, k)
        shots.push(cur)
        continue
      }
      // 3. Comfortable.
      if (this.dist(k, ax, ay, cur.centre) <= pace.deadZone) {
        if (firm) this.markFirm(cur, k)
        continue
      }
      // 4. A soft target must stay out (a flick, an overshoot does not).
      if (!firm && !this.confirmed(k, cur.centre)) continue
      // 5. The new view, unless it is no real change (held at the recording's edge).
      const next = this.fit(k, pace.lookAhead)
      if (!next || this.dist(k, next.centre.x, next.centre.y, cur.centre) < pace.minChange) {
        if (firm) this.markFirm(cur, k)
        continue
      }
      // 6. A new shot.
      cur = this.newShot(o[k], k, next.centre, this.att.kind[k], false)
      if (firm) this.markFirm(cur, k)
      shots.push(cur)
    }
    return shots
  }

  /**
   * Short shots (§5.8): a soft shot shorter than minHold whose targets all stay visible from the
   * previous view is dropped; then shots whose centres are less than minChange apart merge.
   */
  shortShots(shots: Shot[]): Shot[] {
    const { pace } = this
    const kept = [shots[0]]
    for (let i = 1; i < shots.length; i++) {
      const b = shots[i]
      const a = kept[kept.length - 1]
      const next = shots[i + 1]
      const end = next ? next.o0 : this.grid.total
      if (!b.firm && !b.cut && end - b.o0 < pace.minHold && this.allWithin(b.k0, next ? next.k0 : this.n, a.centre, pace.visible)) continue
      kept.push(b)
    }
    const out = [kept[0]]
    for (let i = 1; i < kept.length; i++) {
      const b = kept[i]
      const a = out[out.length - 1]
      if (this.dist(b.k0, b.centre.x, b.centre.y, a.centre) < pace.minChange) {
        if (b.firm) {
          a.firm = true
          a.lastFirm = Math.max(a.lastFirm, b.lastFirm)
          if (a.firstAt === null) {
            a.firstFirm = b.firstFirm
            a.firstAt = b.firstAt
            a.firstK = b.firstK
          }
        }
        continue
      }
      out.push(b)
    }
    return out
  }

  /** Whether every target of samples [k0, k1) lies within `limit` views of `centre`. */
  allWithin(k0: number, k1: number, centre: Pt, limit: number): boolean {
    for (let j = k0; j < k1 && j < this.n; j++) if (this.has(j) && this.dist(j, this.tx(j), this.ty(j), centre) > limit) return false
    return true
  }

  /**
   * The pans between shots (§5.9): each starts when its shot does (after the previous pan and the
   * latest cut) and lasts panDuration; a firm shot's event must be comfortably in view at its
   * time, so the pan leaves early (anticipates) or speeds up (hurries) up to hardSpeed, else the
   * shot is late. A pan never crosses a cut: it ends there, or the view changes at the cut. A pan
   * that could only start after the next shot began is dropped.
   */
  pans(shots: Shot[]): Move[] {
    const { pace } = this
    const g = this.grid.g
    const moves: Move[] = []
    let a = shots[0]
    let prevEnd = 0
    for (let i = 1; i < shots.length; i++) {
      const b = shots[i]
      if (b.cut) {
        moves.push({ o0: b.o0, o1: b.o0, from: b.centre, to: b.centre, ramp: GLIDE_RAMP, kind: 'jump' })
        prevEnd = Math.max(prevEnd, b.o0)
        a = b
        continue
      }
      const d = this.dist(this.sampleAt(b.o0), b.centre.x, b.centre.y, a.centre)
      if (!(d > 1e-9)) {
        a = b
        continue
      }
      let D = panDuration(d, pace)
      const floor = Math.max(prevEnd, this.cutBefore(b.o0))
      let t0 = Math.max(b.o0, floor)
      // A firm event before the shot could start (a zoom ending over typing already under way) sets no deadline.
      if (b.firm && b.firstAt && b.firstFirm >= b.o0 - g - 1e-9) {
        const e = b.firstFirm
        const delta = this.dist(b.firstK, b.firstAt.x, b.firstAt.y, b.centre)
        const u = glideInverse(clamp(1 - (pace.inView - delta) / d, 0, 1), GLIDE_RAMP)
        if (t0 + u * D > e + 1e-9) {
          t0 = Math.max(e - u * D, b.o0 - pace.maxLead, floor, a.lastFirm + pace.settle, a.o0 + pace.minShown)
          if (t0 + u * D > e + 1e-9) {
            D = Math.max(u > 0 ? (e - t0) / u : 0, (2 * d) / pace.hardSpeed, pace.minPan)
            b.late = t0 + u * D > e + 1e-9
          }
        }
      }
      // Never across a cut: end there when that is not too short or fast, else change at the cut.
      const cut = this.cutIn(t0, t0 + D)
      if (cut !== null) {
        if (cut - t0 >= pace.minPan / 2 && (2 * d) / (cut - t0) <= pace.hardSpeed + 1e-9) {
          D = cut - t0
        } else {
          moves.push({ o0: cut, o1: cut, from: b.centre, to: b.centre, ramp: GLIDE_RAMP, kind: 'jump' })
          prevEnd = cut
          a = b
          continue
        }
      }
      // Backlog: the view would only leave after the next shot began; go straight on to that one.
      const c = shots[i + 1]
      if (c && t0 >= c.o0) continue
      moves.push({ o0: t0, o1: t0 + D, from: a.centre, to: b.centre, ramp: GLIDE_RAMP, kind: 'pan' })
      prevEnd = t0 + D
      a = b
    }
    return moves
  }

  /** Consecutive pans in the same direction, close together and on one side of every cut, joined into one glide where it keeps every target in view (§5.10). */
  joined(moves: Move[]): Move[] {
    const { pace } = this
    const out: Move[] = []
    for (const m of moves) {
      const p = out[out.length - 1]
      if (m.kind === 'pan' && p && p.kind !== 'jump' && m.o0 - p.o1 <= pace.joinGap + 1e-9 && this.cutIn(p.o0, m.o1) === null && sameWay(p, m)) {
        const g: Move = { o0: p.o0, o1: m.o1, from: p.from, to: m.to, ramp: Math.min(0.5, pace.glideRamp / (m.o1 - p.o0)), kind: 'glide' }
        if (this.keeps(g)) {
          out[out.length - 1] = g
          continue
        }
      }
      out.push(m)
    }
    return out
  }

  /** Whether glide `g` keeps every target of its time within GLIDE_SOFT views (soft) and inView (firm). */
  keeps(g: Move): boolean {
    const { o } = this.grid
    for (let k = Math.max(0, Math.ceil(g.o0 / this.grid.g - 1e-9)); k < this.n && o[k] <= g.o1 + 1e-9; k++) {
      if (!this.has(k)) continue
      const p = moveAt(g, o[k])
      if (this.dist(k, this.tx(k), this.ty(k), p) > (this.firm(k) ? this.pace.inView : GLIDE_SOFT)) return false
    }
    return true
  }
}

/** Whether two moves go the same way on both axes (neither reverses the other). */
const sameWay = (p: Move, q: Move): boolean =>
  Math.sign(p.to.x - p.from.x) * Math.sign(q.to.x - q.from.x) >= 0 && Math.sign(p.to.y - p.from.y) * Math.sign(q.to.y - q.from.y) >= 0

/** Where a pan or glide is at output time `o`. */
function moveAt(m: Move, o: number): Pt {
  const k = m.o1 > m.o0 ? glide((o - m.o0) / (m.o1 - m.o0), m.ramp) : 1
  return { x: m.from.x + (m.to.x - m.from.x) * k, y: m.from.y + (m.to.y - m.from.y) * k }
}

/** The plan's segments: holds between the moves, back to back from 0 to the end; a jump starts a hold at its new centre. */
function segmentsOf(moves: Move[], start: Pt, total: number): FollowSegment[] {
  const out: FollowSegment[] = []
  let at = start
  let t = 0
  const hold = (o1: number): void => {
    if (o1 > t + 1e-12) out.push({ o0: t, o1, from: at, to: at, ramp: GLIDE_RAMP, kind: 'hold' })
  }
  for (const m of moves) {
    hold(m.o0)
    t = Math.max(t, m.o0)
    if (m.kind !== 'jump') {
      out.push({ o0: m.o0, o1: m.o1, from: m.from, to: m.to, ramp: m.ramp, kind: m.kind })
      t = m.o1
    }
    at = m.to
  }
  out.push({ o0: t, o1: Math.max(t, total), from: at, to: at, ramp: GLIDE_RAMP, kind: 'hold' })
  return out
}

/* ---------- the plan cache (§8.1) ---------- */

const PLAN_CACHE_SIZE = 4
const planCache = new WeakMap<object, { refs: readonly unknown[]; key: string; plan: FollowPlan }[]>()
