/**
 * Captions Studio test 42 (docs/design/captions-studio.md §11.8, §2.8): Make my captions great.
 */
import { describe, expect, it, vi } from 'vitest'
import { settleCaptionAuto } from '../src/shared/captions/captionAutoSettle'
import { DEFAULT_CLEANUP } from '../src/shared/captions/cleanup'
import { DEFAULT_GREAT_OPTIONS, greatHint, greatNotice, planCaptionsGreat, readGreatOptions, resolveGreatOptions, type GreatSummary } from '../src/shared/captions/great'
import { DEFAULT_CAPTIONS } from '../src/shared/captions/settings'
import { studioWordTexts } from '../src/shared/captions/words'
import { chordFromEvent, DEFAULT_KEYMAP, matchShortcut, shortcutIndex, undoHint } from '../src/shared/editor/shortcuts'
import type { Graphic, Project } from '../src/shared/types'
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

  it('emphasis picked on words the tidy joined stays on them through the store’s settle', () => {
    const p = studioProject({ segments: captions(['we have twenty five new Export options today', 'we grew one hundred and twenty users and our Revenue increased']) })
    const { project } = run(p, WIDE)
    expect(project.transcript!.segments[1].text).toBe('we grew 120 users and our Revenue increased.')
    const on = (q: Project): string[] => (q.captionMarks ?? []).map((m) => `${m.caption}:${m.from}-${m.to} ${m.text}`)
    expect(on(project)).toContain('c1:6-6 Revenue')
    const words = new Map(project.transcript!.segments.map((s) => [s.id, studioWordTexts(s.text, 'en')]))
    for (const m of project.captionMarks!) expect(words.get(m.caption)!.slice(m.from, m.to + 1).join(' ')).toBe(m.text)
    // The Editor's store settles every update against the project before it: the marks stay on their words.
    expect(on(settleCaptionAuto(project, p))).toEqual(on(project))
  })

  it('the user’s marks and anchored graphics move onto the tidied words before anything is picked', () => {
    const graphic: Graphic = { id: 'g-mine', kind: 'emoji', start: 4, end: 5, place: 'auto', size: 0.12, enter: { kind: 'pop', duration: 0.24, strength: 1 }, exit: { kind: 'fade', duration: 0.18, strength: 1 }, emoji: '1f4c8', anchor: { caption: 'c1', from: 9, to: 9, text: 'Revenue' } }
    const p = studioProject({
      segments: captions(['we have twenty five new Export options today', 'we grew one hundred and twenty users and our Revenue increased']),
      captionMarks: [{ id: 'mine', caption: 'c1', from: 9, to: 9, text: 'Revenue' }],
      graphics: [graphic]
    })
    const { project } = run(p, WIDE)
    expect(project.captionMarks!.find((m) => m.id === 'mine')).toEqual({ id: 'mine', caption: 'c1', from: 6, to: 6, text: 'Revenue' })
    const g = project.graphics!.find((x) => x.id === 'g-mine')
    expect(g?.kind === 'emoji' && g.anchor).toEqual({ caption: 'c1', from: 6, to: 6, text: 'Revenue' })
    expect(settleCaptionAuto(project, p).captionMarks!.find((m) => m.id === 'mine')).toMatchObject({ from: 6, to: 6, text: 'Revenue' })
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
    expect(greatNotice(s, undoHint(DEFAULT_KEYMAP))).toBe('Captions: Bold Pop, 38 words emphasised, 3 emoji, 1 counter, 1 list, 12 captions tidied · Ctrl + Z to undo')
    const none: GreatSummary = { style: null, emphasised: 0, emoji: 0, counters: 0, lists: 0, keywords: 0, lowerThirds: 0, chapters: 0, quotes: 0, tidied: 0, bleeped: 0 }
    expect(greatNotice(none, undoHint(DEFAULT_KEYMAP))).toBe('Your captions already have all of this.')
    expect(greatNotice({ ...s, providerFailed: true }, undoHint(DEFAULT_KEYMAP))).toBe(
      'Captions: Bold Pop, 38 words emphasised, 3 emoji, 1 counter, 1 list, 12 captions tidied · Ctrl + Z to undo. The AI provider could not be reached, so Flown picked on this PC.'
    )
    // Without an undo shortcut the notice just lists what changed.
    expect(greatNotice({ ...s, providerFailed: true })).toBe('Captions: Bold Pop, 38 words emphasised, 3 emoji, 1 counter, 1 list, 12 captions tidied. The AI provider could not be reached, so Flown picked on this PC.')
  })

  it('the notice asks for no key that runs another command: Shift+R is Hold the view until Review mode comes (phase B)', () => {
    const s: GreatSummary = { style: 'Bold Pop', emphasised: 38, emoji: 3, counters: 1, lists: 1, keywords: 0, lowerThirds: 0, chapters: 0, quotes: 0, tidied: 12, bleeped: 0 }
    const shiftR = { key: 'R', code: 'KeyR', ctrlKey: false, shiftKey: true, altKey: false, metaKey: false }
    expect(matchShortcut(shortcutIndex(DEFAULT_KEYMAP), chordFromEvent(shiftR)!)).toBe('holdView')
    for (const notice of [greatNotice(s, undoHint(DEFAULT_KEYMAP)), greatNotice({ ...s, providerFailed: true }, undoHint(DEFAULT_KEYMAP))]) expect(notice).not.toMatch(/Shift\+R|Review|· Undo/)
  })

  it('the hint follows the resolved options', () => {
    const p = studioProject({ segments: captions(TEXTS) })
    expect(greatHint(resolveGreatOptions(DEFAULT_GREAT_OPTIONS, p, TALL))).toBe("Adds a style for this video's shape, key words, counters, list cards and speaker names, and tidies the text.")
    expect(greatHint(resolveGreatOptions({ ...DEFAULT_GREAT_OPTIONS, style: false, emphasis: false, speakers: false, tidy: false }, p, WIDE))).toBe('Choose what it does in its options.')
  })
})
