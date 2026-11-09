/**
 * Find short clips (docs/design/smart-tools.md §8.2-§8.4): the stretches of 15 to 90 seconds that
 * could be posted on their own, scored offline from the sentences (§8.1) and how they open and
 * end, picked best first without overlapping much, each with its reasons and a title. A recording
 * without words (or with Use activity only) gets the busiest stretches instead (§8.3). Pure.
 */
import type { SceneScan } from '../api/projects'
import { transcriptLanguage } from '../captions/captionTracks'
import { findNumbers } from '../captions/numbers'
import { sentencesOf } from '../editor/retakes'
import { normalizeWord } from '../editor/transcript'
import { editToVideo, planOf, videoDuration, videoTimesAt, type FreezePlan } from '../engine/freeze'
import { clockTime } from '../search/moment'
import { cutName, sentenceName } from '../smart/sentenceName'
import { screenChanges } from '../smart/screenChanges'
import type { Clip, CursorTrack, Project } from '../types'
import { clipSentences, keptClipWords, lastAtOrBefore, type ClipSentence } from './sentences'

export const CLIP_RULES = {
  min: 15,
  max: 90,
  shortMax: 60,
  longMin: 60,
  gapBefore: 0.3,
  gapAfter: 0.4,
  best: 45,
  spread: 20,
  lengthWeight: 1.5,
  overlap: 0.3,
  perMoments: 120,
  minMoments: 3,
  maxMoments: 10,
  minVideo: 45,
  empty: 0.3,
  choppy: 4
} as const

export interface Moment {
  /** Source seconds. */
  start: number
  end: number
  /** Viewing seconds (clip speeds and pause freezes). */
  seconds: number
  score: number
  /** At most 3 reasons, then the length ("45 s"). */
  reasons: string[]
  /** The first words said, without quotes ('' for a silent moment). */
  first: string
  title: string
  /** From activity only (§8.3). */
  silent: boolean
}

export type MomentLength = 'any' | 'short' | 'long'

/** Padding (seconds) before a moment's first word and after its last, never past the middle of the silence there. */
const PAD_BEFORE = 0.15
const PAD_AFTER = 0.25
/** Seconds of speech or input around an input event that count as something happening (§8.2 empty). */
const INPUT_REACH = 0.5
/** A gap of input that a silent moment may start or end in (§8.3). */
const INPUT_GAP = 1
/** Scroll events closer than this are one scroll. */
const SCROLL_JOIN = 0.5
/** A reason is given for a term of at least this. */
const REASON_MIN = 0.1
/** Longest first words shown (graphemes). */
const FIRST_MAX = 80
const EPS = 1e-6

/** Opening words that make a question (§8.2 hook). */
const QUESTION_WORDS = new Set(['how', 'why', 'what', 'কীভাবে', 'কেন', 'কী'])
/** Button and menu verbs (Captions Studio's UI verbs, emphasis.ts). */
const UI_VERBS = new Set([
  'click', 'press', 'open', 'select', 'choose', 'type', 'drag', 'save', 'copy', 'paste', 'delete', 'remove', 'add', 'create', 'scroll', 'tap', 'enable', 'disable', 'rename',
  'upload', 'download', 'install', 'run', 'check', 'hit', 'pick', 'toggle', 'turn'
])
/** Openings that refer back to something before the clip (§8.2). */
const REFERS_BACK = ['as i said', 'like i said', 'as mentioned', 'this one', 'that one', 'যেমন বললাম', 'আগেই বলেছি']
const QUESTION_END = /[?？؟]["'”’»)\]]*$/u

/** The bounds of a moment's length (viewing seconds). */
export function lengthBounds(length: MomentLength): { min: number; max: number } {
  if (length === 'short') return { min: CLIP_RULES.min, max: CLIP_RULES.shortMax }
  if (length === 'long') return { min: CLIP_RULES.longMin, max: CLIP_RULES.max }
  return { min: CLIP_RULES.min, max: CLIP_RULES.max }
}

/** How many moments a video of `L` viewing seconds gets: round(L / 120), 3 to 10. */
export function momentCount(L: number): number {
  return Math.min(CLIP_RULES.maxMoments, Math.max(CLIP_RULES.minMoments, Math.round(L / CLIP_RULES.perMoments)))
}

/** The length term (§8.2): 1.5 × exp(−((len − 45) / 20)² / 2), best at 45 s. */
export function lengthTerm(seconds: number): number {
  return CLIP_RULES.lengthWeight * Math.exp(-(((seconds - CLIP_RULES.best) / CLIP_RULES.spread) ** 2) / 2)
}

/** A sentence's text lower case, without punctuation, single spaces. */
const plain = (text: string): string =>
  text
    .toLocaleLowerCase()
    .replace(/[‘’ʼ]/g, "'")
    .replace(/[^\p{L}\p{M}\p{N}' ]+/gu, ' ')
    .replace(/\s+/g, ' ')
    .trim()

/** How a moment opens (§8.2 hook): a question, a number, a UI verb, or not. */
export function hookOf(text: string, language?: string): 'question' | 'number' | 'action' | null {
  const trimmed = text.trim()
  const first = normalizeWord(trimmed.split(/\s+/u)[0] ?? '')
  if (QUESTION_END.test(trimmed) || QUESTION_WORDS.has(first)) return 'question'
  if (findNumbers({ id: '', start: 0, end: 0, text: trimmed }, language).length > 0) return 'number'
  if (UI_VERBS.has(first)) return 'action'
  return null
}

/** Whether a sentence opens by referring back ("As I said", "যেমন বললাম"). */
export function refersBack(text: string): boolean {
  const p = plain(text)
  return REFERS_BACK.some((phrase) => p === phrase || p.startsWith(`${phrase} `))
}

/** Sorted, merged intervals and the covered length up to each one's end: covered(a, b) in O(log n). */
class Coverage {
  private starts: number[] = []
  private ends: number[] = []
  private cum: number[] = []
  constructor(intervals: { start: number; end: number }[]) {
    const sorted = intervals.filter((r) => r.end > r.start).sort((a, b) => a.start - b.start)
    let total = 0
    for (const r of sorted) {
      const k = this.ends.length - 1
      if (k >= 0 && r.start <= this.ends[k]) {
        if (r.end > this.ends[k]) {
          total += r.end - this.ends[k]
          this.ends[k] = r.end
          this.cum[k] = total
        }
        continue
      }
      total += r.end - r.start
      this.starts.push(r.start)
      this.ends.push(r.end)
      this.cum.push(total)
    }
  }
  /** Covered length up to `x`. */
  private upTo(x: number): number {
    const k = lastAtOrBefore(this.starts, x)
    if (k < 0) return 0
    return (k > 0 ? this.cum[k - 1] : 0) + Math.min(x, this.ends[k]) - this.starts[k]
  }
  covered(a: number, b: number): number {
    return b > a ? this.upTo(b) - this.upTo(a) : 0
  }
}

/** Video times where a cut joins two pieces of the recording (a gap between clips, not a speed change). */
function cutTimes(clips: readonly Clip[], plan: FreezePlan): number[] {
  const out: number[] = []
  let edit = 0
  for (let i = 0; i < clips.length; i++) {
    if (i > 0 && clips[i].start - clips[i - 1].end > EPS) out.push(editToVideo(plan, edit))
    edit += (clips[i].end - clips[i].start) / clips[i].speed
  }
  return out
}

/** How many of `sorted` lie strictly between a and b. */
function countBetween(sorted: readonly number[], a: number, b: number): number {
  const lo = lastAtOrBefore(sorted, a + EPS)
  const hi = lastAtOrBefore(sorted, b - EPS * 2)
  return Math.max(0, hi - lo)
}

/** Overlap of two stretches as a share of the shorter. */
const overlapShare = (a: { vs: number; ve: number }, b: { vs: number; ve: number }): number => {
  const o = Math.min(a.ve, b.ve) - Math.max(a.vs, b.vs)
  return o <= 0 ? 0 : o / Math.max(EPS, Math.min(a.ve - a.vs, b.ve - b.vs))
}

/** Picks best first, dropping one that overlaps a picked one by more than 30% of the shorter; at most `k`. */
function pick<T extends { vs: number; ve: number; score: number }>(cands: T[], k: number): T[] {
  cands.sort((a, b) => b.score - a.score || a.vs - b.vs)
  const out: T[] = []
  for (const c of cands) {
    if (out.length >= k) break
    if (out.some((p) => overlapShare(p, c) > CLIP_RULES.overlap + EPS)) continue
    out.push(c)
  }
  return out
}

const plural = (n: number, one: string): string => `${n} ${one}${n === 1 ? '' : 's'}`
const lengthWords = (seconds: number): string => `${Math.round(seconds)} s`

const graphemer = new Intl.Segmenter(undefined, { granularity: 'grapheme' })
/** The first words of a sentence, at most FIRST_MAX graphemes, cut at a word with "…". */
function firstWords(text: string): string {
  const g = [...graphemer.segment(text)].map((s) => s.segment)
  if (g.length <= FIRST_MAX) return text
  const head = g.slice(0, FIRST_MAX).join('')
  const space = head.lastIndexOf(' ')
  return `${(space > 0 ? head.slice(0, space) : head).replace(/[\s\p{P}]+$/u, '')}…`
}

/** Longest title (graphemes), as an AI's names for clips (§8.4). */
export const TITLE_MAX = 80

/**
 * The offline title of a moment opening with `text` (§8.4): its sentence's name (at most 80
 * graphemes), else the sentence cut to 40, else "Clip n". Cut by graphemes at a word, never inside
 * a cluster; never private-like (sentenceName and cutName refuse it).
 */
export function momentTitle(text: string, rank: number, language?: string): string {
  const name = sentenceName(text, language)
  return (name ? cutName(name, TITLE_MAX) : null) ?? cutName(text) ?? `Clip ${rank}`
}

/**
 * The moments of `project` (§8.2), best first, or why there are none: a video under 45 s is too
 * short; 'nothing' when no stretch fits. Without words (no captions) or with `activityOnly`, the
 * busiest stretches (§8.3). Whether captions are needed first is the caller's (speechHeard, §7.8).
 */
export function findMoments(
  project: Project,
  ctx: { track: CursorTrack | null; scan: SceneScan | null; focus?: string; length: MomentLength; activityOnly?: boolean }
): Moment[] | { reason: 'too-short' | 'nothing' } {
  if (!project.clips?.length) return { reason: 'too-short' }
  const plan = planOf(project)
  const L = videoDuration(project.clips, plan)
  if (L < CLIP_RULES.minVideo - EPS) return { reason: 'too-short' }
  const hasWords = !!project.transcript?.segments.some((s) => s.text.trim())
  const out = !hasWords || ctx.activityOnly ? silentMoments(project, plan, L, ctx) : spokenMoments(project, plan, L, ctx)
  return out.length ? out : { reason: 'nothing' }
}

interface Candidate {
  i: number
  j: number
  vs: number
  ve: number
  score: number
  hook: ReturnType<typeof hookOf>
  ending: boolean
}

/** Input events (source seconds) of `track`: clicks, shortcut keys, typing bursts and scrolls (joined). */
function inputRanges(track: CursorTrack | null): { start: number; end: number }[] {
  const out: { start: number; end: number }[] = []
  for (const c of track?.clicks ?? []) out.push({ start: c.t - INPUT_REACH, end: c.t + INPUT_REACH })
  for (const k of track?.keys ?? []) out.push({ start: k.t - INPUT_REACH, end: k.t + INPUT_REACH })
  for (const b of track?.typing ?? []) out.push({ start: b.t, end: Math.max(b.t, b.end) })
  for (const s of track?.scrolls ?? []) out.push({ start: s.t - INPUT_REACH, end: s.t + INPUT_REACH })
  return out
}

/** `ranges` (source seconds) in video time. */
function toVideo(project: Project, plan: FreezePlan, ranges: readonly { start: number; end: number }[]): { start: number; end: number }[] {
  const times: number[] = []
  for (const r of ranges) times.push(r.start, r.end)
  const v = videoTimesAt(project.clips, plan, times)
  return ranges.map((_, i) => ({ start: v[2 * i], end: v[2 * i + 1] }))
}

function spokenMoments(project: Project, plan: FreezePlan, L: number, ctx: { track: CursorTrack | null; scan: SceneScan | null; focus?: string; length: MomentLength }): Moment[] {
  const all = clipSentences(project, ctx)
  const S = all.filter((s) => !s.retake)
  if (S.length === 0) return []
  const language = transcriptLanguage(project.transcript)
  const { min, max } = lengthBounds(ctx.length)

  // Padded boundaries in video time.
  const padded: number[] = []
  for (const s of S) padded.push(s.start - Math.min(PAD_BEFORE, s.gapBefore / 2), s.end + Math.min(PAD_AFTER, s.gapAfter / 2))
  const pv = videoTimesAt(project.clips, plan, padded)
  const vs = (i: number): number => pv[2 * i]
  const ve = (j: number): number => pv[2 * j + 1]

  // Prefix sums of the seconds-weighted feature score.
  const W = new Float64Array(S.length + 1)
  const F = new Float64Array(S.length + 1)
  S.forEach((s, k) => {
    const f = s.features
    const value = f.density + f.keywords + f.emphasis + f.numbers + f.action - f.fillers + f.focus
    const w = Math.max(0, s.vEnd - s.vStart)
    W[k + 1] = W[k] + w
    F[k + 1] = F[k] + w * value
  })

  // Speech (every kept sentence, short ones and retakes too) and input, in video time.
  const words = keptClipWords(project)
  const speech = sentencesOf(words).map(([a, b]) => ({ start: words[a].start, end: words[b].end }))
  const coverage = new Coverage(toVideo(project, plan, [...speech, ...inputRanges(ctx.track)]))
  const cuts = cutTimes(project.clips, plan)
  const hooks = S.map((s) => hookOf(s.text, language))
  const back = S.map((s) => refersBack(s.text))

  const cands: Candidate[] = []
  for (let i = 0; i < S.length; i++) {
    if (S[i].gapBefore < CLIP_RULES.gapBefore - EPS) continue
    for (let j = i; j < S.length; j++) {
      const len = ve(j) - vs(i)
      if (len > max + EPS) break
      if (len < min - EPS) continue
      const w = W[j + 1] - W[i]
      let score = w > 0 ? (F[j + 1] - F[i]) / w : 0
      if (hooks[i]) score += 1
      const ending = S[j].gapAfter >= CLIP_RULES.gapAfter - EPS
      if (ending) score += 0.5
      if (back[i]) score -= 0.5
      if (1 - coverage.covered(vs(i), ve(j)) / len > CLIP_RULES.empty + EPS) score -= 1
      if (countBetween(cuts, vs(i), ve(j)) / (len / 30) > CLIP_RULES.choppy + EPS) score -= 0.5
      score += lengthTerm(len)
      cands.push({ i, j, vs: vs(i), ve: ve(j), score, hook: hooks[i], ending })
    }
  }
  return pick(cands, momentCount(L)).map((c, rank): Moment => {
    const first = S[c.i]
    return {
      start: padded[2 * c.i],
      end: padded[2 * c.j + 1],
      seconds: c.ve - c.vs,
      score: c.score,
      reasons: reasonsOf(S.slice(c.i, c.j + 1), c),
      first: firstWords(first.text),
      title: momentTitle(first.text, rank + 1, language),
      silent: false
    }
  })
}

/** At most 3 reasons from the largest terms, then the length (§8.2). */
function reasonsOf(list: readonly ClipSentence[], c: Candidate): string[] {
  let w = 0
  const sum = { density: 0, keywords: 0, emphasis: 0, numbers: 0, action: 0, focus: 0 }
  let clicks = 0
  let focusWord: string | null = null
  for (const s of list) {
    const sw = Math.max(0, s.vEnd - s.vStart)
    w += sw
    sum.density += sw * s.features.density
    sum.keywords += sw * s.features.keywords
    sum.emphasis += sw * s.features.emphasis
    sum.numbers += sw * s.features.numbers
    sum.action += sw * s.features.action
    sum.focus += sw * s.features.focus
    clicks += s.clicks
    focusWord ??= s.focusWord
  }
  const mean = (x: number): number => (w > 0 ? x / w : 0)
  const terms: { value: number; label: string }[] = [
    { value: mean(sum.density), label: 'Packed with information' },
    { value: mean(sum.keywords), label: 'Important words' },
    { value: mean(sum.emphasis), label: 'Words you emphasised' },
    { value: mean(sum.numbers), label: 'Numbers' },
    { value: clicks > 0 ? mean(sum.action) : 0, label: plural(clicks, 'click') },
    { value: focusWord ? mean(sum.focus) : 0, label: `Mentions “${focusWord ?? ''}”` },
    { value: c.hook ? 1 : 0, label: c.hook === 'question' ? 'Opens with a question' : c.hook === 'number' ? 'Opens with a number' : 'Opens with an action' },
    { value: c.ending ? 0.5 : 0, label: 'Ends cleanly' }
  ]
  const top = terms
    .filter((t) => t.value >= REASON_MIN)
    .sort((a, b) => b.value - a.value)
    .slice(0, 3)
    .map((t) => t.label)
  return [...top, lengthWords(c.ve - c.vs)]
}

/**
 * Silent recordings (§8.3): activity a second (clicks, keys, typing, scrolls and screen changes)
 * in stretches that start and end at a settled screen change or in a gap of input of 1 s or more,
 * scored by that density plus 1 for each page change in it and the length term.
 */
function silentMoments(project: Project, plan: FreezePlan, L: number, ctx: { track: CursorTrack | null; scan: SceneScan | null; length: MomentLength }): Moment[] {
  const { track, scan } = ctx
  const { min, max } = lengthBounds(ctx.length)
  // Input events (scrolls joined) in source time.
  const events: { t: number; click: boolean }[] = []
  for (const c of track?.clicks ?? []) events.push({ t: c.t, click: true })
  for (const k of track?.keys ?? []) events.push({ t: k.t, click: false })
  for (const b of track?.typing ?? []) events.push({ t: b.t, click: false })
  let lastScroll = -Infinity
  for (const s of [...(track?.scrolls ?? [])].sort((a, b) => a.t - b.t)) {
    if (s.t - lastScroll > SCROLL_JOIN) events.push({ t: s.t, click: false })
    lastScroll = s.t
  }
  events.sort((a, b) => a.t - b.t)
  const changes = scan ? screenChanges(scan, track?.scrolls) : []

  const kept = { start: project.clips[0].start, end: project.clips[project.clips.length - 1].end }
  const inKept = (t: number): boolean => t >= kept.start - EPS && t <= kept.end + EPS
  // Where a stretch may start and end (source time).
  const startsAt: number[] = [kept.start]
  const endsAt: number[] = [kept.end]
  for (const c of changes) {
    if (!inKept(c.t)) continue
    startsAt.push(c.t)
    endsAt.push(c.t)
  }
  for (let i = 0; i <= events.length; i++) {
    const a = i > 0 ? events[i - 1].t : kept.start
    const b = i < events.length ? events[i].t : kept.end
    if (b - a < INPUT_GAP - EPS) continue
    if (i > 0) endsAt.push(Math.min(b, a + INPUT_GAP / 2))
    if (i < events.length) startsAt.push(Math.max(a, b - INPUT_GAP / 2))
  }
  const uniq = (xs: number[]): number[] => [...new Set(xs.filter(inKept).map((x) => Math.round(x * 1000) / 1000))].sort((a, b) => a - b)
  const S0 = uniq(startsAt)
  const E0 = uniq(endsAt)
  const sv = videoTimesAt(project.clips, plan, S0)
  const ev = videoTimesAt(project.clips, plan, E0)

  // Activity in video time, as sorted lists for counting.
  const eventV = videoTimesAt(project.clips, plan, events.map((e) => e.t)).sort((a, b) => a - b)
  const clickV = videoTimesAt(project.clips, plan, events.filter((e) => e.click).map((e) => e.t)).sort((a, b) => a - b)
  const keptChanges = changes.filter((c) => inKept(c.t))
  const changeV = videoTimesAt(project.clips, plan, keptChanges.map((c) => c.t)).sort((a, b) => a - b)
  const pageV = videoTimesAt(project.clips, plan, keptChanges.filter((c) => c.page).map((c) => c.t)).sort((a, b) => a - b)
  /** Of `sorted`, how many lie in [a, b). */
  const within = (sorted: readonly number[], a: number, b: number): number => Math.max(0, lastAtOrBefore(sorted, b - EPS) - lastAtOrBefore(sorted, a - EPS))

  const cands: { si: number; ei: number; vs: number; ve: number; score: number }[] = []
  for (let si = 0; si < S0.length; si++) {
    // The ends between min and max seconds later (video times grow with source times).
    for (let ei = Math.max(0, lastAtOrBefore(ev, sv[si] + min - EPS * 2) + 1); ei < E0.length; ei++) {
      const len = ev[ei] - sv[si]
      if (len > max + EPS) break
      if (len < min - EPS) continue
      const activity = within(eventV, sv[si], ev[ei]) + within(changeV, sv[si], ev[ei])
      if (activity === 0) continue
      const pages = countBetween(pageV, sv[si], ev[ei])
      cands.push({ si, ei, vs: sv[si], ve: ev[ei], score: activity / len + pages + lengthTerm(len) })
    }
  }
  return pick(cands, momentCount(L)).map((c): Moment => {
    const clicks = within(clickV, c.vs, c.ve)
    const screens = 1 + countBetween(pageV, c.vs, c.ve)
    const reasons = [...(clicks > 0 ? [plural(clicks, 'click')] : []), ...(screens > 1 ? [plural(screens, 'screen')] : []), lengthWords(c.ve - c.vs)]
    return {
      start: S0[c.si],
      end: E0[c.ei],
      seconds: c.ve - c.vs,
      score: c.score,
      reasons,
      first: '',
      title: `Most action, ${clockTime(c.vs)}`,
      silent: true
    }
  })
}
