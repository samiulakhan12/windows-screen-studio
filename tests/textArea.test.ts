import { describe, expect, it, vi } from 'vitest'
import type { Rect } from '../src/shared/engine/layout'
import type { CaptionSettings, Corner, CursorTrack, Project, ReframeSettings, TitleCard, WatermarkSettings } from '../src/shared/types'

/*
 * Where captions, key presses, the logo and lower-third titles go in a vertical frame
 * (docs/design/vertical-video.md §6.3, tests 52 and 53): the text area (safeZones.ts textArea) and
 * each placement rule in it. Without an area every rule gives today's placement; the equivalence
 * guard (tests/verticalEquivalence.test.ts) pins those values bit for bit.
 */

const { DEFAULT_REFRAME } = await import('../src/shared/engine/reframeData')
const { textArea, COMMON_SAFE, TEXT_INSET } = await import('../src/shared/render/safeZones')
const { createProject } = await import('../src/shared/engine/project')
const { easeInOutCubic } = await import('../src/shared/engine/math')
const { captionLayout, captionMetrics, placeChunk } = await import('../src/shared/captions/layout')
const { DEFAULT_CAPTIONS } = await import('../src/shared/captions/settings')
const { watermarkRect } = await import('../src/shared/engine/watermark')
const { titleLayout, TITLE_SAFE } = await import('../src/shared/render/titleCards')
const { followGeometry } = await import('../src/shared/engine/layout')

/* ---------- a canvas that records its calls (for the key presses) ---------- */

interface Call {
  name: string
  args: unknown[]
  fill: unknown
  /** The canvas drawn on, for a context made with an id (a layer's own picture). */
  canvas?: number
}
const calls: Call[] = []
function recordingContext(canvas?: number): unknown {
  const state: Record<string | symbol, unknown> = {}
  return new Proxy(state, {
    get(target, prop) {
      if (prop in target) return target[prop]
      if (prop === 'measureText') return (text: string) => ({ width: String(text).length * 9, actualBoundingBoxAscent: 7, actualBoundingBoxDescent: 2 })
      return (...args: unknown[]) => void calls.push({ name: String(prop), args, fill: target.fillStyle, ...(canvas === undefined ? {} : { canvas }) })
    },
    set(target, prop, value) {
      target[prop] = value
      return true
    }
  })
}
vi.stubGlobal('Path2D', class {})

type DrawKeystrokes = (ctx: unknown, w: number, h: number, t: number, project: Project, cursor: CursorTrack, area?: Rect | null) => void
type CaptionBlockAt = (ctx: unknown, project: Project, t: number, w: number, h: number, area?: Rect | null) => { position: string; top: number; bottom: number } | null
/** A render layer, given the parts of a frame context it reads. */
type Layer = (fc: { ctx: unknown; w: number; h: number; t: number; k: number; project: Project; background: null; textArea: Rect | null }) => void
// Renderer code (DOM types): imported at run time so the Node typecheck of tests/ does not follow it.
const RENDER = '../src/renderer/src/render/'
const { drawKeystrokes } = (await import(/* @vite-ignore */ `${RENDER}textOverlays`)) as { drawKeystrokes: DrawKeystrokes }
const { captionBlockAt, drawCaptionsLayer } = (await import(/* @vite-ignore */ `${RENDER}captionsLayer`)) as { captionBlockAt: CaptionBlockAt; drawCaptionsLayer: Layer }
const { drawTitleCardsLayer } = (await import(/* @vite-ignore */ `${RENDER}titleCardLayer`)) as { drawTitleCardsLayer: Layer }
const { drawWatermarkLayer } = (await import(/* @vite-ignore */ `${RENDER}watermarkLayer`)) as { drawWatermarkLayer: Layer }

/* ---------- projects ---------- */

const W = 1080
const H = 1920
const U = Math.min(W, H)

/** A 16:9 recording in a 9:16 frame, with a camera, `reframe` and a style padding. */
function project(reframe: Partial<ReframeSettings> | null, extra: Partial<Project> = {}, padding = 0.07): Project {
  const p = createProject({
    id: 'p',
    name: 'p',
    duration: 30,
    width: 1920,
    height: 1080,
    hasWebcam: true,
    hasAudio: true,
    webcamOffset: 0,
    zooms: [],
    cursorValid: true,
    capture: { method: 'native', cursorInVideo: false, region: null, target: 'screen' }
  })
  return { ...p, style: { ...p.style, aspectRatio: '9:16', padding }, ...(reframe ? { reframe: { ...DEFAULT_REFRAME, ...reframe } } : {}), ...extra }
}

const area = (p: Project, t = 1, w = W, h = H): Rect | null => textArea(p, w, h, 1920, 1080, t)
/** The common safe area in a 1080 x 1920 frame: 864 x 1248 px from (64.8, 211.2). */
const COMMON: Rect = { x: 0.06 * W, y: 0.11 * H, w: 0.8 * W, h: 0.65 * H }
/** The slot under a top band of 0.32 at padding 0.07 (§11.1 test 4): from 674.016 to 1844.4 px. */
const SLOT_TOP = 75.6 + 0.32 * 1768.8 + 32.4

function expectRect(r: Rect | null, e: Rect): void {
  expect(r).not.toBeNull()
  for (const k of ['x', 'y', 'w', 'h'] as const) expect(r![k], k).toBeCloseTo(e[k], 6)
}

describe('textArea (test 52)', () => {
  it('is null without appSafe and without a band: placement as today', () => {
    expect(area(project(null))).toBeNull()
    expect(area(project({ mode: 'fit', appSafe: false }))).toBeNull()
    // Following with the camera in its bubble, or without a camera shown.
    expect(area(project({ appSafe: false, camera: 'bubble' }))).toBeNull()
    expect(area(project({ appSafe: false }, { hasWebcam: false }))).toBeNull()
    // appSafe only applies to tall frames; a square or 16:9 frame has no band either.
    expect(area(project({ appSafe: true }), 1, 1080, 1080)).toBeNull()
    expect(area(project({ appSafe: true }), 1, 1920, 1080)).toBeNull()
    expect(area(project({ appSafe: true }), 1, 0, 0)).toBeNull()
  })

  it('is the common safe area in a tall frame with appSafe, following or not', () => {
    expectRect(area(project({ mode: 'fit', appSafe: true })), COMMON)
    expectRect(area(project({ appSafe: true, camera: 'bubble' })), COMMON)
    expectRect(area(project({ appSafe: true }, { hasWebcam: false })), COMMON)
    expect(COMMON).toEqual({ x: COMMON_SAFE.x * W, y: COMMON_SAFE.y * H, w: COMMON_SAFE.w * W, h: COMMON_SAFE.h * H })
    // A taller phone frame (9:19.5) scales with it.
    expectRect(area(project({ mode: 'fit', appSafe: true }), 1, 1080, 2340), { x: 64.8, y: 0.11 * 2340, w: 864, h: 0.65 * 2340 })
  })

  it('is pushed below a top band to the slot (674 px at padding 0.07), and above a bottom band', () => {
    const top = area(project({ appSafe: true }))!
    expect(top.y).toBeCloseTo(674.016, 6)
    expect(Math.round(top.y)).toBe(674)
    expect(top.y + top.h).toBeCloseTo(0.76 * H, 6)
    expect(top.x).toBeCloseTo(64.8, 6)
    expect(top.w).toBeCloseTo(864, 6)
    const bottom = area(project({ appSafe: true, camera: 'bottom' }))!
    expect(bottom.y).toBeCloseTo(0.11 * H, 6)
    expect(bottom.y + bottom.h).toBeCloseTo(75.6 + 1768.8 - 0.32 * 1768.8 - 32.4, 6)
    // Without appSafe the band still keeps text off the camera: the whole frame below it.
    expectRect(area(project({ appSafe: false })), { x: 0, y: SLOT_TOP, w: W, h: H - SLOT_TOP })
    // The large camera's band is deeper.
    const large = area(project({ appSafe: true }, { layouts: [{ id: 'l', start: 0, end: 30, layout: 'camera-large' }] }))!
    expect(large.y).toBeCloseTo(75.6 + 0.512 * 1768.8 + 32.4, 6)
    // Not following, the band is not there.
    expectRect(area(project({ appSafe: true }), 1, W, H), area(project({ appSafe: true }))!)
    expectRect(textArea(project({ appSafe: true }), W, H, 1080, 1920, 1), COMMON)
  })

  it('follows the layout\'s eased progress as the band collapses (screen-only) and comes back; camera-only gives no push', () => {
    const p = project({ appSafe: true }, { layouts: [{ id: 'l1', start: 10, end: 14, layout: 'screen-only' }, { id: 'l2', start: 20, end: 24, layout: 'camera-only' }] })
    const pushed = SLOT_TOP
    const free = 0.11 * H
    expect(area(p, 9.9)!.y).toBeCloseTo(pushed, 6)
    expect(area(p, 12)!.y).toBeCloseTo(free, 6)
    expect(area(p, 22)!.y).toBeCloseTo(free, 6)
    let last = Infinity
    for (let t = 10; t <= 10.4 + 1e-9; t += 0.01) {
      const y = area(p, t)!.y
      expect(y, `t ${t}`).toBeCloseTo(pushed + (free - pushed) * easeInOutCubic(Math.min(1, (t - 10) / 0.4)), 6)
      expect(y).toBeLessThanOrEqual(last + 1e-9)
      last = y
      // The bottom never moves with a top band.
      expect(area(p, t)!.y + area(p, t)!.h).toBeCloseTo(0.76 * H, 6)
    }
    // Halfway back in, halfway pushed.
    expect(area(p, 13.8)!.y).toBeCloseTo((pushed + free) / 2, 6)
  })

  it('keeps text off the band of a bubble side by side in a tall frame, with appSafe or without', () => {
    const sideBySide = (appSafe: boolean, corner: Corner): Project =>
      project({ appSafe, camera: 'bubble' }, { layouts: [{ id: 's', start: 2, end: 8, layout: 'side-by-side', corner }] }, 0)
    // The camera's band (0.32 of the frame) at the bottom: the area ends where the slot does, 1305.6 px.
    const slotEnd = H - 0.32 * H
    expectRect(area(sideBySide(false, 'bottom-right'), 5), { x: 0, y: 0, w: W, h: slotEnd })
    expectRect(area(sideBySide(true, 'bottom-right'), 5), { x: COMMON.x, y: COMMON.y, w: COMMON.w, h: slotEnd - COMMON.y })
    // At the top: the area starts below it.
    expectRect(area(sideBySide(false, 'top-left'), 5), { x: 0, y: 0.32 * H, w: W, h: H - 0.32 * H })
    // Before the segment the bubble has no band: today's placement without appSafe.
    expect(area(sideBySide(false, 'bottom-right'), 1)).toBeNull()
    expectRect(area(sideBySide(true, 'bottom-right'), 1), COMMON)
    // The bottom caption ends above the band, not on the camera.
    const settings = caps()
    const layout = captionLayout(LONG, settings, W, H, measure, area(sideBySide(false, 'bottom-right'), 5))
    const placed = placeChunk(layout, layout.chunks[0], 'bottom', W, H, area(sideBySide(false, 'bottom-right'), 5))
    expect(placed.top + placed.height).toBeCloseTo(slotEnd - TEXT_INSET * U, 6)
  })
})

/* ---------- test 53: the rules in the area ---------- */

describe('a large camera leaves text its room (§6.3: text never covers the camera)', () => {
  // The deepest bands Camera size allows, with the large camera of an intro: a key press over a
  // two-line caption, a caption at the largest size and a two-line lower third all stay below it.
  for (const padding of [0, 0.07]) {
    for (const band of [0.32, 0.4, 0.5]) {
      it(`band ${band}, padding ${padding}`, () => {
        const p: Project = {
          ...project({ appSafe: true, band }, { layouts: [{ id: 'l', start: 0, end: 30, layout: 'camera-large' }] }, padding),
          effects: { motionBlur: 0, keystrokes: { show: true, position: 'bottom', size: 0.035 } },
          transcript: { provider: 'local', model: 'm', createdAt: '', segments: [{ ...LONG, start: 1, end: 4 }] },
          captions: caps()
        }
        const cameraEnd = (() => {
          const b = followGeometry('camera-large', p, W, H, 1920, 1080).band!
          return b.y + b.h
        })()
        const a = area(p, 2)!
        expect(a.y).toBeGreaterThanOrEqual(cameraEnd)
        const ctx = recordingContext()
        calls.length = 0
        drawKeystrokes(ctx, W, H, 2, p, { samples: [], clicks: [], keys: [{ t: 1.9, label: 'Ctrl + S' }], shapes: [], scale: 1, valid: false }, a)
        const box = calls.find((c) => c.name === 'roundRect')!.args as number[]
        const caption = captionBlockAt(ctx, p, 2, W, H, a)!
        expect(caption.top).toBeGreaterThanOrEqual(a.y)
        expect(box[1]).toBeGreaterThanOrEqual(a.y)
        const big = captionLayout(LONG, caps({ size: 0.09 }), W, H, measure, a)
        for (const chunk of big.chunks) expect(placeChunk(big, chunk, 'bottom', W, H, a).top).toBeGreaterThanOrEqual(a.y)
        const title = titleLayout({ title: 'A much longer title that has to be broken over two lines', subtitle: 'A subtitle long enough to need a second line of its own', style: 'lower-third' }, W, H, measure, a)
        expect(title.band!.y).toBeGreaterThanOrEqual(a.y)
      })
    }
  }

  /** The keystroke pill as drawn: its first rounded rectangle through the translate and scale calls before it. */
  function drawnKeys(): Rect & { moved: boolean } {
    let m = 1
    let tx = 0
    let ty = 0
    let moved = false
    for (const c of calls) {
      const [a, b] = c.args as number[]
      if (c.name === 'translate') [tx, ty, moved] = [tx + m * a, ty + m * b, true]
      if (c.name === 'scale') [m, moved] = [m * a, true]
      if (c.name === 'roundRect') {
        const [x, y, w, h] = c.args as number[]
        return { x: m * x + tx, y: m * y + ty, w: m * w, h: m * h, moved }
      }
    }
    throw new Error('no keystroke pill drawn')
  }

  it('the largest key presses beside the largest captions shrink into the room left, over neither the camera nor the caption', () => {
    const cursor: CursorTrack = { samples: [], clicks: [], keys: [{ t: 1.9, label: 'Ctrl + S' }], shapes: [], scale: 1, valid: false }
    let shrunk = 0
    for (const padding of [0, 0.07, 0.25]) {
      for (const band of [0.32, 0.5]) {
        for (const keyAt of ['bottom', 'top'] as const) {
          for (const captionAt of ['bottom', 'middle', 'top'] as const) {
            for (const [keySize, captionSize] of [[0.07, 0.09], [0.065, 0.085], [0.035, 0.045]]) {
              const p: Project = {
                ...project({ appSafe: true, band }, { layouts: [{ id: 'l', start: 0, end: 30, layout: 'camera-large' }] }, padding),
                effects: { motionBlur: 0, keystrokes: { show: true, position: keyAt, size: keySize } },
                transcript: { provider: 'local', model: 'm', createdAt: '', segments: [{ ...LONG, start: 1, end: 4 }] },
                captions: caps({ position: captionAt, size: captionSize })
              }
              const b = followGeometry('camera-large', p, W, H, 1920, 1080).band!
              const a = area(p, 2)!
              const ctx = recordingContext()
              calls.length = 0
              drawKeystrokes(ctx, W, H, 2, p, cursor, a)
              const box = drawnKeys()
              const caption = captionBlockAt(ctx, p, 2, W, H, a)!
              const what = `padding ${padding}, band ${band}, keys ${keyAt} ${keySize}, caption ${captionAt} ${captionSize}`
              expect(box.y, what).toBeGreaterThanOrEqual(Math.max(a.y, b.y + b.h) - 1e-6)
              expect(box.y + box.h, what).toBeLessThanOrEqual(a.y + a.h + 1e-6)
              expect(box.y + box.h <= caption.top + 1e-6 || box.y >= caption.bottom - 1e-6, what).toBe(true)
              // Shrunk about its own centre across: still centred on the frame.
              expect(box.x + box.w / 2, what).toBeCloseTo(W / 2, 6)
              if (box.moved) shrunk++
              // The default sizes fit as they are: drawn exactly as before.
              if (keySize === 0.035) expect(box.moved, what).toBe(false)
            }
          }
        }
      }
    }
    expect(shrunk).toBeGreaterThan(0)
  })
})

const measure = (text: string, px: number, weight: number): number => text.length * px * (weight >= 700 ? 0.56 : 0.5)
const LONG = {
  id: 'k2',
  start: 4,
  end: 12,
  text: 'Invoices are listed by month, and each one opens the customer it was sent to with every payment made since.'
}
const caps = (over: Partial<CaptionSettings> = {}): CaptionSettings => ({ ...DEFAULT_CAPTIONS, ...over })

describe('placement in the text area (test 53)', () => {
  const safeArea = area(project({ mode: 'fit', appSafe: true }))!

  it('captions: lines centred on the frame no wider than 0.72 W; bottom ending at 0.76 H - 0.02 u, top and middle in the area', () => {
    for (const preset of ['clean', 'bold', 'boxed', 'karaoke', 'minimal'] as const) {
      for (const background of ['none', 'box', 'shadow'] as const) {
        const settings = caps({ preset, background, size: 0.06, maxLines: 2 })
        const m = captionMetrics(settings, W, H, safeArea)
        expect(m.maxWidth + m.padX * 2).toBeLessThanOrEqual(0.72 * W + 1e-9)
        expect(m.px).toBe(captionMetrics(settings, W, H).px)
        const layout = captionLayout(LONG, settings, W, H, measure, safeArea)
        expect(layout.chunks.length).toBeGreaterThan(1)
        for (const chunk of layout.chunks) {
          const bottom = placeChunk(layout, chunk, 'bottom', W, H, safeArea)
          expect(bottom.top + bottom.height).toBeCloseTo(0.76 * H - 0.02 * U, 6)
          for (const l of bottom.lines) {
            expect(l.width).toBeLessThanOrEqual(0.72 * W)
            expect(l.x + l.width / 2).toBeCloseTo(W / 2, 9)
            expect(l.x - layout.padX).toBeGreaterThanOrEqual(safeArea.x - 1e-9)
            expect(l.x + l.width + layout.padX).toBeLessThanOrEqual(safeArea.x + safeArea.w + 1e-9)
          }
          const top = placeChunk(layout, chunk, 'top', W, H, safeArea)
          expect(top.top).toBeCloseTo(safeArea.y + TEXT_INSET * U, 9)
          const middle = placeChunk(layout, chunk, 'middle', W, H, safeArea)
          expect(middle.top + middle.height / 2).toBeCloseTo(safeArea.y + safeArea.h / 2, 9)
        }
      }
    }
    // Under a top band, a caption at the top starts below it.
    const banded = area(project({ appSafe: true }))!
    const layout = captionLayout(LONG, caps(), W, H, measure, banded)
    expect(placeChunk(layout, layout.chunks[0], 'top', W, H, banded).top).toBeCloseTo(SLOT_TOP + 0.02 * U, 6)
  })

  it('captions: a null area is the whole frame, exactly as without one', () => {
    const settings = caps({ preset: 'boxed', background: 'box' })
    expect(captionMetrics(settings, W, H, null)).toEqual(captionMetrics(settings, W, H))
    const a = captionLayout(LONG, settings, W, H, measure, null)
    expect(a).toEqual(captionLayout(LONG, settings, W, H, measure))
    for (const position of ['bottom', 'middle', 'top'] as const) expect(placeChunk(a, a.chunks[0], position, W, H, null)).toEqual(placeChunk(a, a.chunks[0], position, W, H))
    // The 16:9 margins are not added inside the area: its bottom is higher than today's in 9:16.
    expect(placeChunk(a, a.chunks[0], 'bottom', W, H).top).toBeGreaterThan(placeChunk(a, a.chunks[0], 'bottom', W, H, safeArea).top)
  })

  /** The keystroke pill (its first rounded rectangle) drawn at t, and the caption block it keeps clear of. */
  function keys(position: 'top' | 'bottom', captions: 'top' | 'bottom' | 'none', where: Rect | null) {
    const p: Project = {
      ...project({ mode: 'fit', appSafe: true }),
      effects: { motionBlur: 0, keystrokes: { show: true, position, size: 0.035 } },
      transcript: { provider: 'local', model: 'm', createdAt: '', segments: [{ id: 'a', start: 1, end: 4, text: 'Press control and S to save the project now' }] },
      captions: caps({ position: captions === 'none' ? 'bottom' : captions, show: captions !== 'none' })
    }
    const cursor: CursorTrack = { samples: [], clicks: [], keys: [{ t: 1.9, label: 'Ctrl + S' }], shapes: [], scale: 1, valid: false }
    const ctx = recordingContext()
    calls.length = 0
    drawKeystrokes(ctx, W, H, 2, p, cursor, where)
    const box = calls.find((c) => c.name === 'roundRect')!.args as number[]
    return { box: { x: box[0], y: box[1], w: box[2], h: box[3] }, caption: captionBlockAt(ctx, p, 2, W, H, where) }
  }

  it('key presses: at the area\'s bottom or top, inside it across, still above (or below) a caption at the same edge', () => {
    const inside = (b: Rect): void => {
      expect(b.x).toBeGreaterThanOrEqual(safeArea.x - 1e-9)
      expect(b.x + b.w).toBeLessThanOrEqual(safeArea.x + safeArea.w + 1e-9)
      expect(b.y).toBeGreaterThanOrEqual(safeArea.y - 1e-9)
      expect(b.y + b.h).toBeLessThanOrEqual(safeArea.y + safeArea.h + 1e-9)
    }
    const alone = keys('bottom', 'none', safeArea)
    expect(alone.caption).toBeNull()
    expect(alone.box.y + alone.box.h).toBeCloseTo(safeArea.y + safeArea.h - TEXT_INSET * U, 9)
    inside(alone.box)
    const under = keys('bottom', 'bottom', safeArea)
    expect(under.caption?.position).toBe('bottom')
    // The caption is placed in the same area.
    expect(under.caption!.bottom).toBeLessThanOrEqual(0.76 * H - 0.02 * U + 1e-6)
    expect(under.box.y + under.box.h).toBeLessThanOrEqual(under.caption!.top - 0.015 * U + 1e-9)
    inside(under.box)
    const top = keys('top', 'none', safeArea)
    expect(top.box.y).toBeCloseTo(safeArea.y + TEXT_INSET * U, 9)
    const over = keys('top', 'top', safeArea)
    expect(over.box.y).toBeGreaterThanOrEqual(over.caption!.bottom + 0.015 * U - 1e-9)
    inside(over.box)
    // Kept inside an area that leaves the frame's centre (centred on it when wider).
    const side = { x: 640, y: 300, w: 400, h: 800 }
    const right = keys('bottom', 'none', side).box
    expect(right.x).toBeCloseTo(640, 9)
    expect(right.x + right.w).toBeLessThanOrEqual(1040)
    const tight = { x: 700, y: 300, w: 40, h: 800 }
    const wide = keys('bottom', 'none', tight).box
    expect(wide.x + wide.w / 2).toBeCloseTo(720, 9)
    // Today's placement without an area (5% of the shorter side from the frame's edge), and a null area is the same.
    const today = keys('bottom', 'none', null)
    expect(today.box.y + today.box.h).toBeCloseTo(H - 0.05 * U, 9)
    expect(keys('bottom', 'bottom', null)).toEqual(keys('bottom', 'bottom', undefined as unknown as null))
  })

  it('logo: corners inside the area with the margin applied within it; the centre unchanged', () => {
    for (const kind of ['image', 'text'] as const) {
      for (const margin of [0, 0.03]) {
        const wm: Pick<WatermarkSettings, 'kind' | 'size' | 'position' | 'margin'> = { kind, size: 0.12, position: 'bottom-right', margin }
        const gap = margin * U
        const br = watermarkRect(W, H, wm, 2, safeArea)
        expect(br.x + br.w).toBeCloseTo(safeArea.x + safeArea.w - gap, 9)
        expect(br.y + br.h).toBeCloseTo(safeArea.y + safeArea.h - gap, 9)
        const tl = watermarkRect(W, H, { ...wm, position: 'top-left' }, 2, safeArea)
        expect(tl.x).toBeCloseTo(safeArea.x + gap, 9)
        expect(tl.y).toBeCloseTo(safeArea.y + gap, 9)
        const tr = watermarkRect(W, H, { ...wm, position: 'top-right' }, 2, safeArea)
        expect(tr.x + tr.w).toBeCloseTo(safeArea.x + safeArea.w - gap, 9)
        const bl = watermarkRect(W, H, { ...wm, position: 'bottom-left' }, 2, safeArea)
        expect(bl.y + bl.h).toBeCloseTo(safeArea.y + safeArea.h - gap, 9)
        // The same size as in the frame when it fits.
        expect(br.w).toBeCloseTo(watermarkRect(W, H, wm, 2).w, 9)
        expect(watermarkRect(W, H, { ...wm, position: 'center' }, 2, safeArea)).toEqual(watermarkRect(W, H, { ...wm, position: 'center' }, 2))
        expect(watermarkRect(W, H, wm, 2, null)).toEqual(watermarkRect(W, H, wm, 2))
      }
    }
    // A logo wider than the area is shrunk to fit it.
    const huge = watermarkRect(W, H, { kind: 'image', size: 0.9, position: 'top-left', margin: 0.03 }, 1, safeArea)
    expect(huge.w).toBeCloseTo(safeArea.w - 2 * 0.03 * U, 9)
    expect(huge.x + huge.w).toBeLessThanOrEqual(safeArea.x + safeArea.w + 1e-9)
  })

  it('lower thirds: the band\'s bottom at the area\'s, its left at max(TITLE_SAFE u, area.x), no wider than the area; other cards unchanged', () => {
    const titles = ['Billing demo', 'A much longer title that has to be broken over more than one line to fit']
    for (const title of titles) {
      for (const subtitle of [undefined, 'Qbexel', 'A subtitle long enough to need a second line of its own as well']) {
        const card: Pick<TitleCard, 'title' | 'subtitle' | 'style'> = { title, style: 'lower-third', ...(subtitle ? { subtitle } : {}) }
        const l = titleLayout(card, W, H, measure, safeArea)
        const b = l.band!
        expect(b.y + b.h).toBeCloseTo(safeArea.y + safeArea.h, 9)
        expect(b.x).toBeCloseTo(Math.max(TITLE_SAFE * U, safeArea.x), 9)
        expect(b.x + b.w).toBeLessThanOrEqual(safeArea.x + safeArea.w + 1e-9)
        expect(b.y).toBeGreaterThanOrEqual(safeArea.y)
        expect(titleLayout(card, W, H, measure, null)).toEqual(titleLayout(card, W, H, measure))
        for (const style of ['centered', 'big'] as const) expect(titleLayout({ ...card, style }, W, H, measure, safeArea)).toEqual(titleLayout({ ...card, style }, W, H, measure))
      }
    }
    // An area further in than the title-safe margin moves the band's left edge with it.
    const narrow = { x: 200, y: 300, w: 600, h: 900 }
    const l = titleLayout({ title: titles[1], style: 'lower-third' }, W, H, measure, narrow)
    expect(l.band!.x).toBe(200)
    expect(l.band!.x + l.band!.w).toBeLessThanOrEqual(800 + 1e-9)
    expect(l.band!.y + l.band!.h).toBeCloseTo(1200, 9)
  })

  it('without appSafe only the band\'s edge moves: at the frame\'s own edges text keeps today\'s margins', () => {
    const card: Pick<TitleCard, 'title' | 'subtitle' | 'style'> = { title: 'Billing demo', subtitle: 'Qbexel', style: 'lower-third' }
    const wm: Pick<WatermarkSettings, 'kind' | 'size' | 'position' | 'margin'> = { kind: 'image', size: 0.12, position: 'bottom-right', margin: 0.03 }
    const caption = (position: CaptionSettings['position'], where: Rect | null): ReturnType<typeof placeChunk> => {
      const layout = captionLayout(LONG, caps(), W, H, measure, where)
      return placeChunk(layout, layout.chunks[0], position, W, H, where)
    }
    // A top band at padding 0: the area is the frame below it (614.4 px down).
    const below = area(project({ appSafe: false }, {}, 0))!
    expectRect(below, { x: 0, y: 0.32 * H, w: W, h: H - 0.32 * H })
    expect(caption('top', below).top).toBeCloseTo(below.y + TEXT_INSET * U, 9)
    expect(keys('top', 'none', below).box.y).toBeCloseTo(below.y + TEXT_INSET * U, 9)
    // Its bottom is the frame's: captions, key presses and lower thirds as today, not at the edge.
    expect(caption('bottom', below)).toEqual(caption('bottom', null))
    expect(keys('bottom', 'none', below).box).toEqual(keys('bottom', 'none', null).box)
    expect(titleLayout(card, W, H, measure, below)).toEqual(titleLayout(card, W, H, measure))
    expect(titleLayout(card, W, H, measure, below).band!.y + titleLayout(card, W, H, measure, below).band!.h).toBeCloseTo(H - TITLE_SAFE * U, 9)
    expect(watermarkRect(W, H, wm, 2, below)).toEqual(watermarkRect(W, H, wm, 2))
    // A bottom band: the top is the frame's.
    const above = area(project({ appSafe: false, camera: 'bottom' }, {}, 0))!
    expectRect(above, { x: 0, y: 0, w: W, h: H - 0.32 * H })
    expect(caption('top', above)).toEqual(caption('top', null))
    expect(keys('top', 'none', above).box).toEqual(keys('top', 'none', null).box)
    expect(watermarkRect(W, H, { ...wm, position: 'top-left' }, 2, above)).toEqual(watermarkRect(W, H, { ...wm, position: 'top-left' }, 2))
    const bottom = caption('bottom', above)
    expect(bottom.top + bottom.height).toBeCloseTo(above.h - TEXT_INSET * U, 9)
    expect(keys('bottom', 'none', above).box.y + keys('bottom', 'none', above).box.h).toBeCloseTo(above.h - TEXT_INSET * U, 9)
    const lower = titleLayout(card, W, H, measure, above).band!
    expect(lower.y + lower.h).toBeCloseTo(above.h, 9)
    // The whole frame as an area is today's placement exactly.
    const whole: Rect = { x: 0, y: 0, w: W, h: H }
    for (const position of ['top', 'middle', 'bottom'] as const) expect(caption(position, whole)).toEqual(caption(position, null))
    for (const position of ['top', 'bottom'] as const) expect(keys(position, 'none', whole).box).toEqual(keys(position, 'none', null).box)
    expect(titleLayout(card, W, H, measure, whole)).toEqual(titleLayout(card, W, H, measure))
    // With appSafe the common safe area is further in than today's margins everywhere: its rules as before.
    expect(caption('bottom', safeArea).top + caption('bottom', safeArea).height).toBeCloseTo(0.76 * H - TEXT_INSET * U, 9)
    expect(titleLayout(card, W, H, measure, safeArea).band!.y + titleLayout(card, W, H, measure, safeArea).band!.h).toBeCloseTo(0.76 * H, 9)
  })
})

describe('the layers lay out again when the text area changes (their caches key on it)', () => {
  const p: Project = {
    ...project({ mode: 'fit', appSafe: true }),
    transcript: { provider: 'local', model: 'm', createdAt: '', segments: [{ id: 'a', start: 1, end: 4, text: 'Hello vertical world' }] },
    captions: caps({ position: 'top', background: 'none' }),
    titles: [{ id: 't', start: 0, end: 6, title: 'Billing demo', style: 'lower-third', background: 'solid' }],
    watermark: { show: true, kind: 'text', text: 'qbexel.com', position: 'bottom-left', size: 0.03, opacity: 0.8, margin: 0.03 }
  }
  const a: Rect = { x: 64.8, y: 211.2, w: 864, h: 1248 }
  const b: Rect = { x: 64.8, y: 674, w: 864, h: 785.2 }
  const c: Rect = { x: 64.8, y: 211.2, w: 864, h: 1034.8 }
  /** Draws `layer` on one context with each area in turn: the calls of each. */
  const drawn = (layer: Layer, areas: (Rect | null)[]): Call[][] => {
    const ctx = recordingContext()
    return areas.map((textArea) => {
      calls.length = 0
      layer({ ctx, w: W, h: H, t: 2, k: 1, project: p, background: null, textArea })
      return calls.slice()
    })
  }

  it('captions', () => {
    const tops = drawn(drawCaptionsLayer, [a, b, a, null]).map((log) => Math.min(...log.filter((x) => x.name === 'fillText').map((x) => x.args[2] as number)))
    expect(tops[1] - tops[0]).toBeCloseTo(b.y - a.y, 6)
    expect(tops[2]).toBe(tops[0])
    // Without an area: the top margin of today.
    expect(tops[3]).toBeLessThan(tops[0])
    // A narrower area breaks the same caption into more lines (its layout is not reused).
    const long: Project = { ...p, transcript: { ...p.transcript!, segments: [{ id: 'l', start: 1, end: 4, text: LONG.text }] } }
    const narrow: Rect = { x: 340, y: 211.2, w: 400, h: 1248 }
    const ctx = recordingContext()
    const lines = [a, narrow, a].map((textArea) => {
      calls.length = 0
      drawCaptionsLayer({ ctx, w: W, h: H, t: 2, k: 1, project: long, background: null, textArea })
      return new Set(calls.filter((x) => x.name === 'fillText').map((x) => x.args[2] as number)).size
    })
    expect(lines[1]).toBeGreaterThan(lines[0])
    expect(lines[2]).toBe(lines[0])
  })

  it('lower thirds', () => {
    const bottoms = drawn(drawTitleCardsLayer, [a, c, a]).map((log) => {
      const r = log.find((x) => x.name === 'roundRect')!.args as number[]
      return r[1] + r[3]
    })
    expect(bottoms[0]).toBeCloseTo(a.y + a.h, 6)
    expect(bottoms[1]).toBeCloseTo(c.y + c.h, 6)
    expect(bottoms[2]).toBe(bottoms[0])
  })

  it('lower thirds: a solid band is pictured again for an area of another width, even at the same left and bottom, and only when it changes', () => {
    // A title of two lines in both areas, broken differently: the band starts at the same point but is narrower.
    const title = Array.from({ length: 28 }, () => 'alpha').join(' ')
    const q: Project = { ...p, titles: [{ id: 'w', start: 0, end: 6, title, style: 'lower-third', background: 'solid' }] }
    const wide: Rect = { x: 64.8, y: 211.2, w: 864, h: 1248 }
    const narrow: Rect = { ...wide, w: 500 }
    // Measured as the layer measures on the recording context: 9 px a letter at 100 px.
    const layerMeasure = (text: string, px: number): number => (text.length * 9 * px) / 100
    const bands = [wide, narrow].map((where) => titleLayout({ title, style: 'lower-third' }, W, H, layerMeasure, where).band!)
    expect(bands[1].x).toBe(bands[0].x)
    expect(bands[1].y).toBe(bands[0].y)
    expect(bands[1].w).toBeLessThan(bands[0].w - 100)
    // The band, its shadow, the accent bar and the text are drawn once on a canvas of their own, then copied.
    const g = globalThis as { document?: unknown }
    let made = 0
    g.document = {
      createElement: () => {
        const id = ++made
        return { id, width: 0, height: 0, getContext: () => recordingContext(id) }
      }
    }
    try {
      const ctx = recordingContext()
      const painted = new Map<number, number>()
      const widths = [wide, narrow, wide].map((textArea) => {
        calls.length = 0
        drawTitleCardsLayer({ ctx, w: W, h: H, t: 2, k: 1, project: q, background: null, textArea })
        for (const x of calls) if (x.canvas !== undefined && x.name === 'roundRect' && !painted.has(x.canvas)) painted.set(x.canvas, (x.args as number[])[2])
        const copy = calls.find((x) => x.canvas === undefined && x.name === 'drawImage')!
        return painted.get((copy.args[0] as { id: number }).id)
      })
      expect(widths[0]).toBeCloseTo(bands[0].w, 6)
      expect(widths[1]).toBeCloseTo(bands[1].w, 6)
      expect(widths[2]).toBe(widths[0])
      // The first picture is used again for the first area.
      expect(made).toBe(2)
      // An area whose top moves (a band above gliding) leaves the band as it is: no new picture.
      const pushed: Rect = { ...wide, y: 674, h: wide.y + wide.h - 674 }
      expect(titleLayout({ title, style: 'lower-third' }, W, H, layerMeasure, pushed).band).toEqual(bands[0])
      calls.length = 0
      drawTitleCardsLayer({ ctx, w: W, h: H, t: 2, k: 1, project: q, background: null, textArea: pushed })
      expect(made).toBe(2)
      expect(calls.filter((x) => x.canvas === undefined && x.name === 'drawImage')).toHaveLength(1)
    } finally {
      delete g.document
    }
  })

  it('the logo', () => {
    const ys = drawn(drawWatermarkLayer, [a, c, a, null]).map((log) => log.find((x) => x.name === 'fillText' && x.args[0] === 'qbexel.com')!.args[2] as number)
    expect(ys[0] - ys[1]).toBeCloseTo(a.h - c.h, 6)
    expect(ys[2]).toBe(ys[0])
    expect(ys[3]).toBeGreaterThan(ys[0])
  })
})
