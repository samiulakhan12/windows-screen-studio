/**
 * The speaker notes' text as the notes window shows it and the scroll engine paces it
 * (docs/design/teleprompter.md, "Text"). Each non-empty line is a block; a blank line before it
 * only adds space. A line starting with "- ", "* ", "• " or "1. " / "1) " is a bullet (the marker
 * is drawn, not counted). [Text in square brackets] is a cue: shown dimmed and in italics, never
 * counted as spoken. Words are counted with Intl.Segmenter (isWordLike), so languages written
 * without spaces count too. Nothing is ever interpreted as markup: the page renders text nodes.
 *
 * STUB (contracts commit): signatures and doc comments frozen, bodies by workstream B.
 */

/** A run of a block's text: spoken, or a cue in brackets (the brackets are not part of `text`). */
export interface NoteRun {
  text: string
  cue: boolean
}

export interface NotesBlock {
  /** Position in the list (0-based). */
  index: number
  kind: 'para' | 'bullet'
  /** The bullet's own marker as typed ("-", "•", "2.") for a bullet, '' for a paragraph. */
  marker: string
  runs: NoteRun[]
  /** Spoken words (cues excluded). */
  words: number
  /** Spoken words in all earlier blocks (where this block starts in the whole text; for F-27 later). */
  firstWord: number
  /** A blank line came before it. */
  gapBefore: boolean
}

/** The blocks of `text` (CR LF, CR and LF all end a line). */
export function splitBlocks(_text: string): NotesBlock[] {
  throw new Error('splitBlocks: not implemented yet (workstream B)')
}

/** Spoken words in `text` (cues excluded). */
export function countWords(_text: string): number {
  throw new Error('countWords: not implemented yet (workstream B)')
}

/** Seconds to read `words` at `wpm` words per minute. */
export function readingSeconds(_words: number, _wpm: number): number {
  throw new Error('readingSeconds: not implemented yet (workstream B)')
}

/** "about 45 s", "about 2 min 24 s", "about 1 h 5 min" (seconds rounded to whole ones). */
export function readingLabel(_seconds: number): string {
  throw new Error('readingLabel: not implemented yet (workstream B)')
}
