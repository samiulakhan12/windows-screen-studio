import { describe, expect, it, vi } from 'vitest'
import type { CameraBox, Rect, SceneProject } from '../src/shared/engine/layout'
import type { CameraLayout, CaptionSettings, CursorTrack, Project, ReframeSettings, TitleCard, WatermarkSettings } from '../src/shared/types'

/*
 * Where captions, key presses, the logo and lower-third titles go in a vertical frame
 * (docs/design/vertical-video.md §6.3, tests 52 and 53): the text area (safeZones.ts textArea) and
 * each placement rule in it. Without an area every rule gives today's placement; the equivalence
 * guard (tests/verticalEquivalence.test.ts) pins those values bit for bit.
 *
 * Until part P1's follow geometry lands, layout.ts's followGeometry and bandSide are stood in for
 * by the formulas of §5.3 (a band of the frame inside the padding, the slot below or above it
 * less the gap), so the numbers here are the spec's.
 */

const { DEFAULT_REFRAME, followApplies, isTall } = await import('../src/shared/engine/reframeData')

type Geometry = { slot: Rect; camera: CameraBox; band: Rect | null }

/** The band layouts of §5.3, for the camera at the top or bottom of a tall frame (f: the band's share of the padded height). */
function band(project: SceneProject, outW: number, outH: number, f: number, side: 'top' | 'bottom'): Geometry {
  const m = Math.min(outW, outH)
  const pad = m * project.style.padding
  const area = { x: pad, y: pad, w: Math.max(1, outW - pad * 2), h: Math.max(1, outH - pad * 2) }
  const gap = project.style.padding > 0 ? 0.03 * m : 0
  const bh = f * area.h
  const camera = { x: area.x, y: side === 'top' ? area.y : area.y + area.h - bh, w: area.w, h: bh }
  const slot = { x: area.x, y: side === 'top' ? area.y + bh + gap : area.y, w: area.w, h: area.h - bh - gap }
  return { slot, camera: { rect: camera, radius: (project.style.cornerRadius * m) / 1080, opacity: 1 }, band: camera }
}

vi.mock('../src/shared/engine/layout', async (importOriginal) => {
  const real = await importOriginal<typeof import('../src/shared/engine/layout')>()
  const placeOf = (p: SceneProject, w: number, h: number): 'top' | 'bottom' | 'bubble' =>
    isTall(w, h) && real.layoutsApply(p) && p.reframe?.camera !== 'bubble' ? (p.reframe?.camera ?? 'top') : 'bubble'
  const followGeometry = (layout: CameraLayout, p: SceneProject, w: number, h: number, vw: number, vh: number): Geometry => {
    const place = placeOf(p, w, h)
    const f = p.reframe?.band ?? 0.32
    const whole = band(p, w, h, 0, 'top')
    if (place === 'bubble' || layout === 'screen-only') {
      const slot = { ...whole.slot }
      const r = real.webcamRect(w, h, p.webcam)
      return { slot, camera: { rect: layout === 'screen-only' ? { ...r, h: 0 } : r, radius: 0, opacity: layout === 'screen-only' ? 0 : 1 }, band: null }
    }
    if (layout === 'camera-only') {
      // The camera fills the frame inside the padding (given as its band here: text must still not be pushed).
      const s = band(p, w, h, f, place).slot
      return { slot: { x: s.x + s.w / 4, y: s.y + s.h / 4, w: s.w / 2, h: s.h / 2 }, camera: { rect: whole.slot, radius: 0, opacity: 1 }, band: whole.slot }
    }
    void vw
    void vh
    return band(p, w, h, layout === 'camera-large' ? Math.min(0.65, 1.6 * f) : f, place)
  }
  const bandSide = (p: SceneProject, w: number, h: number, vw: number, vh: number): 'top' | 'bottom' | null => {
    const place = placeOf(p, w, h)
    return followApplies(p, w, h, vw, vh) && place !== 'bubble' ? place : null
  }
  return { ...real, followGeometry, bandSide }
})

const { textArea, COMMON_SAFE, TEXT_INSET } = await import('../src/shared/render/safeZones')
const { createProject } = await import('../src/shared/engine/project')
const { easeInOutCubic } = await import('../src/shared/engine/math')
const { captionLayout, captionMetrics, placeChunk } = await import('../src/shared/captions/layout')
const { DEFAULT_CAPTIONS } = await import('../src/shared/captions/settings')
const { watermarkRect } = await import('../src/shared/engine/watermark')
const { titleLayout, TITLE_SAFE } = await import('../src/shared/render/titleCards')

/* ---------- a canvas that records its calls (for the key presses) ---------- */

interface Call {
  name: string
  args: unknown[]
  fill: unknown
}
const calls: Call[] = []
function recordingContext(): unknown {
  const state: Record<string | symbol, unknown> = {}
  return new Proxy(state, {
    get(target, prop) {
      if (prop in target) return target[prop]
      if (prop === 'measureText') return (text: string) => ({ width: String(text).length * 9, actualBoundingBoxAscent: 7, actualBoundingBoxDescent: 2 })
      return (...args: unknown[]) => void calls.push({ name: String(prop), args, fill: target.fillStyle })
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
})

/* ---------- test 53: the rules in the area ---------- */

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

  it('the logo', () => {
    const ys = drawn(drawWatermarkLayer, [a, c, a, null]).map((log) => log.find((x) => x.name === 'fillText' && x.args[0] === 'qbexel.com')!.args[2] as number)
    expect(ys[0] - ys[1]).toBeCloseTo(a.h - c.h, 6)
    expect(ys[2]).toBe(ys[0])
    expect(ys[3]).toBeGreaterThan(ys[0])
  })
})
