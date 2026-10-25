import { describe, expect, it } from 'vitest'
import type { RecordingManifest } from '../src/main/projects'
import { bubbleCamera, setCameraFollows, setCameraMoves } from '../src/main/recording/cameraMoves'
import { setLayoutAt } from '../src/shared/editor/layoutCommands'
import { addLayoutAt, cornerAt, DEFAULT_LAYOUT_LENGTH } from '../src/shared/editor/layouts'
import { LAYOUT_TRANSITION, sceneCameraBox, type Rect, type SceneProject } from '../src/shared/engine/layout'
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

  it('a change of layout (not a position) still changes in place', () => {
    const r = setLayoutAt(project([seg('x', 10, 20, 'camera-only')]), 'side-by-side', 15)
    expect(r).toMatchObject({ ok: true, id: 'x', added: false })
    expect(addLayoutAt(project([seg('x', 10, 20, 'camera-only')]), 'side-by-side', 15)).toEqual({ ok: false, reason: 'inside', id: 'x' })
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
