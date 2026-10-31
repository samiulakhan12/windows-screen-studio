/**
 * Cleaning what an AI wrote for the copy pack (docs/design/publish-pack.md §4.4–4.5): plain text
 * without control or direction characters or markdown emphasis, with no link that the transcript
 * (or what the user typed) does not have, cut at a sentence or word end, and X's count of a post.
 * Links are what X links (twitterText.ts, a port of twitter-text 3.1.0), and links written with
 * "http(s)://" or "www." that X does not link but other sites do. Pure.
 */
import { emojiSpans, extractUrlsWithIndices, findUrls, parseTweet } from './twitterText'

/** C0 controls but tab and line feed, DEL, C1 controls, direction overrides and isolates, and the BOM. */
// eslint-disable-next-line no-control-regex
const CONTROLS = /[\u0000-\u0008\u000b-\u001f\u007f-\u009f\u202a-\u202e\u2066-\u2069\ufeff]/g

export interface PlainTextOptions {
  /** Longest result (characters), cut at a sentence or word end. */
  max: number
  /** Line breaks become spaces (titles, headings, tags, steps). */
  oneLine?: boolean
  /** Links are kept only when this text (the transcript, and what the user typed) has the same link; absent: no link is kept. */
  linksFrom?: string
  /** Every link of the text itself is kept (text the user wrote or edited); a cut still makes none. */
  keepLinks?: boolean
}

/* ---------- links ---------- */

/** A link in a text: where it is, and whether it goes whole (a scheme, "www." or a path, with its port and query) or is only broken. */
interface Link {
  start: number
  end: number
  text: string
  whole: boolean
}

/** "http://", "https://" or "www." anywhere: other sites (YouTube, LinkedIn) link from there. */
const SCHEME_OR_WWW = /https?:\/\/|www\./gi
/**
 * Letters of the languages written without spaces between words (Chinese, Japanese, Korean, Thai…)
 * and their punctuation and full-width forms, where such a link ends when X does not link it.
 */
const NO_SPACE = '\\p{scx=Han}\\p{scx=Hiragana}\\p{scx=Katakana}\\p{scx=Hangul}\\p{sc=Thai}\\p{sc=Lao}\\p{sc=Khmer}\\p{sc=Myanmar}\\u3000-\\u303f\\uff00-\\uffef'
/** Such a link X does not link: to a space, a quote, an angle bracket or such a language's text… */
const LOOSE_LINK = new RegExp(`(?:https?:\\/\\/|www\\.)[^\\s"'\`<>${NO_SPACE}]*`, 'iuy')
/** …without the sentence's punctuation after it, and with something after its "://" or "www.". */
const LOOSE_TRAIL = /[.,;:!?)\]}…]+$/u
const LOOSE_HOST = /^(?:https?:\/\/|www\.)[\p{L}\p{N}]/iu
/** A link that goes whole: with a scheme, "www." or a path (and the port and query with it); else it is a bare name. */
const WHOLE = /^(?:https?:\/\/|www\.)|\//i
/** Longest stretch read for one "http(s)://" or "www." link (a longer one goes in pieces, a round each). */
const LOOSE_MAX = 2000

/**
 * The links in `text`: every link X finds (with those it leaves only for their length, which other
 * sites link), and every "http(s)://" or "www." link elsewhere (glued to a word, in another link's
 * query, to an address X does not link), as X ends it when it links it from there, else up to a
 * space, a quote or Chinese or Japanese text. In order.
 *
 * X reads the start of a text in two ways: at the very start a first character such as "é" or "("
 * is what comes before a link ("éflown.app" links "flown.app"), after a space it is part of it
 * ("éflown.app"). A part becomes the start or comes after a space as the pack is put together and
 * pasted, so the links of both readings count.
 */
function linksIn(text: string): Link[] {
  const links: Link[] = []
  const seen = new Set<string>()
  for (const shift of [0, 1]) {
    for (const { indices } of findUrls(shift ? ` ${text}` : text, true)) {
      const start = Math.max(0, indices[0] - shift)
      const end = indices[1] - shift
      if (end <= start || seen.has(`${start}:${end}`)) continue
      seen.add(`${start}:${end}`)
      const t = text.slice(start, end)
      links.push({ start, end, text: t, whole: WHOLE.test(t) })
    }
  }
  const x = links.slice()
  let after = 0
  for (const m of text.matchAll(SCHEME_OR_WWW)) {
    const i = m.index
    // Inside a link X finds, or the last one found here: it goes with that one.
    if (i < after || x.some((l) => l.start <= i && i < l.end)) continue
    // As if the text started here (a link has no space in it, so it ends at the first one).
    const space = text.slice(i, i + LOOSE_MAX).search(/\s/)
    const from = text.slice(i, space < 0 ? i + LOOSE_MAX : i + space)
    const own = findUrls(from, true).find((u) => u.indices[0] === 0)
    LOOSE_LINK.lastIndex = i
    const loose = (LOOSE_LINK.exec(text)?.[0] ?? '').slice(0, LOOSE_MAX).replace(LOOSE_TRAIL, '')
    const t = own ? from.slice(0, own.indices[1]) : LOOSE_HOST.test(loose) ? loose : ''
    if (t) {
      links.push({ start: i, end: i + t.length, text: t, whole: true })
      after = i + t.length
    }
  }
  return links.sort((a, b) => a.start - b.start || b.end - a.end)
}

/** Hosts (and schemes) compare without case, in ASCII only (U+212A, the Kelvin sign, is not "k"); the rest of a link exactly. */
function linkKey(link: string): string {
  const host = /^(?:https?:\/\/)?[^/?#:]*/i.exec(link)?.[0] ?? ''
  return host.replace(/[A-Z]+/g, (c) => c.toLowerCase()) + link.slice(host.length)
}

/** The links of `text` (in its NFC form, as X reads it), as linkKey compares them. */
export function linkKeys(text: string): Set<string> {
  return new Set(linksIn(text.normalize()).map((l) => linkKey(l.text)))
}

/**
 * The links of `text` that `allowed` lacks. Links that overlap are taken together: when one of them
 * is not allowed, all of them go, whole when one of them goes whole.
 */
function disallowed(text: string, allowed: ReadonlySet<string>): Link[] {
  const groups: (Link & { bad: boolean })[] = []
  for (const l of linksIn(text)) {
    const bad = !allowed.has(linkKey(l.text))
    const g = groups.at(-1)
    if (g && l.start < g.end) {
      g.end = Math.max(g.end, l.end)
      g.whole ||= l.whole
      g.bad ||= bad
    } else groups.push({ ...l, bad })
  }
  return groups.filter((g) => g.bad).map((g) => ({ ...g, text: text.slice(g.start, g.end) }))
}

/** Rounds of cleaning before the last resort (a text made to hide links in links needs one per level). */
const ROUNDS = 8

/** No "." before a letter (every top-level domain starts with one) and no "://": nothing in `t` can be a link. */
const noLinkAtAll = (t: string): string => t.replace(/\.(?=[\p{L}\p{M}])/gu, '').replace(/:\/\//g, '')

/**
 * `text` with no link that `allowed` lacks (read in NFC, as X reads it; NFC when anything changed): a
 * link with a scheme, "www." or a path (and its port and query) is removed (the punctuation after it
 * stays); a bare name ("evil.com", "TP.Thủ", "README.md") gets a space after each of its dots
 * ("evil. com", "TP. Thủ"), so no word loses a letter and nothing links it. The result is read again
 * until no such link is left, since removing one can join the text around it into another; should a
 * text still hide one after ROUNDS, noLinkAtAll.
 */
function cleanLinks(text: string, allowed: ReadonlySet<string>): string {
  let t = text
  for (let round = 0; round < ROUNDS; round++) {
    const nfc = t.normalize()
    const bad = disallowed(nfc, allowed)
    if (!bad.length) return t
    let out = ''
    let last = 0
    for (const l of bad) {
      out += nfc.slice(last, l.start) + (l.whole ? '' : l.text.replace(/\./g, '. '))
      last = l.end
    }
    t = out + nfc.slice(last)
  }
  return disallowed(t.normalize(), allowed).length ? noLinkAtAll(t.normalize()) : t
}

/**
 * The text `cut` gives for a budget, then with no link `allowed` lacks (cleanLinks, after the cut: a
 * cut makes no link), and `length` at most `max`. A space after a dot can make it longer: it is then
 * cut shorter, from the whole text again.
 */
function settle(allowed: ReadonlySet<string>, max: number, cut: (budget: number) => string, length: (t: string) => number, tidy = (t: string): string => t): string {
  let budget = max
  for (let round = 0; round < 6; round++) {
    const out = tidy(cleanLinks(cut(budget), allowed))
    const over = length(out) - max
    if (over <= 0) return out
    budget -= over
  }
  // Never longer than the cut.
  return tidy(noLinkAtAll(cut(Math.max(0, budget)).normalize()))
}

/**
 * The text whose links an answer may have: the transcript that was sent, and the recording's name and
 * chapter titles, which the user typed. On lines of their own, so no link spans two of them.
 */
export function trustedText(transcript: string, context?: { title?: string; chapters?: string[] }): string {
  return [transcript, context?.title ?? '', ...(context?.chapters ?? [])].join('\n')
}

/* ---------- plain text ---------- */

/**
 * Markdown emphasis around words: "**Bold**", "**two words**", and "__two words__" (with a space
 * inside, so that "__init__" and "__name__" stay). Not glued to a letter, digit, "_" or "*" outside,
 * so "2**8", "**kwargs", the "**" of a glob ("src/**" + "/*.ts") and "snake__case" stay.
 */
const STRONG = /(?<![\p{L}\p{N}_*])\*\*(?=[^\s*])([^*\n]*?[^\s*])\*\*(?![\p{L}\p{N}_*])/gu
const UNDERLINED = /(?<![\p{L}\p{N}_])__(?=[^\s_])([^_\n]*?\s[^_\n]*?[^\s_])__(?![\p{L}\p{N}_])/gu

/** Repeated spaces, spaces at line ends and more than one blank line removed, trimmed. */
const tidyText = (t: string): string =>
  t
    .split('\n')
    .map((line) => line.replace(/[ \u00a0]{2,}/g, ' ').replace(/\s+$/, ''))
    .join('\n')
    .replace(/\n{3,}/g, '\n\n')
    .trim()

const charLength = (t: string): number => [...t].length

/**
 * `s` as plain text: line breaks normalised, control and direction characters removed (a tab is a
 * space), NFC, markdown emphasis removed, spaces at line ends and repeated blank lines removed,
 * trimmed, cut to `max`, and then every link `linksFrom` does not have (keepLinks: `s` itself)
 * removed or broken (cleanLinks). Not a string: ''.
 */
export function plainText(s: unknown, opts: PlainTextOptions): string {
  if (typeof s !== 'string') return ''
  const allowed = linkKeys(opts.keepLinks ? s : (opts.linksFrom ?? ''))
  let t = s.replace(/\r\n?/g, '\n').replace(/\t/g, ' ').replace(CONTROLS, '').normalize()
  t = t.replace(STRONG, '$1').replace(UNDERLINED, '$1')
  if (opts.oneLine) t = t.replace(/\s*\n\s*/g, ' ')
  t = tidyText(t)
  return settle(allowed, opts.max, (budget) => cutText(t, budget), charLength, tidyText)
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

/** `s` with no link `from` lacks: a link that a change to `from` made (as "<" to "‹") is removed or broken (cleanLinks). */
export const withLinksOf = (s: string, from: string): string => cleanLinks(s, linkKeys(from))

/**
 * `s` cut to `max` characters after the last sentence end in its second half, or else the last word
 * end, with "…" when cut inside a sentence; inside a word never inside a link that goes whole (its
 * piece would go anyway), but before it. Only cuts: cutAt and plainText then make sure the cut made
 * no link.
 */
function cutText(s: string, max: number): string {
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
    const inside = linksIn(s).find((l) => l.whole && l.start < cut.length && cut.length < l.end)
    if (inside) cut = cut.slice(0, inside.start)
  }
  return `${cut.replace(/[\s,;:–—-]+$/, '')}…`
}

/**
 * `s` at most `max` characters: whole when it fits, else cut after the last sentence end in its
 * second half, or else the last word end, with "…" when cut inside a sentence. The cut makes no link
 * `s` does not have ("evil.comfy" cut to "evil.com…" gives "evil. com…").
 */
export function cutAt(s: string, max: number): string {
  if (charLength(s) <= max) return s
  return settle(linkKeys(s), max, (budget) => cutText(s, budget), charLength)
}

/* ---------- X ---------- */

/** X's limit for a post (weighted length). */
export const X_LIMIT = 280

/** A post's length as X counts it: twitter-text's parseTweet on its NFC form (links 23, emoji 2, wide scripts 2 per character). */
export const xLength = (s: string): number => parseTweet(s).weightedLength

/** `s` cut at a word end with "…" so X's count is at most `limit`, links and emoji whole. Only cuts. */
function cutX(s: string, limit: number): string {
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

/** `s` cut at a word end, with "…", so X's count is at most `limit`. The cut makes no link `s` does not have. */
export function fitX(s: string, limit = X_LIMIT): string {
  if (xLength(s) <= limit) return s
  return settle(linkKeys(s), limit, (budget) => cutX(s, budget), xLength)
}
