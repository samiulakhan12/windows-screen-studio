import { readFileSync } from 'node:fs'
import { describe, expect, it } from 'vitest'
import { X_COUNTRY_TLDS, X_GENERIC_TLDS } from '../src/shared/publish/tlds'
import {
  asciiDomainsIn,
  extractUrlsWithIndices,
  EXTRACT_URL,
  findUrls,
  INVALID_URL_WITHOUT_PROTOCOL_PRECEDING_CHARS,
  parseTweet,
  urlMatchesPlain,
  VALID_ASCII_DOMAIN,
  VALID_TCO_URL
} from '../src/shared/publish/twitterText'
import { TWEMOJI } from '../src/shared/publish/twemoji'

/** twitter-text 3.1.0's own answers (scripts/build-link-oracle.mjs, from the integrity-checked packages). */
interface Fixture {
  packages: Record<string, string>
  patterns: Record<string, [string, string]>
  cases: { text: string; urls: [string, number, number][]; weighted: number }[]
}
const fixture = JSON.parse(readFileSync(new URL('./fixtures/x-links.json', import.meta.url), 'utf8')) as Fixture

/** mulberry32: the same strings on every run. */
function random(seed: number): () => number {
  let a = seed >>> 0
  return () => {
    a = (a + 0x6d2b79f5) >>> 0
    let t = a
    t = Math.imul(t ^ (t >>> 15), t | 1)
    t ^= t + Math.imul(t ^ (t >>> 7), t | 61)
    return ((t ^ (t >>> 14)) >>> 0) / 4294967296
  }
}

describe("the port of twitter-text 3.1.0 (X's rules for links and length)", () => {
  it('builds the very same patterns as twitter-text 3.1.0 and twemoji-parser 11.0.2', () => {
    expect(fixture.packages['twitter-text']).toMatch(/^3\.1\.0 sha512-/)
    const ours: Record<string, RegExp> = {
      extractUrl: EXTRACT_URL,
      validAsciiDomain: VALID_ASCII_DOMAIN,
      validTcoUrl: VALID_TCO_URL,
      invalidUrlWithoutProtocolPrecedingChars: INVALID_URL_WITHOUT_PROTOCOL_PRECEDING_CHARS,
      twemoji: TWEMOJI
    }
    for (const [name, re] of Object.entries(ours)) expect([re.source, re.flags], name).toEqual(fixture.patterns[name])
  })

  it(`finds every link twitter-text finds, at the same indices, in all ${fixture.cases.length} texts of the fixture`, () => {
    expect(fixture.cases.length).toBeGreaterThan(5000)
    const wrong: string[] = []
    for (const c of fixture.cases) {
      const got = extractUrlsWithIndices(c.text).map((u) => [u.url, u.indices[0], u.indices[1]])
      if (JSON.stringify(got) !== JSON.stringify(c.urls)) wrong.push(`${JSON.stringify(c.text)}: ${JSON.stringify(got)} for ${JSON.stringify(c.urls)}`)
    }
    expect(wrong.slice(0, 10)).toEqual([])
  })

  it("counts every text as parseTweet's weighted length does", () => {
    const wrong = fixture.cases.filter((c) => parseTweet(c.text).weightedLength !== c.weighted).map((c) => `${JSON.stringify(c.text)}: ${parseTweet(c.text).weightedLength} for ${c.weighted}`)
    expect(wrong.slice(0, 10)).toEqual([])
  })

  it("finds the same matches in linear time as twitter-text's own loop (seeded random texts, short and long)", () => {
    const rnd = random(42)
    const atoms = ['a', 'b', 'Th', 'ủ', '.', '.', '.', 'com', 'co', 'uk', 'de', '日本', '在线', '嘉里', '大酒店', 'онлайн', '_', '-', 'x', '1', 'https://', 'HTTP://', '/', '?', ':', '#', '(', ')', ' ', 'ы', 'xn--p1ai', 'é', '\u0301', '\u212a', '\u017f', '@', '😀', '。', '\u200b']
    for (let k = 0; k < 4000; k++) {
      let s = ''
      const n = 1 + Math.floor(rnd() * (k % 10 === 0 ? 200 : 20))
      for (let i = 0; i < n; i++) s += atoms[Math.floor(rnd() * atoms.length)]
      expect(findUrls(s), s).toEqual(findUrls(s, false, urlMatchesPlain))
      expect(findUrls(s, true), s).toEqual(findUrls(s, true, urlMatchesPlain))
      const domain = s.replace(/[\s/?:#()@]/g, '')
      expect(asciiDomainsIn(domain), domain).toEqual(domain.match(VALID_ASCII_DOMAIN) ?? [])
    }
  })

  it('stays fast where twitter-text takes quadratic time: long Chinese or Japanese text with "." between words, and the worst runs of dots and names', () => {
    const ja = '今日は新しいエクスポート機能を紹介します設定を開いて保存を押すだけです'
    const texts = [
      `${ja}.`.repeat(1500),
      '日本.'.repeat(20_000),
      'a_b.com.'.repeat(7000),
      `${'a.'.repeat(2000)}日.com`,
      '.'.repeat(60_000),
      `https://a.com/${'('.repeat(5000)}${')'.repeat(5000)}`,
      `https://a.com/?${'a=b&'.repeat(10_000)}`
    ]
    for (const t of texts) {
      const start = performance.now()
      findUrls(t, true)
      parseTweet(t)
      expect(performance.now() - start, t.slice(0, 30)).toBeLessThan(400)
    }
  })

  it('has top-level domains that each start with a letter', () => {
    for (const tld of `${X_GENERIC_TLDS}|${X_COUNTRY_TLDS}`.split('|')) expect(/^\p{L}/u.test(tld), tld).toBe(true)
  })
})
