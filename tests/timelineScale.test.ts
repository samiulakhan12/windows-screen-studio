import { describe, expect, it } from 'vitest'
import {
  clampScale,
  fitScale,
  followScroll,
  formatTick,
  MAX_PX_PER_SEC,
  renderWindow,
  scrollForZoom,
  tickStep,
  ticksIn
} from '../src/shared/editor/timelineScale'

describe('timeline scale', () => {
  it('fits the recording and clamps zoom between fit and the maximum', () => {
    const fit = fitScale(1200, 1800)
    expect(fit).toBeCloseTo(1200 / 1800)
    expect(clampScale(0.01, fit)).toBe(fit)
    expect(clampScale(1e6, fit)).toBe(MAX_PX_PER_SEC)
  })

  it('picks readable tick steps for any zoom level', () => {
    expect(tickStep(1200 / 1800)).toBeGreaterThanOrEqual(60)
    expect(tickStep(100)).toBe(1)
    expect(tickStep(400)).toBe(0.2)
    expect(ticksIn(9.5, 12.1, 1)).toEqual([10, 11, 12])
  })

  it('formats ticks with tenths only when needed', () => {
    expect(formatTick(75, 5)).toBe('1:15')
    expect(formatTick(1.2, 0.2)).toBe('0:01.2')
  })

  it('keeps the time under the pointer fixed while zooming', () => {
    const old = 10
    const scroll = 500
    const anchor = 300
    const t = (scroll + anchor) / old
    const next = scrollForZoom(old, 40, scroll, anchor)
    expect((next + anchor) / 40).toBeCloseTo(t)
  })

  it('pages to follow the playhead only when it leaves the view', () => {
    expect(followScroll(500, 0, 1000)).toBeNull()
    expect(followScroll(990, 0, 1000)).toBeCloseTo(890)
    expect(followScroll(100, 400, 1000)).toBeCloseTo(0)
  })

  it('renders one viewport of overscan on each side', () => {
    expect(renderWindow(2000, 1000, 100, 1800)).toEqual({ start: 10, end: 40 })
    expect(renderWindow(0, 1000, 100, 15)).toEqual({ start: 0, end: 15 })
  })
})
