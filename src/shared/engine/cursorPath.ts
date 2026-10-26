/**
 * Straightened cursor paths (NW-03 part 2, docs/design/smarter-auto-zoom.md): finds the moves
 * between two resting points and replaces the eligible ones with a straight, minimum-jerk glide
 * between the same two points at the same two times. The recorded samples are never changed
 * (a new array is returned); rests, clicks and scroll positions stay exactly as recorded.
 *
 * Distances are in video heights: d(p, q) = hypot((p.x - q.x) * aspect, p.y - q.y) with
 * aspect = project width / height (at 1080p, 0.001 is about 1 px). Pure and deterministic.
 */
import type { ClickEvent, CursorSample, CursorTrack, PathRange, ScrollEvent } from '../types'
import { lowerIndex } from './math'

export const PATH = {
  /** Samples staying within this distance of a rest's first sample belong to the rest. */
  restRadius: 0.006,
  /** Shortest rest (seconds). */
  restMin: 0.15,
  /** Automatic option: moves this long (seconds) or longer... */
  minSeconds: 0.1,
  /** ...and at most this long. */
  maxSeconds: 2.5,
  /** A 'straight' range: at most this long. */
  maxManualSeconds: 10,
  /** Automatic option: shortest chord (distance from start to end). */
  minChord: 0.03,
  /** A 'straight' range: shortest chord. */
  minManualChord: 0.01,
  /** Automatic option: largest distance of a recorded sample from the chord, as a share of the chord. */
  wobbleMax: 0.2,
  /** Automatic option: a path turning this much (degrees, signed sum) is a gesture (a loop). */
  maxTurnDeg: 300,
  /** Arc length step (video heights) the path is resampled at to measure its turning. */
  turnStep: 0.02,
  /** Older recordings without releases: a press this long (seconds) before a move may start a drag. */
  dragGuess: 0.25,
  /** A press held this long (seconds) into a move makes it a drag. */
  dragOverlap: 0.03,
  /** Rate of the synthetic samples of a straightened move (the SmoothedTrack rate). */
  hz: 120
} as const

/**
 * Why a move keeps its recorded path. The first four block it everywhere, a 'straight' range
 * included: 'off-frame' (a sample outside the video: another monitor, beside the area or
 * window, hidden), 'click' or 'scroll' (a recorded click, ignored ones too, or a scroll event
 * strictly inside the move), 'drag' (a press held into the move, known from ClickEvent.up).
 * The others only stop the automatic option ('drag-guess': a click without `up` up to
 * PATH.dragGuess before the move; 'short' / 'long' / 'small': duration or chord out of limits,
 * 'wobbly': wobble above PATH.wobbleMax, 'gesture': turning of PATH.maxTurnDeg or more); a
 * 'straight' range is held to 'long' and 'small' with the manual limits only.
 */
export type MoveReason = 'off-frame' | 'click' | 'scroll' | 'drag' | 'drag-guess' | 'short' | 'long' | 'small' | 'wobbly' | 'gesture'

/** A move between two rests. */
export interface CursorMove {
  /** The last sample of one rest and the first sample of the next (source seconds). */
  t0: number
  t1: number
  /** Their indices in the recorded samples. */
  i0: number
  i1: number
  /** The recorded positions at t0 and t1 (kept by straightening). */
  from: { x: number; y: number }
  to: { x: number; y: number }
  /** Largest distance of a recorded sample from the chord, divided by the chord. */
  wobble: number
  /** Why the automatic option keeps it as recorded; null when it may straighten it. */
  auto: MoveReason | null
  /** Why a 'straight' range keeps it as recorded; null when it may straighten it. */
  manual: MoveReason | null
}

/** Minimum-jerk profile: 0 at 0, 1 at 1, zero speed and acceleration at both ends. */
export const minJerk = (s: number): number => s * s * s * (10 - 15 * s + 6 * s * s)

/**
 * The moves of a track: rests are found by walking the samples (from sample i, extend j while
 * d(S[j + 1], S[i]) <= restRadius; a run of at least restMin seconds is a rest, the walk goes on
 * after it, else at i + 1), and each stretch between two consecutive rests is a move (before the
 * first rest and after the last there is none). Each move carries its reasons (MoveReason) for
 * both modes. Cached per (samples, clicks, scrolls) arrays and aspect. [] for an invalid track.
 */
export function cursorMoves(track: CursorTrack, aspect: number): CursorMove[] {
  if (!track.valid || track.samples.length < 2) return []
  const A = Number.isFinite(aspect) && aspect > 0 ? aspect : 16 / 9
  let entries = moveCache.get(track.samples)
  if (!entries) {
    entries = []
    moveCache.set(track.samples, entries)
  }
  const hit = entries.find((e) => e.clicks === track.clicks && e.scrolls === track.scrolls && e.aspect === A)
  if (hit) return hit.moves
  const moves = findMoves(track.samples, track.clicks, track.scrolls ?? NO_SCROLLS, A)
  entries.unshift({ clicks: track.clicks, scrolls: track.scrolls, aspect: A, moves })
  if (entries.length > CACHE_SIZE) entries.pop()
  return moves
}

const CACHE_SIZE = 4
const NO_SCROLLS: ScrollEvent[] = []
const moveCache = new WeakMap<CursorSample[], { clicks: ClickEvent[]; scrolls: ScrollEvent[] | undefined; aspect: number; moves: CursorMove[] }[]>()
const restCache = new WeakMap<CursorSample[], { aspect: number; rests: [number, number][] }[]>()
const EPS = 1e-9

type Pt = { x: number; y: number }

const dist2 = (p: Pt, q: Pt, A: number): number => {
  const dx = (p.x - q.x) * A
  const dy = p.y - q.y
  return dx * dx + dy * dy
}
const dist = (p: Pt, q: Pt, A: number): number => Math.sqrt(dist2(p, q, A))

/** Distance (video heights) from p to the segment a-b. */
function segmentDist(p: Pt, a: Pt, b: Pt, A: number): number {
  const ax = a.x * A
  const bx = b.x * A
  const px = p.x * A
  const dx = bx - ax
  const dy = b.y - a.y
  const len2 = dx * dx + dy * dy
  const k = len2 > 0 ? Math.min(1, Math.max(0, ((px - ax) * dx + (p.y - a.y) * dy) / len2)) : 0
  const ex = px - (ax + dx * k)
  const ey = p.y - (a.y + dy * k)
  return Math.sqrt(ex * ex + ey * ey)
}

/** The rests of `samples` as [first, last] index pairs (see cursorMoves). Cached per samples array and aspect. */
function restsOf(samples: CursorSample[], A: number): [number, number][] {
  let entries = restCache.get(samples)
  if (!entries) {
    entries = []
    restCache.set(samples, entries)
  }
  const hit = entries.find((e) => e.aspect === A)
  if (hit) return hit.rests
  const rests: [number, number][] = []
  const n = samples.length
  const r2 = PATH.restRadius * PATH.restRadius
  for (let i = 0; i < n; ) {
    let j = i
    while (j + 1 < n && dist2(samples[j + 1], samples[i], A) <= r2) j++
    if (samples[j].t - samples[i].t >= PATH.restMin - EPS) {
      rests.push([i, j])
      i = j + 1
    } else {
      i++
    }
  }
  entries.unshift({ aspect: A, rests })
  if (entries.length > CACHE_SIZE) entries.pop()
  return rests
}

/** Signed sum of direction changes (radians) along the path resampled every PATH.turnStep of arc length. */
function turning(path: readonly Pt[], A: number): number {
  const pts: Pt[] = [{ x: path[0].x * A, y: path[0].y }]
  let carry = 0
  for (let i = 1; i < path.length; i++) {
    const ax = path[i - 1].x * A
    const ay = path[i - 1].y
    const bx = path[i].x * A
    const by = path[i].y
    const len = Math.hypot(bx - ax, by - ay)
    if (len <= 0) continue
    let at = PATH.turnStep - carry
    while (at <= len + EPS) {
      pts.push({ x: ax + ((bx - ax) * at) / len, y: ay + ((by - ay) * at) / len })
      at += PATH.turnStep
    }
    carry = len - (at - PATH.turnStep)
  }
  const end = path[path.length - 1]
  const last = pts[pts.length - 1]
  if (Math.hypot(end.x * A - last.x, end.y - last.y) > EPS) pts.push({ x: end.x * A, y: end.y })
  let sum = 0
  let prev: Pt | null = null
  for (let i = 1; i < pts.length; i++) {
    const d = { x: pts[i].x - pts[i - 1].x, y: pts[i].y - pts[i - 1].y }
    if (Math.hypot(d.x, d.y) <= EPS) continue
    if (prev) sum += Math.atan2(prev.x * d.y - prev.y * d.x, prev.x * d.x + prev.y * d.y)
    prev = d
  }
  return sum
}

const offFrame = (s: Pt): boolean => !(s.x >= 0 && s.x <= 1 && s.y >= 0 && s.y <= 1)
/** A release time that can be trusted (ClickEvent.up). */
const releaseOf = (c: ClickEvent): number | null => (typeof c.up === 'number' && Number.isFinite(c.up) && c.up >= c.t ? c.up : null)

/** Sorted event times for the per-move checks (binary searches, not scans: an hour has thousands of moves). */
interface InputIndex {
  /** Every click and scroll event. */
  clicks: { t: number }[]
  scrolls: { t: number }[]
  /** Clicks with a trusted release, by time, with the latest release up to each one. */
  held: { t: number; up: number }[]
  maxUp: number[]
  /** Clicks without a trusted release. */
  unheld: { t: number }[]
}

function indexInput(clicks: readonly ClickEvent[], scrolls: readonly ScrollEvent[]): InputIndex {
  const byT = (a: { t: number }, b: { t: number }): number => a.t - b.t
  const finiteT = (e: { t: number }): boolean => Number.isFinite(e.t)
  const held: { t: number; up: number }[] = []
  const unheld: { t: number }[] = []
  for (const c of clicks) {
    if (!finiteT(c)) continue
    const up = releaseOf(c)
    if (up === null) unheld.push({ t: c.t })
    else held.push({ t: c.t, up })
  }
  held.sort(byT)
  unheld.sort(byT)
  const maxUp: number[] = []
  held.forEach((h, i) => maxUp.push(Math.max(h.up, i > 0 ? maxUp[i - 1] : -Infinity)))
  return {
    clicks: clicks.filter(finiteT).map((c) => ({ t: c.t })).sort(byT),
    scrolls: scrolls.filter(finiteT).map((e) => ({ t: e.t })).sort(byT),
    held,
    maxUp,
    unheld
  }
}

/** Some event with lo < t < hi (`items` sorted). */
function anyInside(items: { t: number }[], lo: number, hi: number): boolean {
  const i = lowerIndex(items, lo) + 1
  return i < items.length && items[i].t < hi
}

/** A press held into [t0, t1]: min(up, t1) - max(c.t, t0) > PATH.dragOverlap. */
function heldInto(ix: InputIndex, t0: number, t1: number): boolean {
  // Only presses before t1 - dragOverlap can overlap enough; walk back while some earlier release reaches far enough.
  for (let i = lowerIndex(ix.held, t1 - PATH.dragOverlap); i >= 0 && ix.maxUp[i] > t0 + PATH.dragOverlap; i--) {
    const h = ix.held[i]
    if (Math.min(h.up, t1) - Math.max(h.t, t0) > PATH.dragOverlap) return true
  }
  return false
}

function findMoves(samples: CursorSample[], clicks: readonly ClickEvent[], scrolls: readonly ScrollEvent[], A: number): CursorMove[] {
  const rests = restsOf(samples, A)
  const ix = indexInput(clicks, scrolls)
  const moves: CursorMove[] = []
  for (let k = 0; k + 1 < rests.length; k++) {
    const i0 = rests[k][1]
    const i1 = rests[k + 1][0]
    const from = samples[i0]
    const to = samples[i1]
    const t0 = from.t
    const t1 = to.t
    const L = dist(from, to, A)
    let far = 0
    let off = false
    for (let i = i0; i <= i1; i++) {
      if (offFrame(samples[i])) off = true
      if (i > i0 && i < i1) far = Math.max(far, segmentDist(samples[i], from, to, A))
    }
    const wobble = L > 0 ? far / L : far > 0 ? Infinity : 0
    let hard: MoveReason | null = null
    if (off) hard = 'off-frame'
    else if (anyInside(ix.clicks, t0, t1)) hard = 'click'
    else if (anyInside(ix.scrolls, t0, t1)) hard = 'scroll'
    else if (heldInto(ix, t0, t1)) hard = 'drag'
    const length = t1 - t0
    let auto: MoveReason | null = hard
    if (!auto) {
      if (anyInside(ix.unheld, t0 - PATH.dragGuess - EPS, t0 + EPS)) auto = 'drag-guess'
      else if (length < PATH.minSeconds) auto = 'short'
      else if (length > PATH.maxSeconds) auto = 'long'
      else if (L < PATH.minChord) auto = 'small'
      else if (wobble > PATH.wobbleMax) auto = 'wobbly'
      else if (Math.abs(turning(samples.slice(i0, i1 + 1), A)) >= (PATH.maxTurnDeg * Math.PI) / 180) auto = 'gesture'
    }
    let manual: MoveReason | null = hard
    if (!manual) {
      if (length > PATH.maxManualSeconds) manual = 'long'
      else if (L < PATH.minManualChord) manual = 'small'
    }
    moves.push({ t0, t1, i0, i1, from: { x: from.x, y: from.y }, to: { x: to.x, y: to.y }, wobble, auto, manual })
  }
  return moves
}

/** The move whose [t0, t1] contains `t` (moves are sorted and disjoint), or null. */
export function moveAt(moves: readonly CursorMove[], t: number): CursorMove | null {
  let lo = 0
  let hi = moves.length - 1
  while (lo <= hi) {
    const mid = (lo + hi) >> 1
    const m = moves[mid]
    if (t < m.t0) hi = mid - 1
    else if (t > m.t1) lo = mid + 1
    else return m
  }
  return null
}

/**
 * `samples` with each of `moves` replaced: the recorded samples strictly between t0 and t1 are
 * removed and synthetic ones inserted at t0 + k / PATH.hz (k = 1 .. ceil((t1 - t0) * hz) - 1),
 * at from + (to - from) * minJerk((t - t0) / (t1 - t0)). The samples at t0 and t1 and every
 * sample outside the moves are the same objects as before. Returns `samples` itself when
 * `moves` is empty.
 */
export function straightenSamples(samples: CursorSample[], moves: readonly CursorMove[]): CursorSample[] {
  if (moves.length === 0) return samples
  const sorted = [...moves].sort((a, b) => a.t0 - b.t0)
  const out: CursorSample[] = []
  let m = 0
  for (const s of samples) {
    // Reaching the end of a move: its glide goes in before the sample at t1.
    for (; m < sorted.length && s.t >= sorted[m].t1; m++) pushGlide(out, sorted[m])
    if (m < sorted.length && s.t > sorted[m].t0 && s.t < sorted[m].t1) continue
    out.push(s)
  }
  for (; m < sorted.length; m++) pushGlide(out, sorted[m])
  return out
}

/** The synthetic samples of one straightened move (strictly between t0 and t1). */
function pushGlide(out: CursorSample[], move: CursorMove): void {
  const { t0, t1, from, to } = move
  const span = t1 - t0
  if (!(span > 0)) return
  const steps = Math.ceil(span * PATH.hz - EPS)
  for (let k = 1; k < steps; k++) {
    const t = t0 + k / PATH.hz
    if (t >= t1 - EPS) break
    const e = minJerk((t - t0) / span)
    out.push({ t, x: from.x + (to.x - from.x) * e, y: from.y + (to.y - from.y) * e })
  }
}

/** Which moves a project straightens, and the samples that result. */
export interface PathPlan {
  /** The samples to draw and follow: `track.samples` itself when no move is straightened. */
  samples: CursorSample[]
  moves: CursorMove[]
  /** The straightened moves, in time order. */
  straightened: CursorMove[]
}

/**
 * Decides every move by the path range containing its midpoint (t0 + t1) / 2 (start <= mid <
 * end): 'recorded' keeps it, 'straight' straightens it when `manual` is null; outside every
 * range the automatic option (`straighten`) straightens it when `auto` is null. Then replaces
 * the chosen moves (straightenSamples). Cached like cursorMoves, plus straighten and the paths
 * array (by identity; every empty array is the same, but pass NO_PATHS when there are none).
 */
export function planCursorPath(track: CursorTrack, ctx: { aspect: number; straighten: boolean; paths: readonly PathRange[] }): PathPlan {
  const moves = cursorMoves(track, ctx.aspect)
  if (moves.length === 0) return { samples: track.samples, moves, straightened: [] }
  let entries = planCache.get(moves)
  if (!entries) {
    entries = []
    planCache.set(moves, entries)
  }
  const straighten = !!ctx.straighten
  const hit = entries.find((e) => e.samples === track.samples && e.straighten === straighten && samePathsArray(e.paths, ctx.paths))
  if (hit) return hit.plan
  const straightened = moves.filter((m) => {
    const mode = pathModeAt(ctx.paths, (m.t0 + m.t1) / 2)
    if (mode === 'recorded') return false
    if (mode === 'straight') return m.manual === null
    return straighten && m.auto === null
  })
  const plan: PathPlan = { samples: straightenSamples(track.samples, straightened), moves, straightened }
  entries.unshift({ samples: track.samples, straighten, paths: ctx.paths, plan })
  if (entries.length > CACHE_SIZE) entries.pop()
  return plan
}

const planCache = new WeakMap<CursorMove[], { samples: CursorSample[]; straighten: boolean; paths: readonly PathRange[]; plan: PathPlan }[]>()

/**
 * The path ranges of a project without any: one shared array, so every caller (the effective
 * track, the path summary, the timeline's bars) finds the same cached plan.
 */
export const NO_PATHS: readonly PathRange[] = []

const samePathsArray = (a: readonly PathRange[], b: readonly PathRange[]): boolean => a === b || (a.length === 0 && b.length === 0)

/** The mode of the path range containing `t` (start <= t < end), or null outside every range. */
export function pathModeAt(paths: readonly PathRange[], t: number): PathRange['mode'] | null {
  for (const r of paths) if (r.start <= t && t < r.end) return r.mode
  return null
}
