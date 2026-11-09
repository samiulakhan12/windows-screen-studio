/**
 * The guide's edits (docs/design/smart-tools.md §17): test 29 and the stored side of test 112 of
 * §22.1. Each edit is one store update (one undo step); a no-op makes no `guide` key; removing
 * the last edit removes `guide`.
 */
import { describe, expect, it } from 'vitest'
import { EditStore } from '../src/shared/editor/editStore'
import { createProject } from '../src/shared/engine/project'
import { withAddedStep, withAiNotes, withAiTitles, withGuideFields, withoutAddedStep, withoutAiTitles, withStepEdit, withTypedBlur } from '../src/shared/guide/guideEdit'
import { GUIDE_LIMITS } from '../src/shared/guide/guideData'
import type { Project } from '../src/shared/types'

function project(): Project {
  return createProject({
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
}

/** Runs `edit` through a store: how many undo steps it made, and the state. */
function once(p: Project, edit: (p: Project) => Project): { steps: number; state: Project } {
  const store = new EditStore(p)
  store.update(edit)
  let steps = 0
  while (store.undo()) steps++
  store.redo()
  return { steps, state: store.state }
}

describe('test 29: guide edits', () => {
  it('each edit is one update; a no-op makes no guide key', () => {
    const p = project()
    expect(once(p, (q) => withStepEdit(q, 'c3000', { title: 'Click Export' })).steps).toBe(1)
    expect(once(p, (q) => withAddedStep(q, 12, 'Step')).steps).toBe(1)
    expect(once(p, (q) => withGuideFields(q, { title: 'Billing guide', kind: 'bug' })).steps).toBe(1)
    expect(once(p, (q) => withAiNotes(q, [{ key: 'c3000', text: 'A.' }, { key: 'c5000', text: 'B.' }], 'openai')).steps).toBe(1)
    expect(once(p, (q) => withAiTitles(q, [{ key: 'c3000', title: 'A' }, { key: 'c5000', title: 'B' }], 'local')).steps).toBe(1)
    // No-ops: the same project, no key.
    expect(withStepEdit(p, 'c3000', {})).toBe(p)
    expect(withStepEdit(p, 'c3000', null)).toBe(p)
    expect(withGuideFields(p, { title: undefined })).toBe(p)
    expect(withAiNotes(p, [], 'openai')).toBe(p)
    expect('guide' in withStepEdit(p, 'c3000', { hidden: undefined })).toBe(false)
    expect(once(p, (q) => withStepEdit(q, 'c3000', {})).steps).toBe(0)
    // The same edit again changes nothing.
    const a = withStepEdit(p, 'c3000', { title: 'Click Export' })
    expect(withStepEdit(a, 'c3000', { title: 'Click Export' })).toBe(a)
  })

  it('removing the last edit removes guide', () => {
    const p = project()
    const a = withStepEdit(p, 'c3000', { hidden: true })
    expect(a.guide).toEqual({ steps: [{ key: 'c3000', hidden: true }] })
    expect('guide' in withStepEdit(a, 'c3000', { hidden: undefined })).toBe(false)
    expect('guide' in withStepEdit(a, 'c3000', null)).toBe(false)
    const b = withAddedStep(p, 12, 'Step')
    expect(b.guide!.added).toEqual([{ key: 'a12000', t: 12, title: 'Step' }])
    expect('guide' in withoutAddedStep(b, 'a12000')).toBe(false)
    const c = withGuideFields(p, { title: 'X' })
    expect('guide' in withGuideFields(c, { title: undefined })).toBe(false)
  })

  it('stored as the reader reads it: texts cut to their limits, bad boxes dropped', () => {
    const p = withStepEdit(project(), 'c3000', { title: 'x'.repeat(300), text: 'y'.repeat(3000) })
    expect(p.guide!.steps![0].title!.length).toBe(GUIDE_LIMITS.stepTitle)
    expect(p.guide!.steps![0].text!.length).toBe(GUIDE_LIMITS.stepText)
    expect(withStepEdit(project(), 'zz', { title: 'A' }).guide).toBeUndefined()
  })

  it('added steps get the next free key', () => {
    const p = withAddedStep(withAddedStep(project(), 12, 'Step'), 12, 'Step')
    expect(p.guide!.added!.map((a) => a.key)).toEqual(['a12000', 'a12001'])
  })

  it('Use offline titles removes every AI title in one update and keeps hand ones', () => {
    let p = withAiTitles(project(), [{ key: 'c1000', title: 'A' }], 'openai')
    p = withStepEdit(p, 'c2000', { title: 'Mine' })
    const r = once(p, withoutAiTitles)
    expect(r.steps).toBe(1)
    expect(r.state.guide!.steps).toEqual([{ key: 'c2000', title: 'Mine' }])
    const q = project()
    expect(withoutAiTitles(q)).toBe(q)
  })

  it('Blur the typed text is one update adding one blur', () => {
    const p = project()
    const step = { key: 'c20500', t: 20.5, kind: 'click' as const, x: 0.4, y: 0.6, typing: { t: 21, end: 23, place: { x: 0.4, y: 0.6 } } }
    const r = once(p, (q) => withTypedBlur(q, step, 26, { x: 0.38, y: 0.58, w: 0.19, h: 0.04 }))
    expect(r.steps).toBe(1)
    expect(r.state.shapes).toHaveLength(1)
    expect(r.state.shapes![0]).toMatchObject({ kind: 'blur', start: 21, end: 26, x: 0.38, y: 0.58, w: 0.19, h: 0.04 })
  })
})

describe('test 112: Adjust (stored)', () => {
  it('Done stores rect and ring in one update; Reset removes them', () => {
    const p = project()
    const done = once(p, (q) => withStepEdit(q, 'c3000', { rect: { x: 0.1, y: 0.1, w: 0.5, h: 0.5 }, ring: { x: 0.3, y: 0.3 } }))
    expect(done.steps).toBe(1)
    expect(done.state.guide!.steps).toEqual([{ key: 'c3000', rect: { x: 0.1, y: 0.1, w: 0.5, h: 0.5 }, ring: { x: 0.3, y: 0.3 } }])
    const reset = once(done.state, (q) => withStepEdit(q, 'c3000', { rect: undefined, ring: undefined }))
    expect(reset.steps).toBe(1)
    expect('guide' in reset.state).toBe(false)
  })

  it('a crop under 5% is refused', () => {
    const p = project()
    expect(withStepEdit(p, 'c3000', { rect: { x: 0.1, y: 0.1, w: 0.04, h: 0.5 } })).toBe(p)
  })
})
