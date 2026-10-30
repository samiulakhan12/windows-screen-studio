/**
 * Cleaning what an AI wrote for the copy pack (docs/design/publish-pack.md §4.4–4.5): plain text
 * without control or direction characters, markdown emphasis or links the transcript does not
 * contain, cut at a word end, and X's way of counting a post's length. Pure.
 */

/** C0 controls but tab and line feed, DEL, C1 controls, direction overrides and isolates, and the BOM. */
// eslint-disable-next-line no-control-regex
const CONTROLS = /[\u0000-\u0008\u000b-\u001f\u007f-\u009f\u202a-\u202e\u2066-\u2069\ufeff]/g

/**
 * Links as they are written in text: with a scheme or "www." anywhere (also glued to a word, as
 * "_https://…"), or a bare domain with a common top-level domain ("evil.com/login"), which sites
 * turn into links too.
 */
const LINK = /(?:https?:\/\/|www\.)[^\s<>"'`]+|(?<![\p{L}\p{N}@.-])[\p{L}\p{N}-]+(?:\.[\p{L}\p{N}-]+)*\.(?:com|net|org|io|co|app|dev|ai|me|ly|gg|xyz|info|biz|link|site|online|shop|store|page|ru|cn|tk|top|click|zip|mov)(?![\p{L}\p{N}])(?:\/[^\s<>"'`]*)?/giu

export interface PlainTextOptions {
  /** Longest result (characters), cut at a sentence or word end. */
  max: number
  /** Line breaks become spaces (titles, headings, tags, steps). */
  oneLine?: boolean
  /** Links are kept only when this text (the transcript) has the same link; absent: every link is removed. */
  linksFrom?: string
  /** Every link is kept (text the user wrote or edited). */
  keepLinks?: boolean
}

/** The links written in `source`, without a trailing dot or bracket, in lower case. */
function linksIn(source: string): Set<string> {
  return new Set([...source.matchAll(LINK)].map((m) => m[0].replace(TRAIL, '').toLowerCase()))
}

/** Punctuation that ends a sentence or a bracket right after a link. */
const TRAIL = /[.,;:!?)\]]+$/

/**
 * `s` as plain text: line breaks normalised, control and direction characters removed (a tab is a
 * space), ** and __ emphasis removed, links the transcript does not contain removed, spaces at line
 * ends and repeated blank lines removed, trimmed and cut to `max`. Not a string: ''.
 */
export function plainText(s: unknown, opts: PlainTextOptions): string {
  if (typeof s !== 'string') return ''
  let t = s.replace(/\r\n?/g, '\n').replace(/\t/g, ' ').replace(CONTROLS, '')
  t = t.replace(/\*\*|__/g, '')
  if (!opts.keepLinks) {
    const allowed = opts.linksFrom === undefined ? new Set<string>() : linksIn(opts.linksFrom)
    t = t.replace(LINK, (match) => {
      // A dot or bracket at the end is the sentence's, not the link's: it stays.
      const tail = TRAIL.exec(match)?.[0] ?? ''
      const link = match.slice(0, match.length - tail.length)
      return (allowed.has(link.toLowerCase()) ? link : '') + tail
    })
  }
  if (opts.oneLine) t = t.replace(/\s*\n\s*/g, ' ')
  t = t
    .split('\n')
    .map((line) => line.replace(/[ \u00a0]{2,}/g, ' ').replace(/\s+$/, ''))
    .join('\n')
    .replace(/\n{3,}/g, '\n\n')
    .trim()
  return cutAt(t, opts.max)
}

/**
 * `s` at most `max` characters: whole when it fits, else cut after the last sentence end in its
 * second half, or else the last word end, with "…" when cut inside a sentence.
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
  const cut = (space > room.length / 2 ? room.slice(0, space) : room).replace(/[\s,;:–—-]+$/, '')
  return `${cut}…`
}

/* ---------- X ---------- */

/** X's limit for a post (weighted length). */
export const X_LIMIT = 280
/** What X counts a link as, whatever its length. */
const X_URL = 23

// Emoji (with skin tones, variation selectors and joined sequences) count 2 each.
const EMOJI = /\p{Extended_Pictographic}(?:\ufe0f|[\u{1f3fb}-\u{1f3ff}]|\u200d\p{Extended_Pictographic}\ufe0f?)*/gu
const X_TOKENS = new RegExp(`${LINK.source}|${EMOJI.source}`, 'giu')

/** Code points X counts as 1 (Latin and other narrow scripts, some punctuation); others count 2. */
function lightCodePoint(cp: number): boolean {
  return cp <= 0x10ff || (cp >= 0x2000 && cp <= 0x200d) || (cp >= 0x2010 && cp <= 0x201f) || (cp >= 0x2032 && cp <= 0x2037)
}

/** A post's length as X counts it (twitter-text v3): links 23, emoji 2, wide scripts 2 per character. */
export function xLength(s: string): number {
  let n = 0
  let last = 0
  const counted = (text: string): number => {
    let k = 0
    for (const ch of text) k += lightCodePoint(ch.codePointAt(0)!) ? 1 : 2
    return k
  }
  for (const m of s.matchAll(X_TOKENS)) {
    n += counted(s.slice(last, m.index))
    n += /^\p{Extended_Pictographic}/u.test(m[0]) ? 2 : X_URL
    last = m.index! + m[0].length
  }
  return n + counted(s.slice(last))
}

/** `s` cut at a word end, with "…", so X's count is at most `limit`. */
export function fitX(s: string, limit = X_LIMIT): string {
  if (xLength(s) <= limit) return s
  const words = s.split(/(\s+)/)
  let out = ''
  for (const w of words) {
    if (xLength(`${out}${w}…`) > limit) break
    out += w
  }
  out = out.replace(/[\s,;:–—-]+$/, '')
  if (!out) {
    // One very long word: cut by characters.
    for (const ch of s) {
      if (xLength(`${out}${ch}…`) > limit) break
      out += ch
    }
  }
  return `${out}…`
}
