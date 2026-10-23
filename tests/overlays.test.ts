import { describe, expect, it } from 'vitest'
import {
  annotationAlpha,
  annotationMetrics,
  blurSampleCount,
  cameraDisplacement,
  cursorHeight,
  keycaps,
  keystrokesAt,
  shapeAt,
  shutterTimes,
  speedAt,
  viewingTime
} from '../src/shared/render/overlays'
import type { Annotation, Clip, KeyEvent } from '../src/shared/types'

const full: Clip[] = [{ id: 'a', start: 0, end: 20, speed: 1 }]
const key = (t: number, label: string): KeyEvent => ({ t, label })

describe('viewingTime / speedAt', () => {
  const clips: Clip[] = [
    { id: 'a', start: 0, end: 2, speed: 1 },
    { id: 'b', start: 4, end: 8, speed: 2 }
  ]
  it('maps kept time to output time and cut time to the next kept frame', () => {
    expect(viewingTime(clips, 1)).toBe(1)
    expect(viewingTime(clips, 6)).toBe(3)
    expect(viewingTime(clips, 3)).toBe(2)
    expect(viewingTime(clips, 99)).toBe(4)
  })
  it('reports the clip speed (1 inside a cut)', () => {
    expect(speedAt(clips, 5)).toBe(2)
    expect(speedAt(clips, 3)).toBe(1)
  })
})

describe('keystrokesAt', () => {
  it('shows nothing before the first key and after the hold time', () => {
    const keys = [key(2, 'Ctrl + C')]
    expect(keystrokesAt(keys, full, 1.9)).toBeNull()
    expect(keystrokesAt(keys, full, 2.5)?.groups).toEqual([{ label: 'Ctrl + C', count: 1 }])
    expect(keystrokesAt(keys, full, 3.3)).toBeNull()
    expect(keystrokesAt([], full, 2)).toBeNull()
    expect(keystrokesAt(undefined, full, 2)).toBeNull()
  })
  it('fades in quickly and out at the end', () => {
    const keys = [key(2, 'Ctrl + C')]
    expect(keystrokesAt(keys, full, 2)!.alpha).toBe(0)
    expect(keystrokesAt(keys, full, 2.5)!.alpha).toBe(1)
    expect(keystrokesAt(keys, full, 3.1)!.alpha).toBeCloseTo(0.4, 5)
  })
  it('stacks presses in quick succession and counts repeats', () => {
    const keys = [key(1, 'Ctrl + C'), key(1.4, 'Ctrl + V'), key(1.6, 'Ctrl + V'), key(1.9, 'Ctrl + V')]
    const view = keystrokesAt(keys, full, 2)!
    expect(view.groups).toEqual([
      { label: 'Ctrl + C', count: 1 },
      { label: 'Ctrl + V', count: 3 }
    ])
    // The row stays until 1.2 s after the LAST press.
    expect(keystrokesAt(keys, full, 3)).not.toBeNull()
  })
  it('starts a new row after a pause', () => {
    const keys = [key(1, 'Ctrl + C'), key(2.5, 'Ctrl + V')]
    expect(keystrokesAt(keys, full, 2.6)!.groups).toEqual([{ label: 'Ctrl + V', count: 1 }])
  })
  it('keeps only the most recent groups', () => {
    const keys = ['A', 'B', 'C', 'D', 'E'].map((l, i) => key(1 + i * 0.1, `Ctrl + ${l}`))
    expect(keystrokesAt(keys, full, 1.5)!.groups.map((g) => g.label)).toEqual(['Ctrl + C', 'Ctrl + D', 'Ctrl + E'])
  })
  it('measures the hold in viewing time on sped-up clips', () => {
    const fast: Clip[] = [{ id: 'a', start: 0, end: 20, speed: 4 }]
    const keys = [key(2, 'Esc')]
    // 4 s of source at 4x is 1 s on screen: still visible.
    expect(keystrokesAt(keys, fast, 6)).not.toBeNull()
    expect(keystrokesAt(keys, fast, 7)).toBeNull()
  })
  it('ignores keys pressed inside a cut', () => {
    const clips: Clip[] = [
      { id: 'a', start: 0, end: 2, speed: 1 },
      { id: 'b', start: 4, end: 8, speed: 1 }
    ]
    expect(keystrokesAt([key(3, 'Ctrl + S')], clips, 4.2)).toBeNull()
  })
  it('pops the newest key right after it is pressed', () => {
    const keys = [key(2, 'Tab')]
    expect(keystrokesAt(keys, full, 2)!.pop).toBe(1)
    expect(keystrokesAt(keys, full, 2.5)!.pop).toBe(0)
  })
  it('splits labels into keycaps', () => {
    expect(keycaps('Ctrl + Shift + S')).toEqual(['Ctrl', 'Shift', 'S'])
    expect(keycaps('Enter')).toEqual(['Enter'])
  })
})

describe('annotations', () => {
  const a: Annotation = { id: 'x', start: 1, end: 3, text: 'Hi', x: 0.5, y: 0.5, size: 0.05, style: 'pill' }
  it('fades in and out over ~150 ms', () => {
    expect(annotationAlpha(a, 0.99)).toBe(0)
    expect(annotationAlpha(a, 1)).toBe(0)
    expect(annotationAlpha(a, 1.075)).toBeCloseTo(0.5, 5)
    expect(annotationAlpha(a, 2)).toBe(1)
    expect(annotationAlpha(a, 2.925)).toBeCloseTo(0.5, 5)
    expect(annotationAlpha(a, 3)).toBe(0)
  })
  it('keeps the fade at 150 ms of viewing time on fast clips', () => {
    expect(annotationAlpha(a, 1.15, 2)).toBeCloseTo(0.5, 5)
  })
  it('sizes text relative to the frame (matching the editor handle)', () => {
    const m = annotationMetrics(a, 1920, 1080)
    expect(m.px).toBeCloseTo(54)
    expect(m.padX).toBeCloseTo(54 * 0.7)
    expect(m.lineHeight).toBeCloseTo(54 * 1.3)
    expect(annotationMetrics({ ...a, style: 'title' }, 1920, 1080).weight).toBe(700)
  })
})

describe('cursor', () => {
  it('uses the shape in effect at t, arrow by default', () => {
    const shapes = [
      { t: 1, shape: 'text' as const },
      { t: 2, shape: 'pointer' as const }
    ]
    expect(shapeAt(undefined, 5)).toBe('arrow')
    expect(shapeAt(shapes, 0.5)).toBe('arrow')
    expect(shapeAt(shapes, 1.5)).toBe('text')
    expect(shapeAt(shapes, 9)).toBe('pointer')
  })
  it('is the same size on screen at 100% and 200% display scaling', () => {
    // Same 1920x1080-DIP display captured at 1080p (100%) and 2160p (200%), drawn into the same 900 px tall content.
    const at100 = cursorHeight(900, 1080, 1, 1, 1)
    const at200 = cursorHeight(900, 2160, 2, 1, 1)
    expect(at200).toBeCloseTo(at100, 6)
    expect(at100).toBeCloseTo((24 / 1080) * 900, 6)
    // Zoom and the size setting scale it.
    expect(cursorHeight(900, 1080, 1, 2, 1.5)).toBeCloseTo(at100 * 3, 6)
    // Missing scale (old recordings) means 100%.
    expect(cursorHeight(900, 1080, undefined, 1, 1)).toBeCloseTo(at100, 6)
  })
})

describe('motion blur sampling', () => {
  const rect = { x: 0, y: 0, w: 1000, h: 500 }
  it('measures no movement for a still camera', () => {
    const cam = { scale: 2, cx: 0.4, cy: 0.6 }
    expect(cameraDisplacement(cam, cam, rect)).toBe(0)
    expect(blurSampleCount(0, 10)).toBe(1)
  })
  it('measures a pan in output pixels', () => {
    // At 2x zoom, moving the centre by 0.01 moves content 0.02 of the width.
    const d = cameraDisplacement({ scale: 2, cx: 0.5, cy: 0.5 }, { scale: 2, cx: 0.51, cy: 0.5 }, rect)
    expect(d).toBeCloseTo(20, 6)
  })
  it('measures a zoom by its largest (corner) movement', () => {
    const d = cameraDisplacement({ scale: 1, cx: 0.5, cy: 0.5 }, { scale: 1.1, cx: 0.5, cy: 0.5 }, rect)
    expect(d).toBeCloseTo(Math.hypot(0.05 * 1000, 0.05 * 500), 6)
  })
  it('uses enough samples for ~2 px spacing, within the budget', () => {
    expect(blurSampleCount(0.5, 10)).toBe(1)
    expect(blurSampleCount(4, 10)).toBe(3)
    expect(blurSampleCount(500, 10)).toBe(10)
    expect(blurSampleCount(500, 1)).toBe(1)
  })
  it('spreads sub-frames evenly around t', () => {
    expect(shutterTimes(1, 0.01, 3)).toEqual([0.995, 1, 1.005])
    expect(shutterTimes(1, 0.01, 1)).toEqual([1])
  })
})
