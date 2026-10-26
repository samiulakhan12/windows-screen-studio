/**
 * The camera director's timeline (docs/design/camera-director.md, steps 5-9): where the demo is,
 * the intro and outro (full camera while the person talks before the first deliberate action
 * and after the last one), the long silences where the camera hides, and the bubble time left
 * between them. Everything here is in OUTPUT seconds of the current edit (what the viewer sees,
 * after cuts and speed changes), so minimum lengths are what the viewer sees. Pure.
 */
import { mergeRanges, rangesToOutput, type Range } from '../audio/activity'
import { scrollSessions } from '../engine/scroll'
import { outputDuration, sourceToOutput } from '../engine/timeline'
import { zoomTransition, type ZoomStyle } from '../engine/zoom'
import type { Clip, CursorTrack, ZoomSegment } from '../types'

/**
 * Fast cursor sweeps count as deliberate input: a path at least `sweepLength` (normalised) long
 * within `sweepWindow` seconds. A sweep after every other event that ends in the last `endEdge`
 * seconds of the edit is the mouse going to stop the recording, not the demo.
 */
export const DEMO = { sweepWindow: 2.0, sweepLength: 0.35, endEdge: 2.0 } as const

/**
 * The intro ends `lead` s before the first action (snapped into a pause of at least `minPause`
 * within `snapWindow` s before it, or `tail` s after the last words); it is at least `min` s
 * long, speech starts within `maxOnset` s, and covers at least `speechShare` of it.
 */
export const INTRO = { lead: 1.0, tail: 0.5, snapWindow: 3.0, minPause: 0.25, min: 3.0, maxOnset: 4.0, speechShare: 0.4 } as const

/**
 * The outro starts `lag` s after the last action (snapped to a pause within `snapWindow` s of
 * the action while still talking, else `onsetLead` s before the next words); at least `min` s
 * long, speech covering at least `speechShare` of it.
 */
export const OUTRO = { lag: 1.5, onsetLead: 0.3, snapWindow: 4.0, minPause: 0.25, min: 3.0, speechShare: 0.4 } as const

/** The demo between an intro and an outro is at least this long (output seconds), or the outro (then the intro) is dropped. */
export const MIN_DEMO = 4.0

/**
 * Hiding: the camera hides `lag` s after the last words of a long silence and is back `lead` s
 * before the next ones; a hidden part is at least `minHidden` s; bubble time shorter than
 * `minShown` s next to a hidden part joins it unless it holds `speechToKeep` s of speech (then it
 * grows to `minShown`).
 */
export const HIDE = { lag: 1.0, lead: 0.8, minHidden: 5.0, minShown: 4.0, speechToKeep: 1.5 } as const

/** The demo: from the start of the first deliberate action to the end of the last one (output seconds). */
export interface DemoSpan {
  start: number
  end: number
}

/**
 * The demo span of a recording (output seconds), or null when nothing deliberate happens. Events,
 * mapped through the clips (events inside cuts are dropped): in-frame clicks of any button, keys,
 * "zoom here" marks, typing bursts [t, end], scroll sessions of in-frame wheel events
 * [start, end], every zoom (manual or auto) over [start, end - zoomTransition(z, style)], and
 * cursor sweeps (DEMO) except those after every other event ending in the last DEMO.endEdge
 * seconds of the edit (the move to stop the recording, whose click is a stray 'end' one).
 * Cursor-derived events (clicks, keys, typing, scrolls, sweeps) count only when `track.valid`.
 */
export function demoSpan(track: CursorTrack, zooms: readonly ZoomSegment[], clips: readonly Clip[], style: ZoomStyle): DemoSpan | null {
  const events: Range[] = []
  const instant = (t: number): void => {
    const o = Number.isFinite(t) ? sourceToOutput(clips as Clip[], t) : null
    if (o !== null) events.push({ start: o, end: o })
  }
  const span = (start: number, end: number): void => {
    if (!Number.isFinite(start) || !Number.isFinite(end)) return
    if (end <= start) return instant(start)
    const out = rangesToOutput([{ start, end }], clips)
    if (out.length) events.push({ start: out[0].start, end: out[out.length - 1].end })
  }
  for (const m of track.marks ?? []) instant(m.t)
  for (const z of zooms) span(z.start, Math.max(z.start, z.end - zoomTransition(z, style)))
  if (track.valid) {
    for (const c of track.clicks) if (inUnit(c.x) && inUnit(c.y)) instant(c.t)
    for (const k of track.keys ?? []) instant(k.t)
    for (const b of track.typing ?? []) span(b.t, b.end)
    for (const s of scrollSessions((track.scrolls ?? []).filter((e) => inUnit(e.x) && inUnit(e.y)))) span(s.start, s.end)
    // Sweeps last: one after every other event that reaches the end of the edit is the move to stop the recording.
    const others = events.reduce((at, e) => Math.max(at, e.end), -Infinity)
    const tail = outputDuration(clips as Clip[]) - DEMO.endEdge
    const first = events.length
    for (const s of cursorSweeps(track.samples)) span(s.start, s.end)
    for (let i = events.length - 1; i >= first; i--) if (events[i].start >= others - 1e-9 && events[i].end > tail + 1e-9) events.splice(i, 1)
  }
  if (!events.length) return null
  let start = Infinity
  let end = -Infinity
  for (const e of events) {
    start = Math.min(start, e.start)
    end = Math.max(end, e.end)
  }
  return { start, end }
}

/**
 * The intro (output seconds, starting at 0), or null: the full camera while the person talks
 * before the demo (INTRO). `speech` and `locked` are output ranges; the intro is cut at the first
 * locked range and dropped when what is left is shorter than INTRO.min.
 */
export function findIntro(speech: readonly Range[], demo: DemoSpan, locked: readonly Range[]): Range | null {
  const S = mergeRanges(speech)
  if (!S.length) return null
  const e = demo.start - INTRO.lead
  let introEnd: number
  if (meets(S, e - STILL_TALKING, e)) {
    // Still talking: end in the latest pause shortly before the first action, else right before it.
    const pause = pauses(S, demo.start - INTRO.snapWindow, e, INTRO.minPause)
    introEnd = pause.length ? mid(pause[pause.length - 1]) : e
  } else {
    const last = S.filter((r) => r.start < e).pop()
    if (!last) return null
    introEnd = Math.min(e, last.end + INTRO.tail)
  }
  if (introEnd < INTRO.min - 1e-9) return null
  if (S[0].start > Math.min(INTRO.maxOnset, introEnd - ONSET_ROOM) + 1e-9) return null
  if (speechIn(S, 0, introEnd) < INTRO.speechShare * introEnd - 1e-9) return null
  // It starts at the first kept frame: only the piece of it before the first locked range.
  const piece = subtract([{ start: 0, end: introEnd }], locked)[0]
  return piece && piece.start <= 1e-9 && piece.end - piece.start >= INTRO.min - 1e-9 ? { start: 0, end: piece.end } : null
}

/** The outro (output seconds, ending at `total`), or null: the full camera while the person talks after the demo (OUTRO). */
export function findOutro(speech: readonly Range[], demo: DemoSpan, total: number, locked: readonly Range[]): Range | null {
  const S = mergeRanges(speech)
  if (!S.length) return null
  const b = demo.end + OUTRO.lag
  let outroStart: number
  if (meets(S, b, b + STILL_TALKING)) {
    // Still talking: start in the first pause after the last action, else right after it.
    const pause = pauses(S, b, demo.end + OUTRO.snapWindow, OUTRO.minPause)
    outroStart = pause.length ? mid(pause[0]) : b
  } else {
    const next = S.find((r) => r.start >= b)
    if (!next) return null
    outroStart = Math.max(b, next.start - OUTRO.onsetLead)
  }
  if (total - outroStart < OUTRO.min - 1e-9) return null
  if (speechIn(S, outroStart, total) < OUTRO.speechShare * (total - outroStart) - 1e-9) return null
  // It ends at the last kept frame: only the piece of it after the last locked range.
  const piece = subtract([{ start: outroStart, end: total }], locked).pop()
  return piece && piece.end >= total - 1e-9 && piece.end - piece.start >= OUTRO.min - 1e-9 ? { start: piece.start, end: total } : null
}

/**
 * Hidden parts (output seconds) for the silences (gaps of `speech` over [0, total]) at least
 * `hideAfter` s long, inside `within` (the demo window minus locked ranges), at least
 * HIDE.minHidden long. A silence that touches the intro (outro) hides straight from (until) it;
 * one at the very start (end) without an intro (outro) hides from 0 (until `total`).
 * `hideAfter` 0: none.
 */
export function findHidden(
  speech: readonly Range[],
  within: readonly Range[],
  hideAfter: number,
  intro: Range | null,
  outro: Range | null,
  total: number
): Range[] {
  if (!(hideAfter > 0)) return []
  const S = mergeRanges(speech)
  const out: Range[] = []
  for (const gap of pauses(S, 0, total, hideAfter)) {
    const { start: a, end: b } = gap
    // From the intro (or the very start) straight to no camera; else after the last words.
    const h0 = intro && a <= intro.end + 1e-9 ? intro.end : a <= 1e-9 && !intro ? 0 : a + HIDE.lag
    // Until the outro (or the very end); else back before the next words.
    const h1 = outro && b >= outro.start - 1e-9 ? outro.start : b >= total - 1e-9 && !outro ? total : b - HIDE.lead
    if (h1 - h0 < HIDE.minHidden - 1e-9) continue
    for (const r of intersect([{ start: h0, end: h1 }], within)) if (r.end - r.start >= HIDE.minHidden - 1e-9) out.push(r)
  }
  return mergeRanges(out)
}

/** What the timeline decides, in output seconds. */
export interface TimelinePlan {
  intro: Range | null
  outro: Range | null
  hidden: Range[]
  /** Bubble time: inside the demo window, not hidden, not locked (camera positions included). */
  shown: Range[]
}

export interface TimelineInput {
  /** Output length of the edit. */
  total: number
  /** Speech in output seconds, or null when unknown (no sound): no intro, outro or hiding then. */
  speech: readonly Range[] | null
  demo: DemoSpan | null
  /** Output ranges of the user's layout changes (not camera positions): never written over. */
  locked: readonly Range[]
  /** Whether to look for an intro and an outro (DirectorSettings.intro !== 'off'). */
  intro: boolean
  /** DirectorSettings.hideAfter (0: never hide). */
  hideAfter: number
}

/**
 * The whole timeline: intro, outro (MIN_DEMO between them), hidden parts, then the anti-flicker
 * rule (HIDE.minShown): every change the director adds is at least 3 s of output from the next.
 */
export function planTimeline(input: TimelineInput): TimelinePlan {
  const { total, demo, locked } = input
  const S = input.speech ? mergeRanges(input.speech) : null
  let intro = S && demo && input.intro ? findIntro(S, demo, locked) : null
  let outro = S && demo && input.intro ? findOutro(S, demo, total, locked) : null
  // The demo between them is at least MIN_DEMO long: the outro goes first, then the intro.
  if (intro && outro && outro.start - intro.end < MIN_DEMO - 1e-9) outro = null
  if (intro && !outro && total - intro.end < MIN_DEMO - 1e-9) intro = null
  if (outro && !intro && outro.start < MIN_DEMO - 1e-9) outro = null
  const within = subtract([{ start: intro?.end ?? 0, end: outro?.start ?? total }], locked)
  const hidden = S ? findHidden(S, within, input.hideAfter, intro, outro, total) : []
  return settleTimeline({ intro, outro, hidden, shown: subtract(within, hidden) }, S, total)
}

/** Input that keeps moving through rests up to this long (seconds) is one move. */
const SWEEP_REST = 0.25
/** A sample further than this (normalised) from the one before is moving. */
const SWEEP_EPS = 0.004
/** "Still talking": speech within this many seconds before the intro's end (after the outro's start). */
const STILL_TALKING = 0.5
/** The first words come at least this long before the intro ends. */
const ONSET_ROOM = 1.0

const inUnit = (v: number): boolean => v >= 0 && v <= 1
const mid = (r: Range): number => (r.start + r.end) / 2

/** Whether sorted `ranges` overlap [a, b]. */
const meets = (ranges: readonly Range[], a: number, b: number): boolean => ranges.some((r) => r.start < b && r.end > a)

/** Seconds of sorted, separate `ranges` inside [a, b]. */
function overlapLength(ranges: readonly Range[], a: number, b: number): number {
  let sum = 0
  for (const r of ranges) {
    if (r.start >= b) break
    sum += Math.max(0, Math.min(b, r.end) - Math.max(a, r.start))
  }
  return sum
}
const speechIn = overlapLength

/** The gaps of sorted, separate `ranges` inside [lo, hi], at least `min` long. */
function pauses(ranges: readonly Range[], lo: number, hi: number, min: number): Range[] {
  const out: Range[] = []
  let at = lo
  for (const r of ranges) {
    if (r.end <= at) continue
    if (r.start >= hi) break
    if (r.start - at >= min - 1e-9 && r.start > at) out.push({ start: at, end: r.start })
    at = Math.max(at, r.end)
  }
  if (hi - at >= min - 1e-9 && hi > at) out.push({ start: at, end: hi })
  return out
}

/** Sorted, separate `a` without `b`. */
export function subtract(a: readonly Range[], b: readonly Range[]): Range[] {
  const cut = mergeRanges(b)
  const out: Range[] = []
  for (const r of mergeRanges(a)) {
    let at = r.start
    for (const c of cut) {
      if (c.end <= at) continue
      if (c.start >= r.end) break
      if (c.start > at) out.push({ start: at, end: c.start })
      at = Math.max(at, c.end)
    }
    if (r.end > at) out.push({ start: at, end: r.end })
  }
  return out
}

/** The parts of `a` inside `b`. */
function intersect(a: readonly Range[], b: readonly Range[]): Range[] {
  const out: Range[] = []
  const bb = mergeRanges(b)
  for (const r of mergeRanges(a)) {
    for (const c of bb) {
      const s = Math.max(r.start, c.start)
      const e = Math.min(r.end, c.end)
      if (e > s) out.push({ start: s, end: e })
    }
  }
  return mergeRanges(out)
}

/**
 * Fast cursor sweeps (source seconds): moves (samples each more than SWEEP_EPS from the one
 * before, rests up to SWEEP_REST included) whose path covers DEMO.sweepLength within some
 * DEMO.sweepWindow, from the sample before the move to its last moving sample. Only steps with
 * both samples inside the frame move: time off it (another monitor, outside the recorded region or
 * window, a covering window) is a rest, as the viewer sees no movement there.
 */
function cursorSweeps(samples: CursorTrack['samples']): Range[] {
  const out: Range[] = []
  let steps: { t0: number; t1: number; len: number }[] = []
  let first = -1
  let last = -1
  const flush = (): void => {
    if (first >= 0 && sweeps(steps)) out.push({ start: samples[first].t, end: samples[last].t })
    steps = []
    first = -1
  }
  for (let i = 1; i < samples.length; i++) {
    const a = samples[i - 1]
    const b = samples[i]
    if (!(inUnit(a.x) && inUnit(a.y) && inUnit(b.x) && inUnit(b.y))) continue
    const len = Math.hypot(b.x - a.x, b.y - a.y)
    if (!(len > SWEEP_EPS)) continue
    if (first >= 0 && a.t - samples[last].t > SWEEP_REST + 1e-9) flush()
    if (first < 0) first = i - 1
    steps.push({ t0: a.t, t1: b.t, len })
    last = i
  }
  flush()
  return out
}

/** Whether some DEMO.sweepWindow of `steps` covers DEMO.sweepLength. */
function sweeps(steps: readonly { t0: number; t1: number; len: number }[]): boolean {
  let lo = 0
  let sum = 0
  for (const s of steps) {
    sum += s.len
    while (s.t1 - steps[lo].t0 > DEMO.sweepWindow + 1e-9) sum -= steps[lo++].len
    if (sum >= DEMO.sweepLength - 1e-9) return true
  }
  return false
}

type PieceKind = 'intro' | 'outro' | 'hidden' | 'shown' | 'other'
interface Piece {
  start: number
  end: number
  kind: PieceKind
}

/**
 * The anti-flicker rule (step 9) over `plan`: bubble time shorter than HIDE.minShown next to a
 * hidden part joins it, unless it holds HIDE.speechToKeep of speech, then it grows to
 * HIDE.minShown from the hidden parts beside it (one that would get shorter than HIDE.minHidden
 * is shown instead); next to the intro or outro it joins that; otherwise (between the user's
 * segments) it stays. `splits` (the edges of the user's camera positions) cut the bubble time
 * into pieces judged on their own, so a sliver between a position and a hidden part joins the
 * hidden part. Time in none of the plan's ranges is the user's and never changes.
 */
export function settleTimeline(plan: TimelinePlan, speech: readonly Range[] | null, total: number, splits: readonly number[] = []): TimelinePlan {
  const S = speech ? mergeRanges(speech) : []
  const cuts = [...splits].sort((a, b) => a - b)
  const pieces: Piece[] = []
  const add = (r: Range, kind: PieceKind): void => {
    if (!(r.end - r.start > 1e-9)) return
    let at = r.start
    if (kind === 'shown') {
      for (const c of cuts) {
        if (c > at + 1e-6 && c < r.end - 1e-6) {
          pieces.push({ start: at, end: c, kind })
          at = c
        }
      }
    }
    pieces.push({ start: at, end: r.end, kind })
  }
  if (plan.intro) add(plan.intro, 'intro')
  if (plan.outro) add(plan.outro, 'outro')
  for (const r of plan.hidden) add(r, 'hidden')
  for (const r of plan.shown) add(r, 'shown')
  pieces.sort((a, b) => a.start - b.start)
  // Fill what the plan leaves out: the user's time.
  const all: Piece[] = []
  let at = 0
  for (const p of pieces) {
    if (p.start > at + 1e-9) all.push({ start: at, end: p.start, kind: 'other' })
    all.push(p)
    at = Math.max(at, p.end)
  }
  if (total > at + 1e-9) all.push({ start: at, end: total, kind: 'other' })

  const len = (p: Piece): number => p.end - p.start
  const touching = (a: Piece | undefined, b: Piece): boolean => !!a && Math.abs(a.end - b.start) <= 1e-6
  /** Joins neighbours of the same kind (bubble pieces stay apart: the splits matter). */
  const join = (): void => {
    for (let i = all.length - 1; i > 0; i--) {
      const a = all[i - 1]
      const b = all[i]
      if (a.kind === b.kind && a.kind !== 'shown' && touching(a, b)) {
        a.end = b.end
        all.splice(i, 1)
      }
    }
  }
  for (let guard = 0; guard < 100000; guard++) {
    let changed = false
    for (let i = 0; i < all.length && !changed; i++) {
      const p = all[i]
      if (p.kind !== 'shown' || len(p) >= HIDE.minShown - 1e-9) continue
      const prev = touching(all[i - 1], p) ? all[i - 1] : undefined
      const next = all[i + 1] && touching(p, all[i + 1]) ? all[i + 1] : undefined
      const hidden = [prev, next].filter((h): h is Piece => h?.kind === 'hidden')
      if (hidden.length) {
        if (speechIn(S, p.start, p.end) < HIDE.speechToKeep - 1e-9) {
          p.kind = 'hidden'
        } else {
          const share = (HIDE.minShown - len(p)) / hidden.length
          const shown = hidden.filter((h) => len(h) - share < HIDE.minHidden - 1e-9)
          if (shown.length) {
            // Too short to give the time: shown instead, as part of this piece.
            for (const h of shown) {
              p.start = Math.min(p.start, h.start)
              p.end = Math.max(p.end, h.end)
              all.splice(all.indexOf(h), 1)
            }
          } else {
            if (prev?.kind === 'hidden') {
              prev.end -= share
              p.start -= share
            }
            if (next?.kind === 'hidden') {
              next.start += share
              p.end += share
            }
          }
        }
        changed = true
      } else if (prev && (prev.kind === 'intro' || prev.kind === 'outro')) {
        p.kind = prev.kind
        changed = true
      } else if (next && (next.kind === 'intro' || next.kind === 'outro')) {
        p.kind = next.kind
        changed = true
      }
    }
    if (!changed) break
    join()
  }
  const of = (kind: PieceKind): Range[] => mergeRanges(all.filter((p) => p.kind === kind).map((p) => ({ start: p.start, end: p.end })))
  const intro = of('intro')[0] ?? null
  const outro = of('outro').pop() ?? null
  return { intro, outro, hidden: of('hidden'), shown: of('shown') }
}
