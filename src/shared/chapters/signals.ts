/**
 * Where a chapter could start (docs/design/smart-tools.md §7.3): candidate times in source seconds
 * from each signal, with a score. Screen and page changes come from screenChanges; pauses in speech
 * and idle input, the cue words a sentence starts with, topic shifts in the narration (TextTiling),
 * the user's own title cards and an AI's suggestions from here. Candidates within 2 s of each other
 * merge (the best score of each kind, summed) and move to the nearest sentence start within 2 s.
 * Pure.
 */
import { STOP_WORDS } from '../captions/stopWords'
import { normalizeWord } from '../editor/transcript'
import { CUE_WORDS } from '../smart/sentenceName'
import { captionsWords } from '../editor/transcript'
import { sentencesOf } from '../editor/retakes'
import type { CaptionSegment, ChapterSignal, TitleCard } from '../types'
import type { TimeRange } from '../editor/smartSpeed'

export const CHAPTER_RULES = {
  /** Shortest video (s) that gets chapters (YouTube asks for 3 of at least 10 s). */
  minVideo: 30,
  /** One chapter for this many seconds at Normal (N = clamp(round(L / 90 × d), 3, 12)). */
  perChapter: 90,
  minChapters: 3,
  maxChapters: 12,
  /** A chapter is at least this share of the video (× e), and at least minLength seconds. */
  minShare: 0.06,
  minLength: 10,
  /** A gap in speech of this many seconds is a pause; from shortPause a short one. */
  pause: 2,
  shortPause: 1.5,
  /** An input gap of this many seconds is idle. */
  idle: 3,
  /** Candidates this close (s) are one. */
  merge: 2,
  /** A candidate moves to a sentence start this close (s). */
  snap: 2,
  /** Most candidates planned with (the best-scored are kept). */
  maxCandidates: 400,
  /** A title card starting this close (s) to a chapter names it. */
  cardNear: 3,
  /** A topic boundary of this TextTiling depth scores in full. */
  topicDepth: 0.5,
  /** What each split costs: a candidate adds `score − cost`, and is chosen only above 0. */
  cost: { fewer: 3.5, normal: 3, more: 2 },
  score: { page: 3.5, screen: 1.5, pause: 1.5, shortPause: 0.75, idle: 1, common: 1, section: 2.5, topic: 2, card: 4, ai: 3.5 }
} as const

/** A place a chapter could start. */
export interface Candidate {
  /** Source seconds. */
  t: number
  /** Video seconds (planChapters sets it). */
  v: number
  score: number
  /** What it was found from, strongest first. */
  from: ChapterSignal[]
  /** A user's chapter: always kept, never moved. */
  fixed?: true
  /** An AI's suggestion: its title. */
  ai?: { title: string }
}

const EPS = 1e-9
const S = CHAPTER_RULES.score

/** Which kind a signal is of: a merged candidate scores the best of each kind, summed. */
const KIND: Readonly<Record<ChapterSignal, string>> = {
  start: 'start',
  page: 'screen',
  screen: 'screen',
  pause: 'pause',
  idle: 'idle',
  cue: 'words',
  section: 'words',
  topic: 'topic',
  card: 'card',
  ai: 'ai'
}

/** The order signals are listed in when two score the same: the strongest kinds first. */
const ORDER: readonly ChapterSignal[] = ['start', 'card', 'page', 'ai', 'section', 'topic', 'screen', 'pause', 'idle', 'cue']

/**
 * Pauses in speech and idle input (§7.3). A gap of 2 s or more between speech ranges gives 1.5 at
 * the next speech start (1.5 to 2 s: 0.75); an input gap of 3 s or more gives 1 at its end. Either
 * list may be null (not known).
 */
export function pauseCandidates(speech: readonly TimeRange[] | null, gaps: readonly TimeRange[] | null): Candidate[] {
  const out: Candidate[] = []
  const ranges = [...(speech ?? [])].filter((r) => Number.isFinite(r.start) && Number.isFinite(r.end)).sort((a, b) => a.start - b.start)
  let end = -Infinity
  for (const r of ranges) {
    if (Number.isFinite(end)) {
      const gap = r.start - end
      if (gap >= CHAPTER_RULES.pause - EPS) out.push({ t: r.start, v: r.start, score: S.pause, from: ['pause'] })
      else if (gap >= CHAPTER_RULES.shortPause - EPS) out.push({ t: r.start, v: r.start, score: S.shortPause, from: ['pause'] })
    }
    end = Math.max(end, r.end)
  }
  for (const g of gaps ?? []) {
    if (Number.isFinite(g.start) && Number.isFinite(g.end) && g.end - g.start >= CHAPTER_RULES.idle - EPS) out.push({ t: g.end, v: g.end, score: S.idle, from: ['idle'] })
  }
  return out.sort((a, b) => a.t - b.t)
}

/** A word as matched against the cue lists: lower case, without punctuation at its ends, apostrophes as "'". */
const cueKey = (w: string): string => w.replace(/[‘’ʼ]/g, "'").toLowerCase().replace(/^[\s\p{P}\p{S}]+|[\s\p{P}\p{S}]+$/gu, '')

/** The cue lists of `language`, or every language's when it is unknown. */
function cueLists(language?: string): { common: string[]; section: string[] } {
  const base = language?.toLowerCase().split('-')[0]
  const tables = base ? (Object.hasOwn(CUE_WORDS, base) ? [CUE_WORDS[base]] : []) : Object.values(CUE_WORDS)
  return { common: tables.flatMap((t) => [...t.common]), section: tables.flatMap((t) => [...t.section]) }
}

/** How many of `words` from `i` the phrase covers ('#' a number of any script), or 0. */
function phraseAt(words: readonly string[], i: number, phrase: string): number {
  const parts = phrase.split(' ')
  for (let n = 0; n < parts.length; n++) {
    const w = words[i + n]
    if (w === undefined) return 0
    const k = cueKey(w)
    if (parts[n] === '#' ? !/^\p{Nd}+$/u.test(k) : k !== parts[n]) return 0
    // Only the phrase's last word may carry a comma or a stop.
    if (n < parts.length - 1 && /\p{P}$/u.test(w) && !w.endsWith("'")) return 0
  }
  return parts.length
}

const longestAt = (words: readonly string[], i: number, list: readonly string[]): number => list.reduce((best, p) => Math.max(best, phraseAt(words, i, p)), 0)

/**
 * How a sentence's first words announce a new part: 'section' (2.5) when it starts with a section
 * cue, also after common cue words ("Now let's move on"); 'cue' (1) when it starts with a common one;
 * null otherwise. A sentence counts once, as its strongest cue.
 */
export function sentenceCue(words: readonly string[], language?: string): 'section' | 'cue' | null {
  const { common, section } = cueLists(language)
  let i = 0
  while (i < words.length && !cueKey(words[i])) i++
  const first = i
  for (;;) {
    if (longestAt(words, i, section)) return 'section'
    const n = longestAt(words, i, common)
    if (!n) break
    i += n
  }
  return longestAt(words, first, common) ? 'cue' : null
}

/**
 * Sentences that start with a cue (§7.3): a common one ("now", "next", "so", bn "এখন") gives 1, a
 * section one ("moving on", "step 2", bn "ধাপ ২") 2.5, at the sentence's first word. Cue words in
 * the middle of a sentence give nothing.
 */
export function cueCandidates(segments: readonly CaptionSegment[], language?: string): Candidate[] {
  const words = captionsWords(segments)
  const out: Candidate[] = []
  for (const [a, b] of sentencesOf(words)) {
    const cue = sentenceCue(
      words.slice(a, Math.min(b + 1, a + 6)).map((w) => w.text),
      language
    )
    if (!cue) continue
    const t = words[a].start
    if (Number.isFinite(t)) out.push({ t, v: t, score: cue === 'section' ? S.section : S.common, from: [cue] })
  }
  return out
}

/** Every language's stop words: TextTiling is told no language. */
const ALL_STOP_WORDS: ReadonlySet<string> = new Set(Object.values(STOP_WORDS).flatMap((s) => [...s]))

/** Cosine similarity of two term counts. */
function cosine(a: ReadonlyMap<string, number>, b: ReadonlyMap<string, number>): number {
  let dot = 0
  let na = 0
  let nb = 0
  for (const [w, n] of a) {
    na += n * n
    const m = b.get(w)
    if (m) dot += n * m
  }
  for (const n of b.values()) nb += n * n
  return na && nb ? dot / Math.sqrt(na * nb) : 0
}

/**
 * Topic shifts by TextTiling (Hearst 1997; §7.3): the words in pseudo-sentences of `w` words (stop
 * words then left out), the similarity of the `k` pseudo-sentences before each gap with the `k`
 * after it (cosine of their word counts), smoothed over `smooth` + 1 gaps, and each valley's depth:
 * how far the similarity climbs on its left and on its right (a difference of cosines, 0..2).
 * Boundaries are the valleys deeper than the mean depth less half its standard deviation, at least
 * 4 gaps apart (the deeper kept), at the first word after the gap. In time order.
 */
export function textTiling(words: readonly { text: string; start: number }[], opts: { w: number; k: number; smooth: number } = { w: 20, k: 6, smooth: 2 }): { t: number; depth: number }[] {
  const w = Math.max(1, Math.round(opts.w))
  const k = Math.max(1, Math.round(opts.k))
  const seqs: { counts: Map<string, number>; start: number }[] = []
  for (let i = 0; i < words.length; i += w) {
    const counts = new Map<string, number>()
    for (const word of words.slice(i, i + w)) {
      const key = normalizeWord(word.text)
      if (!key || ALL_STOP_WORDS.has(key) || Array.from(key).length < 3) continue
      counts.set(key, (counts.get(key) ?? 0) + 1)
    }
    seqs.push({ counts, start: words[i].start })
  }
  // A gap after each pseudo-sentence but the last.
  const gaps = seqs.length - 1
  if (gaps < 3) return []
  const block = (from: number, to: number): Map<string, number> => {
    const m = new Map<string, number>()
    for (let i = Math.max(0, from); i < Math.min(seqs.length, to); i++) for (const [word, n] of seqs[i].counts) m.set(word, (m.get(word) ?? 0) + n)
    return m
  }
  const raw: number[] = []
  for (let g = 0; g < gaps; g++) raw.push(cosine(block(g + 1 - k, g + 1), block(g + 1, g + 1 + k)))
  const half = Math.max(0, Math.floor(opts.smooth / 2))
  const score = raw.map((_, g) => {
    let sum = 0
    let n = 0
    for (let j = g - half; j <= g + half; j++) {
      if (j < 0 || j >= raw.length) continue
      sum += raw[j]
      n++
    }
    return sum / n
  })
  const depth = score.map((s, g) => {
    let left = s
    for (let j = g - 1; j >= 0 && score[j] >= left - EPS; j--) left = score[j]
    let right = s
    for (let j = g + 1; j < score.length && score[j] >= right - EPS; j++) right = score[j]
    return left - s + (right - s)
  })
  // Near either end a block holds fewer pseudo-sentences and reads as less similar: a gap counts
  // only with at least half a block on each side.
  const least = Math.ceil(k / 2)
  const judged: number[] = []
  for (let g = 1; g < gaps - 1; g++) if (Math.min(g + 1, seqs.length - g - 1) >= least) judged.push(g)
  if (!judged.length) return []
  const mean = judged.reduce((a, g) => a + depth[g], 0) / judged.length
  const sd = Math.sqrt(judged.reduce((a, g) => a + (depth[g] - mean) ** 2, 0) / judged.length)
  const cutoff = mean - sd / 2
  // Valleys: lower than the gap before, not higher than the one after (a flat bottom counts at its first gap).
  const valleys = judged.filter((g) => score[g] < score[g - 1] - EPS && score[g] <= score[g + 1] + EPS && depth[g] > cutoff + EPS && depth[g] > EPS)
  // At least 4 gaps apart: the deeper first.
  const chosen: number[] = []
  for (const g of [...valleys].sort((a, b) => depth[b] - depth[a] || a - b)) if (chosen.every((c) => Math.abs(c - g) >= 4)) chosen.push(g)
  return chosen.sort((a, b) => a - b).map((g) => ({ t: seqs[g + 1].start, depth: depth[g] }))
}

/** A topic boundary's score: `2 × min(1, depth ÷ 0.5)`. */
export const topicScore = (depth: number): number => S.topic * Math.min(1, Math.max(0, depth) / CHAPTER_RULES.topicDepth)

/** Topic shifts as candidates, each moved to the nearest sentence start (§7.3). */
export function topicCandidates(words: readonly { text: string; start: number }[], sentenceStarts: readonly number[]): Candidate[] {
  const out: Candidate[] = []
  for (const b of textTiling(words)) {
    let t = b.t
    let best = Infinity
    for (const s of sentenceStarts) {
      const d = Math.abs(s - b.t)
      if (d < best - EPS) {
        best = d
        t = s
      }
    }
    const score = topicScore(b.depth)
    if (score > EPS) out.push({ t, v: t, score, from: ['topic'] })
  }
  return out
}

/** Whether a title card is the user's own: centred, big or a lower third, not made automatically or by the brand kit. */
export const userCard = (card: TitleCard): boolean => !card.auto && !card.brand && card.style !== 'quote' && !!card.title?.trim()

/** The starts of the user's own title cards (§7.3): 4 each. A card Captions Studio made from a chapter gives nothing. */
export function cardCandidates(titles: readonly TitleCard[]): Candidate[] {
  return titles.filter((c) => userCard(c) && Number.isFinite(c.start)).map((c) => ({ t: c.start, v: c.start, score: S.card, from: ['card'] }))
}

/** An AI's suggested starts (§7.6.1): 3.5 each, with the suggested title. */
export function aiCandidates(chapters: readonly { t: number; title: string }[]): Candidate[] {
  return chapters.filter((c) => Number.isFinite(c.t) && c.t >= 0).map((c) => ({ t: c.t, v: c.t, score: S.ai, from: ['ai'], ai: { title: c.title } }))
}

/**
 * Candidates within 2 s of the first of a run merged into one (§7.3): its score the sum of the best
 * score of each kind present, its signals the kinds present (strongest first), an AI title kept;
 * then moved to the nearest sentence start within 2 s of its strongest member, else left at a
 * title card's start, a screen change, or the speech start. User chapters (`fixed`) never merge and
 * never move.
 */
export function mergeCandidates(list: readonly Candidate[], sentenceStarts: readonly number[]): Candidate[] {
  const sorted = list.filter((c) => !c.fixed && Number.isFinite(c.t)).sort((a, b) => a.t - b.t || b.score - a.score)
  const starts = [...sentenceStarts].filter(Number.isFinite).sort((a, b) => a - b)
  const out: Candidate[] = []
  let i = 0
  while (i < sorted.length) {
    const group = [sorted[i]]
    let j = i + 1
    while (j < sorted.length && sorted[j].t - sorted[i].t <= CHAPTER_RULES.merge + EPS) group.push(sorted[j++])
    i = j
    // The best score of each kind, and each signal at its best.
    const best = new Map<string, number>()
    const signals = new Map<ChapterSignal, number>()
    for (const c of group) {
      for (const s of c.from) {
        const kind = KIND[s]
        best.set(kind, Math.max(best.get(kind) ?? 0, c.score))
        signals.set(s, Math.max(signals.get(s) ?? 0, c.score))
      }
    }
    const score = [...best.values()].reduce((a, b) => a + b, 0)
    const from = [...signals.entries()].sort((a, b) => b[1] - a[1] || ORDER.indexOf(a[0]) - ORDER.indexOf(b[0])).map(([s]) => s)
    const strongest = group.reduce((a, b) => (b.score > a.score + EPS ? b : a))
    const ai = group.find((c) => c.ai)?.ai
    const card = group.find((c) => c.from.includes('card'))
    let t = strongest.t
    if (card) t = card.t
    else {
      let near = Infinity
      for (const s of starts) {
        const d = Math.abs(s - strongest.t)
        if (d <= CHAPTER_RULES.snap + EPS && d < near - EPS) {
          near = d
          t = s
        }
      }
      if (!Number.isFinite(near)) {
        const screen = group.find((c) => c.from.includes('page') || c.from.includes('screen'))
        const pause = group.find((c) => c.from.includes('pause'))
        t = screen ? screen.t : pause ? pause.t : strongest.t
      }
    }
    out.push({ t, v: t, score, from, ...(ai ? { ai } : {}) })
  }
  return out
}
