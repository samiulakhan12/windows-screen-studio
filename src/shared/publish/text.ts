/**
 * Cleaning what an AI wrote for the copy pack (docs/design/publish-pack.md §4.4–4.5): plain text
 * without control or direction characters or markdown emphasis, with no link that the transcript
 * (or what the user typed) does not have, cut at a sentence or word end, and X's count of a post.
 * Links are what X links (twitterText.ts, a port of twitter-text 3.1.0), what other sites link where
 * X's own rules do not ("$name", "「name」", newer top-level domains…), and links written with
 * "http(s)://" or "www." that X does not link but other sites do, read to where a browser's host
 * ends. Pure.
 */
import { emojiSpans, extractUrlsWithIndices, findUrls, isTopLevelDomain, parseTweet } from './twitterText'

/**
 * C0 controls but tab and line feed, DEL, C1 controls, direction overrides and isolates, the BOM,
 * and the invisible characters IDNA drops from a host (soft hyphen, zero-width space, invisible
 * plus): "evil\u200bflown.app" is evilflown.app to a browser, and only "flown.app" to X.
 */
// eslint-disable-next-line no-control-regex
const CONTROLS = /[\u0000-\u0008\u000b-\u001f\u007f-\u009f\u00ad\u200b\u2064\u202a-\u202e\u2066-\u2069\ufeff]/g

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

/** A link in a text: where it is, and whether it goes whole (a scheme or "www.") or is only broken. */
interface Link {
  start: number
  end: number
  text: string
  whole: boolean
}

/** "http://", "https://" or "www." anywhere: other sites (YouTube, LinkedIn) link from there. */
const SCHEME_OR_WWW = /https?:\/\/|www\./gi
/**
 * Letters of the languages written without spaces between words (Chinese, Japanese, Korean, Thai…),
 * their punctuation (U+3000–U+303F) and the half-width forms (U+FF5F–U+FFEF). Not the full-width
 * forms of ASCII (U+FF01–U+FF5E): IDNA reads them as ASCII, so a host can be written in them
 * ("https://ｅｖｉｌ.ｃｏｍ").
 */
const NO_SPACE = '\\p{scx=Han}\\p{scx=Hiragana}\\p{scx=Katakana}\\p{scx=Hangul}\\p{sc=Thai}\\p{sc=Lao}\\p{sc=Khmer}\\p{sc=Myanmar}\\u3000-\\u303f\\uff5f-\\uffef'
/** A "http(s)://" or "www." link X does not link: to a space, a quotation mark, an angle bracket or such a language's text… */
const LOOSE_LINK = new RegExp(`(?:https?:\\/\\/|www\\.)[^\\s"'\`<>\\p{Pi}\\p{Pf}\\u201a\\u201e${NO_SPACE}]*`, 'iuy')
/** …without the sentence's punctuation after it, and with something after its "://" or "www.". */
const LOOSE_TRAIL = /[.,;:!?)\]}…]+$/u
const LOOSE_HOST = /^(?:https?:\/\/|www\.)[\p{L}\p{N}]/iu
/** A link that goes whole: with a scheme or "www."; any other is a bare name, broken. */
const WHOLE = /^(?:https?:\/\/|www\.)/i
/** Longest stretch read for one "http(s)://" or "www." link (a longer one goes in pieces, a round each). */
const LOOSE_MAX = 2000

/**
 * What sites other than X take for the end of a name (and X does not), for linksIn's third reading:
 * "$" and "#" (X's cashtag and hashtag: a linkifier such as markdown-it's links "#evil.com"), "@"
 * (asOtherSitesRead keeps an e-mail address's), "//" before a name that is not a scheme's, with any
 * user name after it (protocol-relative, "//evil.com/login", "//me@evil.com"); what X counts as part
 * of a name: '"' and "`", punctuation other than ASCII's ("「evil.com」", "/．evil.com") and the text
 * of languages written without spaces ("网站flown.app/download"); and the ASCII punctuation X reads
 * on through in a path or query it drops ("flown.app?README.md", ".x.de/a%2eREADME.md": X links
 * nothing after a bare name's "?" or in a name it does not link, other sites start again there).
 */
const OTHER_SITES_ENDS = new RegExp(`[${NO_SPACE}]+|(?:(?![\\x00-\\x7f])\\p{P})+|[$#"\`!?*'();=+,%[\\]~|&{}^<>\\\\]+|@|(?<!https?:)\\/\\/(?:[-\\w.~%!$&'()*+,;=:]*@)?`, 'giu')

/**
 * Whether the "@" between `before` and `rest` is an e-mail address's, as other sites read one: after
 * a user name in ASCII that starts a word, and before a name that ends at a space, the end or
 * punctuation that ends a sentence or a bracket. Else they take the name before it for a link
 * ("paypal-login.com@evil.comx", "paypal.com@login", "ſevil.com@x.com").
 */
const isMailAt = (before: string, rest: string): boolean => {
  if (!/(?:^|[\s<>|"(])[-;:&=+$,.\w]+$/.test(before)) return false
  const name = findUrls(rest, true).find((u) => u.indices[0] === 0)
  return !!name && /^(?:$|\s|[,;!?)\]'"…<>#/%&*。、，]|\.(?![\p{L}\p{N}]))/u.test(rest.slice(name.indices[1]))
}

/** `text` as sites other than X read it for links: OTHER_SITES_ENDS as spaces (but an e-mail address's "@"), so each character stays where it was. */
const asOtherSitesRead = (text: string): string =>
  text.replace(OTHER_SITES_ENDS, (m: string, at: number) => (m === '@' && isMailAt(text.slice(Math.max(0, at - 256), at), text.slice(at + 1, at + 257)) ? m : ' '.repeat(m.length)))

/** A "http(s)://" or "www." link's authority: what comes before its path, query or fragment ("\\" is "/" to a browser). */
const authorityOf = (link: string): string => link.replace(/^https?:\/\//i, '').split(/[/?#\\]/, 1)[0]

/**
 * The hosts a browser may open for `piece` (a piece of an authority between "@"s), as sites end a
 * link at different places: up to each character that is not a letter, digit, "-", "_" or "." ("%",
 * "．", a quotation mark…: one site ends there, another reads on), each without the port, its escapes
 * decoded, as IDNA reads it (NFKC, lower case, "。" and "｡" as "."), without dots at its ends.
 */
function hostsOf(piece: string): string[] {
  const raw = piece.replace(/:.*$/s, '')
  const hosts: string[] = []
  let end = 0
  for (const part of raw.split(/(?=[^\p{L}\p{M}\p{N}._-])/u)) {
    end += part.length
    const decoded = raw.slice(0, end).replace(/(?:%[0-9a-f]{2})+/gi, (m) => {
      try {
        return decodeURIComponent(m)
      } catch {
        return m // no UTF-8: a browser keeps the bytes, and no name has them
      }
    })
    hosts.push(decoded.normalize('NFKC').toLowerCase().replace(/[。｡]/g, '.').replace(/^\.+|\.+$/g, ''))
  }
  return hosts
}

/**
 * Whether a site that reads "http(s)://" or "www." link `wide` (to the next space) further than X's
 * reading `own` may open a name that is not own's: when a piece of its authority (before, between or
 * after "@"s, as sites end such a link at different places, quotation marks or not) is a host on a
 * top-level domain that is neither own's host nor one under it ("https://flown.app%2eevil.com",
 * "https://flown.app:8443@evil.com", "https://flown.app．evil．com", 'https://flown.app".evil.com'). A
 * host on no top-level domain ("https://flown.app—great", "https://flown.app,") opens nothing.
 */
function opensOtherHost(wide: string, own: string): boolean {
  const mine = hostsOf(authorityOf(own)).at(-1) ?? ''
  return authorityOf(wide)
    .split('@')
    .some((piece) =>
      hostsOf(piece).some((host) => {
        const dot = host.lastIndexOf('.')
        return dot > 0 && host !== mine && !host.endsWith(`.${mine}`) && isTopLevelDomain(host.slice(dot + 1))
      })
    )
}

/**
 * The links in `text`, in order: every link X finds (with those it leaves only for their length, and
 * names on newer top-level domains, which other sites link), read three ways; and every "http(s)://"
 * or "www." link elsewhere (glued to a word, in another link's query, to an address X does not link),
 * as X ends it when it links it from there, else up to a space, a quotation mark or Chinese or
 * Japanese text, and up to there too when a site reading that far opens another host.
 *
 * X reads the start of a text in two ways: at the very start a first character such as "é" or "("
 * is what comes before a link ("éflown.app" links "flown.app"), after a space it is part of it
 * ("éflown.app"). A part becomes the start or comes after a space as the pack is put together and
 * pasted, so the links of both readings count; and those of the text as other sites read it
 * (asOtherSitesRead).
 */
function linksIn(text: string): Link[] {
  const links: Link[] = []
  const seen = new Set<string>()
  const add = (start: number, end: number): void => {
    if (end <= start || seen.has(`${start}:${end}`)) return
    seen.add(`${start}:${end}`)
    const t = text.slice(start, end)
    links.push({ start, end, text: t, whole: WHOLE.test(t) })
  }
  for (const [read, shift] of [[text, 0], [` ${text}`, 1], [` ${asOtherSitesRead(text)}`, 1]] as const) {
    for (const { indices } of findUrls(read, true)) add(Math.max(0, indices[0] - shift), indices[1] - shift)
  }
  const found = links.slice()
  let after = 0
  for (const m of text.matchAll(SCHEME_OR_WWW)) {
    const i = m.index
    // Inside a link found above, or the last one found here: it goes with that one.
    if (i < after || found.some((l) => l.start < i && i < l.end)) continue
    // As if the text started here (a link has no space in it, so it ends at the first one).
    const space = text.slice(i, i + LOOSE_MAX).search(/\s/)
    const from = text.slice(i, space < 0 ? i + LOOSE_MAX : i + space)
    const x = findUrls(from, true).find((u) => u.indices[0] === 0)
    const own = x ? from.slice(0, x.indices[1]) : ''
    LOOSE_LINK.lastIndex = i
    const loose = (LOOSE_LINK.exec(text)?.[0] ?? '').slice(0, LOOSE_MAX).replace(LOOSE_TRAIL, '')
    let end = i + m[0].length
    if (own) {
      // Read to the space when a site reading that far may open another name.
      end = i + (opensOtherHost(from, own) ? from.length : own.length)
      add(i, i + own.length)
      add(i, end)
    } else if (LOOSE_HOST.test(loose)) {
      end = i + loose.length
      add(i, end)
    } else if (/\S/.test(text[end] ?? ' ')) {
      // A scheme glued to what no site reads as a host ("https://日%2eevil…", "https://“…"): the scheme.
      add(i, end)
    }
    after = Math.max(after, end)
  }
  return links.sort((a, b) => a.start - b.start || b.end - a.end)
}

/**
 * The ending of a word written on a link ("'dan", "'s", "-Seite", ":sta", "-странице"), which X reads
 * as part of its path: the link without it, and it; or null.
 */
function ending(link: string): { stem: string; tail: string } | null {
  const m = /['’:\-–][\p{L}\p{M}]+$/u.exec(link)
  return m && m.index > 0 ? { stem: link.slice(0, m.index), tail: m[0] } : null
}

/** A link as links compare: without "http(s)://" (it goes to the same place), the host without case in ASCII only (U+212A, the Kelvin sign, is not "k"), the rest exactly. */
function linkKey(link: string): string {
  const bare = link.replace(/^https?:\/\//i, '')
  const host = /^[^/?#:]*/.exec(bare)?.[0] ?? ''
  return host.replace(/[A-Z]+/g, (c) => c.toLowerCase()) + bare.slice(host.length)
}

/** The last few texts' links: every field of an answer is checked against the same transcript. */
const keysOf = new Map<string, ReadonlySet<string>>()

/** The links of `text` (in its NFC form, as X reads it), as linkKey compares them, each also without a word's ending. */
export function linkKeys(text: string): ReadonlySet<string> {
  let keys = keysOf.get(text)
  if (keys) keysOf.delete(text)
  else {
    const set = new Set<string>()
    for (const l of linksIn(text.normalize())) {
      set.add(linkKey(l.text))
      const e = ending(l.text)
      if (e) set.add(linkKey(e.stem))
    }
    keys = set
    if (keysOf.size >= 8) keysOf.delete(keysOf.keys().next().value as string)
  }
  // The most recently used last, so the transcript stays while an answer's fields are checked.
  keysOf.set(text, keys)
  return keys
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

/** What breaks a name: a no-break space after its dot. It reads as a space, ends a name for X and every other site, and no cut takes it for a sentence end. */
const BREAK = '\u00a0'
/** Between a link and a word's ending: U+2060, the word joiner, which ends X's link and shows nothing. */
const JOIN = '\u2060'

/** Rounds of cleaning before the last resort (a text made to hide links in links needs one per level). */
const ROUNDS = 8

/**
 * A no-break space after every "." before something other than a space (every name has one before its
 * top-level domain) and in every "://": nothing in `t` can then be a link. Only adds, so it joins
 * nothing into a link.
 */
const noLinkAtAll = (t: string): string => t.replace(/\.(?=\S)/g, `.${BREAK}`).replace(/:\/\//g, `:${BREAK}//`)

/**
 * `text` with no link that `allowed` lacks (read in NFC, as X reads it; NFC when anything changed): a
 * link that is one `allowed` has with a word's ending ("flown.app/download'dan") gets JOIN before the
 * ending; else a link with a scheme or "www." (and its port, path and query) is removed (the
 * punctuation after it stays), and a bare name ("evil.com/login", "TP.Thủ", "README.md") gets BREAK
 * after each of its dots ("evil. com/login", "TP. Thủ"), so no word loses a letter and nothing links
 * it. The result is read again until no such link is left, since removing one can join the text
 * around it into another; should a text still hide one after ROUNDS, noLinkAtAll.
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
      const e = ending(l.text)
      const kept = e && allowed.has(linkKey(e.stem)) ? `${e.stem}${JOIN}${e.tail}` : l.whole ? '' : l.text.replace(/\./g, `.${BREAK}`)
      out += nfc.slice(last, l.start) + kept
      last = l.end
    }
    t = out + nfc.slice(last)
  }
  return disallowed(t.normalize(), allowed).length ? noLinkAtAll(t.normalize()) : t
}

/**
 * The text `cut` gives for a budget, then with no link `allowed` lacks (cleanLinks, after the cut: a
 * cut makes no link), and `length` at most `max`. Breaking a name makes it longer: it is then cut
 * shorter, from the whole text again, by what it went over; when the same cut comes back (a cut at
 * a sentence end is the same for every budget down to it), from that cut's own length, so the next
 * one goes before it. After a few rounds the step doubles each round, so this ends ('' at worst).
 */
function settle(allowed: ReadonlySet<string>, max: number, cut: (budget: number) => string, length: (t: string) => number, tidy = (t: string): string => t): string {
  let budget = max
  let last: string | undefined
  for (let round = 0; budget > 0; round++) {
    const c = cut(budget)
    const out = tidy(cleanLinks(c, allowed))
    const over = length(out) - max
    if (over <= 0) return out
    budget = (c === last ? Math.min(budget, length(c)) : budget) - over * 2 ** Math.max(0, round - 3)
    last = c
  }
  return ''
}

/**
 * The text whose links an answer may have: the transcript that was sent, and the recording's name and
 * chapter titles, which the user typed (what an AI suggested for them lost in main the links its
 * captions lack: transcriptText.ts). On lines of their own, so no link spans two of them.
 */
export function trustedText(transcript: string, context?: { title?: string; chapters?: string[] }): string {
  return [transcript, context?.title ?? '', ...(context?.chapters ?? [])].join('\n')
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
