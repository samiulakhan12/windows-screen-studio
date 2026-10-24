import { describe, expect, it } from 'vitest'
import {
  cameraRadius,
  cameraSourceRect,
  LAYOUT_TRANSITION,
  layoutGeometry,
  layoutMoving,
  layoutPhaseAt,
  layoutRamps,
  sceneCameraBox,
  sceneContentRect,
  sceneLayout,
  styleContentRect,
  webcamRect,
  type Rect,
  type SceneProject
} from '../src/shared/engine/layout'
import type { CameraLayout, LayoutSegment, StyleSettings } from '../src/shared/types'

const STYLE: StyleSettings = { background: { type: 'color', color: '#000000' }, padding: 0.07, cornerRadius: 14, shadow: 0.6, aspectRatio: 'auto' }

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

const seg = (id: string, start: number, end: number, layout: CameraLayout): LayoutSegment => ({ id, start, end, layout })
const W = 1920
const H = 1080
const inside = (a: Rect, b: Rect, eps = 1e-6): boolean => a.x >= b.x - eps && a.y >= b.y - eps && a.x + a.w <= b.x + b.w + eps && a.y + a.h <= b.y + b.h + eps
const overlap = (a: Rect, b: Rect): boolean => a.x < b.x + b.w && b.x < a.x + a.w && a.y < b.y + b.h && b.y < a.y + a.h
const expectRect = (a: Rect, b: Rect): void => {
  expect(a.x).toBeCloseTo(b.x, 6)
  expect(a.y).toBeCloseTo(b.y, 6)
  expect(a.w).toBeCloseTo(b.w, 6)
  expect(a.h).toBeCloseTo(b.h, 6)
}

describe('scene layout without layout changes', () => {
  it('is exactly the style rectangle and the camera bubble (old projects draw as before)', () => {
    const p = project()
    expect(sceneContentRect(p, W, H, 1280, 720, 3)).toEqual(styleContentRect(W, H, 1280, 720, STYLE))
    const cam = sceneCameraBox(p, W, H, 1280, 720, 3)!
    expect(cam.rect).toEqual(webcamRect(W, H, p.webcam))
    expect(cam.radius).toBe(cam.rect.w / 2)
    expect(cam.opacity).toBe(1)
  })

  it('ignores layouts when the recording has no camera or it is hidden', () => {
    const layouts = [seg('a', 0, 10, 'side-by-side')]
    const base = styleContentRect(W, H, 1280, 720, STYLE)
    expect(sceneContentRect(project(layouts, { hasWebcam: false }), W, H, 1280, 720, 5)).toEqual(base)
    const hidden = project(layouts, { webcam: { show: false, corner: 'bottom-right', size: 0.24, shape: 'circle' } })
    expect(sceneLayout(hidden, W, H, 1280, 720, 5)).toEqual({ screen: base, camera: null, moving: false })
    expect(layoutMoving(hidden, 0.1)).toBe(false)
  })

  it('rounds the camera by its shape', () => {
    const r = { x: 0, y: 0, w: 200, h: 100 }
    expect(cameraRadius('circle', r)).toBe(50)
    expect(cameraRadius('rounded', r)).toBeCloseTo(18)
    expect(cameraRadius('square', r)).toBe(0)
  })
})

describe('layout geometry', () => {
  const p = project()
  const pad = 1080 * STYLE.padding
  const area = { x: pad, y: pad, w: W - pad * 2, h: H - pad * 2 }

  it('camera only: the camera card fills the padded frame and hides the screen under it', () => {
    const g = layoutGeometry('camera-only', p, W, H, 1280, 720)
    expectRect(g.camera.rect, area)
    expect(g.camera.radius).toBeCloseTo(14)
    expect(g.camera.opacity).toBe(1)
    // The screen (and its shadow) stays well inside the camera card.
    expect(inside(g.screen, { x: area.x + 200, y: area.y + 150, w: area.w - 400, h: area.h - 300 })).toBe(true)
  })

  it('screen only: the screen stays, the camera fades out where its bubble was', () => {
    const g = layoutGeometry('screen-only', p, W, H, 1280, 720)
    expect(g.screen).toEqual(styleContentRect(W, H, 1280, 720, STYLE))
    expect(g.camera.opacity).toBe(0)
    expect(inside(g.camera.rect, webcamRect(W, H, p.webcam))).toBe(true)
  })

  it('large camera: a bigger bubble in the same corner', () => {
    const g = layoutGeometry('camera-large', p, W, H, 1280, 720)
    const bubble = webcamRect(W, H, p.webcam)
    expect(g.camera.rect.w).toBeGreaterThan(bubble.w * 2)
    expect(g.camera.rect.x + g.camera.rect.w).toBeCloseTo(bubble.x + bubble.w)
    expect(g.camera.rect.y + g.camera.rect.h).toBeCloseTo(bubble.y + bubble.h)
    expect(g.screen).toEqual(styleContentRect(W, H, 1280, 720, STYLE))
  })

  it('side by side (landscape): a tall camera card next to the screen, same height, inside the padding', () => {
    const g = layoutGeometry('side-by-side', p, W, H, 1280, 720)
    expect(inside(g.screen, area)).toBe(true)
    expect(inside(g.camera.rect, area)).toBe(true)
    expect(overlap(g.screen, g.camera.rect)).toBe(false)
    expect(g.camera.rect.h).toBeCloseTo(g.screen.h)
    expect(g.camera.rect.w / g.camera.rect.h).toBeCloseTo(3 / 4)
    expect(g.screen.w / g.screen.h).toBeCloseTo(16 / 9)
    // Bottom-right corner: the camera is on the right.
    expect(g.camera.rect.x).toBeGreaterThan(g.screen.x)
    // Centred as a pair.
    const left = g.screen.x - area.x
    const right = area.x + area.w - (g.camera.rect.x + g.camera.rect.w)
    expect(left).toBeCloseTo(right)
    const onLeft = layoutGeometry('side-by-side', project([], { webcam: { ...p.webcam, corner: 'top-left' } }), W, H, 1280, 720)
    expect(onLeft.camera.rect.x).toBeLessThan(onLeft.screen.x)
  })

  it('side by side (portrait and square): stacked, the camera on its corner side', () => {
    for (const [w, h] of [
      [1080, 1920],
      [1080, 1080]
    ]) {
      const g = layoutGeometry('side-by-side', p, w, h, 1280, 720)
      expect(overlap(g.screen, g.camera.rect)).toBe(false)
      expect(g.camera.rect.y).toBeGreaterThan(g.screen.y)
      expect(g.camera.rect.w).toBeCloseTo(g.screen.w)
      const top = layoutGeometry('side-by-side', project([], { webcam: { ...p.webcam, corner: 'top-right' } }), w, h, 1280, 720)
      expect(top.camera.rect.y).toBeLessThan(top.screen.y)
    }
  })

  it('side by side keeps room for a device frame around the screen', () => {
    const framed = project([], { style: { ...STYLE, frame: { kind: 'browser', theme: 'light' } } })
    const g = layoutGeometry('side-by-side', framed, W, H, 1280, 720)
    // The browser bar sits above the recording, so the recording starts lower than the camera card.
    expect(g.screen.y).toBeGreaterThan(g.camera.rect.y)
    expect(overlap(g.screen, g.camera.rect)).toBe(false)
  })
})

describe('layout changes over time', () => {
  const T = LAYOUT_TRANSITION

  it('animates into a segment over its first seconds and back out over its last ones', () => {
    const p = project([seg('a', 5, 10, 'camera-only')])
    expect(layoutPhaseAt(p, 4.9)).toEqual({ from: 'default', to: 'default', progress: 1 })
    expect(layoutPhaseAt(p, 5)).toMatchObject({ from: 'default', to: 'camera-only', progress: 0 })
    expect(layoutPhaseAt(p, 5 + T / 2).progress).toBeCloseTo(0.5)
    expect(layoutPhaseAt(p, 5 + T)).toEqual({ from: 'camera-only', to: 'camera-only', progress: 1 })
    expect(layoutPhaseAt(p, 10 - T / 2)).toMatchObject({ from: 'camera-only', to: 'default' })
    expect(layoutPhaseAt(p, 10 - T / 2).progress).toBeCloseTo(0.5)
    expect(layoutPhaseAt(p, 10).progress).toBe(1)
    // Half way the screen is between where it was and where it goes (eased).
    const a = layoutGeometry('default', p, W, H, 1280, 720)
    const b = layoutGeometry('camera-only', p, W, H, 1280, 720)
    const mid = sceneLayout(p, W, H, 1280, 720, 5 + T / 2)
    expect(mid.screen.w).toBeCloseTo((a.screen.w + b.screen.w) / 2)
    expect(mid.camera!.rect.w).toBeCloseTo((a.camera.rect.w + b.camera.rect.w) / 2)
    expect(mid.moving).toBe(true)
    expect(sceneLayout(p, W, H, 1280, 720, 7).moving).toBe(false)
    expect(sceneLayout(p, W, H, 1280, 720, 7).screen).toEqual(b.screen)
  })

  it('changes straight from one segment to the next when they are back to back', () => {
    const p = project([seg('a', 2, 6, 'side-by-side'), seg('b', 6, 9, 'camera-only')])
    expect(layoutPhaseAt(p, 5.9)).toEqual({ from: 'side-by-side', to: 'side-by-side', progress: 1 })
    expect(layoutPhaseAt(p, 6.1)).toMatchObject({ from: 'side-by-side', to: 'camera-only' })
    expect(layoutRamps(p, p.layouts![0])).toEqual({ in: T, out: 0 })
    expect(layoutRamps(p, p.layouts![1])).toEqual({ in: T, out: T })
  })

  it('is instant at the start and end of the edit', () => {
    const p = project([seg('a', 0, 4, 'camera-only'), seg('b', 25, 30, 'side-by-side')])
    expect(layoutPhaseAt(p, 0)).toEqual({ from: 'camera-only', to: 'camera-only', progress: 1 })
    expect(layoutPhaseAt(p, 29.99).progress).toBe(1)
    expect(layoutRamps(p, p.layouts![0])).toEqual({ in: 0, out: T })
    expect(layoutRamps(p, p.layouts![1])).toEqual({ in: T, out: 0 })
    // Trimmed: the first kept frame is where the edit starts.
    const trimmed = project([seg('a', 2, 4, 'camera-only')], { clips: [{ id: 'c', start: 2, end: 30, speed: 1 }] })
    expect(layoutPhaseAt(trimmed, 2).progress).toBe(1)
  })

  it('splits a short segment between its two changes', () => {
    const p = project([seg('a', 5, 5.4, 'camera-large')])
    const ramps = layoutRamps(p, p.layouts![0])
    expect(ramps.in).toBeCloseTo(0.2)
    expect(ramps.out).toBeCloseTo(0.2)
    expect(layoutPhaseAt(p, 5.1).progress).toBeCloseTo(0.5)
    expect(layoutPhaseAt(p, 5.3)).toMatchObject({ from: 'camera-large', to: 'default' })
  })

  it('works with unsorted segments and without clips', () => {
    const p = project([seg('b', 10, 12, 'screen-only'), seg('a', 2, 4, 'camera-only')], { clips: undefined, duration: undefined })
    expect(layoutPhaseAt(p, 3).to).toBe('camera-only')
    expect(layoutPhaseAt(p, 11).to).toBe('screen-only')
    expect(layoutPhaseAt(p, 7).to).toBe('default')
  })

  it('reports the screen as moving only when it actually moves', () => {
    const p = project([seg('a', 2, 6, 'camera-large'), seg('b', 8, 12, 'screen-only'), seg('c', 14, 18, 'side-by-side')])
    expect(layoutMoving(p, 2.1)).toBe(false)
    expect(layoutMoving(p, 8.1)).toBe(false)
    expect(layoutMoving(p, 14.1)).toBe(true)
    expect(layoutMoving(p, 16)).toBe(false)
    // The hidden camera fades: half way it is half transparent.
    expect(sceneCameraBox(p, W, H, 1280, 720, 8 + LAYOUT_TRANSITION / 2)!.opacity).toBeCloseTo(0.5)
    expect(sceneCameraBox(p, W, H, 1280, 720, 10)!.opacity).toBe(0)
  })
})

describe('cameraSourceRect', () => {
  it('is a centred cover fit at zoom 1', () => {
    // 16:9 camera in a square bubble: the middle square.
    expect(cameraSourceRect(1280, 720, 200, 200, {})).toEqual({ x: 280, y: 0, w: 720, h: 720 })
    // Same shape: the whole picture.
    expect(cameraSourceRect(1280, 720, 640, 360, {})).toEqual({ x: 0, y: 0, w: 1280, h: 720 })
  })

  it('zooms in around the crop centre and stays inside the picture', () => {
    expect(cameraSourceRect(1280, 720, 640, 360, { zoom: 2, cropX: 0.5, cropY: 0.5 })).toEqual({ x: 320, y: 180, w: 640, h: 360 })
    expect(cameraSourceRect(1280, 720, 640, 360, { zoom: 2, cropX: 0, cropY: 1 })).toEqual({ x: 0, y: 360, w: 640, h: 360 })
    // At zoom 1 a square bubble can still slide across a wide picture.
    expect(cameraSourceRect(1280, 720, 200, 200, { cropX: 0 }).x).toBe(0)
    expect(cameraSourceRect(1280, 720, 200, 200, { cropX: 1 }).x).toBe(560)
    // Out-of-range values are clamped.
    expect(cameraSourceRect(1280, 720, 640, 360, { zoom: 9 }).w).toBeCloseTo(1280 / 3)
    expect(cameraSourceRect(1280, 720, 640, 360, { zoom: NaN })).toEqual({ x: 0, y: 0, w: 1280, h: 720 })
  })
})
