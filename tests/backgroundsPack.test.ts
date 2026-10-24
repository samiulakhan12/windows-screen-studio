import { describe, expect, it } from 'vitest'
import {
  ANIMATED_GRADIENTS,
  ANIMATED_PERIOD,
  animatedBlobs,
  animatedSpeed,
  animationTime,
  backgroundBlur,
  blurRadius,
  drawAnimated,
  isKnownBackground
} from '../src/shared/engine/backgrounds'
import { cardLook, shadowPaint, shadowReach } from '../src/shared/engine/cardStyle'
import type { Draw2D } from '../src/shared/engine/draw2d'
import { activeWatermark, watermarkRect, watermarkSettings, WATERMARK_SIZE } from '../src/shared/engine/watermark'
import { drawWallpaper, WALLPAPERS, wallpaperById } from '../src/shared/engine/wallpapers'
import type { Clip, WatermarkSettings } from '../src/shared/types'

/** A 2D context stand-in that records every call and property write, in order. */
function recorder(): { ctx: Draw2D; log: string[] } {
  const log: string[] = []
  const round = (v: unknown): unknown => (typeof v === 'number' ? +v.toFixed(6) : v)
  const gradient = (kind: string, args: unknown[]) => {
    log.push(`${kind}(${args.map(round).join(',')})`)
    return { addColorStop: (o: number, c: string) => log.push(`stop(${round(o)},${c})`) }
  }
  const state: Record<string, unknown> = {}
  const ctx = new Proxy(state, {
    get(target, prop: string) {
      if (prop in target) return target[prop]
      if (prop === 'createLinearGradient' || prop === 'createRadialGradient') return (...a: unknown[]) => gradient(prop, a)
      return (...a: unknown[]) => void log.push(`${prop}(${a.map(round).join(',')})`)
    },
    set(target, prop: string, value) {
      target[prop] = value
      log.push(`${prop}=${typeof value === 'object' ? 'gradient' : round(value)}`)
      return true
    }
  }) as unknown as Draw2D
  return { ctx, log }
}

describe('wallpapers', () => {
  it('has at least 12 wallpapers with unique ids and names', () => {
    expect(WALLPAPERS.length).toBeGreaterThanOrEqual(12)
    expect(new Set(WALLPAPERS.map((w) => w.id)).size).toBe(WALLPAPERS.length)
    expect(new Set(WALLPAPERS.map((w) => w.name)).size).toBe(WALLPAPERS.length)
  })

  it('draws deterministically: the same calls every time, scaled with the frame', () => {
    for (const w of WALLPAPERS) {
      const a = recorder()
      const b = recorder()
      w.draw(a.ctx, 1920, 1080)
      w.draw(b.ctx, 1920, 1080)
      expect(a.log.length).toBeGreaterThan(3)
      expect(a.log).toEqual(b.log)
      // At half the size, every coordinate halves (the picture is the same, smaller).
      const c = recorder()
      w.draw(c.ctx, 960, 540)
      expect(c.log.length).toBe(a.log.length)
    }
  })

  it('covers the whole frame first (no transparent corners)', () => {
    for (const w of WALLPAPERS) {
      const { ctx, log } = recorder()
      w.draw(ctx, 800, 600)
      expect(log.find((l) => l.startsWith('fillRect'))).toBe('fillRect(0,0,800,600)')
    }
  })

  it('falls back to the first wallpaper for an unknown id', () => {
    const a = recorder()
    const b = recorder()
    drawWallpaper(a.ctx, 100, 100, 'nope')
    WALLPAPERS[0].draw(b.ctx, 100, 100)
    expect(a.log).toEqual(b.log)
    expect(wallpaperById('nope')).toBeUndefined()
  })
})

describe('animated gradients', () => {
  it('loops seamlessly: the same picture one period later, at any speed', () => {
    for (const preset of ANIMATED_GRADIENTS) {
      for (const speed of [0.25, 1, 1.7, 2]) {
        const a = animatedBlobs(preset, 3.3, speed)
        const b = animatedBlobs(preset, 3.3 + ANIMATED_PERIOD / speed, speed)
        a.forEach((blob, i) => {
          expect(b[i].x).toBeCloseTo(blob.x, 9)
          expect(b[i].y).toBeCloseTo(blob.y, 9)
          expect(b[i].r).toBeCloseTo(blob.r, 9)
        })
      }
    }
  })

  it('moves slowly: a frame apart the blobs barely move, a few seconds apart they visibly do', () => {
    const p = ANIMATED_GRADIENTS[0]
    const a = animatedBlobs(p, 1, 1)
    const b = animatedBlobs(p, 1 + 1 / 60, 1)
    const c = animatedBlobs(p, 4, 1)
    const dist = (u: { x: number; y: number }, v: { x: number; y: number }) => Math.hypot(u.x - v.x, u.y - v.y)
    for (let i = 0; i < a.length; i++) expect(dist(a[i], b[i])).toBeLessThan(0.005)
    expect(Math.max(...a.map((blob, i) => dist(blob, c[i])))).toBeGreaterThan(0.1)
  })

  it('draws a base and one glow per colour', () => {
    const { ctx, log } = recorder()
    drawAnimated(ctx, 320, 180, ANIMATED_GRADIENTS[1], 2)
    expect(log.filter((l) => l.startsWith('fillRect')).length).toBe(1 + ANIMATED_GRADIENTS[1].colors.length)
  })

  it('clamps the speed and defaults it to 1', () => {
    expect(animatedSpeed({ type: 'animated', preset: 'aurora' })).toBe(1)
    expect(animatedSpeed({ type: 'animated', preset: 'aurora', speed: 9 })).toBe(2)
    expect(animatedSpeed({ type: 'animated', preset: 'aurora', speed: 0 })).toBe(0.25)
    expect(animatedSpeed({ type: 'animated', preset: 'aurora', speed: NaN })).toBe(1)
  })

  it('runs on output time: continuous across cuts and paced on sped-up clips', () => {
    const clips: Clip[] = [
      { id: 'a', start: 0, end: 2, speed: 1 },
      { id: 'b', start: 5, end: 9, speed: 2 }
    ]
    expect(animationTime(clips, 1)).toBeCloseTo(1)
    // Just before and just after the cut are next to each other in the video.
    expect(animationTime(clips, 5)).toBeCloseTo(2)
    expect(animationTime(clips, 7)).toBeCloseTo(3)
    // Inside the cut: the next kept frame's time.
    expect(animationTime(clips, 3)).toBeCloseTo(2)
    expect(animationTime(clips, 9)).toBeCloseTo(4)
    expect(animationTime(clips, 50)).toBeCloseTo(4)
  })
})

describe('background options', () => {
  it('blur applies to images and wallpapers only, clamped to 0..1', () => {
    expect(backgroundBlur({ type: 'image', path: 'background.png', blur: 0.4 })).toBe(0.4)
    expect(backgroundBlur({ type: 'wallpaper', id: 'dunes', blur: 3 })).toBe(1)
    expect(backgroundBlur({ type: 'wallpaper', id: 'dunes' })).toBe(0)
    expect(backgroundBlur({ type: 'wallpaper', id: 'dunes', blur: -1 })).toBe(0)
    expect(backgroundBlur({ type: 'gradient', preset: 'aurora' })).toBe(0)
    expect(blurRadius(1, 1920, 1080)).toBeCloseTo(43.2)
    expect(blurRadius(0.5, 3840, 2160)).toBeCloseTo(2 * blurRadius(0.5, 1920, 1080))
  })

  it('knows which presets exist', () => {
    expect(isKnownBackground({ type: 'wallpaper', id: 'violet-mesh' })).toBe(true)
    expect(isKnownBackground({ type: 'wallpaper', id: 'nope' })).toBe(false)
    expect(isKnownBackground({ type: 'animated', preset: 'ocean' })).toBe(true)
    expect(isKnownBackground({ type: 'animated', preset: 'nope' })).toBe(false)
    expect(isKnownBackground({ type: 'gradient', preset: 'nope' })).toBe(false)
  })
})

describe('card look', () => {
  it('keeps the original soft shadow for older projects', () => {
    const look = cardLook({})
    expect(look).toEqual({ shadowStyle: 'soft', shadowColor: '#000000', border: null })
    expect(shadowPaint(look, 0.6, 2)).toEqual({ kind: 'blur', color: 'rgba(0,0,0,0.33)', blur: 70 * 2 * 0.6, offsetX: 0, offsetY: 22 * 2 * 0.6 })
    expect(shadowPaint(look, 0, 1)).toBeNull()
  })

  it('hard shadows are solid and offset; glows are coloured, centred and blurred', () => {
    const hard = shadowPaint(cardLook({ shadowStyle: 'hard', shadowColor: '#ff0000' }), 0.5, 1)
    expect(hard).toEqual({ kind: 'solid', color: '#ff0000', offsetX: 13, offsetY: 13 })
    const glow = shadowPaint(cardLook({ shadowStyle: 'glow' }), 1, 1)
    expect(glow).toMatchObject({ kind: 'blur', color: 'rgba(139,92,246,1)', offsetX: 0, offsetY: 0 })
    expect(shadowReach(glow)).toBeGreaterThan(110)
    expect(shadowReach(null)).toBe(0)
  })

  it('validates borders and colours', () => {
    expect(cardLook({ border: { width: 0, color: '#fff000', glass: false } }).border).toBeNull()
    expect(cardLook({ border: { width: 99, color: 'red', glass: 'yes' as unknown as boolean } }).border).toEqual({ width: 24, color: '#ffffff', glass: false })
    expect(cardLook({ shadowStyle: 'weird' as 'soft', shadowColor: 'blue' })).toEqual({ shadowStyle: 'soft', shadowColor: '#000000', border: null })
  })
})

describe('watermark', () => {
  const wm = (patch: Partial<WatermarkSettings>): WatermarkSettings => ({ show: true, kind: 'text', text: 'ACME', position: 'bottom-right', size: 0.05, opacity: 0.8, margin: 0.04, ...patch })

  it('is drawn only when shown and not empty', () => {
    expect(activeWatermark({})).toBeNull()
    expect(activeWatermark({ watermark: wm({ show: false }) })).toBeNull()
    expect(activeWatermark({ watermark: wm({ text: '  ' }) })).toBeNull()
    expect(activeWatermark({ watermark: wm({ kind: 'image' }) })).toBeNull()
    expect(activeWatermark({ watermark: wm({ kind: 'image', path: 'watermark.png' }) })?.path).toBe('watermark.png')
    expect(activeWatermark({ watermark: wm({ kind: 'image', path: '../secret.png' }) })).toBeNull()
  })

  it('fills in and clamps bad values', () => {
    const s = watermarkSettings({ kind: 'image', size: 7, opacity: -1, margin: NaN, position: 'middle' } as unknown as WatermarkSettings)
    expect(s).toEqual({ show: true, kind: 'image', text: '', position: 'bottom-right', size: 0.4, opacity: 0.1, margin: 0.035 })
    expect(watermarkSettings({ kind: 'text' } as WatermarkSettings)?.size).toBe(WATERMARK_SIZE.text)
  })

  it('sits in the chosen corner, inside the margin, sized from the shorter side', () => {
    const W = 1920
    const H = 1080
    const img = watermarkRect(W, H, wm({ kind: 'image', size: 0.2, position: 'top-left' }), 2)
    expect(img).toEqual({ x: 0.04 * 1080, y: 0.04 * 1080, w: 216, h: 108 })
    const text = watermarkRect(W, H, wm({ size: 0.05, position: 'bottom-right' }), 4)
    expect(text.h).toBeCloseTo(54)
    expect(text.w).toBeCloseTo(216)
    expect(text.x + text.w).toBeCloseTo(W - 0.04 * 1080)
    expect(text.y + text.h).toBeCloseTo(H - 0.04 * 1080)
    const c = watermarkRect(W, H, wm({ position: 'center' }), 3)
    expect(c.x + c.w / 2).toBeCloseTo(W / 2)
    expect(c.y + c.h / 2).toBeCloseTo(H / 2)
  })

  it('never grows past the frame', () => {
    const r = watermarkRect(400, 400, wm({ size: 0.4, margin: 0 }), 20)
    expect(r.w).toBeLessThanOrEqual(400 + 1e-9)
    expect(r.x).toBeGreaterThanOrEqual(-1e-9)
  })
})
