import { describe, expect, it } from 'vitest'
import { back, calmed, captionPoses, caretAt, circlePath, clipsKey, counterValue, EASE, emojiBob, flashSafeChunks, itemPose, listWindows, seedOf, spring, typewriterClip, type ChunkPose } from '../src/shared/captions/motion'
import { studioLayout, type StudioFace, type StudioLayout } from '../src/shared/captions/studioLayout'
import { STUDIO_BASE, studioPreset } from '../src/shared/captions/studioPresets'
import type { CaptionMotion, CaptionSegment, CaptionStudio, CaptionWord, Clip, CounterGraphic, ListGraphic } from '../src/shared/types'

/* Tests 12–17 and 60 (docs/design/captions-studio.md §16.1): the motion engine (§9), and the graphics' timing (§10.1). */

const FACE: StudioFace = { stack: 'test', weight: 600, tracking: 0 }
const measure = (text: string, px: number): number => [...text].length * 0.55 * px
const look = (id: string): CaptionStudio => structuredClone(studioPreset(id)!.look)
const U = 1080
const ONE: Clip[] = [{ id: 'a', start: 0, end: 100, speed: 1 }]

function timed(text: string, step = 0.3, start = 0, id = 'c1'): CaptionSegment {
  const words: CaptionWord[] = text.split(' ').map((w, i) => ({ text: w, start: start + i * step, end: start + i * step + step * 0.8 }))
  return { id, start, end: start + words.length * step, text, words }
}
const lay = (seg: CaptionSegment, studio: CaptionStudio, w = 1080, h = 1920, marks?: { from: number; to: number }[], language = 'en'): StudioLayout =>
  studioLayout(seg, studio, w, h, measure, { faceOf: () => FACE, marks, language })
const withMotion = (s: CaptionStudio, m: Partial<CaptionMotion>): CaptionStudio => ({ ...s, motion: { ...s.motion, ...m } })
const isRest = (p: ChunkPose): boolean => p.alpha === 1 && p.dx === 0 && p.dy === 0 && p.scale === 1 && p.scaleX === 1 && p.blur === 0 && p.reveal === 1

describe('easing (test 13)', () => {
  it('back(1.7) peaks at 1.10 near p = 0.58; spring(1) = 1; out(0.5) = 0.875', () => {
    let peak = 0
    let at = 0
    for (let p = 0; p <= 1; p += 0.001) {
      if (back(p, 1.7) > peak) {
        peak = back(p, 1.7)
        at = p
      }
    }
    expect(peak).toBeCloseTo(1.1, 2)
    expect(at).toBeCloseTo(0.58, 2)
    expect(back(0, 1.7)).toBeCloseTo(0, 9)
    expect(back(1, 1.7)).toBe(1)
    expect(spring(1)).toBe(1)
    expect(spring(0)).toBe(0)
    expect(Math.max(...Array.from({ length: 100 }, (_, i) => spring(i / 100)))).toBeGreaterThan(1)
    expect(EASE.out(0.5)).toBe(0.875)
    expect(EASE.outQuart(0.5)).toBe(0.9375)
    expect(EASE.inCubic(0.5)).toBe(0.125)
    expect(EASE.outExpo(1)).toBe(1)
    expect(EASE.emphDecel(0)).toBe(0)
    expect(EASE.emphAccel(1)).toBe(1)
  })
})

describe('seeds (test 17)', () => {
  it('FNV-1a values are stable', () => {
    expect(seedOf('')).toBe(0x811c9dc5)
    expect(seedOf('a')).toBe(0xe40c292c)
    expect(seedOf('foobar')).toBe(0xbf9cf968)
    expect(seedOf('c1|3')).toBe(seedOf('c1|3'))
    expect(clipsKey(ONE)).toBe(clipsKey([{ id: 'other', start: 0, end: 100, speed: 1 }]))
    expect(clipsKey(ONE)).not.toBe(clipsKey([{ id: 'a', start: 0, end: 100, speed: 2 }]))
  })

  it('a chunk keeps its tilt at every frame, and two chunks differ', () => {
    const s = look('comic')
    const l = lay(timed('one two three four five six seven eight'), s)
    const angles = [0.05, 0.3, 0.6].map((t) => captionPoses(l, 0, t, ONE, s, U, null).chunk.rotate)
    expect(new Set(angles).size).toBe(1)
    expect(Math.abs(angles[0])).toBeLessThanOrEqual(4)
    expect(angles[0]).not.toBe(0)
    expect(captionPoses(l, 1, l.chunks[1].start + 0.3, ONE, s, U, null).chunk.rotate).not.toBe(angles[0])
  })

  it("Stickers tilt each word by its place in the chunk, −4° and +3°, never by chance", () => {
    const s = look('stickers')
    const l = lay(timed('three easy steps'), s)
    const rot = captionPoses(l, 0, 0.1, ONE, s, U, null).words.map((w) => w.rotate)
    expect(rot).toEqual([-4, 3, -4])
    expect(captionPoses(l, 0, 0.1, ONE, withMotion(s, { calm: true }), U, null).words.map((w) => w.rotate)).toEqual([0, 0, 0])
  })

  it("the Circle look's path is fixed per word and differs between words", () => {
    const box = { x: 100, y: 50, w: 120, h: 40 }
    expect(circlePath(box, 3, 40)).toEqual(circlePath(box, 3, 40))
    expect(circlePath(box, 3, 40).points).not.toEqual(circlePath(box, 4, 40).points)
    const { points } = circlePath(box, 3, 40)
    expect(points.length).toBe(20)
    // It goes around the word: wider than the word on both sides.
    const xs = points.filter((_, i) => i % 2 === 0)
    expect(Math.min(...xs)).toBeLessThan(box.x)
    expect(Math.max(...xs)).toBeGreaterThan(box.x + box.w)
  })
})

describe('purity (test 12)', () => {
  const s = look('bold-pop')
  const l = lay(timed('make every word count today now', 0.25), s, 1080, 1920, [{ from: 1, to: 1 }])
  const times = Array.from({ length: 40 }, (_, i) => i * 0.04)
  const poseAt = (t: number): unknown => {
    const c = l.chunks.findIndex((ch) => t >= ch.start && t < ch.end)
    return c < 0 ? null : captionPoses(l, c, t, ONE, s, U, null)
  }

  it('gives the same poses for forward, backward and random seek orders', () => {
    const forward = new Map(times.map((t) => [t, JSON.stringify(poseAt(t))]))
    for (const t of [...times].reverse()) expect(JSON.stringify(poseAt(t)), `back ${t}`).toBe(forward.get(t))
    const shuffled = [...times].sort((a, b) => seedOf(String(a)) - seedOf(String(b)))
    for (const t of shuffled) expect(JSON.stringify(poseAt(t)), `random ${t}`).toBe(forward.get(t))
  })

  it('is at rest once the entrance is over, and words once their motion is over', () => {
    const at = l.chunks[0].start + 0.2
    const p = captionPoses(l, 0, at, ONE, s, U, null)
    expect(isRest(p.chunk)).toBe(true)
    const late = captionPoses(l, 0, l.chunks[0].end - 0.001, ONE, s, U, null)
    for (const w of late.words) expect([w.dx, w.dy, w.scale, w.alpha]).toEqual([0, 0, 1, 1])
  })

  it('keeps the minimum durations: 0.1 s for chunk motion even at double speed', () => {
    const fast = withMotion(STUDIO_BASE, { speed: 2 })
    const sl = lay(timed('make every word'), fast, 1920, 1080)
    // A 0.12 s fade at speed 2 would take 0.06 s: it takes 0.1 s.
    expect(captionPoses(sl, 0, 0.08, ONE, fast, U, null).chunk.alpha).toBeLessThan(1)
    expect(captionPoses(sl, 0, 0.1, ONE, fast, U, null).chunk.alpha).toBe(1)
  })

  it('runs in viewing time: on a 2× clip a 0.12 s fade takes 0.24 s of the recording', () => {
    const sl = lay(timed('make every word'), STUDIO_BASE, 1920, 1080)
    const fast: Clip[] = [{ id: 'a', start: 0, end: 100, speed: 2 }]
    expect(captionPoses(sl, 0, 0.12, fast, STUDIO_BASE, U, null).chunk.alpha).toBeLessThan(1)
    expect(captionPoses(sl, 0, 0.24, fast, STUDIO_BASE, U, null).chunk.alpha).toBe(1)
    expect(captionPoses(sl, 0, 0.12, ONE, STUDIO_BASE, U, null).chunk.alpha).toBe(1)
  })

  it('plays exits only before a pause of 0.25 s or more', () => {
    const sl = lay(timed('make every word'), STUDIO_BASE, 1920, 1080)
    const end = sl.chunks[sl.chunks.length - 1].end
    const last = sl.chunks.length - 1
    expect(captionPoses(sl, last, end - 0.02, ONE, STUDIO_BASE, U, end + 0.1).chunk.alpha).toBe(1)
    expect(captionPoses(sl, last, end - 0.02, ONE, STUDIO_BASE, U, end + 0.3).chunk.alpha).toBeLessThan(1)
    expect(captionPoses(sl, last, end - 0.02, ONE, STUDIO_BASE, U, null).chunk.alpha).toBeLessThan(1)
  })

  it('a change of one clip speed changes the flash merge, and the cache keys on the clips', () => {
    const one = look('one-word')
    const ol = lay(timed('go make every big word count today', 0.15), one)
    const big = (): number => 1e9
    const normal = flashSafeChunks(ol, ONE, 1080 * 1920, big)
    const slow = flashSafeChunks(ol, [{ id: 'a', start: 0, end: 100, speed: 0.25 }], 1080 * 1920, big)
    expect(normal.chunks.length).toBeLessThan(ol.chunks.length)
    expect(slow.chunks.length).toBe(ol.chunks.length)
    expect(clipsKey(ONE)).not.toBe(clipsKey([{ id: 'a', start: 0, end: 100, speed: 0.25 }]))
  })
})

describe('calm motion and strength 0 (test 14)', () => {
  const moving = (s: CaptionStudio): { scale: number[]; move: number[]; rotate: number[]; blur: number[] } => {
    const l = lay(timed('make every word count today now', 0.3), s, 1080, 1920, [{ from: 1, to: 1 }])
    const out = { scale: [] as number[], move: [] as number[], rotate: [] as number[], blur: [] as number[] }
    for (let t = 0; t < l.chunks[l.chunks.length - 1].end; t += 0.01) {
      const c = l.chunks.findIndex((ch) => t >= ch.start && t < ch.end)
      if (c < 0) continue
      const p = captionPoses(l, c, t, ONE, s, U, null)
      for (const q of [p.chunk, ...p.words]) {
        out.scale.push(q.scale, q.scaleX)
        out.move.push(Math.abs(q.dx), Math.abs(q.dy))
        out.rotate.push(Math.abs(q.rotate))
        out.blur.push(q.blur)
      }
    }
    return out
  }

  it('calm clamps every pose: scale 0.96–1.04, movement 0.015 u, no rotation, blur or overshoot', () => {
    for (const [id, word, emphasis] of [
      ['bold-pop', 'shake', 'blur'],
      ['comic', 'rise', 'slide'],
      ['one-word', 'bounce', 'pop'],
      ['stickers', 'slide', 'rise'],
      ['spotlight-word', 'pulse', 'shake']
    ] as const) {
      const s = withMotion(look(id), { calm: true, word, emphasis })
      const r = moving(s)
      expect(Math.min(...r.scale), id).toBeGreaterThanOrEqual(0.96)
      expect(Math.max(...r.scale), id).toBeLessThanOrEqual(1.04)
      expect(Math.max(...r.move), id).toBeLessThanOrEqual(0.015 * U + 1e-9)
      expect(Math.max(...r.rotate), id).toBe(0)
      expect(Math.max(...r.blur), id).toBe(0)
    }
    // Without calm, the same looks move more.
    const wild = moving(withMotion(look('bold-pop'), { enter: 'slam', word: 'bounce' }))
    expect(Math.max(...wild.move)).toBeGreaterThan(0.015 * U)
  })

  it('calmed turns pop, bounce, drop and slam into grow and blur into fade, and keeps typewriter, wipe and colour', () => {
    const c = calmed({ ...STUDIO_BASE.motion, enter: 'slam', exit: 'blur', word: 'bounce', emphasis: 'pop', tilt: 4, wordTilt: [-4, 3], spokenScale: 1.2 })
    expect(c).toMatchObject({ enter: 'grow', exit: 'fade', word: 'grow', emphasis: 'grow', tilt: 0, calm: true })
    expect(c.wordTilt).toBeUndefined()
    expect(c.spokenScale).toBeUndefined()
    expect(calmed({ ...STUDIO_BASE.motion, enter: 'blur', word: 'typewriter', emphasis: 'wipe' })).toMatchObject({ enter: 'fade', word: 'typewriter', emphasis: 'wipe' })
  })

  it('strength 0 leaves colour and fade only, within 0.12 s', () => {
    const s = withMotion(look('bold-pop'), { strength: 0, enter: 'slam', word: 'bounce', emphasis: 'pop' })
    const r = moving(s)
    expect(Math.max(...r.move)).toBe(0)
    expect(Math.min(...r.scale)).toBe(1)
    expect(Math.max(...r.scale)).toBe(1)
    expect(Math.max(...r.rotate)).toBe(0)
    const l = lay(timed('make every word'), s)
    expect(captionPoses(l, 0, 0.12, ONE, s, U, null).chunk.alpha).toBe(1)
  })
})

describe('the flash rule (test 15)', () => {
  it('Bold Pop at 6 words a second has no big chunk shorter than 0.34 s of viewing time', () => {
    const s = look('bold-pop')
    const seg = timed('Go. Now. Make. Every. Word. Count. Today. Yes. Do it now please.', 1 / 6)
    const l = lay(seg, s)
    expect(l.chunks.some((c) => c.end - c.start < 0.34)).toBe(true)
    const safe = flashSafeChunks(l, ONE, 1080 * 1920, () => 0.054 * 1080 * 1920)
    for (const c of safe.chunks) expect(c.end - c.start, `${c.first}-${c.last}`).toBeGreaterThanOrEqual(0.34 - 1e-9)
    // Every word is still shown once.
    expect(safe.chunks.flatMap((c) => c.lines.flatMap((line) => line.words.map((w) => w.token)))).toEqual(l.chunks.flatMap((c) => c.lines.flatMap((line) => line.words.map((w) => w.token))))
    // A small chunk is never merged.
    expect(flashSafeChunks(l, ONE, 1080 * 1920, () => 10).chunks).toBe(l.chunks)
    const quiet = lay(timed('a calm and slow caption here'), STUDIO_BASE, 1920, 1080)
    expect(flashSafeChunks(quiet, ONE, 1920 * 1080, () => 10)).toBe(quiet)
  })

  it("a big mark dwells 0.34 s; Highlight Box's small box is not limited", () => {
    const s = look('highlight-box')
    const seg = timed('one two three four five six', 0.1)
    const small = flashSafeChunks(lay(seg, s), ONE, 1080 * 1920, () => 10)
    expect(small.bigMark).toBeUndefined()
    const marks = (l: StudioLayout): number[] => [0.05, 0.15, 0.25].map((t) => captionPoses(l, 0, t, ONE, s, U, null).mark!.first)
    expect(marks(small)).toEqual([0, 1, 2])
    // The same box in a small frame is big: it stays on the first word for 0.34 s, covering the words said meanwhile.
    const big = flashSafeChunks(lay(seg, s), ONE, 200 * 300, () => 10)
    expect(big.bigMark).toBe(true)
    const p = captionPoses(big, 0, 0.25, ONE, s, U, null).mark!
    expect([p.first, p.last]).toEqual([0, 2])
  })
})

describe('right to left (test 16)', () => {
  it('a fill sweeps right to left for an Arabic word and left to right for an English word inside it', () => {
    const s = look('karaoke-fill')
    const l = lay(timed('مرحبا بكم في Flown اليوم'), s, 1920, 1080, undefined, 'ar')
    expect(l.rtl).toBe(true)
    expect(l.dirs).toEqual(['r', 'r', 'r', 'l', 'r'])
    const p = captionPoses(l, 0, 0.3 * 3 + 0.1, ONE, s, U, null)
    // The English word is being filled (P2 sweeps it from its left), the Arabic words before it are filled.
    expect(p.words[3].fill).toBeGreaterThan(0)
    expect(p.words[3].fill).toBeLessThan(1)
    expect(p.words[0].fill).toBe(1)
  })

  it('slide entrances come from the right, and a spoken box grows from the right edge of an Arabic word', () => {
    const s = withMotion(look('highlight-box'), { enter: 'slide' })
    const l = lay(timed('مرحبا بكم في البرنامج'), s, 1920, 1080, undefined, 'ar')
    expect(captionPoses(l, 0, 0.02, ONE, s, U, null).chunk.dx).toBeGreaterThan(0)
    const en = lay(timed('hello and welcome today'), s, 1920, 1080)
    expect(captionPoses(en, 0, 0.02, ONE, s, U, null).chunk.dx).toBeLessThan(0)
    const m = captionPoses(l, 0, 0.05, ONE, s, U, null).mark!
    const word = l.chunks[0].lines[0].words.find((w) => w.token === 0)!
    expect(m.x + m.w).toBeCloseTo(word.x + word.w, 6)
    expect(m.w).toBeLessThan(word.w)
  })
})

describe('typewriter (test 60)', () => {
  it('in Latin the clip lands on a measured prefix advance, so no letter is cut', () => {
    const adv = [10, 22, 30, 41]
    expect(typewriterClip({ graphemes: 4, prefixAdvances: adv, width: 41 }, 0)).toBe(0)
    expect(typewriterClip({ graphemes: 4, prefixAdvances: adv, width: 41 }, 2)).toBe(22)
    expect(typewriterClip({ graphemes: 4, prefixAdvances: adv, width: 41 }, 4)).toBe(41)
    expect(typewriterClip({ graphemes: 4, prefixAdvances: adv, width: 41 }, 9)).toBe(41)
  })

  it('in Arabic the clip is the width share', () => {
    expect(typewriterClip({ graphemes: 5, width: 100 }, 2)).toBe(40)
  })

  it('reveals whole graphemes over the word, and the caret blinks at 0.94 Hz after the last letter', () => {
    const s = look('typewriter')
    const l = lay(timed('make every word', 1), s, 1920, 1080)
    const w = (t: number): number => captionPoses(l, 0, t, ONE, s, U, null).words[0].reveal
    expect(w(-0.01 + 0.0001)).toBe(0)
    expect(w(0.05)).toBe(1 / 4)
    expect(w(0.1)).toBe(2 / 4)
    expect(w(0.5)).toBe(1)
    // Words not yet spoken are hidden.
    expect(captionPoses(l, 0, 0.5, ONE, s, U, null).words[1].reveal).toBe(0)
    const end = 2 + 4 * 0.045
    expect(caretAt(l, 0, 2.1, ONE)).toEqual({ token: 2, on: true })
    expect(caretAt(l, 0, end + 0.2, ONE)).toEqual({ token: 2, on: true })
    expect(caretAt(l, 0, end + 0.6, ONE)).toEqual({ token: 2, on: false })
    expect(caretAt(l, 0, end + 1.1, ONE)).toEqual({ token: 2, on: true })
  })
})

describe('spoken marks and word motion (§9.3)', () => {
  it('the spoken colour crossfades in over 0.06 s and back when the next word starts', () => {
    const s = look('bold-pop')
    const l = lay(timed('make every word'), s, 1920, 1080)
    const f = (t: number): number[] => captionPoses(l, 0, t, ONE, s, U, null).words.map((w) => w.fill)
    expect(f(0.03)[0]).toBeCloseTo(0.5, 9)
    expect(f(0.1)).toEqual([1, 0, 0])
    expect(f(0.33)[0]).toBeCloseTo(0.5, 9)
    expect(f(0.4)).toEqual([0, 1, 0])
  })

  it('a translated track shows no spoken mark and no word motion', () => {
    const s = look('bold-pop')
    const l = lay(timed('make every word'), s)
    const p = captionPoses(l, 0, 0.01, ONE, s, U, null, { spoken: false })
    for (const w of p.words) expect([w.fill, w.scale, w.alpha]).toEqual([0, 1, 1])
  })

  it('a word that grows while spoken grows to its size, at most ×1.14 in Bangla', () => {
    const s = look('spotlight-word')
    const l = lay(timed('the secret setting'), s)
    expect(captionPoses(l, 0, 0.35 + 0.25, ONE, s, U, null).words[1].scale).toBeCloseTo(1.28, 6)
    const bn = lay(timed('এক ক্লিকে সুন্দর'), s, 1080, 1920, undefined, 'bn')
    expect(captionPoses(bn, 0, 0.35 + 0.25, ONE, s, U, null).words[1].scale).toBeCloseTo(1.14, 6)
  })

  it('emphasis marks draw in from 0.06 s before the word', () => {
    const s = look('circle')
    const l = lay(timed('this is the only step'), s, 1920, 1080, [{ from: 3, to: 3 }])
    const m = (t: number): number => captionPoses(l, 0, t, ONE, s, U, null).words[3].mark
    expect(m(0.9 - 0.07)).toBe(0)
    expect(m(0.9 + 0.1)).toBeGreaterThan(0)
    expect(m(0.9 + 0.1)).toBeLessThan(1)
    expect(m(0.9 + 0.3)).toBe(1)
  })

  it('News Bar pushes the outgoing chunk out for 0.2 s and never after', () => {
    const s = look('news')
    const l = lay(timed('one two three four five six seven eight nine ten eleven twelve thirteen fourteen fifteen sixteen', 0.3), { ...s, layout: { ...s.layout, chars: 20 } }, 1920, 1080)
    expect(l.chunks.length).toBeGreaterThan(1)
    const start = l.chunks[1].start
    expect(captionPoses(l, 1, start + 0.1, ONE, s, U, null).out?.chunk).toBe(0)
    expect(captionPoses(l, 1, start + 0.21, ONE, s, U, null).out).toBeUndefined()
    expect(captionPoses(l, 0, 0.1, ONE, s, U, null).out).toBeUndefined()
  })

  it('Glass Pill’s pills never blink between chunks: the words enter, the pills keep their opacity and glide for 0.16 s', () => {
    const s = look('glass')
    const l = lay(timed('one two three four five six seven eight nine ten eleven twelve thirteen fourteen fifteen sixteen', 0.3), { ...s, layout: { ...s.layout, chars: 20 } }, 1920, 1080)
    expect(l.chunks.length).toBeGreaterThan(1)
    const start = l.chunks[1].start
    const at = captionPoses(l, 1, start, ONE, s, U, null)
    // The words grow in from alpha 0; the pills are already there, and start at the old chunk's width.
    expect(at.chunk.alpha).toBe(0)
    expect(at.box && isRest(at.box)).toBe(true)
    expect(at.out).toEqual({ chunk: 0, pose: expect.objectContaining({ alpha: 0, reveal: 1 }) })
    const mid = captionPoses(l, 1, start + 0.08, ONE, s, U, null)
    expect(mid.out!.pose.reveal).toBeGreaterThan(0)
    expect(mid.out!.pose.reveal).toBeLessThan(1)
    expect(mid.box!.alpha).toBe(1)
    expect(captionPoses(l, 1, start + 0.17, ONE, s, U, null).out).toBeUndefined()
    // The first chunk enters with its pill.
    expect(captionPoses(l, 0, 0, ONE, s, U, null).box).toBeUndefined()
  })
})

describe('graphics timing (§10.1)', () => {
  const pop = { kind: 'pop' as const, duration: 0.24, strength: 1 }
  const fade = { kind: 'fade' as const, duration: 0.18, strength: 1 }

  it('itemPose is null outside the item, at rest in the middle, and fades out at the end', () => {
    expect(itemPose(1, 3, 0.5, ONE, pop, fade, 100, false)).toBeNull()
    expect(itemPose(1, 3, 3, ONE, pop, fade, 100, false)).toBeNull()
    expect(isRest(itemPose(1, 3, 2, ONE, pop, fade, 100, false)!)).toBe(true)
    expect(itemPose(1, 3, 1.05, ONE, pop, fade, 100, false)!.scale).toBeLessThan(1)
    expect(itemPose(1, 3, 2.95, ONE, pop, fade, 100, false)!.alpha).toBeLessThan(1)
    // Calm: no overshoot.
    for (let t = 1; t < 1.3; t += 0.01) expect(itemPose(1, 3, t, ONE, pop, fade, 100, true)!.scale).toBeLessThanOrEqual(1.04)
  })

  it('a counter counts from `from` to `to` over its time, then holds', () => {
    const g = { kind: 'counter', id: 'g', start: 2, end: 6, from: 0, to: 300, countFor: 1.2 } as CounterGraphic
    expect(counterValue(g, 1, ONE)).toBe(0)
    expect(counterValue(g, 2.6, ONE)).toBeCloseTo(300 * 0.875, 6)
    expect(counterValue(g, 4, ONE)).toBe(300)
    // On a 2× clip the count takes 2.4 s of the recording.
    expect(counterValue(g, 3.2, [{ id: 'a', start: 0, end: 100, speed: 2 }])).toBeCloseTo(300 * 0.875, 6)
  })

  it('listWindows hides the card after 6 s without an item and shows it again 0.3 s before the next', () => {
    const g = { kind: 'list', id: 'l', start: 10, end: 30, items: [{ text: 'a', at: 10 }, { text: 'b', at: 12 }, { text: 'c', at: 25 }] } as ListGraphic
    expect(listWindows(g, ONE)).toEqual([
      { start: 10, end: 18 },
      { start: 24.7, end: 30 }
    ])
    expect(listWindows({ ...g, items: [{ text: 'a', at: 10 }] }, ONE)).toEqual([{ start: 10, end: 16 }])
  })

  it('an emoji bobs by a seed, and not at all with calm motion', () => {
    expect(emojiBob('e1', 0, 0.3, ONE, 100, 1, false)).toBe(emojiBob('e1', 0, 0.3, ONE, 100, 1, false))
    expect(Math.abs(emojiBob('e1', 0, 0.3, ONE, 100, 1, false))).toBeLessThanOrEqual(4)
    expect(emojiBob('e1', 0, 0.3, ONE, 100, 1, true)).toBe(0)
  })
})
