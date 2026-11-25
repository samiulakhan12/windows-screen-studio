/**
 * Numbers said aloud as runs of digits (docs/design/auto-blur.md §7.2), read one way wherever a said
 * number is read: by the spoken rules (said.ts) and by the spoken forms of a private bleep
 * (spoken.ts, §7.3), so a run the rules find always has its digit form. Every word of every caption
 * in time order is one stream; a run ends at a pause over 2.0 s or a word that is neither a number
 * word nor a filler (`and` ends one). Pure: the word tables only.
 */
import { asciiDigits } from '../../captions/numbers'
import type { CaptionWord } from '../../types'
import { DIGIT_TOKEN, SAID_DIGITS, SAID_FILLERS, SAID_REPEAT, SAID_TENS, SAID_TENS_HYPHEN, VERSION_TOKEN, WORD_EDGES, ZERO_INSIDE_ONLY } from './tables'

export interface DigitRun {
  /** The digits said. */
  digits: string
  /** The first and last word of the run (indices into the words). */
  first: number
  last: number
  /** The digits each number word or token gave, in order ("4917", "6", "1", …). */
  tokens: string[]
  /** Each token's first and last word ("double" goes with the digit after it, "twenty five" is one token). */
  spans: [number, number][]
  /** Whether each token was said in words ("four", "twenty five", "double five", চার) rather than written in digits ("4829", ৪৮২৯). */
  spelled: boolean[]
  /**
   * The tokens a sentence or a clause ends before (a word with `.`, `!`, `?`, `।`, `…`, `,`, `;` or `:`
   * at its end, the token's own or a filler's) or a new caption starts at, in order: where the run may
   * hold more than one number (§7.2: "4917 6123 4567 8904. One second" is a card and a word).
   */
  breaks: number[]
  /** Those of the breaks where a sentence ended or a new caption started (not only a clause). */
  stops: number[]
}

/** A pause that ends a run of digits (seconds). */
const RUN_PAUSE = 2.0
/** A word that ends a sentence, and one that ends a clause, before closing quotes or brackets. */
const SENTENCE_STOP = /[.!?।…]["'”’»)\]]*$/u
const CLAUSE_END = /[,;:]["'”’»)\]]*$/u

/** A word as compared: NFC, lower case, punctuation and symbols off its ends, digits of every script as ASCII. */
export const saidWord = (w: string): string => asciiDigits(w.normalize('NFC').toLowerCase().replace(WORD_EDGES, ''))

/** The digits a bare word says ('' for none). */
function wordDigits(w: string): string {
  if (/^\d+$/.test(w)) return w
  if (VERSION_TOKEN.test(w)) return ''
  if (DIGIT_TOKEN.test(w)) return w.replace(/\D/g, '')
  if (Object.hasOwn(SAID_DIGITS, w)) return SAID_DIGITS[w]
  const hy = SAID_TENS_HYPHEN.exec(w)
  if (hy) return SAID_TENS[hy[1]] + SAID_DIGITS[hy[2]]
  if (Object.hasOwn(SAID_TENS, w)) return SAID_TENS[w] + '0'
  return ''
}

/**
 * Runs of digits said over the caption words in time order (§7.2): across captions and full stops,
 * ended by a pause over 2.0 s or a word that is neither a number word nor a filler (`and` ends one).
 * `captionStarts`: the indices of the words that start a caption, which mark a run's breaks.
 */
export function digitRuns(words: readonly CaptionWord[], captionStarts: ReadonlySet<number> = new Set()): DigitRun[] {
  const runs: DigitRun[] = []
  let cur: DigitRun | null = null
  let repeat = 0
  /** The word a token starts at ("double" before its digit). */
  let from = -1
  const close = (): void => {
    if (cur && cur.digits.length) runs.push(cur)
    cur = null
    repeat = 0
    from = -1
  }
  const open = (i: number): DigitRun => (cur ??= { digits: '', first: i, last: i, tokens: [], spans: [], spelled: [], breaks: [], stops: [] })
  /**
   * Adds a token said by words a..b to the open run (`spelled`: said in words, not written in digits),
   * with a break before it when a sentence, a clause or a caption ended since the last one.
   */
  const push = (run: DigitRun, d: string, a: number, b: number, spelled: boolean): void => {
    const prev = run.spans[run.spans.length - 1]
    if (prev) {
      let clause = false
      let stop = false
      for (let k = prev[1]; k < a; k++) {
        const text = words[k].text.trim()
        if (SENTENCE_STOP.test(text) || captionStarts.has(k + 1)) stop = true
        else if (CLAUSE_END.test(text)) clause = true
      }
      if (stop || clause) run.breaks.push(run.tokens.length)
      if (stop) run.stops.push(run.tokens.length)
    }
    run.digits += d
    run.tokens.push(d)
    run.spans.push([a, b])
    run.spelled.push(spelled)
    run.last = b
  }
  for (let i = 0; i < words.length; i++) {
    const w = saidWord(words[i].text)
    if (cur && i > 0 && words[i].start - words[i - 1].end > RUN_PAUSE) close()
    if (Object.hasOwn(SAID_REPEAT, w)) {
      open(i).last = i
      if (from < 0) from = i
      repeat = SAID_REPEAT[w]
      continue
    }
    let d = wordDigits(w)
    if (ZERO_INSIDE_ONLY.has(w) && !cur) d = ''
    // "twenty five": a tens word and a ones word make one number.
    if (d.length === 2 && d.endsWith('0') && i + 1 < words.length) {
      const next = saidWord(words[i + 1].text)
      const ones = Object.hasOwn(SAID_DIGITS, next) ? SAID_DIGITS[next] : ''
      if (ones.length === 1 && ones !== '0' && !ZERO_INSIDE_ONLY.has(next) && /^[a-z]+$/.test(next) && words[i + 1].start - words[i].end <= RUN_PAUSE) {
        push(open(i), d[0] + ones, from < 0 ? i : from, i + 1, true)
        repeat = 0
        from = -1
        i++
        continue
      }
    }
    if (d) {
      const run = open(i)
      // Said in words: a number word, or digits after "double" or "triple"; written: a digit token in any script.
      const spelled = from >= 0 || !/^\d/.test(w)
      if (repeat && d.length === 1) d = d.repeat(repeat)
      push(run, d, from < 0 ? i : from, i, spelled)
      repeat = 0
      from = -1
    } else if (cur && SAID_FILLERS.has(w)) {
      continue
    } else close()
  }
  close()
  return runs
}

/**
 * The digit string `texts` say when they are one run from the first word to the last, as digitRuns
 * reads them (fillers inside it skipped, "oh" read as zero inside it, "double" and "triple", the
 * number words of every language the rules read); null when they are not (§7.3).
 */
export function runDigitsOf(texts: readonly string[]): string | null {
  if (!texts.length) return null
  const runs = digitRuns(texts.map((text, i) => ({ text, start: i, end: i + 0.5 })))
  return runs.length === 1 && runs[0].first === 0 && runs[0].last === texts.length - 1 ? runs[0].digits : null
}
