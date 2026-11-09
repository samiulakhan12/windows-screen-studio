/**
 * Step titles (docs/design/smart-tools.md §5.2, §5.3): tests 18–20 and 22 of §22.1.
 */
import { describe, expect, it } from 'vitest'
import { createProject } from '../src/shared/engine/project'
import { withAiTitles, withStepEdit, withoutAiTitles } from '../src/shared/guide/guideEdit'
import type { GuideStep } from '../src/shared/guide/steps'
import { guideSegments, namesRequestForSteps, needsTitle, narrationObject, shownTitles, stepAction, stepTitle, type TitleFrom } from '../src/shared/guide/stepTitles'
import { validateNamesAnswer } from '../src/shared/captions/transcriptText'
import type { CaptionSegment, Project } from '../src/shared/types'

function project(segments: CaptionSegment[], language = 'en', patch: Partial<Project> = {}): Project {
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
  return { ...p, transcript: { language, provider: 'local', model: 'test', createdAt: '2026-11-07T00:00:00Z', segments }, ...patch }
}

const seg = (id: string, start: number, end: number, text: string): CaptionSegment => ({ id, start, end, text })
const click = (t: number, extra: Partial<GuideStep> = {}): GuideStep => ({ key: `c${Math.round(t * 1000)}`, t, kind: 'click', x: 0.5, y: 0.5, ...extra })

function title(p: Project, step: GuideStep, extra: Partial<Parameters<typeof stepTitle>[1]> = {}) {
  return stepTitle(step, {
    segments: guideSegments(p),
    language: extra.language ?? 'en',
    transcriptLanguage: p.transcript?.language,
    digits: extra.digits,
    target: 'screen',
    scale: 1,
    height: 1080,
    ...extra
  })
}

describe('test 18: titles from the narration (English)', () => {
  it('"so now click the Export button" at the click gives Click “Export”', () => {
    const p = project([seg('a', 1.5, 3.5, 'so now click the Export button')])
    expect(title(p, click(3))).toEqual({ title: 'Click “Export”', from: 'narration' })
  })

  it('"open Visual Studio Code" names “Visual Studio Code”', () => {
    const p = project([seg('a', 9, 11, 'then open Visual Studio Code here')])
    expect(narrationObject(10, guideSegments(p), 'en')).toBe('Visual Studio Code')
    expect(title(p, click(10)).title).toBe('Click “Visual Studio Code”')
  })

  it('the nearest of two objects wins', () => {
    const p = project([seg('a', 0, 4, 'click Settings and then click Billing')])
    // Words spread over 0–4 s: "Settings" near 0.6 s, "Billing" near 3.6 s.
    expect(title(p, click(3.5)).title).toBe('Click “Billing”')
    expect(title(p, click(0.8)).title).toBe('Click “Settings”')
  })

  it('an object that is a URL, a path, a stop word or "2024" is refused', () => {
    for (const text of ['open example.com now', 'open C:\\Users\\sam\\notes now', 'click it now', 'select 2024 now', 'click the button now']) {
      const p = project([seg('a', 2, 4, text)])
      expect(title(p, click(3)).from, text).not.toBe('narration')
    }
  })

  it('a double-click and a repeat get their own verbs; typing and the key after it are added', () => {
    const p = project([seg('a', 7, 9, 'now open Quarterly Report here'), seg('b', 19, 21, 'click Next a few times'), seg('c', 29, 31, 'click Search')])
    expect(title(p, { ...click(8), kind: 'double' }).title).toBe('Double-click “Quarterly Report”')
    expect(title(p, click(20, { times: 3 })).title).toBe('Click “Next” 3 times')
    expect(title(p, click(30, { typing: { t: 31, end: 33, place: { x: 0.5, y: 0.5 } }, then: 'Enter' })).title).toBe('Click “Search” and type and press Enter')
    expect(title(p, { ...click(20), kind: 'right' }).title).toBe('Right-click “Next”')
    expect(title(p, { ...click(20), kind: 'drag', to: { x: 0.9, y: 0.9 } }).title).toBe('Drag “Next”')
  })

  it('cut words are not read', () => {
    const timed: CaptionSegment = {
      ...seg('a', 1.5, 3.5, 'so now click the Export button'),
      words: [
        { text: 'so', start: 1.5, end: 1.8 },
        { text: 'now', start: 1.8, end: 2.1 },
        { text: 'click', start: 2.1, end: 2.4 },
        { text: 'the', start: 2.4, end: 2.6 },
        { text: 'Export', start: 2.6, end: 3.0 },
        { text: 'button', start: 3.0, end: 3.3 }
      ]
    }
    expect(title(project([timed]), click(3.6)).title).toBe('Click “Export”')
    const p = project([timed], 'en', {
      clips: [
        { id: 'x', start: 0, end: 2.5, speed: 1 },
        { id: 'y', start: 3.4, end: 60, speed: 1 }
      ]
    })
    expect(title(p, click(3.6)).from).not.toBe('narration')
  })

  it('a scroll before the step leads it, in lower case', () => {
    const p = project([seg('a', 1.5, 3.5, 'so now click the Export button')])
    expect(title(p, click(3, { scroll: 'down' })).title).toBe('Scroll down, then click “Export”')
  })
})

describe('test 19: titles in Bangla and Hindi', () => {
  it('"রপ্তানি বোতামে ক্লিক করুন" gives “রপ্তানি”-এ ক্লিক করুন', () => {
    const p = project([seg('a', 2, 4, 'রপ্তানি বোতামে ক্লিক করুন')], 'bn')
    expect(title(p, click(3), { language: 'bn', digits: 'native' })).toEqual({ title: '“রপ্তানি”-এ ক্লিক করুন', from: 'narration' })
  })

  it('"Export-এ ক্লিক করুন" gives “Export”-এ ক্লিক করুন', () => {
    const p = project([seg('a', 2, 4, 'Export-এ ক্লিক করুন')], 'bn')
    expect(title(p, click(3), { language: 'bn' }).title).toBe('“Export”-এ ক্লিক করুন')
  })

  it('Hindi "Export बटन पर क्लिक करें" names Export', () => {
    const p = project([seg('a', 2, 4, 'Export बटन पर क्लिक करें')], 'hi')
    expect(narrationObject(3, guideSegments(p), 'hi')).toBe('Export')
  })

  it('Bangla digits in "ধাপ ৩"', () => {
    const p = project([], 'bn')
    expect(title(p, { key: 's5000', t: 5, kind: 'screen' }, { language: 'bn', digits: 'native', n: '৩' })).toEqual({ title: 'ধাপ ৩', from: 'template' })
    const shown = shownTitles(p, [{ key: 's5000', t: 5, kind: 'screen' }], ['৩'])
    expect(shown[0].title).toBe('ধাপ ৩')
  })
})

describe('test 20: fallbacks and their source', () => {
  const p = project([])

  it('the cursor: a text cursor, a hand', () => {
    expect(title(p, click(3, { shape: 'text', x: 0.9, y: 0.1 }))).toEqual({ title: 'Click in the text field near the top right', from: 'cursor' })
    expect(title(p, click(3, { shape: 'pointer', x: 0.1, y: 0.5 }))).toEqual({ title: 'Click the link or button near the left', from: 'cursor' })
  })

  it('the taskbar: the bottom 48 px of a whole-screen recording at scale 1', () => {
    expect(title(p, click(3, { x: 0.1, y: (1080 - 47) / 1080 }))).toEqual({ title: 'Click on the taskbar, on the left', from: 'taskbar' })
    expect(title(p, click(3, { x: 0.1, y: (1080 - 49) / 1080 })).from).toBe('place')
    // At 150% the taskbar is 72 px high.
    expect(title(p, click(3, { x: 0.9, y: (1080 - 70) / 1080 }), { scale: 1.5 }).title).toBe('Click on the taskbar, on the right')
    // Not for a window or an area.
    expect(title(p, click(3, { x: 0.1, y: (1080 - 10) / 1080 }), { target: 'window' }).from).toBe('place')
  })

  it('thirds give the nine places', () => {
    const at = (x: number, y: number) => title(p, click(3, { x, y }))
    expect([at(0.1, 0.1), at(0.5, 0.1), at(0.9, 0.1), at(0.1, 0.5), at(0.5, 0.5), at(0.9, 0.5), at(0.1, 0.8), at(0.5, 0.8), at(0.9, 0.8)].map((t) => t.title)).toEqual([
      'Click near the top left',
      'Click near the top',
      'Click near the top right',
      'Click near the left',
      'Click in the middle',
      'Click near the right',
      'Click near the bottom left',
      'Click near the bottom',
      'Click near the bottom right'
    ])
    expect(at(0.5, 0.5).from).toBe('place')
    expect(title(p, { ...click(3, { x: 0.1, y: 0.1 }), kind: 'drag', to: { x: 0.5, y: 0.5 } }).title).toBe('Drag from the top left to the middle')
    expect(title(p, { key: 't3000', t: 3, kind: 'type', typing: { t: 3, end: 5, place: { x: 0.5, y: 0.5 } } }).title).toBe('Type your text')
  })

  it('keys: Press Ctrl + S', () => {
    expect(title(p, { key: 'k3000', t: 3, kind: 'keys', keys: 'Ctrl + S' })).toEqual({ title: 'Press Ctrl + S', from: 'keys' })
    expect(title(p, { key: 'k3000', t: 3, kind: 'keys', keys: 'Tab', times: 3 }).title).toBe('Press Tab 3 times')
  })

  it('screen, badge and added steps: the sentence said after them, else cut short, else a number', () => {
    const q = project([seg('a', 12.4, 14, 'Next we open settings.'), seg('b', 30, 34, 'Configuration')])
    expect(title(q, { key: 's12000', t: 12, kind: 'screen' })).toEqual({ title: 'Open settings', from: 'sentence' })
    expect(title(q, { key: 's30000', t: 30, kind: 'screen' })).toEqual({ title: 'Configuration', from: 'cut' })
    expect(title(q, { key: 's50000', t: 50, kind: 'screen' }, { n: '7' })).toEqual({ title: 'Step 7', from: 'template' })
  })

  it('needsTitle is true for cut, cursor, taskbar, place and template only', () => {
    const all: TitleFrom[] = ['narration', 'keys', 'sentence', 'cut', 'cursor', 'taskbar', 'place', 'template']
    expect(all.filter(needsTitle)).toEqual(['cut', 'cursor', 'taskbar', 'place', 'template'])
  })
})

describe('test 22: AI titles', () => {
  const p = project([seg('a', 1.5, 3.5, 'now click the Export button, see example.com or C:\\Users\\sam'), seg('b', 20, 22, 'and save it')])
  const steps: GuideStep[] = [click(3), click(12), { key: 'k21000', t: 21, kind: 'keys', keys: 'Ctrl + S' }]

  it('namesRequestForSteps sends only unedited steps that have words, their action and 600 characters of words', () => {
    const edited = withStepEdit(p, 'k21000', { title: 'Save the report' })
    const request = namesRequestForSteps(edited, steps, 'step')
    expect(request.kind).toBe('step')
    expect(request.language).toBe('en')
    expect(request.items.map((i) => i.id)).toEqual(['c3000'])
    expect(request.items[0].action).toBe('click, middle of the screen')
    expect(request.items[0].text).toContain('click the Export button')
    expect(request.items[0].image).toBeUndefined()
    const long = project([seg('a', 0, 8, 'word '.repeat(400).trim())])
    expect(namesRequestForSteps(long, [click(4)], 'step').items[0].text.length).toBeLessThanOrEqual(600)
    // No screenshot, no file name, no window title: only id, text and action.
    expect(Object.keys(request.items[0]).sort()).toEqual(['action', 'id', 'text'])
  })

  it('a returned title holding "example.com" or "C:\\Users\\sam" is dropped, even though the words sent held it', () => {
    const request = namesRequestForSteps(p, steps, 'step')
    const answer = { names: [{ id: 'c3000', name: 'Open example.com' }] }
    expect(() => validateNamesAnswer(answer, request)).toThrow()
    expect(validateNamesAnswer({ names: [{ id: 'c3000', name: 'Click Export' }, { id: 'k21000', name: 'Save C:\\Users\\sam' }] }, { ...request, items: [...request.items, { id: 'k21000', text: 'x' }] })).toEqual([{ id: 'c3000', name: 'Click Export' }])
  })

  it('`ai` is set by a run and cleared by a hand edit; Use offline titles is one update', () => {
    const withAi = withAiTitles(p, [{ key: 'c3000', title: 'Click Export' }], 'openai')
    expect(withAi.guide!.steps).toEqual([{ key: 'c3000', title: 'Click Export', ai: 'openai' }])
    const shown = shownTitles(withAi, steps, ['1', '2', '3'])
    expect(shown[0]).toMatchObject({ title: 'Click Export', own: true, ai: 'openai' })
    const hand = withStepEdit(withAi, 'c3000', { title: 'Click Export now' })
    expect(hand.guide!.steps).toEqual([{ key: 'c3000', title: 'Click Export now' }])
    // An AI title may be written again; a hand edit is never sent.
    expect(namesRequestForSteps(withAi, steps, 'step').items.map((i) => i.id)).toContain('c3000')
    expect(namesRequestForSteps(hand, steps, 'step').items.map((i) => i.id)).not.toContain('c3000')
    const offline = withoutAiTitles(withAi)
    expect(offline.guide).toBeUndefined()
  })

  it('stepAction names the action in words', () => {
    expect(stepAction(click(3, { x: 0.9, y: 0.1 }))).toBe('click, top right of the screen')
    expect(stepAction({ key: 'k1', t: 1, kind: 'keys', keys: 'Ctrl + S' })).toBe('press Ctrl + S')
    expect(stepAction(click(3, { x: 0.5, y: 0.1, typing: { t: 4, end: 5, place: { x: 0.5, y: 0.1 } } }))).toBe('type after clicking near the top')
  })
})
