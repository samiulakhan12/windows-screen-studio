import { describe, expect, it } from 'vitest'
import { contentRect, outputSize, webcamRect } from '../src/shared/engine/layout'
import { formatTime, frameTimes } from '../src/shared/engine/project'

describe('outputSize', () => {
  it('follows the source aspect in auto mode', () => {
    expect(outputSize('auto', 2560, 1440, 1080)).toEqual({ width: 1920, height: 1080 })
  })
  it('handles presets including portrait', () => {
    expect(outputSize('1:1', 1920, 1080, 1080)).toEqual({ width: 1080, height: 1080 })
    expect(outputSize('9:16', 1920, 1080, 1080)).toEqual({ width: 1080, height: 1920 })
    expect(outputSize('4:3', 1920, 1080, 720)).toEqual({ width: 960, height: 720 })
  })
  it('always returns even dimensions (required by H.264)', () => {
    const { width, height } = outputSize('auto', 1366, 768, 721)
    expect(width % 2).toBe(0)
    expect(height % 2).toBe(0)
  })
})

describe('contentRect', () => {
  it('fits the recording inside the padding, centred', () => {
    const r = contentRect(1920, 1080, 1920, 1080, 0.1)
    expect(r.h).toBeCloseTo(1080 - 216)
    expect(r.x + r.w / 2).toBeCloseTo(960)
    expect(r.y + r.h / 2).toBeCloseTo(540)
  })
  it('letterboxes a landscape recording in a portrait frame', () => {
    const r = contentRect(1080, 1920, 1920, 1080, 0)
    expect(r.w).toBeCloseTo(1080)
    expect(r.h).toBeCloseTo(607.5)
  })
})

describe('webcamRect', () => {
  it('places the camera in the requested corner', () => {
    const r = webcamRect(1920, 1080, { corner: 'bottom-right', size: 0.25 })
    expect(r.w).toBe(270)
    expect(r.x + r.w).toBeLessThan(1920)
    expect(r.y + r.h).toBeLessThan(1080)
    expect(webcamRect(1920, 1080, { corner: 'top-left', size: 0.25 }).x).toBeLessThan(100)
  })
})

describe('time helpers', () => {
  it('formats time', () => {
    expect(formatTime(75.34)).toBe('1:15.3')
    expect(formatTime(5, false)).toBe('0:05')
  })
  it('produces one frame per 1/fps across the range', () => {
    const t = frameTimes(1, 2, 30)
    expect(t).toHaveLength(30)
    expect(t[0]).toBe(1)
    expect(t[29]).toBeCloseTo(1 + 29 / 30)
  })
})
