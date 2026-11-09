/**
 * Shots that may show what was typed (docs/design/smart-tools.md §5.5.7): test 105 of §22.1.
 */
import { describe, expect, it } from 'vitest'
import type { SceneScan } from '../src/shared/api/projects'
import { typedBefore, type GuideStep } from '../src/shared/guide/steps'

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
