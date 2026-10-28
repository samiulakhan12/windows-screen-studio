import { describe, expect, it } from 'vitest'
import { createOverlay, moveOverlay, overlayLabel, resetOverlayShape, resizeOverlay, rotationToward, sizeForAspect } from '../src/shared/editor/overlays'
import { migrateProject } from '../src/shared/engine/project'
import { MAX_OVERLAYS, normalizeAngle, readBrand, readFonts, readOverlay, readOverlays } from '../src/shared/engine/overlayData'
import { gifFrameAt, gifScale, gifTiming, GIF_MAX_BYTES, imageSizeProblem, overlayAlpha, overlayBox, overlayClockMs, playedDelays } from '../src/shared/render/imageOverlays'
import { isSticker, STICKERS, stickerUrl } from '../src/shared/render/stickers'
import type { Clip, ImageOverlay } from '../src/shared/types'

const ONE: Clip[] = [{ id: 'c', start: 0, end: 10, speed: 1 }]
const base: ImageOverlay = { id: 'o', start: 2, end: 5, file: 'overlay-1.png', x: 0.5, y: 0.5, w: 0.3, h: 0.2, rotation: 0, opacity: 1, fadeIn: 0, fadeOut: 0 }

describe('overlay geometry', () => {
  it('sizes both sides by the shorter side of the frame, so 9:16 never stretches it', () => {
    const wide = overlayBox(base, 1920, 1080)
    const tall = overlayBox(base, 1080, 1920)
    expect(wide).toMatchObject({ cx: 960, cy: 540, w: 324, h: 216 })
    expect(tall.w / tall.h).toBeCloseTo(wide.w / wide.h)
    expect(overlayBox({ ...base, rotation: 90 }, 100, 100).angle).toBeCloseTo(Math.PI / 2)
  })

  it('sizes a new image from its aspect, long side 0.35; a sticker is square at 0.22', () => {
    expect(sizeForAspect(2, 0.35)).toEqual({ w: 0.35, h: 0.175 })
    expect(sizeForAspect(0.5, 0.35)).toEqual({ w: 0.175, h: 0.35 })
    const img = createOverlay(1, 10, { file: 'overlay-1.png', name: 'logo.png' }, 2, 'x')
    expect(img).toMatchObject({ start: 1, end: 4, w: 0.35, h: 0.175, x: 0.5, y: 0.5, rotation: 0, opacity: 1, fadeIn: 0.2, fadeOut: 0.2, name: 'logo.png' })
    const st = createOverlay(9, 10, { sticker: 'star' }, 3, 'y')
    expect(st).toMatchObject({ start: 7, end: 10, w: 0.22, h: 0.22, sticker: 'star' })
    expect(st.file).toBeUndefined()
    expect(overlayLabel(st)).toBe('Star sticker')
  })

  it('moves by preview pixels and keeps the centre near the frame', () => {
    expect(moveOverlay(base, 100, -50, { w: 1000, h: 500 })).toEqual({ x: 0.6, y: 0.4 })
    expect(moveOverlay(base, 10000, 0, { w: 1000, h: 500 }).x).toBe(1.5)
  })

  it('resizes from a corner with the opposite corner fixed; Shift keeps the shape', () => {
    const frame = { w: 1000, h: 1000 }
    const g = { x: 0.5, y: 0.5, w: 0.2, h: 0.1, rotation: 0 }
    const free = resizeOverlay(g, 'se', 100, 0, frame, false)
    expect(free.w).toBeCloseTo(0.3)
    expect(free.h).toBeCloseTo(0.1)
    // Top-left corner stayed at (400, 450).
    expect(free.x * 1000 - (free.w * 1000) / 2).toBeCloseTo(400)
    expect(free.y * 1000 - (free.h * 1000) / 2).toBeCloseTo(450)
    const kept = resizeOverlay(g, 'se', 100, 0, frame, true)
    expect(kept.w / kept.h).toBeCloseTo(2)
    expect(kept.w).toBeCloseTo(0.3)
    // An edge with Shift scales the other side around the centre.
    const edge = resizeOverlay(g, 'e', 200, 0, frame, true)
    expect(edge.h).toBeCloseTo(0.2)
    expect(edge.y).toBeCloseTo(0.5)
  })

  it('resizes along the rotated axes', () => {
    const frame = { w: 1000, h: 1000 }
    const g = { x: 0.5, y: 0.5, w: 0.2, h: 0.2, rotation: 90 }
    // Rotated 90° clockwise, the overlay's right edge points down: dragging down widens it.
    const r = resizeOverlay(g, 'e', 0, 100, frame, false)
    expect(r.w).toBeCloseTo(0.3)
    expect(r.h).toBeCloseTo(0.2)
    expect(r.x).toBeCloseTo(0.5)
    expect(r.y).toBeCloseTo(0.55)
  })

  it('never resizes below or above the limits', () => {
    const frame = { w: 1000, h: 1000 }
    const g = { x: 0.5, y: 0.5, w: 0.2, h: 0.1, rotation: 0 }
    expect(resizeOverlay(g, 'w', 900, 0, frame, false).w).toBeCloseTo(0.02)
    const tiny = resizeOverlay(g, 'nw', 900, 900, frame, true)
    expect(Math.min(tiny.w, tiny.h)).toBeGreaterThanOrEqual(0.02 - 1e-9)
    expect(resizeOverlay(g, 'e', 99999, 0, frame, false).w).toBeCloseTo(2)
  })

  it('rotates toward the pointer, clockwise from straight up; Shift snaps to 15°', () => {
    const c = { x: 100, y: 100 }
    expect(rotationToward(c, { x: 100, y: 0 }, false)).toBeCloseTo(0)
    expect(rotationToward(c, { x: 200, y: 100 }, false)).toBeCloseTo(90)
    expect(rotationToward(c, { x: 0, y: 100 }, false)).toBeCloseTo(-90)
    expect(rotationToward(c, { x: 100, y: 200 }, false)).toBe(180)
    expect(rotationToward(c, { x: 150, y: 10 }, true) % 15).toBe(0)
    expect(normalizeAngle(190)).toBe(-170)
    expect(normalizeAngle(-180)).toBe(180)
  })

  it('resets the shape to the image aspect keeping the long side', () => {
    expect(resetOverlayShape({ w: 0.4, h: 0.4 }, 2)).toEqual({ w: 0.4, h: 0.2 })
  })

  it('keeps the short side at 0.02 or more, so a wide logo is not stretched when the project is opened again', () => {
    const stored = (s: { w: number; h: number }): { w: number; h: number } => {
      const o = readOverlay(JSON.parse(JSON.stringify({ ...base, ...s })))!
      return { w: o.w, h: o.h }
    }
    // A 10:1 wordmark made small: the long side stops at 0.2, where the short one reaches 0.02.
    const small = sizeForAspect(10, 0.15)
    expect(small.w).toBeCloseTo(0.2, 9)
    expect(small.h).toBeGreaterThanOrEqual(0.02)
    expect(small.w / small.h).toBeCloseTo(10, 9)
    expect(stored(small)).toEqual(small)
    // Tall the same way; and a new image wider than 17.5:1.
    const tall = sizeForAspect(0.1, 0.05)
    expect(tall.h).toBeCloseTo(0.2, 9)
    expect(stored(tall)).toEqual(tall)
    const strip = createOverlay(0, 10, { file: 'overlay-1.png' }, 25, 's')
    expect(strip.w / strip.h).toBeCloseTo(25, 9)
    expect(stored(strip)).toEqual({ w: strip.w, h: strip.h })
    // Reset shape on such a logo gives the same size, so it repairs it.
    expect(resetOverlayShape({ w: 0.15, h: 0.02 }, 10)).toEqual(small)
    // Past what the limits allow (over 100:1), the stored shape is used from the start.
    const line = sizeForAspect(400, 1)
    expect(stored(line)).toEqual(line)
  })
})

describe('overlay timing', () => {
  it('fades in and out over output time, at its own opacity', () => {
    const o = { ...base, opacity: 0.8, fadeIn: 1, fadeOut: 0.5 }
    expect(overlayAlpha(o, 1.99, ONE)).toBe(0)
    expect(overlayAlpha(o, 2.5, ONE)).toBeCloseTo(0.4)
    expect(overlayAlpha(o, 3.5, ONE)).toBeCloseTo(0.8)
    expect(overlayAlpha(o, 4.75, ONE)).toBeCloseTo(0.4)
    expect(overlayAlpha(o, 5, ONE)).toBe(0)
  })

  it('a 2x clip does not halve the fade (output time)', () => {
    const fast: Clip[] = [{ id: 'c', start: 0, end: 10, speed: 2 }]
    const o = { ...base, fadeIn: 1 }
    // 1 s of output into a 2x clip is 2 s of source.
    expect(overlayAlpha(o, 3, fast)).toBeCloseTo(0.5)
    expect(overlayAlpha(o, 4, fast)).toBeCloseTo(1)
  })

  it('fades longer than the overlay share it', () => {
    const o = { ...base, start: 0, end: 1, fadeIn: 2, fadeOut: 2 }
    expect(overlayAlpha(o, 0.5, ONE)).toBeCloseTo(1)
    expect(overlayAlpha(o, 0.25, ONE)).toBeCloseTo(0.5)
  })

  it('runs the GIF clock on output time from its start, across a cut', () => {
    const cut: Clip[] = [
      { id: 'a', start: 0, end: 3, speed: 1 },
      { id: 'b', start: 6, end: 10, speed: 1 }
    ]
    expect(overlayClockMs({ start: 2 }, 2.5, ONE)).toBeCloseTo(500)
    // 1 s before the cut + 0.5 s after it.
    expect(overlayClockMs({ start: 2 }, 6.5, cut)).toBeCloseTo(1500)
  })
})

describe('GIF frames', () => {
  it('plays tiny or broken delays as 100 ms, as browsers do', () => {
    expect(playedDelays([0, 10, 11, 50, NaN, -5])).toEqual([100, 100, 11, 50, 100, 100])
  })

  it('finds the frame for a time and loops', () => {
    const t = gifTiming([100, 200, 100])
    expect(t).toEqual({ starts: [0, 100, 300], total: 400 })
    expect(gifFrameAt(t, 0)).toBe(0)
    expect(gifFrameAt(t, 99.9)).toBe(0)
    expect(gifFrameAt(t, 100)).toBe(1)
    expect(gifFrameAt(t, 299)).toBe(1)
    expect(gifFrameAt(t, 300)).toBe(2)
    expect(gifFrameAt(t, 400)).toBe(0)
    expect(gifFrameAt(t, 1250)).toBe(0)
    expect(gifFrameAt(t, 1350)).toBe(1)
    expect(gifFrameAt(gifTiming([80]), 5000)).toBe(0)
  })

  it('keeps decoded frames within 720 px and 200 MB', () => {
    expect(gifScale(480, 270, 10)).toBe(1)
    expect(gifScale(1440, 810, 10)).toBeCloseTo(0.5)
    const s = gifScale(720, 720, 1500)
    expect(720 * 720 * 4 * 1500 * s * s).toBeLessThanOrEqual(GIF_MAX_BYTES * 1.0001)
  })

  it('refuses images over 8192 px a side or 40 megapixels', () => {
    expect(imageSizeProblem(8192, 4000)).toBeNull()
    expect(imageSizeProblem(8193, 10)).toMatch(/too large/)
    expect(imageSizeProblem(7000, 7000)).toMatch(/40 megapixels/)
    expect(imageSizeProblem(0, 10)).toMatch(/could not be read/)
  })
})

describe('stickers', () => {
  it('are self-contained SVGs: no script, no text, no external reference', () => {
    expect(STICKERS.length).toBe(12)
    for (const s of STICKERS) {
      expect(s.svg).not.toMatch(/<script|<text|href|url\(|<image|<foreignObject/i)
      expect(stickerUrl(s)).toMatch(/^data:image\/svg\+xml/)
    }
    expect(isSticker('star')).toBe(true)
    expect(isSticker('../star')).toBe(false)
  })
})

describe('reading stored overlays, fonts and the brand', () => {
  it('keeps a good overlay and clamps its numbers', () => {
    const o = readOverlay({ ...base, w: 9, opacity: 0, rotation: 270, fadeIn: -1, name: 'a\nb' }, 4)
    expect(o).toMatchObject({ end: 4, w: 2, opacity: 0.05, rotation: -90, fadeIn: 0, name: 'a b' })
  })

  it('drops overlays that cannot be shown or name another file', () => {
    expect(readOverlay({ ...base, file: '../secret.png' })).toBeNull()
    expect(readOverlay({ ...base, file: 'overlay-1.exe' })).toBeNull()
    expect(readOverlay({ ...base, file: undefined, sticker: 'nope' })).toBeNull()
    expect(readOverlay({ ...base, start: 3, end: 3.01 })).toBeNull()
    expect(readOverlay({ ...base, start: 'x' })).toBeNull()
    expect(readOverlay(null)).toBeNull()
    const both = readOverlay({ ...base, sticker: 'star' })
    expect(both?.file).toBe('overlay-1.png')
    expect(both?.sticker).toBeUndefined()
  })

  it('keeps at most 200 overlays with unique ids', () => {
    const many = readOverlays(Array.from({ length: 250 }, () => ({ ...base })))!
    expect(many.length).toBe(MAX_OVERLAYS)
    expect(new Set(many.map((o) => o.id)).size).toBe(MAX_OVERLAYS)
    expect(readOverlays(undefined)).toBeUndefined()
    expect(readOverlays('x')).toEqual([])
  })

  it('reads fonts with safe files and ids only', () => {
    expect(
      readFonts([
        { id: 'f1', name: ' Brand ', file: 'font-1.ttf' },
        { id: 'f1', name: 'dup', file: 'font-2.ttf' },
        { id: 'f2', file: '../x.ttf' },
        { id: 'a b', file: 'font-3.otf' }
      ])
    ).toEqual([{ id: 'f1', name: 'Brand', file: 'font-1.ttf' }])
    expect(readFonts(undefined)).toBeUndefined()
  })

  it('reads the brand colours and fonts', () => {
    expect(readBrand({ colors: ['#ABCDEF', 'red', '#abcdef', '#000000'], headingFont: 'f1', bodyFont: 3 })).toEqual({ colors: ['#abcdef', '#000000'], headingFont: 'f1' })
    expect(readBrand('x')).toBeUndefined()
  })

  it('leaves a project from before overlays without any of the new fields', () => {
    const old = {
      version: 2,
      id: 'p',
      name: 'Old',
      duration: 10,
      width: 1280,
      height: 720,
      clips: [{ id: 'c', start: 0, end: 10, speed: 1 }],
      annotations: [],
      titles: [{ id: 't', start: 0, end: 2, title: 'Hi', style: 'centered', background: 'blur' }],
      captions: { show: true }
    }
    const p = migrateProject(old)
    expect('overlays' in p).toBe(false)
    expect('fonts' in p).toBe(false)
    expect('brand' in p).toBe(false)
    expect('font' in p.titles![0]).toBe(false)
    expect('font' in p.captions!).toBe(false)
  })

  it('keeps fonts named by title cards and captions, and the brand intro mark', () => {
    const p = migrateProject({
      id: 'p',
      duration: 10,
      clips: [{ id: 'c', start: 0, end: 10, speed: 1 }],
      overlays: [base],
      fonts: [{ id: 'f1', name: 'Brand', file: 'font-1.woff2' }],
      titles: [{ id: 't', start: 0, end: 2, title: 'Hi', style: 'centered', background: 'blur', font: 'f1', brand: 'intro' }],
      captions: { show: true, font: 'f1' }
    })
    expect(p.overlays).toHaveLength(1)
    expect(p.fonts).toEqual([{ id: 'f1', name: 'Brand', file: 'font-1.woff2' }])
    expect(p.titles![0]).toMatchObject({ font: 'f1', brand: 'intro' })
    expect(p.captions!.font).toBe('f1')
    const bad = migrateProject({ id: 'p', duration: 10, titles: [{ id: 't', start: 0, end: 2, title: 'Hi', font: '../x', brand: 'x' }], captions: { font: 7 } })
    expect('font' in bad.titles![0]).toBe(false)
    expect('brand' in bad.titles![0]).toBe(false)
    expect('font' in bad.captions!).toBe(false)
  })
})

describe('GIF header', () => {
  it('reads the declared screen size before decoding, so a huge canvas is refused first', async () => {
    const { gifScreenSize } = await import('../src/shared/render/imageOverlays')
    const head = Uint8Array.from([...'GIF89a'].map((c) => c.charCodeAt(0)).concat([0x40, 0x9c, 0x40, 0x9c]))
    expect(gifScreenSize(head)).toEqual({ width: 40000, height: 40000 })
    expect(imageSizeProblem(40000, 40000)).toMatch(/too large/)
    expect(gifScreenSize(Uint8Array.from([0x89, 0x50, 0x4e, 0x47, 0, 0, 0, 0, 0, 0]))).toBeNull()
    expect(gifScreenSize(Uint8Array.from([0x47, 0x49]))).toBeNull()
  })
})
