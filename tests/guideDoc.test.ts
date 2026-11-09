/**
 * The guide's document (docs/design/smart-tools.md §5.6): tests 113 and the document side of 109,
 * 111 and 114 of §22.1.
 */
import { describe, expect, it } from 'vitest'
import { createProject } from '../src/shared/engine/project'
import { ACTUAL_KEY, buildGuideDoc, bugDetails, defaultDetails, demoHotspot, stepNumbers, type GuideImage } from '../src/shared/guide/guideDoc'
import { withGuideFields, withStepEdit } from '../src/shared/guide/guideEdit'
import { guideHtml } from '../src/shared/guide/guideHtml'
import { guideMarkdown } from '../src/shared/guide/guideMarkdown'
import { planShot, shotSize } from '../src/shared/guide/shots'
import type { GuideStep } from '../src/shared/guide/steps'
import type { Project } from '../src/shared/types'

function project(patch: Partial<Project> = {}): Project {
  const p = createProject({
    id: 'p',
    name: 'Billing',
    duration: 252,
    width: 1920,
    height: 1080,
    hasWebcam: false,
    hasAudio: true,
    webcamOffset: 0,
    zooms: [],
    cursorValid: true,
    capture: { method: 'native', cursorInVideo: false, region: null, target: 'screen', fps: 60 }
  })
  return { ...p, createdAt: '2026-11-07T12:00:00.000Z', ...patch }
}

const img = (w = 960, h = 540): GuideImage => ({ bytes: new Uint8Array([0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a]), mime: 'image/png', width: w, height: h })
const steps: GuideStep[] = [
  { key: 'c3000', t: 3, kind: 'click', x: 0.3, y: 0.4 },
  { key: 'k30000', t: 30, kind: 'keys', keys: 'Ctrl + S' },
  { key: 'c40000', t: 40, kind: 'click', x: 0.9, y: 0.9 }
]

describe('the document', () => {
  it('numbers, labels, titles, alt texts and images of the included steps', () => {
    const p = withStepEdit(project(), 'k30000', { hidden: true })
    const d = buildGuideDoc(p, steps, new Map([['c3000', img()]]), null)
    expect(d.title).toBe('Billing')
    expect(d.steps.map((s) => [s.n, s.label, s.title, s.alt])).toEqual([
      ['1', 'Step 1', 'Click near the left', 'Step 1: Click near the left'],
      ['2', 'Step 2', 'Click near the bottom right', 'Step 2: Click near the bottom right']
    ])
    expect(d.steps[0].image).not.toBeNull()
    expect(d.steps[1].image).toBeNull()
  })

  it('Bangla digits and words for a Bangla guide', () => {
    const p = withGuideFields(project(), { language: 'bn' })
    const d = buildGuideDoc(p, steps, new Map(), null)
    expect(d.lang).toBe('bn')
    expect(d.steps.map((s) => s.label)).toEqual(['ধাপ ১', 'ধাপ ২', 'ধাপ ৩'])
    expect(d.steps[1].title).toBe('Ctrl + S চাপুন')
  })

  it('steps between badges are numbered 3.1, 3.2 when included (test 111)', () => {
    const list: GuideStep[] = [
      { key: 'b2000', t: 2, kind: 'badge', badge: { label: '3' } },
      { key: 'c4000', t: 4, kind: 'click', x: 0.5, y: 0.5, hiddenByDefault: true },
      { key: 'c5000', t: 5, kind: 'click', x: 0.5, y: 0.5, hiddenByDefault: true },
      { key: 'b8000', t: 8, kind: 'badge', badge: { label: '4', section: 'Billing' } }
    ]
    let p = project()
    expect(stepNumbers(p, list)).toEqual(['3', '', '', '4'])
    p = withStepEdit(p, 'c4000', { shown: true })
    p = withStepEdit(p, 'c5000', { shown: true })
    expect(stepNumbers(p, list)).toEqual(['3', '3.1', '3.2', '4'])
    const d = buildGuideDoc(p, list, new Map(), null)
    expect(d.steps.map((s) => s.n)).toEqual(['3', '3.1', '3.2', '4'])
    expect(d.steps[3].section).toBe('Billing')
    expect(stepNumbers(withGuideFields(p, { language: 'bn' }), list)).toEqual(['3', '3.১', '3.২', '4'])
  })

  it('the demo’s hotspot: the whole screen, or the zoomed shot with demoZoom (test 109)', () => {
    const p = project()
    expect(demoHotspot(steps[0], p, undefined)).toEqual({ x: 0.3, y: 0.4 })
    const zoomed = demoHotspot(steps[0], p, { key: 'c3000', demoZoom: true })!
    // Zoomed to 950 px around the click: the click is in the middle of the shot.
    expect(zoomed.x).toBeCloseTo(0.5, 6)
    expect(zoomed.y).toBeCloseTo(0.5, 6)
    expect(demoHotspot(steps[1], p, undefined)).toBeUndefined()
    const d = buildGuideDoc(p, steps, new Map(), null)
    expect(d.steps[0].hotspot).toEqual({ x: 0.3, y: 0.4 })
    expect(d.steps[1].hotspot).toBeUndefined()
  })

  it('a zoomed demo shot recorded at 150%: the hotspot sits on the ring its picture draws', () => {
    const list: GuideStep[] = [
      { key: 'c3000', t: 3, kind: 'click', x: 0.94, y: 0.5 },
      { key: 'c4000', t: 4, kind: 'click', x: 0.3, y: 0.4 }
    ]
    let p = project()
    for (const s of list) p = withStepEdit(p, s.key, { demoZoom: true })
    const d = buildGuideDoc(p, list, new Map(), null, 1.5)
    list.forEach((s, i) => {
      const plan = planShot(s, p, p.guide!.steps!.find((e) => e.key === s.key), 1.5, 'demo')
      const out = shotSize(plan.rect)
      expect(d.steps[i].hotspot!.x).toBeCloseTo(plan.ring!.cx / out.w, 2)
      expect(d.steps[i].hotspot!.y).toBeCloseTo(plan.ring!.cy / out.h, 2)
    })
  })
})

describe('test 113: bug report', () => {
  it('Details lists the recording date, the size and scale, and the length', () => {
    expect(defaultDetails(project(), 1.5)).toEqual(['Recorded on 7 November 2026', 'Screen 1920 × 1080 at 150%', 'Length 4:12'])
    expect(defaultDetails(withGuideFields(project(), { language: 'bn' }), 1)).toEqual(['রেকর্ড করা হয়েছে ৭ নভেম্বর, ২০২৬', 'স্ক্রিন ১৯২০ × ১০৮০, ১০০%', 'দৈর্ঘ্য ৪:১২'])
  })

  it('each detail removable and editable', () => {
    const p = withGuideFields(project(), {
      kind: 'bug',
      details: [{ text: 'Recorded on 7 November 2026' }, { text: 'Screen 1920 × 1080 at 150% (Windows 11)' }, { text: 'Length 4:12', off: true }]
    })
    expect(bugDetails(p)).toEqual(['Recorded on 7 November 2026', 'Screen 1920 × 1080 at 150% (Windows 11)'])
    expect(buildGuideDoc(p, steps, new Map(), null).bug!.details).toEqual(bugDetails(p))
  })

  it('the Actual screen stores actualAt and every format shows its screenshot', () => {
    const p = withGuideFields(project(), { kind: 'bug', expected: 'A report', actual: 'An error', actualAt: 41.5 })
    expect(p.guide!.actualAt).toBe(41.5)
    const d = buildGuideDoc(p, steps, new Map([[ACTUAL_KEY, img()]]), null)
    expect(d.bug).toMatchObject({ expected: 'A report', actual: 'An error' })
    expect(d.bug!.actualImage).not.toBeNull()
    expect(guideMarkdown(d).images).toContain('actual.png')
    expect(guideHtml(d, { demo: false, print: false, fonts: [] })).toContain('alt="Actual"')
    expect(guideHtml(d, { demo: false, print: true, fonts: [] })).toContain('alt="Actual"')
    expect(guideHtml(d, { demo: false, print: false, clipboard: true, fonts: [] })).toContain('alt="Actual"')
    // Without actualAt, no Actual screenshot.
    const none = buildGuideDoc(withGuideFields(p, { actualAt: undefined }), steps, new Map([[ACTUAL_KEY, img()]]), null)
    expect(none.bug!.actualImage).toBeNull()
  })
})

describe('test 114: the brand kit in the document', () => {
  const brand = { logo: img(120, 40), colour: '#b00020' }
  it('with a kit, the logo and colour; unticked, neither', () => {
    expect(buildGuideDoc(project(), steps, new Map(), brand).brand).toEqual(brand)
    expect(buildGuideDoc(withGuideFields(project(), { brand: false }), steps, new Map(), brand).brand).toBeUndefined()
    expect(buildGuideDoc(project(), steps, new Map(), null).brand).toBeUndefined()
  })
})
