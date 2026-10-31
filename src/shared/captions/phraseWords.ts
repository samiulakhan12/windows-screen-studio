/**
 * The words line breaks look at (docs/design/captions-studio.md §8.3): join words per language,
 * sentence and clause ends, and the Chinese and Japanese line rules (kinsoku). Part P1 completes
 * the join lists for es, fr, de and pt.
 */

/** Words a line should not end with and may start with (§8.3), by language; other languages use punctuation and pauses only. */
export const JOIN_WORDS: Readonly<Record<string, readonly string[]>> = {
  en: ['and', 'but', 'or', 'so', 'because', 'that', 'which', 'when', 'while', 'if', 'to', 'of', 'in', 'on', 'at', 'for', 'with', 'from', 'by', 'about', 'into', 'than'],
  bn: ['এবং', 'কিন্তু', 'অথবা', 'যে', 'কারণ', 'জন্য', 'থেকে', 'দিয়ে', 'সাথে'],
  hi: ['और', 'लेकिन', 'या', 'कि', 'क्योंकि', 'के', 'की', 'का', 'में', 'से', 'पर']
}

/** A word that ends a sentence (§8.2, §8.3). */
export const SENTENCE_END = /[.!?…।۔。！？]["'”’)\]]*$/u
/** A word that ends a clause. */
export const CLAUSE_END = /[,;:–—、，；：]["'”’)\]]*$/u
/** Never at the start of a line (closing punctuation, the prolonged sound mark; §8.3 kinsoku). */
export const NO_LINE_START = /^[、。，．・：；？！ー」』）】〉》〕…]/u
/** Never at the end of a line (opening punctuation). */
export const NO_LINE_END = /[「『（【〈《〔]$/u
