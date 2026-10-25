import { describe, expect, it } from 'vitest'
import {
  CAPTION_FADE,
  CAPTION_MAX_WIDTH,
  captionAlpha,
  captionIndexAt,
  captionLayout,
  captionMetrics,
  captionTokens,
  chunkIndexAt,
  placeChunk,
  spokenToken,
  type MeasureText
} from '../src/shared/captions/layout'
import { retimeWords } from '../src/shared/captions/edit'
import { DEFAULT_CAPTIONS } from '../src/shared/captions/settings'
import type { CaptionSegment, CaptionSettings, Clip } from '../src/shared/types'

const clip = (start: number, end: number, speed = 1): Clip => ({ id: `${start}`, start, end, speed })
/** Every character is half the font size wide. */
const measure: MeasureText = (text, px) => Array.from(text).length * px * 0.5
const seg = (id: string, start: number, end: number, text: string, words?: CaptionSegment['words']): CaptionSegment => ({ id, start, end, text, ...(words && { words }) })
const settings = (over: Partial<CaptionSettings> = {}): CaptionSettings => ({ ...DEFAULT_CAPTIONS, ...over })
const lineTexts = (l: { words: { text: string }[] }): string => l.words.map((w) => w.text).join(' ')

describe('captionIndexAt', () => {
  const list = [seg('a', 1, 2, 'one'), seg('b', 2, 3, 'two'), seg('c', 5, 6, 'three')]
  it('finds the caption at t (start inclusive, end exclusive), or -1 in a gap', () => {
    expect(captionIndexAt(list, 0.5)).toBe(-1)
    expect(captionIndexAt(list, 1)).toBe(0)
    expect(captionIndexAt(list, 1.99)).toBe(0)
    expect(captionIndexAt(list, 2)).toBe(1)
    expect(captionIndexAt(list, 4)).toBe(-1)
    expect(captionIndexAt(list, 5.5)).toBe(2)
    expect(captionIndexAt(list, 6)).toBe(-1)
    expect(captionIndexAt([], 1)).toBe(-1)
  })
})

describe('captionTokens', () => {
  it('uses the word timings while the text has as many words', () => {
    const s = seg('a', 1, 3, 'hello big world', [
      { text: 'hello', start: 1, end: 1.4 },
      { text: 'big', start: 1.5, end: 1.9 },
      { text: 'world', start: 2.2, end: 2.9 }
    ])
    expect(captionTokens(s).map((t) => [t.text, t.start, t.end])).toEqual([
      ['hello', 1, 1.4],
      ['big', 1.5, 1.9],
      ['world', 2.2, 2.9]
    ])
  })

  it('spreads the words by length when the text was edited or there are no timings', () => {
    const edited = seg('a', 0, 2, 'ab abcdef', [{ text: 'x', start: 0, end: 2 }])
    const t = captionTokens(edited)
    expect(t.map((x) => x.text)).toEqual(['ab', 'abcdef'])
    expect(t[0].start).toBe(0)
    expect(t[0].end).toBeCloseTo(2 * (3 / 10))
    expect(t[1].start).toBeCloseTo(t[0].end)
    expect(t[1].end).toBeCloseTo(2)
  })

  it('keeps out-of-order timings inside the caption and in order', () => {
    const s = seg('a', 1, 2, 'a b', [
      { text: 'a', start: 1.5, end: 1.6 },
      { text: 'b', start: 0.5, end: 9 }
    ])
    const t = captionTokens(s)
    expect(t[1].start).toBeGreaterThanOrEqual(t[0].start)
    expect(t[1].end).toBeLessThanOrEqual(2)
  })
})

describe('captionLayout: line breaking and chunks', () => {
  const W = 1920
  const H = 1080

  it('keeps a short caption on one line, centred at the bottom inside the safe area', () => {
    const l = captionLayout(seg('a', 0, 2, 'Hello there'), settings(), W, H, measure)
    expect(l.chunks).toHaveLength(1)
    expect(l.chunks[0].lines.map(lineTexts)).toEqual(['Hello there'])
    const placed = placeChunk(l, l.chunks[0], 'bottom', W, H)
    expect(placed.lines[0].x).toBeCloseTo((W - l.chunks[0].lines[0].width) / 2)
    expect(placed.top + placed.height).toBeLessThan(H - 0.06 * H)
    const top = placeChunk(l, l.chunks[0], 'top', W, H)
    expect(top.top).toBeCloseTo(0.06 * H)
    const middle = placeChunk(l, l.chunks[0], 'middle', W, H)
    expect(middle.top + middle.height / 2).toBeCloseTo(H / 2)
  })

  it('breaks lines to fit the safe width and evens out two lines', () => {
    const text = 'one two three four five six seven eight nine ten eleven twelve'
    const s = settings({ size: 0.06 })
    const m = captionMetrics(s, W, H)
    const l = captionLayout(seg('a', 0, 4, text), s, W, H, measure)
    for (const ch of l.chunks) for (const line of ch.lines) expect(line.width).toBeLessThanOrEqual(m.maxWidth + 1e-6)
    expect(m.maxWidth).toBeLessThanOrEqual(W * CAPTION_MAX_WIDTH)
    // Two lines of similar width, not a full line and a lone word.
    const [a, b] = l.chunks[0].lines
    expect(Math.abs(a.width - b.width)).toBeLessThan(m.px * 3)
    expect(l.chunks.flatMap((c) => c.lines.map(lineTexts)).join(' ')).toBe(text)
  })

  it('shows a long caption as successive chunks of at most maxLines lines, timed by their first word', () => {
    const words = Array.from({ length: 40 }, (_, i) => `word${i}`)
    const timed = words.map((text, i) => ({ text, start: 10 + i * 0.25, end: 10 + i * 0.25 + 0.2 }))
    for (const maxLines of [1, 2] as const) {
      const l = captionLayout(seg('a', 10, 20, words.join(' '), timed), settings({ maxLines, size: 0.06 }), W, H, measure)
      expect(l.chunks.length).toBeGreaterThan(1)
      for (const ch of l.chunks) expect(ch.lines.length).toBeLessThanOrEqual(maxLines)
      expect(l.chunks[0].start).toBe(10)
      expect(l.chunks[l.chunks.length - 1].end).toBe(20)
      for (let i = 1; i < l.chunks.length; i++) {
        expect(l.chunks[i].start).toBeCloseTo(timed[l.chunks[i].first].start)
        expect(l.chunks[i - 1].end).toBeCloseTo(l.chunks[i].start)
        expect(l.chunks[i].first).toBe(l.chunks[i - 1].last + 1)
      }
      // Every word shown exactly once, in order.
      expect(l.chunks.flatMap((c) => c.lines.flatMap((x) => x.words.map((w) => w.text)))).toEqual(words)
      expect(chunkIndexAt(l, 10)).toBe(0)
      expect(chunkIndexAt(l, 19.99)).toBe(l.chunks.length - 1)
      const mid = l.chunks[1]
      expect(chunkIndexAt(l, mid.start)).toBe(1)
      expect(chunkIndexAt(l, mid.start - 0.01)).toBe(0)
    }
  })

  it('times chunks evenly without word timings', () => {
    const words = Array.from({ length: 30 }, () => 'abcd')
    const l = captionLayout(seg('a', 0, 30, words.join(' ')), settings({ maxLines: 1, size: 0.08 }), W, H, measure)
    expect(l.chunks.length).toBeGreaterThan(2)
    const lens = l.chunks.slice(0, -1).map((c) => c.end - c.start)
    for (const len of lens) expect(len).toBeCloseTo(lens[0], 5)
  })

  it('breaks a word wider than a line between letters', () => {
    const l = captionLayout(seg('a', 0, 2, 'x'.repeat(200)), settings(), W, H, measure)
    const pieces = l.chunks.flatMap((c) => c.lines.flatMap((x) => x.words))
    expect(pieces.length).toBeGreaterThan(1)
    expect(pieces.every((p) => p.token === 0)).toBe(true)
    expect(pieces.map((p) => p.text).join('')).toBe('x'.repeat(200))
  })

  it('wraps the same words on every frame size (preview and export agree)', () => {
    const text = 'The quick brown fox jumps over the lazy dog and keeps on running far away'
    const big = captionLayout(seg('a', 0, 5, text), settings(), 3840, 2160, measure)
    const small = captionLayout(seg('a', 0, 5, text), settings(), 960, 540, measure)
    expect(small.chunks.map((c) => c.lines.map(lineTexts))).toEqual(big.chunks.map((c) => c.lines.map(lineTexts)))
  })

  it('puts the bold preset in capitals', () => {
    const l = captionLayout(seg('a', 0, 2, 'Hello there'), settings({ preset: 'bold' }), W, H, measure)
    expect(lineTexts(l.chunks[0].lines[0])).toBe('HELLO THERE')
  })
})

describe('spokenToken: the karaoke word', () => {
  const s = seg('a', 1, 3, 'one two three', [
    { text: 'one', start: 1.1, end: 1.4 },
    { text: 'two', start: 1.6, end: 1.9 },
    { text: 'three', start: 2.2, end: 2.8 }
  ])
  const l = captionLayout(s, settings({ preset: 'karaoke' }), 1920, 1080, measure)
  const ch = l.chunks[0]

  it('is the last word that has started, lit until the next one starts', () => {
    expect(spokenToken(l, ch, 1.05)).toBe(-1)
    expect(spokenToken(l, ch, 1.1)).toBe(0)
    expect(spokenToken(l, ch, 1.5)).toBe(0)
    expect(spokenToken(l, ch, 1.6)).toBe(1)
    expect(spokenToken(l, ch, 2.5)).toBe(2)
    expect(spokenToken(l, ch, 2.95)).toBe(2)
  })
})

describe('captionAlpha: fades in viewing time', () => {
  const clips = [clip(0, 20)]

  it('fades in and out over CAPTION_FADE and is hidden outside', () => {
    const list = [seg('a', 2, 4, 'x')]
    expect(captionAlpha(list, 0, 1.9, clips)).toBe(0)
    expect(captionAlpha(list, 0, 2, clips)).toBe(0)
    expect(captionAlpha(list, 0, 2 + CAPTION_FADE / 2, clips)).toBeGreaterThan(0.5)
    expect(captionAlpha(list, 0, 2 + CAPTION_FADE / 2, clips)).toBeLessThan(1)
    expect(captionAlpha(list, 0, 3, clips)).toBe(1)
    expect(captionAlpha(list, 0, 4 - CAPTION_FADE / 2, clips)).toBeLessThan(1)
    expect(captionAlpha(list, 0, 4, clips)).toBe(0)
  })

  it('does not fade between captions that follow each other', () => {
    const list = [seg('a', 2, 4, 'x'), seg('b', 4.1, 6, 'y')]
    expect(captionAlpha(list, 0, 3.999, clips)).toBe(1)
    expect(captionAlpha(list, 1, 4.1, clips)).toBe(1)
  })

  it('measures the fade in output time: at 4x speed it lasts 4x the source time', () => {
    const fast = [clip(0, 20, 4)]
    const list = [seg('a', 2, 10, 'x')]
    // CAPTION_FADE / 2 of viewing time is 2 * CAPTION_FADE of source time at 4x.
    const a = captionAlpha(list, 0, 2 + 2 * CAPTION_FADE, fast)
    const b = captionAlpha(list, 0, 2 + CAPTION_FADE / 2, clips)
    expect(a).toBeCloseTo(b, 5)
  })

  it('a cut right after the start does not stretch the fade: it continues after the cut', () => {
    const cut = [clip(0, 2.05), clip(5, 20)]
    const list = [seg('a', 2, 8, 'x')]
    // 0.05 s shown before the cut, the rest of the fade right after it.
    const after = captionAlpha(list, 0, 5 + 0.01, cut)
    const plain = captionAlpha(list, 0, 2 + 0.06, clips)
    expect(after).toBeCloseTo(plain, 5)
  })
})

describe('captionLayout: every chunk shows (CAP-1)', () => {
  /** Checks that chunk starts increase, each chunk has time, and chunkIndexAt reaches each in turn. */
  const allShown = (layout: ReturnType<typeof captionLayout>, s: CaptionSegment): void => {
    expect(layout.chunks.length).toBeGreaterThan(1)
    expect(layout.chunks[0].start).toBe(s.start)
    layout.chunks.forEach((ch, i) => {
      expect(ch.end).toBeGreaterThan(ch.start)
      if (i) expect(ch.start).toBeGreaterThan(layout.chunks[i - 1].start)
      expect(chunkIndexAt(layout, (ch.start + ch.end) / 2)).toBe(i)
    })
    expect(chunkIndexAt(layout, s.start)).toBe(0)
    expect(chunkIndexAt(layout, s.end - 1e-3)).toBe(layout.chunks.length - 1)
  }
  // Chinese has no spaces: the whole caption is one word, broken over lines and chunks.
  const chinese = '我们今天来看一下如何在这个应用程序里面录制屏幕并且添加字幕然后把视频导出成为一个文件分享给大家使用'

  it('a caption without spaces, two lines at 9:16 and one line at 16:9, shows from its start to its end', () => {
    const s = seg('a', 10, 16, chinese)
    for (const [w, h, maxLines] of [[1080, 1920, 2], [1920, 1080, 1]] as const) {
      const layout = captionLayout(s, settings({ maxLines }), w, h, (text, px) => Array.from(text).length * px)
      expect(layout.tokens).toHaveLength(1)
      allShown(layout, s)
      // Chunks take time in proportion to their characters.
      const first = layout.chunks[0]
      const chars = first.lines.reduce((n, l) => n + l.words.reduce((k, wd) => k + wd.text.length, 0), 0)
      expect((first.end - first.start) / 6).toBeCloseTo(chars / (chinese.length + 1), 1)
    }
  })

  it('word timings that start chunks together still give each chunk its time', () => {
    const words = 'one two three four five six seven eight nine ten eleven twelve'.split(' ')
    // A provider gave the last eight words one start.
    const s = seg('a', 0, 8, words.join(' '), words.map((text, i) => ({ text, start: i < 4 ? i * 0.5 : 2, end: i < 4 ? i * 0.5 + 0.4 : 2.2 })))
    const layout = captionLayout(s, settings({ maxLines: 1, size: 0.2 }), 1920, 1080, measure)
    expect(layout.chunks.length).toBeGreaterThan(2)
    allShown(layout, s)
  })

  it('a caption trimmed on the track into its speech still shows each chunk for a moment', () => {
    const words = Array.from({ length: 28 }, (_, i) => `word${i}`)
    const s = seg('a', 0, 8, words.join(' '), words.map((text, i) => ({ text, start: (i * 8) / 28, end: ((i + 0.8) * 8) / 28 })))
    const look = settings({ maxLines: 1 })
    const whole = captionLayout(s, look, 1920, 1080, measure)
    expect(whole.chunks.length).toBeGreaterThan(2)
    // The end dragged in before the second chunk's first word, then before the last chunk's:
    // retimeWords clamps the words after it to the new end, where their chunks start.
    for (const end of [whole.chunks[1].start - 0.1, whole.chunks[whole.chunks.length - 1].start - 0.05]) {
      const trimmed = retimeWords(s, { start: 0, end })
      const layout = captionLayout(trimmed, look, 1920, 1080, measure)
      expect(layout.chunks).toHaveLength(whole.chunks.length)
      allShown(layout, trimmed)
      const minShow = Math.min(0.4, end / layout.chunks.length)
      for (const ch of layout.chunks) expect(ch.end - ch.start).toBeGreaterThanOrEqual(minShow - 1e-9)
    }
  })

  it('breaks a long word between letters as read, never between a Thai letter and its vowel mark', () => {
    const thai = 'สวัสดีครับวันนี้เราจะมาดูวิธีการบันทึกหน้าจอและการเพิ่มคำบรรยายให้กับวิดีโอของเรา'
    const layout = captionLayout(seg('a', 0, 6, thai), settings({ maxLines: 1 }), 1920, 1080, (text, px) => Array.from(text).length * px)
    const pieces = layout.chunks.flatMap((c) => c.lines.flatMap((l) => l.words.map((wd) => wd.text)))
    expect(pieces.length).toBeGreaterThan(1)
    expect(pieces.join('')).toBe(thai)
    // No piece starts with a combining mark (vowel signs and tone marks are \p{M}).
    for (const p of pieces) expect(/^\p{M}/u.test(p)).toBe(false)
  })
})

describe('captionLayout: right-to-left captions (CAP-2)', () => {
  it('an Arabic caption reads from the right: its first word is the rightmost', () => {
    const layout = captionLayout(seg('a', 0, 4, 'مرحبا بكم في البرنامج'), settings(), 1920, 1080, measure)
    expect(layout.rtl).toBe(true)
    const line = layout.chunks[0].lines[0]
    const xs = line.words.map((wd) => wd.x)
    expect(xs).toEqual([...xs].sort((a, b) => b - a))
    expect(xs[0] + line.words[0].w).toBeCloseTo(line.width, 6)
    expect(line.words[line.words.length - 1].x).toBeCloseTo(0, 6)
  })

  it('Hebrew too; English stays left to right, also when it starts with digits or punctuation', () => {
    expect(captionLayout(seg('a', 0, 4, 'שלום לכולם'), settings(), 1920, 1080, measure).rtl).toBe(true)
    const en = captionLayout(seg('a', 0, 4, '3, 2, 1 go now'), settings(), 1920, 1080, measure)
    expect(en.rtl).toBe(false)
    expect(en.chunks[0].lines[0].words[0].x).toBe(0)
    expect(captionLayout(seg('a', 0, 4, '«مرحبا» world'), settings(), 1920, 1080, measure).rtl).toBe(true)
  })

  /** The words of a one-line caption from left to right as shown (checking they sit side by side across the line). */
  const shown = (text: string): string[] => {
    const layout = captionLayout(seg('a', 0, 4, text), settings(), 1920, 1080, measure)
    expect(layout.chunks).toHaveLength(1)
    expect(layout.chunks[0].lines).toHaveLength(1)
    const line = layout.chunks[0].lines[0]
    const words = [...line.words].sort((a, b) => a.x - b.x)
    expect(words[0].x).toBeCloseTo(0, 6)
    expect(words[words.length - 1].x + words[words.length - 1].w).toBeCloseTo(line.width, 6)
    for (let i = 1; i < words.length; i++) expect(words[i].x).toBeCloseTo(words[i - 1].x + words[i - 1].w + measure(' ', layout.px, 0), 6)
    return words.map((wd) => wd.text)
  }

  it('a run of English words in an Arabic caption keeps its order, a number with it', () => {
    expect(shown('افتح Visual Studio Code الآن')).toEqual(['الآن', 'Visual', 'Studio', 'Code', 'افتح'])
    expect(shown('ثبت Windows 11 الآن')).toEqual(['الآن', 'Windows', '11', 'ثبت'])
    // A number between Arabic words reads with them, from the right.
    expect(shown('عندي 3 قطط')).toEqual(['قطط', '3', 'عندي'])
  })

  it('a run of Arabic words in an English caption reads from the right', () => {
    expect(shown('Welcome everyone مرحبا بكم')).toEqual(['Welcome', 'everyone', 'بكم', 'مرحبا'])
    expect(shown('Say مرحبا بكم to everyone')).toEqual(['Say', 'بكم', 'مرحبا', 'to', 'everyone'])
  })
})
