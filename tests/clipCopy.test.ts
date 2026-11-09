/**
 * A short clip made into a copy (docs/design/smart-tools.md §8.5; §22.1 tests 55 and 122): the
 * clips and freezes of the moment by edit time, no chapters and no guide, its name and origin,
 * Duplicate's own framing, and only the pending changes it shows.
 */
import { describe, expect, it } from 'vitest'
import { clipCopy, clipsInRange, piecesClips, suffixedName, withinRange } from '../src/shared/clips/clipCopy'
import type { Moment } from '../src/shared/clips/moments'
import { projectCopy } from '../src/shared/editor/duplicate'
import { migrateProject } from '../src/shared/engine/project'
import { cutRange } from '../src/shared/engine/timeline'
import { recordAutoCuts } from '../src/shared/review/autoCuts'
import { removeItems, reviewItems } from '../src/shared/review/review'
import type { Clip, Project } from '../src/shared/types'
import { clipProject, steadyTalk } from './clipFixtures'

const MOMENT: Moment = { start: 20, end: 50, seconds: 30, score: 3, reasons: ['Opens with a question', '6 clicks', '30 s'], first: 'How', title: 'Set up billing', silent: false }

/** A 100 s narrated project with a 2× clip from 30 to 40 s, freezes, chapters, a guide and two zooms (one auto). */
function original(over: Partial<Project> = {}): Project {
  const clips: Clip[] = [
    { id: 'a', start: 0, end: 30, speed: 1 },
    { id: 'b', start: 30, end: 40, speed: 2 },
    { id: 'c', start: 40, end: 100, speed: 1 }
  ]
  return clipProject({
    said: steadyTalk(19, { every: 5 }),
    duration: 100,
    clips,
    freezes: [
      { id: 'f1', at: 10, length: 2, sound: 'pause' },
      { id: 'f2', at: 25, length: 3, sound: 'pause' },
      { id: 'f3', at: 70, length: 1, sound: 'continue' }
    ],
    chapters: [
      { id: 'c1', t: 0, title: 'Intro' },
      { id: 'c2', t: 45, title: 'Billing' }
    ],
    guide: { title: 'How to bill' },
    zooms: [
      { id: 'z-in', start: 22, end: 26, scale: 2, focus: { mode: 'cursor' }, auto: true },
      { id: 'z-out', start: 70, end: 74, scale: 2, focus: { mode: 'cursor' }, auto: true },
      { id: 'z-mine', start: 80, end: 84, scale: 2, focus: { mode: 'cursor' }, auto: false }
    ],
    captions: { ...clipProject({ duration: 1 }).captions!, show: true } as Project['captions'],
    ...over
  } as Parameters<typeof clipProject>[0])
}

describe('clip copies (test 55)', () => {
  it('clips cut to the moment by edit time (a 2× clip keeps its speed), freezes inside only', () => {
    const part = clipsInRange(original(), 20, 50)
    expect(part.clips.map((c) => [c.id, c.start, c.end, c.speed])).toEqual([
      ['a', 20, 30, 1],
      ['b', 30, 40, 2],
      ['c', 40, 50, 1]
    ])
    expect(part.freezes!.map((f) => f.id)).toEqual(['f2'])
    // A moment inside a cut keeps only what plays; none inside it: no freezes key.
    const cut = clipsInRange({ clips: cutRange(original().clips, 24, 28), freezes: original().freezes }, 22, 35)
    expect(cut.clips.map((c) => [c.start, c.end])).toEqual([
      [22, 24],
      [28, 30],
      [30, 35]
    ])
    expect('freezes' in cut).toBe(false)
  })

  it('chapters and guide gone, “<title> (clip)” within 120 characters, clipOf with the reasons', () => {
    const copy = clipCopy(original(), MOMENT, { shape: 'same', captions: true, measure: null })
    expect(copy.chapters).toBeUndefined()
    expect(copy.guide).toBeUndefined()
    expect(copy.name).toBe('Set up billing (clip)')
    expect(copy.clipOf).toEqual({ kind: 'moment', start: 20, end: 50, why: 'Opens with a question · 6 clicks · 30 s' })
    expect(copy.id).toBe(original().id)
    const long = clipCopy(original(), { ...MOMENT, title: 'x'.repeat(200) }, { shape: 'same', captions: true, measure: null })
    expect(long.name.length).toBe(120)
    expect(long.name.endsWith('x (clip)')).toBe(true)
    // Cut by graphemes: an emoji or a conjunct at the edge is never split.
    expect(suffixedName('a'.repeat(112) + '👍🏽👍🏽', ' (clip)').length).toBeLessThanOrEqual(120)
    expect(suffixedName('a'.repeat(112) + '👍🏽👍🏽', ' (clip)')).toBe('a'.repeat(112) + ' (clip)')
    // The copy reads back as it was written.
    expect(migrateProject(JSON.parse(JSON.stringify(copy))).clipOf).toEqual(copy.clipOf)
  })

  it("with 'vertical' it equals projectCopy(…, 'vertical') in every field but those and the pending changes", () => {
    const p = original()
    const copy = clipCopy(p, MOMENT, { shape: 'vertical', captions: true, measure: null })
    const dup = projectCopy(p, 'vertical', null)
    const skip = new Set(['clips', 'freezes', 'chapters', 'guide', 'name', 'clipOf', 'zooms'])
    const keys = new Set([...Object.keys(copy), ...Object.keys(dup)])
    for (const k of keys) if (!skip.has(k)) expect((copy as unknown as Record<string, unknown>)[k], k).toEqual((dup as unknown as Record<string, unknown>)[k])
    expect(copy.style.aspectRatio).toBe('9:16')
    expect(copy.reframe?.mode).toBe('follow')
    // The zooms: the same ones, the pending one outside the moment settled.
    expect(copy.zooms.map((z) => [z.id, z.auto])).toEqual([
      ['z-in', true],
      ['z-out', false],
      ['z-mine', false]
    ])
  })

  it("'square' and 'same' take Duplicate's other shapes", () => {
    expect(clipCopy(original(), MOMENT, { shape: 'square', captions: true, measure: null }).style.aspectRatio).toBe('1:1')
    expect(clipCopy(original(), MOMENT, { shape: 'same', captions: true, measure: null }).style.aspectRatio).toBe(original().style.aspectRatio)
  })

  it('pieces of one clip get their own ids', () => {
    const out = piecesClips(original(), [
      { start: 1, end: 5 },
      { start: 10, end: 15 },
      { start: 35, end: 38 }
    ])
    expect(out.clips.map((c) => [c.start, c.end, c.speed])).toEqual([
      [1, 5, 1],
      [10, 15, 1],
      [35, 38, 2]
    ])
    expect(new Set(out.clips.map((c) => c.id)).size).toBe(3)
    expect(out.clips[0].id).toBe('a')
    expect(out.freezes!.map((f) => f.id)).toEqual(['f1'])
  })
})

describe('clip copies keep only their own pending changes (test 122)', () => {
  /** The original with silence cuts before (10-12), inside (33-35) and after (60-62) the moment. */
  function withSilences(): Project {
    const p = original({ clips: [{ id: 'k', start: 0, end: 100, speed: 1 }], freezes: undefined })
    let clips = p.clips
    for (const [a, b] of [
      [10, 12],
      [33, 35],
      [60, 62]
    ])
      clips = cutRange(clips, a, b)
    return recordAutoCuts(p, clips, [
      { start: 10, end: 12 },
      { start: 33, end: 35 },
      { start: 60, end: 62 }
    ], 'cut', 'silences')
  }

  it('keeps only the record inside, with no outcome recorded for the dropped ones', () => {
    const p = { ...withSilences(), autoCutOutcomes: [{ id: 'old', outcome: 'kept' as const }] }
    expect(p.autoCuts).toHaveLength(3)
    const copy = clipCopy(p, MOMENT, { shape: 'same', captions: true, measure: null })
    expect(copy.autoCuts!.map((c) => [c.start, c.end])).toEqual([[33, 35]])
    expect(copy.autoCutOutcomes).toEqual([{ id: 'old', outcome: 'kept' }])
    const rows = reviewItems(copy)
    expect(rows.filter((r) => r.cut).map((r) => r.title)).toEqual(['Cut 2.0 s of silence'])
  })

  it('Remove all in the copy leaves its clips inside the moment', () => {
    const copy = clipCopy(withSilences(), MOMENT, { shape: 'same', captions: true, measure: null })
    const after = removeItems(copy, reviewItems(copy))
    expect(after.clips.length).toBeGreaterThan(0)
    for (const c of after.clips) {
      expect(c.start).toBeGreaterThanOrEqual(20 - 1e-9)
      expect(c.end).toBeLessThanOrEqual(50 + 1e-9)
    }
    // The silence inside came back.
    expect(after.clips.map((c) => [c.start, c.end])).toEqual([[20, 50]])
  })

  it('a pending automatic zoom wholly outside the moment is no longer listed; one inside still is', () => {
    const copy = clipCopy(withSilences(), MOMENT, { shape: 'same', captions: true, measure: null })
    const keys = reviewItems(copy).map((r) => r.key)
    expect(keys).toContain('zoom:z-in')
    expect(keys).not.toContain('zoom:z-out')
    // Settling only drops the mark: the zoom is still there, as the user's.
    expect(copy.zooms.find((z) => z.id === 'z-out')).toMatchObject({ auto: false, start: 70, end: 74 })
  })

  it('withinRange leaves a copy with nothing outside as it is; Captions Studio’s items are judged one by one', () => {
    const p = withSilences()
    const inside = withinRange(p, [{ start: 0, end: 100 }])
    expect(inside).toBe(p)
    const marks = [
      { id: 'e1', caption: 's4', from: 0, to: 0, text: 'x', auto: true as const },
      { id: 'e2', caption: 's14', from: 0, to: 0, text: 'y', auto: true as const }
    ]
    const copy = clipCopy({ ...p, captionMarks: marks }, MOMENT, { shape: 'same', captions: true, measure: null })
    expect(copy.captionMarks!.map((m) => [m.id, !!m.auto])).toEqual([
      ['e1', true],
      ['e2', false]
    ])
  })

  it('the changes made to the whole video stay listed: the caption look (listed at the first caption, before the moment), Auto colour and smooth cuts', () => {
    const p = original({
      joins: { all: { kind: 'smooth' }, auto: { by: 'polish', was: null } },
      grade: { camera: { exposure: 0.2 }, auto: { camera: null } },
      captionAuto: { style: { was: null, by: 'polish', name: 'Bold' } }
    })
    const whole = ['style:look', 'colour:camera', 'join:all']
    expect(reviewItems(p).map((r) => r.key)).toEqual(expect.arrayContaining(whole))
    expect(reviewItems(p).find((r) => r.key === 'style:look')!.start).toBeLessThan(MOMENT.start)
    const copy = clipCopy(p, MOMENT, { shape: 'same', captions: true, measure: null })
    expect(reviewItems(copy).map((r) => r.key)).toEqual(expect.arrayContaining(whole))
    // Each still has its record, so Remove in the copy can put back what was there.
    expect(copy.captionAuto?.style).toEqual(p.captionAuto!.style)
    expect(copy.grade?.auto).toEqual({ camera: null })
    expect(copy.joins?.auto).toEqual({ by: 'polish', was: null })
  })

  it('Captions: shown when ticked, hidden when not; a recording without captions is left alone', () => {
    const p = { ...original(), captions: { ...original().captions!, show: false } }
    expect(clipCopy(p, MOMENT, { shape: 'same', captions: true, measure: null }).captions!.show).toBe(true)
    expect(clipCopy(original(), MOMENT, { shape: 'same', captions: false, measure: null }).captions!.show).toBe(false)
    const silent = clipProject({ duration: 100 })
    expect(clipCopy(silent, MOMENT, { shape: 'same', captions: true, measure: null }).captions).toEqual(silent.captions)
  })

  it('a moment no longer in the video is refused', () => {
    const p = original({ clips: [{ id: 'a', start: 0, end: 10, speed: 1 }, { id: 'c', start: 60, end: 100, speed: 1 }] })
    expect(() => clipCopy(p, MOMENT, { shape: 'same', captions: true, measure: null })).toThrow(/no longer in the video/)
  })
})
