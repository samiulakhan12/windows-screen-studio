/**
 * The note under each step (docs/design/smart-tools.md §5.4): tests 21 and 108 (its pure parts:
 * *Use everything I said*, what *Tidy notes* sends and writes) of §22.1.
 */
import { describe, expect, it } from 'vitest'
import { createProject } from '../src/shared/engine/project'
import { withAiNotes, withStepEdit } from '../src/shared/guide/guideEdit'
import type { GuideStep } from '../src/shared/guide/steps'
import { namesRequestForSteps, stepText } from '../src/shared/guide/stepTitles'
import type { Bleep, CaptionSegment, Clip, Project } from '../src/shared/types'

/** A caption with each word timed: words share the caption's time by their order. */
function timed(id: string, start: number, end: number, text: string): CaptionSegment {
  const parts = text.split(' ')
  const d = (end - start) / parts.length
  return { id, start, end, text, words: parts.map((w, i) => ({ text: w, start: start + i * d, end: start + (i + 1) * d - 0.01 })) }
}

const SEGMENTS = [
  timed('a', 1.0, 3.0, 'Um, this is the billing page.'),
  timed('b', 3.5, 5.0, 'We open the report.'),
  timed('c', 5.2, 7.0, 'We open the monthly report.'),
  timed('d', 7.5, 8.5, 'It has every invoice.'),
  timed('e', 9.0, 10.5, 'Now click the Export button.'),
  timed('f', 12.0, 13.0, 'It saves a file.')
]

function project(patch: Partial<Project> = {}, segments = SEGMENTS): Project {
  const p = createProject({
    id: 'p',
    name: 'Billing',
    duration: 60,
    width: 1920,
    height: 1080,
    hasWebcam: false,
    hasAudio: true,
    webcamOffset: 0,
    zooms: [],
    cursorValid: true,
    capture: { method: 'native', cursorInVideo: false, region: null, target: 'screen', fps: 60 }
  })
  return { ...p, transcript: { language: 'en', provider: 'local', model: 'test', createdAt: '2026-11-07T00:00:00Z', segments }, ...patch }
}

const steps: GuideStep[] = [
  { key: 'c500', t: 0.5, kind: 'click', x: 0.2, y: 0.2 },
  { key: 'c10000', t: 10, kind: 'click', x: 0.5, y: 0.5 },
  { key: 'k14000', t: 14, kind: 'keys', keys: 'Ctrl + S' }
]

describe('test 21: stepText', () => {
  it('the short note leaves out fillers, the earlier take of a retake and the title’s sentence; two whole sentences', () => {
    const note = stepText(steps, 1, project(), false)
    expect(note).toBe('this is the billing page. We open the monthly report.')
    expect(note).not.toMatch(/\bUm\b/)
    expect(note).not.toContain('Export')
  })

  it('the short note is at most 300 characters and ends at a sentence end', () => {
    const words = (tag: string): string => Array.from({ length: 40 }, (_, i) => `${tag}${String.fromCharCode(97 + (i % 26))}${i}`).join(' ')
    const long = [timed('a', 1, 4, `${words('w')} one.`), timed('b', 4.5, 8, `${words('o')} two.`)]
    const note = stepText(steps, 1, project({}, long), false)
    expect(note.length).toBeLessThanOrEqual(300)
    expect(note.endsWith('one.')).toBe(true)
  })

  it('with full: every kept word since the previous step, whole sentences, at most 1,000 characters', () => {
    const full = stepText(steps, 1, project(), true)
    expect(full).toBe('Um, this is the billing page. We open the report. We open the monthly report. It has every invoice. Now click the Export button.')
    const long = Array.from({ length: 30 }, (_, i) => timed(`s${i}`, 0.6 + i * 0.3, 0.6 + i * 0.3 + 0.29, `${'Sentence words '.repeat(3).trim()} ${i}.`))
    const capped = stepText([steps[0], { ...steps[1], t: 10 }], 1, project({}, long), true)
    expect(capped.length).toBeLessThanOrEqual(1000)
    expect(capped.endsWith('.')).toBe(true)
  })

  it('the first step reads from the start of the recording', () => {
    expect(stepText(steps, 0, project(), true)).toBe('Um, this is the billing page.')
    expect(stepText([{ ...steps[1] }], 0, project(), true)).toContain('billing page')
    expect(stepText([{ ...steps[1] }], 0, project(), true)).toContain('Export')
  })

  it('cut words are out and bleeped words masked in both', () => {
    const clips: Clip[] = [
      { id: 'x', start: 0, end: 7.4, speed: 1 },
      { id: 'y', start: 8.6, end: 60, speed: 1 }
    ]
    const bleeps: Bleep[] = [{ id: 'b1', start: 6.25, end: 6.68, word: 'monthly', sound: 'tone' }]
    const p = project({ clips, bleeps })
    for (const full of [false, true]) {
      const note = stepText(steps, 1, p, full)
      expect(note).not.toContain('invoice')
      expect(note).not.toContain('monthly')
      expect(note).toMatch(/m\*+/)
    }
  })
})

describe('test 108: notes', () => {
  it('Use everything I said sets full', () => {
    const p = withStepEdit(project(), 'c10000', { full: true })
    expect(p.guide!.steps).toEqual([{ key: 'c10000', full: true }])
    expect(withStepEdit(p, 'c10000', { full: undefined }).guide).toBeUndefined()
  })

  it('Tidy notes sends kind note with each step’s full words and its title', () => {
    const request = namesRequestForSteps(project(), steps, 'note')
    expect(request.kind).toBe('note')
    const item = request.items.find((i) => i.id === 'c10000')!
    expect(item.text).toBe(stepText(steps, 1, project(), true))
    expect(item.action).toBe('Click “Export”')
    expect(item.image).toBeUndefined()
  })

  it('writes textAi; a hand edit clears it', () => {
    const p = withAiNotes(project(), [{ key: 'c10000', text: 'Open the monthly report.' }], 'local')
    expect(p.guide!.steps).toEqual([{ key: 'c10000', text: 'Open the monthly report.', textAi: 'local' }])
    expect(withStepEdit(p, 'c10000', { text: 'Mine.' }).guide!.steps).toEqual([{ key: 'c10000', text: 'Mine.' }])
  })
})
