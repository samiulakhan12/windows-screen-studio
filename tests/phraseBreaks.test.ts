import { describe, expect, it } from 'vitest'
import { breakPhrases, studioLayout, type StudioFace, type StudioLayout } from '../src/shared/captions/studioLayout'
import { STUDIO_BASE } from '../src/shared/captions/studioPresets'
import type { StudioToken } from '../src/shared/captions/words'
import type { CaptionSegment, CaptionStudio } from '../src/shared/types'

/* Test 7 (docs/design/captions-studio.md §16.1): line breaks at natural phrases (§8.3). */

const FACE: StudioFace = { stack: 'test', weight: 600, tracking: 0 }
/** Every Latin character 0.55 em wide, every CJK character 1 em. */
const measure = (text: string, px: number): number => [...text].reduce((s, ch) => s + (/[　-鿿＀-￯]/.test(ch) ? 1 : 0.55), 0) * px

function layout(text: string, studio: CaptionStudio = STUDIO_BASE, w = 1920, h = 1080, extra: Partial<CaptionSegment> = {}, language = 'en'): StudioLayout {
  const seg: CaptionSegment = { id: 'c', start: 0, end: 4, text, ...extra }
  return studioLayout(seg, studio, w, h, measure, { faceOf: () => FACE, language })
}

/** Lines as text, chunk by chunk. */
const linesOf = (l: StudioLayout): string[][] => l.chunks.map((c) => c.lines.map((line) => line.words.map((w) => w.text).join(' ')))
const allLines = (l: StudioLayout): string[] => linesOf(l).flat()

/** A Subtitle look with lines of at most `chars` characters. */
const subtitle = (chars: number): CaptionStudio => ({ ...STUDIO_BASE, layout: { ...STUDIO_BASE.layout, chars, tallChars: chars } })

const tok = (text: string, i: number, gap = true): StudioToken => ({ text, start: i * 0.3, end: i * 0.3 + 0.25, word: i, gap: i > 0 && gap, dir: 'l', script: 'latin' })

describe('phrase breaks (§8.3)', () => {
  it('"Click the Save button, then open the Export dialog" breaks after "button,"', () => {
    expect(linesOf(layout('Click the Save button, then open the Export dialog'))).toEqual([['Click the Save button,', 'then open the Export dialog']])
  })

  it('never ends a line in "the", and prefers to break before a join word', () => {
    for (const text of [
      'Now we drag the file into the upload box and wait',
      'Open the menu and choose the option you want to use',
      'You can find the setting under the Privacy tab of the app'
    ]) {
      const lines = allLines(layout(text, subtitle(30)))
      expect(lines.length, text).toBeGreaterThan(1)
      for (const line of lines.slice(0, -1)) expect(line.split(' ').pop(), `${text}: ${line}`).not.toBe('the')
    }
  })

  it('keeps "300 percent" and "Visual Studio Code" together', () => {
    for (const chars of [20, 22, 24, 26, 28, 30]) {
      const sales = allLines(layout('Our sales grew by 300 percent over the last two years of hard work', subtitle(chars)))
      expect(sales.some((l) => l.includes('300 percent')), `${chars}: ${sales.join(' | ')}`).toBe(true)
      const code = allLines(layout('Now open Visual Studio Code and start typing your code', subtitle(chars)))
      expect(code.some((l) => l.includes('Visual Studio Code')), `${chars}: ${code.join(' | ')}`).toBe(true)
    }
  })

  it('makes two-line chunks bottom-heavy: the top line is never wider by more than a tenth of the room', () => {
    // Captions without punctuation, join words or capitals: only the two-line rules choose.
    for (const text of ['sales grew hugely this year across every single team', 'ten people came over here today asking us many good questions', 'make sure you save everything before you close up shop']) {
      const l = layout(text, subtitle(36))
      expect(l.chunks.some((c) => c.lines.length === 2), text).toBe(true)
      for (const c of l.chunks) if (c.lines.length === 2) expect(c.lines[0].width - c.lines[1].width, text).toBeLessThanOrEqual(0.1 * 0.84 * 1920 + 1e-6)
    }
  })

  it('breaks at a sentence end before anywhere else', () => {
    expect(linesOf(layout('That is the first thing. Then we open the settings page', subtitle(34)))).toEqual([['That is the first thing.', 'Then we open the settings page']])
  })

  it('in Chinese and Japanese no line starts with 。 or 」 and none ends with 「', () => {
    // Words as a Segmenter could give them, punctuation on its own.
    const texts = ['我们', '今天', '「', '导出', '视频', '」', '。', '然后', '保存']
    const tokens = texts.map((t, i) => ({ ...tok(t, i, false), script: 'han' as const }))
    const widths = texts.map((t) => measure(t, 10))
    for (let room = 20; room <= 100; room += 10) {
      const chunks = breakPhrases(widths, tokens, room, 0, 2, 'zh')
      const starts = chunks.flat().map(([a]) => texts[a])
      const ends = chunks.flat().map(([, b]) => texts[b - 1])
      expect(starts.filter((s) => s === '。' || s === '」'), `room ${room}`).toEqual([])
      expect(ends.slice(0, -1).filter((s) => s === '「'), `room ${room}`).toEqual([])
      // Every word is laid out once, in order.
      expect(chunks.flat().map(([a, b]) => texts.slice(a, b).join('')).join('')).toBe(texts.join(''))
    }
  })

  it('counts no spaces in a line without gaps', () => {
    const texts = ['我们', '今天', '学习', '如何', '导出', '视频']
    const tokens = texts.map((t, i) => ({ ...tok(t, i, false), script: 'han' as const }))
    const widths = texts.map((t) => measure(t, 10))
    // 12 characters fit a 12-character limit only when no space is counted between the words.
    expect(breakPhrases(widths, tokens, 1000, 12, 2, 'zh')).toEqual([[[0, 6]]])
    expect(breakPhrases(widths, tokens, 1000, 11, 2, 'zh').flat().length).toBe(2)
    // With gaps, the spaces count.
    const spaced = texts.map((t, i) => tok(t, i))
    expect(breakPhrases(widths, spaced, 1000, 12, 2, 'zh').flat().length).toBe(2)
  })

  it('adds the width of a space only where the text has one', () => {
    const zh = layout('我们今天学习如何导出视频', STUDIO_BASE, 1920, 1080, {}, 'zh')
    const line = zh.chunks[0].lines[0]
    expect(line.words.length).toBeGreaterThan(3)
    for (let i = 1; i < line.words.length; i++) expect(line.words[i].x).toBeCloseTo(line.words[i - 1].x + line.words[i - 1].w, 9)
  })

  it('keeps the speaker name with the words after it and never breaks inside it', () => {
    const seg: CaptionSegment = { id: 'c', start: 0, end: 4, text: 'Hello there everyone and welcome to the show today', speaker: 'Priya Das' }
    const l = studioLayout(seg, subtitle(24), 1920, 1080, measure, { faceOf: () => FACE, language: 'en', showSpeaker: true })
    const first = l.chunks[0].lines[0].words.map((w) => w.text)
    expect(first.slice(0, 3)).toEqual(['Priya', 'Das:', 'Hello'])
  })

  it('in Bangla and Hindi no line starts with a postposition: it stays after its noun ("ঢাকা থেকে", "दिल्ली से")', () => {
    const post = new Set(['জন্য', 'থেকে', 'দিয়ে', 'সাথে', 'के', 'की', 'का', 'में', 'से', 'पर'])
    const cases: [string, string][] = [
      ['আমি সকালে ঢাকা থেকে চট্টগ্রামে এসেছি', 'bn'],
      ['তুমি আমার সাথে বাজারে চলো', 'bn'],
      ['আমরা আমাদের দলের সাথে প্রতি সপ্তাহে মিটিং করি', 'bn'],
      ['এই ফিচারটি নতুন ব্যবহারকারীদের জন্য খুবই দরকারি হবে', 'bn'],
      ['প্রথমে ফাইল মেনু থেকে নতুন প্রজেক্ট খুলুন', 'bn'],
      ['मैं कल दिल्ली से मुंबई गया था', 'hi'],
      ['इस ऐप से आप अपनी स्क्रीन रिकॉर्ड कर सकते हैं', 'hi']
    ]
    for (const [text, language] of cases)
      for (const [w, h] of [[1920, 1080], [1080, 1920]])
        for (const chars of [16, 20, 24, 28, 32]) {
          const lines = allLines(layout(text, subtitle(chars), w, h, {}, language))
          for (const line of lines) expect(post.has(line.split(' ')[0]), `${w}x${h} ${chars}: ${lines.join(' | ')}`).toBe(false)
        }
  })
})
