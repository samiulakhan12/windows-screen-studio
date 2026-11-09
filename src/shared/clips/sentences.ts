/**
 * The sentences short clips are picked from (docs/design/smart-tools.md §8.1): the kept words'
 * sentences (sentencesOf), each with its time in the video and what makes it worth posting: how
 * packed it is, its key words, the user's emphasis, statistics, what happens on screen, fillers,
 * and the words of Focus on. Earlier takes of a retake are marked; sentences of fewer than 3
 * words are left out. Offline and pure.
 */
import type { SceneScan } from '../api/projects'
import { emphasisScores } from '../captions/emphasis'
import { findNumbers } from '../captions/numbers'
import { spokenSegments } from '../captions/subtitles'
import { transcriptLanguage } from '../captions/captionTracks'
import { studioTokens } from '../captions/words'
import { userChapters } from '../chapters/pending'
import { findFillers } from '../editor/fillers'
import { findRetakes, sentencesOf } from '../editor/retakes'
import { captionsWords, cutFlags, normalizeWord, type TranscriptWord } from '../editor/transcript'
import { planOf, videoTimesAt } from '../engine/freeze'
import { screenChanges } from '../smart/screenChanges'
import type { CaptionSegment, CursorTrack, Project } from '../types'

export interface ScoredSentence {
  /** Source seconds of its first word's start and its last word's end. */
  start: number
  end: number
  /** Viewing seconds (clip speeds and pause freezes) from start to end. */
  seconds: number
  /** As said (bleeped words masked, as the subtitles carry them). */
  text: string
  words: number
  features: {
    /** Words a second, z-scored over the recording. */
    density: number
    /** The sum of key-word scores of 2.5 or more a second, z-scored. */
    keywords: number
    /** 1 when the user (not an automatic tool) emphasised a word in it. */
    emphasis: number
    /** 0.5 for each statistic, at most 1. */
    numbers: number
    /** Clicks, typing, zoom starts and screen changes in it: min(1, count / 3). */
    action: number
    /** Fillers a second, z-scored (subtracted from the score). */
    fillers: number
    /** 2 when it holds a word of Focus on. */
    focus: number
  }
  /** The earlier take of a retake: never picked. */
  retake: boolean
  /** Index of the user chapter it starts in (0 without chapters). */
  chapter: number
}

/** A sentence with what moments and the shorter version also read. */
export interface ClipSentence extends ScoredSentence {
  /** Video seconds of start and end. */
  vStart: number
  vEnd: number
  /** Silence before its first word and after its last (source seconds; Infinity at the ends). */
  gapBefore: number
  gapAfter: number
  /** Indexes of its first and last word in `keptClipWords`. */
  from: number
  to: number
  /** Clicks in it (the reason "6 clicks"). */
  clicks: number
  /** Share of its words that are fillers. */
  fillerShare: number
  /** The Focus on word it mentions, as typed. */
  focusWord: string | null
}

/** Shortest sentence (words) kept (§8.1). */
export const MIN_SENTENCE_WORDS = 3
/** Key-word scores from this up count (Captions Studio's candidates, emphasis.ts EMPHASIS_MIN). */
const KEYWORD_MIN = 2.5
/** Letters of a Latin word Focus on compares (Billing's, billing). */
const FOCUS_PREFIX = 5
/** A sentence's seconds are at least this when dividing by them. */
const MIN_SECONDS = 0.5
const EPS = 1e-9

let wordsMemo: { transcript: Project['transcript']; bleeps: Project['bleeps']; clips: Project['clips']; words: TranscriptWord[] } | null = null

/** The kept words of the transcript (masked as the subtitles say them), in order. Memoised on the transcript, bleeps and clips (one entry). */
export function keptClipWords(project: Pick<Project, 'transcript' | 'bleeps' | 'clips'>): TranscriptWord[] {
  const { transcript, bleeps, clips } = project
  if (wordsMemo && wordsMemo.transcript === transcript && wordsMemo.bleeps === bleeps && wordsMemo.clips === clips) return wordsMemo.words
  let words: TranscriptWord[] = []
  if (clips?.length) {
    const all = captionsWords(spokenSegments(project))
    const cut = cutFlags(all, clips)
    words = all.filter((_, i) => !cut[i])
  }
  wordsMemo = { transcript, bleeps, clips, words }
  return words
}

const LATIN = /\p{Script=Latin}/u

/** How Focus on compares a word: lower case, the first 5 letters in Latin scripts, whole in others. */
export function focusKey(word: string): string {
  const k = normalizeWord(word)
  return LATIN.test(k) ? [...k].slice(0, FOCUS_PREFIX).join('') : k
}

/** The words of Focus on ("billing, export"), each with its key; empty words dropped. */
export function focusWords(focus: string | undefined): { word: string; key: string }[] {
  const out: { word: string; key: string }[] = []
  const seen = new Set<string>()
  for (const raw of (focus ?? '').split(/[\s,;،、，；]+/u)) {
    const word = raw.replace(/^[\p{P}\p{S}]+|[\p{P}\p{S}]+$/gu, '')
    const key = focusKey(word)
    if (!key || seen.has(key)) continue
    seen.add(key)
    out.push({ word, key })
  }
  return out
}

/** The z-scores of `xs` (all 0 when they do not vary). */
function zScores(xs: readonly number[]): number[] {
  if (xs.length === 0) return []
  const mean = xs.reduce((s, x) => s + x, 0) / xs.length
  const sd = Math.sqrt(xs.reduce((s, x) => s + (x - mean) ** 2, 0) / xs.length)
  return sd < 1e-9 ? xs.map(() => 0) : xs.map((x) => (x - mean) / sd)
}

/** The index of the last of `starts` (sorted) at or before `t`, or -1. */
export function lastAtOrBefore(starts: readonly number[], t: number): number {
  let lo = 0
  let hi = starts.length
  while (lo < hi) {
    const mid = (lo + hi) >> 1
    if (starts[mid] <= t + EPS) lo = mid + 1
    else hi = mid
  }
  return lo - 1
}

/** The source time of each studio word of `seg` (its start), by word index. */
function wordTimes(seg: CaptionSegment, language: string | undefined): Map<number, number> {
  const out = new Map<number, number>()
  for (const t of studioTokens(seg, language)) if (t.word >= 0 && !out.has(t.word)) out.set(t.word, t.start)
  return out
}

interface Memo {
  project: Project
  track: CursorTrack | null
  scan: SceneScan | null
  focus: string
  out: ClipSentence[]
}
let memo: Memo | null = null

/**
 * Every sentence of 3 words or more (§8.1), in order, with its features and what moments and the
 * shorter version read besides. Memoised on its inputs (one entry): the panel asks again on every
 * render.
 */
export function clipSentences(project: Project, ctx: { track: CursorTrack | null; scan: SceneScan | null; focus?: string }): ClipSentence[] {
  const focus = ctx.focus ?? ''
  if (memo && memo.project === project && memo.track === ctx.track && memo.scan === ctx.scan && memo.focus === focus) return memo.out
  const out = makeSentences(project, ctx.track, ctx.scan, focus)
  memo = { project, track: ctx.track, scan: ctx.scan, focus, out }
  return out
}

/** The sentences of §8.1 with their features (features in the recording's own terms). */
export function scoredSentences(project: Project, ctx: { track: CursorTrack | null; scan: SceneScan | null; focus?: string }): ScoredSentence[] {
  return clipSentences(project, ctx)
}

function makeSentences(project: Project, track: CursorTrack | null, scan: SceneScan | null, focus: string): ClipSentence[] {
  const words = keptClipWords(project)
  if (words.length === 0) return []
  const language = transcriptLanguage(project.transcript)
  const spans = sentencesOf(words)
  const plan = planOf(project)
  const clips = project.clips
  const times: number[] = []
  for (const [a, b] of spans) times.push(words[a].start, words[b].end)
  const video = videoTimesAt(clips, plan, times)

  // The earlier takes of retakes (stutters are not takes).
  const retakeWord = new Uint8Array(words.length)
  for (const m of findRetakes(words, language)) if (m.kind === 'retake') for (let i = m.span[0]; i <= m.span[1]; i++) retakeWord[i] = 1
  // Fillers.
  const fillerWord = new Uint8Array(words.length)
  for (const [a, b] of findFillers(words, language)) for (let i = a; i <= b; i++) fillerWord[i] = 1

  const starts = spans.map(([a]) => words[a].start)
  /** The sentence `t` falls in (between its first word's start and its last word's end), or -1. */
  const sentenceAt = (t: number): number => {
    const k = lastAtOrBefore(starts, t)
    return k >= 0 && t <= words[spans[k][1]].end + EPS ? k : -1
  }
  const n = spans.length
  const keywordSum = new Float64Array(n)
  const emphasised = new Uint8Array(n)
  const statistics = new Uint16Array(n)
  const actions = new Uint16Array(n)
  const clicks = new Uint16Array(n)

  // Key words, the user's marks and statistics: by the time of their word.
  const segments = project.transcript?.segments ?? []
  const byId = new Map(segments.map((s) => [s.id, s]))
  const timesOf = new Map<string, Map<number, number>>()
  const timeOf = (caption: string, word: number): number | null => {
    const seg = byId.get(caption)
    if (!seg) return null
    let t = timesOf.get(caption)
    if (!t) timesOf.set(caption, (t = wordTimes(seg, language)))
    return t.get(word) ?? null
  }
  for (const w of emphasisScores(segments, { language, ...(track ? { cursor: track } : {}), clips })) {
    if (w.score < KEYWORD_MIN) continue
    const t = timeOf(w.caption, w.word)
    const k = t === null ? -1 : sentenceAt(t)
    if (k >= 0) keywordSum[k] += w.score
  }
  for (const m of project.captionMarks ?? []) {
    if (m.auto) continue
    const t = timeOf(m.caption, m.from)
    const k = t === null ? -1 : sentenceAt(t)
    if (k >= 0) emphasised[k] = 1
  }
  for (const seg of segments) {
    for (const num of findNumbers(seg, language)) {
      if (!num.statistic) continue
      const t = timeOf(seg.id, num.from)
      const k = t === null ? -1 : sentenceAt(t)
      if (k >= 0) statistics[k]++
    }
  }
  // What happens on screen: clicks, typing, zoom starts and settled screen changes.
  const act = (t: number, click = false): void => {
    const k = sentenceAt(t)
    if (k < 0) return
    actions[k]++
    if (click) clicks[k]++
  }
  for (const c of track?.clicks ?? []) act(c.t, true)
  for (const b of track?.typing ?? []) act(b.t)
  for (const z of project.zooms) act(z.start)
  if (scan) for (const c of screenChanges(scan, track?.scrolls)) act(c.t)

  // User chapters, for the shorter version's one sentence per chapter.
  const chapterStarts = userChapters(project)
    .map((c) => c.t)
    .sort((a, b) => a - b)
  const wanted = focusWords(focus)

  const kept: { k: number; seconds: number; count: number }[] = []
  spans.forEach(([a, b], k) => {
    const count = b - a + 1
    if (count < MIN_SENTENCE_WORDS) return
    kept.push({ k, seconds: Math.max(0, video[2 * k + 1] - video[2 * k]), count })
  })
  const density = zScores(kept.map((s) => s.count / Math.max(MIN_SECONDS, s.seconds)))
  const keywords = zScores(kept.map((s) => keywordSum[s.k] / Math.max(MIN_SECONDS, s.seconds)))
  const fillersPerSecond = kept.map((s) => {
    let f = 0
    for (let i = spans[s.k][0]; i <= spans[s.k][1]; i++) f += fillerWord[i]
    return f
  })
  const fillers = zScores(kept.map((s, i) => fillersPerSecond[i] / Math.max(MIN_SECONDS, s.seconds)))

  return kept.map((s, i): ClipSentence => {
    const [a, b] = spans[s.k]
    const list = words.slice(a, b + 1)
    let focusWord: string | null = null
    if (wanted.length) {
      for (const w of list) {
        const key = focusKey(w.text)
        const hit = wanted.find((f) => f.key === key)
        if (hit) {
          focusWord = hit.word
          break
        }
      }
    }
    let retake = false
    for (let j = a; j <= b && !retake; j++) retake = retakeWord[j] === 1
    return {
      start: words[a].start,
      end: words[b].end,
      seconds: s.seconds,
      text: list.map((w) => w.text).join(' '),
      words: s.count,
      features: {
        density: density[i],
        keywords: keywords[i],
        emphasis: emphasised[s.k],
        numbers: Math.min(1, statistics[s.k] * 0.5),
        action: Math.min(1, actions[s.k] / 3),
        fillers: fillers[i],
        focus: focusWord ? 2 : 0
      },
      retake,
      chapter: Math.max(0, lastAtOrBefore(chapterStarts, words[a].start)),
      vStart: video[2 * s.k],
      vEnd: video[2 * s.k + 1],
      gapBefore: a > 0 ? words[a].start - words[a - 1].end : Infinity,
      gapAfter: b + 1 < words.length ? words[b + 1].start - words[b].end : Infinity,
      from: a,
      to: b,
      clicks: clicks[s.k],
      fillerShare: fillersPerSecond[i] / s.count,
      focusWord
    }
  })
}
