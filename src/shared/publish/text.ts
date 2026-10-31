/**
 * Cleaning what an AI wrote for the copy pack (docs/design/publish-pack.md §4.4–4.5): plain text
 * without control or direction characters, markdown emphasis or links the transcript does not
 * contain, cut at a word end, and X's way of counting a post's length. Pure.
 */
import { X_COUNTRY_TLDS, X_GENERIC_TLDS } from './tlds'

/** C0 controls but tab and line feed, DEL, C1 controls, direction overrides and isolates, and the BOM. */
// eslint-disable-next-line no-control-regex
const CONTROLS = /[\u0000-\u0008\u000b-\u001f\u007f-\u009f\u202a-\u202e\u2066-\u2069\ufeff]/g

/**
 * Links as they are written in text: with a scheme or "www." anywhere (also glued to a word, as
 * "_https://…"), or a bare domain, which sites turn into links too: on a top-level domain X links
 * (tlds.ts), with or without a port and a path ("evil.icu", "flown.co.uk", "is.gd/x",
 * "evil.de:8080/login"). "Node.js/React" or "index.html/style.css" are on none, so they are text.
 */
const LINK = new RegExp(
  '(?:https?:\\/\\/|www\\.)[^\\s<>"\'`]+' +
    `|(?<![\\p{L}\\p{N}@.-])[\\p{L}\\p{N}-]+(?:\\.[\\p{L}\\p{N}-]+)*\\.(?:${X_GENERIC_TLDS}|${X_COUNTRY_TLDS}|xn--[\\p{L}\\p{N}-]+)` +
    '(?![\\p{L}\\p{N}])(?::\\d+)?(?:\\/[^\\s<>"\'`]*)?',
  'giu'
)

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
 * A bare name on a top-level domain that is also a file type, with no port or path
 * ("recording.mov", "export.zip", "Settings.app", "captions.srt", "settings.py", "README.md",
 * "install.sh", "Main.java"): a file or app name. Sites still link it ("flown.app" is a site), so
 * unless the transcript has it, only its name stays ("recording", "Settings"). With a scheme, "www.",
 * a port or a path it is a link. X counts it as one (xLength), as X does.
 */
const FILE_NAME = /^(?!www\.)[\p{L}\p{N}-]+(?:\.[\p{L}\p{N}-]+)*\.(?:app|zip|mov|srt|md|py|sh|rs|java|so|cc|gd|map)$/iu

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
      if (allowed.has(link.toLowerCase())) return link + tail
      // A file or app name keeps its name without the extension, unless that is a link too ("evil.com.app").
      const name = FILE_NAME.test(link) ? link.slice(0, link.lastIndexOf('.')) : ''
      return (name.search(LINK) < 0 ? name : '') + tail
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
 * Text the user typed or edited, as it is saved and copied: line breaks normalised, control and
 * direction characters removed, trimmed and cut to `max`. Emphasis, spaces and links stay as typed.
 * Not a string: ''.
 */
export function typedText(s: unknown, max: number): string {
  if (typeof s !== 'string') return ''
  return cutAt(s.replace(/\r\n?/g, '\n').replace(CONTROLS, '').trim(), max)
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

/** Latin letters with accents, which X takes in a domain or a path. */
const X_ACCENTS = '\\u00c0-\\u00d6\\u00d8-\\u00f6\\u00f8-\\u024f\\u0253\\u0254\\u0256\\u0257\\u0259\\u025b\\u0263\\u0268\\u026f\\u0272\\u0289\\u028b\\u02bb\\u0300-\\u036f\\u1e00-\\u1eff'
const X_TLD = `(?:${X_GENERIC_TLDS}|${X_COUNTRY_TLDS}|xn--[0-9a-z-]+)(?![0-9a-z@+-])`
const X_PATH_CHAR = `[a-z\\u0400-\\u04ff0-9!*';:=+,.$/%#\\[\\]\\-\\u2013_~@|&${X_ACCENTS}]`
const X_PATH = `\\/(?:${X_PATH_CHAR}|\\(${X_PATH_CHAR}+\\))*(?<=[+\\-a-z\\u0400-\\u04ff0-9=_#/)${X_ACCENTS}])`
const X_QUERY = "\\?[a-z0-9!?*'@();:&=+$/%#\\[\\]\\-_.,~|]*[a-z0-9\\-_&=#/]"
/**
 * Links as X finds them in a post (twitter-text v3), not as plainText does: a domain on a top-level
 * domain X knows (tlds.ts), with "http(s)://" (any letters) or bare (Latin letters, also right
 * after Chinese or Japanese text), then a port, a path and a query, which end where X ends them (at
 * other scripts, quotes, an unmatched bracket or a closing dot or comma). "Node.js" and "file.txt"
 * are not links; "flown.fm" and "README.md" are.
 */
const X_LINK =
  `(?:(?<![a-z0-9@\\uff20$#\\uff03])https?:\\/\\/(?:[\\p{L}\\p{M}\\p{N}_-]+\\.)+` +
  `|(?<![a-z0-9@\\uff20$#\\uff03\\-_./${X_ACCENTS}])[a-z0-9${X_ACCENTS}][-a-z0-9${X_ACCENTS}]*\\.(?:[-a-z0-9${X_ACCENTS}]+\\.)*)` +
  `${X_TLD}(?::[0-9]+)?(?:${X_PATH})?(?:${X_QUERY})?`

// Emoji (with skin tones, variation selectors and joined sequences) count 2 each.
const EMOJI = /\p{Extended_Pictographic}(?:\ufe0f|[\u{1f3fb}-\u{1f3ff}]|\u200d\p{Extended_Pictographic}\ufe0f?)*/gu
const X_TOKENS = new RegExp(`${X_LINK}|${EMOJI.source}`, 'giu')

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
  if (xLength(out) < limit / 2) {
    // No word end in the second half (one very long word, or Chinese or Japanese written without
    // spaces): cut by characters.
    out = ''
    for (const ch of s) {
      if (xLength(`${out}${ch}…`) > limit) break
      out += ch
    }
    out = out.replace(/[\s,;:–—-]+$/, '')
  }
  return `${out}…`
}
