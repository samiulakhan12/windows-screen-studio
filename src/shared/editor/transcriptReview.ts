/**
 * The fillers-and-retakes review list (NW-01, docs/design/edit-by-text.md §4.7): suggested cuts
 * that the user keeps or removes one by one, or all at once. Nothing here changes the project;
 * applySuggestions gives the clips for one store update (one undo step).
 */
import { findFillers } from './fillers'
import { findRetakes, type RetakeKind } from './retakes'
import { cutFlags, cutWords, spansSaving, type TranscriptWord, type WordSpan } from './transcript'
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

/** Suggestions that would save less (output seconds) are not listed: they are already cut. */
export const MIN_SUGGESTION_SAVING = 0.05

export const SUGGESTION_LABELS: Record<SuggestionKind, string> = { filler: 'Filler', retake: 'Retake', repeat: 'Repeat' }

const idOf = (kind: SuggestionKind, [first, last]: WordSpan): string => `${kind}:${first}-${last}`

/** Whether the take a retake or repeat leaves in is still in the edit (cut, removing it would lose every take). */
const keepsATake = (s: { keeps?: readonly number[] }, cut: readonly boolean[]): boolean => !s.keeps || s.keeps.some((i) => !cut[i])

/**
 * Fillers and retakes in order, those inside a retake left out (it covers them), each with what it
 * saves on the current clips; ones that save nothing (already cut) are left out, and so are retakes
 * and repeats whose later take is cut.
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
  const cut = cutFlags(words, clips)
  return items
    .filter((it) => keepsATake(it, cut))
    .map((it) => ({
      id: idOf(it.kind, it.span),
      kind: it.kind,
      first: it.span[0],
      last: it.span[1],
      saved: spansSaving(clips, words, [it.span], duration),
      ...(it.keeps ? { keeps: it.keeps } : {})
    }))
    .filter((s) => s.saved >= MIN_SUGGESTION_SAVING)
}

/** The listed suggestions still worth removing on these clips (and whose later take is kept), with what each saves now. */
export function refreshSuggestions(items: readonly EditSuggestion[], words: readonly TranscriptWord[], clips: readonly Clip[], duration: number): EditSuggestion[] {
  const cut = cutFlags(words, clips)
  return items
    .filter((s) => words[s.first] && words[s.last] && keepsATake(s, cut))
    .map((s) => ({ ...s, saved: spansSaving(clips, words, [[s.first, s.last]], duration) }))
    .filter((s) => s.saved >= MIN_SUGGESTION_SAVING)
}

/** The clips with these suggestions cut (one store update), and the output seconds that saves. */
export function applySuggestions(clips: Clip[], words: readonly TranscriptWord[], items: readonly EditSuggestion[], duration: number): { clips: Clip[]; saved: number } {
  const spans: WordSpan[] = items.map((s) => [s.first, s.last])
  const next = cutWords(clips, words, spans, duration)
  return { clips: next, saved: Math.max(0, outputDuration(clips) - outputDuration(next)) }
}
