/**
 * The copy pack's link check (docs/design/publish-pack.md §4.8). Words spoken in a recording can
 * steer an AI into writing a link into the copy; nothing rewrites the copy for it. Instead this
 * finds every piece of a text (between ASCII spaces) that holds anything link-like nobody said, so
 * that the piece is shown under its card and confirmed before it leaves the app. It never changes
 * text, and it is over-inclusive on purpose: a dotted file name the AI wrote is noted too. Pure.
 */
import { isTopLevelDomain } from './twitterText'

/* ---------- reading a piece ---------- */

/** What a browser drops or shows nothing for: controls, format characters, variation selectors, the combining grapheme joiner, Hangul fillers. */
const INVISIBLE = /[\p{Cc}\p{Cf}\u034f\u115f\u1160\u3164\uffa0\u180b-\u180f\ufe00-\ufe0f\u{e0100}-\u{e01ef}]/gu

/** An HTML character reference by a name this does not know: it may be any letter ("&rcy;&fcy;" is "рф"), so a label with it may be a top-level domain. */
const ANY = '\ue000'

/** Named character references for the punctuation a link is written with. */
const NAMED: Readonly<Record<string, string>> = {
  period: '.', colon: ':', sol: '/', bsol: '\\', commat: '@', num: '#', quest: '?', percnt: '%', lowbar: '_', amp: '&', excl: '!', dollar: '$',
  plus: '+', equals: '=', comma: ',', semi: ';', ast: '*', lpar: '(', rpar: ')', lsqb: '[', rsqb: ']', verbar: '|', apos: "'", quot: '"', lt: '<',
  gt: '>', hyphen: '-', dash: '-', nbsp: ' ', tab: '\t', newline: '\n'
}

/** HTML's character references: numeric with or without ";" and with any number of digits, and named ones with ";". */
const REFERENCE = /&#(\d+);?|&#x([0-9a-f]+);?|&([a-z][a-z0-9]{1,31});/gi

const decodeReferences = (s: string): string =>
  s.replace(REFERENCE, (_m, dec?: string, hex?: string, name?: string) => {
    if (name) return NAMED[name] ?? NAMED[name.toLowerCase()] ?? ANY
    const digits = (dec ?? (hex as string)).replace(/^0+(?=.)/, '')
    const code = digits.length > 8 ? Infinity : parseInt(digits, dec ? 10 : 16)
    return code > 0 && code <= 0x10ffff && (code < 0xd800 || code > 0xdfff) ? String.fromCodePoint(code) : '�'
  })

/** Percent-escapes decoded as UTF-8 (when they are not UTF-8, those of ASCII characters alone). */
const decodePercents = (s: string): string =>
  s.replace(/(?:%[0-9a-f]{2})+/gi, (m) => {
    try {
      return decodeURIComponent(m)
    } catch {
      return m.replace(/%([0-7][0-9a-f])/gi, (_e, h: string) => String.fromCharCode(parseInt(h, 16)))
    }
  })

/** Both kinds of escape until none is left ("%2526%2346;" is "&#46;" is "."), a few rounds at most. */
function decoded(s: string): string {
  let t = s
  for (let round = 0; round < 3 && /[%&]/.test(t); round++) {
    const next = decodePercents(decodeReferences(t))
    if (next === t) break
    t = next
  }
  return t
}

/**
 * A piece as the check reads it: HTML character references and percent-escapes decoded, invisible
 * and format characters removed, NFKC, the dot-likes "。", "．" and "｡" (IDNA's dots) as ".", "\\" as
 * "/" (a browser reads it so in a URL), lower case.
 */
export function normalise(s: string): string {
  const t = decoded(s.replace(INVISIBLE, '')).replace(INVISIBLE, '').normalize('NFKC')
  return decoded(t).replace(INVISIBLE, '').replace(/[。．｡]/g, '.').replace(/\\/g, '/').toLowerCase()
}

/**
 * A piece as a linkifier reads it, also checked: the same without NFKC and with ASCII letters alone in
 * lower case, as X and linkify-it end a name before a character NFKC would make ASCII ("evil.comſ" and
 * "evil.comK" link evil.com) and read "（" as no "(" ("（anna.li@acme.de" links anna.li).
 */
const asWritten = (s: string): string =>
  decoded(s.replace(INVISIBLE, ''))
    .replace(INVISIBLE, '')
    .replace(/[。．｡]/g, '.')
    .replace(/\\/g, '/')
    .replace(/[A-Z]+/g, (c) => c.toLowerCase())

/* ---------- what is link-like ---------- */

/**
 * A scheme: letters, then ":", then more than nothing ("https:x", "mailto:x", "javascript:x"). Two
 * characters or more: one letter is a Windows drive ("C:\\Users\\…"), and opens no host.
 */
const SCHEME = /(?<![a-z0-9+.-])[a-z][a-z0-9+.-]+:(?=\S)/
/** "www.", "//" or "@" before a host (letters, digits, "." and "-", so every form of an IPv4 address; "[" for IPv6). */
const BEFORE_HOST = /(?:www\.|\/\/|@)[\p{L}\p{N}\p{M}\p{Co}[_.\-]/u
/**
 * A name's dot and the label after it (which "_" ends: X links "df.to" in "df.to_csv"); the name may be
 * glued to text in any script ("ログインflown.jp", "flown.jpから").
 */
const DOTTED = /(?<=[\p{L}\p{N}\p{M}\p{Co}_\-]|(?![<>|^])\p{S})\.([\p{L}\p{N}\p{M}\p{Co}\-]+)/gu

/**
 * Whether `label`, the last label of a dotted name, is a top-level domain from the full list, also
 * without its marks; or, after a name that ends in ASCII, one glued to more text: an ASCII one before
 * a letter or symbol of another script ("flown.jpから", "README.md를"), or one in another script
 * before more of it ("paypal-login.在线客服", which X links). Any label with a reference this could
 * not read (ANY) may be.
 */
function topLevel(label: string, afterAscii: boolean): boolean {
  if (isTopLevelDomain(label) || label.includes(ANY)) return true
  const bare = label.normalize('NFD').replace(/\p{M}/gu, '')
  if (bare !== label && isTopLevelDomain(bare)) return true
  if (!afterAscii) return false
  const ascii = /^[a-z0-9]+/.exec(label)?.[0]
  if (ascii) return ascii.length < label.length && /[^\x00-\x7f]/.test(label[ascii.length]) && isTopLevelDomain(ascii)
  const chars = [...label]
  for (let k = 1; k < Math.min(chars.length, 13); k++) if (isTopLevelDomain(chars.slice(0, k).join(''))) return true
  return false
}

/**
 * Whether `n` (a piece as `normalise` reads it) holds anything link-like: a scheme, "www.", "//" or
 * "@" before a host, or a dotted name whose last label is a top-level domain (topLevel). Linear.
 */
export function linkLike(n: string): boolean {
  if (SCHEME.test(n) || BEFORE_HOST.test(n)) return true
  for (const m of n.matchAll(DOTTED)) if (topLevel(m[1], /[a-z0-9-]/.test(n[m.index - 1]))) return true
  return false
}

/* ---------- what was said ---------- */

/** What was said, as the check blanks it: the link-like tokens of the said texts. */
export interface Said {
  readonly tokens: ReadonlySet<string>
}

/** Nothing said: every link-like piece is noted. */
export const NOTHING_SAID: Said = { tokens: new Set() }

/** ASCII spaces: every Markdown, HTML and URL parser ends a link there. Other spaces stay inside a piece. */
const ASCII_SPACES = /[\t\n\f\r ]+/
const PIECE = /[^\t\n\f\r ]+/g

/** Runs of a said piece its tokens are: the ASCII characters a URL is written with, and dotted names in any script. */
const URL_RUN = /[a-z0-9\-._~:/?#[\]@!$&'()*+,;=%\ue000]+/g
const NAME_RUN = /[\p{L}\p{N}\p{M}\p{Co}_\-]+(?:\.[\p{L}\p{N}\p{M}\p{Co}_\-]+)+/gu

const count = (s: string, c: string): number => s.split(c).length - 1

/**
 * `run` without the brackets, quotation marks and sentence punctuation around it (a ")" of its own
 * stays: "…/Foo_(bar)"), nor a "-" a word's ending was written after ("flown.app/docs-এ").
 */
function trimmed(run: string): string {
  let t = run.replace(/^['(\[]+/, '')
  for (;;) {
    let u = t.replace(/[-.,:;!?'\]]+$/, '')
    if (u.endsWith(')') && count(u, '(') < count(u, ')')) u = u.slice(0, -1)
    if (u === t) return t
    t = u
  }
}

/**
 * `token` and the forms of it that go to the same host: with and without "http(s)://" or "//" and a
 * "/" at its end, and a link's host alone; an address's host, and the address with "mailto:" (or
 * without, when said with it).
 */
function formsOf(token: string): string[] {
  const forms = [token]
  const bare = token.replace(/^(?:https?:)?\/\//, '').replace(/^mailto:/, '')
  const mail = /^[^@/?#:]+@([^@/?#]+)$/.exec(bare)
  if (mail) forms.push(bare, `mailto:${bare}`, mail[1])
  else if (!/^[a-z][a-z0-9+.-]*:/.test(bare)) {
    const path = bare.replace(/\/$/, '')
    for (const b of [path, `${path}/`]) forms.push(b, `https://${b}`, `http://${b}`, `//${b}`)
    const host = /^(?:[^@/?#]*@)?([^/?#:]+)/.exec(bare)?.[1]
    if (host && host !== path && host.includes('.')) forms.push(host, `${host}/`, `https://${host}`, `http://${host}`)
  }
  return forms.filter((f) => f.length >= 2)
}

/** The link-like tokens of `text` (said), as `normalise` reads it, with the forms that go to the same place (formsOf). */
function tokensOf(text: string): string[] {
  const out = new Set<string>()
  for (const piece of text.split(ASCII_SPACES)) {
    if (!piece) continue
    const n = normalise(piece)
    if (!linkLike(n)) continue
    for (const m of [...n.matchAll(URL_RUN), ...n.matchAll(NAME_RUN)]) {
      const t = trimmed(m[0])
      // Also without a word's ending written after an apostrophe ("flown.app/docs'ta", "README.md's").
      for (const u of [t, t.replace(/'[a-z]+$/, '')]) if (u && linkLike(u)) for (const form of formsOf(u)) out.add(form)
    }
  }
  return [...out]
}

/** The tokens of each said text, remembered: a caption's are read once while its text stays the same. */
const tokenCache = new Map<string, string[]>()
function cachedTokens(text: string): string[] {
  let t = tokenCache.get(text)
  if (!t) {
    t = tokensOf(text)
    if (tokenCache.size >= 20_000) tokenCache.clear()
    tokenCache.set(text, t)
  }
  return t
}

/** What was said in `texts`: their link-like tokens. */
export function saidOf(texts: readonly string[]): Said {
  const tokens = new Set<string>()
  for (const text of texts) for (const t of cachedTokens(text)) tokens.add(t)
  return { tokens }
}

/**
 * The said tokens as one automaton (Aho–Corasick): `next` per state, the state a mismatch falls back
 * to, and the lengths of the tokens that end in each state. Finds every token in a text in one pass.
 */
interface Matcher {
  next: Map<string, number>[]
  fail: number[]
  ends: number[][]
}

const matchers = new WeakMap<Said, Matcher>()
function matcherOf(said: Said): Matcher {
  let m = matchers.get(said)
  if (m) return m
  const next: Map<string, number>[] = [new Map()]
  const ends: number[][] = [[]]
  // By UTF-16 units, as a text is read.
  for (const t of said.tokens) {
    let state = 0
    for (let k = 0; k < t.length; k++) {
      const c = t[k]
      let to = next[state].get(c)
      if (to === undefined) {
        to = next.length
        next.push(new Map())
        ends.push([])
        next[state].set(c, to)
      }
      state = to
    }
    ends[state].push(t.length)
  }
  const fail = new Array<number>(next.length).fill(0)
  const queue = [...next[0].values()]
  for (let q = 0; q < queue.length; q++) {
    const state = queue[q]
    for (const [c, to] of next[state]) {
      let f = fail[state]
      while (f && !next[f].has(c)) f = fail[f]
      fail[to] = next[f].get(c) ?? 0
      ends[to] = [...ends[to], ...ends[fail[to]]]
      queue.push(to)
    }
  }
  m = { next, fail, ends }
  matchers.set(said, m)
  return m
}

/** The last answer of saidLinks for each caption list. */
const saidMemo = new WeakMap<readonly object[], { key: string; said: Said }>()

/**
 * What was said for the copy of `segments` (the captions it is written from) and `context` (the
 * recording's name and chapter titles): the tokens of the captions without aiLinks (no AI wrote a
 * link into them), the name and the chapter titles. Remembered for the caption list: read once per
 * change of the captions, never per render.
 */
export function saidLinks(segments: readonly { text: string; aiLinks?: readonly string[] }[], context?: { title?: string; chapters?: readonly string[] }): Said {
  const key = JSON.stringify([context?.title ?? '', context?.chapters ?? []])
  const memo = saidMemo.get(segments)
  if (memo && memo.key === key) return memo.said
  const said = saidOf([...segments.filter((s) => !s.aiLinks?.length).map((s) => s.text), ...(context?.title ? [context.title] : []), ...(context?.chapters ?? [])])
  saidMemo.set(segments, { key, said })
  return said
}

/* ---------- the check ---------- */

/**
 * What joins a name: a letter of any script, a digit, mark or symbol (linkify-it reads one into a
 * host: "😀flown.to"; not "<", ">", "|" or "^", which end one), ".", "-", "_", "@", ":", "/", "%" or "&".
 */
const JOINS = /[\p{L}\p{N}\p{M}\p{Co}._@:/%&\-]|(?![<>|^])\p{S}/u
/** What joins a scheme before it: ASCII letters, digits, "+", "." and "-" (dots alone end a sentence: "完成。https://…"). */
const SCHEME_BEFORE = /[a-z0-9+-][a-z0-9+.-]*$/
/** A token that is a host alone: no path, query or fragment after its scheme. */
const HOST_ONLY = /^(?:[a-z][a-z0-9+.-]*:)?(?:\/\/)?[^/?#]*$/

const charBefore = (s: string, i: number): string => (i > 0 ? String.fromCodePoint(s.codePointAt(i >= 2 && /[\udc00-\udfff]/.test(s[i - 1]) ? i - 2 : i - 1) as number) : '')
const charAt = (s: string, i: number): string => (i < s.length ? String.fromCodePoint(s.codePointAt(i) as number) : '')

/**
 * Whether what comes after a token that ends at `end` joins it. Dots or colons that end a sentence
 * do not ("flown.app." is flown.app): what comes after them must. After a host alone, neither does a
 * port or line number ("main.py:42,"), nor a dot before the text of another script, which ends a
 * sentence ("README.md。第二步"), unless that text may be a top-level domain ("flown.app。在线"); what
 * comes after is read on its own.
 */
function joinsAfter(n: string, end: number, hostOnly: boolean): boolean {
  let i = end + (hostOnly ? (/^:\d{1,5}/.exec(n.slice(end, end + 6))?.[0].length ?? 0) : 0)
  while (n[i] === '.' || n[i] === ':') i++
  const next = charAt(n, i)
  if (next === '' || !JOINS.test(next)) return false
  if (!hostOnly || !n.slice(end, i).includes('.') || !/[^\x00-\x7f]/.test(next) || !/\p{L}/u.test(next)) return true
  LABEL_AT.lastIndex = i
  return topLevel(LABEL_AT.exec(n)?.[0] ?? '', true)
}

/** A label from where it is looked for (DOTTED's). */
const LABEL_AT = /[\p{L}\p{N}\p{M}\p{Co}\-]*/uy

/** What may come right before an address whose user name is a name on a top-level domain: else linkify-it reads that name as a host ("'anna.li@acme.de'"). */
const BEFORE_MAIL = /^[<>｜"(\s]?$/u

/**
 * Whether what comes before a token that starts at `i` joins it: for a token with a scheme, an
 * ASCII letter, digit, "+" or "-" (a longer scheme); for an address whose user name is a dotted name
 * (anna.li@acme.de), anything but what linkify-it starts an address after (BEFORE_MAIL); else JOINS,
 * but a colon only after an ASCII letter, digit, "+", "." or "-" (a scheme or a port): after other
 * text it is punctuation ("下载：flown.app").
 */
function joinsBefore(n: string, i: number, token: string): boolean {
  if (/^[a-z][a-z0-9+.-]*:/.test(token)) return SCHEME_BEFORE.test(n.slice(Math.max(0, i - 64), i))
  const at = token.indexOf('@')
  if (at > 0 && linkLike(token.slice(0, at)) && !BEFORE_MAIL.test(charBefore(n, i))) return true
  let j = i
  while (n[j - 1] === ':') j--
  const prev = charBefore(n, j)
  return prev !== '' && (j < i ? /[a-z0-9+.-]/.test(prev) : JOINS.test(prev))
}

/** `n` with every said token blanked where it stands alone (nothing that joins it right before or after it). Linear in `n` for a given said set. */
function withoutSaid(n: string, said: Said): string {
  if (!said.tokens.size) return n
  const { next, fail, ends } = matcherOf(said)
  // How far a blank reaches from each position, the tokens found by where they end.
  const blank = new Int32Array(n.length)
  let state = 0
  for (let j = 0; j < n.length; j++) {
    const c = n[j]
    while (state && !next[state].has(c)) state = fail[state]
    state = next[state].get(c) ?? 0
    for (const length of ends[state]) {
      const i = j + 1 - length
      const t = n.slice(i, j + 1)
      if (!joinsBefore(n, i, t) && !joinsAfter(n, j + 1, HOST_ONLY.test(t))) blank[i] = Math.max(blank[i], j + 1)
    }
  }
  let out = ''
  let copied = 0
  for (let i = 0; i < n.length; ) {
    if (blank[i] <= i) {
      i++
      continue
    }
    let end = blank[i]
    for (let k = i + 1; k < end; k++) end = Math.max(end, blank[k])
    out += n.slice(copied, i) + ' '.repeat(end - i)
    copied = i = end
  }
  return out + n.slice(copied)
}

/** Whether `piece` (as written, between ASCII spaces) holds anything link-like once what was said is blanked, as either reading has it. */
function isNoted(piece: string, said: Said): boolean {
  if (!/[.:@/\\%&]|[^\x00-\x7f]/.test(piece)) return false
  return [normalise(piece), asWritten(piece)].some((n) => linkLike(n) && linkLike(withoutSaid(n, said)))
}

/** A piece of a text the check notes: where it is, and its text as written. */
export interface Noted {
  start: number
  end: number
  text: string
}

/** A quoted attribute value: a browser drops the tabs and line breaks in it before it reads a URL there ('<a href="https://flown.app\n.com">'). */
const QUOTED = /=\s*(?:"([^"]*)"|'([^']*)')/g

/**
 * The pieces of `text` (between ASCII spaces, exactly as written) that hold anything link-like
 * nobody said, in order; and, as one piece, a quoted attribute value with a tab or line break in it
 * when it is so once they are dropped. Never changes the text.
 */
export function notedPieces(text: string, said: Said): Noted[] {
  const found: Noted[] = []
  for (const m of text.matchAll(PIECE)) if (isNoted(m[0], said)) found.push({ start: m.index, end: m.index + m[0].length, text: m[0] })
  for (const m of text.matchAll(QUOTED)) {
    const value = m[1] ?? m[2] ?? ''
    if (!/[\t\n\r]/.test(value)) continue
    const start = m.index + m[0].length - value.length - 1
    const end = start + value.length
    const joined = value.replace(/[\t\n\r]+/g, '').split(/[\f ]+/)
    if (joined.some((part) => part && isNoted(part, said)) && !found.some((f) => f.start <= start && f.end >= end)) found.push({ start, end, text: value })
  }
  return found.sort((a, b) => a.start - b.start)
}

/** The noted pieces of `text` (notedPieces), each once, in order: what a note lists. */
export const linksToCheck = (text: string, said: Said): string[] => [...new Set(notedPieces(text, said).map((p) => p.text))]

/** How a piece shows: invisible characters as their code ("evil⟨U+200B⟩.com"), so nothing in it is hidden. */
export const shownRun = (run: string): string => run.replace(INVISIBLE, (c) => `⟨U+${(c.codePointAt(0) as number).toString(16).toUpperCase().padStart(4, '0')}⟩`)

/** Characters of context a confirm shows on each side of a noted piece. */
const CONTEXT = 12

/** Noted piece `p` of `text` as a confirm shows it (shownRun), with a few characters of context on each side. */
export function inContext(text: string, p: Noted): { before: string; piece: string; after: string } {
  const before = text.slice(Math.max(0, p.start - CONTEXT), p.start).replace(/\s+/g, ' ')
  const after = text.slice(p.end, p.end + CONTEXT).replace(/\s+/g, ' ')
  return {
    before: `${p.start > CONTEXT ? '…' : ''}${shownRun(before)}`,
    piece: shownRun(p.text),
    after: `${shownRun(after)}${p.end + CONTEXT < text.length ? '…' : ''}`
  }
}
