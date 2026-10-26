/**
 * The speaker notes' text as the notes window shows it and the scroll engine paces it
 * (docs/design/teleprompter.md, "Text"). Each non-empty line is a block; a blank line before it
 * only adds space. A line starting with "- ", "* ", "• " or "1. " / "1) " is a bullet (the marker
 * is drawn, not counted). [Text in square brackets] is a cue: shown dimmed and in italics, never
 * counted as spoken. Words are counted with Intl.Segmenter (isWordLike), so languages written
 * without spaces count too. Nothing is ever interpreted as markup: the page renders text nodes.
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

/** "- ", "* ", "• ", "1. " or "1) " at the start of a line (after any indentation). */
const BULLET = /^\s*([-*•]|\d{1,3}[.)])\s+(?=\S)/
/** A cue: [text in square brackets] on one line. */
const CUE = /\[([^\[\]\n]*)\]/g

let segmenter: Intl.Segmenter | null | undefined

/** Word-like segments of `text` (cues not removed: callers pass spoken text only). */
function spokenWords(text: string): number {
  if (!text.trim()) return 0
  if (segmenter === undefined) {
    try {
      segmenter = typeof Intl !== 'undefined' && 'Segmenter' in Intl ? new Intl.Segmenter(undefined, { granularity: 'word' }) : null
    } catch {
      segmenter = null
    }
  }
  if (!segmenter) return text.split(/\s+/).filter((w) => /[\p{L}\p{N}]/u.test(w)).length
  let n = 0
  for (const s of segmenter.segment(text)) if (s.isWordLike) n++
  return n
}

/** A line's text as runs: spoken text and [cues]. An unclosed "[" stays spoken text. */
function runsOf(line: string): NoteRun[] {
  const runs: NoteRun[] = []
  let at = 0
  for (const m of line.matchAll(CUE)) {
    const i = m.index ?? 0
    if (i > at) runs.push({ text: line.slice(at, i), cue: false })
    if (m[1].trim()) runs.push({ text: m[1], cue: true })
    at = i + m[0].length
  }
  if (at < line.length) runs.push({ text: line.slice(at), cue: false })
  return runs
}

const runWords = (runs: readonly NoteRun[]): number => runs.reduce((n, r) => (r.cue ? n : n + spokenWords(r.text)), 0)

/** The blocks of `text` (CR LF, CR and LF all end a line). */
export function splitBlocks(text: string): NotesBlock[] {
  const blocks: NotesBlock[] = []
  let gap = false
  let words = 0
  for (const raw of text.split(/\r\n|\r|\n/)) {
    const line = raw.trim()
    if (!line) {
      gap = blocks.length > 0
      continue
    }
    const bullet = BULLET.exec(line)
    const body = bullet ? line.slice(bullet[0].length) : line
    const runs = runsOf(body)
    const count = runWords(runs)
    blocks.push({ index: blocks.length, kind: bullet ? 'bullet' : 'para', marker: bullet ? bullet[1] : '', runs, words: count, firstWord: words, gapBefore: gap })
    words += count
    gap = false
  }
  return blocks
}

/** Spoken words in `text` (cues excluded). */
export function countWords(text: string): number {
  let n = 0
  for (const raw of text.split(/\r\n|\r|\n/)) {
    const line = raw.trim()
    if (!line) continue
    const bullet = BULLET.exec(line)
    n += runWords(runsOf(bullet ? line.slice(bullet[0].length) : line))
  }
  return n
}

/** Seconds to read `words` at `wpm` words per minute. */
export function readingSeconds(words: number, wpm: number): number {
  if (!(words > 0) || !(wpm > 0)) return 0
  return (words / wpm) * 60
}

/** "about 45 s", "about 2 min 24 s", "about 1 h 5 min" (seconds rounded to whole ones). */
export function readingLabel(seconds: number): string {
  const s = Math.max(0, Math.round(Number.isFinite(seconds) ? seconds : 0))
  if (s < 60) return `about ${s} s`
  if (s < 3600) {
    const m = Math.floor(s / 60)
    const rest = s % 60
    return rest ? `about ${m} min ${rest} s` : `about ${m} min`
  }
  const minutes = Math.round(s / 60)
  const h = Math.floor(minutes / 60)
  const m = minutes % 60
  return m ? `about ${h} h ${m} min` : `about ${h} h`
}
