/**
 * Cleaning a line the reader returned, its views and folding (docs/design/auto-blur.md §6.2). Every
 * view has the cleaned text's length, so a span found on any view maps back to the raw text through
 * `map` one to one. Pure.
 */
import { asciiDigits } from '../../captions/numbers'
import { AFTER_PREFIX, BULLET, DASH, DIGIT_GROUP_SEP, DIGITISH, LABEL_WORD, LINK_START, LOOKALIKES, PREFIX_FOLD, PREFIX_START, PREFIXES, TO_DIGIT, TWO_LETTERS, ZERO_WIDTH } from './tables'

export interface CleanLine {
  /** The cleaned text: NFKC, dashes as '-', bullet-like dots as '•', no zero-width characters, look-alikes inside Latin tokens as Latin. */
  text: string
  /** For each character of `text`, the index in the raw text of the character it came from; one more entry, the raw text's length. */
  map: Int32Array
  /** Bengali and Devanagari digits as ASCII; in runs of digit groups, OCR look-alike letters as digits. */
  digit: string
  /** Known token prefixes read with OCR confusions rewritten ("x0xb-" as "xoxb-"). */
  prefix: string
  /** Inside a link, a single space between two runs of 6 or more token characters filled (OCR reads '_' as a space). */
  url: string
  /** Inside words, digits read as the letters they stand for ("PASSW0RD"); labels are matched only here. */
  label: string
}

const SPACE = /\s/u
const MARK = /\p{M}/u
const LETTER = /[A-Za-z]/
const TOKEN = /[A-Za-z0-9_-]/

/** Whether each raw index lies in a whitespace-separated token that holds an ASCII letter or digit. */
function latinTokens(raw: string): Uint8Array {
  const out = new Uint8Array(raw.length)
  const space = (c: number): boolean => c === 32 || (c < 128 ? c >= 9 && c <= 13 : SPACE.test(String.fromCharCode(c)))
  let i = 0
  while (i < raw.length) {
    while (i < raw.length && space(raw.charCodeAt(i))) i++
    const start = i
    let latin = false
    while (i < raw.length && !space(raw.charCodeAt(i))) {
      const c = raw.charCodeAt(i)
      if ((c >= 48 && c <= 57) || (c >= 65 && c <= 90) || (c >= 97 && c <= 122)) latin = true
      i++
    }
    if (latin) out.fill(1, start, i)
  }
  return out
}

/** A line as the rules read it, with its views (§6.2). */
export function cleanLine(raw: string): CleanLine {
  const latin = latinTokens(raw)
  let text = ''
  const map: number[] = []
  let i = 0
  while (i < raw.length) {
    const c = raw.charCodeAt(i)
    // Printable ASCII is its own cleaned form (a mark after it is handled below).
    if (c >= 32 && c <= 126 && !(i + 1 < raw.length && raw.charCodeAt(i + 1) >= 0x300 && MARK.test(raw[i + 1]))) {
      text += c === 32 ? ' ' : raw[i]
      map.push(i)
      i++
      continue
    }
    const cp = raw.codePointAt(i)!
    const base = String.fromCodePoint(cp)
    // A cluster: the character and the marks after it, normalised together (Bangla vowel signs compose).
    let end = i + base.length
    while (end < raw.length && MARK.test(String.fromCodePoint(raw.codePointAt(end)!))) end += String.fromCodePoint(raw.codePointAt(end)!).length
    let out: string
    if (ZERO_WIDTH.test(base)) out = ''
    else if (SPACE.test(base)) out = ' '
    else if (DASH.test(base)) out = '-'
    else if (BULLET.test(base)) out = '•'
    else if (Object.hasOwn(LOOKALIKES, base) && latin[i]) out = LOOKALIKES[base]
    else out = raw.slice(i, end).normalize('NFKC')
    if (out === '' && end > i + base.length && ZERO_WIDTH.test(base)) end = i + base.length
    for (let k = 0; k < out.length; k++) {
      text += out[k]
      map.push(i)
    }
    i = end
  }
  map.push(raw.length)
  return { text, map: Int32Array.from(map), digit: digitView(text), prefix: prefixView(text), url: urlView(text), label: labelView(text) }
}

/**
 * The digit view (§6.2): Bengali and Devanagari digits as ASCII; in each run of digit groups (joined by
 * one or two of ` . / ( ) -`) with no ASCII letter on either side, holding 6 or more real digits and
 * at most one look-alike letter per 5 characters, the look-alike letters of the groups that hold a
 * real digit become digits.
 */
export function digitView(text: string): string {
  const t = asciiDigits(text)
  const out = t.split('')
  let i = 0
  while (i < t.length) {
    if (!DIGITISH.test(t[i]) || (i > 0 && (DIGITISH.test(t[i - 1]) || LETTER.test(t[i - 1])))) {
      i++
      continue
    }
    // The run: groups of digit-like characters joined by one or two separators.
    const groups: [number, number][] = []
    let j = i
    for (;;) {
      const gs = j
      while (j < t.length && DIGITISH.test(t[j])) j++
      groups.push([gs, j])
      let k = j
      while (k < t.length && k - j < 2 && DIGIT_GROUP_SEP.test(t[k])) k++
      if (k > j && k < t.length && DIGITISH.test(t[k])) j = k
      else break
    }
    const end = groups[groups.length - 1][1]
    i = end
    if (end < t.length && LETTER.test(t[end])) continue
    let real = 0
    let look = 0
    let chars = 0
    for (const [a, b] of groups)
      for (let k = a; k < b; k++) {
        chars++
        if (t[k] >= '0' && t[k] <= '9') real++
        else look++
      }
    if (real < 6 || look === 0 || look > Math.max(1, Math.floor(chars / 5))) continue
    for (const [a, b] of groups) {
      let hasReal = false
      for (let k = a; k < b; k++) if (t[k] >= '0' && t[k] <= '9') hasReal = true
      if (!hasReal) continue
      for (let k = a; k < b; k++) if (Object.hasOwn(TO_DIGIT, t[k])) out[k] = TO_DIGIT[t[k]]
    }
  }
  return out.join('')
}

const foldPrefixChar = (c: string): string => (Object.hasOwn(PREFIX_FOLD, c) ? PREFIX_FOLD[c] : c.toLowerCase())
const foldPrefix = (s: string): string => {
  let out = ''
  for (const c of s) out += foldPrefixChar(c)
  return out
}
/** The prefixes by length, longest first, each length a map from its folded form to the prefix (the first listed wins). */
const PREFIX_INDEX: { length: number; byFold: Map<string, string> }[] = (() => {
  const byLength = new Map<number, Map<string, string>>()
  for (const p of PREFIXES) {
    const m = byLength.get(p.length) ?? new Map<string, string>()
    const f = foldPrefix(p)
    if (!m.has(f)) m.set(f, p)
    byLength.set(p.length, m)
  }
  return [...byLength.entries()].sort((a, b) => b[0] - a[0]).map(([length, byFold]) => ({ length, byFold }))
})()

/** The prefix view (§6.2): at each token start, a known prefix read with OCR confusions is rewritten when 8 or more token characters follow. */
export function prefixView(text: string): string {
  let out: string[] | null = null
  for (let i = 0; i < text.length; i++) {
    if (!PREFIX_START.test(text[i]) || (i > 0 && /[A-Za-z0-9_]/.test(text[i - 1]))) continue
    for (const { length, byFold } of PREFIX_INDEX) {
      if (i + length > text.length) continue
      const seg = text.slice(i, i + length)
      const p = byFold.get(foldPrefix(seg))
      if (!p) continue
      if (seg === p) break
      if (!AFTER_PREFIX.test(text.slice(i + length, i + length + 8))) continue
      out ??= text.split('')
      for (let k = 0; k < length; k++) out[i + k] = p[k]
      break
    }
  }
  return out ? out.join('') : text
}

/**
 * The URL view (§6.2): inside a link (a run without spaces from `http(s)://` or `www.`, continued by
 * pieces " <6+ token characters>" that end before a space, `. , ; )` or the end), each single space
 * that follows 6 token characters is filled with the character before it, so the token reads whole.
 */
export function urlView(text: string): string {
  let out: string[] | null = null
  let done = 0
  for (const m of text.matchAll(LINK_START)) {
    if (m.index < done) continue
    let i = m.index
    while (i < text.length && text[i] !== ' ') i++
    // Pieces " token" after the link.
    for (;;) {
      if (text[i] !== ' ') break
      let j = i + 1
      while (j < text.length && TOKEN.test(text[j])) j++
      const piece = j - (i + 1)
      if (piece < 6 || !(j === text.length || /[\s.,;)]/.test(text[j]))) break
      let before = 0
      for (let k = i - 1; k >= 0 && before < 6 && TOKEN.test(text[k]); k--) before++
      if (before >= 6) {
        out ??= text.split('')
        out[i] = text[i - 1]
      }
      i = j
    }
    done = i
  }
  return out ? out.join('') : text
}

/** The label view (§6.2): inside words of two or more letters, 0 → O, 1 → I, 5 → S, 8 → B. */
export function labelView(text: string): string {
  return text.replace(LABEL_WORD, (w) => (TWO_LETTERS.test(w) ? w.replace(/[0158]/g, (d) => ({ '0': 'O', '1': 'I', '5': 'S', '8': 'B' })[d as '0' | '1' | '5' | '8']) : w))
}

/**
 * Folded text (§6.2): what matches text across frames and reads compares (group keys, Cover this text
 * everywhere, evidence of absence, names). NFKC, lower case, spaces and '_' removed, 0 → o,
 * 1 | ! → l, i → l, 5 → s, 8 → b, then rn → m, vv → w, cl → d.
 */
export function foldText(s: string): string {
  return s
    .normalize('NFKC')
    .toLowerCase()
    .replace(/[\s_]/gu, '')
    .replace(/[01|!i58]/g, (c) => (c === '0' ? 'o' : c === '5' ? 's' : c === '8' ? 'b' : 'l'))
    .replace(/rn/g, 'm')
    .replace(/vv/g, 'w')
    .replace(/cl/g, 'd')
}

/** The raw index range a cleaned span [start, end) came from. */
export function rawSpan(line: CleanLine, start: number, end: number): [number, number] {
  const s = line.map[Math.max(0, Math.min(start, line.text.length))]
  if (end <= start) return [s, s]
  const last = line.map[end - 1]
  // The raw end: the start of the next raw character after the last one used.
  let k = end
  while (k < line.text.length && line.map[k] === last) k++
  return [s, k < line.text.length ? line.map[k] : line.map[line.text.length]]
}
