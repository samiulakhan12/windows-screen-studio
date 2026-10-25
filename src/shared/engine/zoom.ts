import type { AutoZoomSettings, ClickEvent, CursorSample, CursorTrack, ZoomEasing, ZoomFocus, ZoomSegment, ZoomSettings } from '../types'
import { cursorAt, SmoothedTrack } from './cursor'
import { BOUNCY_OVERSHOOT, ease } from './easing'
import { clamp, easeInOutCubic, lerp } from './math'

export const ZOOM_TRANSITION = 0.7
/** How long after an auto zoom's click the camera takes to hand its aim back to the cursor. */
export const ANCHOR_RELEASE = 0.3

/** Zoom levels: below 1 pulls back (the recording shrinks onto the background), above 1 zooms in. */
export const ZOOM_MIN_SCALE = 0.5
export const ZOOM_MAX_SCALE = 5
/** Transition lengths the editor offers (seconds). */
export const MIN_TRANSITION = 0.15
export const MAX_TRANSITION = 2.5

const outsideFrame = (s: CursorSample): boolean => s.x < 0 || s.x > 1 || s.y < 0 || s.y > 1

/**
 * The path the zoom camera follows with cursor focus: the cursor, heavily smoothed, with
 * positions off the recorded frame (another monitor, beside the recorded area or window, or
 * hidden) held at the frame's edge. Far-off positions would otherwise drag the camera to the
 * opposite side and keep it lagging there long after the cursor came back.
 */
export function focusPathFor(samples: CursorSample[], duration: number): SmoothedTrack {
  const inFrame = samples.some(outsideFrame)
    ? samples.map((s) => (outsideFrame(s) ? { t: s.t, x: clamp(s.x, 0, 1), y: clamp(s.y, 0, 1) } : s))
    : samples
  return new SmoothedTrack(inFrame, duration, 1)
}

export interface AutoZoomOptions {
  scale: number
  /** Clicks closer than this (seconds) share one zoom segment. */
  clusterGap: number
  leadIn: number
  hold: number
  minDuration: number
}

export const DEFAULT_AUTO_ZOOM: AutoZoomOptions = {
  scale: 1.8,
  clusterGap: 3,
  leadIn: 0.9,
  hold: 1.8,
  minDuration: 2.2
}

let idCounter = 0
export const newZoomId = (): string => `z${Date.now().toString(36)}${(idCounter++).toString(36)}`

const inUnit = (p: { x: number; y: number }): boolean => p.x >= 0 && p.x <= 1 && p.y >= 0 && p.y <= 1

/**
 * Left clicks that landed on the captured display. Clicks on other monitors are
 * normalised outside 0..1 and must never become zooms aimed at the frame edge.
 */
export function isUsableClick(c: ClickEvent): boolean {
  return c.button === 'left' && Number.isFinite(c.t) && inUnit(c)
}

/** Clicks that create auto zooms: left clicks, and right clicks when asked for. */
export function isZoomClick(c: ClickEvent, rightClicks = false): boolean {
  return (c.button === 'left' || (rightClicks && c.button === 'right')) && Number.isFinite(c.t) && inUnit(c)
}

/** Something recorded that deserves a zoom: it spans t0..t1 and the zoom aims at `anchor`. */
interface ZoomEvent {
  t0: number
  t1: number
  anchor: { t: number; x: number; y: number }
  /** Typing into the field at `anchor` from t0 to t1: the zoom holds its aim there for as long as it lasts. */
  typing?: boolean
}

/** Places closer than this (normalised units) are the same field: one zoom aims at both. */
const SAME_FIELD = 0.08

const near = (a: { x: number; y: number }, b: { x: number; y: number }): boolean => Math.hypot(a.x - b.x, a.y - b.y) < SAME_FIELD

/** Consecutive events of one zoom that aim at the same thing: clicks and marks together, or one typing session. */
interface ZoomPart {
  t0: number
  t1: number
  anchor: ZoomEvent['anchor']
  typing: boolean
  events: ZoomEvent[]
}

/** The parts of one zoom: typing on its own (with clicks into the same field), clicks and marks between. */
function zoomParts(events: ZoomEvent[]): ZoomPart[] {
  const parts: ZoomPart[] = []
  for (const e of events) {
    const last = parts[parts.length - 1]
    if (last && !e.typing && !last.typing) {
      last.t1 = Math.max(last.t1, e.t1)
      last.events.push(e)
    } else {
      parts.push({ t0: e.t0, t1: e.t1, anchor: { ...e.anchor }, typing: !!e.typing, events: [e] })
    }
  }
  // Clicking into a field and typing there (or typing on after a pause) is one part aimed at the field.
  const sameField = (a: ZoomPart, b: ZoomPart): boolean => {
    if (!a.typing && !b.typing) return false
    const field = a.typing ? a.anchor : b.anchor
    return [...a.events, ...b.events].every((e) => near(e.anchor, field))
  }
  for (let i = 0; i + 1 < parts.length; ) {
    const a = parts[i]
    const b = parts[i + 1]
    if (!sameField(a, b)) {
      i++
      continue
    }
    const field = a.typing ? a.anchor : b.anchor
    parts.splice(i, 2, { t0: a.t0, t1: Math.max(a.t1, b.t1), anchor: { ...field }, typing: true, events: [...a.events, ...b.events] })
  }
  return parts
}

/**
 * The zoom segments of one range [start, end]: one per part, back to back, so the camera pans
 * from one part to the next without zooming out. A part's segment begins leadIn before it (or
 * halfway from the previous part when that is closer, never before the previous part ends).
 * Click parts aim at their first event as zooms always have; typing parts look at their field
 * for the whole segment (an anchor spanning the typing, see anchorWeight), at `typingScale`.
 */
function rangeSegments(r: { start: number; end: number; events: ZoomEvent[] }, o: AutoZoomOptions, typingScale: number): ZoomSegment[] {
  const parts = zoomParts(r.events)
  const bounds = [r.start]
  for (let i = 1; i < parts.length; i++) {
    const prev = parts[i - 1]
    const next = parts[i]
    bounds.push(clamp(Math.max(next.t0 - o.leadIn, (prev.t1 + next.t0) / 2), bounds[i - 1], r.end))
  }
  bounds.push(r.end)
  const segments: ZoomSegment[] = []
  parts.forEach((part, i) => {
    const start = bounds[i]
    const end = bounds[i + 1]
    // Only when clamped to the recording's end: nothing is left of this part, the previous one goes on.
    if (end - start < 0.05) {
      const prev = segments[segments.length - 1]
      if (prev) prev.end = end
      else bounds[i + 1] = start
      return
    }
    // Typing spans its whole part (from the click into the field to the last key), not one instant.
    const anchor = part.typing ? { t: part.t0, x: part.anchor.x, y: part.anchor.y, until: part.t1 } : { ...part.anchor }
    segments.push({ id: newZoomId(), start, end, scale: part.typing ? typingScale : o.scale, focus: { mode: 'cursor' }, auto: true, anchor })
  })
  return segments
}

/**
 * Zoom segments from recorded events: events closer than clusterGap share one zoom, which
 * starts leadIn before the first and holds until `hold` after the last; segments whose
 * transitions would overlap are merged (no zoom-out/in dip). Each zoom aims at its first
 * event; typing gets its own part of the zoom, aimed at the field for as long as it lasts,
 * joined to the clicks around it by a pan.
 */
function zoomsFromEvents(events: ZoomEvent[], duration: number, o: AutoZoomOptions, typingScale = o.scale): ZoomSegment[] {
  const sorted = [...events].sort((a, b) => a.t0 - b.t0)
  const ranges: { start: number; end: number; last: number; events: ZoomEvent[] }[] = []
  for (const e of sorted) {
    const cur = ranges[ranges.length - 1]
    if (cur && e.t0 - cur.last <= o.clusterGap) {
      cur.last = Math.max(cur.last, e.t1)
      cur.end = Math.max(cur.end, e.t1 + o.hold)
      cur.events.push(e)
    } else {
      ranges.push({ start: e.t0 - o.leadIn, end: e.t1 + o.hold, last: e.t1, events: [e] })
    }
  }
  const zooms: { start: number; end: number; events: ZoomEvent[] }[] = []
  for (const r of ranges) {
    let start = clamp(r.start, 0, duration)
    let end = clamp(Math.max(r.end, start + o.minDuration), 0, duration)
    if (end - start < 2 * ZOOM_TRANSITION) {
      start = clamp(end - 2 * ZOOM_TRANSITION, 0, duration)
      end = clamp(start + 2 * ZOOM_TRANSITION, 0, duration)
    }
    const prev = zooms[zooms.length - 1]
    // Merge segments whose transitions would overlap, to avoid a zoom-out/in "dip".
    if (prev && start - prev.end < ZOOM_TRANSITION) {
      prev.end = Math.max(prev.end, end)
      prev.events.push(...r.events)
      continue
    }
    if (end - start > 0.2) zooms.push({ start, end, events: [...r.events] })
  }
  return zooms.flatMap((r) => rangeSegments(r, o, typingScale))
}

const clickEvent = (c: ClickEvent): ZoomEvent => ({ t0: c.t, t1: c.t, anchor: { t: c.t, x: c.x, y: c.y } })

/** Builds zoom segments from click clusters: zoom in just before a click, hold, ease out. */
export function generateAutoZooms(
  clicks: ClickEvent[],
  duration: number,
  options: Partial<AutoZoomOptions> = {}
): ZoomSegment[] {
  return zoomsFromEvents(clicks.filter((c) => isUsableClick(c)).map(clickEvent), duration, { ...DEFAULT_AUTO_ZOOM, ...options })
}

/** How far back (seconds) a click still counts as "the field being typed into". */
export const TYPING_CLICK_WINDOW = 10
/** A click this shortly before typing (seconds) is the click into the field: they are one zoom. */
export const TYPING_CLICK_JOIN = 5
/** Typing shorter than this (seconds: a lone key, a quick "ok") makes no zoom of its own. */
export const TYPING_MIN_LENGTH = 0.5
/** Pauses between typing bursts up to this long (seconds) keep the zoom in: thinking mid-sentence. */
export const TYPING_PAUSE = 6

/**
 * Level of a typing zoom: text needs a closer look than a click, so a step (20%) closer than
 * click zooms, up to 2.2× (a level already above that is kept, never lowered).
 */
export function typingScale(scale: number): number {
  return Math.max(scale, Math.min(scale * 1.2, 2.2))
}

/** Where a typing burst starting at `t` types into: the last click before it, else the cursor. */
function typingPlace(track: CursorTrack, t: number, rightClicks: boolean): { x: number; y: number } {
  let click: ClickEvent | null = null
  for (const c of track.clicks) {
    if (c.t <= t && c.t >= t - TYPING_CLICK_WINDOW && isZoomClick(c, rightClicks) && (!click || c.t >= click.t)) click = c
  }
  if (click) return { x: click.x, y: click.y }
  return cursorPlace(track, t)
}

/** The recorded cursor position at `t`, kept on the frame (centre without cursor data). */
function cursorPlace(track: CursorTrack, t: number): { x: number; y: number } {
  const p = cursorAt(track.samples, t)
  return p ? { x: clamp(p.x, 0, 1), y: clamp(p.y, 0, 1) } : { x: 0.5, y: 0.5 }
}

/** A stretch of typing into one field, with the click into it (when there was one just before). */
interface TypingSession {
  t0: number
  t1: number
  place: { x: number; y: number }
  click: ClickEvent | null
}

/**
 * Typing sessions from the recorded bursts: bursts with pauses up to `pause` between them and
 * no click in between are one session (a click means another field, or the same one again:
 * then the sessions join later, being at the same place). Sessions shorter than
 * TYPING_MIN_LENGTH are dropped. A session takes the last zoom click up to TYPING_CLICK_JOIN
 * before it (after the previous session) as the click into its field.
 */
function typingSessions(track: CursorTrack, clicks: readonly ClickEvent[], pause: number, rightClicks: boolean): TypingSession[] {
  const bursts = (track.typing ?? [])
    .filter((b) => Number.isFinite(b.t) && Number.isFinite(b.end))
    .map((b) => ({ t0: b.t, t1: Math.max(b.t, b.end) }))
    .sort((a, b) => a.t0 - b.t0)
  const runs: { t0: number; t1: number }[] = []
  for (const b of bursts) {
    const cur = runs[runs.length - 1]
    if (cur && b.t0 - cur.t1 <= pause && !clicks.some((c) => c.t > cur.t1 && c.t < b.t0)) cur.t1 = Math.max(cur.t1, b.t1)
    else runs.push({ ...b })
  }
  const sessions: TypingSession[] = []
  let after = -Infinity
  for (const r of runs) {
    if (r.t1 - r.t0 < TYPING_MIN_LENGTH) continue
    let click: ClickEvent | null = null
    for (const c of clicks) if (c.t <= r.t0 && c.t > after && (!click || c.t >= click.t)) click = c
    const into = click && r.t0 - click.t <= TYPING_CLICK_JOIN ? click : null
    sessions.push({ t0: into ? into.t : r.t0, t1: r.t1, place: into ? { x: into.x, y: into.y } : typingPlace(track, r.t0, rightClicks), click: into })
    after = r.t1
  }
  return sessions
}

/**
 * Auto zoom segments for a whole cursor track: clicks (right clicks too when enabled),
 * typing (see below) and "zoom here" marks (aimed at the cursor). Overlapping results are
 * merged. Every zoom carries an anchor.
 *
 * Typing: bursts a short pause apart are one session, which holds the zoom in until it ends
 * (plus the hold) instead of zooming out mid-sentence. It aims at the place being typed into,
 * the last click up to TYPING_CLICK_WINDOW before it, else the cursor where it starts, for its
 * whole length (the idle mouse is never chased), a little closer than click zooms
 * (typingScale). The click into the field just before and the typing are one zoom; clicks and
 * marks elsewhere in the same zoom pan to their own place and back. Typing too short to read
 * makes no zoom of its own.
 *
 * Scrolling (track.scrolls with settings.scrolling, docs/design/smarter-auto-zoom.md part 3):
 * 'zoom-out' (the default) zooms out during long scrolls and back in where they stop, short
 * scrolls hold the zoom; 'hold' holds through every scroll. Without scroll data (older
 * recordings, or `scrolls: []`) or with 'ignore' the result is exactly what it was before
 * scrolling was recorded.
 * CONTRACT: used by recording finalize and by "Regenerate", always with the effective track
 * (shared/engine/inputTrack.ts effectiveTrack), so ignored clicks stay ignored.
 */
export function autoZoomsForTrack(track: CursorTrack, duration: number, settings: AutoZoomSettings = DEFAULT_ZOOM_SETTINGS.auto): ZoomSegment[] {
  if (!settings.enabled) return []
  const o: AutoZoomOptions = {
    scale: clamp(settings.scale, 1.05, ZOOM_MAX_SCALE),
    clusterGap: Math.max(0, settings.clusterGap),
    leadIn: Math.max(0, settings.leadIn),
    hold: Math.max(0, settings.hold),
    minDuration: DEFAULT_AUTO_ZOOM.minDuration
  }
  const clicks = track.clicks.filter((c) => isZoomClick(c, settings.rightClicks)).sort((a, b) => a.t - b.t)
  const sessions = track.valid !== false && settings.onTyping ? typingSessions(track, clicks, Math.max(TYPING_PAUSE, o.clusterGap), settings.rightClicks) : []
  // Clicks into a field, and clicks and marks while typing, belong to the typing.
  const typed = (t: number): boolean => sessions.some((s) => t >= s.t0 && t <= s.t1)
  const events: ZoomEvent[] = clicks.filter((c) => !sessions.some((s) => s.click === c) && !typed(c.t)).map(clickEvent)
  for (const s of sessions) events.push({ t0: s.t0, t1: s.t1, anchor: { t: s.t0, ...s.place }, typing: true })
  if (settings.onMarks) {
    for (const m of track.marks ?? []) {
      if (!Number.isFinite(m.t) || typed(m.t)) continue
      events.push({ t0: m.t, t1: m.t, anchor: { t: m.t, ...cursorPlace(track, m.t) } })
    }
  }
  const zooms = zoomsFromEvents(events, duration, o, typingScale(o.scale))
  // Without cursor data there is no cursor to follow: look at the anchor instead.
  return track.valid === false ? zooms.map((z) => ({ ...z, focus: { mode: 'fixed', x: z.anchor?.x ?? 0.5, y: z.anchor?.y ?? 0.5 } })) : zooms
}

/** Envelope 0..1 of a segment at time t (eased ramps at both ends). */
export function segmentEnvelope(seg: ZoomSegment, t: number, transition = ZOOM_TRANSITION): number {
  if (t <= seg.start || t >= seg.end) return 0
  const tr = Math.min(transition, (seg.end - seg.start) / 2)
  const rampIn = easeInOutCubic((t - seg.start) / tr)
  const rampOut = easeInOutCubic((seg.end - t) / tr)
  return Math.min(rampIn, rampOut)
}

export interface Camera {
  /**
   * Zoom factor (1 = whole frame). Below 1 the camera pulls back: the whole recording
   * shows, shrunk inside its card, with more background around it.
   */
  scale: number
  /**
   * Viewport centre in normalised source coordinates. The viewport spans 1/scale of the
   * source around it; below scale 1 it is larger than the source, which then sits inside it.
   */
  cx: number
  cy: number
}

const REST: Camera = { scale: 1, cx: 0.5, cy: 0.5 }

/**
 * How much an auto zoom aims at its anchor rather than at the smoothed cursor at time t. A
 * click: fully until the click, then handing back to the cursor over ANCHOR_RELEASE. Typing
 * (an anchor spanning t..until): fully for the whole zoom, so a trimmed, disconnected or
 * clamped end never sets the camera chasing the idle mouse. 0 without an anchor, or for one
 * the segment no longer covers (it was moved away from the click or the typing).
 */
export function anchorWeight(seg: ZoomSegment, t: number): number {
  const a = seg.anchor
  if (!a) return 0
  const until = a.until
  if (typeof until === 'number' && Number.isFinite(until)) return Math.min(a.t, until) <= seg.end && Math.max(a.t, until) >= seg.start ? 1 : 0
  if (!(a.t >= seg.start && a.t <= seg.end)) return 0
  if (t <= a.t) return 1
  const k = (t - a.t) / ANCHOR_RELEASE
  return k >= 1 ? 0 : 1 - easeInOutCubic(k)
}

/* ---------- zoom levels, regions and per-zoom style ---------- */

/** Zoom level that frames a normalised source rectangle: the largest that still shows all of it. */
export function regionScale(r: { w: number; h: number }): number {
  return clamp(1 / Math.max(r.w, r.h, 1e-6), 1, ZOOM_MAX_SCALE)
}

/** The level a zoom moves to (a region zoom's follows from its rectangle). */
export function zoomTargetScale(z: Pick<ZoomSegment, 'scale' | 'focus'>): number {
  if (z.focus.mode === 'region') return regionScale(z.focus)
  return clamp(Number.isFinite(z.scale) ? z.scale : 2, ZOOM_MIN_SCALE, ZOOM_MAX_SCALE)
}

/** Project-wide defaults a zoom falls back to when it has no easing or transition of its own. */
export interface ZoomStyle {
  easing: ZoomEasing
  transition: number
}

export const DEFAULT_ZOOM_STYLE: ZoomStyle = { easing: 'smooth', transition: ZOOM_TRANSITION }

export const zoomEasing = (z: ZoomSegment, style: ZoomStyle = DEFAULT_ZOOM_STYLE): ZoomEasing => z.easing ?? style.easing ?? 'smooth'

export function zoomTransition(z: ZoomSegment, style: ZoomStyle = DEFAULT_ZOOM_STYLE): number {
  const tr = z.transition ?? style.transition
  return clamp(Number.isFinite(tr) ? tr : ZOOM_TRANSITION, 0.05, 10)
}

/**
 * Longest gap between two zooms that still counts as "connected": the camera then pans (and
 * zooms) straight from one to the next instead of returning to the full frame in between.
 */
export const connectGap = (a: ZoomSegment, b: ZoomSegment, style: ZoomStyle = DEFAULT_ZOOM_STYLE): number =>
  (zoomTransition(a, style) + zoomTransition(b, style)) / 2

/** True when the camera goes from `a` straight to `b` (b follows a closely; overlap counts too). */
export function zoomsConnected(a: ZoomSegment, b: ZoomSegment, style: ZoomStyle = DEFAULT_ZOOM_STYLE): boolean {
  return b.start >= a.start && b.start - a.end < connectGap(a, b, style) - 1e-9
}

/* ---------- camera ---------- */

/** A zoom resolved against its neighbours: when it moves in, holds and moves out. */
interface PlanItem {
  seg: ZoomSegment
  scale: number
  easing: ZoomEasing
  /** Seconds of the move into this zoom (from the full frame, or from the previous zoom). */
  tin: number
  /** Seconds of the move back to the full frame at the end (0 when it connects to the next zoom). */
  tout: number
  fromPrev: boolean
  toNext: boolean
}

interface ZoomPlan {
  items: PlanItem[]
  starts: number[]
}

function buildPlan(zooms: ZoomSegment[], style: ZoomStyle): ZoomPlan {
  const sorted: ZoomSegment[] = []
  for (const z of zooms.filter((z) => z.end > z.start).sort((a, b) => a.start - b.start)) {
    // A zoom entirely inside an earlier one (only possible in a hand-edited file) is ignored.
    const last = sorted[sorted.length - 1]
    if (!last || z.end > last.end) sorted.push(z)
  }
  const items: PlanItem[] = sorted.map((seg, i) => {
    const prev = sorted[i - 1]
    const next = sorted[i + 1]
    const fromPrev = !!prev && zoomsConnected(prev, seg, style)
    const toNext = !!next && zoomsConnected(seg, next, style)
    // An overlapped zoom only lasts until the next one starts.
    const len = (next && next.start < seg.end ? next.start : seg.end) - seg.start
    const tr = zoomTransition(seg, style)
    const tin = Math.min(tr, toNext ? len : len / 2)
    return { seg, scale: zoomTargetScale(seg), easing: zoomEasing(seg, style), tin, tout: toNext ? 0 : Math.min(tr, len / 2), fromPrev, toNext }
  })
  return { items, starts: items.map((it) => it.seg.start) }
}

const plans = new WeakMap<ZoomSegment[], { style: ZoomStyle; plan: ZoomPlan }>()

/** The camera plan for a list of zooms, computed once per list (project states are immutable). */
function planFor(zooms: ZoomSegment[], style: ZoomStyle): ZoomPlan {
  const hit = plans.get(zooms)
  if (hit && hit.style.easing === style.easing && hit.style.transition === style.transition) return hit.plan
  const plan = buildPlan(zooms, style)
  plans.set(zooms, { style: { easing: style.easing, transition: style.transition }, plan })
  return plan
}

/** How each zoom moves, resolved against its neighbours (for drawing transitions on the timeline). */
export interface ZoomTiming {
  /** Seconds of the move in at the start (a pan from the previous zoom when fromPrev). */
  tin: number
  /** Seconds of the move back to the full frame at the end (0 when it pans into the next zoom). */
  tout: number
  fromPrev: boolean
  toNext: boolean
}

export function zoomTimings(zooms: ZoomSegment[], style: ZoomStyle = DEFAULT_ZOOM_STYLE): Map<string, ZoomTiming> {
  const out = new Map<string, ZoomTiming>()
  for (const it of planFor(zooms, style).items) out.set(it.seg.id, { tin: it.tin, tout: it.tout, fromPrev: it.fromPrev, toNext: it.toNext })
  return out
}

/** Keeps a camera from showing outside the recording (zoomed in) or the card off the frame (pulled back). */
export function clampCamera(c: Camera): Camera {
  const scale = Math.max(0.05, c.scale)
  const half = 0.5 / scale
  const lo = Math.min(half, 1 - half)
  const hi = Math.max(half, 1 - half)
  return { scale, cx: clamp(c.cx, lo, hi), cy: clamp(c.cy, lo, hi) }
}

/**
 * Camera that zooms by `scale` towards focus point (fx, fy). Zoomed in, the view is centred
 * on the point as far as the recording allows. Pulled back, the card shrinks around the
 * point, which stays where it is on screen (the centre shrinks it evenly).
 */
export function cameraFor(scale: number, fx: number, fy: number): Camera {
  if (scale >= 1) return clampCamera({ scale, cx: fx, cy: fy })
  return clampCamera({ scale, cx: fx + (0.5 - fx) / scale, cy: fy + (0.5 - fy) / scale })
}

type Point = { x: number; y: number }

/** Where a cursor-following zoom aims at t, the smoothed cursor being at `p`: toward its anchor by anchorWeight. */
function anchoredAim(seg: ZoomSegment, t: number, p: Point): Point {
  const a = seg.anchor
  const w = a ? anchorWeight(seg, t) : 0
  return a && w > 0 ? { x: lerp(p.x, a.x, w), y: lerp(p.y, a.y, w) } : p
}

/** Where a zoom aims at time t. */
function focusOf(it: PlanItem, t: number, focusTrack: SmoothedTrack | null): { x: number; y: number } {
  const f = it.seg.focus
  if (f.mode === 'fixed') return { x: f.x, y: f.y }
  if (f.mode === 'region') return { x: f.x + f.w / 2, y: f.y + f.h / 2 }
  // A cursor-following pull-back stays centred: the whole recording is visible anyway.
  if (it.scale < 1 || !focusTrack) return { x: 0.5, y: 0.5 }
  return anchoredAim(it.seg, t, focusTrack.at(t))
}

const targetOf = (it: PlanItem, t: number, focusTrack: SmoothedTrack | null): Camera => {
  const f = focusOf(it, t, focusTrack)
  return cameraFor(it.scale, f.x, f.y)
}

/**
 * Camera part way (w) from a to b. Between zoomed-in views the centre moves in a straight
 * line; when a pull-back is involved the card position moves linearly instead, so a card
 * shrinking around a point keeps that point still. w may pass 1 (bouncy easing).
 */
export function blendCameras(a: Camera, b: Camera, w: number): Camera {
  let scale = lerp(a.scale, b.scale, w)
  if (a.scale >= 1 && b.scale >= 1) {
    // An overshoot must never show outside the recording.
    scale = Math.max(1, scale)
    return clampCamera({ scale, cx: lerp(a.cx, b.cx, w), cy: lerp(a.cy, b.cy, w) })
  }
  scale = Math.max(0.05, scale)
  // Left/top edge of the source in viewport units: 0.5 - c * scale.
  const px = lerp(0.5 - a.cx * a.scale, 0.5 - b.cx * b.scale, w)
  const py = lerp(0.5 - a.cy * a.scale, 0.5 - b.cy * b.scale, w)
  return clampCamera({ scale, cx: (0.5 - px) / scale, cy: (0.5 - py) / scale })
}

/** Eased move from `from` to `to`; overshoot only where it cannot reveal outside the recording. */
function move(from: Camera, to: Camera, easing: ZoomEasing, x: number): Camera {
  const safe = !(Math.min(from.scale, to.scale) >= 1 && to.scale - BOUNCY_OVERSHOOT * (from.scale - to.scale) < 1)
  return blendCameras(from, to, ease(easing, x, safe))
}

/** Index of the last plan item starting at or before t (-1 if none). */
function itemAt(plan: ZoomPlan, t: number): number {
  let lo = 0
  let hi = plan.starts.length - 1
  let found = -1
  while (lo <= hi) {
    const mid = (lo + hi) >> 1
    if (plan.starts[mid] <= t) {
      found = mid
      lo = mid + 1
    } else {
      hi = mid - 1
    }
  }
  return found
}

/**
 * Camera at time `t`. Focus follows a heavily smoothed cursor path (`focusTrack`), except
 * that an auto zoom aims at its click while zooming in (the smoothed cursor lags behind a
 * quick move to the click), and is clamped so the zoomed viewport never shows anything
 * outside the recording. Each zoom moves in and out over its transition with its easing
 * (defaults from `style`); zooms close enough to be connected pan from one to the next
 * without returning to the full frame. Region zooms frame their rectangle, levels below 1
 * pull back.
 */
export function cameraAt(zooms: ZoomSegment[], t: number, focusTrack: SmoothedTrack | null, style: ZoomStyle = DEFAULT_ZOOM_STYLE): Camera {
  if (zooms.length === 0) return REST
  const plan = planFor(zooms, style)
  const i = itemAt(plan, t)
  if (i < 0) return REST
  const it = plan.items[i]
  const { start, end } = it.seg
  if (t >= end) return it.toNext ? targetOf(it, t, focusTrack) : REST
  const target = targetOf(it, t, focusTrack)
  if (it.tin > 0 && t < start + it.tin) {
    const from = it.fromPrev ? targetOf(plan.items[i - 1], t, focusTrack) : REST
    return move(from, target, it.easing, (t - start) / it.tin)
  }
  if (it.tout > 0 && t > end - it.tout) return move(target, REST, it.easing, (t - (end - it.tout)) / it.tout)
  return target
}

/** Where zoom `it` aims at t in place of the cursor `p`: toward its anchor when it follows the cursor (as focusOf), else `p`. */
const aimOf = (it: PlanItem, t: number, p: Point): Point => (it.seg.focus.mode === 'cursor' && it.scale >= 1 ? anchoredAim(it.seg, t, p) : p)

const lerpPoint = (a: Point, b: Point, w: number): Point => (w <= 0 ? a : w >= 1 ? b : { x: lerp(a.x, b.x, w), y: lerp(a.y, b.y, w) })

/**
 * The point the camera follows at `t` in place of the smoothed cursor (`focusTrack`): the cursor
 * itself, except while a cursor-following zoom holds its aim on its anchor (the click it zooms
 * to, the field being typed into), exactly as cameraAt aims. It goes over to the anchor while
 * the camera moves in (from the cursor, or from the previous zoom's aim) and back while it moves
 * out, with the camera's own progress, so it never jumps. Fixed, region and pull-back zooms leave
 * it the cursor. The 3D tilt's 'cursor' lean follows it, so the card leans toward what the camera
 * looks at, never toward an idle mouse the camera ignores.
 */
export function aimAt(zooms: ZoomSegment[], t: number, focusTrack: { at(t: number): Point }, style: ZoomStyle = DEFAULT_ZOOM_STYLE): Point {
  const p = focusTrack.at(t)
  if (zooms.length === 0) return p
  const plan = planFor(zooms, style)
  const i = itemAt(plan, t)
  if (i < 0) return p
  const it = plan.items[i]
  const { start, end } = it.seg
  // Past its end the camera has gone back to the full frame, unless it pans on into the next zoom.
  if (t >= end) return it.toNext ? aimOf(it, t, p) : p
  const aim = aimOf(it, t, p)
  if (it.tin > 0 && t < start + it.tin) return lerpPoint(it.fromPrev ? aimOf(plan.items[i - 1], t, p) : p, aim, ease(it.easing, (t - start) / it.tin, false))
  if (it.tout > 0 && t > end - it.tout) return lerpPoint(aim, p, ease(it.easing, (t - (end - it.tout)) / it.tout, false))
  return aim
}

/** Keeps segments sorted, inside [0, duration] and non-overlapping. */
export function normalizeZooms(zooms: ZoomSegment[], duration: number): ZoomSegment[] {
  const sorted = [...zooms].sort((a, b) => a.start - b.start)
  const out: ZoomSegment[] = []
  for (const z of sorted) {
    const prev = out[out.length - 1]
    const start = clamp(Math.max(z.start, prev ? prev.end : 0), 0, duration)
    const end = clamp(z.end, 0, duration)
    if (end - start >= 0.3) out.push({ ...z, start, end, scale: clamp(z.scale, ZOOM_MIN_SCALE, ZOOM_MAX_SCALE) })
  }
  return out
}

/* ---------- Editing helpers: they never move or drop segments other than the one edited ---------- */

/** Shortest zoom the timeline lets the user drag a segment down to. */
export const MIN_ZOOM_LENGTH = 0.6
/** Shortest zoom that "add zoom" creates; a smaller free gap is refused with a hint. */
export const MIN_NEW_ZOOM = 1
export const DEFAULT_NEW_ZOOM = 3

export const zoomAt = (zooms: ZoomSegment[], t: number): ZoomSegment | null =>
  zooms.find((z) => t >= z.start && t < z.end) ?? null

export type InsertZoomResult =
  | { ok: true; zooms: ZoomSegment[]; id: string }
  | { ok: false; reason: 'inside'; id: string }
  | { ok: false; reason: 'no-room' }

/**
 * Adds a zoom covering time `at`, fitted into the free gap around it. `lead` is
 * how long before `at` the zoom starts, so it is fully zoomed in at `at`.
 * Existing segments are never changed: inside an existing zoom the result names
 * that zoom instead, and a gap shorter than MIN_NEW_ZOOM is refused.
 */
export function insertZoom(
  zooms: ZoomSegment[],
  at: number,
  duration: number,
  options: { lead?: number; length?: number; scale?: number; focus?: ZoomFocus } = {}
): InsertZoomResult {
  const t = clamp(at, 0, duration)
  const hit = zoomAt(zooms, t)
  if (hit) return { ok: false, reason: 'inside', id: hit.id }
  const length = Math.max(MIN_NEW_ZOOM, options.length ?? DEFAULT_NEW_ZOOM)
  const gapStart = Math.max(0, ...zooms.filter((z) => z.end <= t).map((z) => z.end))
  const gapEnd = Math.min(duration, ...zooms.filter((z) => z.start > t).map((z) => z.start))
  let start = Math.max(gapStart, t - clamp(options.lead ?? 0, 0, length))
  const end = Math.min(gapEnd, start + length)
  // Close to the next zoom (or the end), grow backwards into the free space instead.
  if (end - start < length) start = Math.max(gapStart, end - length)
  if (end - start < MIN_NEW_ZOOM - 1e-9) return { ok: false, reason: 'no-room' }
  const id = newZoomId()
  const seg: ZoomSegment = { id, start, end, scale: options.scale ?? 2, focus: options.focus ?? { mode: 'cursor' }, auto: false }
  return { ok: true, id, zooms: [...zooms, seg].sort((a, b) => a.start - b.start) }
}

/** Range a segment may be dragged within without overlapping its neighbours. */
export function zoomDragBounds(zooms: ZoomSegment[], id: string, duration: number): { lower: number; upper: number } {
  const seg = zooms.find((z) => z.id === id)
  if (!seg) return { lower: 0, upper: duration }
  const others = zooms.filter((z) => z.id !== id)
  const lower = Math.max(0, ...others.filter((z) => z.end <= seg.start + 1e-6).map((z) => z.end))
  const upper = Math.min(duration, ...others.filter((z) => z.start >= seg.end - 1e-6).map((z) => z.start))
  return { lower, upper }
}

/** New start/end for a move or edge drag by `dt` seconds, kept between the neighbours. */
export function dragZoomTimes(
  initial: { start: number; end: number },
  mode: 'move' | 'start' | 'end',
  dt: number,
  bounds: { lower: number; upper: number }
): { start: number; end: number } {
  let { start, end } = initial
  // A segment already shorter than the minimum may grow but not shrink further.
  const short = end - start < MIN_ZOOM_LENGTH
  if (mode === 'move') {
    const len = end - start
    start = clamp(start + dt, bounds.lower, Math.max(bounds.lower, bounds.upper - len))
    end = start + len
  } else if (mode === 'start') {
    start = clamp(start + dt, Math.min(bounds.lower, start), short ? start : end - MIN_ZOOM_LENGTH)
  } else {
    end = clamp(end + dt, short ? end : start + MIN_ZOOM_LENGTH, Math.max(bounds.upper, end))
  }
  return { start, end }
}

/**
 * Clamps segments into [0, duration] after the media duration was corrected.
 * Unlike normalizeZooms it never shifts a segment because of its neighbours.
 */
export function clampZooms(zooms: ZoomSegment[], duration: number): ZoomSegment[] {
  const out: ZoomSegment[] = []
  for (const z of zooms) {
    const start = clamp(z.start, 0, duration)
    const end = clamp(z.end, 0, duration)
    if (end - start >= 0.05) out.push(start === z.start && end === z.end ? z : { ...z, start, end })
  }
  return out
}

/** Defaults for Project.zoomSettings (older projects have none). */
export const DEFAULT_ZOOM_SETTINGS: ZoomSettings = {
  defaultScale: 2,
  easing: 'smooth',
  transition: ZOOM_TRANSITION,
  auto: {
    enabled: true,
    scale: DEFAULT_AUTO_ZOOM.scale,
    clusterGap: DEFAULT_AUTO_ZOOM.clusterGap,
    leadIn: DEFAULT_AUTO_ZOOM.leadIn,
    hold: DEFAULT_AUTO_ZOOM.hold,
    rightClicks: false,
    onTyping: true,
    onMarks: true,
    scrolling: 'zoom-out'
  }
}

/** The project's zoom settings with defaults filled in. */
export function zoomSettingsOf(project: { zoomSettings?: ZoomSettings; autoZoom?: boolean }): ZoomSettings {
  const z = project.zoomSettings
  return {
    ...DEFAULT_ZOOM_SETTINGS,
    ...z,
    auto: { ...DEFAULT_ZOOM_SETTINGS.auto, enabled: project.autoZoom ?? true, ...z?.auto }
  }
}

const styleCache = new WeakMap<object, ZoomStyle>()

/** The camera defaults (easing, transition) of a project, cached per settings object. */
export function zoomStyleOf(project: { zoomSettings?: ZoomSettings }): ZoomStyle {
  const z = project.zoomSettings
  if (!z) return DEFAULT_ZOOM_STYLE
  let s = styleCache.get(z)
  if (!s) {
    s = { easing: z.easing ?? DEFAULT_ZOOM_STYLE.easing, transition: Number.isFinite(z.transition) ? z.transition : DEFAULT_ZOOM_STYLE.transition }
    styleCache.set(z, s)
  }
  return s
}

/**
 * Replaces every automatic zoom with a fresh set generated from the recording (clicks, or
 * a whole cursor track with auto zoom settings: typing, marks, right clicks).
 * Zooms the user created or edited (auto: false) are kept as they are, and new
 * automatic zooms that would overlap them are skipped.
 */
export function regenerateAutoZooms(
  zooms: ZoomSegment[],
  clicks: ClickEvent[] | CursorTrack,
  duration: number,
  settings?: AutoZoomSettings
): { zooms: ZoomSegment[]; removed: number; added: number; kept: number } {
  const manual = zooms.filter((z) => !z.auto)
  const generated = Array.isArray(clicks) ? generateAutoZooms(clicks, duration) : autoZoomsForTrack(clicks, duration, settings)
  const fresh = generated.filter((a) => !manual.some((m) => a.start < m.end && a.end > m.start))
  return {
    zooms: [...manual, ...fresh].sort((a, b) => a.start - b.start),
    removed: zooms.length - manual.length,
    added: fresh.length,
    kept: manual.length
  }
}

/**
 * The project's zooms after a change of the input auto zoom reads (a click ignored or used
 * again): only the automatic zooms that change are replaced, so zooms the user deleted stay
 * deleted and zooms the user edited (auto: false) are never touched. `before` and `after` are
 * autoZoomsForTrack() for the old and the new effective track, with the same settings and
 * duration. Two zooms are the same when start and end agree within 1e-6 s, scale and focus are
 * equal, and their anchors agree (t, x, y within 1e-6, and `until`). Rules:
 *  - keep every zoom of `zooms` (same object, same id) unless it is auto, matches a zoom of
 *    `before` and matches none of `after`;
 *  - also drop an auto zoom whose click anchor (anchor.until undefined) has its clickKey(anchor.t)
 *    in `dropAnchors` (zooms from an older generator, which `before` no longer reproduces);
 *  - add (with a new id) every zoom of `after` that matches none of `before` and overlaps no
 *    kept zoom;
 *  - sorted by start. Returns `zooms` itself when nothing changes.
 * CONTRACT: used by shared/editor/inputEdits.ts setClicksIgnored (one undo step with the edit).
 */
export function rebaseAutoZooms(zooms: ZoomSegment[], before: ZoomSegment[], after: ZoomSegment[], dropAnchors: readonly number[] = []): ZoomSegment[] {
  void zooms
  void before
  void after
  void dropAnchors
  throw new Error('not implemented')
}
