/**
 * What the unwanted-sound finder changes in a project (docs/design/sound-finder.md §3, §4.4–4.6):
 * reading `Project.sounds` from disk, each row's state, the actions (each a pure function of the
 * project, run as one store update), and the one gain curve the preview and the export both play:
 * keyframes for Web Audio, an ffmpeg expression for the export.
 */
import { restoreRange } from '../editor/clips'
import { editToVideo, type FreezePlan } from '../engine/freeze'
import { cutRange } from '../engine/timeline'
import type { SoundGain } from '../api/export'
import type { Clip, Project, SoundEdits, SoundSpan } from '../types'
import { gainAt, type Keyframe } from './automation'
import { KEY_RE, type SoundRow } from './sounds'

/** Seconds of the ramp before a muted or lowered stretch and after it. */
export const SOUND_FADE = 0.02
/** Gain of a lowered (ducked) stretch: −14 dB. */
export const DUCK_GAIN = 0.2
/** Shortest stretch kept when a project is read. */
export const MIN_SPAN = 0.01
/** Most spans and ignored keys a project keeps. */
export const MAX_SOUND_SPANS = 2000
/** Most stretches an export job may carry (main validates it). */
export const MAX_SOUND_GAINS = 4000
/** The export evaluates the gain once per this many samples (1.3 ms at 48 kHz): a 20 ms ramp in 15 steps. */
export const GAIN_FRAME = 64

const EPS = 1e-6
const finite = (v: unknown): v is number => typeof v === 'number' && Number.isFinite(v)
const isObject = (v: unknown): v is Record<string, unknown> => typeof v === 'object' && v !== null && !Array.isArray(v)

/* ---------- reading ---------- */

/** `Project.sounds` from anything (docs/design/sound-finder.md §3.2): sanitised, or undefined when nothing is left. */
export function readSoundEdits(raw: unknown, duration: number): SoundEdits | undefined {
  if (!isObject(raw)) return undefined
  const spans: SoundSpan[] = []
  if (Array.isArray(raw.spans)) {
    for (const s of raw.spans.slice(0, MAX_SOUND_SPANS)) {
      if (!isObject(s) || !finite(s.start) || !finite(s.end)) continue
      if ((s.action !== 'mute' && s.action !== 'duck') || typeof s.key !== 'string' || !KEY_RE.test(s.key)) continue
      const start = Math.max(0, s.start)
      const end = Math.min(duration, s.end)
      if (end - start >= MIN_SPAN) spans.push({ start, end, action: s.action, key: s.key })
    }
  }
  spans.sort((a, b) => a.start - b.start)
  const ignored = Array.isArray(raw.ignored) ? [...new Set(raw.ignored.filter((k): k is string => typeof k === 'string' && KEY_RE.test(k)))].slice(0, MAX_SOUND_SPANS) : []
  return spans.length > 0 || ignored.length > 0 ? { spans, ignored } : undefined
}

/** `p` with `edits`, or without `sounds` when they are empty (the project is then as it was before). */
function withEdits(p: Project, edits: SoundEdits): Project {
  if (edits.spans.length === 0 && edits.ignored.length === 0) {
    if (!p.sounds) return p
    const { sounds: _gone, ...rest } = p
    void _gone
    return rest
  }
  return { ...p, sounds: edits }
}

const editsOf = (p: Pick<Project, 'sounds'>): SoundEdits => p.sounds ?? { spans: [], ignored: [] }

/* ---------- rows ---------- */

export type RowState = 'open' | 'muted' | 'ducked' | 'cut' | 'ignored'

/** Whether no clip keeps any of [start, end). */
export const whollyCut = (clips: readonly Clip[], start: number, end: number): boolean => clips.every((c) => c.end <= start + EPS || c.start >= end - EPS)

/** Where row `r` stands in project `p` (§4.4). */
export function rowState(p: Pick<Project, 'sounds' | 'clips'>, r: Pick<SoundRow, 'key' | 'start' | 'end'>): RowState {
  const span = p.sounds?.spans.find((s) => s.key === r.key)
  if (span) return span.action === 'mute' ? 'muted' : 'ducked'
  if (whollyCut(p.clips, r.start, r.end)) return 'cut'
  if (p.sounds?.ignored.includes(r.key)) return 'ignored'
  return 'open'
}

/* ---------- actions (each one store update) ---------- */

/** Mutes or lowers each of `rows` (rows that already have a span keep it). */
export function addSpans(p: Project, rows: readonly Pick<SoundRow, 'key' | 'start' | 'end'>[], action: SoundSpan['action']): Project {
  const e = editsOf(p)
  const have = new Set(e.spans.map((s) => s.key))
  const added = rows.filter((r) => !have.has(r.key)).map((r) => ({ start: Math.max(0, r.start), end: Math.min(p.duration, r.end), action, key: r.key }))
  if (added.length === 0) return p
  const spans = [...e.spans, ...added].sort((a, b) => a.start - b.start).slice(0, MAX_SOUND_SPANS)
  return withEdits(p, { spans, ignored: e.ignored.filter((k) => !added.some((a) => a.key === k)) })
}

/** Removes the mute or duck of row `key`. */
export function removeSpan(p: Project, key: string): Project {
  const e = editsOf(p)
  if (!e.spans.some((s) => s.key === key)) return p
  return withEdits(p, { spans: e.spans.filter((s) => s.key !== key), ignored: e.ignored })
}

/** Whether two clip lists keep the same ranges at the same speeds. */
export const sameClips = (a: readonly Clip[], b: readonly Clip[]): boolean =>
  a === b || (a.length === b.length && a.every((c, i) => Math.abs(c.start - b[i].start) < EPS && Math.abs(c.end - b[i].end) < EPS && c.speed === b[i].speed))

/** Cuts the row out of the video (an ordinary cut); the same project when nothing changes or that would leave nothing. */
export function cutRow(p: Project, r: Pick<SoundRow, 'start' | 'end'>): Project {
  const clips = cutRange(p.clips, r.start, r.end)
  return sameClips(clips, p.clips) ? p : { ...p, clips }
}

/** Puts the row's stretch back into the video; the same project when nothing changes. */
export function restoreCut(p: Project, r: Pick<SoundRow, 'start' | 'end'>): Project {
  const clips = restoreRange(p.clips, r.start, r.end, p.duration)
  return sameClips(clips, p.clips) ? p : { ...p, clips }
}

/** Keeps the row as it is and takes it off the list. */
export function ignoreRow(p: Project, key: string): Project {
  const e = editsOf(p)
  if (e.ignored.includes(key) || e.ignored.length >= MAX_SOUND_SPANS) return p
  return withEdits(p, { spans: e.spans, ignored: [...e.ignored, key] })
}

/** Puts an ignored row back on the list. */
export function bringBack(p: Project, key: string): Project {
  const e = editsOf(p)
  if (!e.ignored.includes(key)) return p
  return withEdits(p, { spans: e.spans, ignored: e.ignored.filter((k) => k !== key) })
}

/* ---------- the gain curve ---------- */

/**
 * The project's stretches as gains (mute 0, duck DUCK_GAIN), made piecewise (joinGains), so a mute
 * inside a lowered stretch silences only itself. Source seconds, sorted.
 */
export function soundGains(p: Pick<Project, 'sounds'>): SoundGain[] {
  return joinGains((p.sounds?.spans ?? []).map((s) => ({ start: s.start, end: s.end, gain: s.action === 'mute' ? 0 : DUCK_GAIN })))
}

/**
 * Gains as a piecewise-constant curve (docs/design/sound-finder.md §4.6): split at every stretch's
 * edge, each piece at the lowest gain over it, neighbours of the same gain joined. A piece shorter
 * than two ramps that is louder than a neighbour (a gap between two stretches, a short duck between
 * mutes) takes its quieter neighbour's gain, so the ramps, always on the louder side of an edge, never
 * meet. Returns the pieces below 1, sorted and separate (they may touch).
 */
export function joinGains(gains: readonly SoundGain[]): SoundGain[] {
  const list = gains.filter((g) => g.end > g.start).map((g) => ({ start: g.start, end: g.end, gain: Math.min(1, Math.max(0, g.gain)) }))
  if (list.length === 0) return []
  const edges = [...new Set(list.flatMap((g) => [g.start, g.end]))].sort((x, y) => x - y)
  // The lowest gain over each piece between two edges (1 where no stretch is).
  let pieces: SoundGain[] = []
  for (let i = 0; i + 1 < edges.length; i++) {
    const a = edges[i]
    const b = edges[i + 1]
    let gain = 1
    for (const g of list) if (g.start <= a && g.end >= b) gain = Math.min(gain, g.gain)
    const last = pieces[pieces.length - 1]
    if (last && Math.abs(last.gain - gain) < 1e-9) last.end = b
    else pieces.push({ start: a, end: b, gain })
  }
  // Short louder pieces take their quieter neighbour's gain, until none is left.
  for (let changed = true; changed; ) {
    changed = false
    for (let i = 0; i < pieces.length; i++) {
      const p = pieces[i]
      const left = pieces[i - 1]?.gain ?? 1
      const right = pieces[i + 1]?.gain ?? 1
      const quieter = Math.min(i > 0 ? left : 2, i + 1 < pieces.length ? right : 2)
      if (p.end - p.start < 2 * SOUND_FADE - 1e-9 && quieter < p.gain) {
        p.gain = quieter
        changed = true
      }
    }
    if (changed) {
      const merged: SoundGain[] = []
      for (const p of pieces) {
        const last = merged[merged.length - 1]
        if (last && Math.abs(last.gain - p.gain) < 1e-9) last.end = p.end
        else merged.push({ ...p })
      }
      pieces = merged
    }
  }
  return pieces.filter((p) => p.gain < 1 - 1e-9)
}

/**
 * Keyframes of the curve in source time: 1 outside the pieces, each piece's gain inside it, and a
 * linear ramp of SOUND_FADE at every edge, on its louder side (before a quieter piece, after a louder
 * one), so every muted or lowered stretch is fully muted or lowered.
 */
export function soundGainKeyframes(joined: readonly SoundGain[]): Keyframe[] {
  const keys: Keyframe[] = []
  const edge = (t: number, from: number, to: number): void => {
    if (Math.abs(from - to) < 1e-9) return
    if (to < from) keys.push({ t: t - SOUND_FADE, gain: from }, { t, gain: to })
    else keys.push({ t, gain: from }, { t: t + SOUND_FADE, gain: to })
  }
  joined.forEach((g, i) => {
    const before = i > 0 && Math.abs(joined[i - 1].end - g.start) < 1e-9 ? joined[i - 1].gain : 1
    edge(g.start, before, g.gain)
    const touching = i + 1 < joined.length && Math.abs(joined[i + 1].start - g.end) < 1e-9
    if (!touching) edge(g.end, g.gain, 1)
  })
  return keys
}

const keyMemo = new WeakMap<readonly SoundGain[], Keyframe[]>()

/** The gain at source time `t` of joined gains (the keyframes' curve, made once per list). */
export function soundGainAt(joined: readonly SoundGain[], t: number): number {
  if (joined.length === 0) return 1
  let keys = keyMemo.get(joined)
  if (!keys) keyMemo.set(joined, (keys = soundGainKeyframes(joined)))
  return gainAt(keys, t)
}

/**
 * The curve on the preview's output (video) timeline: within each clip a source time `t` plays at
 * `out(clip) + (t − clip.start) / speed`, past the pause freezes before it. At a cut the gain steps
 * (over 0.1 ms) from the value at the clip's end to the one at the next clip's start; the cut's own
 * fade is silent there. Empty when there is nothing to play differently.
 */
export function soundOutputKeyframes(joined: readonly SoundGain[], clips: readonly Clip[], plan: FreezePlan): Keyframe[] {
  if (joined.length === 0) return []
  const keys = soundGainKeyframes(joined)
  const raw: Keyframe[] = []
  let acc = 0
  const push = (t: number, gain: number): void => {
    const last = raw[raw.length - 1]
    if (last && t <= last.t) {
      if (Math.abs(last.gain - gain) < 1e-9) return
      t = last.t + 1e-4
    }
    raw.push({ t, gain })
  }
  for (const c of clips) {
    const at = (t: number): number => editToVideo(plan, acc + (t - c.start) / c.speed)
    push(at(c.start), gainAt(keys, c.start))
    for (const k of keys) if (k.t > c.start && k.t < c.end) push(at(k.t), k.gain)
    push(at(c.end), gainAt(keys, c.end))
    acc += (c.end - c.start) / c.speed
  }
  // Points between two of the same gain change nothing.
  return raw.filter((k, i) => i === 0 || i === raw.length - 1 || !(Math.abs(raw[i - 1].gain - k.gain) < 1e-9 && Math.abs(raw[i + 1].gain - k.gain) < 1e-9))
}

/** Compact decimal for ffmpeg arguments (10 µs). */
const num = (v: number): string => String(+v.toFixed(5))
const tMinus = (v: number): string => (v < 0 ? `t+${num(-v)}` : `t-${num(v)}`)

/**
 * The curve as an ffmpeg expression in `t` (source seconds), for `volume=eval=frame`: a binary
 * search over the keyframes picks the segment `t` is in, which is constant or a linear ramp, so each
 * evaluation costs log N comparisons. '1' without stretches. Contains commas.
 */
export function soundGainExpression(joined: readonly SoundGain[]): string {
  const keys = soundGainKeyframes(joined)
  if (keys.length === 0) return '1'
  // Segment i runs from keys[i - 1] to keys[i] (before the first and after the last: held).
  const segment = (i: number): string => {
    if (i === 0) return num(keys[0].gain)
    if (i === keys.length) return num(keys[keys.length - 1].gain)
    const a = keys[i - 1]
    const b = keys[i]
    if (Math.abs(a.gain - b.gain) < 1e-9 || b.t - a.t < 1e-9) return num(b.gain)
    return `${num(a.gain)}+${num(b.gain - a.gain)}*(${tMinus(a.t)})/${num(b.t - a.t)}`
  }
  const tree = (lo: number, hi: number): string => {
    if (hi - lo === 1) return segment(lo)
    const mid = (lo + hi) >> 1
    return `if(lt(t,${num(keys[mid - 1].t)}),${tree(lo, mid)},${tree(mid, hi)})`
  }
  return tree(0, keys.length + 1)
}

/** The filters (no leading comma) that put `gains` on the recording's sound in source time, or '' for none. */
export function soundGainFilters(gains: readonly SoundGain[] | undefined): string {
  const joined = joinGains(gains ?? [])
  if (joined.length === 0) return ''
  return `asetnsamples=n=${GAIN_FRAME}:p=0,volume=volume='${soundGainExpression(joined)}':eval=frame`
}

/** Whether an export job's `sounds` is well formed (main checks every job). */
export function validSoundGains(v: unknown): v is SoundGain[] {
  return Array.isArray(v) && v.length <= MAX_SOUND_GAINS && v.every((g) => isObject(g) && finite(g.start) && finite(g.end) && finite(g.gain) && g.start >= 0 && g.end > g.start && g.end <= 1e7 && g.gain >= 0 && g.gain <= 1)
}
