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
 * and invisible characters a browser drops from a host (soft hyphen, combining grapheme joiner,
 * zero-width space, the invisible operators, shorthand format controls): "evil\u200bflown.app" is
 * evilflown.app to a browser, and only "flown.app" to X.
 */
// eslint-disable-next-line no-control-regex
const CONTROLS = /[\u0000-\u0008\u000b-\u001f\u007f-\u009f\u00ad\u034f\u200b\u2061-\u2064\u202a-\u202e\u2066-\u2069\ufeff]|\ud82f[\udca0-\udca3]/g
/**
 * The word joiner, which a browser drops from a host too: removed from what an AI wrote (cleanLinks
 * puts it back only as JOIN, after a said link), kept in what the user typed.
 */
const WORD_JOINER = /\u2060/g

export interface PlainTextOptions {
  /** Longest result (characters), cut at a sentence or word end. */
  max: number
  /** Line breaks become spaces (titles, headings, tags, steps). */
  oneLine?: boolean
  /** Links are kept only when this text (the transcript, and what the user typed) has the same link; absent: no link is kept. */
  linksFrom?: string
  /** Every link of the text itself is kept (text the user wrote or edited); a cut still makes none. */
  keepLinks?: boolean
  /** Links not kept although `linksFrom` has them: those an AI wrote into the captions and nothing else says (unsaidLinks). */
  untrusted?: readonly string[]
}

/* ---------- links ---------- */

/** A link in a text: where it is, and whether it goes whole (a scheme or "www.") or is only broken. */
interface Link {
  start: number
  end: number
  text: string
  whole: boolean
  /**
   * A stretch read to the next space (otherHostReader): the length of the link X or a linkifier reads
   * from its start, which cleanLinks keeps when it is a said one.
   */
  keep?: number
}

/**
 * "http://", "https://" or "www." anywhere: other sites (YouTube, LinkedIn) link from there; and "//"
 * not right after ":" or "/", where linkify-it starts a protocol-relative link (after a separator, or
 * where a link or address it read ends: "(support@flown.app//203.0.113.7").
 */
const SCHEME_OR_WWW = /https?:\/\/|www\.|(?<![:/])\/\//gi
/**
 * Letters of the languages written without spaces between words (Chinese, Japanese, Korean, Thai…),
 * their punctuation (U+3000–U+303F) and the half-width forms (U+FF5F–U+FFEF). Not the full-width
 * forms of ASCII (U+FF01–U+FF5E): IDNA reads them as ASCII, so a host can be written in them
 * ("https://ｅｖｉｌ.ｃｏｍ").
 */
const NO_SPACE = '\\p{scx=Han}\\p{scx=Hiragana}\\p{scx=Katakana}\\p{scx=Hangul}\\p{sc=Thai}\\p{sc=Lao}\\p{sc=Khmer}\\p{sc=Myanmar}\\u3000-\\u303f\\uff5f-\\uffef'
/** A "http(s)://", "www." or "//" link X does not link: to a space, a quotation mark, an angle bracket or such a language's text (and endsLooseLink)… */
const LOOSE_LINK = new RegExp(`(?:https?:\\/\\/|www\\.|\\/\\/)[^\\s"'\`<>${NO_SPACE}]*`, 'iuy')
/**
 * …without the sentence's punctuation after it, and with something after its "://" or "www."; after
 * "//", a host with a dot inside it (linkify-it's: "//203.0.113.7", "//paypal-login.com\ufe0f"; not
 * "//comments", "a.//b", nor a broken name, "//evil.\u00a0com").
 */
const LOOSE_TRAIL = /(?:[.,;:!?)\]}]|(?![\x00-\x7f])\p{P})+$/u
const LOOSE_HOST = /^(?:(?:https?:\/\/|www\.)[\p{L}\p{N}]|\/\/[^/?#\\]*[^./?#\\]\.[^/?#\\])/iu
/** An authority (after "//") with a dot inside it. */
const DOTTED_AUTHORITY = /^[^/?#\\]*[^./?#\\]\.[^/?#\\]/u
/** A link that goes whole: with a scheme or "www."; any other is a bare name, broken. */
const WHOLE = /^(?:https?:\/\/|www\.)/i
/** Longest stretch X's own reading of one "http(s)://" or "www." link is looked for in, longest such link X does not link, and longest authority read for its hosts. */
const LOOSE_MAX = 2000

/**
 * What sites other than X take for the end of a name (and X does not), for linksIn's third reading:
 * "$" and "#" (X's cashtag and hashtag: a linkifier such as markdown-it's links "#evil.com"), "@"
 * (but where it stays one: atStays), "//" before a name that is not a scheme's (protocol-relative,
 * "//evil.com/login"); what X counts as part of a name: '"' and "`", punctuation other than ASCII's
 * ("「evil.com」", "/．evil.com"), linkify-it's other separators ("<", ">" and "｜":
 * "support@flown.app｜paypal-login.com") and the text of languages written without spaces
 * ("网站flown.app/download"), but not right after a "." (a top-level domain in such a script:
 * "paypal-login.在线"); and the ASCII punctuation X reads on through in a path or query it drops
 * ("flown.app?README.md", ".x.de/a%2eREADME.md": X links nothing after a bare name's "?" or in a name
 * it does not link, other sites start again there). A "." right after one of them is an end too
 * (asOtherSitesRead).
 */
const OTHER_SITES_ENDS = new RegExp(
  `(?<![.${NO_SPACE}])[${NO_SPACE}]+|(?:(?![\\x00-\\x7f])\\p{P})+|[$#"\`!?*'();=+,%[\\]~|&{}^<>\\\\\\uff5c]+|@|(?<!https?:)\\/\\/`,
  'giu'
)
/**
 * The same, but with the text of languages written without spaces kept in names: linkify-it reads it
 * in a host, so before an "@" it is a name ("paypalログイン.com@verify", "登录.com@客服").
 */
const OTHER_SITES_ENDS_IN_RUNS = new RegExp(OTHER_SITES_ENDS.source.replace(`(?<![.${NO_SPACE}])[${NO_SPACE}]+|`, ''), 'giu')
/** Text of a language written without spaces: the fourth reading (asOtherSitesRead with runs) is needed only with an "@". */
const NO_SPACE_TEXT = new RegExp(`[${NO_SPACE}]`, 'u')

/**
 * Characters a browser drops from a host: IDNA's ignored ones (soft hyphen, combining grapheme joiner,
 * variation selectors, zero-width space, word joiner, invisible operators, BOM, shorthand format
 * controls) and the joiners IDNA's older, transitional processing drops (U+200C, U+200D).
 */
const HOST_IGNORED = /[\u00ad\u034f\u180b-\u180d\u180f\u200b-\u200d\u2060-\u2064\ufe00-\ufe0f\ufeff\u{1bca0}-\u{1bca3}\u{e0100}-\u{e01ef}]/gu
/**
 * Whether a browser reads character `c` in a host as ASCII letters, digits or "-" (IDNA: NFKC, case
 * folded: "ｇ", "𝗀", "™", "①") or drops it (HOST_IGNORED), while X reads it as no part of an ASCII
 * name. Not punctuation ("－", "﹣", which NFKC makes "-"): a linkifier ends a name there, so no
 * browser reads it in a host it was given without a scheme ("support@flown.app－paypal-login.com"
 * links paypal-login.com). Not the word joiner: what an AI wrote has none but JOIN, after a said
 * link's path.
 */
const foldCache = new Uint8Array(0x10000)
function joinsName(c: string): boolean {
  const code = c.length === 1 ? c.charCodeAt(0) : -1
  if (code >= 0 && foldCache[code]) return foldCache[code] === 1
  HOST_IGNORED.lastIndex = 0
  const joins = c !== JOIN && !/\p{P}/u.test(c) && (HOST_IGNORED.test(c) || /^[a-z0-9-]+$/.test(c.normalize('NFKC').toLowerCase()))
  if (code >= 0) foldCache[code] = joins ? 1 : 2
  return joins
}

/**
 * Whether `c` ends a "http(s)://" or "www." link X does not link: punctuation other than ASCII's that
 * a browser does not read as part of a host ("，", "（", "！", "—", "»", "।"; not "．", "－", "＿", "｡",
 * "…": IDNA reads them as ".", "-", "_"), as linkifiers end a host there ("http://localhost:3000，就能…").
 */
const stopCache = new Uint8Array(0x10000)
function endsLooseLink(c: string): boolean {
  const code = c.length === 1 ? c.charCodeAt(0) : -1
  if (code >= 0 && stopCache[code]) return stopCache[code] === 1
  const ends = /^(?![\x00-\x7f])\p{P}$/u.test(c) && !/^[-._]+$/.test(c.normalize('NFKC')) && !joinsName(c)
  if (code >= 0) stopCache[code] = ends ? 1 : 2
  return ends
}

/**
 * An e-mail address's top-level domain as markdown-it's linkifier (linkify-it 5) knows one: a country's
 * two letters (its list: not "ok" or "zz"), punycode, or its other names.
 */
const MAIL_TLD = new RegExp(
  '^(?:a[cdefgilmnoqrstuwxz]|b[abdefghijmnorstvwyz]|c[acdfghiklmnoruvwxyz]|d[ejkmoz]|e[cegrstu]|f[ijkmor]|g[abdefghilmnpqrstuwy]|h[kmnrtu]|i[delmnoqrst]|j[emop]|k[eghimnprwyz]|l[abcikrstuvy]|m[acdeghklmnopqrstuvwxyz]|n[acefgilopruz]|om|p[aefghklmnrstwy]|qa|r[eosuw]|s[abcdeghijklmnortuvxyz]|t[cdfghjklmnortvwz]|u[agksyz]|v[aceginu]|w[fs]|y[et]|z[amw]' +
    '|xn--[-a-z0-9]{1,59}|biz|com|edu|gov|net|org|pro|web|xxx|aero|asia|coop|info|museum|name|shop|рф)$',
  'i'
)
/** A host's characters for a linkifier: anything but spaces, controls, punctuation and "<", ">", "｜"; "-" and "." between. */
const MAIL_HOST = /^(?:[^\s\p{P}\p{Cc}<>｜]|[-.])+/u

/**
 * Whether the "@" at `at` of `text` is an e-mail address's as linkifiers read one (linkify-it 5, which
 * markdown-it uses): a user name of ASCII letters, digits and "-;:&=+$,._" (and '"' after the first)
 * after the start, a space, a control or one of '<>｜"(', and a host of dotted names on MAIL_TLD,
 * not followed by "_", a port or a name ("wei.wang@acme.com", "anna.li@acme.de"). Else they link a
 * name before the "@" ("paypal-login.com@flown.app", "paypal-login.com@x.com:80/verify",
 * "|paypal-login.com@evil.com").
 */
export function isMailAt(text: string, at: number): boolean {
  let s = at
  while (s > 0 && at - s < 256 && /[-;:&=+$,."\w]/.test(text[s - 1])) s--
  // The user name may start at any of its characters after the start, a space, a control, '<>｜"(', or a '"' in it.
  let ok = false
  for (let u = s; u < at && !ok; u++) ok = text[u] !== '"' && (u === 0 || (u === s ? /[\s\p{Cc}<>｜"(]/u.test(text[u - 1]) : text[u - 1] === '"'))
  if (!ok) return false
  const host = MAIL_HOST.exec(text.slice(at + 1, at + 300))?.[0] ?? ''
  const name = host.replace(/\.+$/, '')
  const labels = name.split('.')
  if (labels.length < 2 || labels.some((l) => !l || l.length > 63 || l.startsWith('-') || l.endsWith('-')) || !MAIL_TLD.test(labels[labels.length - 1])) return false
  return !/^(?:_|:\d)/.test(text.slice(at + 1 + name.length))
}

/**
 * Whether the "@" at `at` stays one for linksIn's third reading, where no site links across it: when
 * nothing right before it can be a link (the name before it, as that reading has it in `ended`, has
 * none, and no "/" or "\" starts its user name: "support@flown.app", "@flown.studio",
 * "@flown@mastodon.social"; not "//me@evil.com", "$paypal.com@x"), or it is an e-mail address's
 * (isMailAt, on `text` as written). Else it is read as a space, and the names on both sides are read
 * ("paypal-login.com@flown.app", "paypal.com@login"). `folded`: `text` with what joins a name folded;
 * `ended`: that, with every other end of a name as spaces.
 */
function atStays(text: string, folded: string, ended: string, at: number): boolean {
  const from = Math.max(0, at - 256)
  // A user name stops at the punctuation of Chinese and Japanese ("文档：flown.app/docs，邮箱：support@flown.app"), as a "/" before it does not start it.
  const user = /[^\s@/\\[\]()，、：；！？（）「」『』【】《》]*$/.exec(folded.slice(from, at))?.[0] ?? ''
  const name = /(?:[^\s\p{P}\p{Cc}<>｜]|[-._．。｡])*$/u.exec(ended.slice(from, at))?.[0].replace(/[．。｡]/g, '.') ?? ''
  const plain = !/[/\\]$/.test(folded.slice(from, at - user.length)) && !findUrls(` ${name}`, false).length && !findUrls(` ${name}`, true).length
  return plain || isMailAt(text, at)
}

/** A variation selector: it belongs to the character before it. */
const VARIATION_SELECTOR = /^(?:[\u180b-\u180d\u180f\ufe00-\ufe0f]|\udb40[\udd00-\uddef])$/

/**
 * `text` as sites other than X read it for links, each character where it was: what a browser reads
 * in a host as ASCII letters or digits, or drops (joinsName: "ｇｅｔflown.com", "get\ufe0fflown.com",
 * which X links from "flown.com"), as "0" (it glues the name around it, but makes no top-level
 * domain, as none has a digit: "１.５００", "ｒｅａｄｍｅ.ｔｘｔ" are no link); a variation selector so
 * only after what is part of such a name ("get\ufe0fflown.com"), as after an emoji it is the emoji's
 * ("➡\ufe0fflown.app" is "➡flown.app" to a browser); then OTHER_SITES_ENDS as spaces, and a "."
 * right after one of them (not after a space): a site may read what ended the name as a label of the
 * name after the "." (linkify-it reads "ログイン", "~", "$" or "𐄀" in a host:
 * "support@flown.app，ログイン.paypal-login.com", "~.paypal-login.com", "//$.paypal-login.com"), while X
 * links no name after a "."; then an "@" only where it does not stay one (atStays).
 */
function asOtherSitesRead(text: string, runs = false): string {
  let folded = ''
  let inName = false
  for (const c of text) {
    if (c < '\x80') inName = /[A-Za-z0-9-]/.test(c)
    else inName = joinsName(c) && (inName || !VARIATION_SELECTOR.test(c))
    folded += c >= '\x80' && inName ? '0'.repeat(c.length) : c
  }
  const ended = folded
    .replace(runs ? OTHER_SITES_ENDS_IN_RUNS : OTHER_SITES_ENDS, (m: string) => (m === '@' ? m : ' '.repeat(m.length)))
    .replace(/(?<= )\./g, (dot: string, at: number) => (/[\s\p{P}]/u.test(text[at - 1]) ? dot : ' '))
  return ended.replace(/@/g, (m: string, at: number) => (atStays(text, folded, ended, at) ? m : ' '))
}

/**
 * The hosts a browser may open for `authority` (a "http(s)://" or "www." link's, with no "@" in it),
 * as sites end a link at different places: up to each character that is not a letter, digit, "-",
 * "_" or "." ("%", "．", a quotation mark…: one site ends there, another reads on), each without the
 * port, its escapes decoded, as IDNA reads it (HOST_IGNORED dropped, NFKC, lower case, "。" and "｡"
 * as "."), without dots at its ends.
 */
function hostsOf(authority: string): string[] {
  const raw = authority.replace(HOST_IGNORED, '').replace(/:.*$/s, '')
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
    hosts.push(decoded.replace(HOST_IGNORED, '').normalize('NFKC').toLowerCase().replace(/[。｡]/g, '.').replace(/^\.+|\.+$/g, ''))
  }
  return hosts
}

/**
 * The links in `text`, in order: every link X finds (with those it leaves only for their length, and
 * names on newer top-level domains, which other sites link: `findUrls` read both ways), read three
 * ways; and every "http(s)://", "www." or protocol-relative "//" link elsewhere (glued to a word, in
 * another link's query, to an address X does not link), as X ends it when it links it from there,
 * else up to a space, a quotation mark, punctuation that ends a host (endsLooseLink) or Chinese or
 * Japanese text; and to the next space too when a site reading that far may open another host
 * (otherHostReader: "https://flown.app%2eevil.com", "https://flown.app:8443@evil.com",
 * "https://flown.app!@203.0.113.7").
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
  const add = (start: number, end: number, keep?: number): void => {
    if (end <= start || seen.has(`${start}:${end}`)) return
    seen.add(`${start}:${end}`)
    const t = text.slice(start, end)
    links.push({ start, end, text: t, whole: WHOLE.test(t), ...(keep ? { keep } : {}) })
  }
  const readings: [string, number][] = [[text, 0], [` ${text}`, 1], [` ${asOtherSitesRead(text)}`, 1]]
  // And with the text of languages written without spaces in names, where an "@" may follow one ("ログイン.com@verify").
  if (text.includes('@') && NO_SPACE_TEXT.test(text)) readings.push([` ${asOtherSitesRead(text, true)}`, 1])
  for (const [read, shift] of readings) {
    // X's own reading, and the wider one: a match on a newer top-level domain that X drops can hide one X makes ("/a.web:1paypal-login.com").
    for (const lenient of [false, true]) for (const { indices } of findUrls(read, lenient)) add(Math.max(0, indices[0] - shift), indices[1] - shift)
  }
  // The links found above by where they start, and how far those that start before a point reach (in one pass, as the matches below go forward).
  const found = links.slice().sort((a, b) => a.start - b.start)
  let foundAt = 0
  let reach = 0
  const opens = otherHostReader(text)
  const nextSpace = nextIndex(text, /\s/g)
  const authorityEnd = nextIndex(text, /[\s/?#\\]/g)
  let after = 0
  for (const m of text.matchAll(SCHEME_OR_WWW)) {
    const i = m.index
    while (foundAt < found.length && found[foundAt].start < i) reach = Math.max(reach, found[foundAt++].end)
    // Inside a link found above, or the last one found here: it goes with that one.
    if (i < after || reach > i) continue
    const relative = m[0] === '//'
    // linkify-it starts no "//" glued to a letter or digit (floor division: "img.height//self.scale"), but where an address it read ends ("a@b.de//c.de").
    if (relative && /[\p{L}\p{N}]/u.test(text[i - 1] ?? '') && !/@[^\s@]*$/.test(text.slice(Math.max(0, i - LOOSE_MAX), i))) continue
    let host = i + (/^w/i.test(m[0]) ? 0 : m[0].length)
    // A browser skips "/" and "\\" after "//" ("//\\@203.0.113.7/login" opens 203.0.113.7).
    if (relative) while (text[host] === '/' || text[host] === '\\') host++
    // The stretch a site reading to the next space takes (a link has no space in it).
    const stretch = nextSpace(i)
    // linkify-it reads a "//" link's user name across "\\", "?" and "#" and links the host after its "@", while a browser
    // opens what comes before them ("//paypal-login｡com\\support@flown.app", "//3405803783#support@flown.app"): the stretch.
    if (relative && /^[^@/[\]()]*[?#\\][^@/[\]()]*@[^/?#\\]*[^./?#\\]\.[^/?#\\]/.test(text.slice(host, Math.min(stretch, host + LOOSE_MAX)))) {
      add(i, stretch)
      after = Math.max(after, stretch)
      continue
    }
    // A "//" starts a link only before a dotted host (linkify-it's), and X links none from there.
    if (relative && !DOTTED_AUTHORITY.test(text.slice(host, Math.min(authorityEnd(host), host + LOOSE_MAX)))) continue
    // As if the text started here.
    const from = text.slice(i, Math.min(stretch, i + LOOSE_MAX))
    const own = relative ? 0 : Math.max(0, ...[false, true].map((lenient) => findUrls(from, lenient).find((u) => u.indices[0] === 0)?.indices[1] ?? 0))
    let loose = ''
    if (!own) {
      LOOSE_LINK.lastIndex = 0
      const run = LOOSE_LINK.exec(from)?.[0] ?? ''
      let cut = m[0].length
      while (cut < run.length && !endsLooseLink(String.fromCodePoint(run.codePointAt(cut) as number))) cut += (run.codePointAt(cut) as number) > 0xffff ? 2 : 1
      loose = run.slice(0, cut).replace(LOOSE_TRAIL, '')
    }
    const link = own ? from.slice(0, own) : LOOSE_HOST.test(loose) ? loose : ''
    let end = i + m[0].length
    if (link) {
      end = i + link.length
      add(i, end)
      if (opens(host, stretch, link)) {
        end = stretch
        add(i, end, link.length)
      }
    } else if (relative) {
      // What the loose reading ends at once, linkify-it may read in a host ("//`@203.0.113.7/login"): to the next space, when a host there may be opened.
      if (opens(host, stretch, '')) {
        end = stretch
        add(i, end)
      }
    } else if (/\S/.test(text[end] ?? ' ')) {
      // A scheme glued to what no site reads as a host ("https://日%2eevil…", "https://“…"): the scheme.
      add(i, end)
    }
    after = Math.max(after, end)
  }
  return links.sort((a, b) => a.start - b.start || b.end - a.end)
}

/**
 * For linksIn: whether a site that reads a "http(s)://" or "www." link whose host starts at `start`
 * to `stretch` (the next space) may open another host than that of `link` (its reading as X or a
 * linkifier ends it). Its authority runs to the first "/", "?", "#" or "\\" (a browser's). With an
 * "@" in it, a browser opens whatever follows the last one ("https://flown.app!@203.0.113.7",
 * "https://flown.app:8443@3405803783"), which no transcript's link is unless it says this whole
 * stretch; so does an authority longer than LOOSE_MAX, which no link has (escapes of characters a
 * browser drops can pad one: its hosts are not read); else when a host of it (hostsOf) is on a
 * top-level domain and is neither link's host nor one under it ("https://flown.app%2eevil.com",
 * "https://flown.app．evil．com", 'https://flown.app".evil.com'). A host on no top-level domain
 * ("https://flown.app—great", "https://flown.app,") opens nothing. Called with `start` never going back.
 */
function otherHostReader(text: string): (start: number, stretch: number, link: string) => boolean {
  const nextStop = nextIndex(text, /[\s/?#\\]/g)
  const nextAt = nextIndex(text, /@/g)
  return (start, stretch, link) => {
    const end = Math.min(stretch, nextStop(start))
    if (nextAt(start) < end || end - start > LOOSE_MAX) return true
    const mine = hostsOf(authorityOf(link)).at(-1) ?? ''
    return hostsOf(text.slice(start, end)).some((host) => {
      const dot = host.lastIndexOf('.')
      return dot > 0 && host !== mine && !host.endsWith(`.${mine}`) && isTopLevelDomain(host.slice(dot + 1))
    })
  }
}

/** Where the next match of global `re` in `text` is at or after `pos` (its length when none), for a `pos` that never goes back. */
function nextIndex(text: string, re: RegExp): (pos: number) => number {
  let found = -1
  return (pos) => {
    if (found < pos) {
      re.lastIndex = pos
      found = re.exec(text)?.index ?? text.length
    }
    return found
  }
}

/** A "http(s)://" or "www." link's authority: what comes before its path, query or fragment ("\\" is "/" to a browser). */
const authorityOf = (link: string): string => link.replace(/^https?:\/\//i, '').split(/[/?#\\]/, 1)[0]

/**
 * The ending of a word written on a link ("'dan", "'s", "-Seite", ":sta", "-странице"), which X reads
 * as part of its path: the link without it, and it; or null.
 */
function ending(link: string): { stem: string; tail: string } | null {
  // Letters after it may be none: X ends a link before Bengali, Devanagari or Tamil ("…/guide-এ" links "…/guide-").
  const m = /['’:\-–][\p{L}\p{M}]*$/u.exec(link)
  return m && m.index > 0 ? { stem: link.slice(0, m.index), tail: m[0] } : null
}

/**
 * The "-" X reads into a bare name after a letter of a script other than Latin (Hebrew attaches "ל-",
 * "ב-", "מ-" so: "ל-flown.app" links "-flown.app"), which no registry gives a name: the link without
 * it, and it; or null.
 */
function leadingHyphen(link: string): { lead: string; name: string } | null {
  const m = /^-+(?=[^-])/.exec(link)
  return m && !WHOLE.test(link) ? { lead: m[0], name: link.slice(m[0].length) } : null
}

/**
 * A link as links compare: without "http(s)://" or "//" and without a "/" at its end (each goes to the
 * same place: "https://flown.app/" and "//flown.app" are "flown.app"), the host without case in ASCII
 * only (U+212A, the Kelvin sign, is not "k"), the rest exactly.
 */
function linkKey(link: string): string {
  const bare = link.replace(/^(?:https?:)?\/\//i, '').replace(/\/$/, '')
  const host = /^[^/?#:]*/.exec(bare)?.[0] ?? ''
  return host.replace(/[A-Z]+/g, (c) => c.toLowerCase()) + bare.slice(host.length)
}

/** The last few texts' links: every field of an answer is checked against the same transcript. */
const keysOf = new Map<string, ReadonlySet<string>>()

/**
 * A "-" after a dotted name before a letter of a script other than Latin: Bangla, Hindi and Tamil
 * write a case ending so ("flown.app-এ", "flown.app-पर", "flown.app-இல்"), and no site links the name
 * then (a "-" follows its top-level domain).
 */
const NAME_HYPHEN_ENDING = /(?<=[\p{L}\p{N}]\.[\p{L}\p{N}]+)-(?=[^\P{L}\p{Script=Latin}])/gu

/** The links of `text` (in its NFC form, as X reads it), as linkKey compares them, each also without a word's ending and without a "-" X reads before it. */
export function linkKeys(text: string): ReadonlySet<string> {
  let keys = keysOf.get(text)
  if (keys) keysOf.delete(text)
  else {
    const set = new Set<string>()
    for (const l of linksIn(text.normalize())) {
      set.add(linkKey(l.text))
      const e = ending(l.text)
      if (e) set.add(linkKey(e.stem))
      const h = leadingHyphen(l.text)
      if (h) set.add(linkKey(h.name))
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

/** What cleanLinks writes for `l`, a link (or links taken together) that `allowed` lacks. */
function cleanedLink(l: Link, allowed: ReadonlySet<string>): string {
  const said = l.keep ? l.text.slice(0, l.keep) : ''
  if (said && allowed.has(linkKey(said))) return `${said}${BREAK}${l.text.slice(said.length)}`
  const e = ending(l.text)
  if (e && allowed.has(linkKey(e.stem))) return `${e.stem}${JOIN}${e.tail}`
  const h = leadingHyphen(l.text)
  if (h && allowed.has(linkKey(h.name))) return `${h.lead}${JOIN}${h.name}`
  return l.whole ? '' : l.text.replace(/\./g, `.${BREAK}`)
}

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
 * stretch read to the next space (Link.keep) that starts with a link `allowed` has keeps that link,
 * with BREAK after it ("https://flown.app，客服邮箱：support@flown.app。": a site reading on to the next
 * space then reads only the said link, and what follows it is read again); a link that is one
 * `allowed` has with a word's ending ("flown.app/download'dan") gets JOIN before the ending, and one
 * X reads with a "-" before it ("ל-flown.app") gets JOIN after the "-"; else a link with a scheme or
 * "www." (and its port, path and query) is removed (the punctuation after it stays), and a bare name
 * ("evil.com/login", "TP.Thủ", "README.md", "//203.0.113.7") gets BREAK after each of its dots
 * ("evil. com/login", "TP. Thủ"), so no word loses a letter and nothing links it. The result is read
 * again until no such link is left, since removing one can join the text around it into another;
 * should a text still hide one after ROUNDS, noLinkAtAll.
 */
function cleanLinks(text: string, allowed: ReadonlySet<string>): string {
  let t = text
  for (let round = 0; round < ROUNDS; round++) {
    const nfc = t.normalize()
    const bad = disallowed(nfc, allowed)
    // What was read: NFC once anything changed (a mark left by a removed link joins the letter before it).
    if (!bad.length) return round ? nfc : t
    let out = ''
    let last = 0
    for (const l of bad) {
      out += nfc.slice(last, l.start) + cleanedLink(l, allowed)
      last = l.end
    }
    t = out + nfc.slice(last)
  }
  const nfc = t.normalize()
  return disallowed(nfc, allowed).length ? noLinkAtAll(nfc) : nfc
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
 * The links `text` says (linkKeys), and a name said with a hyphen ending ("flown.app-এ": NAME_HYPHEN_ENDING),
 * which no site links. For what was said, and for what an AI wrote into a caption (the more, the less is
 * trusted); not for a cut, which keeps only the links its text has (cutAt, sliceAt, fitX).
 */
export function saidKeys(text: string): ReadonlySet<string> {
  const nfc = text.normalize()
  NAME_HYPHEN_ENDING.lastIndex = 0
  if (!NAME_HYPHEN_ENDING.test(nfc)) return linkKeys(text)
  return new Set([...linkKeys(text), ...linkKeys(nfc.replace(NAME_HYPHEN_ENDING, ' '))])
}

/**
 * The text whose links an answer may have: the transcript that was sent, and the recording's name and
 * chapter titles, which the user typed (what an AI suggested for them lost in main the links its
 * captions lack: transcriptText.ts). On lines of their own, so no link spans two of them.
 */
export function trustedText(transcript: string, context?: { title?: string; chapters?: string[] }): string {
  // Without them, the transcript itself: its links are read once (linkKeys remembers the last few texts).
  return [transcript, ...(context?.title ? [context.title] : []), ...(context?.chapters ?? [])].join('\n')
}

/**
 * CaptionSegment.aiLinks of a caption an AI wrote more links into than a caption records (or whose
 * record could not be read whole): every link of its text is the AI's. A list cut short would have
 * the pack trust the links it lost.
 */
export const EVERY_LINK = '*'

/** The links an AI wrote into caption `s`: its aiLinks, or every link of its text when they are EVERY_LINK. */
export function aiLinksOf(s: { text: string; aiLinks?: readonly string[] }): readonly string[] {
  if (!s.aiLinks?.length) return []
  return s.aiLinks.includes(EVERY_LINK) ? [...saidKeys(s.text)] : s.aiLinks
}

/**
 * The links Fix captions or Translate wrote into `segments` (CaptionSegment.aiLinks, aiLinksOf) that
 * nothing else says: not a caption's own (its links but its aiLinks), nor the name's or a chapter
 * title's. The copy pack never trusts them (PlainTextOptions.untrusted, docs/design/publish-pack.md §4.6).
 */
export function unsaidLinks(segments: readonly { text: string; aiLinks?: readonly string[] }[], context?: { title?: string; chapters?: string[] }): string[] {
  const marked = segments.filter((s) => s.aiLinks?.length)
  if (!marked.length) return []
  const said = new Set(saidKeys(trustedText(segments.filter((s) => !s.aiLinks?.length).map((s) => s.text).join(' '), context)))
  for (const s of marked) {
    const ai = new Set(aiLinksOf(s))
    for (const k of saidKeys(s.text)) if (!ai.has(k)) said.add(k)
  }
  return [...new Set(marked.flatMap(aiLinksOf))].filter((k) => !said.has(k))
}

/** `keys` without `gone`. */
const without = (keys: ReadonlySet<string>, gone: readonly string[] | undefined): ReadonlySet<string> => {
  if (!gone?.length) return keys
  const out = new Set(keys)
  for (const k of gone) out.delete(k)
  return out
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
 * `s` as plain text: line breaks normalised, control and direction characters and the word joiner
 * removed (a tab is a space), NFC, markdown emphasis removed, spaces at line ends and repeated blank lines removed,
 * trimmed, cut to `max`, and then every link `linksFrom` does not have (keepLinks: `s` itself), or
 * that is `untrusted`, removed or broken (cleanLinks). Not a string: ''.
 */
export function plainText(s: unknown, opts: PlainTextOptions): string {
  if (typeof s !== 'string') return ''
  const allowed = without(saidKeys(opts.keepLinks ? s : (opts.linksFrom ?? '')), opts.untrusted)
  let t = s.replace(/\r\n?/g, '\n').replace(/\t/g, ' ').replace(CONTROLS, '').replace(WORD_JOINER, '').normalize()
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

/**
 * `s` cut to at most `max` UTF-16 units, never inside a surrogate pair, as a name or a field that
 * counts them is cut (no "…", no word end), with no link the cut made that `s` lacks: a title that
 * ends in "flown-files.comfy" cut after "com" gives "flown-files.c", as its break would not fit.
 * Text an AI wrote that the copy pack then trusts as typed (the recording's name, a chapter title) is
 * cut with this, so a cut cannot make a link nobody said.
 */
export function sliceAt(s: string, max: number): string {
  if (s.length <= max) return s
  const units = (budget: number): string => {
    const end = Math.max(0, budget)
    const code = s.charCodeAt(end - 1)
    return s.slice(0, code >= 0xd800 && code <= 0xdbff ? end - 1 : end)
  }
  return settle(linkKeys(s), max, units, (t) => t.length)
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
