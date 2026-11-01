/**
 * The copy pack's safety net (docs/design/publish-pack.md §4.8). The link cleaning (text.ts) rewrites
 * an answer for every reading it knows; this never changes text. It reads each card paranoidly, as a
 * browser might read a host (characters it drops dropped, escapes decoded, NFKC, IDNA's dots as dots),
 * and returns every stretch some site could turn into a link that is not a said one, for the Publish
 * dialog to show as "Check this link before you post". A false alarm only shows a note. Pure.
 */
import { isMailAt, saidKeys, trustedText, unsaidLinks } from './text'
import { isTopLevelDomain } from './twitterText'

/** What was said, as the safety net compares it: the links the pack trusts, and the e-mail addresses said. */
export interface SaidLinks {
  /** The pack's said links (saidKeys of the transcript, name and chapter titles, but those an AI wrote into the captions), as `view` reads them. */
  links: readonly string[]
  /** E-mail addresses said (in captions no AI wrote a link into, the name or a chapter title), as `view` reads them. */
  mails: ReadonlySet<string>
  /** Stretches of what was said (between spaces) that the net would note, as `view` reads them: one written the same way needs no note. */
  runs: ReadonlySet<string>
}

/** Nothing said: linksToCheck then notes every stretch some site could link (what is said only takes notes away). */
export const NOTHING_SAID: SaidLinks = { links: [], mails: new Set(), runs: new Set() }

/** Spaces that end every reading of a link (not U+FEFF or U+180E, which a linkifier reads into a host and a browser drops). */
const SPACES = '\\t\\n\\v\\f\\r \\u00a0\\u1680\\u2000-\\u200a\\u2028\\u2029\\u202f\\u205f\\u3000'
const SPACE = new RegExp(`[${SPACES}]+`)
/** A stretch between spaces. */
const NOT_SPACE = new RegExp(`[^${SPACES}]+`, 'g')
/** What a browser drops from a host, or what shows nothing: controls, format characters, variation selectors, the combining grapheme joiner, Hangul fillers. */
const INVISIBLE = /[\p{Cc}\p{Cf}\u034f\u115f\u1160\u3164\uffa0\u180b-\u180f\ufe00-\ufe0f\u{e0100}-\u{e01ef}]/gu

/**
 * A stand-in (a private-use character) for an HTML character reference by a name this does not know:
 * it may be any letter ("&rcy;&fcy;" is "рф", "&oopf;" NFKC's "o"), so a label with it may be a
 * top-level domain (mayBeTld).
 */
const ANY = '\ue000'
/** Named character references for the ASCII punctuation a link is written with (and the no-break space). */
const NAMED: Readonly<Record<string, string>> = {
  period: '.', colon: ':', sol: '/', bsol: '\\', commat: '@', num: '#', quest: '?', percnt: '%', lowbar: '_', UnderBar: '_', amp: '&', AMP: '&',
  excl: '!', dollar: '$', plus: '+', equals: '=', comma: ',', semi: ';', ast: '*', midast: '*', lpar: '(', rpar: ')', lsqb: '[', lbrack: '[',
  rsqb: ']', rbrack: ']', lcub: '{', lbrace: '{', rcub: '}', rbrace: '}', verbar: '|', vert: '|', VerticalLine: '|', apos: "'", quot: '"',
  QUOT: '"', lt: '<', LT: '<', gt: '>', GT: '>', Hat: '^', grave: '`', DiacriticalGrave: '`', nbsp: '\u00a0', NonBreakingSpace: '\u00a0'
}
/**
 * A backslash escape of ASCII punctuation, or a character reference: CommonMark's, and HTML's numeric
 * one, which needs no ";" and may have any number of digits ('<a href="//paypal-login&#46com">',
 * "&#0000046;").
 */
const MARKDOWN_ESCAPE = /\\([!-/:-@[-`{-~])|&(?:#(\d+);?|#[xX]([0-9a-fA-F]+);?|([A-Za-z][A-Za-z0-9]{1,31});)/g

/**
 * `s` as a Markdown renderer gives it to a linkifier or a browser (a help centre's article, a link's
 * destination: "[here](https\\://paypal-login\\.com)", "paypal-login&#46;com"): backslash escapes and
 * character references decoded, an unknown name as ANY.
 */
function unescapeMarkdown(s: string): string {
  return s.replace(MARKDOWN_ESCAPE, (_m, punct?: string, dec?: string, hex?: string, name?: string) => {
    if (punct) return punct
    if (name) return NAMED[name] ?? ANY
    const digits = (dec ?? (hex as string)).replace(/^0+(?=.)/, '')
    const code = digits.length > 8 ? Infinity : parseInt(digits, dec ? 10 : 16)
    return code > 0 && code <= 0x10ffff && (code < 0xd800 || code > 0xdfff) ? String.fromCodePoint(code) : '\ufffd'
  })
}

/**
 * Where a browser reads a host: after "//" (either slash may be "\\") or a special scheme (which needs
 * no slashes: "https:evil.com"), to its path, query or fragment.
 */
const AUTHORITY = /(?:[/\\]{2}|(?<![a-z0-9+.-])(?:https?|ftp|wss?):[/\\]*)[^/?#\\]*/giu

/**
 * Characters other than ASCII's that NFKC turns into, or ends with, the "@", "/", "\\", "_" or "." after
 * which linkable starts no name ("＠", "／", "＿", "…", "℅" "c/o", "⒈" "1."): every site reads them in
 * text as punctuation, and linkify-it starts a link right after them ("＠ログインflown.jp"). ("．" is
 * IDNA's dot: view keeps it apart.)
 */
const COMPAT_PUNCTUATION = /[\u2024-\u2026\u2100\u2101\u2105\u2106\u2488-\u249b\u33c2\u33c7\u33d8\ufe19\ufe30\ufe33\ufe34\ufe4d-\ufe4f\ufe52\ufe68\ufe6b\uff0f\uff20\uff3c\uff3f\u{1f100}]/gu

/**
 * `s` as a browser may read it in a host: Markdown's escapes decoded (unless `markdown` is false: a
 * site that does not render Markdown reads them as written), invisible characters dropped, escapes
 * decoded, NFKC, lower case. IDNA's dots ("。", "｡", "．") are dots in a host a browser is given (after
 * "//" or a scheme, to its path), and nowhere else: no site links across them in text, where Chinese
 * and Japanese end their sentences with them ("设置完成。网站上有更多教程。"). Outside such a host,
 * COMPAT_PUNCTUATION is read as the punctuation "、", not as what NFKC makes of it.
 */
export function view(s: string, markdown = true): string {
  const decoded = (markdown ? unescapeMarkdown(s) : s).replace(INVISIBLE, '').replace(/(?:%[0-9a-f]{2})+/gi, (m) => {
    try {
      return decodeURIComponent(m)
    } catch {
      return m.replace(/%([0-7][0-9a-f])/gi, (_e, h: string) => String.fromCharCode(parseInt(h, 16)))
    }
  })
  // Outside a host, "．" as "。" (which NFKC keeps) and COMPAT_PUNCTUATION as "、".
  const outside = (t: string): string => t.replace(/．/g, '。').replace(COMPAT_PUNCTUATION, '、')
  let dotted = ''
  let last = 0
  for (const m of decoded.matchAll(AUTHORITY)) {
    dotted += outside(decoded.slice(last, m.index)) + m[0].replace(/[。｡．]/g, '.')
    last = m.index + m[0].length
  }
  dotted += outside(decoded.slice(last))
  return dotted.normalize('NFKC').toLowerCase().replace(INVISIBLE, '')
}

/**
 * A scheme a site links from ("https://", "ftp://", "javascript:"…), and a special scheme a browser
 * reads without its slashes before a host ("https:paypal-login.com", "http:/evil.com",
 * "https:3405803783"; not "https:で始まります", which has none).
 */
const SCHEME = /(?<![a-z0-9+.-])(?:[a-z][a-z0-9+.-]*:\/\/|(?:mailto|javascript|vbscript|data):|(?:https?|ftp|wss?):(?=[/\\a-z0-9\ue000]|[^\s/?#\\]*\.))/u
/** "www." starting a name. */
const WWW = /(?<![\p{L}\p{N}_-])www\d{0,3}\./u
/**
 * An IP address as a browser reads a host after "//" (either slash may be "\\": "\\/203.0.113.7") or
 * "@": a dotted quad (of decimal or hex parts), or one number (eight digits or more, or hex); and after
 * a "//" that is not glued to a letter or digit (where linkify-it starts one: not floor division,
 * "3//4.5"), two or three parts ("//203.28935" and "//1.1" are 203.0.113.7 and 1.0.0.1); and an IPv6
 * address in brackets after "//", "@" or a special scheme ("//[2606:4700::1111]", "https:[::1]").
 */
const NUMERIC_HOST =
  /(?:[/\\]{2}|@)[/\\]*(?:\d{8,}|0x[0-9a-f]{6,}|(?:0x[0-9a-f]+|\d+)(?:\.(?:0x[0-9a-f]+|\d+)){3})(?![\p{L}\p{N}])|(?<![\p{L}\p{N}])[/\\]{2}[/\\]*(?:0x[0-9a-f]+|\d+)(?:\.(?:0x[0-9a-f]+|\d+)){1,2}(?![\p{L}\p{N}]|\.[\p{L}\p{N}])|(?:[/\\]{2}|@|(?<![a-z0-9+.-])(?:https?|ftp|wss?):)[/\\]*\[[0-9a-f:.]*:[0-9a-f:.]*\]/u
/**
 * A stretch of name characters (letters, digits, marks, "-", "." and ANY, and symbols other than
 * ASCII's, which linkify-it reads in a host: "😀flown.to", "➡flown.app"): its dotted names are read
 * from it in one pass.
 */
const NAME_CHARS = /(?:[\p{L}\p{N}\p{M}.\-\ue000]|(?![\x00-\x7f])\p{S})+/gu

/** Each dotted name in `v` (labels of letters, digits, marks and "-"), with where it starts. Linear. */
function* namesIn(v: string): Generator<{ at: number; labels: string[] }> {
  for (const m of v.matchAll(NAME_CHARS)) {
    const parts = m[0].split('.')
    let pos = m.index
    for (let i = 0; i < parts.length; ) {
      let j = i
      if (parts[i]) while (j + 1 < parts.length && parts[j + 1]) j++
      if (j > i) yield { at: pos, labels: parts.slice(i, j + 1) }
      for (let k = i; k <= j; k++) pos += parts[k].length + 1
      i = j + 1
    }
  }
}

/** Whether `label` may be read as a top-level domain: it is one, or starts with one before a letter of another script ("comログイン"). */
function mayBeTld(label: string): boolean {
  if (isTopLevelDomain(label) || label.includes(ANY)) return true
  // With its marks off: X reads a decomposed "io" + U+0300 as "io".
  const bare = label.normalize('NFD').replace(/\p{M}/gu, '')
  if (bare !== label && mayBeTld(bare)) return true
  const ascii = /^[a-z0-9]+/.exec(label)?.[0]
  if (ascii) return ascii.length < label.length && !/[a-z0-9-]/.test(label[ascii.length]) && isTopLevelDomain(ascii)
  // A name in another script: any start of it (a top-level domain in Chinese or Russian, then more text).
  const chars = [...label]
  for (let k = 1; k < Math.min(chars.length, 24); k++) if (isTopLevelDomain(chars.slice(0, k).join(''))) return true
  return false
}

/** Two slashes as a browser reads them before a host: either may be "\\" ("\\/paypal-login.com"). */
const TWO_SLASHES = /[/\\]{2}/

/**
 * Whether `v` (a stretch as `view` reads it) holds what some site could link: a scheme, "www.", an IP
 * address after "//" or "@", or a dotted name whose labels after the first may be a top-level domain.
 * A name is not one where no site starts a link: right after "@" (an address's or a handle's domain,
 * when no "//" comes before it: "//me@evil.com" is evil.com's), after one "/" (a path: "src/main.rs"),
 * after "_" ("my_model.fit"), or after a "." that follows punctuation or nothing ("*.example.com",
 * "(.env.dev)", "(.co.uk)"). After "//", "\\/", "~", "$", "#" or the text of another script it is.
 * `written`: the stretch as written (but its case), in the same places as `v`, when `view` reads it
 * so: there an e-mail address's user name, as linkifiers read one (isMailAt), is no link either
 * ("anna.li@acme.de"; not after "//", nor after "：", which NFKC makes a ":" that may start a user name).
 */
function linkable(v: string, written?: string): boolean {
  if (SCHEME.test(v) || WWW.test(v) || NUMERIC_HOST.test(v)) return true
  for (const { at, labels } of namesIn(v)) {
    const before = v[at - 1] ?? ''
    if (before === '_' || (before === '@' && !TWO_SLASHES.test(v.slice(0, at)))) continue
    if (before === '/' && !/[/\\]/.test(v[at - 2] ?? '')) continue
    if (before === '.' && (at < 2 || /[\s\p{P}]/u.test(v[at - 2]))) continue
    const end = at + labels.join('.').length
    if (written && written[end] === '@' && !TWO_SLASHES.test(written.slice(0, at)) && isMailAt(written, end)) continue
    if (labels.slice(1).some(mayBeTld)) return true
  }
  return false
}

/** A character that goes on with a name: a letter, digit, mark, "_", "-", ANY, or a symbol other than ASCII's (NAME_CHARS). */
const LABEL = /[\p{L}\p{N}\p{M}_\-\ue000]|(?![\x00-\x7f])\p{S}/u
/** A letter or symbol of another script than ASCII's: after a name that ends in ASCII, it is no top-level domain's ("flown.app에서"). */
const OTHER_SCRIPT = /(?![\x00-\x7f])[\p{L}\p{S}]/u
/** The character (code point) of `s` that ends at `i`, and the one that starts there. */
const charBefore = (s: string, i: number): string => (i > 0 ? String.fromCodePoint(s.codePointAt(i >= 2 && /[\udc00-\udfff]/.test(s[i - 1]) ? i - 2 : i - 1) as number) : '')
const charAt = (s: string, i: number): string => (i < s.length ? String.fromCodePoint(s.codePointAt(i) as number) : '')
const MAIL_USER = /[a-z0-9._%+-]/
const SENTENCE_ENDS = /^[\p{P}]+|[\p{P}]+$/gu

/** `v` with every said link and address in it blanked, where it is not part of a longer name ("paypal-flown.app" is not "flown.app"). */
function withoutSaid(v: string, said: SaidLinks): string {
  let out = v
  const blank = (find: string, host: boolean, mail = false): void => {
    if (!find) return
    let from = 0
    for (let at = out.indexOf(find, from); at >= 0; at = out.indexOf(find, from)) {
      let start = at
      // With the scheme or "//" written before it, as the pack keeps one ("https://flown.app" is "flown.app").
      const scheme = /(?:https?:\/\/|\/\/)$/.exec(out.slice(Math.max(0, at - 8), at))?.[0] ?? ''
      start -= scheme.length
      const end = at + find.length
      const prev = charBefore(out, start)
      const next = charAt(out, end)
      // A name goes on with a letter, digit, "-" or a dot and a label (after a name that ends in ASCII, not with the
      // letters of another script, where every site ends it: "flown.app에서", "README.md를"; before a scheme, only with
      // a letter or digit: "👉https://flown.app"), and is a user name before "@" or a port and "@" ("https://flown.app@evil.com",
      // "flown.app:8443@3405803783"; "main.py:42" is main.py); a path or address may be followed by anything.
      const userName = host && (next === '@' || /^:\d{0,5}@/.test(out.slice(end, end + 8)))
      // Between the letters of a script other than Latin, or its symbols, a name in ASCII is read alone: X reads only the
      // ASCII, and linkify-it reads no top-level domain that goes on with such a letter ("在flown.app下载", "無料のflown.appで";
      // "éflown.appから" is a longer name to X). So is one after a Hebrew or Arabic prefix and "-" ("ב-flown.app"): no
      // label starts with "-", and a host that mixes the two directions opens nothing.
      const enclosed = host && /[a-z0-9]$/.test(find) && OTHER_SCRIPT.test(next) && /[^\P{L}\p{Script=Latin}]|(?![\x00-\x7f])\p{S}/u.test(prev)
      const rtlPrefix = host && prev === '-' && /[\p{Script=Hebrew}\p{Script=Arabic}]/u.test(charBefore(out, start - 1))
      const before = mail ? MAIL_USER.test(prev) : scheme ? /[\p{L}\p{N}\p{M}_-]/u.test(prev) : (LABEL.test(prev) && !enclosed && !rtlPrefix) || prev === '.'
      const after = host && ((LABEL.test(next) && !(/[a-z0-9]$/.test(find) && OTHER_SCRIPT.test(next))) || (next === '.' && LABEL.test(charAt(out, end + 1))))
      const longer = before || after || userName
      if (!longer) out = `${out.slice(0, start)}${' '.repeat(end - start)}${out.slice(end)}`
      from = end
    }
  }
  for (const mail of said.mails) blank(mail, true, true)
  for (const link of said.links) blank(link, !/[/?#]/.test(link))
  return out
}

/**
 * Where a site reads one link across spaces and line breaks: the value of an HTML attribute that takes
 * a URL (a browser drops the tabs and line breaks in it and reads a space before "@" as part of a user
 * name: '<a href="https://flown.app\n@paypal-login.com">', '<a href="//paypal-login.\ncom">',
 * '<a href="https://flown.app @paypal-login.com">'), and a Markdown link's destination in "<…>", whose
 * spaces markdown-it percent-encodes ("[here](<https://flown.app @paypal-login.com>)").
 */
const WHOLE_URL =
  /(?<![\p{L}\p{N}_.:-])(?:[a-z][\w.-]*:)?(?:href|src|srcset|action|formaction|data|poster|cite|background|ping|longdesc|codebase|lowsrc|dynsrc)\s*=\s*(?:"([^"]*)"|'([^']*)')|\](?:\(|:)\s*<([^<>\n]*)>/giu

/**
 * The stretches of `text` (between spaces, exactly as written, or a link written across spaces:
 * WHOLE_URL's) that some site could turn into a link that is not a said one, each once, in order:
 * notes to show, never changes. One is said when it is written as a stretch of what was said, or when
 * what is left of it without the said links and addresses links nothing.
 */
export function linksToCheck(text: string, said: SaidLinks): string[] {
  const found: { at: number; run: string }[] = []
  const shown = new Set<string>()
  const checked = new Set<string>()
  const check = (run: string, read: string, at: number): void => {
    if (!run || checked.has(read)) return
    checked.add(read)
    if (!shown.has(run) && isNoted(read, said)) {
      shown.add(run)
      found.push({ at, run })
    }
  }
  for (const m of text.matchAll(NOT_SPACE)) check(m[0], m[0], m.index)
  for (const m of text.matchAll(WHOLE_URL)) {
    const value = m[1] ?? m[2] ?? m[3] ?? ''
    // Read as a browser reads it: tabs and line breaks dropped, and a space before "@" part of a user name (a space
    // it keeps elsewhere is in a path, or makes the host fail: "paypal-login.\u00a0com", as the cleaning breaks one).
    const read = urlRead(value)
    if (read === value) continue
    const own = new Set(value.split(/\s+/u))
    for (const piece of read.split(/\s+/u)) if (!own.has(piece)) check(value.trim(), piece, m.index)
  }
  return found.sort((a, b) => a.at - b.at).map((f) => f.run)
}

/**
 * `value` as a browser reads it in a URL: tabs and line breaks dropped, and a space before an "@"
 * with no "/", "?", "#" or "\\" between them dropped (it is part of a user name, which the parser
 * percent-encodes: "https://flown.app%20@paypal-login.com" is paypal-login.com). Linear.
 */
function urlRead(value: string): string {
  const s = value.replace(/[\t\n\r]+/g, '')
  const kept: string[] = []
  let user = false
  for (let i = s.length - 1; i >= 0; i--) {
    const c = s[i]
    if (c === '@') user = true
    else if ('/?#\\'.includes(c)) user = false
    if (!(user && /\s/u.test(c))) kept.push(c)
  }
  return kept.reverse().join('')
}

/** Whether some reading of `run` links what was not said. */
function isNoted(run: string, said: SaidLinks): boolean {
  const lower = run.toLowerCase()
  return readingsOf(run).some((v) => {
    const written = v === lower ? v : undefined
    return linkable(v, written) && !said.runs.has(v.replace(SENTENCE_ENDS, '')) && linkable(withoutSaid(v, said), written)
  })
}

/**
 * The ways `run` may be read (view): with its controls dropped and as spaces (a control character is
 * dropped by one reader and a space to another; a caption stores it as one: "_\u0001evil.com"), with
 * Markdown's escapes decoded and as written (one site decodes them, another does not), and where a
 * space it decodes ("&#32;", "&nbsp;", "%20") comes before an "@", also as a URL reads it (urlRead).
 */
function readingsOf(run: string): string[] {
  const texts = /\p{Cc}/u.test(run) ? [run, run.replace(/\p{Cc}/gu, ' ')] : [run]
  const views = /[\\&]/.test(run) ? texts.flatMap((t) => [view(t), view(t, false)]) : texts.map((t) => view(t))
  return views.flatMap((v) => (v.includes('@') && /\s/u.test(v) ? [v, urlRead(v)] : [v]))
}

/** An e-mail address, as `view` reads it (its user name in ASCII, as linkifiers read one). */
const MAIL = /[a-z0-9._%+-]+@[\p{L}\p{N}\p{M}-]+(?:\.[\p{L}\p{N}\p{M}-]+)+/gu

/**
 * What the safety net counts as said for `segments` (the captions the pack is written from) and
 * `context` (the name and chapter titles the user typed): the pack's own said links (but those an AI
 * wrote into the captions: unsaidLinks), and the addresses and stretches of the captions no AI wrote
 * a link into, the name and the chapter titles.
 */
export function saidLinks(segments: readonly { text: string; aiLinks?: readonly string[] }[], context?: { title?: string; chapters?: string[] }): SaidLinks {
  const untrusted = new Set(unsaidLinks(segments, context))
  const links = [...saidKeys(trustedText(segments.map((s) => s.text).join(' '), context))].filter((k) => !untrusted.has(k)).map((k) => view(k))
  const plain = trustedText(segments.filter((s) => !s.aiLinks?.length).map((s) => s.text).join(' '), context)
  const runs = new Set<string>()
  const mails = new Set<string>()
  for (const run of plain.split(SPACE)) {
    const lower = run.toLowerCase()
    for (const v of readingsOf(run)) {
      if (!v || !linkable(v, v === lower ? v : undefined)) continue
      runs.add(v.replace(SENTENCE_ENDS, ''))
      for (const m of v.matchAll(MAIL)) mails.add(m[0].replace(/^[._%+-]+/, ''))
    }
  }
  return { links: [...new Set(links)].sort((a, b) => b.length - a.length), mails, runs }
}

/** How a stretch shows in a note: invisible characters as their code ("evil⟨U+200B⟩.com"), so nothing in it is hidden. */
export const shownRun = (run: string): string =>
  run.replace(INVISIBLE, (c) => `⟨U+${(c.codePointAt(0) as number).toString(16).toUpperCase().padStart(4, '0')}⟩`)
