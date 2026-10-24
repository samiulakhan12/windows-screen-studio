import { describe, expect, it } from 'vitest'
import { TITLE_FADE, TITLE_SAFE, titleLayout, titlePhase, wrapText, type MeasureText } from '../src/shared/render/titleCards'
import type { Clip, TitleCard } from '../src/shared/types'

const clip = (start: number, end: number, speed = 1): Clip => ({ id: `${start}`, start, end, speed })
/** Every character is half the font size wide (bold a little wider). */
const measure: MeasureText = (text, px, weight) => Array.from(text).length * px * (weight >= 700 ? 0.55 : 0.5)
const card = (over: Partial<TitleCard> = {}): TitleCard => ({ id: 't', start: 2, end: 5, title: 'Title', style: 'centered', background: 'blur', ...over })

describe('titlePhase: fade and rise', () => {
  const clips = [clip(0, 10)]

  it('is hidden outside the card (end exclusive)', () => {
    expect(titlePhase(card(), 1.99, clips)).toBeNull()
    expect(titlePhase(card(), 5, clips)).toBeNull()
  })

  it('fades and rises in, holds, then fades out drifting up', () => {
    const start = titlePhase(card(), 2, clips)!
    expect(start).toEqual({ background: 0, text: 0, rise: 1 })
    const mid = titlePhase(card(), 2 + TITLE_FADE / 2, clips)!
    expect(mid.text).toBeGreaterThan(0.5)
    expect(mid.text).toBeLessThan(1)
    expect(mid.rise).toBeCloseTo(1 - mid.text)
    expect(titlePhase(card(), 3.5, clips)).toEqual({ background: 1, text: 1, rise: 0 })
    const out = titlePhase(card(), 5 - TITLE_FADE / 4, clips)!
    expect(out.text).toBeLessThan(1)
    expect(out.rise).toBeLessThan(0)
    expect(out.background).toBe(out.text)
  })

  it('fades over more source time on a sped-up clip, and at most half of a short card', () => {
    const fast = [clip(0, 10, 2)]
    expect(titlePhase(card(), 2 + TITLE_FADE, fast)!.text).toBeLessThan(1)
    expect(titlePhase(card(), 2 + TITLE_FADE * 2, fast)!.text).toBe(1)
    const short = card({ start: 2, end: 2.4 })
    expect(titlePhase(short, 2.2, clips)!.text).toBeCloseTo(1)
  })

  it('a full-frame card opening the video shows its background from the first frame; one closing it stays', () => {
    const opening = titlePhase(card({ start: 0, end: 3 }), 0, clips)!
    expect(opening.background).toBe(1)
    expect(opening.text).toBe(0)
    // A trimmed start counts as the start of the video.
    expect(titlePhase(card({ start: 1, end: 3 }), 1, [clip(1, 10)])!.background).toBe(1)
    // A lower third fades in anyway.
    expect(titlePhase(card({ start: 0, end: 3, style: 'lower-third' }), 0, clips)!.background).toBe(0)
    expect(titlePhase(card({ start: 7, end: 10 }), 9.99, clips)).toEqual({ background: 1, text: 1, rise: 0 })
  })
})

describe('wrapText', () => {
  const width = (s: string): number => s.length * 10

  it('wraps words greedily and keeps line breaks', () => {
    expect(wrapText('one two three four', 90, width)).toEqual(['one two', 'three', 'four'])
    expect(wrapText('one\ntwo three', 200, width)).toEqual(['one', 'two three'])
    expect(wrapText('  spaced   out  ', 200, width)).toEqual(['spaced out'])
  })

  it('breaks a word longer than a line between letters', () => {
    expect(wrapText('abcdefghij xy', 40, width)).toEqual(['abcd', 'efgh', 'ij', 'xy'])
  })

  it('drops blank lines at the ends but keeps one in the middle', () => {
    expect(wrapText('\n\na\n\nb\n', 100, width)).toEqual(['a', '', 'b'])
    expect(wrapText('', 100, width)).toEqual([])
  })
})

describe('titleLayout', () => {
  const W = 1920
  const H = 1080

  it('sizes text relative to the frame, so a smaller preview wraps the same way', () => {
    const c = card({ title: 'Building a screen recorder from scratch', subtitle: 'Part one: capture' })
    const big = titleLayout(c, W, H, measure)
    const small = titleLayout(c, W / 2, H / 2, measure)
    expect(small.title.lines).toEqual(big.title.lines)
    expect(small.title.px).toBeCloseTo(big.title.px / 2)
    expect(big.subtitle?.lines).toEqual(['Part one: capture'])
    expect(big.band).toBeNull()
  })

  it('keeps long titles inside the safe area by wrapping, then shrinking, then ending with an ellipsis', () => {
    const long = card({ title: 'word '.repeat(80).trim() })
    const l = titleLayout(long, W, H, measure)
    expect(l.title.lines.length).toBeLessThanOrEqual(3)
    expect(l.title.px).toBeLessThan(0.085 * H)
    expect(Math.max(...l.title.widths)).toBeLessThanOrEqual(W * 0.78 + 1e-6)
    expect(l.title.lines[l.title.lines.length - 1].endsWith('…')).toBe(true)
    // A title that fits is not shrunk.
    expect(titleLayout(card({ title: 'Hi' }), W, H, measure).title.px).toBeCloseTo(0.085 * H)
  })

  it('makes the big style larger than centered', () => {
    expect(titleLayout(card({ style: 'big' }), W, H, measure).title.px).toBeGreaterThan(titleLayout(card(), W, H, measure).title.px * 1.5)
  })

  it('puts a lower third in a band at the bottom-left, inside the safe area', () => {
    const l = titleLayout(card({ style: 'lower-third', title: 'Jane Doe', subtitle: 'Product designer' }), W, H, measure)
    const b = l.band!
    const safe = TITLE_SAFE * H
    expect(b.x).toBeCloseTo(safe)
    expect(b.y + b.h).toBeCloseTo(H - safe)
    expect(b.y).toBeGreaterThan(H * 0.6)
    expect(b.w).toBeLessThan(W * 0.62 + 1e-6)
    expect(b.h).toBeCloseTo(l.height + b.padY * 2)
    // On a portrait frame it may use the whole width.
    const tall = titleLayout(card({ style: 'lower-third', title: 'word '.repeat(12) }), 1080, 1920, measure)
    expect(tall.band!.w).toBeGreaterThan(1080 * 0.62)
    expect(tall.band!.x + tall.band!.w).toBeLessThanOrEqual(1080 - TITLE_SAFE * 1080 + 1e-6)
  })

  it('handles a card with only a subtitle, or no text', () => {
    const onlySub = titleLayout(card({ title: '  ', subtitle: 'Just this' }), W, H, measure)
    expect(onlySub.title.lines).toEqual([])
    expect(onlySub.subtitle?.lines).toEqual(['Just this'])
    expect(onlySub.gap).toBe(0)
    const empty = titleLayout(card({ title: '', subtitle: '' }), W, H, measure)
    expect(empty.height).toBe(0)
    expect(empty.subtitle).toBeNull()
  })

  it('shrinks title and subtitle together when the block is too tall for the frame', () => {
    const l = titleLayout(card({ style: 'lower-third', title: 'word '.repeat(30), subtitle: 'more '.repeat(30) }), W, H, measure)
    expect(l.band!.h).toBeLessThanOrEqual(H * 0.3 + 1e-6)
  })
})
