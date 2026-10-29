/**
 * The fillers-and-retakes review list (NW-01, docs/design/edit-by-text.md §4.7): suggested cuts
 * that the user keeps or removes one by one, or all at once. Nothing here changes the project;
 * applySuggestions gives the clips for one store update (one undo step).
 */
import { findFillers } from './fillers'
import { findRetakes, type RetakeKind } from './retakes'
import { cutFlags, cutWords, middlesCut, spansSaving, type TranscriptWord, type WordSpan } from './transcript'
import { outputDuration } from '../engine/timeline'
import type { Clip } from '../types'

export type SuggestionKind = 'filler' | RetakeKind

export interface EditSuggestion {
  /** Stable while the transcript does not change: kind and span. */
  id: string
  kind: SuggestionKind
  first: number
  last: number
  /** Output seconds removing it saves now. */
  saved: number
  /** A retake or repeat: the words of the later takes it leaves in (RetakeMatch.keeps); listed only while one is kept. */
  keeps?: readonly number[]
}

/**
 * Suggestions that would save less (output seconds) are not listed: they are already cut (unless
 * removing them strikes through a word the tab shows kept: worthRemoving).
 */
export const MIN_SUGGESTION_SAVING = 0.05

export const SUGGESTION_LABELS: Record<SuggestionKind, string> = { filler: 'Filler', retake: 'Retake', repeat: 'Repeat' }

const idOf = (kind: SuggestionKind, [first, last]: WordSpan): string => `${kind}:${first}-${last}`

/** Each word on the clips: whether the tab shows it cut (cutFlags), and whether its middle is in no clip, its time heard or a guess (middlesCut). */
interface WordStates {
  shown: boolean[]
  middle: boolean[]
}

const statesOf = (words: readonly TranscriptWord[], clips: readonly Clip[]): WordStates => ({ shown: cutFlags(words, clips), middle: middlesCut(words, clips) })

/**
 * Whether the take a retake or repeat leaves in is still in the edit: a word a cut may have taken
 * out (its middle cut, a guess the tab still shows kept included, §4.2 rule 3, or shown cut) is not.
 * When unsure it is not: removing the earlier take would lose every take.
 */
const keepsATake = (s: { keeps?: readonly number[] }, w: WordStates): boolean => !s.keeps || s.keeps.some((i) => !w.middle[i] && !w.shown[i])

/**
 * Whether removing a suggestion that saves `saved` changes the edit: it saves time, or it strikes
 * through a word the tab shows kept whose time is already cut (a guess inside a timeline or Smart
 * speed cut, §4.2 rule 3), which Remove marks deleted without changing the clips (rule 4).
 */
function worthRemoving(s: { first: number; last: number; saved: number }, w: WordStates): boolean {
  if (s.saved >= MIN_SUGGESTION_SAVING) return true
  for (let i = s.first; i <= s.last; i++) if (w.middle[i] && !w.shown[i]) return true
  return false
}

/**
 * Fillers and retakes in order, those inside a retake left out (it covers them), each with what it
 * saves on the current clips; ones that change nothing (already cut: worthRemoving) are left out,
 * and so are retakes and repeats whose later take is cut.
 */
export function reviewSuggestions(words: readonly TranscriptWord[], clips: readonly Clip[], duration: number, language?: string): EditSuggestion[] {
  const retakes = findRetakes(words, language)
  const inRetake = (s: WordSpan): boolean => retakes.some((r) => r.kind === 'retake' && s[0] >= r.span[0] && s[1] <= r.span[1])
  const overlaps = (s: WordSpan): boolean => retakes.some((r) => s[0] <= r.span[1] && s[1] >= r.span[0])
  const items: { kind: SuggestionKind; span: WordSpan; keeps?: readonly number[] }[] = [
    ...retakes.map((r) => ({ kind: r.kind, span: r.span, keeps: r.keeps })),
    ...findFillers(words, language)
      .filter((s) => !inRetake(s) && !overlaps(s))
      .map((span) => ({ kind: 'filler' as const, span }))
  ]
  items.sort((a, b) => a.span[0] - b.span[0])
  const states = statesOf(words, clips)
  return items
    .filter((it) => keepsATake(it, states))
    .map((it) => ({
      id: idOf(it.kind, it.span),
      kind: it.kind,
      first: it.span[0],
      last: it.span[1],
      saved: spansSaving(clips, words, [it.span], duration),
      ...(it.keeps ? { keeps: it.keeps } : {})
    }))
    .filter((s) => worthRemoving(s, states))
}

/** The listed suggestions still worth removing on these clips (and whose later take is kept), with what each saves now. */
export function refreshSuggestions(items: readonly EditSuggestion[], words: readonly TranscriptWord[], clips: readonly Clip[], duration: number): EditSuggestion[] {
  const states = statesOf(words, clips)
  return items
    .filter((s) => words[s.first] && words[s.last] && keepsATake(s, states))
    .map((s) => ({ ...s, saved: spansSaving(clips, words, [[s.first, s.last]], duration) }))
    .filter((s) => worthRemoving(s, states))
}

/** The clips with these suggestions cut (one store update, with anchorCutWords' marks), and the output seconds that saves. */
export function applySuggestions(clips: Clip[], words: readonly TranscriptWord[], items: readonly EditSuggestion[], duration: number): { clips: Clip[]; saved: number } {
  const spans: WordSpan[] = items.map((s) => [s.first, s.last])
  const next = cutWords(clips, words, spans, duration)
  return { clips: next, saved: Math.max(0, outputDuration(clips) - outputDuration(next)) }
}
