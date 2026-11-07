import { describe, expect, it } from 'vitest'
import { EASE, itemPose } from '../src/shared/captions/motion'
import { contrastRatio } from '../src/shared/captions/colors'
import { createProject } from '../src/shared/engine/project'
import {
  badgeBox,
  badgeLabels,
  badgeNumber,
  badgeTextColor,
  bubbleBody,
  bubbleLineHeight,
  bubbleOutlined,
  bubbleTail,
  CALLOUT_DEFAULTS,
  calloutItemOf,
  calloutPose,
  ellipsePerimeter,
  graphemes,
  rectPerimeter,
  withDefaultMotion,
  wrapCallout
} from '../src/shared/render/callouts'
import { ITEM_MOTIONS } from '../src/shared/editor/groupEdit'
import { createShape } from '../src/shared/editor/shapes'
import type { Annotation, CalloutMotion, Clip, ItemMotion, Project } from '../src/shared/types'

/*
 * Animated callouts' pure parts (docs/design/editing-polish.md §7, §19.1 tests 36, 38, 40, 41):
 * the motion engine, step badges' numbers, sizes and colours, and speech bubbles' lines, bodies
 * and tails.
 */

const clips1: Clip[] = [{ id: 'c1', start: 0, end: 20, speed: 1 }]
const m = (kind: CalloutMotion['kind'], duration: number, strength = 1): CalloutMotion => ({ kind, duration, strength })

describe('calloutPose (test 36)', () => {
  const kinds = ITEM_MOTIONS.map((o) => o.value)
  it('equals itemPose for every ItemMotion kind, enter and exit, calm or not', () => {
    for (const kind of kinds)
      for (const calm of [false, true])
        for (const t of [1.0, 1.05, 1.1, 1.2, 1.4, 2, 3.7, 3.85, 3.95, 3.999]) {
          const enter = m(kind, 0.3, 0.8)
          const exit = m(kind === 'typewriter' ? 'fade' : kind, 0.25, 0.6)
          const want = itemPose(1, 4, t, clips1, enter as ItemMotion, exit as ItemMotion, 40, calm)
          const got = calloutPose(1, 4, t, clips1, enter, exit, 40, calm, 0.15)
          expect(got).not.toBeNull()
          const { drawn, ...pose } = got!
          expect(pose).toEqual(want)
          expect(drawn).toBe(1)
        }
  })

  it('is null outside the item', () => {
    expect(calloutPose(1, 4, 0.99, clips1, m('pop', 0.3), m('fade', 0.2), 40, false, 0.15)).toBeNull()
    expect(calloutPose(1, 4, 4, clips1, m('pop', 0.3), m('fade', 0.2), 40, false, 0.15)).toBeNull()
  })

  it('Draw gives 1 − (1 − p)³ at full opacity, then rests drawn', () => {
    for (const p of [0, 0.1, 0.25, 0.5, 0.8, 0.99]) {
      const pose = calloutPose(2, 6, 2 + p * 0.35, clips1, m('draw', 0.35), m('fade', 0.18), 30, false, 0.15)!
      expect(pose.drawn).toBeCloseTo(1 - (1 - p) ** 3, 9)
      expect(pose.alpha).toBe(1)
      expect(pose.reveal).toBe(1)
    }
    expect(calloutPose(2, 6, 2.36, clips1, m('draw', 0.35), m('fade', 0.18), 30, false, 0.15)!.drawn).toBe(1)
  })

  it('Wipe gives emphDecel from the reading start', () => {
    for (const p of [0, 0.2, 0.5, 0.9]) {
      const pose = calloutPose(2, 6, 2 + p * 0.28, clips1, m('wipe', 0.28), undefined, 30, false, 0.15)!
      expect(pose.reveal).toBeCloseTo(EASE.emphDecel(p), 9)
      expect(pose.drawn).toBe(1)
      expect(pose.alpha).toBe(1)
    }
  })

  it('keeps each side to at most half the item', () => {
    // A 0.4 s item with 1.5 s motions: the entrance is over at its middle, the exit starts there.
    const enter = m('draw', 1.5)
    const mid = calloutPose(5, 5.4, 5.2, clips1, enter, m('fade', 1.5), 30, false, 0.15)!
    expect(mid.drawn).toBeCloseTo(1, 9)
    const quarter = calloutPose(5, 5.4, 5.1, clips1, enter, m('fade', 1.5), 30, false, 0.15)!
    expect(quarter.drawn).toBeCloseTo(EASE.out(0.5), 9)
    const late = calloutPose(5, 5.4, 5.3, clips1, enter, m('fade', 1.5), 30, false, 0.15)!
    expect(late.alpha).toBeCloseTo(1 - EASE.inCubic(0.5), 9)
  })

  it('a missing exit fades over the old length, and a missing entrance too', () => {
    const fade = { kind: 'fade', duration: 0.15, strength: 1 } as ItemMotion
    for (const t of [3.86, 3.9, 3.95, 3.99]) {
      const got = calloutPose(1, 4, t, clips1, m('pop', 0.3), undefined, 40, false, 0.15)!
      expect(got.alpha).toBeCloseTo(itemPose(1, 4, t, clips1, m('pop', 0.3) as ItemMotion, fade, 40, false)!.alpha, 12)
      expect(got.alpha).toBeLessThan(1)
    }
    expect(calloutPose(1, 4, 3.8, clips1, m('pop', 0.3), undefined, 40, false, 0.15)!.alpha).toBe(1)
    // A title card's old fade is 0.35 s.
    expect(calloutPose(1, 4, 3.7, clips1, undefined, m('pop', 0.2), 40, false, 0.35)!.alpha).toBe(1)
    expect(calloutPose(1, 4, 1.2, clips1, undefined, m('pop', 0.2), 40, false, 0.35)!.alpha).toBeLessThan(1)
  })

  it('Calm motion clamps: pop grows, Draw fades, scale and movement held in', () => {
    const calm = calloutPose(1, 4, 1.05, clips1, m('pop', 0.3), m('fade', 0.2), 40, true, 0.15)!
    expect(calm.scale).toBeGreaterThanOrEqual(0.96)
    expect(Math.abs(calm.dy)).toBeLessThanOrEqual(0.15 * 40 + 1e-9)
    const drawn = calloutPose(1, 4, 1.05, clips1, m('draw', 0.35), m('fade', 0.2), 40, true, 0.15)!
    expect(drawn.drawn).toBe(1)
    expect(drawn.alpha).toBeLessThan(1)
    // Wipe stays under Calm motion, at least 0.2 s long.
    const wipe = calloutPose(1, 4, 1.15, clips1, m('wipe', 0.1), undefined, 40, true, 0.15)!
    expect(wipe.reveal).toBeCloseTo(EASE.emphDecel(0.75), 9)
  })

  it('runs in viewing time on a 2× clip', () => {
    const clips: Clip[] = [
      { id: 'a', start: 0, end: 10, speed: 1 },
      { id: 'b', start: 10, end: 30, speed: 2 }
    ]
    // On the 2× clip, 0.35 s of viewing time is 0.7 s of source time.
    const half = calloutPose(12, 20, 12 + 0.35, clips, m('draw', 0.35), m('fade', 0.18), 30, false, 0.15)!
    expect(half.drawn).toBeCloseTo(EASE.out(0.5), 9)
    expect(calloutPose(12, 20, 12.7, clips, m('draw', 0.35), m('fade', 0.18), 30, false, 0.15)!.drawn).toBe(1)
    const pop = calloutPose(12, 20, 12.2, clips, m('pop', 0.4), m('fade', 0.18), 30, false, 0.15)!
    expect(pop).toEqual({ ...itemPose(12, 20, 12.2, clips, m('pop', 0.4) as ItemMotion, m('fade', 0.18) as ItemMotion, 30, false)!, drawn: 1 })
  })
})

describe('items and their default motions (§7.1)', () => {
  it('maps styles and kinds to items; privacy shapes have none', () => {
    expect(calloutItemOf('pill')).toBe('text')
    expect(calloutItemOf('badge')).toBe('badge')
    expect(calloutItemOf('bubble')).toBe('bubble')
    expect(calloutItemOf('arrow')).toBe('arrow')
    expect(calloutItemOf('line')).toBe('arrow')
    expect(calloutItemOf('rect')).toBe('box')
    expect(calloutItemOf('ellipse')).toBe('box')
    expect(calloutItemOf('highlight')).toBe('highlight')
    expect(calloutItemOf('title')).toBe('title')
    expect(calloutItemOf('blur')).toBeNull()
    expect(calloutItemOf('pixelate')).toBeNull()
  })

  it('withDefaultMotion writes the kind defaults, never over a motion, never on privacy shapes', () => {
    expect(withDefaultMotion(createShape('arrow', 1, 10)).enter).toEqual({ kind: 'draw', duration: 0.35, strength: 1 })
    expect(withDefaultMotion(createShape('rect', 1, 10)).enter).toEqual({ kind: 'draw', duration: 0.45, strength: 1 })
    expect(withDefaultMotion(createShape('highlight', 1, 10)).enter).toEqual({ kind: 'wipe', duration: 0.28, strength: 1 })
    expect(withDefaultMotion(createShape('ellipse', 1, 10)).exit).toEqual({ kind: 'fade', duration: 0.18, strength: 1 })
    const blur = createShape('blur', 1, 10)
    expect(withDefaultMotion(blur)).toBe(blur)
    const own = { ...createShape('arrow', 1, 10), enter: m('fade', 0.5) }
    expect(withDefaultMotion(own)).toBe(own)
    // Exits are never longer than entrances in the defaults.
    for (const d of Object.values(CALLOUT_DEFAULTS)) expect(d.exit.duration).toBeLessThanOrEqual(d.enter.duration)
  })
})

describe('draw-on lengths (test 38, the pure part)', () => {
  it('a rectangle traces 2(w + h)', () => {
    expect(rectPerimeter(300, 200)).toBe(1000)
  })

  it("an ellipse's perimeter by Ramanujan is within 0.01 % of a numeric integral", () => {
    const numeric = (a: number, b: number): number => {
      const n = 200000
      let sum = 0
      let px = a
      let py = 0
      for (let i = 1; i <= n; i++) {
        const th = (2 * Math.PI * i) / n
        const x = a * Math.cos(th)
        const y = b * Math.sin(th)
        sum += Math.hypot(x - px, y - py)
        px = x
        py = y
      }
      return sum
    }
    // Up to 3.5 : 1 (the error grows with the ratio: 0.011 % at 4 : 1, 0.06 % at 8 : 1, a fraction of a pixel of dash).
    for (const [a, b] of [
      [100, 100],
      [150, 50],
      [350, 100],
      [60, 200]
    ]) {
      const exact = numeric(a, b)
      expect(Math.abs(ellipsePerimeter(a, b) - exact) / exact).toBeLessThan(1e-4)
    }
  })
})

/* ---------- step badges ---------- */

let seq = 0
function badge(start: number, extra: Partial<Annotation> & Record<string, unknown> = {}): Annotation {
  return { id: `b${String(++seq).padStart(3, '0')}`, start, end: start + 3, text: '', x: 0.5, y: 0.5, size: 0.045, style: 'badge', number: 'auto', ...extra } as Annotation
}
function projectWith(annotations: Annotation[], patch: Partial<Project> = {}): Project {
  const p = createProject({
    id: 'p1',
    name: 'P',
    duration: 120,
    width: 1920,
    height: 1080,
    hasWebcam: false,
    hasAudio: false,
    webcamOffset: 0,
    zooms: [],
    cursorValid: false,
    capture: { method: 'native', cursorInVideo: false, region: null, fps: 30 }
  })
  return { ...p, annotations, ...patch }
}

describe('badges (test 40)', () => {
  it('numbers automatic badges by start, ties by id', () => {
    const a = badge(10, { id: 'z' })
    const b = badge(5, { id: 'y' })
    const c = badge(10, { id: 'a' })
    const labels = badgeLabels(projectWith([a, b, c]))
    expect([labels.get('y'), labels.get('a'), labels.get('z')]).toEqual(['1', '2', '3'])
  })

  it('moving a badge renumbers', () => {
    const a = badge(2, { id: 'first' })
    const b = badge(4, { id: 'second' })
    const p = projectWith([a, b])
    expect(badgeLabels(p).get('first')).toBe('1')
    const moved = { ...p, annotations: [{ ...a, start: 6, end: 9 }, b] }
    expect(badgeLabels(moved).get('first')).toBe('2')
    expect(badgeLabels(moved).get('second')).toBe('1')
  })

  it('restarts at each chapter with two chapters, not with badgesByChapter false', () => {
    const list = [badge(5, { id: 'a' }), badge(10, { id: 'b' }), badge(40, { id: 'c' }), badge(50, { id: 'd' })]
    const chapters = [
      { id: 'k1', t: 0, title: 'One' },
      { id: 'k2', t: 30, title: 'Two' }
    ]
    const p = projectWith(list, { chapters })
    expect(['a', 'b', 'c', 'd'].map((id) => badgeLabels(p).get(id))).toEqual(['1', '2', '1', '2'])
    const off = { ...p, effects: { ...p.effects, badgesByChapter: false } }
    expect(['a', 'b', 'c', 'd'].map((id) => badgeLabels(off).get(id))).toEqual(['1', '2', '3', '4'])
    // One chapter: no restart.
    const one = projectWith(list, { chapters: [{ id: 'k2', t: 30, title: 'Two' }] })
    expect(['a', 'b', 'c', 'd'].map((id) => badgeLabels(one).get(id))).toEqual(['1', '2', '3', '4'])
  })

  it('startAt 5 gives 5, 6, 7; own-text badges do not count', () => {
    const list = [badge(1, { id: 'a', startAt: 5 }), badge(2, { id: 'own', number: undefined, text: 'Go' }), badge(3, { id: 'b' }), badge(4, { id: 'c' })]
    const labels = badgeLabels(projectWith(list))
    expect([labels.get('a'), labels.get('b'), labels.get('c')]).toEqual(['5', '6', '7'])
    expect(labels.has('own')).toBe(false)
  })

  it('A–Z then AA; Bangla digits ১…১০ with English captions; a language without digits of its own is Western', () => {
    expect(badgeNumber(1, 'A')).toBe('A')
    expect(badgeNumber(26, 'A')).toBe('Z')
    expect(badgeNumber(27, 'A')).toBe('AA')
    expect(badgeNumber(28, 'A')).toBe('AB')
    const list = Array.from({ length: 10 }, (_, i) => badge(i + 1, { id: `n${i}`, numbering: 'bn' }))
    const p = projectWith(list)
    const withCaptions = { ...p, captions: { ...(p.captions ?? {}), language: 'en' } } as Project
    const labels = badgeLabels(withCaptions)
    expect(list.map((b) => labels.get(b.id))).toEqual(['১', '২', '৩', '৪', '৫', '৬', '৭', '৮', '৯', '১০'])
    // 'fr' has no digits of its own: calloutOf reads it as '1'.
    const fr = badgeLabels(projectWith([badge(1, { id: 'fr', numbering: 'fr' })]))
    expect(fr.get('fr')).toBe('1')
    expect(badgeNumber(3, 'hi')).toBe('३')
  })

  it('label colours by contrast: #0060df takes white (5.61:1), #ffd60a takes #111111', () => {
    expect(badgeTextColor('#0060df')).toBe('#ffffff')
    expect(contrastRatio('#0060df', '#ffffff')).toBeGreaterThanOrEqual(5.61)
    expect(contrastRatio('#0060df', '#ffffff')).toBeLessThan(5.62)
    expect(badgeTextColor('#ffd60a')).toBe('#111111')
  })

  it('badgeBox for 1, 2 and 3 graphemes at the 0.045 default; "ক্ষা" and "👍🏽" are one grapheme each', () => {
    const f = 0.045 * 1080
    const measure = (text: string, px: number): number => graphemes(text).length * px * 0.6
    expect(badgeBox('3', f, measure)).toEqual({ w: 1.75 * f, h: 1.75 * f, px: f, radius: 0.875 * f })
    expect(badgeBox('ক্ষা', f, measure)).toEqual({ w: 1.75 * f, h: 1.75 * f, px: f, radius: 0.875 * f })
    expect(badgeBox('👍🏽', f, measure)).toEqual({ w: 1.75 * f, h: 1.75 * f, px: f, radius: 0.875 * f })
    expect(badgeBox('12', f, measure)).toEqual({ w: 1.75 * f, h: 1.75 * f, px: 0.85 * f, radius: 0.875 * f })
    const three = badgeBox('১২৩', f, measure)
    expect(three.h).toBeCloseTo(1.75 * f, 9)
    expect(three.w).toBeCloseTo(Math.max(1.75 * f, 3 * f * 0.6 + 0.9 * f), 9)
    const wide = badgeBox('WWW', f, (_t, px) => 3 * px)
    expect(wide.w).toBeCloseTo(3.9 * f, 9)
    // 85 px across at 1080p, 0.079 S.
    expect(1.75 * f).toBeCloseTo(85.05, 2)
  })
})

/* ---------- speech bubbles ---------- */

describe('bubbles (test 41, the pure part)', () => {
  const mono = (s: string): number => graphemes(s).length * 10

  it('wraps greedily by words', () => {
    const lines = wrapCallout('Click the blue button to save your work', 140, mono)
    expect(lines).toEqual(['Click the blue', 'button to save', 'your work'])
    for (const l of lines) expect(mono(l)).toBeLessThanOrEqual(140)
    expect(wrapCallout('Click the blue button to save your work', 120, mono)).toEqual(['Click the', 'blue button', 'to save your', 'work'])
    expect(wrapCallout('One\nTwo three', 500, mono)).toEqual(['One', 'Two three'])
  })

  it('never splits "ক্ষমতা" inside "ক্ষ"', () => {
    const text = 'ক্ষমতা'
    for (const width of [10, 20, 25]) {
      const lines = wrapCallout(text, width, mono)
      expect(lines.join('')).toBe(text)
      for (const l of lines) expect(l.startsWith('্') || l.startsWith('ষ') || l.endsWith('ক')).toBe(false)
      expect(lines.some((l) => l.includes('ক্ষ'))).toBe(true)
    }
  })

  it('wraps Chinese between graphemes, filling each line', () => {
    const text = '我们今天学习如何使用这个应用程序'
    const lines = wrapCallout(text, 50, mono)
    expect(lines.join('')).toBe(text)
    for (const l of lines) expect(mono(l)).toBeLessThanOrEqual(50)
    expect(lines.length).toBeLessThanOrEqual(5)
  })

  it('keeps the body inside the area, moved by the least amount', () => {
    const area = { x: 0, y: 0, w: 1920, h: 1080 }
    expect(bubbleBody({ x: 1000, y: 600 }, { dx: 0.12, dy: -0.1 }, { w: 300, h: 100 }, 1080, area)).toEqual({ x: 1000 + 129.6 - 150, y: 600 - 108 - 50, w: 300, h: 100 })
    const edge = bubbleBody({ x: 1900, y: 20 }, { dx: 0.12, dy: -0.1 }, { w: 300, h: 100 }, 1080, area)
    expect(edge).toEqual({ x: 1620, y: 0, w: 300, h: 100 })
  })

  it('puts the tail on the nearest edge, leaves it out inside or near the body, and clamps its base', () => {
    const body = { x: 100, y: 100, w: 400, h: 120 }
    const f = 40
    const below = bubbleTail(body, { x: 300, y: 400 }, f, 24)!
    expect(below.base[0].y).toBe(220)
    expect(below.base[1].y).toBe(220)
    expect(below.base[1].x - below.base[0].x).toBeCloseTo(Math.min(0.6 * f, 0.15 * 400), 9)
    // Its length is clamped to 3 f toward the tip.
    expect(Math.hypot(below.tip.x - 300, below.tip.y - 220)).toBeCloseTo(3 * f, 9)
    const left = bubbleTail(body, { x: 20, y: 160 }, f, 24)!
    expect(left.base[0].x).toBe(100)
    expect(left.base[1].x).toBe(100)
    // Inside or within 0.5 f: no tail.
    expect(bubbleTail(body, { x: 300, y: 150 }, f, 24)).toBeNull()
    expect(bubbleTail(body, { x: 300, y: 235 }, f, 24)).toBeNull()
    expect(bubbleTail(body, null, f, 24)).toBeNull()
    // Far to the right along the bottom: the base stops a corner radius from the corner.
    const corner = bubbleTail(body, { x: 700, y: 700 }, f, 24)!
    expect(corner.base[0].y).toBe(220)
    const width = Math.min(0.6 * f, 0.15 * 400)
    expect(Math.max(corner.base[0].x, corner.base[1].x)).toBeCloseTo(500 - 24, 9)
    expect(corner.base[1].x - corner.base[0].x).toBeCloseTo(width, 9)
    // A narrow edge: the base is 0.15 of it.
    const narrow = bubbleTail({ x: 0, y: 0, w: 100, h: 60 }, { x: 50, y: 200 }, f, 10)!
    expect(narrow.base[1].x - narrow.base[0].x).toBeCloseTo(15, 9)
    // Close: the tail reaches the tip itself (0.5 f to 3 f).
    const close = bubbleTail(body, { x: 300, y: 270 }, f, 24)!
    expect(close.tip).toEqual({ x: 300, y: 270 })
  })

  it('outlines white and light fills only; line height 1.4 with Bengali', () => {
    expect(bubbleOutlined('#ffffff')).toBe(true)
    expect(bubbleOutlined('#f4f4f8')).toBe(true)
    expect(bubbleOutlined('#1d1d24')).toBe(false)
    expect(bubbleOutlined('#0060df')).toBe(false)
    expect(bubbleLineHeight('Save it')).toBe(1.3)
    expect(bubbleLineHeight('সেভ করুন')).toBe(1.4)
    expect(bubbleLineHeight('สวัสดี')).toBe(1.4)
  })
})
