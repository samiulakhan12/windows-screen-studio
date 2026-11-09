/**
 * Make a shorter version (docs/design/smart-tools.md §8.6; §22.1 tests 58, 59, 123 and 124): the
 * plan's length with freezes, its order, padding and joins, one sentence per user chapter first,
 * what it never picks, why it gives up; the copy's records of the removed stretches, the original's
 * records it keeps, and its smooth cuts.
 */
import { describe, expect, it } from 'vitest'
import { clipSentences, keptClipWords } from '../src/shared/clips/sentences'
import { planShort, shortCopy, type ShortPlan } from '../src/shared/clips/short60'
import { planOf, videoDuration } from '../src/shared/engine/freeze'
import { cutRange } from '../src/shared/engine/timeline'
import { recordAutoCuts } from '../src/shared/review/autoCuts'
import { JOIN_ALL_KEY } from '../src/shared/review/joinReview'
import { removeItems, reviewItems } from '../src/shared/review/review'
import type { Clip, Project } from '../src/shared/types'
import { clipProject, steadyTalk, type Said } from './clipFixtures'

type Ok = Extract<ShortPlan, { ok: true }>
const plan = (p: Project, seconds: 30 | 60 | 90, focus?: string): ShortPlan => planShort(p, clipSentences(p, { track: null, scan: null, focus }), { seconds, ...(focus !== undefined ? { focus } : {}) })
const ok = (p: ShortPlan): Ok => {
  if (!p.ok) throw new Error(`no plan: ${p.reason}`)
  return p
}

/** Three minutes of talk with gaps of 0.2, 0.5 and 1.2 s between sentences, a 2× stretch and pause freezes. */
function talk(over: Partial<Project> = {}): Project {
  const said: Said[] = []
  let t = 1
  for (let i = 0; i < 48; i++) {
    const words = 6 + (i % 4)
    const text = `${['Here', 'Then', 'Now', 'Also'][i % 4]} the ${['report', 'invoice', 'billing', 'export', 'chart', 'table'][i % 6]} shows ${['totals', 'rows', 'teams', 'dates'][i % 4]} ${Array.from({ length: words - 5 }, (_, k) => ['for', 'each', 'week', 'and', 'month'][(i + k) % 5]).join(' ')} item${i}.`
    said.push({ t, text })
    t += (text.split(' ').length - 1) * 0.35 + 0.28 + [0.2, 0.5, 1.2][i % 3]
  }
  const duration = Math.ceil(t) + 2
  const clips: Clip[] = [
    { id: 'a', start: 0, end: 60, speed: 1 },
    { id: 'b', start: 60, end: 80, speed: 2 },
    { id: 'c', start: 80, end: duration, speed: 1 }
  ]
  return clipProject({ said, duration, clips, freezes: [{ id: 'f1', at: 30, length: 2, sound: 'pause' }, { id: 'f2', at: 100, length: 1.5, sound: 'pause' }], ...over })
}

describe('planShort (test 58)', () => {
  it('the viewing time of the pieces plus the freezes inside stays within 30, 60 and 90 s; the copy lasts exactly that', () => {
    const p = talk()
    for (const seconds of [30, 60, 90] as const) {
      const out = ok(plan(p, seconds))
      expect(out.seconds).toBeLessThanOrEqual(seconds + 1e-9)
      expect(out.seconds).toBeGreaterThanOrEqual(seconds / 2)
      const copy = shortCopy(p, out, { shape: 'same', captions: true, measure: null })
      expect(videoDuration(copy.clips, planOf(copy))).toBeCloseTo(out.seconds, 6)
      expect(copy.name).toBe(`Billing tour (${seconds} s)`)
    }
  })

  it('pieces in order, 0.6 s or more apart (0.5 s apart join), padded 0.15 / 0.25 s but never past the middle of the silence to the next word', () => {
    const p = talk()
    const out = ok(plan(p, 60))
    const words = keptClipWords(p)
    for (let i = 1; i < out.pieces.length; i++) expect(out.pieces[i].start - out.pieces[i - 1].end).toBeGreaterThanOrEqual(0.6 - 1e-9)
    for (const piece of out.pieces) {
      const before = words.filter((w) => w.end <= piece.start + 1e-9).pop()
      const first = words.find((w) => w.start >= piece.start - 1e-9)!
      const last = words.filter((w) => w.end <= piece.end + 1e-9).pop()!
      const after = words.find((w) => w.start >= piece.end - 1e-9)
      expect(piece.start).toBeGreaterThanOrEqual(first.start - 0.15 - 1e-9)
      if (before) expect(piece.start).toBeGreaterThanOrEqual((before.end + first.start) / 2 - 1e-9)
      expect(piece.end).toBeLessThanOrEqual(last.end + 0.25 + 1e-9)
      if (after) expect(piece.end).toBeLessThanOrEqual((last.end + after.start) / 2 + 1e-9)
    }
    // After a 0.2 s gap, a piece starts at its middle (0.1 s before the word), not 0.15 s before.
    // (Two words before it: a sentence never chosen.)
    const said = [{ t: 1, text: 'Right then.' }, { t: 1 + 0.35 + 0.28 + 0.2, text: 'The billing page shows every invoice row.' }, ...steadyTalk(12, { from: 10, every: 6 })]
    const p2 = clipProject({ said, duration: 100 })
    const second = ok(plan(p2, 30, 'billing')).pieces.find((x) => x.end > said[1].t + 1 && x.start <= said[1].t)!
    expect(second.start).toBeCloseTo(said[1].t - 0.1, 6)
  })

  it('the pad after a sentence stops at the middle of a 0.2 s silence', () => {
    const said: Said[] = [{ t: 1, text: 'The billing page shows every invoice row.' }, { t: 1 + 6 * 0.35 + 0.28 + 0.2, text: 'Right then.' }, ...steadyTalk(12, { from: 10, every: 6 })]
    const p = clipProject({ said, duration: 100 })
    const first = ok(plan(p, 30, 'billing')).pieces[0]
    expect(first.end).toBeCloseTo(1 + 6 * 0.35 + 0.28 + 0.1, 6)
  })

  it('a pause freeze inside a piece counts: the copy lasts the plan’s seconds with it', () => {
    const said = steadyTalk(30, { every: 5 })
    said[3] = { t: said[3].t, text: 'The billing page shows every open invoice.' }
    const p = clipProject({ said, duration: 160, freezes: [{ id: 'f', at: 17, length: 10, sound: 'pause' }] })
    const out = ok(plan(p, 30, 'billing'))
    expect(out.pieces.some((x) => x.start <= 17 && x.end > 17)).toBe(true)
    const copy = shortCopy(p, out, { shape: 'same', captions: true, measure: null })
    expect(copy.freezes!.map((f) => f.id)).toEqual(['f'])
    expect(videoDuration(copy.clips, planOf(copy))).toBeCloseTo(out.seconds, 6)
    expect(out.seconds).toBeLessThanOrEqual(30 + 1e-9)
  })

  it('Focus on (+2) decides between sentences alike; a sentence much like one taken gives way to another (maximal marginal relevance)', () => {
    /** A sentence of 34 different words (about 12 s): `head` then words of its own. */
    const long = (head: string, tag: string): string => `${head} ${Array.from({ length: 34 - head.split(' ').length }, (_, k) => `${tag}${k}`).join(' ')}.`
    const said: Said[] = [
      { t: 30, text: long('The report page lists', 'rp') },
      { t: 50, text: long('Our export file keeps', 'ex') },
      { t: 70, text: long('The report chart compares', 'rc') },
      { t: 90, text: long('Each export job sends', 'ej') },
      { t: 110, text: long('The report summary fits', 'rs') }
    ]
    const p = clipProject({ said, duration: 200 })
    const starts = (o: Ok): number[] => o.pieces.map((x) => Math.round(x.start + 0.15))
    expect(starts(ok(plan(p, 30, 'export')))).toEqual([50, 90])
    expect(starts(ok(plan(p, 30, 'report')))).not.toContain(50)
    // Two copies of one sentence (too far apart to be a retake) and another a little less relevant: the second copy gives way.
    const same = long('The billing page lists', 'bp')
    const alike: Said[] = [
      { t: 40, text: same },
      { t: 70, text: same },
      { t: 100, text: long('Billing settings decide', 'bs') },
      ...steadyTalk(6, { from: 130, every: 5 })
    ]
    const q = clipProject({ said: alike, duration: 200 })
    const zero = { density: 0, keywords: 0, emphasis: 0, numbers: 0, action: 0, fillers: 0, focus: 0 }
    const scored = clipSentences(q, { track: null, scan: null }).map((x, i) => ({ ...x, features: { ...zero, ...(i < 2 ? { keywords: 1, emphasis: 1 } : i === 2 ? { keywords: 0.8, emphasis: 1 } : {}) } }))
    const picked = planShort(q, scored, { seconds: 30 })
    expect(starts(ok(picked)).slice(0, 2)).toEqual([40, 100])
    expect(starts(ok(picked))).not.toContain(70)
  })

  it('two sentences 0.5 s apart become one piece', () => {
    const said: Said[] = [
      { t: 1, text: 'The billing page shows the monthly totals.' },
      { t: 1 + 6 * 0.35 + 0.28 + 0.5, text: 'The billing export keeps every invoice row.' },
      ...steadyTalk(10, { from: 20, every: 6 })
    ]
    const p = clipProject({ said, duration: 100 })
    const out = ok(plan(p, 30, 'billing'))
    const first = out.pieces[0]
    expect(first.start).toBeCloseTo(1 - 0.15, 6)
    expect(first.end).toBeGreaterThan(said[1].t + 2)
  })

  it('one sentence per user chapter first (with 2 or more), then the best', () => {
    // The first minute says what Focus on asks for; the others mostly fillers.
    const billing = [
      'The billing page lists every open invoice.',
      'Billing totals update after each payment arrives.',
      'Our billing export keeps tax details safe.',
      'Billing reminders go out on Monday mornings.',
      'The billing chart compares this quarter with last.',
      'Billing settings decide who approves refunds.',
      'Each billing entry links to its customer.',
      'Billing history helps auditors check old records.',
      'The billing summary fits on one screen.',
      'Billing alerts warn you before a card expires.'
    ]
    const chat = [
      'Um so uh the weather was nice outside.',
      'Uh like um my coffee got cold again.',
      'Um well uh traffic took forever this morning.',
      'Like um uh the cat sat near me.',
      'Uh so um lunch might be pizza today.',
      'Um like uh my desk needs a cleaning.',
      'Uh um well the window is open now.',
      'So um uh music plays somewhere down the hall.',
      'Um uh like a bird keeps singing outside.',
      'Uh well um the printer jammed twice before.'
    ]
    const said: Said[] = [
      ...billing.map((text, i) => ({ t: 1 + i * 5, text })),
      ...chat.map((text, i) => ({ t: 61 + i * 5, text })),
      ...chat.map((text, i) => ({ t: 121 + i * 5, text: text.replace(/\.$/, ' too.') }))
    ]
    const p = clipProject({ said, duration: 180 })
    const parts = (o: Ok): number => new Set(o.pieces.map((x) => (x.start < 60 ? 0 : x.start < 120 ? 1 : 2))).size
    expect(parts(ok(plan(p, 30, 'billing')))).toBeLessThan(3)
    const chaptered = { ...p, chapters: [{ id: 'a', t: 0, title: 'Billing' }, { id: 'b', t: 60, title: 'Reports' }, { id: 'c', t: 120, title: 'Export' }] }
    const out = ok(plan(chaptered, 30, 'billing'))
    expect(parts(out)).toBe(3)
    // One chapter only: no first pass.
    expect(parts(ok(plan({ ...p, chapters: [{ id: 'a', t: 0, title: 'All' }] }, 30, 'billing')))).toBeLessThan(3)
    // Found chapters waiting for review do not count.
    const found = { ...p, chapters: [{ id: 'a', t: 0, title: 'Billing' }, { id: 'b', t: 60, title: 'R', auto: { by: 'find' as const, from: ['pause' as const], name: 'number' as const } }, { id: 'c', t: 120, title: 'E', auto: { by: 'find' as const, from: ['pause' as const], name: 'number' as const } }] }
    expect(parts(ok(plan(found, 30, 'billing')))).toBeLessThan(3)
  })

  it('the earlier take of a retake and sentences under 3 words are never chosen', () => {
    const said: Said[] = [
      { t: 1, text: 'Billing billing billing invoices are here.' },
      { t: 5, text: 'Billing billing billing invoices are here now.' },
      { t: 10, text: 'Billing please.' },
      ...steadyTalk(16, { from: 15, every: 5 })
    ]
    const p = clipProject({ said, duration: 100 })
    const list = clipSentences(p, { track: null, scan: null, focus: 'billing' })
    expect(list[0].retake).toBe(true)
    const out = ok(plan(p, 30, 'billing'))
    const covers = (t: number): boolean => out.pieces.some((x) => x.start <= t && x.end >= t)
    expect(covers(2)).toBe(false)
    expect(covers(10.2)).toBe(false)
    expect(covers(6)).toBe(true)
  })

  it('under half the length found: too-little; a length at or above the video: too-short; no captions: no-captions', () => {
    const sparse = clipProject({ said: [{ t: 1, text: 'We open the billing page now.' }, { t: 40, text: 'And that is all for today.' }], duration: 100 })
    expect(plan(sparse, 60)).toEqual({ ok: false, reason: 'too-little' })
    const short = clipProject({ said: steadyTalk(10), duration: 55 })
    expect(plan(short, 60)).toEqual({ ok: false, reason: 'too-short' })
    expect(plan(short, 90)).toEqual({ ok: false, reason: 'too-short' })
    expect(plan(clipProject({ said: steadyTalk(10), duration: 60 }), 60)).toEqual({ ok: false, reason: 'too-short' })
    expect(plan(short, 30).ok).toBe(true)
    expect(plan(clipProject({ duration: 100 }), 30)).toEqual({ ok: false, reason: 'no-captions' })
  })
})

/** A 100 s recording, one clip, sentences every 5 s; the plan keeps [5, 20] and [24.2, 40]. */
function simple(over: Partial<Project> = {}): Project {
  return clipProject({ said: steadyTalk(19, { every: 5 }), duration: 100, ...over })
}
const PLAN: Ok = { ok: true, pieces: [{ start: 5, end: 20 }, { start: 24.2, end: 40 }], seconds: 30.8, sentences: 6, length: 60 }

describe('shortCopy (test 59)', () => {
  it('its records come from recordAutoCuts by "short", with `was` the original’s kept pieces there; Review lists “Cut 4.2 s for the shorter version”', () => {
    const p = simple({ clips: [{ id: 'a', start: 0, end: 22, speed: 1 }, { id: 'b', start: 22, end: 23, speed: 2 }, { id: 'c', start: 23, end: 100, speed: 1 }] })
    const copy = shortCopy(p, PLAN, { shape: 'same', captions: true, measure: null })
    expect(copy.clips.map((c) => [c.start, c.end, c.speed])).toEqual([
      [5, 20, 1],
      [24.2, 40, 1]
    ])
    expect(copy.autoCuts!.map((c) => [c.by, c.action, c.start, c.end, c.was])).toEqual([
      ['short', 'cut', 0, 5, [{ start: 0, end: 5, speed: 1 }]],
      ['short', 'cut', 20, 24.2, [{ start: 20, end: 22, speed: 1 }, { start: 22, end: 23, speed: 2 }, { start: 23, end: 24.2, speed: 1 }]],
      ['short', 'cut', 40, 100, [{ start: 40, end: 100, speed: 1 }]]
    ])
    const rows = reviewItems(copy).filter((r) => r.cut)
    expect(rows.map((r) => [r.kind, r.title, r.detail])).toEqual([
      ['short', 'Cut 5.0 s for the shorter version', 'Make a shorter version'],
      ['short', 'Cut 4.2 s for the shorter version', 'Make a shorter version'],
      ['short', 'Cut 60.0 s for the shorter version', 'Make a shorter version']
    ])
    expect(copy.clipOf).toEqual({ kind: 'short', start: 5, end: 40 })
  })

  it('Remove brings the stretch back exactly, at its speeds', () => {
    const p = simple({ clips: [{ id: 'a', start: 0, end: 22, speed: 1 }, { id: 'b', start: 22, end: 23, speed: 2 }, { id: 'c', start: 23, end: 100, speed: 1 }] })
    const copy = shortCopy(p, PLAN, { shape: 'same', captions: true, measure: null })
    const row = reviewItems(copy).find((r) => r.title === 'Cut 4.2 s for the shorter version')!
    const back = removeItems(copy, [row])
    expect(back.clips.map((c) => [c.start, c.end, c.speed])).toEqual([
      [5, 22, 1],
      [22, 23, 2],
      [23, 40, 1]
    ])
    expect(back.autoCutOutcomes).toEqual([{ id: row.cut!.id, outcome: 'removed' }])
    // Removing them all gives back the original's kept edit.
    const all = removeItems(copy, reviewItems(copy).filter((r) => r.cut))
    expect(all.clips.map((c) => [c.start, c.end, c.speed])).toEqual(p.clips.map((c) => [c.start, c.end, c.speed]))
  })
})

describe('the original’s records in the shorter version (test 123)', () => {
  it('a silence record inside a removed stretch is not in the copy; one inside a kept piece is, and is listed', () => {
    const p0 = simple()
    const p = recordAutoCuts(p0, cutRange(cutRange(p0.clips, 10, 11), 30, 31), [{ start: 10, end: 11 }, { start: 30, end: 31 }], 'cut', 'silences')
    const copy = shortCopy(p, { ...PLAN, pieces: [{ start: 5, end: 20 }, { start: 40, end: 55 }] }, { shape: 'same', captions: true, measure: null })
    const silences = copy.autoCuts!.filter((c) => c.by === 'silences')
    expect(silences.map((c) => [c.start, c.end])).toEqual([[10, 11]])
    expect(reviewItems(copy).filter((r) => r.kind === 'silence').map((r) => r.title)).toEqual(['Cut 1.0 s of silence'])
    // Removing the short's stretch over 20-40 never brings back 30-31 (the original's cut stays a plain cut there).
    const row = reviewItems(copy).find((r) => r.cut?.start === 20)!
    expect(removeItems(copy, [row]).clips.some((c) => c.start < 31 && c.end > 30)).toBe(false)
  })

  it('a removed stretch of 70 kept pieces gives 2 records and 2 rows', () => {
    // 68 clips of 0.18 s, 0.02 s apart, in 20.22-33.8 s: with the clips at each end, 70 pieces in 20-40.
    const clips: Clip[] = [{ id: 'head', start: 0, end: 20.2, speed: 1 }]
    for (let i = 0; i < 68; i++) clips.push({ id: `m${i}`, start: 20.22 + i * 0.2, end: 20.22 + i * 0.2 + 0.18, speed: 1 })
    clips.push({ id: 'tail', start: 33.85, end: 100, speed: 1 })
    const copy = shortCopy(simple({ clips }), { ...PLAN, pieces: [{ start: 5, end: 20 }, { start: 40, end: 55 }] }, { shape: 'same', captions: true, measure: null })
    const middle = copy.autoCuts!.filter((c) => c.by === 'short' && c.start >= 20 - 1e-9 && c.end <= 40 + 1e-9)
    expect(middle).toHaveLength(2)
    expect(middle.map((c) => c.was.length)).toEqual([64, 6])
    expect(reviewItems(copy).filter((r) => r.cut && r.cut.start >= 20 - 1e-9 && r.cut.end <= 40 + 1e-9)).toHaveLength(2)
  })
})

describe('smooth cuts in the shorter version (test 124)', () => {
  it('an original without joins.all gets smooth cuts by "short", one row "Make a shorter version"; Remove restores no joins', () => {
    const copy = shortCopy(simple(), PLAN, { shape: 'same', captions: true, measure: null })
    expect(copy.joins).toEqual({ all: { kind: 'smooth' }, auto: { by: 'short', was: null } })
    const rows = reviewItems(copy).filter((r) => r.key === JOIN_ALL_KEY)
    expect(rows).toHaveLength(1)
    expect(rows[0].detail).toBe('Make a shorter version')
    expect(rows[0].title).toMatch(/^Smooth cuts at \d+ cuts?$/)
    expect(removeItems(copy, rows).joins).toBeUndefined()
  })

  it("an original with Polish's smooth cuts still pending: the short keeps that row, and Auto colour's, the caption look's and the face framing's (all of the whole video)", () => {
    const p = simple({
      joins: { all: { kind: 'smooth' }, auto: { by: 'polish', was: null } },
      grade: { camera: { exposure: 0.2 }, auto: { camera: null } },
      captionAuto: { style: { was: null, by: 'polish', name: 'Bold' } },
      webcam: { ...simple().webcam, zoom: 1.6, cropX: 0.4, cropY: 0.45 },
      director: { intro: 'off', corners: 'auto', hideAfter: 0, frameFace: true, framed: { zoom: 1.6, cropX: 0.4, cropY: 0.45 } }
    })
    const whole = ['join:all', 'colour:camera', 'style:look', 'camera:framing']
    expect(reviewItems(p).map((r) => r.key)).toEqual(expect.arrayContaining(whole))
    const copy = shortCopy(p, PLAN, { shape: 'same', captions: true, measure: null })
    const rows = reviewItems(copy).filter((r) => !r.cut)
    expect(rows.map((r) => r.key)).toEqual(expect.arrayContaining(whole))
    // The smooth cuts at the short's cuts are Polish's, listed once, and Remove puts back what was there.
    expect(copy.joins).toEqual({ all: { kind: 'smooth' }, auto: { by: 'polish', was: null } })
    const join = rows.filter((r) => r.key === JOIN_ALL_KEY)
    expect(join).toHaveLength(1)
    expect(join[0].detail).toBe('Polish')
    expect(removeItems(copy, join).joins).toBeUndefined()
    expect(copy.grade?.auto).toEqual({ camera: null })
  })

  it('an original with its own joins.all keeps it and has no row', () => {
    const p = simple({ joins: { all: { kind: 'crossfade', duration: 0.3 } } })
    const copy = shortCopy(p, PLAN, { shape: 'same', captions: true, measure: null })
    expect(copy.joins).toEqual({ all: { kind: 'crossfade', duration: 0.3 } })
    expect(reviewItems(copy).some((r) => r.key === JOIN_ALL_KEY)).toBe(false)
  })

  it('the copy drops chapters, keeps the freezes inside the pieces, and shows captions when asked', () => {
    const p = simple({ chapters: [{ id: 'c', t: 0, title: 'Intro' }], freezes: [{ id: 'in', at: 10, length: 1, sound: 'pause' }, { id: 'out', at: 22, length: 1, sound: 'pause' }] })
    const copy = shortCopy(p, PLAN, { shape: 'vertical', captions: true, measure: null })
    expect(copy.chapters).toBeUndefined()
    expect(copy.freezes!.map((f) => f.id)).toEqual(['in'])
    expect(copy.captions!.show).toBe(true)
    expect(copy.style.aspectRatio).toBe('9:16')
  })
})
