import { describe, expect, it } from 'vitest'
import { deviceFrameDrawing, FRAME_KINDS, frameInsets, frameOf, frameTakesBorder, frameTitle, screenCornerRadius, screenRadii, type FrameDrawing } from '../src/shared/engine/deviceFrames'
import { contentRect, styleContentRect, type Rect } from '../src/shared/engine/layout'
import type { DeviceFrame, DeviceFrameKind, StyleSettings } from '../src/shared/types'

const base: Pick<StyleSettings, 'padding' | 'frame'> = { padding: 0.07 }
const withFrame = (kind: DeviceFrameKind, padding = 0.07, theme: DeviceFrame['theme'] = 'light'): Pick<StyleSettings, 'padding' | 'frame'> => ({ padding, frame: { kind, theme } })

const inside = (inner: Rect, outer: Rect, eps = 1e-6): boolean =>
  inner.x >= outer.x - eps && inner.y >= outer.y - eps && inner.x + inner.w <= outer.x + outer.w + eps && inner.y + inner.h <= outer.y + outer.h + eps

/** Every rectangle a drawing paints or casts a shadow with. */
function rects(d: FrameDrawing): Rect[] {
  const out: Rect[] = d.outline.map((o) => o.rect)
  for (const p of d.parts) {
    if (p.type === 'rrect') out.push(p.rect)
    else if (p.type === 'circle') out.push({ x: p.x - p.r, y: p.y - p.r, w: p.r * 2, h: p.r * 2 })
  }
  return out
}

describe('frameOf', () => {
  it('is null without a frame, for none and for unknown kinds', () => {
    expect(frameOf({})).toBeNull()
    expect(frameOf({ frame: { kind: 'none', theme: 'dark' } })).toBeNull()
    expect(frameOf({ frame: { kind: 'tablet' as DeviceFrameKind, theme: 'dark' } })).toBeNull()
    expect(frameOf({ frame: 'browser' as unknown as DeviceFrame })).toBeNull()
  })
  it('fills in a missing or invalid theme', () => {
    expect(frameOf({ frame: { kind: 'phone', theme: 'blue' as 'light' } })).toEqual({ kind: 'phone', theme: 'light' })
    expect(frameOf({ frame: { kind: 'browser', theme: 'dark', title: 'x.com' } })).toEqual({ kind: 'browser', theme: 'dark', title: 'x.com' })
  })
  it('titles the browser with its own text, else the project name', () => {
    expect(frameTitle({ frame: { kind: 'browser', theme: 'light', title: ' app.example.com ' } }, 'Demo')).toBe('app.example.com')
    expect(frameTitle({ frame: { kind: 'browser', theme: 'light', title: '   ' } }, 'Demo')).toBe('Demo')
    expect(frameTitle({}, 'My recording')).toBe('My recording')
  })
})

describe('styleContentRect', () => {
  it('is exactly contentRect without a frame (older projects keep their layout)', () => {
    for (const [w, h, sw, sh] of [
      [1920, 1080, 1280, 720],
      [1080, 1920, 1920, 1080],
      [1000, 1000, 333, 777]
    ]) {
      expect(styleContentRect(w, h, sw, sh, base)).toEqual(contentRect(w, h, sw, sh, 0.07))
      expect(styleContentRect(w, h, sw, sh, { padding: 0.07, frame: { kind: 'none', theme: 'light' } })).toEqual(contentRect(w, h, sw, sh, 0.07))
    }
  })

  for (const kind of FRAME_KINDS.filter((k) => k !== 'none')) {
    it(`${kind}: the recording and its chrome fit inside the padding, chrome around the recording`, () => {
      for (const [W, H, sw, sh] of [
        [1920, 1080, 1280, 720],
        [1080, 1920, 1920, 1080],
        [1080, 1920, 1080, 1920],
        [1080, 1080, 2560, 1080],
        [1920, 1080, 600, 1300]
      ]) {
        const style = withFrame(kind)
        const r = styleContentRect(W, H, sw, sh, style)
        // Aspect ratio of the recording is kept.
        expect(r.w / r.h).toBeCloseTo(sw / sh, 6)
        const d = deviceFrameDrawing(frameOf(style)!, r, { radius: 14, title: 'Demo' })
        const pad = Math.min(W, H) * 0.07
        const avail = { x: pad, y: pad, w: W - pad * 2, h: H - pad * 2 }
        expect(inside(d.outer, avail, 1e-6)).toBe(true)
        // The device touches the padding on at least one axis (it is as large as it can be).
        const fillsW = Math.abs(d.outer.w - avail.w) < 1e-6
        const fillsH = Math.abs(d.outer.h - avail.h) < 1e-6
        expect(fillsW || fillsH).toBe(true)
        // Centred.
        expect(d.outer.x + d.outer.w / 2).toBeCloseTo(W / 2, 6)
        expect(d.outer.y + d.outer.h / 2).toBeCloseTo(H / 2, 6)
        // Everything drawn stays inside the device's box, and the recording inside it too.
        for (const p of rects(d)) expect(inside(p, d.outer, 1e-6)).toBe(true)
        expect(inside(r, d.outer)).toBe(true)
        // The recording is never larger than without the frame: the chrome takes room.
        const bare = contentRect(W, H, sw, sh, 0.07)
        expect(r.w).toBeLessThanOrEqual(bare.w + 1e-9)
        if (W === 1920 && sw === 1280) expect(r.w).toBeLessThan(bare.w)
      }
    })
  }

  it('puts the browser bar above the recording and the laptop base below it', () => {
    const b = styleContentRect(1920, 1080, 1280, 720, withFrame('browser'))
    const bd = deviceFrameDrawing({ kind: 'browser', theme: 'light' }, b, { radius: 14, title: 'Demo' })
    expect(bd.outer.y).toBeLessThan(b.y)
    expect(bd.outer.y + bd.outer.h).toBeCloseTo(b.y + b.h, 6)
    const l = styleContentRect(1920, 1080, 1280, 720, withFrame('laptop'))
    const ld = deviceFrameDrawing({ kind: 'laptop', theme: 'light' }, l, { radius: 14, title: '' })
    expect(ld.outer.y + ld.outer.h - (l.y + l.h)).toBeGreaterThan(l.y - ld.outer.y)
    expect(ld.outer.w).toBeGreaterThan(l.w * 1.1)
    const m = styleContentRect(1920, 1080, 1280, 720, withFrame('monitor'))
    const md = deviceFrameDrawing({ kind: 'monitor', theme: 'dark' }, m, { radius: 14, title: '' })
    // The stand reaches well below the screen.
    expect(md.outer.y + md.outer.h - (m.y + m.h)).toBeGreaterThan(0.15 * m.h)
  })

  it('with no padding the device fills the frame on one axis', () => {
    const r = styleContentRect(1920, 1080, 1920, 1080, withFrame('monitor', 0))
    const d = deviceFrameDrawing({ kind: 'monitor', theme: 'light' }, r, { radius: 0, title: '' })
    expect(d.outer.y).toBeCloseTo(0, 6)
    expect(d.outer.h).toBeCloseTo(1080, 6)
  })
})

describe('deviceFrameDrawing', () => {
  const screen = { x: 300, y: 200, w: 1280, h: 720 }

  it('scales and moves with the recording (a pulled-back card shrinks its chrome)', () => {
    for (const kind of ['browser', 'laptop', 'monitor', 'phone'] as const) {
      const full = deviceFrameDrawing({ kind, theme: 'dark' }, screen, { radius: 20, title: 'Demo' })
      const half = { x: screen.x + 100, y: screen.y + 50, w: screen.w / 2, h: screen.h / 2 }
      const small = deviceFrameDrawing({ kind, theme: 'dark' }, half, { radius: 10, title: 'Demo' })
      expect(small.outer.w).toBeCloseTo(full.outer.w / 2, 6)
      expect(small.outer.h).toBeCloseTo(full.outer.h / 2, 6)
      expect(small.outer.x - half.x).toBeCloseTo((full.outer.x - screen.x) / 2, 6)
      expect(small.parts.length).toBe(full.parts.length)
    }
  })

  it('draws a browser bar with three window buttons and the title', () => {
    const d = deviceFrameDrawing({ kind: 'browser', theme: 'light' }, screen, { radius: 16, title: 'app.example.com' })
    const dots = d.parts.filter((p) => p.type === 'circle')
    expect(dots.map((p) => p.fill)).toEqual(['#ff5f57', '#febc2e', '#28c840'])
    const text = d.parts.find((p) => p.type === 'text')
    expect(text && text.type === 'text' && text.text).toBe('app.example.com')
    // Bar above the recording; the window's top corners are rounded, the recording's only at the bottom.
    expect(d.screenRadii).toEqual([0, 0, 16, 16])
    expect(d.outline[0].radii).toEqual([16, 16, 16, 16])
    expect(d.outline[0].rect.y).toBeLessThan(screen.y)
  })

  it('keeps the address field clear of the window buttons, even on a narrow window', () => {
    for (const s of [screen, { x: 0, y: 40, w: 90, h: 300 }]) {
      const d = deviceFrameDrawing({ kind: 'browser', theme: 'light' }, s, { radius: 4, title: 'Title' })
      const lastDot = d.parts.filter((p) => p.type === 'circle').at(-1)!
      const field = d.parts.find((p) => p.type === 'rrect' && p.fill === '#ffffff')!
      expect(field.type === 'rrect' && lastDot.type === 'circle' && field.rect.x > lastDot.x + lastDot.r).toBe(true)
      expect(field.type === 'rrect' && field.rect.x + field.rect.w <= s.x + s.w).toBe(true)
    }
  })

  it('themes change colours, not geometry', () => {
    for (const kind of ['browser', 'laptop', 'monitor', 'phone'] as const) {
      const a = deviceFrameDrawing({ kind, theme: 'light' }, screen, { radius: 12, title: 'x' })
      const b = deviceFrameDrawing({ kind, theme: 'dark' }, screen, { radius: 12, title: 'x' })
      expect(rects(a)).toEqual(rects(b))
      expect(JSON.stringify(a.parts)).not.toEqual(JSON.stringify(b.parts))
    }
  })

  it('devices choose the recording corners; bare recordings and browsers use the style radius', () => {
    expect(screenRadii(null, screen, 30)).toEqual([30, 30, 30, 30])
    expect(screenRadii(null, { x: 0, y: 0, w: 20, h: 10 }, 30)).toEqual([5, 5, 5, 5])
    expect(screenCornerRadius({ kind: 'phone', theme: 'light' }, screen, 0)).toBeCloseTo(0.075 * 720)
    expect(screenCornerRadius({ kind: 'laptop', theme: 'light' }, screen, 60)).toBeCloseTo(7.2)
    expect(frameTakesBorder(null)).toBe(true)
    expect(frameTakesBorder({ kind: 'browser', theme: 'light' })).toBe(true)
    expect(frameTakesBorder({ kind: 'laptop', theme: 'light' })).toBe(false)
  })

  it('insets are non-negative and only the browser has none at the bottom', () => {
    for (const kind of FRAME_KINDS) {
      const i = frameInsets(kind)
      for (const v of Object.values(i)) expect(v).toBeGreaterThanOrEqual(0)
    }
    expect(frameInsets('browser').bottom).toBe(0)
    expect(frameInsets('none')).toEqual({ top: 0, right: 0, bottom: 0, left: 0 })
  })
})
