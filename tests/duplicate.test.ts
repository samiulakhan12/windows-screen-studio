import { describe, expect, it, vi } from 'vitest'
import type { Rect } from '../src/shared/engine/layout'

/*
 * Until parts P1 and P2 are merged, textArea and keepInArea (shared/render/safeZones.ts) are
 * contract stubs that throw 'not implemented'. Only then do these stand-ins answer in their place,
 * with the rules of §6.3 (a frame without a camera band) and §6.4; once the real functions are
 * in, every call goes to them.
 */
vi.mock('../src/shared/render/safeZones', async (importOriginal) => {
  const real = await importOriginal<typeof import('../src/shared/render/safeZones')>()
  const orStandIn =
    <A extends unknown[], R>(f: (...args: A) => R, standIn: (...args: A) => R) =>
    (...args: A): R => {
      try {
        return f(...args)
      } catch (err) {
        if ((err as Error).message !== 'not implemented') throw err
        return standIn(...args)
      }
    }
  const { COMMON_SAFE } = real
  return {
    ...real,
    textArea: orStandIn(real.textArea, (p, w, h) =>
      p.reframe?.appSafe && h >= 1.25 * w ? { x: COMMON_SAFE.x * w, y: COMMON_SAFE.y * h, w: COMMON_SAFE.w * w, h: COMMON_SAFE.h * h } : null
    ),
    keepInArea: orStandIn(real.keepInArea, (box: Rect, area: Rect, minScale = 0.6) => {
      const scale = Math.max(minScale, Math.min(1, area.w / box.w, area.h / box.h))
      const shift = (from: number, size: number, lo: number, room: number): number => {
        const s = size * scale
        const at = from + (size - s) / 2
        return s > room ? lo + (room - s) / 2 - at : Math.min(Math.max(at, lo), lo + room - s) - at
      }
      return { dx: shift(box.x, box.w, area.x, area.w), dy: shift(box.y, box.h, area.y, area.h), scale }
    })
  }
})

import { canCopyAs, copyName, projectCopy, refitItems, type MeasureText } from '../src/shared/editor/duplicate'
import { createProject } from '../src/shared/engine/project'
import { COMMON_SAFE, textArea } from '../src/shared/render/safeZones'
import type { Annotation, ImageOverlay, Project } from '../src/shared/types'

/*
 * Duplicate, Make a vertical version and Make a square version, the pure part
 * (docs/design/vertical-video.md §4.8, tests 58-60): the copy's name, what the copy changes and
 * what it keeps, the refit of texts and images into the text area, and when a copy can be made.
 */

function project(width = 1920, height = 1080, over: Partial<Project> = {}): Project {
  return {
    ...createProject({
      id: 'rec-20261028-101500',
      name: 'Billing demo',
      duration: 20,
      width,
      height,
      hasWebcam: false,
      hasAudio: true,
      webcamOffset: 0,
      zooms: [{ id: 'z1', start: 2, end: 5, scale: 1.8, focus: { mode: 'cursor' }, auto: true }],
      cursorValid: true,
      capture: { method: 'native', cursorInVideo: false, region: null }
    }),
    createdAt: '2026-10-01T09:00:00.000Z',
    ...over
  }
}

function deepFreeze<T>(value: T): T {
  if (value && typeof value === 'object') {
    for (const v of Object.values(value)) deepFreeze(v)
    Object.freeze(value)
  }
  return value
}

const text = (over: Partial<Annotation> = {}): Annotation => ({ id: 'a1', start: 1, end: 4, text: 'Click Save', x: 0.5, y: 0.5, size: 0.05, style: 'pill', ...over })
const image = (over: Partial<ImageOverlay> = {}): ImageOverlay => ({ id: 'o1', start: 1, end: 4, file: 'overlay-1.png', x: 0.5, y: 0.5, w: 0.2, h: 0.1, rotation: 0, opacity: 1, fadeIn: 0, fadeOut: 0, ...over })
/** Half the font size per character: widths that are easy to work out by hand. */
const measure: MeasureText = (s, px) => s.length * px * 0.5

/* A 1080 x 1920 frame and the area the apps leave free in it: 864 x 1248 px from (64.8, 211.2). */
const W = 1080
const H = 1920
const AREA: Rect = { x: COMMON_SAFE.x * W, y: COMMON_SAFE.y * H, w: COMMON_SAFE.w * W, h: COMMON_SAFE.h * H }

/** The box a pill text is drawn in (drawAnnotations) with the test's measure. */
function pillBox(a: Annotation, w = W, h = H): Rect {
  const px = a.size * Math.min(w, h)
  const lines = a.text.split('\n')
  const bw = Math.max(...lines.map((l) => measure(l, px, '', 600))) + 2 * 0.7 * px
  const bh = 1.3 * px * lines.length + 2 * 0.35 * px
  return { x: a.x * w - bw / 2, y: a.y * h - bh / 2, w: bw, h: bh }
}
const inside = (b: Rect, area: Rect): boolean => b.x >= area.x - 1e-6 && b.y >= area.y - 1e-6 && b.x + b.w <= area.x + area.w + 1e-6 && b.y + b.h <= area.y + area.h + 1e-6

describe('copyName (test 58)', () => {
  it('adds what the copy is to the name', () => {
    expect(copyName('Billing demo', 'copy')).toBe('Billing demo (copy)')
    expect(copyName('Billing demo', 'vertical')).toBe('Billing demo (vertical)')
    expect(copyName('Billing demo', 'square')).toBe('Billing demo (square)')
    expect(copyName('  Billing demo  ', 'copy')).toBe('Billing demo (copy)')
  })

  it('names a copy of a blank name "Untitled recording (…)"', () => {
    expect(copyName('', 'copy')).toBe('Untitled recording (copy)')
    expect(copyName('   ', 'vertical')).toBe('Untitled recording (vertical)')
    expect(copyName('', 'square')).toBe('Untitled recording (square)')
  })

  it('keeps at most 120 characters, cutting the name and never the suffix', () => {
    const long = 'x'.repeat(150)
    expect(copyName(long, 'copy')).toBe(`${'x'.repeat(113)} (copy)`)
    expect(copyName(long, 'vertical')).toBe(`${'x'.repeat(109)} (vertical)`)
    expect(copyName(long, 'square')).toHaveLength(120)
    // A cut that would split an emoji drops it whole; one at a space leaves no space before the suffix.
    expect(copyName(`${'x'.repeat(112)}😀tail`, 'copy')).toBe(`${'x'.repeat(112)} (copy)`)
    expect(copyName(`${'x'.repeat(112)} tail`, 'copy')).toBe(`${'x'.repeat(112)} (copy)`)
  })
})

describe('projectCopy (test 59)', () => {
  it("'vertical': a 9:16 frame that follows, the camera in a band on top, text kept clear of the apps' buttons", () => {
    const p = deepFreeze(project())
    const copy = projectCopy(p, 'vertical', measure)
    expect(copy.style.aspectRatio).toBe('9:16')
    expect(copy.reframe).toEqual({ mode: 'follow', level: 1, camera: 'top', band: 0.32, pace: 'balanced', appSafe: true })
    expect(copy.name).toBe('Billing demo (vertical)')
    expect(copy.id).toBe(p.id)
  })

  it("'vertical' keeps the settings a project already has (rest point, pace, level, band side), turning following on", () => {
    const p = deepFreeze(project(1920, 1080, { reframe: { mode: 'fit', level: 1.4, camera: 'bottom', band: 0.4, pace: 'calm', appSafe: false, rest: { x: 0.2, y: 0.3 } } }))
    expect(projectCopy(p, 'vertical', measure).reframe).toEqual({ mode: 'follow', level: 1.4, camera: 'bottom', band: 0.4, pace: 'calm', appSafe: true, rest: { x: 0.2, y: 0.3 } })
  })

  it("'square': 1:1 with the camera bubble, captions where they always were", () => {
    const p = deepFreeze(project(1920, 1080, { reframe: { mode: 'fit', level: 1, camera: 'top', band: 0.32, pace: 'lively', appSafe: true, rest: { x: 0.7, y: 0.5 } } }))
    const copy = projectCopy(p, 'square', measure)
    expect(copy.style.aspectRatio).toBe('1:1')
    expect(copy.reframe).toEqual({ mode: 'follow', level: 1, camera: 'bubble', band: 0.32, pace: 'lively', appSafe: false, rest: { x: 0.7, y: 0.5 } })
    expect(copy.name).toBe('Billing demo (square)')
    expect(projectCopy(deepFreeze(project()), 'square', measure).reframe).toEqual({ mode: 'follow', level: 1, camera: 'bubble', band: 0.32, pace: 'balanced', appSafe: false })
  })

  it("'copy': only the name changes", () => {
    const p = deepFreeze(project(1920, 1080, { style: { ...project().style, aspectRatio: '16:9' }, annotations: [text({ y: 0.97 })], overlays: [image({ x: 0.99 })] }))
    const copy = projectCopy(p, 'copy', measure)
    expect(copy).toEqual({ ...p, name: 'Billing demo (copy)' })
    expect(copy.annotations).toBe(p.annotations)
    expect(copy.overlays).toBe(p.overlays)
    expect('reframe' in copy).toBe(false)
  })

  it('never changes clips, zooms, layouts, captions, shapes, crop, freezes or any other field, and never mutates its input', () => {
    const base = project(1920, 1080, {
      crop: { x: 0.1, y: 0, w: 0.8, h: 1 },
      clips: [
        { id: 'c1', start: 0, end: 6, speed: 1 },
        { id: 'c2', start: 8, end: 20, speed: 2 }
      ],
      layouts: [{ id: 'l1', start: 3, end: 6, layout: 'camera-large', corner: 'top-left' }],
      shapes: [{ id: 's1', kind: 'arrow', start: 1, end: 3, x: 0.2, y: 0.2, w: 0.1, h: 0.1, color: '#ff3b30', stroke: 4 } as never],
      freezes: [{ id: 'f1', at: 4, length: 1, mode: 'pause' } as never],
      titles: [{ id: 't1', start: 0, end: 2, kind: 'intro', title: 'Billing', subtitle: '' } as never],
      captions: { show: true } as never,
      annotations: [text()],
      overlays: [image()],
      copyOf: { id: 'rec-older', name: 'Older' }
    })
    const p = deepFreeze(base)
    const json = JSON.stringify(p)
    for (const kind of ['vertical', 'square'] as const) {
      const copy = projectCopy(p, kind, measure)
      const { name: _n, style, reframe: _r, ...rest } = copy
      const { name: _pn, style: pStyle, ...pRest } = p
      expect(rest).toEqual(pRest)
      expect({ ...style, aspectRatio: pStyle.aspectRatio }).toEqual(pStyle)
      for (const key of ['clips', 'zooms', 'layouts', 'shapes', 'crop', 'freezes', 'titles', 'captions', 'effects', 'cursor', 'webcam', 'audio', 'copyOf'] as const) expect(copy[key]).toBe(p[key])
      // Texts and images already inside the area are the same objects in the same lists.
      expect(copy.annotations).toBe(p.annotations)
      expect(copy.overlays).toBe(p.overlays)
    }
    expect(JSON.stringify(p)).toBe(json)
  })

  it('refits a text and an image into the text area of the new frame at their start', () => {
    const p = deepFreeze(project(1920, 1080, { annotations: [text({ y: 0.9 })], overlays: [image({ x: 0.97, y: 0.05 })] }))
    const copy = projectCopy(p, 'vertical', measure)
    const area = textArea(copy, W, H, 1920, 1080, 1)!
    expect(area).not.toBeNull()
    const a = copy.annotations[0]
    expect(a).not.toBe(p.annotations[0])
    expect(inside(pillBox(a), area)).toBe(true)
    expect(a.size).toBe(0.05)
    const o = copy.overlays![0]
    expect(o.x * W + (o.w * W) / 2).toBeCloseTo(area.x + area.w, 6)
    expect(o.y * H - (o.h * W) / 2).toBeCloseTo(area.y, 6)
  })

  it('keeps texts off the camera band in effect at their start', () => {
    // With the camera shown, the vertical version puts it in a band on top (§6.3: the area starts under it).
    const p = deepFreeze(
      project(1920, 1080, {
        hasWebcam: true,
        webcam: { ...project().webcam, show: true },
        annotations: [text({ y: 0.2 }), text({ id: 'a2', start: 9, end: 12, y: 0.74 })]
      })
    )
    const copy = projectCopy(p, 'vertical', measure)
    for (const a of copy.annotations) expect(inside(pillBox(a), textArea(copy, W, H, 1920, 1080, a.start)!)).toBe(true)
  })

  it("'square' refits into the whole frame: a text near the right edge of a 16:9 frame comes back in", () => {
    // At x 0.95 of 1080 px its 345.6 px box would end at 1198.8 px.
    const p = deepFreeze(project(1920, 1080, { annotations: [text({ x: 0.95 })] }))
    const a = projectCopy(p, 'square', measure).annotations[0]
    expect(a.x * 1080 + pillBox(a, 1080, 1080).w / 2).toBeCloseTo(1080, 6)
    expect(a.y).toBe(0.5)
  })
})

describe('refitItems (test 60)', () => {
  it('moves a text at y 0.9 into the area, shifted only', () => {
    const a = text({ y: 0.9 })
    const out = refitItems({ annotations: [a] }, W, H, AREA, measure).annotations[0]
    // The box is 345.6 x 108 px: its bottom goes to the area's bottom, 1459.2 px.
    expect(out.y * H).toBeCloseTo(1459.2 - 54, 6)
    expect(out.x).toBe(0.5)
    expect(out.size).toBe(0.05)
    expect(out.text).toBe('Click Save')
    expect(inside(pillBox(out), AREA)).toBe(true)
  })

  it('shrinks a text wider than the area to fit', () => {
    // 45 characters: 1215 + 75.6 px wide, 864 px of room.
    const a = text({ text: 'Open the settings and choose a new background' })
    const out = refitItems({ annotations: [a] }, W, H, AREA, measure).annotations[0]
    expect(out.size).toBeCloseTo(0.05 * (864 / 1290.6), 9)
    expect(out.text).toBe(a.text)
    expect(inside(pillBox(out), AREA)).toBe(true)
  })

  it('shrinks no further than 60%, then breaks the text at the space nearest its middle', () => {
    // 69 characters: 1938.6 px wide, still 1163 px at 60%.
    const a = text({ text: 'Drag the slider all the way to the right to make the picture brighter' })
    const out = refitItems({ annotations: [a] }, W, H, AREA, measure).annotations[0]
    expect(out.text).toBe('Drag the slider all the way to the\nright to make the picture brighter')
    // Two lines of 34 characters: 993.6 px wide, so it shrinks less than it would have unbroken.
    expect(out.size).toBeCloseTo(0.05 * (864 / 993.6), 9)
    expect(inside(pillBox(out), AREA)).toBe(true)
  })

  it('keeps a text too wide at 60% that cannot break at 60%, centred on the area', () => {
    const a = text({ text: 'x'.repeat(70), x: 0.8 })
    const out = refitItems({ annotations: [a] }, W, H, AREA, measure).annotations[0]
    expect(out.size).toBeCloseTo(0.03, 12)
    expect(out.text).toBe(a.text)
    expect(out.x * W).toBeCloseTo(AREA.x + AREA.w / 2, 6)
  })

  it('shifts an image by its rotated bounds', () => {
    // 216 x 108 px turned a quarter: 108 px wide. Its right edge goes to the area's, 928.8 px.
    const o = image({ x: 0.9, rotation: 90 })
    const out = refitItems({ annotations: [], overlays: [o] }, W, H, AREA, measure).overlays![0]
    expect(out.x * W).toBeCloseTo(928.8 - 54, 6)
    expect(out.y).toBe(0.5)
    expect([out.w, out.h, out.rotation]).toEqual([0.2, 0.1, 90])
    // Unturned it is 216 px wide.
    const flat = refitItems({ annotations: [], overlays: [{ ...o, rotation: 0 }] }, W, H, AREA, measure).overlays![0]
    expect(flat.x * W).toBeCloseTo(928.8 - 108, 6)
  })

  it('shrinks an image larger than the area, by its rotated bounds', () => {
    // 0.9 x 0.9 of 1080 px turned 45°: bounds of 1374.6 px square, 864 px of room.
    const o = image({ w: 0.9, h: 0.9, rotation: 45 })
    const out = refitItems({ annotations: [], overlays: [o] }, W, H, AREA, measure).overlays![0]
    expect(out.w).toBeCloseTo(0.9 * (864 / (972 * Math.SQRT2)), 9)
    expect(out.h).toBeCloseTo(out.w, 12)
  })

  it('leaves items already inside as the same objects, and lists without a change as the same arrays', () => {
    const annotations = [text(), text({ id: 'a2', y: 0.3 })]
    const overlays = [image(), image({ id: 'o2', y: 0.7, rotation: 30 })]
    const out = refitItems({ annotations, overlays }, W, H, AREA, measure)
    expect(out.annotations).toBe(annotations)
    expect(out.overlays).toBe(overlays)
    const high = text({ id: 'a3', y: 0.05 })
    const moved = refitItems({ annotations: [...annotations, high] }, W, H, AREA, measure)
    expect(moved.annotations[0]).toBe(annotations[0])
    expect(moved.annotations[1]).toBe(annotations[1])
    expect(moved.annotations[2]).not.toBe(high)
    expect(moved.annotations[2].y * H - 54).toBeCloseTo(AREA.y, 6)
    expect('overlays' in moved).toBe(false)
  })

  it('leaves blank texts alone and never mutates the items', () => {
    const a = deepFreeze(text({ text: '   ', y: 0.99 }))
    const b = deepFreeze(text({ y: 0.99 }))
    const out = refitItems({ annotations: [a, b] }, W, H, AREA, measure)
    expect(out.annotations[0]).toBe(a)
    expect(b.y).toBe(0.99)
  })

  it('estimates the width of a text without a measure', () => {
    const a = text({ text: 'x'.repeat(30) })
    // 30 characters at 0.55 of 54 px, padded: 966.6 px.
    const out = refitItems({ annotations: [a] }, W, H, AREA, null).annotations[0]
    expect(out.size).toBeCloseTo(0.05 * (864 / (30 * 0.55 * 54 + 75.6)), 9)
  })
})

describe('canCopyAs (test 60)', () => {
  const follow = { mode: 'follow', level: 1, camera: 'top', band: 0.32, pace: 'balanced', appSafe: true } as const
  const withAspect = (p: Project, aspectRatio: Project['style']['aspectRatio']): Project => ({ ...p, style: { ...p.style, aspectRatio } })

  it('allows every copy of a landscape recording', () => {
    for (const kind of ['copy', 'vertical', 'square'] as const) expect(canCopyAs(project(), kind, 1920, 1080)).toEqual({ ok: true })
    // A 9:16 or 1:1 project that is only fitted can still be made into one that follows.
    expect(canCopyAs(withAspect(project(), '9:16'), 'vertical', 1920, 1080)).toEqual({ ok: true })
    expect(canCopyAs(withAspect(project(1920, 1080, { reframe: { ...follow, mode: 'fit' } }), '9:16'), 'vertical', 1920, 1080)).toEqual({ ok: true })
  })

  it('"This video already follows the action" for a 9:16 (1:1) project that follows', () => {
    const vertical = withAspect(project(1920, 1080, { reframe: follow }), '9:16')
    expect(canCopyAs(vertical, 'vertical', 1920, 1080)).toEqual({ ok: false, reason: 'This video already follows the action' })
    expect(canCopyAs(vertical, 'square', 1920, 1080)).toEqual({ ok: true })
    const square = withAspect(project(1920, 1080, { reframe: { ...follow, camera: 'bubble', appSafe: false } }), '1:1')
    expect(canCopyAs(square, 'square', 1920, 1080)).toEqual({ ok: false, reason: 'This video already follows the action' })
    expect(canCopyAs(square, 'vertical', 1920, 1080)).toEqual({ ok: true })
  })

  it('"Your recording is already tall" / "… square or tall" when that frame could not follow the recording as cropped', () => {
    const tall = project(1080, 1920)
    expect(canCopyAs(tall, 'vertical', 1080, 1920)).toEqual({ ok: false, reason: 'Your recording is already tall' })
    expect(canCopyAs(tall, 'square', 1080, 1920)).toEqual({ ok: false, reason: 'Your recording is already square or tall' })
    // A tall project set to follow: its frame cannot follow, so it is the recording's shape that says no.
    expect(canCopyAs(withAspect(project(1080, 1920, { reframe: follow }), '9:16'), 'vertical', 1080, 1920)).toEqual({ ok: false, reason: 'Your recording is already tall' })
    const square = project(1080, 1080)
    expect(canCopyAs(square, 'vertical', 1080, 1080)).toEqual({ ok: true })
    expect(canCopyAs(square, 'square', 1080, 1080)).toEqual({ ok: false, reason: 'Your recording is already square or tall' })
    // The crop decides: a 16:9 recording cropped to 1000 x 1080 is nearly square.
    expect(canCopyAs(project(), 'square', 1000, 1080)).toEqual({ ok: false, reason: 'Your recording is already square or tall' })
    expect(canCopyAs(project(), 'vertical', 1000, 1080)).toEqual({ ok: true })
  })

  it('always allows Duplicate', () => {
    expect(canCopyAs(project(1080, 1920), 'copy', 1080, 1920)).toEqual({ ok: true })
    expect(canCopyAs(withAspect(project(1920, 1080, { reframe: follow }), '9:16'), 'copy', 1920, 1080)).toEqual({ ok: true })
  })
})
