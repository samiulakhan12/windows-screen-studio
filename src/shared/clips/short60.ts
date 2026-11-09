/**
 * Make a shorter version (docs/design/smart-tools.md §8.6): the most useful sentences, in order,
 * within 30, 60 or 90 seconds, chosen offline by relevance with a penalty for repeating (maximal
 * marginal relevance), and the copy that keeps them: every removed stretch a Review row that
 * brings it back, and smooth cuts when the original has no cut style of its own. Pure.
 */
import { transcriptLanguage } from '../captions/captionTracks'
import { STOP_WORDS } from '../captions/stopWords'
import { fillerLanguage, isFiller } from '../editor/fillers'
import { normalizeWord } from '../editor/transcript'
import { projectCopy, type MeasureText } from '../editor/duplicate'
import { planOf, videoDuration, videoTimesAt } from '../engine/freeze'
import { recordAutoCuts } from '../review/autoCuts'
import type { Clip, Project } from '../types'
import { copyKindOf, piecesClips, suffixedName, withClipCaptions, withinRange, type ClipShape } from './clipCopy'
import { focusKey, focusWords, keptClipWords, lastAtOrBefore, MIN_SENTENCE_WORDS, type ScoredSentence } from './sentences'

export type ShortLength = 30 | 60 | 90
export const SHORT_LENGTHS: readonly ShortLength[] = [30, 60, 90]

export type ShortPlan =
  | { ok: true; pieces: { start: number; end: number }[]; seconds: number; sentences: number; length?: ShortLength }
  | { ok: false; reason: 'no-captions' | 'too-little' | 'too-short' }

/** §8.6's numbers. */
export const SHORT_RULES = {
  /** Seconds before a sentence's first word and after its last that its piece keeps. */
  padBefore: 0.15,
  padAfter: 0.25,
  /** Pieces closer than this join (the silence between them kept). */
  join: 0.6,
  /** Maximal marginal relevance's weight of relevance. */
  lambda: 0.7,
  /** The set-up and the result: the first 15% and the last 10% of the video. */
  setUp: 0.15,
  result: 0.1,
  /** A sentence more than this share fillers loses 1. */
  fillerShare: 0.3,
  /** Words under this many graphemes are not content words. */
  minContent: 3
} as const

const EPS = 1e-9

interface Piece {
  start: number
  end: number
}

/** The kept viewing time of [a, b] (source seconds) on `clips` (in order), at their speeds. */
function keptSeconds(clips: readonly Clip[], ends: readonly number[], a: number, b: number): number {
  let out = 0
  // The first clip that ends after a.
  let lo = 0
  let hi = clips.length
  while (lo < hi) {
    const mid = (lo + hi) >> 1
    if (ends[mid] <= a) lo = mid + 1
    else hi = mid
  }
  for (let i = lo; i < clips.length && clips[i].start < b; i++) out += Math.max(0, Math.min(b, clips[i].end) - Math.max(a, clips[i].start)) / clips[i].speed
  return out
}

/** `pieces` sorted, those closer than SHORT_RULES.join joined. */
function joined(pieces: readonly Piece[]): Piece[] {
  const sorted = [...pieces].sort((x, y) => x.start - y.start)
  const out: Piece[] = []
  for (const p of sorted) {
    const last = out[out.length - 1]
    if (last && p.start - last.end < SHORT_RULES.join - EPS) last.end = Math.max(last.end, p.end)
    else out.push({ ...p })
  }
  return out
}

const graphemer = new Intl.Segmenter(undefined, { granularity: 'grapheme' })
const graphemeCount = (s: string): number => (/^[\x20-\x7e]*$/.test(s) ? s.length : [...graphemer.segment(s)].length)

/**
 * The plan of a shorter version of `seconds` (§8.6): sentences scored (key words 0..1, an action
 * in it (a click, typing, a zoom or a screen change) +1, in the set-up or the result +0.5, Focus on +2, the user's emphasis +1, a statistic
 * +0.5, fillers over 30% −1; retakes and sentences under 3 words left out), chosen by maximal
 * marginal relevance (λ 0.7, tf-idf cosine of content words), first one per user chapter while
 * they fit (with 2 or more), then the best remaining while any fits. Each sentence's piece runs
 * 0.15 s before its first word to 0.25 s after its last, never past the middle of the silence to
 * the next or previous word; pieces under 0.6 s apart join. The pieces (in order) with the pause
 * freezes inside them stay within `seconds`.
 */
export function planShort(project: Project, sentences: readonly ScoredSentence[], opts: { seconds: ShortLength; focus?: string }): ShortPlan {
  if (!project.transcript?.segments.some((s) => s.text.trim())) return { ok: false, reason: 'no-captions' }
  const clips = project.clips
  if (!clips?.length) return { ok: false, reason: 'too-short' }
  const plan = planOf(project)
  const L = videoDuration(clips, plan)
  if (opts.seconds >= L - 1e-6) return { ok: false, reason: 'too-short' }

  const language = transcriptLanguage(project.transcript)
  const lang = (language ?? 'en').toLowerCase().split(/[-_]/)[0]
  const fillers = fillerLanguage(language)
  const cands = sentences.filter((s) => !s.retake && s.words >= MIN_SENTENCE_WORDS)
  if (cands.length === 0) return { ok: false, reason: 'too-little' }

  // Each sentence's piece, bounded by the middle of the silence to its neighbouring words.
  const words = keptClipWords(project)
  const wordStarts = words.map((w) => w.start)
  const pieces: Piece[] = cands.map((s) => {
    const from = Math.max(0, lastAtOrBefore(wordStarts, s.start))
    const to = Math.max(from, lastAtOrBefore(wordStarts, s.end - 1e-6))
    const prev = words[from - 1]
    const next = words[to + 1]
    let start = s.start - SHORT_RULES.padBefore
    let end = s.end + SHORT_RULES.padAfter
    if (prev) start = Math.max(start, (prev.end + s.start) / 2)
    if (next) end = Math.min(end, (s.end + next.start) / 2)
    return { start: Math.max(0, start), end: Math.min(project.duration, Math.max(end, s.end)) }
  })

  // The relevance of each sentence (§8.6 rule 1).
  const v = videoTimesAt(clips, plan, cands.flatMap((s) => [s.start, s.end]))
  const k = cands.map((s) => s.features.keywords)
  const kMin = Math.min(...k)
  const kMax = Math.max(...k)
  const wanted = opts.focus !== undefined ? focusWords(opts.focus) : null
  const raw = cands.map((s, i) => {
    const f = s.features
    let score = kMax - kMin > EPS ? (f.keywords - kMin) / (kMax - kMin) : 0
    if (f.action > 0) score += 1
    if (v[2 * i] <= SHORT_RULES.setUp * L + EPS || v[2 * i + 1] >= (1 - SHORT_RULES.result) * L - EPS) score += 0.5
    const focus = wanted ? s.text.split(/\s+/u).some((w) => wanted.some((x) => x.key === focusKey(w))) : f.focus > 0
    if (focus) score += 2
    if (f.emphasis > 0) score += 1
    if (f.numbers > 0) score += 0.5
    const said = s.text.split(/\s+/u).filter(Boolean)
    if (said.length && said.filter((w) => isFiller(normalizeWord(w), fillers)).length / said.length > SHORT_RULES.fillerShare + EPS) score -= 1
    return score
  })
  const rMin = Math.min(...raw)
  const rMax = Math.max(...raw)
  const rel = raw.map((r) => (rMax - rMin > EPS ? (r - rMin) / (rMax - rMin) : 1))

  // tf-idf vectors of content words, for the penalty for repeating.
  const stop = STOP_WORDS[lang] ?? new Set<string>()
  const terms = cands.map((s) => {
    const tf = new Map<string, number>()
    for (const w of s.text.split(/\s+/u)) {
      const key = normalizeWord(w)
      if (!key || stop.has(key) || graphemeCount(key) < SHORT_RULES.minContent) continue
      tf.set(key, (tf.get(key) ?? 0) + 1)
    }
    return tf
  })
  const df = new Map<string, number>()
  for (const tf of terms) for (const key of tf.keys()) df.set(key, (df.get(key) ?? 0) + 1)
  const vectors = terms.map((tf) => {
    const vec = new Map<string, number>()
    let norm = 0
    for (const [key, n] of tf) {
      const w = n * Math.log(cands.length / (df.get(key) ?? 1) + 1)
      vec.set(key, w)
      norm += w * w
    }
    return { vec, norm: Math.sqrt(norm) }
  })
  const cosine = (a: number, b: number): number => {
    const x = vectors[a]
    const y = vectors[b]
    if (x.norm === 0 || y.norm === 0) return 0
    const [small, large] = x.vec.size <= y.vec.size ? [x.vec, y.vec] : [y.vec, x.vec]
    let dot = 0
    for (const [key, w] of small) dot += w * (large.get(key) ?? 0)
    return dot / (x.norm * y.norm)
  }

  // Fitting: the viewing time of the joined pieces and the pause freezes inside them.
  const ends = clips.map((c) => c.end)
  const holds = plan.holds
  const total = (list: readonly Piece[]): number => {
    let sum = 0
    for (const p of list) {
      sum += keptSeconds(clips, ends, p.start, p.end)
      for (const h of holds) if (h.at >= p.start - EPS && h.at < p.end - EPS) sum += h.length
    }
    return sum
  }
  const chosen: number[] = []
  const taken = new Uint8Array(cands.length)
  const maxSim = new Float64Array(cands.length)
  const fits = (i: number): Piece[] | null => {
    const next = joined([...chosen.map((c) => pieces[c]), pieces[i]])
    return total(next) <= opts.seconds + EPS ? next : null
  }
  const mmr = (i: number): number => SHORT_RULES.lambda * rel[i] - (1 - SHORT_RULES.lambda) * maxSim[i]
  const take = (i: number): void => {
    chosen.push(i)
    taken[i] = 1
    for (let j = 0; j < cands.length; j++) if (!taken[j]) maxSim[j] = Math.max(maxSim[j], cosine(i, j))
  }
  /** The best of `among` by MMR that fits, or -1. */
  const best = (among: readonly number[]): number => {
    const order = among.filter((i) => !taken[i]).sort((a, b) => mmr(b) - mmr(a) || a - b)
    for (const i of order) if (fits(i)) return i
    return -1
  }

  // One sentence per user chapter first (when there are 2 or more), then the best remaining.
  const chapters = [...new Set(cands.map((s) => s.chapter))].sort((a, b) => a - b)
  if (chapters.length >= 2) {
    for (const c of chapters) {
      const i = best(cands.map((s, j) => (s.chapter === c ? j : -1)).filter((j) => j >= 0))
      if (i >= 0) take(i)
    }
  }
  const all = cands.map((_, i) => i)
  for (;;) {
    const i = best(all)
    if (i < 0) break
    take(i)
  }
  const kept = joined(chosen.map((c) => pieces[c]))
  const seconds = total(kept)
  if (kept.length === 0 || seconds < opts.seconds / 2 - EPS) return { ok: false, reason: 'too-little' }
  return { ok: true, pieces: kept, seconds, sentences: chosen.length, length: opts.seconds }
}

/** The removed stretches between the kept pieces (and before the first and after the last), within the kept edit. */
function removedRanges(clips: readonly Clip[], pieces: readonly Piece[]): Piece[] {
  const out: Piece[] = []
  let at = clips[0].start
  for (const p of pieces) {
    if (p.start - at > 1e-6) out.push({ start: at, end: p.start })
    at = Math.max(at, p.end)
  }
  const end = clips[clips.length - 1].end
  if (end - at > 1e-6) out.push({ start: at, end })
  return out
}

/** The length a plan was made for: as given, else the shortest that holds it. */
const lengthOf = (plan: Extract<ShortPlan, { ok: true }>): ShortLength => plan.length ?? SHORT_LENGTHS.find((n) => plan.seconds <= n + 1e-6) ?? 90

/**
 * The shorter version's copy (§8.6 rule 5): projectCopy for the shape; the original's automatic
 * cut records kept only when they lie inside one kept piece, other pending items outside the
 * pieces settled (withinRange); the clips cut to the pieces with a record of each removed stretch
 * (recordAutoCuts, by 'short': Review lists each, and Remove brings it back); the freezes inside
 * the pieces only; no chapters; named "<name> (60 s)"; `clipOf` from the first piece's start to the
 * last one's end; captions as asked; and smooth cuts, recorded for Review, when the original has
 * no cut style of its own (rule 6). Still `project.id`: main gives the copy its new id.
 */
export function shortCopy(project: Project, plan: Extract<ShortPlan, { ok: true }>, opts: { shape: ClipShape; captions: boolean; measure: MeasureText | null }): Project {
  const part = piecesClips(project, plan.pieces)
  if (part.clips.length === 0) throw new Error('The sentences picked are no longer in the video: try again.')
  const base = projectCopy(project, copyKindOf(opts.shape), opts.measure)
  const { chapters: _chapters, ...rest } = base
  void _chapters
  const settled = withinRange(rest, plan.pieces)
  let copy = recordAutoCuts(settled, part.clips, removedRanges(project.clips, plan.pieces), 'cut', 'short')
  if (part.freezes) copy = { ...copy, freezes: part.freezes }
  else if (copy.freezes) {
    const { freezes: _f, ...noFreezes } = copy
    void _f
    copy = noFreezes
  }
  copy = {
    ...copy,
    name: suffixedName(project.name, ` (${lengthOf(plan)} s)`),
    clipOf: { kind: 'short', start: plan.pieces[0].start, end: plan.pieces[plan.pieces.length - 1].end }
  }
  if (!project.joins?.all) copy = { ...copy, joins: { ...copy.joins, all: { kind: 'smooth' }, auto: { by: 'short', was: null } } }
  return withClipCaptions(copy, opts.captions)
}
