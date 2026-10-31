/**
 * Captions Studio test 46 (docs/design/captions-studio.md §11.8, §2.8): Polish's Caption look step,
 * and Auto style on the captions Polish makes (test 40's part).
 */
import { describe, expect, it, vi } from 'vitest'
import { DEFAULT_CLEANUP } from '../src/shared/captions/cleanup'
import { DEFAULT_GREAT_OPTIONS } from '../src/shared/captions/great'
import { DEFAULT_POLISH_OPTIONS, planPolish, readPolishOptions, type PolishInput, type PolishOptions } from '../src/shared/editor/polish'
import { polishHint, polishSkipText, polishStepLabel } from '../src/shared/editor/polishCopy'
import type { Project, Transcript } from '../src/shared/types'
import { captions, studioProject } from './p4Fixtures'

vi.mock('../src/shared/captions/words', async (o) => (await import('./p1Fillins')).fillWords(await o()))
vi.mock('../src/shared/captions/studioLayout', async (o) => (await import('./p1Fillins')).fillLayout(await o(), await import('../src/shared/captions/words')))
vi.mock('../src/shared/captions/studioEdit', async (o) => (await import('./p1Fillins')).fillEdit(await o()))

const TEXTS = ['today i show three ways to work faster', 'First, open the Settings page.', 'Second, turn on Auto Save.', 'Sales grew 300% this year.']
const ONLY: PolishOptions = { ...DEFAULT_POLISH_OPTIONS, styleId: null, zoom: false, silences: false, captions: false, captionLook: true, director: false }
const NO_INPUT = { samples: [], clicks: [], valid: true } as unknown as PolishInput['recorded']
const input = (project: Project, over: Partial<PolishInput> = {}): PolishInput => ({
  project,
  recorded: NO_INPUT,
  sound: null,
  transcript: null,
  speech: null,
  framing: { status: 'skipped' },
  preset: null,
  ...over
})
const step = (r: ReturnType<typeof planPolish>) => r.summary.steps.find((s) => s.step === 'captionLook')

describe("Polish's Caption look (test 46)", () => {
  it('saved options without the key read false; new installs have it on', () => {
    expect(readPolishOptions({ zoom: true }).captionLook).toBe(false)
    expect(DEFAULT_POLISH_OPTIONS.captionLook).toBe(true)
  })

  it('is skipped without captions, and when it is off', () => {
    expect(step(planPolish(input(studioProject()), ONLY))).toEqual({ step: 'captionLook', status: 'skipped', reason: 'no-captions' })
    expect(step(planPolish(input(studioProject({ segments: captions(TEXTS) })), { ...ONLY, captionLook: false }))).toEqual({ step: 'captionLook', status: 'skipped', reason: 'off' })
  })

  it('runs offline: no provider and no quotes whatever the saved options say', () => {
    const p = studioProject({ segments: captions(TEXTS), aspect: '9:16' })
    const look = { great: { ...DEFAULT_GREAT_OPTIONS, provider: 'p1', quotes: true }, cleanup: DEFAULT_CLEANUP, words: [] }
    const r = planPolish(input(p, { captionLook: look }), ONLY)
    expect(step(r)?.status).toBe('changed')
    expect((r.project.titles ?? []).some((t) => t.style === 'quote')).toBe(false)
    expect(r.project.captionAuto?.style?.by).toBe('polish')
  })

  it('in a wide frame adds no graphics whatever the options say; in a tall one it does', () => {
    const look = { great: { ...DEFAULT_GREAT_OPTIONS, counters: true, lists: true, emoji: true, keywords: true }, cleanup: DEFAULT_CLEANUP, words: [] }
    const wide = planPolish(input(studioProject({ segments: captions(TEXTS) }), { captionLook: look }), ONLY).project
    expect(wide.graphics).toBeUndefined()
    expect(wide.captionMarks?.length).toBeGreaterThan(0)
    expect(wide.captions?.studio?.from).toBe('subtitle')
    const tall = planPolish(input(studioProject({ segments: captions(TEXTS), aspect: '9:16' }), { captionLook: look }), ONLY).project
    expect(tall.graphics?.some((g) => g.kind === 'counter')).toBe(true)
  })

  it('the captions Polish makes get Auto style with no record', () => {
    const transcript: Transcript = { language: 'en', provider: 'local', model: 'm', createdAt: '', segments: captions(TEXTS) }
    const p = studioProject({ aspect: '9:16' })
    const r = planPolish(input(p, { transcript }), { ...ONLY, captions: true, captionLook: false })
    expect(r.project.captions?.studio?.from).toBe('clean-short')
    expect(r.project.captions?.show).toBe(true)
    expect(r.project.captionAuto).toBeUndefined()
  })

  it('has its label, hint and skip text', () => {
    expect(polishStepLabel('captionLook')).toBe('Caption look')
    expect(polishSkipText('captionLook', 'no-captions')).toBe('This video has no captions to style')
    const state = { silenceAction: 'cut' as const, autoZoomOn: false, provider: null }
    expect(polishHint('captionLook', state)).toBe('Style, emphasis and pop-ups for your captions.')
    expect(polishHint('captionLook', { ...state, wide: true })).toBe('Style, emphasis and tidy text for your captions.')
  })
})
