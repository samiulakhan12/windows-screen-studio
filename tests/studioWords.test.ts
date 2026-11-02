import { describe, expect, it } from 'vitest'
import { mainScript, prefixDrawsSame, scriptOf, scriptsIn, studioTokens, studioWords, withDigits } from '../src/shared/captions/words'
import type { CaptionSegment } from '../src/shared/types'

/* Test 6 (docs/design/captions-studio.md §16.1): one splitter for every word of a caption, and their times (§8.1). */

const seg = (text: string, extra: Partial<CaptionSegment> = {}): CaptionSegment => ({ id: 'c1', start: 0, end: 2, text, ...extra })

describe('studioWords (§8.1)', () => {
  it('splits on white space and keeps punctuation with its word', () => {
    expect(studioWords('Hello,  world! (yes)')).toEqual([
      { text: 'Hello,', gap: false },
      { text: 'world!', gap: true },
      { text: '(yes)', gap: true }
    ])
  })

  it('splits Chinese without spaces with the Segmenter, without gaps', () => {
    const words = studioWords('我们今天学习', 'zh')
    expect(words.map((w) => w.text)).toEqual(['我们', '今天', '学习'])
    expect(words.every((w) => !w.gap)).toBe(true)
  })

  it('keeps punctuation with the word before it inside a piece split by the Segmenter', () => {
    expect(studioWords('我们今天学习。', 'zh').map((w) => w.text)).toEqual(['我们', '今天', '学习。'])
  })

  it('gives opening brackets and quotes to the word after them, so no word ends on one (§8.3)', () => {
    const ja = studioWords('彼は言いました。「ありがとう」と。', 'ja').map((w) => w.text)
    expect(ja.slice(-3)).toEqual(['した。', '「ありがとう」', 'と。'])
    const zh = studioWords('他说：“我们走吧。”', 'zh').map((w) => w.text)
    expect(zh).toContain('“我们')
    for (const w of [...ja, ...zh]) expect(w, w).not.toMatch(/[\p{Ps}\p{Pi}]$/u)
    // The words are as many as before, so marks and anchors keep their indexes; an opener with no word after stays on the last.
    expect(ja.length).toBe(7)
    expect(studioWords('今日は新機能「', 'ja').map((w) => w.text).at(-1)).toMatch(/「$/u)
  })

  it('has no gap inside 我们今天学习如何导出视频 or a Thai caption', () => {
    const zh = studioWords('我们今天学习如何导出视频', 'zh')
    expect(zh.length).toBeGreaterThan(3)
    expect(zh.some((w) => w.gap)).toBe(false)
    const th = studioWords('วันนี้เราจะเรียนรู้การส่งออก', 'th')
    expect(th.length).toBeGreaterThan(2)
    expect(th.some((w) => w.gap)).toBe(false)
  })
})

describe('studioTokens (§8.1)', () => {
  it('uses the provider word times when they match the words, clamped like captionTokens', () => {
    const t = studioTokens(
      seg('Make every word', {
        words: [
          { text: 'Make', start: 0.1, end: 0.4 },
          { text: 'every', start: 0.05, end: 0.9 },
          { text: 'word', start: 1.2, end: 5 }
        ]
      })
    )
    expect(t.map((x) => [x.start, x.end])).toEqual([
      [0.1, 0.4],
      [0.1, 0.9],
      [1.2, 2]
    ])
    expect(t.map((x) => x.word)).toEqual([0, 1, 2])
    expect(t.some((x) => x.estimated)).toBe(false)
    expect(t.map((x) => x.gap)).toEqual([false, true, true])
  })

  it('maps NW-09 Chinese words by concatenation when the Segmenter splits the text differently', () => {
    // A text-only answer: the provider's words, joined without spaces, are the caption's text.
    const s = seg('我们今天学习', {
      words: [
        { text: '我', start: 0, end: 0.2 },
        { text: '们今', start: 0.2, end: 0.6 },
        { text: '天学', start: 0.6, end: 1.1 },
        { text: '习', start: 1.1, end: 1.5 }
      ]
    })
    const t = studioTokens(s, 'zh')
    expect(t.map((x) => x.text)).toEqual(['我们', '今天', '学习'])
    expect(t.map((x) => [x.start, x.end])).toEqual([
      [0, 0.6],
      [0.2, 1.1],
      [0.6, 1.5]
    ])
    expect(t.some((x) => x.estimated)).toBe(false)
  })

  it('carries a provider guess as estimated when words are mapped by concatenation', () => {
    const t = studioTokens(seg('我们今天', { words: [{ text: '我们今天', start: 0, end: 1, estimated: true }] }), 'zh')
    expect(t.every((x) => x.estimated)).toBe(true)
  })

  it('spreads an edited caption by graphemes + 1 and marks every word estimated', () => {
    const t = studioTokens(seg('ab abcd', { words: [{ text: 'x', start: 0, end: 1 }] }))
    // Weights 3 and 5 of 8 over 2 s.
    expect(t[0].end).toBeCloseTo(0.75, 9)
    expect(t[1].start).toBeCloseTo(0.75, 9)
    expect(t[1].end).toBeCloseTo(2, 9)
    expect(t.every((x) => x.estimated)).toBe(true)
  })

  it('counts a Bengali conjunct as one grapheme when spreading', () => {
    // "ক্ষ" is three code points and one grapheme: weights 2 and 2.
    const t = studioTokens(seg('ক্ষ ক'))
    expect(t[0].end).toBeCloseTo(1, 9)
  })

  it('puts speaker labels first with word index -1, never estimated words of the caption', () => {
    const t = studioTokens(seg('Hello there', { speaker: 'Priya Das', words: [{ text: 'Hello', start: 0.2, end: 0.5 }, { text: 'there', start: 0.6, end: 1 }] }), 'en', true)
    expect(t.map((x) => x.text)).toEqual(['Priya', 'Das:', 'Hello', 'there'])
    expect(t.map((x) => x.word)).toEqual([-1, -1, 0, 1])
    expect(t[0].label).toBe(true)
    expect(t[2].label).toBeUndefined()
    expect(t.map((x) => x.gap)).toEqual([false, true, true, true])
    // Without the flag, no label.
    expect(studioTokens(seg('Hello there', { speaker: 'Priya' })).map((x) => x.word)).toEqual([0, 1])
  })

  it('gives each word its own direction and script', () => {
    const t = studioTokens(seg('مرحبا Flown 2 يا'))
    expect(t.map((x) => x.dir)).toEqual(['r', 'l', 'l', 'r'])
    expect(t.map((x) => x.script)).toEqual(['arabic', 'latin', 'other', 'arabic'])
    const bn = studioTokens(seg('আমরা আজ Flown শিখব'))
    expect(bn.map((x) => x.script)).toEqual(['bengali', 'bengali', 'latin', 'bengali'])
    expect(bn.every((x) => x.dir === 'l')).toBe(true)
  })

  it('a speaker name does not decide the direction of an Arabic caption', () => {
    const t = studioTokens(seg('مرحبا بكم', { speaker: 'You' }), 'ar', true)
    expect(t.slice(1).map((x) => x.dir)).toEqual(['r', 'r'])
  })
})

describe('scripts', () => {
  it('scriptOf names the script of the first letter; Bengali digits are Bengali, 0-9 have none', () => {
    expect(scriptOf('Hello')).toBe('latin')
    expect(scriptOf('«Привет»')).toBe('cyrillic')
    expect(scriptOf('১২৩')).toBe('bengali')
    expect(scriptOf('300%')).toBe('other')
    expect(scriptOf('ひらがな')).toBe('kana')
    expect(scriptOf('カタカナ')).toBe('kana')
    expect(scriptOf('한국어')).toBe('hangul')
    expect(scriptOf('中文')).toBe('han')
    expect(scriptOf('ไทย')).toBe('thai')
    expect(scriptOf('🔥')).toBe('other')
  })

  it('mainScript gives the script of most letters and its share', () => {
    expect(mainScript('আমরা আজ Flown শিখব').script).toBe('bengali')
    expect(mainScript('আমরা আজ Flown শিখব').share).toBeGreaterThan(0.5)
    expect(mainScript('Open Settings খুলুন')).toEqual({ script: 'latin', share: 12 / 17 })
    expect(mainScript('123 !')).toEqual({ script: 'other', share: 0 })
  })

  it('scriptsIn lists every script with a letter', () => {
    expect(scriptsIn(['Hello', 'আমরা', 'مرحبا 3'])).toEqual(new Set(['latin', 'bengali', 'arabic']))
  })

  it('prefixDrawsSame is true only where a prefix draws as in the word', () => {
    for (const s of ['latin', 'cyrillic', 'greek', 'han', 'kana', 'hangul'] as const) expect(prefixDrawsSame(s), s).toBe(true)
    for (const s of ['arabic', 'hebrew', 'bengali', 'devanagari', 'thai', 'tamil', 'telugu', 'other'] as const) expect(prefixDrawsSame(s), s).toBe(false)
  })
})

describe('the Digits choice (§0.2)', () => {
  it('writes Bangla digits or Western ones, digit for digit, and leaves text as written without a choice', () => {
    expect(withDigits('৩০০ টাকা, 2024', 'western', 'bn')).toBe('300 টাকা, 2024')
    expect(withDigits('300 টাকা, ২০২৪', 'native', 'bn')).toBe('৩০০ টাকা, ২০২৪')
    expect(withDigits('৩০০ and 300', undefined, 'bn')).toBe('৩০০ and 300')
    expect(withDigits('Step 3', 'native', 'en')).toBe('Step 3')
    expect(withDigits('٣ and 3', 'native', 'ar')).toBe('٣ and ٣')
    expect(withDigits('३', 'western', 'hi')).toBe('3')
  })

  it('never changes the number of words, so marks keep their indexes', () => {
    const text = 'আমরা ৩টি ধাপ দেখব ২০২৪ সালে'
    expect(studioWords(withDigits(text, 'western', 'bn')).length).toBe(studioWords(text).length)
  })
})
