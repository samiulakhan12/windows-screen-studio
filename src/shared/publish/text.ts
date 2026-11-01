/**
 * Cleaning what an AI wrote for the copy pack (docs/design/publish-pack.md §4.4–4.5): plain text
 * without control or direction characters or markdown emphasis, cut at a sentence or word end, and
 * X's count of a post (twitterText.ts, a port of twitter-text 3.1.0). Nothing here changes a
 * character because of a link: a link nobody said is noted and confirmed instead (check.ts). Pure.
 */
import { emojiSpans, extractUrlsWithIndices, parseTweet } from './twitterText'

/**
 * C0 controls but tab and line feed, DEL, C1 controls, direction overrides and isolates, the BOM,
 * and invisible characters (soft hyphen, combining grapheme joiner, zero-width space, the invisible
 * operators, shorthand format controls), which show nothing.
 */
// eslint-disable-next-line no-control-regex
const CONTROLS = /[\u0000-\u0008\u000b-\u001f\u007f-\u009f\u00ad\u034f\u200b\u2061-\u2064\u202a-\u202e\u2066-\u2069\ufeff]|\ud82f[\udca0-\udca3]/g
/** The word joiner, which shows nothing either: removed from what an AI wrote, kept in what the user typed. */
const WORD_JOINER = /\u2060/g

/**
 * Letters of the languages written without spaces between words (Chinese, Japanese, Korean, Thai…),
 * their punctuation (U+3000–U+303F) and the half-width forms (U+FF5F–U+FFEF).
 */
const NO_SPACE = '\\p{scx=Han}\\p{scx=Hiragana}\\p{scx=Katakana}\\p{scx=Hangul}\\p{sc=Thai}\\p{sc=Lao}\\p{sc=Khmer}\\p{sc=Myanmar}\\u3000-\\u303f\\uff5f-\\uffef'

export interface PlainTextOptions {
  /** Longest result (characters), cut at a sentence or word end. */
  max: number
  /** Line breaks become spaces (titles, headings, tags, steps). */
  oneLine?: boolean
}

/* ---------- plain text ---------- */

/**
 * Markdown emphasis around words: "**Bold**", "**two words**", and "__two words__" (with a space
 * inside, so that "__init__" and "__name__" stay). Not glued to a letter, digit, "_" or "*" outside,
 * so "2**8", "**kwargs", the "**" of a glob ("src/**" + "/*.ts") and "snake__case" stay; but "**"
 * may touch the text of a language written without spaces ("点击**保存**按钮", "**설정**을").
 */
const STRONG = new RegExp(`(?<=^|[^\\p{L}\\p{N}_*]|[${NO_SPACE}])\\*\\*(?=[^\\s*])([^*\\n]*?[^\\s*])\\*\\*(?=$|[^\\p{L}\\p{N}_*]|[${NO_SPACE}])`, 'gu')
const UNDERLINED = /(?<![\p{L}\p{N}_])__(?=[^\s_])([^_\n]*?\s[^_\n]*?[^\s_])__(?![\p{L}\p{N}_])/gu

/** Repeated spaces, spaces at line ends and more than one blank line removed, trimmed. */
const tidyText = (t: string): string =>
  t
    .split('\n')
    .map((line) => line.replace(/[ \u00a0]{2,}/g, ' ').replace(/\s+$/, ''))
    .join('\n')
    .replace(/\n{3,}/g, '\n\n')
    .trim()

/**
 * `s` as plain text: line breaks normalised, control and direction characters and the word joiner
 * removed (a tab is a space), NFC, markdown emphasis removed, spaces at line ends and repeated blank
 * lines removed, trimmed and cut to `max` (cutAt). Links stay as written. Not a string: ''.
 */
export function plainText(s: unknown, opts: PlainTextOptions): string {
  if (typeof s !== 'string') return ''
  let t = s.replace(/\r\n?/g, '\n').replace(/\t/g, ' ').replace(CONTROLS, '').replace(WORD_JOINER, '').normalize()
  t = t.replace(STRONG, '$1').replace(UNDERLINED, '$1')
  if (opts.oneLine) t = t.replace(/\s*\n\s*/g, ' ')
  return tidyText(cutAt(tidyText(t), opts.max))
}

/**
 * Text the user typed or edited, as it is saved and copied: line breaks normalised, control and
 * direction characters removed, trimmed and cut to `max` (cutAt). Emphasis, spaces and links stay as
 * typed. Not a string: ''.
 */
export function typedText(s: unknown, max: number): string {
  if (typeof s !== 'string') return ''
  return cutAt(s.replace(/\r\n?/g, '\n').replace(CONTROLS, '').trim(), max)
}

/**
 * `s` at most `max` characters: whole when it fits, else cut after the last sentence end in its
 * second half, or else the last word end, with "…" when cut inside a sentence; inside a word (no word
 * end in the second half, as in Chinese or Japanese) never inside a link X finds, but before it.
 */
export function cutAt(s: string, max: number): string {
  const chars = [...s]
  if (chars.length <= max) return s
  if (max <= 1) return chars.slice(0, Math.max(0, max)).join('')
  const head = chars.slice(0, max).join('')
  const sentence = Math.max(head.lastIndexOf('. '), head.lastIndexOf('! '), head.lastIndexOf('? '), head.lastIndexOf('.\n'), head.lastIndexOf('\n\n'))
  if (sentence >= head.length / 2) return head.slice(0, sentence + 1).trim()
  const room = chars.slice(0, max - 1).join('')
  const space = room.search(/\s\S*$/)
  let cut = space > room.length / 2 ? room.slice(0, space) : room
  if (cut === room) {
    const inside = extractUrlsWithIndices(s).find((u) => u.indices[0] < cut.length && cut.length < u.indices[1])
    if (inside) cut = cut.slice(0, inside.indices[0])
  }
  return `${cut.replace(/[\s,;:–—-]+$/, '')}…`
}

/** `s` cut to at most `max` UTF-16 units, never inside a surrogate pair, as a name or a field that counts them is cut (no "…", no word end). */
export function sliceAt(s: string, max: number): string {
  if (s.length <= max) return s
  const end = Math.max(0, max)
  const code = s.charCodeAt(end - 1)
  return s.slice(0, code >= 0xd800 && code <= 0xdbff ? end - 1 : end)
}

/* ---------- X ---------- */

/** X's limit for a post (weighted length). */
export const X_LIMIT = 280

/** A post's length as X counts it: twitter-text's parseTweet on its NFC form (links 23, emoji 2, wide scripts 2 per character). */
export const xLength = (s: string): number => parseTweet(s).weightedLength

/** `s` cut at a word end, with "…", so X's count is at most `limit`: links and emoji stay whole or go. */
export function fitX(s: string, limit = X_LIMIT): string {
  if (xLength(s) <= limit) return s
  let out = ''
  for (const w of s.split(/(\s+)/)) {
    if (xLength(`${out}${w}…`) > limit) break
    out += w
  }
  out = out.replace(/[\s,;:–—-]+$/, '')
  if (xLength(out) < limit / 2) {
    // No word end in the second half (one very long word, or Chinese or Japanese written without
    // spaces): cut by characters, with each link and emoji whole (a piece of a link is broken, or
    // links to another site: "https://app.flown.co.…").
    const whole = [...extractUrlsWithIndices(s).map((u) => u.indices), ...emojiSpans(s)].sort((a, b) => a[0] - b[0])
    const pieces: string[] = []
    let last = 0
    for (const [start, end] of whole) {
      if (start < last) continue
      pieces.push(...s.slice(last, start), s.slice(start, end))
      last = end
    }
    pieces.push(...s.slice(last))
    out = ''
    for (const piece of pieces) {
      if (xLength(`${out}${piece}…`) > limit) break
      out += piece
    }
    out = out.replace(/[\s,;:–—-]+$/, '')
  }
  return `${out}…`
}
