/**
 * Shots that may show what was typed (docs/design/smart-tools.md §5.5.7): test 105 of §22.1.
 */
import { describe, expect, it } from 'vitest'
import type { SceneScan } from '../src/shared/api/projects'
import { createProject } from '../src/shared/engine/project'
import { planShot } from '../src/shared/guide/shots'
import { findSteps, typedBefore, typingRuns, type GuideStep } from '../src/shared/guide/steps'
import type { CursorTrack, Project } from '../src/shared/types'

const frame = { w: 1920, h: 1080 }

function scanWith(duration: number, changes: Record<number, number>): SceneScan {
  const t: number[] = []
  const changed: number[] = []
  for (let i = 0; i * 0.25 <= duration; i++) {
    t.push(i * 0.25)
    changed.push(changes[i * 0.25] ?? 0)
  }
  return { step: 0.25, t, changed, stills: [] }
}

// The click into the field at 20.5 s and the typing at 21–23 s (place 0.4, 0.6: 768, 648 px).
const typing: GuideStep = { key: 'c20500', t: 20.5, kind: 'click', x: 0.4, y: 0.6, typing: { t: 21, end: 23, place: { x: 0.4, y: 0.6 } } }
const near: GuideStep = { key: 'c24500', t: 24.5, kind: 'click', x: 0.45, y: 0.6 }
const save: GuideStep = { key: 'k25000', t: 25, kind: 'keys', keys: 'Ctrl + S' }
const later: GuideStep = { key: 'c30000', t: 30, kind: 'click', x: 0.45, y: 0.6 }
const steps = [typing, near, save, later]

const holding = { x: 400, y: 380, w: 950, h: 534 }
const away = { x: 970, y: 0, w: 950, h: 534 }
const whole = { x: 0, y: 0, w: 1920, h: 1080 }

describe('test 105: typedBefore', () => {
  const scan = scanWith(40, { 26: 62 })

  it('a click at 24.5 s whose zoomed shot holds the typing place is marked for the typing step', () => {
    const shots = new Map([
      [typing.key, { t: 20.48, rect: holding, whole: false }],
      [near.key, { t: 24.48, rect: holding, whole: false }]
    ])
    expect(typedBefore(steps, shots, scan, frame).get(near.key)).toBe(typing.key)
    // The typing step's own shot is taken before its typing: not marked.
    expect(typedBefore(steps, shots, scan, frame).has(typing.key)).toBe(false)
  })

  it('the same click with a zoomed shot that leaves out the place is not marked', () => {
    const shots = new Map([[near.key, { t: 24.48, rect: away, whole: false }]])
    expect(typedBefore(steps, shots, scan, frame).has(near.key)).toBe(false)
  })

  it('the margin is 5% of the frame', () => {
    // The place is at x 768: a crop ending 90 px before it holds it, one ending 100 px before does not.
    expect(typedBefore(steps, new Map([[near.key, { t: 24.48, rect: { x: 0, y: 380, w: 678, h: 534 }, whole: false }]]), scan, frame).has(near.key)).toBe(true)
    expect(typedBefore(steps, new Map([[near.key, { t: 24.48, rect: { x: 0, y: 380, w: 668, h: 534 }, whole: false }]]), scan, frame).has(near.key)).toBe(false)
  })

  it('a step after a settled page change at 26 s is not marked; a whole-screen key step before 26 s is', () => {
    const shots = new Map([
      [save.key, { t: 24.98, rect: whole, whole: true }],
      [later.key, { t: 29.98, rect: holding, whole: false }]
    ])
    const out = typedBefore(steps, shots, scan, frame)
    expect(out.get(save.key)).toBe(typing.key)
    expect(out.has(later.key)).toBe(false)
  })

  it('without a scene scan every later shot holding the place is marked', () => {
    const shots = new Map([
      [near.key, { t: 24.48, rect: holding, whole: false }],
      [later.key, { t: 29.98, rect: holding, whole: false }],
      [save.key, { t: 24.98, rect: away, whole: false }]
    ])
    const out = typedBefore(steps, shots, null, frame)
    expect([...out.keys()].sort()).toEqual([later.key, near.key].sort())
  })

  it('a change under 30% is not a page change; the latest burst names the step', () => {
    const second: GuideStep = { key: 't27000', t: 27, kind: 'type', typing: { t: 27, end: 28, place: { x: 0.42, y: 0.6 } } }
    const shots = new Map([[later.key, { t: 29.98, rect: holding, whole: false }]])
    expect(typedBefore([...steps, second], shots, scanWith(40, { 26: 20 }), frame).get(later.key)).toBe(second.key)
  })

  it('a typing step shown after its typing is marked by its own typing', () => {
    const shots = new Map([[typing.key, { t: 23.2, rect: holding, whole: false }]])
    expect(typedBefore(steps, shots, scan, frame).get(typing.key)).toBe(typing.key)
  })
})

describe('typing no listed step holds still marks the later shots that show it', () => {
  // Click into a field at 2 s, type from 2.5 to 6 s, click Log in at 8 s (0.45, 0.6: the field shows).
  const login: CursorTrack = {
    samples: [
      { t: 0, x: 0.4, y: 0.6 },
      { t: 60, x: 0.45, y: 0.6 }
    ],
    clicks: [
      { t: 2, x: 0.4, y: 0.6, button: 'left' },
      { t: 8, x: 0.45, y: 0.6, button: 'left' }
    ],
    typing: [{ t: 2.5, end: 6 }],
    valid: true,
    scale: 1
  }
  const project = (clips?: Project['clips']): Project => {
    const p = createProject({
      id: 'p',
      name: 'Login',
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
    return clips ? { ...p, clips } : p
  }
  /** The marks as the panel works them out: the guide's shots and every stretch of typing. */
  const marks = (track: CursorTrack, p: Project): [string, string][] => {
    const steps = findSteps({ track, project: p, scan: null })
    const shots = new Map(steps.map((s) => [s.key, planShot(s, p, undefined, 1, 'guide')] as const))
    return [...typedBefore(steps, shots, null, frame, typingRuns({ track, project: p }, steps))]
  }

  it('a listed click-and-type step names the mark, as before', () => {
    expect(marks(login, project())).toEqual([['c8000', 'c2000']])
    const steps = findSteps({ track: login, project: project(), scan: null })
    expect(typingRuns({ track: login, project: project() }, steps)).toEqual([{ key: 'c2000', t: 2.5, end: 6, place: { x: 0.4, y: 0.6 } }])
  })

  it('the click and its typing cut from the video (Remove silences): the Log in shot is still marked', () => {
    const p = project([
      { id: 'a', start: 0, end: 1.5, speed: 1 },
      { id: 'b', start: 7, end: 60, speed: 1 }
    ])
    expect(findSteps({ track: login, project: p, scan: null }).map((s) => s.key)).toEqual(['c8000'])
    expect(marks(login, p)).toEqual([['c8000', 't2500']])
  })

  it('only the click into the field cut: still marked', () => {
    const p = project([
      { id: 'a', start: 0, end: 1.9, speed: 1 },
      { id: 'b', start: 2.2, end: 60, speed: 1 }
    ])
    expect(marks(login, p)).toEqual([['c8000', 't2500']])
  })

  it('a lone burst under 0.5 s (no step of its own) marks the click after it', () => {
    const lone: CursorTrack = { ...login, clicks: [{ t: 12, x: 0.45, y: 0.6, button: 'left' }], typing: [{ t: 10, end: 10.4 }] }
    expect(findSteps({ track: lone, project: project(), scan: null }).map((s) => s.key)).toEqual(['c12000'])
    expect(marks(lone, project())).toEqual([['c12000', 't10000']])
  })
})
