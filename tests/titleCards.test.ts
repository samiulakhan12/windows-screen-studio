import { describe, expect, it } from 'vitest'
import { exportFrameTimes } from '../src/shared/engine/timeline'
import { TITLE_FADE, TITLE_SAFE, titleLayout, titlePhase, titleShowTime, wrapText, type MeasureText } from '../src/shared/render/titleCards'
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

describe('titlePhase: fades in viewing time, across speed changes and cuts', () => {
  const FPS = 60
  /** Text opacity of `c` on every frame of a 60 fps export (what the preview draws at the same times). */
  const textOver = (c: TitleCard, clips: Clip[]): number[] => exportFrameTimes(clips, FPS).map((t) => titlePhase(c, t, clips)?.text ?? 0)
  /** The largest step a fade takes between two frames: its first one (easeOutCubic starts steepest). */
  const firstStep = 1 - (1 - 1 / (FPS * TITLE_FADE)) ** 3 + 1e-6

  /** Opacity rises to 1 and falls back to 0 (or stays), never stepping back or jumping. */
  function expectSmooth(text: number[]): void {
    const top = text.indexOf(1)
    expect(top, 'reaches full opacity').toBeGreaterThan(0)
    for (let i = 1; i < text.length; i++) {
      expect(Math.abs(text[i] - text[i - 1]), `frame ${i}: ${text[i - 1]} -> ${text[i]}`).toBeLessThanOrEqual(firstStep)
      if (i <= top) expect(text[i], `fades in without stepping back at frame ${i}`).toBeGreaterThanOrEqual(text[i - 1])
    }
    const last = text.lastIndexOf(1)
    for (let i = last + 1; i < text.length; i++) expect(text[i], `fades out without coming back at frame ${i}`).toBeLessThanOrEqual(text[i - 1])
  }

  /** Frames from the first shown to the first fully shown. */
  const fadeInFrames = (text: number[]): number => text.indexOf(1) - text.findIndex((v) => v > 0) + 1

  it('a speed change inside the fade-in neither steps back nor stretches it', () => {
    const fast = [clip(0, 10.2), clip(10.2, 30, 4)]
    const text = textOver(card({ start: 10, end: 20 }), fast)
    expectSmooth(text)
    expect(fadeInFrames(text)).toBe(Math.round(TITLE_FADE * FPS))
  })

  it('a lower third in a pause sped up by smart speed fades in and out once', () => {
    // Speed up silences 4x around a card over the pause, 0.25 s inside each end of it.
    const clips = [clip(0.75, 10.25), clip(10.25, 12.75, 4), clip(12.75, 29.25)]
    const text = textOver(card({ start: 10, end: 13, style: 'lower-third' }), clips)
    expectSmooth(text)
    const shown = text.filter((v) => v > 0).length
    // 0.25 + 2.5 / 4 + 0.25 s of viewing time.
    expect(Math.abs(shown - Math.round(1.125 * FPS))).toBeLessThanOrEqual(1)
  })

  it('a cut inside a fade continues it after the cut, and a card ending in a cut fades out before it', () => {
    // 4.1–6 s is cut, right after the card starts showing.
    const inCut = textOver(card({ start: 4, end: 9 }), [clip(0, 4.1), clip(6, 12)])
    expectSmooth(inCut)
    expect(fadeInFrames(inCut)).toBe(Math.round(TITLE_FADE * FPS))
    // The card ends at 7 s, in the cut 5–8 s: gone by the jump, not cut off at full opacity.
    const clips = [clip(0, 5), clip(8, 10)]
    const endsInCut = textOver(card({ start: 3, end: 7 }), clips)
    expectSmooth(endsInCut)
    const lastShown = endsInCut.length - 1 - [...endsInCut].reverse().findIndex((v) => v > 0)
    expect(endsInCut[lastShown]).toBeLessThan(firstStep)
    expect(exportFrameTimes(clips, FPS)[lastShown]).toBeLessThan(5)
    // A card starting in a cut fades in where it starts showing.
    expect(titlePhase(card({ start: 6, end: 9 }), 8, clips)).toEqual({ background: 0, text: 0, rise: 1 })
  })

  it('"show title" moves the playhead to where the card is fully shown, as drawn', () => {
    const cases: [TitleCard, Clip[]][] = [
      [card({ start: 10, end: 20 }), [clip(0, 10.2), clip(10.2, 30, 4)]],
      [card({ start: 4, end: 9 }), [clip(0, 4.1), clip(6, 12)]],
      [card({ start: 6, end: 9 }), [clip(0, 5), clip(8, 10)]],
      [card({ start: 2, end: 2.3 }), [clip(0, 10)]],
      [card(), []]
    ]
    for (const [c, clips] of cases) {
      const at = titleShowTime(c, 0, clips)
      const phase = titlePhase(c, at, clips)
      expect(phase?.text, `${JSON.stringify(c)} at ${at}`).toBeCloseTo(1, 2)
      // Already fully shown there: the playhead stays.
      expect(titleShowTime(c, at, clips)).toBe(at)
    }
    // Played at 4x right after the start, the fade-in ends 0.35 s of viewing time later: 1.4 s of recording.
    expect(titleShowTime(card({ start: 10, end: 20 }), 0, [clip(0, 10), clip(10, 30, 4)])).toBeCloseTo(10 + (TITLE_FADE + 0.01) * 4)
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
