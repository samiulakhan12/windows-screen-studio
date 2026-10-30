/**
 * The ranges the fillers-and-retakes list's Remove all cuts, with what each removed, so Review mode
 * can list them as "Removed “um”" (docs/design/review-mode.md §4.1). Pure.
 */
import { wordsRange, type TranscriptWord } from '../editor/transcript'
import type { EditSuggestion } from '../editor/transcriptReview'
import type { AutoRange } from './autoCuts'

/** One range per suggestion (transcript.ts wordsRange, as cutWords cuts it), by its kind, with its words. */
export function suggestionRanges(words: readonly TranscriptWord[], items: readonly Pick<EditSuggestion, 'kind' | 'first' | 'last'>[], duration: number): AutoRange[] {
  return items
    .filter((s) => words[s.first] && words[s.last])
    .map((s) => ({
      ...wordsRange(words, s.first, s.last, duration),
      by: s.kind,
      words: words
        .slice(Math.min(s.first, s.last), Math.max(s.first, s.last) + 1)
        .map((w) => w.text)
        .join(' ')
    }))
}
