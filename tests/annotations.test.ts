import { describe, expect, it } from 'vitest'
import { annotationLanes, createAnnotation, dragAnnotationTimes, MIN_ANNOTATION_LENGTH } from '../src/shared/editor/annotations'
import type { Annotation } from '../src/shared/types'

const ann = (id: string, start: number, end: number): Annotation => ({ id, start, end, text: id, x: 0.5, y: 0.5, size: 0.05, style: 'pill' })

describe('createAnnotation', () => {
  it('starts at the playhead with a default length', () => {
    const a = createAnnotation(4, 20)
    expect([a.start, a.end]).toEqual([4, 7])
    expect(a.text.length).toBeGreaterThan(0)
    expect(a.style).toBe('pill')
  })

  it('fits inside the recording near the end and in short recordings', () => {
    expect(createAnnotation(19.5, 20)).toMatchObject({ start: 17, end: 20 })
    expect(createAnnotation(1, 2)).toMatchObject({ start: 0, end: 2 })
  })

  it('creates unique ids', () => {
    expect(createAnnotation(0, 10).id).not.toBe(createAnnotation(0, 10).id)
  })
})

describe('dragAnnotationTimes', () => {
  it('moves within the recording and resizes with a minimum length', () => {
    expect(dragAnnotationTimes({ start: 2, end: 4 }, 'move', 100, 10)).toEqual({ start: 8, end: 10 })
    expect(dragAnnotationTimes({ start: 2, end: 4 }, 'move', -100, 10)).toEqual({ start: 0, end: 2 })
    expect(dragAnnotationTimes({ start: 2, end: 4 }, 'start', 5, 10).start).toBeCloseTo(4 - MIN_ANNOTATION_LENGTH)
    expect(dragAnnotationTimes({ start: 2, end: 4 }, 'end', 100, 10).end).toBe(10)
  })

  it('never gives an item shorter than the minimum a negative start', () => {
    const short = { start: 0.1, end: 0.2 }
    expect(dragAnnotationTimes(short, 'start', 0, 10)).toEqual(short)
    expect(dragAnnotationTimes(short, 'start', 1, 10).start).toBeCloseTo(0.1)
    expect(dragAnnotationTimes(short, 'start', -1, 10).start).toBe(0)
    expect(dragAnnotationTimes(short, 'end', -1, 10).end).toBeCloseTo(0.2)
  })
})

describe('annotationLanes', () => {
  it('stacks overlapping overlays and reuses free lanes', () => {
    const { lanes, count } = annotationLanes([ann('a', 0, 4), ann('b', 1, 3), ann('c', 2, 6), ann('d', 4, 5)])
    expect(count).toBe(3)
    expect(lanes.get('a')).toBe(0)
    expect(lanes.get('b')).toBe(1)
    expect(lanes.get('c')).toBe(2)
    expect(lanes.get('d')).toBe(0)
  })

  it('uses one lane when nothing overlaps', () => {
    expect(annotationLanes([ann('a', 0, 1), ann('b', 1, 2)]).count).toBe(1)
    expect(annotationLanes([]).count).toBe(1)
  })
})
