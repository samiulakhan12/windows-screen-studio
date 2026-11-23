import { describe, expect, it } from 'vitest'
import { cleanLine, digitView, foldText, labelView, prefixView, rawSpan, urlView } from '../src/shared/privacy/detect/clean'
import { token } from './autoBlurRulesFixtures'

/* Auto-blur P3: cleaning a line, its views and folding (docs/design/auto-blur.md §6.2, tests 105-106). */

/** Every view has the cleaned text's length, and every cleaned character maps back into the raw text in order. */
function viewsHold(raw: string): void {
  const c = cleanLine(raw)
  for (const v of [c.digit, c.prefix, c.url, c.label]) expect(v.length, raw).toBe(c.text.length)
  expect(c.map.length).toBe(c.text.length + 1)
  expect(c.map[c.text.length]).toBe(raw.length)
  for (let i = 0; i < c.text.length; i++) {
    expect(c.map[i]).toBeGreaterThanOrEqual(0)
    expect(c.map[i]).toBeLessThan(raw.length)
    if (i) expect(c.map[i]).toBeGreaterThanOrEqual(c.map[i - 1])
  }
}

describe('auto-blur P3: cleaning', () => {
  it('105. cleanLine: NFKC, dashes, bullets, zero-width characters, θ and ø as 0 inside tokens, Cyrillic look-alikes; every view has the cleaned text’s length and maps back', () => {
    // NFKC: full-width letters and colons, ligatures.
    expect(cleanLine('ＡＰＩ：ｋｅｙ').text).toBe('API:key')
    expect(cleanLine('ﬁle').text).toBe('file')
    // Every dash as '-', bullet-like dots as '•'.
    expect(cleanLine('a‐b‑c‒d–e—f―g−h﹘i﹣j－k').text).toBe('a-b-c-d-e-f-g-h-i-j-k')
    expect(cleanLine('Password: ●●●●∙∙⦁⬤').text).toBe('Password: ••••••••')
    // Zero-width characters and the soft hyphen are removed, and the map skips them.
    const z = cleanLine('gh​p_­ab﻿c')
    expect(z.text).toBe('ghp_abc')
    expect([...z.map]).toEqual([0, 1, 3, 4, 6, 7, 9, 10])
    // Look-alikes become Latin only inside a token holding an ASCII letter or digit.
    expect(cleanLine('sk-proj-4θθ9Øa×1').text).toBe('sk-proj-4009' + '0ax1')
    expect(cleanLine('θ and ø alone').text).toBe('θ and ø alone')
    expect(cleanLine('АКIA5ТОКЕN').text).toBe('AKIA5TOKEN')
    expect(cleanLine('Москва').text).toBe('Москва')
    // Bangla: vowel signs compose with their letter; য় stays two code points (NFC's exclusion).
    expect(cleanLine('পাসওয়ার্ড').text).toBe('পাসওয়ার্ড'.normalize('NFC'))
    expect(cleanLine('য়').text).toBe('য়')
    // Views have the cleaned text's length; raw spans map back.
    for (const raw of ['ghp_AbC​def 1234 5678 9O12 34', 'ＰＡＳＳ：x', 'https://a.example/reset/abcdef ghijkl.', '৪৮২৯১৩ ﬁ', 'sk-proj-ab θ ø', '']) viewsHold(raw)
    const c = cleanLine('ＡＢ ghp_x')
    const [s, e] = rawSpan(c, 3, 8)
    expect('ＡＢ ghp_x'.slice(s, e)).toBe('ghp_x')
    // The digit view: Bengali and Devanagari digits as ASCII; look-alike letters in runs of digit groups with 6 or more real digits.
    expect(digitView('৪৮২৯১৩ and ४८२९')).toBe('482913 and 4829')
    expect(digitView('4917 6l23 4567 8904')).toBe('4917 6123 4567 8904')
    expect(digitView('Tel: +44 2O 7946 0958')).toBe('Tel: +44 20 7946 0958')
    expect(digitView('Ollie 123')).toBe('Ollie 123')
    expect(digitView('SO12 34')).toBe('SO12 34')
    // The prefix view: a known prefix read with confusions, when 8 token characters follow.
    const tail = token('«a12»')
    expect(prefixView('x0xb-' + tail)).toBe('xoxb-' + tail)
    expect(prefixView('AK1A' + tail.toUpperCase())).toBe('AKIA' + tail.toUpperCase())
    expect(prefixView('Alza' + tail)).toBe('AIza' + tail)
    expect(prefixView('ghp ' + tail)).toBe('ghp_' + tail)
    expect(prefixView('x0xb- short')).toBe('x0xb- short')
    // The URL view: a single space between two runs of 6 token characters inside a link reads as one token.
    expect(urlView('https://a.b/reset/abcdef ghijkl next')).toBe('https://a.b/reset/abcdeffghijkl next')
    expect(urlView('see abcdef ghijkl')).toBe('see abcdef ghijkl')
    // The label view: digits inside words read as letters.
    expect(labelView('SLACK_B0T_T0KEN PASSW0RD 1234 x1')).toBe('SLACK_BOT_TOKEN PASSWORD 1234 x1')
  })

  it('106. foldText folds O/0, I/l/1, rn/m, vv/w, cl/d and drops spaces and _', () => {
    expect(foldText('O0')).toBe('oo')
    expect(foldText('Il1|!')).toBe('lllll')
    expect(foldText('rn')).toBe(foldText('m'))
    expect(foldText('vv')).toBe(foldText('w'))
    expect(foldText('cl')).toBe(foldText('d'))
    expect(foldText('5S8B')).toBe('ssbb')
    expect(foldText('ghp_ ABC def')).toBe('ghpabcdef')
    expect(foldText('ＡＢＣ')).toBe('abc')
    // Two reads of one key that differ only by OCR confusions fold the same.
    expect(foldText('sk_live_0Il1 rn')).toBe(foldText('sk live oIIl m'))
  })
})
