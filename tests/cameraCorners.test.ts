import { describe, expect, it } from 'vitest'
import { cornerAt, addLayoutAt } from '../src/shared/editor/layouts'
import { cornerRefusal, setCornerAt } from '../src/shared/editor/layoutCommands'
import { easeInOutCubic } from '../src/shared/engine/math'
import {
  LAYOUT_TRANSITION,
  layoutGeometry,
  layoutMoving,
  layoutPhaseAt,
  layoutRamps,
  lerpRect,
  sceneCameraBox,
  sceneContentRect,
  styleContentRect,
  webcamRect,
  type Rect,
  type SceneProject
} from '../src/shared/engine/layout'
import { readLayouts } from '../src/shared/engine/webcamData'
import type { CameraLayout, Corner, LayoutSegment, StyleSettings } from '../src/shared/types'

const STYLE: StyleSettings = { background: { type: 'color', color: '#000000' }, padding: 0.07, cornerRadius: 14, shadow: 0.6, aspectRatio: 'auto' }
const W = 1920
const H = 1080
const T = LAYOUT_TRANSITION

function project(layouts: LayoutSegment[] = [], over: Partial<SceneProject> = {}): SceneProject {
  return {
    style: STYLE,
    hasWebcam: true,
    webcam: { show: true, corner: 'bottom-right', size: 0.24, shape: 'circle' },
    layouts,
    clips: [{ id: 'c', start: 0, end: 30, speed: 1 }],
    duration: 30,
    ...over
  }
}

const seg = (id: string, start: number, end: number, corner?: Corner, layout: CameraLayout = 'default'): LayoutSegment => ({ id, start, end, layout, ...(corner ? { corner } : {}) })
const bubble = (corner: Corner): Rect => webcamRect(W, H, { corner, size: 0.24 })
const camAt = (p: SceneProject, t: number): Rect => sceneCameraBox(p, W, H, 1280, 720, t)!.rect
const expectRect = (a: Rect, b: Rect): void => {
  expect(a.x).toBeCloseTo(b.x, 6)
  expect(a.y).toBeCloseTo(b.y, 6)
  expect(a.w).toBeCloseTo(b.w, 6)
  expect(a.h).toBeCloseTo(b.h, 6)
}

describe('camera corner per layout segment: geometry', () => {
  it('puts the bubble in the segment corner, and in the project corner elsewhere', () => {
    const p = project([seg('a', 5, 10, 'top-left')])
    expectRect(camAt(p, 2), bubble('bottom-right'))
    expectRect(camAt(p, 7), bubble('top-left'))
    expectRect(camAt(p, 15), bubble('bottom-right'))
    // The screen does not move for a change of corner.
    expect(sceneContentRect(p, W, H, 1280, 720, 5 + T / 2)).toEqual(styleContentRect(W, H, 1280, 720, STYLE))
    expect(layoutMoving(p, 5 + T / 2)).toBe(false)
  })

  it('glides between corners over LAYOUT_TRANSITION with the layouts easing, in and back out', () => {
    const p = project([seg('a', 5, 10, 'top-left')])
    const from = bubble('bottom-right')
    const to = bubble('top-left')
    expectRect(camAt(p, 5), from)
    for (const k of [0.25, 0.5, 0.75]) expectRect(camAt(p, 5 + k * T), lerpRect(from, to, easeInOutCubic(k)))
    expectRect(camAt(p, 5 + T), to)
    // And back to the project's corner at its end.
    expectRect(camAt(p, 10 - T / 2), lerpRect(to, from, easeInOutCubic(0.5)))
    expectRect(camAt(p, 10), from)
    expect(layoutRamps(p, p.layouts![0])).toEqual({ in: T, out: T })
  })

  it('moves straight from corner to corner between back-to-back segments', () => {
    const p = project([seg('a', 5, 10, 'top-left'), seg('b', 10, 15, 'top-right')])
    expect(layoutPhaseAt(p, 10 + T / 2)).toMatchObject({ from: 'default', to: 'default', fromCorner: 'top-left', toCorner: 'top-right' })
    expectRect(camAt(p, 10 + T / 2), lerpRect(bubble('top-left'), bubble('top-right'), 0.5))
    // No detour through the default corner at the change.
    expectRect(camAt(p, 10 - 1e-3), bubble('top-left'))
    expect(layoutRamps(p, p.layouts![0])).toEqual({ in: T, out: 0 })
    expect(layoutRamps(p, p.layouts![1])).toEqual({ in: T, out: T })
  })

  it('a segment in the project corner (or with no corner) changes nothing and has no ramps', () => {
    const same = project([seg('a', 5, 10, 'bottom-right')])
    expect(layoutPhaseAt(same, 5.1).progress).toBe(1)
    expect(layoutRamps(same, same.layouts![0])).toEqual({ in: 0, out: 0 })
    expectRect(camAt(same, 5.1), bubble('bottom-right'))
    // A default segment next to a cornered one moves back to the project corner at its start.
    const p = project([seg('a', 5, 10, 'top-left'), seg('b', 10, 15)])
    expect(layoutPhaseAt(p, 10 + T / 2)).toMatchObject({ fromCorner: 'top-left', from: 'default', to: 'default' })
    expect(layoutPhaseAt(p, 10 + T / 2).toCorner).toBeUndefined()
    expectRect(camAt(p, 10 + T / 2), lerpRect(bubble('top-left'), bubble('bottom-right'), 0.5))
  })

  it('a change at the very start or end of the edit is instant', () => {
    const p = project([seg('a', 0, 4, 'top-left'), seg('b', 26, 30, 'top-right')])
    expectRect(camAt(p, 0), bubble('top-left'))
    expect(layoutRamps(p, p.layouts![0])).toEqual({ in: 0, out: T })
    expect(layoutRamps(p, p.layouts![1])).toEqual({ in: T, out: 0 })
    expectRect(camAt(p, 29.99), bubble('top-right'))
  })

  it('applies the corner to the large camera too, and never to layouts without a bubble', () => {
    const large = project([seg('a', 5, 10, 'top-left', 'camera-large')])
    const box = layoutGeometry('camera-large', large, W, H, 1280, 720, 'top-left').camera.rect
    expectRect(camAt(large, 7), box)
    expect(box.x).toBeLessThan(W / 4)
    expect(box.y).toBeLessThan(H / 4)
    // Camera only fills the frame: the corner is ignored.
    const p = project([seg('a', 5, 10, 'top-left', 'camera-only')])
    const plain = project([seg('a', 5, 10, undefined, 'camera-only')])
    expectRect(camAt(p, 7), camAt(plain, 7))
    expect(layoutPhaseAt(p, 7)).toEqual(layoutPhaseAt(plain, 7))
  })

  it('puts the camera card beside the screen on the side of its segment corner', () => {
    const left = project([seg('a', 5, 10, 'top-left', 'side-by-side')])
    const card = camAt(left, 7)
    const screen = sceneContentRect(left, W, H, 1280, 720, 7)
    expect(card.x + card.w).toBeLessThan(screen.x)
    expectRect(card, layoutGeometry('side-by-side', project([], { webcam: { show: true, corner: 'top-left', size: 0.24, shape: 'circle' } }), W, H, 1280, 720).camera.rect)
    // Without one it is the project's side (bottom right: on the right).
    expect(camAt(project([seg('a', 5, 10, undefined, 'side-by-side')]), 7).x).toBeGreaterThan(W / 2)
    // A card changing sides moves the screen too.
    const across = project([seg('a', 5, 10, 'top-left', 'side-by-side'), seg('b', 10, 15, 'top-right', 'side-by-side')])
    expect(layoutPhaseAt(across, 10.1)).toMatchObject({ from: 'side-by-side', to: 'side-by-side', fromCorner: 'top-left', toCorner: 'top-right' })
    expect(layoutMoving(across, 10.1)).toBe(true)
    expect(layoutMoving(across, 12)).toBe(false)
    // Its corner can be changed at the playhead like the bubble's.
    expect(setCornerAt({ ...left, duration: 30 }, 'bottom-right', 7)).toMatchObject({ ok: true, id: 'a', added: false })
  })

  it('old projects (no corners) get exactly the same phases and boxes as before', () => {
    const p = project([seg('a', 5, 10, undefined, 'camera-only')])
    expect(layoutPhaseAt(p, 7)).toEqual({ from: 'camera-only', to: 'camera-only', progress: 1 })
    expect(Object.keys(layoutPhaseAt(p, 5.1))).toEqual(['from', 'to', 'progress'])
    expect(layoutPhaseAt(project(), 3)).toEqual({ from: 'default', to: 'default', progress: 1 })
  })

  it('follows the project corner as the default: changing it leaves cornered segments where they are', () => {
    const p = project([seg('a', 5, 10, 'top-left')], { webcam: { show: true, corner: 'top-right', size: 0.24, shape: 'circle' } })
    expectRect(camAt(p, 2), bubble('top-right'))
    expectRect(camAt(p, 7), bubble('top-left'))
  })

  it('a hidden camera or a recording without one ignores corners', () => {
    const p = project([seg('a', 5, 10, 'top-left')], { hasWebcam: false })
    expect(layoutPhaseAt(p, 7)).toEqual({ from: 'default', to: 'default', progress: 1 })
    expect(sceneCameraBox(project([seg('a', 5, 10, 'top-left')], { webcam: { show: false, corner: 'bottom-right', size: 0.24, shape: 'circle' } }), W, H, 1280, 720, 7)).toBeNull()
  })
})

describe('camera corners in stored projects and editor commands', () => {
  it('keeps a valid corner when reading layouts and drops an unknown one', () => {
    const read = readLayouts(
      [
        { id: 'a', start: 1, end: 3, layout: 'default', corner: 'top-left' },
        { id: 'b', start: 4, end: 6, layout: 'default', corner: 'middle' },
        { id: 'c', start: 7, end: 9, layout: 'camera-large', corner: 'bottom-left' }
      ],
      10
    )
    expect(read).toEqual([
      { id: 'a', start: 1, end: 3, layout: 'default', corner: 'top-left' },
      { id: 'b', start: 4, end: 6, layout: 'default' },
      { id: 'c', start: 7, end: 9, layout: 'camera-large', corner: 'bottom-left' }
    ])
  })

  it('cornerAt: the segment corner, else the project corner', () => {
    const p = { ...project([seg('a', 5, 10, 'top-left'), seg('b', 12, 14, 'top-right', 'camera-only')]) }
    expect(cornerAt(p, 7)).toBe('top-left')
    expect(cornerAt(p, 13)).toBe('bottom-right')
    expect(cornerAt(p, 20)).toBe('bottom-right')
  })

  it('setCornerAt changes the segment at the playhead, or adds one with the shared add rule', () => {
    const base = { ...project([seg('a', 5, 10, 'top-left')]), duration: 30 }
    const inside = setCornerAt(base, 'top-right', 7)
    expect(inside).toMatchObject({ ok: true, id: 'a', added: false })
    if (inside.ok) expect(inside.layouts[0].corner).toBe('top-right')
    expect(setCornerAt(base, 'top-left', 7)).toEqual({ ok: false, reason: 'same', id: 'a' })

    const added = setCornerAt(base, 'bottom-left', 15)
    expect(added).toMatchObject({ ok: true, added: true })
    const ref = addLayoutAt(base, 'default', 15, 'bottom-left')
    if (added.ok && ref.ok) {
      const seg2 = added.layouts.find((s) => s.id === added.id)!
      expect({ ...seg2, id: '' }).toEqual({ ...ref.segment, id: '' })
      expect(seg2).toMatchObject({ layout: 'default', corner: 'bottom-left', start: 15 })
    }
    // The project corner outside every segment: nothing to add.
    expect(setCornerAt(base, 'bottom-right', 15)).toEqual({ ok: false, reason: 'same', id: null })
    // A layout without a bubble has no corner to change.
    const cam = { ...project([seg('c', 5, 10, undefined, 'camera-only')]), duration: 30 }
    expect(setCornerAt(cam, 'top-left', 7)).toEqual({ ok: false, reason: 'no-corner', id: 'c' })
    expect(cornerRefusal('no-corner', 'top-left')).toMatch(/no camera corner/)
  })

  it('setCornerAt next to the end of the video still adds a segment that plays', () => {
    const base = { ...project([]), duration: 30 }
    const r = setCornerAt(base, 'top-left', 29.95)
    expect(r.ok).toBe(true)
    if (r.ok) expect(r.layouts[0]).toMatchObject({ end: 30, corner: 'top-left' })
  })
})
