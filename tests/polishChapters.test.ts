/**
 * Polish's Find chapters step (docs/design/smart-tools.md §13.3, §0 decision 8; §22.1 tests 45 and
 * 121): on for new options, off for saved ones; it skips over the user's chapters, under 2 minutes
 * and without captions; it runs offline in Polish's one update; polishing twice changes nothing;
 * without words, or with number names only, it adds nothing; and its chapters change no badge
 * number and make no chapter-title card while they wait for review.
 */
import { describe, expect, it } from 'vitest'
import { polishChapters } from '../src/shared/chapters/chapterAuto'
import { DEFAULT_GREAT_OPTIONS } from '../src/shared/captions/great'
import { DEFAULT_POLISH_OPTIONS, planPolish, POLISH_STEPS, readPolishOptions, type PolishInput, type PolishOptions } from '../src/shared/editor/polish'
import { polishResultLines, polishSkipText, polishStepLabel } from '../src/shared/editor/polishCopy'
import { badgeLabels } from '../src/shared/render/callouts'
import type { Annotation, Chapter, Project } from '../src/shared/types'
import { chapterProject, scanOf, type Said } from './chapterFixtures'

const ONLY_CHAPTERS: PolishOptions = { ...DEFAULT_POLISH_OPTIONS, styleId: null, zoom: false, silences: false, smoothCuts: false, captions: false, chapters: true, captionLook: false, director: false }
const input = (project: Project, extra: Partial<PolishInput> = {}): PolishInput => ({
  project,
  recorded: { samples: [], clicks: [], keys: [], valid: false },
  sound: null,
  transcript: null,
  speech: null,
  framing: { status: 'skipped' },
  preset: null,
  ...extra
})

/** 3 minutes said in three parts, the screen changing page at 1:00 and 2:00. */
const SAID: Said[] = [
  { t: 1, text: 'Welcome to the billing tour.' },
  { t: 61, text: "Now let's set up billing, which takes a minute." },
  { t: 121, text: 'Finally we export the report.' }
]
const narrated = (extra: Partial<Project> = {}): Project => ({ ...chapterProject({ duration: 180, said: SAID }), ...extra })
const scan = scanOf(180, { 60.5: 62, 120.5: 70 })
const stepOf = (r: ReturnType<typeof planPolish>) => r.summary.steps.find((s) => s.step === 'chapters')

describe("Polish's Find chapters step (test 45)", () => {
  it('saved options without it read it as off; new options have it on; the label and the result line', () => {
    expect(readPolishOptions({ zoom: true, silences: true }).chapters).toBe(false)
    expect(readPolishOptions({ ...DEFAULT_POLISH_OPTIONS }).chapters).toBe(true)
    expect(DEFAULT_POLISH_OPTIONS.chapters).toBe(true)
    expect(POLISH_STEPS).toContain('chapters')
    expect(polishStepLabel('chapters')).toBe('Find chapters')
    expect(polishSkipText('chapters', 'has-chapters')).toBe('Your chapters are kept')
  })

  it('runs offline inside Polish\'s one update, by Polish, with the names said', () => {
    const r = planPolish(input(narrated(), { scan }), ONLY_CHAPTERS)
    expect(stepOf(r)).toEqual({ step: 'chapters', status: 'changed' })
    const found = r.project.chapters!
    expect(found.map((c) => [Math.round(c.t), c.title, c.auto!.by, c.auto!.name])).toEqual([
      [0, 'Welcome to the billing tour', 'polish', 'sentence'],
      [61, 'Set up billing', 'polish', 'sentence'],
      [121, 'Export the report', 'polish', 'sentence']
    ])
    expect(r.summary.chapters).toBe(3)
    expect(polishResultLines(r.summary).find((l) => l.step === 'chapters')!.text).toBe('Found 3 chapters')
  })

  it('polishing twice returns an equal project (the re-found chapters are kept as they are)', () => {
    const once = planPolish(input(narrated(), { scan }), ONLY_CHAPTERS).project
    const twice = planPolish(input(once, { scan }), ONLY_CHAPTERS)
    expect(twice.project).toBe(once)
    expect(stepOf(twice)).toEqual({ step: 'chapters', status: 'unchanged' })
  })

  it("skips over the user's chapters; found ones waiting for review do not count, and are replaced", () => {
    const mine: Chapter = { id: 'u', t: 0, title: 'Mine' }
    expect(stepOf(planPolish(input(narrated({ chapters: [mine] }), { scan }), ONLY_CHAPTERS))).toEqual({ step: 'chapters', status: 'skipped', reason: 'has-chapters' })
    const pending: Chapter = { id: 'p', t: 30, title: 'Old', auto: { by: 'find', from: ['pause'], name: 'cut' } }
    const r = planPolish(input(narrated({ chapters: [pending] }), { scan }), ONLY_CHAPTERS)
    expect(stepOf(r)?.status).toBe('changed')
    expect(r.project.chapters!.some((c) => c.id === 'p')).toBe(false)
    expect(r.project.chapters!.every((c) => c.auto?.by === 'polish')).toBe(true)
  })

  it('skips videos under 2 minutes and videos without captions', () => {
    const short = narrated({ clips: [{ id: 'c', start: 0, end: 119, speed: 1 }] })
    expect(stepOf(planPolish(input(short, { scan }), ONLY_CHAPTERS))).toEqual({ step: 'chapters', status: 'skipped', reason: 'short-video' })
    const silent = chapterProject({ duration: 180 })
    expect(stepOf(planPolish(input(silent, { scan }), ONLY_CHAPTERS))).toEqual({ step: 'chapters', status: 'skipped', reason: 'no-speech' })
  })

  it("the guards: its chapters restart no badge number and make no chapter-title card while they wait", () => {
    const badges = Array.from({ length: 8 }, (_, i) => ({ id: `b${i}`, start: 5 + i * 20, end: 8 + i * 20, text: '', x: 0.5, y: 0.5, size: 0.045, style: 'badge', number: 'auto' }) as unknown as Annotation)
    const p = narrated({ annotations: badges })
    const before = [...badgeLabels(p)]
    const options = { ...ONLY_CHAPTERS, captionLook: true }
    const r = planPolish(input(p, { scan, captionLook: { great: { ...DEFAULT_GREAT_OPTIONS, chapters: 'auto' }, cleanup: { fillers: false, repeats: false, numbers: false, caps: false, profanity: 'off' } as never, words: [] } }), options)
    expect(r.project.chapters!.length).toBe(3)
    expect([...badgeLabels(r.project)]).toEqual(before)
    expect((r.project.titles ?? []).filter((c) => c.auto?.by === 'chapter')).toEqual([])
  })
})

describe("Polish's guard without words (test 121)", () => {
  it("on a project without captions the step reports 'no-speech' and adds nothing", () => {
    const p = chapterProject({ duration: 180 })
    const r = planPolish(input(p, { scan }), ONLY_CHAPTERS)
    expect(stepOf(r)).toEqual({ step: 'chapters', status: 'skipped', reason: 'no-speech' })
    expect(r.project.chapters).toEqual([])
    // Captions with no words at all are no captions.
    const empty = { ...p, transcript: { provider: 'local' as const, model: 't', createdAt: '', segments: [{ id: 's', start: 1, end: 2, text: '  ' }] } }
    expect(stepOf(planPolish(input(empty, { scan }), ONLY_CHAPTERS))?.reason).toBe('no-speech')
  })

  it('with captions whose every name would be a number, it adds nothing', () => {
    // Said only in the last part: the parts at 0:00 and 1:00 hold no words, and "Okay." names nothing.
    const p = chapterProject({ duration: 180, said: [{ t: 170, text: 'Okay.' }] })
    const r = planPolish(input(p, { scan }), ONLY_CHAPTERS)
    expect(r.project).toBe(p)
    expect(stepOf(r)?.status).toBe('unchanged')
    expect(polishChapters(p, { ...input(p), scan })).toBe(p)
  })
})
