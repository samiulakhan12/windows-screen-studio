/**
 * Choosing where chapters start (docs/design/smart-tools.md §7.1, §7.4): the candidates of
 * signals.ts, judged in video time (after cuts, speeds and pause freezes), stored in source time.
 * An exact search charges each split a cost, so a split needs two kinds of evidence or one strong
 * one, and keeps YouTube's rules: the first at 0:00, each at least `m` long (10 s or more), at most
 * `N`. The user's chapters are fixed: always kept, never moved, worked around. Pure.
 */
import { videoDuration, planOf, videoTimesAt } from '../engine/freeze'
import { clipIndexAt } from '../engine/timeline'
import { inputGaps } from '../editor/smartSpeed'
import type { TimeRange } from '../editor/smartSpeed'
import { middlesCut, transcriptWords } from '../editor/transcript'
import { sentencesOf } from '../editor/retakes'
import { transcriptSpeech } from '../audio/speech'
import { outputChapters, youtubeChapters } from '../render/chapters'
import { screenChanges } from '../smart/screenChanges'
import type { SceneScan } from '../api/projects'
import type { Chapter, ChapterSignal, CursorTrack, Project } from '../types'
import { userChapters } from './pending'
import { aiCandidates, cardCandidates, CHAPTER_RULES, cueCandidates, mergeCandidates, pauseCandidates, topicCandidates, type Candidate } from './signals'

export interface ChapterPlanInput {
  project: Project
  /** The input as the edit uses it (effectiveTrack), or null when unknown. */
  track: CursorTrack | null
  /** The scene scan (§7.2), or null when it is not read. */
  scan: SceneScan | null
  /** The speech detector's ranges (source seconds) for a recording without captions, or null. */
  speech: readonly TimeRange[] | null
  density: 'fewer' | 'normal' | 'more'
  /** Split at: screen changes, pauses (and idle input), what was said (cues and topics). */
  use: { screen: boolean; pauses: boolean; words: boolean }
  /** An AI's suggested starts (§7.6.1), source seconds. */
  ai?: readonly { t: number; title: string }[]
  /** App switches (F-10, a later wave): score 4 each. Nothing passes it in this wave. */
  apps?: readonly { t: number }[]
}

/** The found starts in source seconds (with their signals, strongest first, at most 3, and an AI's title), or why there are none. */
export type ChapterPlan =
  | { ok: true; starts: { t: number; from: ChapterSignal[]; ai?: string }[]; youtube: boolean }
  | { ok: false; reason: 'too-short' | 'nothing' | 'already' }

const EPS = 1e-9
/** `d` (how many) and `e` (how long) of each density (§7.1). */
const DENSITY = { fewer: { d: 0.6, e: 1.5 }, normal: { d: 1, e: 1 }, more: { d: 1.5, e: 0.67 } } as const
/** An app switch's score (the F-10 seam). */
const APP_SCORE = 4

/** The most chapters (`n`) and the shortest (`m`, seconds) of a video `L` seconds long at `density`. */
export function chapterLimits(L: number, density: ChapterPlanInput['density']): { n: number; m: number; cost: number } {
  const { d, e } = DENSITY[density]
  const n = Math.min(CHAPTER_RULES.maxChapters, Math.max(CHAPTER_RULES.minChapters, Math.round((L / CHAPTER_RULES.perChapter) * d)))
  const m = Math.max(CHAPTER_RULES.minLength, CHAPTER_RULES.minShare * L * e)
  return { n, m, cost: CHAPTER_RULES.cost[density] }
}

/** Whether a candidate must be chosen and adds nothing: a user's chapter, or the 0:00 start. */
const required = (c: Candidate): boolean => !!c.fixed || c.from[0] === 'start'

/**
 * The best set of starts among `cands` (§7.4), exactly, by dynamic programming over the candidates
 * in video time: each chosen candidate adds `score − cost`; fixed ones (the user's chapters) and the
 * 0:00 start (`from[0] === 'start'`) must be chosen and add 0; consecutive starts are at least `m`
 * apart (waived between two of those that must be chosen); the last leaves at least `m` before `L`
 * (unless it must be chosen); at most `n` in all (or every one that must be chosen, when there are
 * more). The chain begins at the first that must be chosen. The highest total wins; ties go to
 * fewer chapters, then to the smaller largest chapter. When nothing satisfies the rules, the ones
 * that must be chosen alone. In time order.
 */
export function chooseBoundaries(cands: readonly Candidate[], L: number, m: number, n: number, cost: number): Candidate[] {
  const all = [...cands].filter((c) => Number.isFinite(c.v)).sort((a, b) => a.v - b.v)
  const firstReq = all.findIndex(required)
  const list = firstReq > 0 ? all.slice(firstReq) : all
  // A candidate that is not required and adds nothing is never chosen (one more chapter, no gain).
  const items = list.filter((c, i) => (firstReq >= 0 && i === 0) || required(c) || c.score - cost > EPS)
  const k = items.length
  if (!k) return []
  const req = items.map(required)
  const reqCount = req.filter(Boolean).length
  const cap = Math.max(n, reqCount, 1)
  // The next required candidate after each (a chain never skips one).
  const nextReq = new Int32Array(k).fill(k)
  for (let i = k - 2; i >= 0; i--) nextReq[i] = req[i + 1] ? i + 1 : nextReq[i + 1]
  const lastReq = req.lastIndexOf(true)
  const gain = items.map((c, i) => (req[i] ? 0 : c.score - cost))
  const v = items.map((c) => c.v)
  // best total, largest chapter so far and predecessor, by [i * (cap + 1) + count].
  const W = cap + 1
  const total = new Float64Array(k * W).fill(-Infinity)
  const widest = new Float64Array(k * W).fill(Infinity)
  const prev = new Int32Array(k * W).fill(-1)
  const starts = firstReq >= 0 ? [0] : items.map((_, i) => i)
  for (const s of starts) {
    total[s * W + 1] = gain[s]
    widest[s * W + 1] = 0
  }
  for (let i = 0; i < k; i++) {
    for (let j = 0; j < i; j++) {
      // j's next required candidate must not lie before i.
      if (nextReq[j] < i) continue
      const gap = v[i] - v[j]
      if (gap < m - EPS && !(req[i] && req[j])) continue
      for (let c = 1; c < cap; c++) {
        const from = total[j * W + c]
        if (from === -Infinity) continue
        const t = from + gain[i]
        const wide = Math.max(widest[j * W + c], gap)
        const at = i * W + c + 1
        if (t > total[at] + EPS || (t > total[at] - EPS && wide < widest[at] - EPS)) {
          total[at] = t
          widest[at] = wide
          prev[at] = j
        }
      }
    }
  }
  let bestAt = -1
  let bestTotal = -Infinity
  let bestCount = Infinity
  let bestWide = Infinity
  for (let i = Math.max(0, lastReq); i < k; i++) {
    if (!(L - v[i] >= m - EPS || req[i])) continue
    for (let c = 1; c <= cap; c++) {
      const t = total[i * W + c]
      if (t === -Infinity) continue
      const wide = Math.max(widest[i * W + c], L - v[i])
      const better = t > bestTotal + EPS || (t > bestTotal - EPS && (c < bestCount || (c === bestCount && wide < bestWide - EPS)))
      if (better) {
        bestAt = i * W + c
        bestTotal = t
        bestCount = c
        bestWide = wide
      }
    }
  }
  if (bestAt < 0) return items.filter((_, i) => req[i])
  const out: Candidate[] = []
  let at = bestAt
  for (;;) {
    const i = Math.floor(at / W)
    const c = at % W
    out.push(items[i])
    const j = prev[at]
    if (j < 0) break
    at = j * W + (c - 1)
  }
  return out.reverse()
}

/** Strongest first, each once, at most 3 (ChapterOrigin.from). */
const top3 = (from: readonly ChapterSignal[]): ChapterSignal[] => [...new Set(from)].slice(0, 3)

/**
 * Where to split `input.project` (§7.1-7.4): the found starts, or 'too-short' (under 30 s of
 * video), 'nothing' (no candidate earns its place) or 'already' (the user's chapters leave no room,
 * or nothing new). Pending found chapters are not read: the caller replaces them. `youtube` says
 * whether the chapters (the user's and these) then keep YouTube's rules.
 */
export function planChapters(input: ChapterPlanInput): ChapterPlan {
  const { project, use } = input
  const clips = project.clips
  if (!clips?.length) return { ok: false, reason: 'too-short' }
  const freezes = planOf(project)
  const L = videoDuration(clips, freezes)
  if (!(L >= CHAPTER_RULES.minVideo - EPS)) return { ok: false, reason: 'too-short' }
  const { n, m, cost } = chapterLimits(L, input.density)

  // The transcript's sentences; only kept words count.
  const transcript = project.transcript
  const words = transcriptWords(transcript)
  const cut = middlesCut(words, clips)
  const kept = words.filter((_, i) => !cut[i])
  const sentenceStarts = sentencesOf(words)
    .filter(([a]) => !cut[a])
    .map(([a]) => words[a].start)

  const raw: Candidate[] = []
  if (use.screen && input.scan) {
    for (const c of screenChanges(input.scan, input.track?.scrolls)) {
      raw.push({ t: c.t, v: c.t, score: c.page ? CHAPTER_RULES.score.page : CHAPTER_RULES.score.screen, from: [c.page ? 'page' : 'screen'] })
    }
  }
  if (use.pauses) {
    const speech = transcriptSpeech(transcript) ?? input.speech
    const gaps = input.track ? inputGaps(input.track, project.duration) : null
    raw.push(...pauseCandidates(speech, gaps))
  }
  if (use.words && transcript) {
    raw.push(...cueCandidates(transcript.segments, transcript.language))
    raw.push(...topicCandidates(kept, sentenceStarts))
  }
  raw.push(...cardCandidates(project.titles ?? []))
  raw.push(...aiCandidates(input.ai ?? []))
  for (const a of input.apps ?? []) if (Number.isFinite(a.t)) raw.push({ t: a.t, v: a.t, score: APP_SCORE, from: ['page'] })

  // A candidate inside a cut is dropped (§7.1).
  const inVideo = (t: number): boolean => clipIndexAt(clips, t) >= 0
  const merged = mergeCandidates(raw.filter((c) => inVideo(c.t)), sentenceStarts).filter((c) => inVideo(c.t))
  const mv = videoTimesAt(clips, freezes, merged.map((c) => c.t))
  merged.forEach((c, i) => (c.v = mv[i]))

  // The user's chapters, fixed (one inside a cut starts where the video goes on, as exports show it).
  const users = userChapters(project).filter((c) => Number.isFinite(c.t))
  const uv = videoTimesAt(clips, freezes, users.map((c) => c.t))
  const fixed: Candidate[] = users
    .map((c, i) => ({ t: c.t, v: uv[i], score: 0, from: [] as ChapterSignal[], fixed: true as const }))
    .filter((c) => c.v < L - EPS)
    .sort((a, b) => a.v - b.v)

  // The first start: 0:00 costs nothing, or a user's chapter within 10 s of it stands in.
  const standIn = fixed.find((c) => c.v <= CHAPTER_RULES.minLength + EPS)
  let cands: Candidate[]
  if (standIn) {
    cands = [...fixed, ...merged.filter((c) => c.v > standIn.v + EPS)]
  } else {
    const near = merged.filter((c) => c.v < CHAPTER_RULES.merge - EPS)
    const lent = near.flatMap((c) => c.from)
    const ai = near.find((c) => c.ai)?.ai
    const start: Candidate = { t: clips[0].start, v: 0, score: 0, from: ['start', ...top3(lent)], ...(ai ? { ai } : {}) }
    cands = [start, ...fixed, ...merged.filter((c) => c.v >= CHAPTER_RULES.merge - EPS)]
  }
  // At most 400 (the best-scored); the required ones always.
  const free = cands.filter((c) => !required(c) && c.score - cost > EPS).sort((a, b) => b.score - a.score || a.v - b.v)
  if (free.length > CHAPTER_RULES.maxCandidates) {
    const keep = new Set(free.slice(0, CHAPTER_RULES.maxCandidates))
    cands = cands.filter((c) => required(c) || keep.has(c))
  }

  const chosen = chooseBoundaries(cands, L, m, n, cost)
  const splits = chosen.filter((c) => !required(c))
  if (!splits.length) return { ok: false, reason: fixed.length ? 'already' : 'nothing' }
  const found = chosen.filter((c) => !c.fixed)
  const starts = found.map((c) => ({ t: c.t, from: top3(c.from), ...(c.ai ? { ai: c.ai.title } : {}) }))
  // YouTube's rules, read as an export writes the chapters.
  const all: Chapter[] = [...users.map((c) => ({ id: c.id, t: c.t, title: c.title || 'x' })), ...starts.map((s, i) => ({ id: `f${i}`, t: s.t, title: 'x' }))]
  const youtube = youtubeChapters(outputChapters(all, clips, freezes), L).problems.length === 0
  return { ok: true, starts, youtube }
}
