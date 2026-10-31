/*
 * Copyright 2018 Twitter, Inc.
 * Licensed under the Apache License, Version 2.0 (the "License"); you may not use this file except in
 * compliance with the License. You may obtain a copy of the License at
 * http://www.apache.org/licenses/LICENSE-2.0
 * Unless required by applicable law or agreed to in writing, software distributed under the License is
 * distributed on an "AS IS" BASIS, WITHOUT WARRANTIES OR CONDITIONS OF ANY KIND, either express or
 * implied. See the License for the specific language governing permissions and limitations under the
 * License.
 *
 * Changed for Flown: a TypeScript port of twitter-text 3.1.0's extractUrlsWithIndices (with
 * lib/idna.js and the src/regexp/ patterns it is built from) and of parseTweet's weighted length
 * (with lib/getCharacterWeight.js and configs.js version 3), in one module. The patterns are built
 * from the same pieces in the same order and compile to the same regular expressions. The punycode
 * package's toASCII is replaced by punycodeLength below, which gives the length of its result (RFC
 * 3492's encoder, counted). Added: urlMatches and asciiDomainsIn, which find the same matches as
 * twitter-text's loops over EXTRACT_URL and VALID_ASCII_DOMAIN in linear time, and the `lenient`
 * option of findUrls. See resources/notices/34-twitter-text.txt.
 */

/**
 * X's own rules for what it turns into a link and how it counts a post (docs/design/publish-pack.md
 * §4.4–4.5): `extractUrlsWithIndices` and `parseTweet` give exactly what twitter-text 3.1.0 gives,
 * which tests/fixtures/x-links.json (written from the package itself by
 * scripts/build-link-oracle.mjs) proves case by case. Pure.
 */
import { X_COUNTRY_TLDS, X_GENERIC_TLDS } from './tlds'
import { TWEMOJI } from './twemoji'

/* ---------- src/regexp/ ---------- */

const latinAccentChars =
  '\\xC0-\\xD6\\xD8-\\xF6\\xF8-\\xFF\\u0100-\\u024F\\u0253\\u0254\\u0256\\u0257\\u0259\\u025B\\u0263\\u0268\\u026F\\u0272\\u0289\\u028B\\u02BB\\u0300-\\u036F\\u1E00-\\u1EFF'
const cyrillicLettersAndMarks = '\\u0400-\\u04FF'
const directionalMarkersGroup = '\\u202A-\\u202E\\u061C\\u200E\\u200F\\u2066\\u2067\\u2068\\u2069'
const invalidCharsGroup = '\\uFFFE\\uFEFF\\uFFFF'
const punct = "\\!'#%&'\\(\\)*\\+,\\\\\\-\\.\\/:;<=>\\?@\\[\\]\\^_{|}~\\$"
const spacesGroup = '\\x09-\\x0D\\x20\\x85\\xA0\\u1680\\u180E\\u2000-\\u200A\\u2028\\u2029\\u202F\\u205F\\u3000'
// invalidDomainChars.js joins its pieces with stringSupplant, which writes each one as a RegExp
// literal, slashes included: they end up in the class too (a "/" was in it already).
const invalidDomainChars = `/${punct}//${spacesGroup}//${invalidCharsGroup}//${directionalMarkersGroup}/`
const validDomainChars = `[^${invalidDomainChars}]`
const validUrlPrecedingChars = `(?:[^A-Za-z0-9@＠$#＃${invalidCharsGroup}]|[${directionalMarkersGroup}]|^)`
const validSubdomain = `(?:(?:${validDomainChars}(?:[_-]|${validDomainChars})*)?${validDomainChars}\\.)`
const validDomainName = `(?:(?:${validDomainChars}(?:-|${validDomainChars})*)?${validDomainChars}\\.)`
const validGTLD = `(?:(?:${X_GENERIC_TLDS})(?=[^0-9a-zA-Z@+-]|$))`
const validCCTLD = `(?:(?:${X_COUNTRY_TLDS})(?=[^0-9a-zA-Z@+-]|$))`
const validPunycode = '(?:xn--[\\-0-9a-z]+)'
const validDomain = `(?:${validSubdomain}*${validDomainName}(?:${validGTLD}|${validCCTLD}|${validPunycode}))`
const validPortNumber = '[0-9]+'
const validGeneralUrlPathChars = `[a-z${cyrillicLettersAndMarks}0-9!\\*';:=\\+,\\.\\$\\/%#\\[\\]\\-\\u2013_~@\\|&${latinAccentChars}]`
// Up to two nested levels of balanced brackets ("/Primer_(film)", "/We_Up_(Album_Version_(Edited))/").
const validUrlBalancedParens =
  `\\((?:${validGeneralUrlPathChars}+|(?:${validGeneralUrlPathChars}*\\(${validGeneralUrlPathChars}+\\)${validGeneralUrlPathChars}*))\\)`
// A path does not end in a dot or a comma ("/foo." leaves the dot).
const validUrlPathEndingChars = `[\\+\\-a-z${cyrillicLettersAndMarks}0-9=_#\\/${latinAccentChars}]|(?:${validUrlBalancedParens})`
// "@" only in the middle ("http://example.com/@user/").
const validUrlPath =
  `(?:(?:${validGeneralUrlPathChars}*(?:${validUrlBalancedParens}${validGeneralUrlPathChars}*)*${validUrlPathEndingChars})|(?:@${validGeneralUrlPathChars}+/))`
const validUrlQueryChars = "[a-z0-9!?\\*'@\\(\\);:&=\\+\\$\\/%#\\[\\]\\-_\\.,~|]"
const validUrlQueryEndingChars = '[a-z0-9\\-_&=#\\/]'

/**
 * regexp/extractUrl.js: $2 the character before the link, $3 the link, $4 its scheme, $5 its domain,
 * $6 port, $7 path, $8 query. Not Unicode-aware, as in twitter-text: a character class matches one
 * UTF-16 unit and "i" folds only what toUpperCase folds within a unit (U+017F, the long s, and
 * U+212A, the Kelvin sign, are not "s" and "k").
 */
export const EXTRACT_URL = new RegExp(
  `((${validUrlPrecedingChars})((https?:\\/\\/)?(${validDomain})(?::(${validPortNumber}))?(\\/${validUrlPath}*)?(\\?${validUrlQueryChars}*${validUrlQueryEndingChars})?))`,
  'gi'
)
/** regexp/validAsciiDomain.js: the part of a domain X links without a scheme. */
export const VALID_ASCII_DOMAIN = new RegExp(`(?:(?:[\\-a-z0-9${latinAccentChars}]+)\\.)+(?:${validGTLD}|${validCCTLD}|${validPunycode})`, 'gi')
/** regexp/validTcoUrl.js. */
export const VALID_TCO_URL = new RegExp(`^https?:\\/\\/t\\.co\\/([a-z0-9]+)(?:\\?${validUrlQueryChars}*${validUrlQueryEndingChars})?`, 'i')
/** regexp/invalidUrlWithoutProtocolPrecedingChars.js: no link without a scheme after these. */
export const INVALID_URL_WITHOUT_PROTOCOL_PRECEDING_CHARS = /[-_.\/]$/

/* ---------- lib/idna.js (with the length of punycode 1.4.1's toASCII) ---------- */

const MAX_DOMAIN_LABEL_LENGTH = 63
const PUNYCODE_ENCODED_DOMAIN_PREFIX = 'xn--'

/** Characters RFC 3492's encoder writes for `input` (UTF-16 units read as punycode.js reads them); Infinity where punycode.js throws "overflow". */
function punycodeEncodedLength(input: string): number {
  const cps: number[] = []
  for (let i = 0; i < input.length; i++) {
    const c = input.charCodeAt(i)
    const d = i + 1 < input.length ? input.charCodeAt(i + 1) : -1
    if (c >= 0xd800 && c <= 0xdbff && d >= 0xdc00 && d <= 0xdfff) {
      cps.push(((c & 0x3ff) << 10) + (d & 0x3ff) + 0x10000)
      i++
    } else cps.push(c)
  }
  const maxInt = 2147483647
  const base = 36
  const tMin = 1
  const tMax = 26
  const adapt = (delta: number, numPoints: number, firstTime: boolean): number => {
    let k = 0
    delta = firstTime ? Math.floor(delta / 700) : delta >> 1
    delta += Math.floor(delta / numPoints)
    for (; delta > ((base - tMin) * tMax) >> 1; k += base) delta = Math.floor(delta / (base - tMin))
    return Math.floor(k + ((base - tMin + 1) * delta) / (delta + 38))
  }
  let length = 0
  for (const cp of cps) if (cp < 0x80) length++
  const basicLength = length
  let handled = basicLength
  if (basicLength) length++
  let n = 128
  let delta = 0
  let bias = 72
  while (handled < cps.length) {
    let m = maxInt
    for (const cp of cps) if (cp >= n && cp < m) m = cp
    const handledPlusOne = handled + 1
    if (m - n > Math.floor((maxInt - delta) / handledPlusOne)) return Infinity
    delta += (m - n) * handledPlusOne
    n = m
    for (const cp of cps) {
      if (cp < n && ++delta > maxInt) return Infinity
      if (cp === n) {
        let q = delta
        for (let k = base; ; k += base) {
          const t = k <= bias ? tMin : k >= bias + tMax ? tMax : k - bias
          if (q < t) break
          length++
          q = Math.floor((q - t) / (base - t))
        }
        length++
        bias = adapt(delta, handledPlusOne, handled === basicLength)
        delta = 0
        handled++
      }
    }
    delta++
    n++
  }
  return length
}

/** Length of punycode 1.4.1's toASCII(label): its dots (also "。", "．", "｡") kept, each part with non-ASCII "xn--" + encoded. */
function punycodeLength(label: string): number {
  const at = label.split('@')
  const prefix = at.length > 1 ? at[0].length + 1 : 0
  const parts = (at.length > 1 ? at[1] : label).replace(/[\x2E。．｡]/g, '.').split('.')
  let n = prefix + parts.length - 1
  for (const part of parts) n += /[^\x20-\x7E]/.test(part) ? PUNYCODE_ENCODED_DOMAIN_PREFIX.length + punycodeEncodedLength(part) : part.length
  return n
}

/** lib/idna.js toAscii: the domain when each label is 1–63 characters in punycode, else undefined. */
function toAscii(domain: string): string | undefined {
  if (domain.substring(0, 4) === PUNYCODE_ENCODED_DOMAIN_PREFIX && !asciiDomainsIn(domain).length) return undefined
  const labels = domain.split('.')
  for (const label of labels) {
    const n = punycodeLength(label)
    if (n < 1 || n > MAX_DOMAIN_LABEL_LENGTH) return undefined
  }
  return labels.join('.')
}

/* ---------- extractUrlsWithIndices.js ---------- */

const DEFAULT_PROTOCOL = 'https://'
const MAX_URL_LENGTH = 4096
const MAX_TCO_SLUG_LENGTH = 40

export interface UrlEntity {
  url: string
  /** Start and end (UTF-16 units) in the text. */
  indices: [number, number]
}

function isValidUrl(url: string, protocol: string, domain: string): boolean {
  let urlLength = url.length
  const punycodeEncodedDomain = toAscii(domain)
  if (!punycodeEncodedDomain || !punycodeEncodedDomain.length) return false
  urlLength = urlLength + punycodeEncodedDomain.length - domain.length
  return protocol.length + urlLength <= MAX_URL_LENGTH
}

/** One match of EXTRACT_URL: its groups, and where it ends. */
interface UrlMatch {
  before: string
  url: string
  protocol: string
  domain: string
  path: string
  end: number
}

/**
 * The matches of EXTRACT_URL in `text`, as `while (EXTRACT_URL.exec(text))` gives them: twitter-text's
 * own loop. Each attempt can read to the end of a run of domain characters, so this takes time
 * quadratic in such a run (Chinese or Japanese written with "." between words); `urlMatches` gives
 * the same faster. Kept to test that.
 */
export function urlMatchesPlain(text: string): UrlMatch[] {
  const out: UrlMatch[] = []
  EXTRACT_URL.lastIndex = 0
  let m: RegExpExecArray | null
  while ((m = EXTRACT_URL.exec(text))) out.push({ before: m[2] ?? '', url: m[3], protocol: m[4] ?? '', domain: m[5], path: m[7] ?? '', end: EXTRACT_URL.lastIndex })
  return out
}

/** EXTRACT_URL at one place (sticky), and its pieces: where a top-level domain is, a scheme, a domain character, a character a link may follow. */
const EXTRACT_URL_AT = new RegExp(EXTRACT_URL.source, 'iy')
const TLD_AT = new RegExp(`(?:${validGTLD}|${validCCTLD}|${validPunycode})`, 'iy')
const PROTOCOL_AT = /https?:\/\//iy
const DOMAIN_CHAR = new RegExp(`^${validDomainChars}$`, 'i')
const PRECEDING_CHAR = new RegExp(`^(?:[^A-Za-z0-9@＠$#＃${invalidCharsGroup}]|[${directionalMarkersGroup}])$`, 'i')
/** Per UTF-16 unit: 0 not yet known, 1 yes, 2 no. */
const domainCharCache = new Uint8Array(0x10000)
const precedingCharCache = new Uint8Array(0x10000)
const isDomainChar = (c: number): boolean => {
  if (!domainCharCache[c]) domainCharCache[c] = DOMAIN_CHAR.test(String.fromCharCode(c)) ? 1 : 2
  return domainCharCache[c] === 1
}
const isPrecedingChar = (c: number): boolean => {
  if (!precedingCharCache[c]) precedingCharCache[c] = PRECEDING_CHAR.test(String.fromCharCode(c)) ? 1 : 2
  return precedingCharCache[c] === 1
}

const ASCII_LABEL_CHAR = new RegExp(`^[\\-a-z0-9${latinAccentChars}]$`, 'i')
const asciiLabelCharCache = new Uint8Array(0x10000)
const isAsciiLabelChar = (c: number): boolean => {
  if (!asciiLabelCharCache[c]) asciiLabelCharCache[c] = ASCII_LABEL_CHAR.test(String.fromCharCode(c)) ? 1 : 2
  return asciiLabelCharCache[c] === 1
}

/** Where a top-level domain starts after each "." of `s`: the end of the one TLD_AT takes there, else -1. */
function tldEnds(s: string): Int32Array {
  const tldEnd = new Int32Array(s.length + 1).fill(-1)
  for (let j = s.indexOf('.'); j >= 0; j = s.indexOf('.', j + 1)) {
    TLD_AT.lastIndex = j + 1
    const m = TLD_AT.exec(s)
    if (m) tldEnd[j] = j + 1 + m[0].length
  }
  return tldEnd
}

/**
 * The matches of VALID_ASCII_DOMAIN in `domain`, as `domain.replace(VALID_ASCII_DOMAIN, …)` meets
 * them, in linear time: `(?:[-a-z0-9…]+\.)+` is greedy, so from each place the match ends at the
 * last "." of its run of names that a top-level domain follows; where there is none, it fails.
 */
export function asciiDomainsIn(domain: string): string[] {
  const n = domain.length
  const tldEnd = tldEnds(domain)
  const labelEnd = new Int32Array(n + 1)
  const far = new Int32Array(n + 1)
  labelEnd[n] = n
  far[n] = -1
  for (let i = n - 1; i >= 0; i--) {
    const label = isAsciiLabelChar(domain.charCodeAt(i))
    labelEnd[i] = label ? labelEnd[i + 1] : i
    const e = labelEnd[i]
    far[i] = label && e < n && domain.charCodeAt(e) === 0x2e ? (far[e + 1] >= 0 ? far[e + 1] : tldEnd[e] >= 0 ? e : -1) : -1
  }
  const out: string[] = []
  for (let i = 0; i < n; ) {
    if (far[i] < 0) {
      i++
      continue
    }
    const end = tldEnd[far[i]]
    out.push(domain.slice(i, end))
    i = end
  }
  return out
}

/**
 * The same matches as urlMatchesPlain, in linear time: EXTRACT_URL runs only where it matches.
 * validDomain is `subdomain* domainName TLD`, each name one or more domain characters (with "-", and
 * "_" in a subdomain, inside) and a ".", so from each place `far` says, right to left, which "." before
 * a top-level domain the greedy pattern ends its domain at (the last one it can reach), or that there
 * is none: an attempt there fails, and is skipped. Where the domain ends before a ":", "/" or "?",
 * EXTRACT_URL itself reads the port, path and query from that place; elsewhere the match ends with
 * the domain and is written directly. tests/publishLinks.test.ts checks this against urlMatchesPlain.
 */
function urlMatches(text: string): UrlMatch[] {
  const n = text.length
  const tldEnd = tldEnds(text)
  // labelEnd: the first unit from i that is not a domain character, "-" or "_".
  const labelEnd = new Int32Array(n + 1)
  const nextUnderscore = new Int32Array(n + 1)
  // far: the "." whose top-level domain a domain starting at i ends at, or -1.
  const far = new Int32Array(n + 1)
  labelEnd[n] = n
  nextUnderscore[n] = n
  far[n] = -1
  for (let i = n - 1; i >= 0; i--) {
    const c = text.charCodeAt(i)
    const domainChar = isDomainChar(c)
    labelEnd[i] = domainChar || c === 0x2d || c === 0x5f ? labelEnd[i + 1] : i
    nextUnderscore[i] = c === 0x5f ? i : nextUnderscore[i + 1]
    far[i] = -1
    const e = labelEnd[i]
    if (domainChar && e < n && text.charCodeAt(e) === 0x2e && isDomainChar(text.charCodeAt(e - 1))) {
      // A further "." through this name as a subdomain, else this one when the name can end a domain (no "_").
      far[i] = far[e + 1] >= 0 ? far[e + 1] : nextUnderscore[i] >= e && tldEnd[e] >= 0 ? e : -1
    }
  }
  /** The domain from q, after a scheme there or not: [scheme, where the domain starts, its "."]. */
  const domainAt = (q: number): [string, number, number] | null => {
    PROTOCOL_AT.lastIndex = q
    const scheme = PROTOCOL_AT.exec(text)
    if (scheme && far[q + scheme[0].length] >= 0) return [scheme[0], q + scheme[0].length, far[q + scheme[0].length]]
    return far[q] >= 0 ? ['', q, far[q]] : null
  }
  const out: UrlMatch[] = []
  let p = 0
  while (p < n) {
    // The preceding character's alternatives in order: a character, then the start of the text.
    let before = ''
    let start = p + 1
    let found = isPrecedingChar(text.charCodeAt(p)) ? domainAt(p + 1) : null
    if (found) before = text[p]
    else if (p === 0 && (found = domainAt(0))) start = 0
    if (!found) {
      p++
      continue
    }
    const [protocol, domainStart, dot] = found
    const end = tldEnd[dot]
    const next = text.charCodeAt(end)
    if (next === 0x3a || next === 0x2f || next === 0x3f) {
      EXTRACT_URL_AT.lastIndex = p
      const m = EXTRACT_URL_AT.exec(text)
      if (!m) {
        p++
        continue
      }
      out.push({ before: m[2] ?? '', url: m[3], protocol: m[4] ?? '', domain: m[5], path: m[7] ?? '', end: EXTRACT_URL_AT.lastIndex })
      p = EXTRACT_URL_AT.lastIndex
    } else {
      out.push({ before, url: text.slice(start, end), protocol, domain: text.slice(domainStart, end), path: '', end })
      p = end
    }
  }
  return out
}

/**
 * The links in `text` as twitter-text 3.1.0's extractUrlsWithIndices finds them (with links without
 * a scheme, its default). `lenient` (not in twitter-text) also gives what it matches but drops only
 * for its length (over 4 096 characters, a t.co name over 40) or, without a scheme, for having no
 * name in Latin letters ("госуслуги.рф"), which other sites may still link; the others are the
 * same. A domain no site can have (a label over 63 characters in punycode, a "xn--" one with other
 * letters) is no link either way.
 */
export function findUrls(text: string, lenient = false, matches = urlMatches): UrlEntity[] {
  if (!text || !text.match(/\./)) return []
  const urls: UrlEntity[] = []
  for (const m of matches(text)) {
    const { before, protocol, domain, path } = m
    let url = m.url
    let endPosition = m.end
    const startPosition = endPosition - url.length
    const valid = isValidUrl(url, protocol || DEFAULT_PROTOCOL, domain)
    // `lenient` keeps one that is too long, not one with a label no name can have.
    if (!valid && !(lenient && toAscii(domain))) continue
    if (!protocol) {
      // Only the domain's parts in Latin letters are linked without a scheme.
      if (before.match(INVALID_URL_WITHOUT_PROTOCOL_PRECEDING_CHARS)) continue
      let lastUrl: UrlEntity | null = null
      let asciiEndPosition = 0
      for (const asciiDomain of asciiDomainsIn(domain)) {
        // As twitter-text does: the first place the name appears from the last one's end.
        const asciiStartPosition = domain.indexOf(asciiDomain, asciiEndPosition)
        asciiEndPosition = asciiStartPosition + asciiDomain.length
        lastUrl = { url: asciiDomain, indices: [startPosition + asciiStartPosition, startPosition + asciiEndPosition] }
        urls.push(lastUrl)
      }
      const last = lastUrl as UrlEntity | null
      if (last == null) {
        // No Latin name in it ("госуслуги.рф"): X does not link it, other sites may.
        if (lenient && valid) urls.push({ url: path ? url : domain, indices: [startPosition, path ? endPosition : startPosition + domain.length] })
        continue
      }
      // Only the last name gets the port, path and query.
      if (path) {
        last.url = url.replace(domain, last.url)
        last.indices[1] = endPosition
      }
    } else {
      // A t.co link takes no more path.
      const tco = url.match(VALID_TCO_URL)
      if (tco) {
        if (tco[1] && tco[1].length > MAX_TCO_SLUG_LENGTH) {
          if (!lenient) continue
        } else {
          url = tco[0]
          endPosition = startPosition + url.length
        }
      }
      urls.push({ url, indices: [startPosition, endPosition] })
    }
  }
  return urls
}

/** twitter-text 3.1.0's extractUrlsWithIndices(text): what X links in `text`. */
export const extractUrlsWithIndices = (text: string): UrlEntity[] => findUrls(text, false)

/* ---------- parseTweet.js (weighted length, configs.js version 3) ---------- */

/** configs.js version 3. */
export const X_CONFIG = {
  maxWeightedTweetLength: 280,
  scale: 100,
  defaultWeight: 200,
  transformedURLLength: 23,
  ranges: [
    { start: 0, end: 4351, weight: 100 },
    { start: 8192, end: 8205, weight: 100 },
    { start: 8208, end: 8223, weight: 100 },
    { start: 8242, end: 8247, weight: 100 }
  ]
} as const

/** lib/getCharacterWeight.js, for one UTF-16 unit (NaN, past the end: the default). */
function characterWeight(code: number): number {
  for (const r of X_CONFIG.ranges) if (code >= r.start && code <= r.end) return r.weight
  return X_CONFIG.defaultWeight
}

/** twemoji-parser 11.0.2's parse: the emoji of `text` with their start and text. */
function emojiIn(text: string): { start: number; text: string }[] {
  const out: { start: number; text: string }[] = []
  TWEMOJI.lastIndex = 0
  let m: RegExpExecArray | null
  while ((m = TWEMOJI.exec(text))) out.push({ start: m.index, text: m[0] })
  return out
}

const isSurrogatePair = (text: string, i: number): boolean => {
  if (i < text.length - 1) {
    const c = text.charCodeAt(i)
    const next = text.charCodeAt(i + 1)
    return c >= 0xd800 && c <= 0xdbff && next >= 0xdc00 && next <= 0xdfff
  }
  return false
}

/**
 * twitter-text 3.1.0's parseTweet(text).weightedLength: X's count of a post, on its NFC form. A link
 * counts 23, an emoji (twemoji-parser's) 2, a UTF-16 unit in U+0000–U+10FF, U+2000–U+200D,
 * U+2010–U+201F or U+2032–U+2037 1, any other character 2 (a surrogate pair once).
 */
export function parseTweet(text: string): { weightedLength: number } {
  const normalized = text.normalize()
  const urlAt = new Map<number, UrlEntity>()
  for (const u of extractUrlsWithIndices(normalized)) urlAt.set(u.indices[0], u)
  const emojiAt = new Map<number, { start: number; text: string }>()
  for (const e of emojiIn(normalized)) emojiAt.set(e.start, e)
  let weighted = 0
  for (let i = 0; i < normalized.length; i++) {
    const url = urlAt.get(i)
    const emoji = url ? undefined : emojiAt.get(i)
    if (url) {
      weighted += X_CONFIG.transformedURLLength * X_CONFIG.scale
      i += url.url.length - 1
    } else if (emoji) {
      weighted += X_CONFIG.defaultWeight
      i += emoji.text.length - 1
    } else {
      i += isSurrogatePair(normalized, i) ? 1 : 0
      weighted += characterWeight(normalized.charAt(i).charCodeAt(0))
    }
  }
  return { weightedLength: weighted / X_CONFIG.scale }
}

/** Where the emoji twemoji-parser finds in `text` start and end (UTF-16 units). */
export const emojiSpans = (text: string): [number, number][] => emojiIn(text).map((e) => [e.start, e.start + e.text.length])
