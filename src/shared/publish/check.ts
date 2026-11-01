/**
 * The copy pack's safety net (docs/design/publish-pack.md §4.8). The link cleaning (text.ts) rewrites
 * an answer for every reading it knows; this never changes text. It reads each card paranoidly, as a
 * browser might read a host (characters it drops dropped, escapes decoded, NFKC, IDNA's dots as dots),
 * and returns every stretch some site could turn into a link that is not a said one, for the Publish
 * dialog to show as "Check this link before you post". A false alarm only shows a note. Pure.
 */
import { linkKeys, trustedText, unsaidLinks } from './text'
import { isTopLevelDomain } from './twitterText'

/** What was said, as the safety net compares it: the links the pack trusts, and the e-mail addresses said. */
export interface SaidLinks {
  /** The pack's said links (linkKeys of the transcript, name and chapter titles, but those an AI wrote into the captions), as `view` reads them. */
  links: readonly string[]
  /** E-mail addresses said (in captions no AI wrote a link into, the name or a chapter title), as `view` reads them. */
  mails: ReadonlySet<string>
  /** Stretches of what was said (between spaces) that the net would note, as `view` reads them: one written the same way needs no note. */
  runs: ReadonlySet<string>
}

/** Spaces that end every reading of a link (not U+FEFF or U+180E, which a linkifier reads into a host and a browser drops). */
const SPACE = /[\t\n\v\f\r \u00a0\u1680\u2000-\u200a\u2028\u2029\u202f\u205f\u3000]+/
/** What a browser drops from a host, or what shows nothing: controls, format characters, variation selectors, the combining grapheme joiner, Hangul fillers. */
const INVISIBLE = /[\p{Cc}\p{Cf}\u034f\u115f\u1160\u3164\uffa0\u180b-\u180f\ufe00-\ufe0f\u{e0100}-\u{e01ef}]/gu

/** `s` as a browser may read it in a host: invisible characters dropped, escapes decoded, NFKC, lower case, IDNA's dots ("。", "｡", "．") as ".". */
export function view(s: string): string {
  const decoded = s.replace(INVISIBLE, '').replace(/(?:%[0-9a-f]{2})+/gi, (m) => {
    try {
      return decodeURIComponent(m)
    } catch {
      return m.replace(/%([0-7][0-9a-f])/gi, (_e, h: string) => String.fromCharCode(parseInt(h, 16)))
    }
  })
  return decoded.normalize('NFKC').toLowerCase().replace(/[。｡．]/g, '.').replace(INVISIBLE, '')
}

/** A scheme a site links from ("https://", "ftp://", "javascript:"…). */
const SCHEME = /(?<![a-z0-9+.-])(?:[a-z][a-z0-9+.-]*:\/\/|(?:mailto|javascript|vbscript|data):)/
/** "www." starting a name. */
const WWW = /(?<![\p{L}\p{N}_-])www\d{0,3}\./u
/** An IP address as a browser reads a host after "//" or "@": a dotted quad (of decimal or hex parts), or one number (eight digits or more, or hex). */
const NUMERIC_HOST = /(?:\/\/|@)[/\\]*(?:\d{8,}|0x[0-9a-f]{6,}|(?:0x[0-9a-f]+|\d+)(?:\.(?:0x[0-9a-f]+|\d+)){3})(?![\p{L}\p{N}])/u
/** A stretch of name characters (letters, digits, marks, "-" and "."): its dotted names are read from it in one pass. */
const NAME_CHARS = /[\p{L}\p{N}\p{M}.-]+/gu

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
  if (isTopLevelDomain(label)) return true
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

/**
 * Whether `v` (a stretch as `view` reads it) holds what some site could link: a scheme, "www.", an IP
 * address after "//" or "@", or a dotted name whose labels after the first may be a top-level domain.
 * A name is not one where no site starts a link: right after "@" (an address's or a handle's domain,
 * when no "//" comes before it: "//me@evil.com" is evil.com's), after one "/" (a path: "src/main.rs"),
 * after "_" ("my_model.fit"), or after a "." that follows punctuation or nothing ("*.example.com",
 * "(.env.dev)", "(.co.uk)"). After "//", "~", "$", "#" or the text of another script it is.
 */
function linkable(v: string): boolean {
  if (SCHEME.test(v) || WWW.test(v) || NUMERIC_HOST.test(v)) return true
  for (const { at, labels } of namesIn(v)) {
    const before = v[at - 1] ?? ''
    if (before === '_' || (before === '@' && !v.slice(0, at).includes('//'))) continue
    if (before === '/' && v[at - 2] !== '/') continue
    if (before === '.' && (at < 2 || /[\s\p{P}]/u.test(v[at - 2]))) continue
    if (labels.slice(1).some(mayBeTld)) return true
  }
  return false
}

const LABEL = /[\p{L}\p{N}\p{M}_-]/u
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
      const prev = out[start - 1] ?? ''
      const next = out.slice(end, end + 2)
      // A name goes on with a letter, digit, "-" or a dot and a label, and is a user name before "@" or a port and "@"
      // ("https://flown.app@evil.com", "flown.app:8443@3405803783"); a path or address may be followed by anything.
      const userName = host && (next[0] === '@' || /^:\d/.test(next))
      const longer = (mail ? MAIL_USER.test(prev) : LABEL.test(prev) || prev === '.') || (host && (LABEL.test(next[0] ?? '') || (next[0] === '.' && LABEL.test(next[1] ?? '')))) || userName
      if (!longer) out = `${out.slice(0, start)}${' '.repeat(end - start)}${out.slice(end)}`
      from = end
    }
  }
  for (const mail of said.mails) blank(mail, true, true)
  for (const link of said.links) blank(link, !/[/?#]/.test(link))
  return out
}

/**
 * The stretches of `text` (between spaces, exactly as written) that some site could turn into a link
 * that is not a said one, each once, in order: notes to show, never changes. One is said when it is
 * written as a stretch of what was said, or when what is left of it without the said links and
 * addresses links nothing.
 */
export function linksToCheck(text: string, said: SaidLinks): string[] {
  const out: string[] = []
  for (const run of text.split(SPACE)) {
    if (!run || out.includes(run)) continue
    // A control character is dropped by one reader and a space to another (a caption stores it as one: "_\u0001evil.com").
    const views = /\p{Cc}/u.test(run) ? [view(run), view(run.replace(/\p{Cc}/gu, ' '))] : [view(run)]
    if (views.some((v) => linkable(v) && !said.runs.has(v.replace(SENTENCE_ENDS, '')) && linkable(withoutSaid(v, said)))) out.push(run)
  }
  return out
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
  const links = [...linkKeys(trustedText(segments.map((s) => s.text).join(' '), context))].filter((k) => !untrusted.has(k)).map(view)
  const plain = trustedText(segments.filter((s) => !s.aiLinks?.length).map((s) => s.text).join(' '), context)
  const runs = new Set<string>()
  const mails = new Set<string>()
  for (const run of plain.split(SPACE)) {
    const v = view(run)
    if (!v || !linkable(v)) continue
    runs.add(v.replace(SENTENCE_ENDS, ''))
    for (const m of v.matchAll(MAIL)) mails.add(m[0].replace(/^[._%+-]+/, ''))
  }
  return { links: [...new Set(links)].sort((a, b) => b.length - a.length), mails, runs }
}

/** How a stretch shows in a note: invisible characters as their code ("evil⟨U+200B⟩.com"), so nothing in it is hidden. */
export const shownRun = (run: string): string =>
  run.replace(INVISIBLE, (c) => `⟨U+${(c.codePointAt(0) as number).toString(16).toUpperCase().padStart(4, '0')}⟩`)
