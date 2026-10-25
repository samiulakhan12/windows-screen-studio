import { describe, expect, it } from 'vitest'
import type { RecordingManifest } from '../src/main/projects'
import { bubbleCamera, setCameraFollows, setCameraMoves } from '../src/main/recording/cameraMoves'
import { setLayoutAt } from '../src/shared/editor/layoutCommands'
import { addLayoutAt, cornerAt, DEFAULT_LAYOUT_LENGTH, dragLayout, dragLayoutTimes, layoutDragBounds, removeLayout, stayAround } from '../src/shared/editor/layouts'
import { LAYOUT_TRANSITION, layoutRamps, sceneCameraBox, sceneContentRect, type Rect, type SceneProject } from '../src/shared/engine/layout'
import { MIN_LAYOUT_LENGTH } from '../src/shared/engine/webcamData'
import type { CameraLayout, Corner, LayoutSegment, StyleSettings } from '../src/shared/types'

/*
 * Bubble moves while recording become corner-only layout segments ('default' with a corner):
 * camera positions that can last minutes. Editing them stays predictable: a layout change at the
 * playhead inside one is added there for DEFAULT_LAYOUT_LENGTH in that corner, and a camera
 * hidden next to one fades where the camera was. Where the camera starts is the project's corner.
 */

const STYLE: StyleSettings = { background: { type: 'color', color: '#000000' }, padding: 0.07, cornerRadius: 14, shadow: 0.6, aspectRatio: 'auto' }
const W = 1920
const H = 1080

function project(layouts: LayoutSegment[], duration = 30): SceneProject & { duration: number } {
  return {
    style: STYLE,
    hasWebcam: true,
    webcam: { show: true, corner: 'bottom-right', size: 0.24, shape: 'circle' },
    layouts,
    clips: [{ id: 'c', start: 0, end: duration, speed: 1 }],
    duration
  }
}

const seg = (id: string, start: number, end: number, layout: CameraLayout, corner?: Corner): LayoutSegment => ({ id, start, end, layout, ...(corner ? { corner } : {}) })
const centre = (r: Rect): { x: number; y: number } => ({ x: r.x + r.w / 2, y: r.y + r.h / 2 })
const shape = (l: LayoutSegment[]) => l.map((s) => [+s.start.toFixed(3), +s.end.toFixed(3), s.layout, s.corner])

describe('a camera hidden next to a camera position', () => {
  const box = (p: SceneProject, t: number) => sceneCameraBox(p, W, H, 1280, 720, t)!

  it('fades out in the corner the camera was in, not on its way to the project corner', () => {
    const p = project([seg('a', 10, 20, 'default', 'top-left'), seg('b', 20, 30, 'screen-only')])
    for (const t of [20.1, 20.2, 20.3]) {
      const c = centre(box(p, t).rect)
      expect(c.x < W / 2 && c.y < H / 2, `top left at ${t}: ${JSON.stringify(c)}`).toBe(true)
    }
    expect(box(p, 20 + LAYOUT_TRANSITION / 2).opacity).toBeGreaterThan(0)
    expect(box(p, 25).opacity).toBe(0)
  })

  it('and fades back in where the camera goes next', () => {
    const p = project([seg('b', 5, 10, 'screen-only'), seg('a', 10, 20, 'default', 'top-right')])
    for (const t of [10.1, 10.2, 10.3]) {
      const c = centre(box(p, t).rect)
      expect(c.x > W / 2 && c.y < H / 2, `top right at ${t}: ${JSON.stringify(c)}`).toBe(true)
    }
  })
})

describe('a layout change at the playhead inside a camera position', () => {
  const stay = seg('a', 120, 600, 'default', 'top-left')

  it('is added there for the default length, in that corner, and the position carries on around it', () => {
    const p = project([stay], 600)
    const r = setLayoutAt(p, 'side-by-side', 300)
    expect(r).toMatchObject({ ok: true, added: true })
    if (!r.ok) return
    expect(shape(r.layouts)).toEqual([
      [120, 300, 'default', 'top-left'],
      [300, 300 + DEFAULT_LAYOUT_LENGTH, 'side-by-side', 'top-left'],
      [300 + DEFAULT_LAYOUT_LENGTH, 600, 'default', 'top-left']
    ])
    expect(r.layouts.find((s) => s.id === r.id)?.layout).toBe('side-by-side')
    expect(r.layouts[0].id).toBe('a')
    // The camera is still top left before and after the change.
    const after = { ...p, layouts: r.layouts }
    for (const t of [200, 400, 599]) expect(cornerAt(after, t)).toBe('top-left')
    // A double-click on the camera track does the same.
    const viaTrack = addLayoutAt(p, 'side-by-side', 300)
    expect(viaTrack.ok && shape(viaTrack.layouts)).toEqual(shape(r.layouts))
    // The default layout there is no change.
    expect(setLayoutAt(p, 'default', 300)).toEqual({ ok: false, reason: 'same', id: 'a' })
  })

  it('stays inside the position: near its ends it is fitted in, without slivers', () => {
    // Just after the start: from the start, no sliver before it.
    let r = setLayoutAt(project([stay], 600), 'camera-only', 120.1)
    expect(r.ok && shape(r.layouts)).toEqual([
      [120, 125.1, 'camera-only', 'top-left'],
      [125.1, 600, 'default', 'top-left']
    ])
    // Next to the following position: up to it, starting earlier.
    const next = seg('b', 600, 700, 'default', 'top-right')
    r = setLayoutAt(project([stay, next], 700), 'camera-large', 599.95)
    expect(r.ok && shape(r.layouts)).toEqual([
      [120, 595, 'default', 'top-left'],
      [595, 600, 'camera-large', 'top-left'],
      [600, 700, 'default', 'top-right']
    ])
  })

  it('leaves no piece of the position too short for its own change in and out', () => {
    // 0.3 s would be left after it: the camera would cross the frame to the project corner in 0.15 s.
    const end = seg('a', 120, 300, 'default', 'top-left')
    const r = addLayoutAt(project([end], 600), 'camera-large', 294.7)
    expect(r.ok && shape(r.layouts)).toEqual([
      [120, 294.7, 'default', 'top-left'],
      [294.7, 300, 'camera-large', 'top-left']
    ])
    if (r.ok) expect(layoutRamps(project(r.layouts, 600), r.segment)).toEqual({ in: LAYOUT_TRANSITION, out: LAYOUT_TRANSITION })
    // 0.3 s before it: the position's first piece would change in over 0.3 s.
    const s = addLayoutAt(project([stay], 600), 'camera-large', 120.3)
    expect(s.ok && shape(s.layouts)).toEqual([
      [120, 125.3, 'camera-large', 'top-left'],
      [125.3, 600, 'default', 'top-left']
    ])
    if (s.ok) expect(layoutRamps(project(s.layouts, 600), s.segment).in).toBe(LAYOUT_TRANSITION)
  })

  it('a change of layout (not a position) still changes in place', () => {
    const r = setLayoutAt(project([seg('x', 10, 20, 'camera-only')]), 'side-by-side', 15)
    expect(r).toMatchObject({ ok: true, id: 'x', added: false })
    expect(addLayoutAt(project([seg('x', 10, 20, 'camera-only')]), 'side-by-side', 15)).toEqual({ ok: false, reason: 'inside', id: 'x' })
  })
})

describe('a change cut out of a camera position, deleted or dragged', () => {
  const stay = seg('a', 120, 600, 'default', 'top-left')
  const cut = (layout: CameraLayout, t: number) => {
    const r = addLayoutAt(project([stay], 600), layout, t)
    if (!r.ok) throw new Error(r.reason)
    return r
  }
  const centreAt = (layouts: LayoutSegment[], t: number) => centre(sceneCameraBox(project(layouts, 600), W, H, 1280, 720, t)!.rect)

  it('deleting it gives its time back to the position, with the camera never leaving its corner', () => {
    for (const t of [300, 597, 121, 120.1]) {
      const r = cut('camera-large', t)
      const back = removeLayout(r.layouts, r.segment.id)
      expect(shape(back), `cut out at ${t}`).toEqual([[120, 600, 'default', 'top-left']])
      expect(back[0].id).toBe('a')
    }
    // It used to leave a hole at the project corner (bottom right): two flights across the frame.
    const r = cut('camera-large', 300)
    const back = removeLayout(r.layouts, r.segment.id)
    for (const t of [299.9, 302, 305.2]) {
      const c = centreAt(back, t)
      expect(c.x < W / 4 && c.y < H / 4, `top left at ${t}: ${JSON.stringify(c)}`).toBe(true)
    }
  })

  it('a change set back to the default layout joins the pieces too', () => {
    const r = cut('camera-only', 300)
    const retyped = r.layouts.map((s) => (s.id === r.segment.id ? { ...s, layout: 'default' as const } : s))
    expect(shape(removeLayout(retyped, r.segment.id))).toEqual([[120, 600, 'default', 'top-left']])
  })

  it('deleting a camera position, or a change that was not cut out of one, takes only that one away', () => {
    const moves = [seg('a', 10, 20, 'default', 'top-left'), seg('b', 20, 30, 'default', 'top-right')]
    expect(removeLayout(moves, 'a')).toEqual([moves[1]])
    expect(removeLayout(moves, 'b')).toEqual([moves[0]])
    // A change added next to a position (no corner of its own), or in another corner.
    const next = [seg('a', 10, 20, 'default', 'top-left'), seg('x', 20, 25, 'side-by-side'), seg('y', 25, 30, 'camera-large', 'top-right'), seg('b', 30, 40, 'default', 'top-left')]
    expect(removeLayout(next, 'x')).toEqual([next[0], next[2], next[3]])
    expect(removeLayout(next, 'y')).toEqual([next[0], next[1], next[3]])
    expect(removeLayout(next, 'zzz')).toEqual(next)
    expect(removeLayout(undefined, 'a')).toEqual([])
  })

  it('moves and resizes inside the position, its pieces following its edges', () => {
    const r = cut('camera-large', 300)
    const id = r.segment.id
    const around = stayAround(r.layouts, r.segment)
    expect([around.before?.id, around.after?.id]).toEqual(['a', r.layouts[2].id])
    const bounds = layoutDragBounds(r.layouts, id, 600)
    expect(bounds).toEqual({ lower: 120 + MIN_LAYOUT_LENGTH, upper: 600 - MIN_LAYOUT_LENGTH })
    const drag = (mode: 'move' | 'start' | 'end', dt: number) => shape(dragLayout(r.layouts, id, dragLayoutTimes(r.segment, mode, dt, bounds), around))
    expect(drag('move', 10)).toEqual([
      [120, 310, 'default', 'top-left'],
      [310, 315, 'camera-large', 'top-left'],
      [315, 600, 'default', 'top-left']
    ])
    expect(drag('end', -2)).toEqual([
      [120, 300, 'default', 'top-left'],
      [300, 303, 'camera-large', 'top-left'],
      [303, 600, 'default', 'top-left']
    ])
    expect(drag('end', 10)).toEqual([
      [120, 300, 'default', 'top-left'],
      [300, 315, 'camera-large', 'top-left'],
      [315, 600, 'default', 'top-left']
    ])
    expect(drag('start', 2)).toEqual([
      [120, 302, 'default', 'top-left'],
      [302, 305, 'camera-large', 'top-left'],
      [305, 600, 'default', 'top-left']
    ])
    // Not past the position's ends: its pieces keep MIN_LAYOUT_LENGTH.
    expect(drag('move', -1000)[0]).toEqual([120, 120 + MIN_LAYOUT_LENGTH, 'default', 'top-left'])
    // A change next to a position, not cut out of it, still stops at it.
    expect(layoutDragBounds([seg('a', 10, 20, 'default', 'top-left'), seg('x', 20, 25, 'side-by-side'), seg('b', 25, 30, 'default', 'top-left')], 'x', 60)).toEqual({ lower: 20, upper: 25 })
  })

  it('side by side keeps the card on the side of the position, so the camera never crosses the frame', () => {
    const r = cut('side-by-side', 300)
    const settled = sceneCameraBox(project(r.layouts, 600), W, H, 1280, 720, 302)!.rect
    expect(settled.x + settled.w).toBeLessThan(sceneContentRect(project(r.layouts, 600), W, H, 1280, 720, 302).x)
    for (const t of [299.9, 300, 300.1, 300.2, 300.3, 300.4, 302, 305, 305.1, 305.2, 305.3, 305.4, 305.5]) {
      const c = centreAt(r.layouts, t)
      expect(c.x, `left half at ${t}: ${JSON.stringify(c)}`).toBeLessThan(W / 2)
    }
  })
})

describe('the camera of a new recording from its bubble', () => {
  const manifest = (moves: { at: number; corner: Corner }[]): RecordingManifest => {
    const m = { version: 1, id: 'r', startedAt: 1000 } as unknown as RecordingManifest
    setCameraFollows(m, true)
    setCameraMoves(m, moves, 1000, [])
    return m
  }

  it('a bubble moved during the countdown becomes the project corner, with no segment over the whole video', () => {
    const m = manifest([
      { at: 0, corner: 'bottom-right' },
      { at: 500, corner: 'top-left' }
    ])
    expect(bubbleCamera(m, 600, 'bottom-right')).toEqual({ corner: 'top-left', layouts: [] })
  })

  it('later moves stay positions against that corner', () => {
    const m = manifest([
      { at: 0, corner: 'bottom-right' },
      { at: 500, corner: 'top-left' },
      { at: 11000, corner: 'top-right' },
      { at: 21000, corner: 'top-left' }
    ])
    const r = bubbleCamera(m, 30, 'bottom-right')
    expect(r.corner).toBe('top-left')
    expect(shape(r.layouts)).toEqual([[10, 20, 'default', 'top-right']])
  })

  it('a bubble that starts in the project corner keeps it', () => {
    const m = manifest([
      { at: 0, corner: 'bottom-right' },
      { at: 3000, corner: 'top-left' }
    ])
    const r = bubbleCamera(m, 20, 'bottom-right')
    expect(r.corner).toBe('bottom-right')
    expect(shape(r.layouts)).toEqual([[2, 20, 'default', 'top-left']])
  })
})
