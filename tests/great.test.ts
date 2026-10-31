/**
 * Captions Studio test 42 (docs/design/captions-studio.md §11.8, §2.8): Make my captions great.
 */
import { describe, expect, it, vi } from 'vitest'
import { DEFAULT_CLEANUP } from '../src/shared/captions/cleanup'
import { DEFAULT_GREAT_OPTIONS, greatHint, greatNotice, planCaptionsGreat, readGreatOptions, resolveGreatOptions, type GreatSummary } from '../src/shared/captions/great'
import { DEFAULT_CAPTIONS } from '../src/shared/captions/settings'
import type { Project } from '../src/shared/types'
import { captions, studioProject, TALL, WIDE } from './p4Fixtures'

vi.mock('../src/shared/captions/words', async (o) => (await import('./p1Fillins')).fillWords(await o()))
vi.mock('../src/shared/captions/studioLayout', async (o) => (await import('./p1Fillins')).fillLayout(await o(), await import('../src/shared/captions/words')))
vi.mock('../src/shared/captions/studioEdit', async (o) => (await import('./p1Fillins')).fillEdit(await o()))

const TEXTS = [
  'today i will show you three ways to make reports faster',
  'First, open the Settings page and click Export.',
  'Second, turn on Auto Save so you never lose work.',
  'Finally, use the Search box to find any report.',
  'Last quarter our sign-ups grew 300% and revenue hit $1.2M.',
  'Click Save and you are done.'
]
const run = (p: Project, frame = TALL, over: Partial<typeof DEFAULT_GREAT_OPTIONS> = {}, by: 'great' | 'polish' = 'great') =>
  planCaptionsGreat({ project: p, frame, cleanup: DEFAULT_CLEANUP, words: [], by }, { ...DEFAULT_GREAT_OPTIONS, ...over })

describe('Make my captions great (test 42)', () => {
  it('reads saved options with defaults', () => {
    expect(readGreatOptions(undefined)).toEqual(DEFAULT_GREAT_OPTIONS)
    expect(readGreatOptions({ emoji: true, counters: false, sound: 'ding', provider: 'p1', quotes: 'x' })).toMatchObject({ emoji: true, counters: false, sound: 'ding', provider: 'p1', quotes: false })
  })

  it('resolves auto: a screen-led tall project has no emoji or keyword pop-ups but counters and lists', () => {
    const p = studioProject({ segments: captions(TEXTS) })
    expect(resolveGreatOptions(DEFAULT_GREAT_OPTIONS, p, TALL)).toMatchObject({ emoji: false, keywords: false, counters: true, lists: true, chapters: false })
    const cam = studioProject({ segments: captions(TEXTS), camera: 'large' })
    expect(resolveGreatOptions(DEFAULT_GREAT_OPTIONS, cam, TALL)).toMatchObject({ emoji: true, keywords: true })
    const wide = studioProject({ segments: captions(TEXTS), chapters: [{ id: 'a', t: 5, title: 'Go' }] })
    expect(resolveGreatOptions(DEFAULT_GREAT_OPTIONS, wide, WIDE)).toMatchObject({ emoji: false, counters: false, lists: false, chapters: true })
    expect(resolveGreatOptions({ ...DEFAULT_GREAT_OPTIONS, quotes: true }, wide, WIDE).quotes).toBe(false)
  })

  it('runs every step in one update: tidy, style, emphasis, graphics', () => {
    const p = studioProject({ segments: captions(TEXTS) })
    const { project, summary } = run(p)
    expect(project.transcript!.segments[0].text.startsWith('Today I will')).toBe(true)
    expect(project.captions?.studio?.from).toBe('clean-short')
    expect(project.captionAuto?.style).toEqual({ was: null, by: 'great', name: 'Clean Short' })
    expect(project.captionMarks?.length).toBeGreaterThan(0)
    expect(project.captionMarks!.every((m) => m.auto)).toBe(true)
    expect(project.graphics?.some((g) => g.kind === 'counter')).toBe(true)
    expect(project.graphics?.some((g) => g.kind === 'list')).toBe(true)
    expect(summary).toMatchObject({ style: 'Clean Short', tidied: 1, counters: 1, lists: 1, emoji: 0, keywords: 0 })
    expect(summary.emphasised).toBeGreaterThan(0)
  })

  it('a second run returns the same project object', () => {
    const p = studioProject({ segments: captions(TEXTS) })
    const once = run(p).project
    expect(run(once).project).toBe(once)
  })

  it('a second style change keeps the first record’s was', () => {
    const was = { ...DEFAULT_CAPTIONS, size: 0.045 }
    const p = studioProject({ segments: captions(TEXTS), captions: was })
    const tall = run(p, TALL).project
    expect(tall.captionAuto?.style?.was).toEqual(was)
    const wide = run(tall, WIDE).project
    expect(wide.captions?.studio?.from).toBe('subtitle')
    expect(wide.captionAuto?.style).toEqual({ was, by: 'great', name: 'Subtitle' })
  })

  it('never changes a picked look, and keeps the user’s marks', () => {
    const p = studioProject({ segments: captions(TEXTS), captions: { ...DEFAULT_CAPTIONS, picked: true }, captionMarks: [{ id: 'mine', caption: 'c5', from: 1, to: 1, text: 'Save' }] })
    const { project, summary } = run(p)
    // The look stays (only the Studio twin is added for the emphasis on a legacy look).
    expect(project.captions).toMatchObject(p.captions!)
    expect(summary.style).toBeNull()
    expect(project.captionMarks!.find((m) => m.id === 'mine')).toEqual({ id: 'mine', caption: 'c5', from: 1, to: 1, text: 'Save' })
    expect(project.captionMarks!.some((m) => m.caption === 'c5' && m.auto)).toBe(false)
  })

  it('emphasis on a legacy look makes the Studio twin in the same update', () => {
    const p = studioProject({ segments: captions(TEXTS), captions: { ...DEFAULT_CAPTIONS, preset: 'boxed', picked: true } })
    const { project } = run(p, TALL, { style: false })
    expect(project.captions?.studio?.layout.legacyAnchor).toBe(true)
    expect(project.captions?.picked).toBe(true)
  })

  it('Polish in a wide frame adds no graphics whatever the options say', () => {
    const p = studioProject({ segments: captions(TEXTS), chapters: [{ id: 'a', t: 5, title: 'Go' }] })
    const { project } = run(p, WIDE, { counters: true, lists: true, emoji: true, chapters: true }, 'polish')
    expect(project.graphics).toBeUndefined()
    expect(project.titles ?? []).toHaveLength(0)
    expect(project.captionAuto?.style?.by).toBe('polish')
    const tall = run(p, TALL, {}, 'polish').project
    expect(tall.graphics?.length).toBeGreaterThan(0)
  })

  it('returns the input when there is nothing to do', () => {
    const p = studioProject()
    expect(run(p).project).toBe(p)
  })

  it('the notice lists what changed, or says there was nothing', () => {
    const s: GreatSummary = { style: 'Bold Pop', emphasised: 38, emoji: 3, counters: 1, lists: 1, keywords: 0, lowerThirds: 0, chapters: 0, quotes: 0, tidied: 12, bleeped: 0 }
    expect(greatNotice(s)).toBe('Captions: Bold Pop, 38 words emphasised, 3 emoji, 1 counter, 1 list, 12 captions tidied. Review (Shift+R) · Undo')
    const none: GreatSummary = { style: null, emphasised: 0, emoji: 0, counters: 0, lists: 0, keywords: 0, lowerThirds: 0, chapters: 0, quotes: 0, tidied: 0, bleeped: 0 }
    expect(greatNotice(none)).toBe('Your captions already have all of this.')
    expect(greatNotice({ ...s, providerFailed: true })).toMatch(/The AI provider could not be reached, so Flown picked on this PC\.$/)
  })

  it('the hint follows the resolved options', () => {
    const p = studioProject({ segments: captions(TEXTS) })
    expect(greatHint(resolveGreatOptions(DEFAULT_GREAT_OPTIONS, p, TALL))).toBe("Adds a style for this video's shape, key words, counters, list cards and speaker names, and tidies the text.")
    expect(greatHint(resolveGreatOptions({ ...DEFAULT_GREAT_OPTIONS, style: false, emphasis: false, speakers: false, tidy: false }, p, WIDE))).toBe('Choose what it does in its options.')
  })
})
