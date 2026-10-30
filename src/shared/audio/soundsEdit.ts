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
/** The export evaluates the gain once per this many samples (5 ms at 48 kHz), as the music's ducking. */
export const GAIN_FRAME = 256

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
 * The project's stretches as gains (mute 0, duck DUCK_GAIN), joined where they overlap or come
 * closer than two ramps (the lower gain wins), so no two ramps ever meet. Source seconds, sorted.
 */
export function soundGains(p: Pick<Project, 'sounds'>): SoundGain[] {
  return joinGains((p.sounds?.spans ?? []).map((s) => ({ start: s.start, end: s.end, gain: s.action === 'mute' ? 0 : DUCK_GAIN })))
}

/** Gains sorted, with those that overlap or come within 2 × SOUND_FADE of each other joined (the lower gain wins). */
export function joinGains(gains: readonly SoundGain[]): SoundGain[] {
  const sorted = gains.filter((g) => g.end > g.start).sort((a, b) => a.start - b.start)
  const out: SoundGain[] = []
  for (const g of sorted) {
    const last = out[out.length - 1]
    if (last && g.start - last.end < 2 * SOUND_FADE - 1e-9) {
      last.end = Math.max(last.end, g.end)
      last.gain = Math.min(last.gain, g.gain)
    } else out.push({ start: g.start, end: g.end, gain: Math.min(1, Math.max(0, g.gain)) })
  }
  return out
}

/** The gain at source time `t` of joined gains: 1 outside, the stretch's gain inside, linear over SOUND_FADE either side. */
export function soundGainAt(joined: readonly SoundGain[], t: number): number {
  let lo = 0
  let hi = joined.length
  // The first stretch whose ramp out ends after t.
  while (lo < hi) {
    const mid = (lo + hi) >> 1
    if (joined[mid].end + SOUND_FADE > t) hi = mid
    else lo = mid + 1
  }
  const g = joined[lo]
  if (!g || t < g.start - SOUND_FADE) return 1
  const clip01 = (v: number): number => Math.min(1, Math.max(0, v))
  return 1 - (1 - g.gain) * clip01((t - (g.start - SOUND_FADE)) / SOUND_FADE) * clip01((g.end + SOUND_FADE - t) / SOUND_FADE)
}

/** Keyframes of soundGainAt in source time (exact: the curve is linear between them). */
export function soundGainKeyframes(joined: readonly SoundGain[]): Keyframe[] {
  const keys: Keyframe[] = []
  for (const g of joined) keys.push({ t: g.start - SOUND_FADE, gain: 1 }, { t: g.start, gain: g.gain }, { t: g.end, gain: g.gain }, { t: g.end + SOUND_FADE, gain: 1 })
  return keys
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
 * soundGainAt as an ffmpeg expression in `t` (source seconds), for `volume=eval=frame`: a binary
 * search picks the only stretch whose ramps can reach `t` (joined stretches are at least two ramps
 * apart), so each evaluation costs log N comparisons. '1' without stretches. Contains commas.
 */
export function soundGainExpression(joined: readonly SoundGain[]): string {
  if (joined.length === 0) return '1'
  const f = num(SOUND_FADE)
  const term = (g: SoundGain): string => `1-${num(1 - g.gain)}*clip((${tMinus(g.start - SOUND_FADE)})/${f},0,1)*clip((${num(g.end + SOUND_FADE)}-t)/${f},0,1)`
  const tree = (lo: number, hi: number): string => {
    if (hi - lo === 1) return term(joined[lo])
    const mid = (lo + hi) >> 1
    const split = (joined[mid - 1].end + joined[mid].start) / 2
    return `if(lt(t,${num(split)}),${tree(lo, mid)},${tree(mid, hi)})`
  }
  return tree(0, joined.length)
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
