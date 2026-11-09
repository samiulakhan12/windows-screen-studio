/**
 * The guide's screenshots (docs/design/smart-tools.md §5.5): tests 14–17 of §22.1. Test 14 draws a
 * shot's frame with the export's own drawFrame on a canvas that records its calls.
 */
import { describe, expect, it, vi } from 'vitest'
import { SmoothedTrack } from '../src/shared/engine/cursor'
import { createProject } from '../src/shared/engine/project'
import { focusPathFor } from '../src/shared/engine/zoom'
import { arrowOf, blurBoxes, guideProject, ringColour, ringOf, shotRect, shotTime, SHOT } from '../src/shared/guide/shots'
import type { GuideStep } from '../src/shared/guide/steps'
import type { Clip, CursorTrack, Project, Shape } from '../src/shared/types'

interface Call {
  canvas: number
  name: string
  args: unknown[]
}
const calls: Call[] = []
let canvases = 0
function canvas(): Record<string, unknown> {
  const id = canvases++
  const c: Record<string, unknown> = { width: 300, height: 150, id }
  const state: Record<string | symbol, unknown> = { globalAlpha: 1 }
  const ctx = new Proxy(state, {
    get(target, prop) {
      if (prop === 'canvas') return c
      if (prop in target) return target[prop]
      if (prop === 'createLinearGradient' || prop === 'createRadialGradient' || prop === 'createPattern') return () => ({ addColorStop() {} })
      if (prop === 'measureText') return (text: string) => ({ width: String(text).length * 9, actualBoundingBoxAscent: 7, actualBoundingBoxDescent: 2 })
      if (prop === 'getTransform') return () => ({ a: 1, b: 0, c: 0, d: 1, e: 0, f: 0 })
      return (...args: unknown[]) => void calls.push({ canvas: id, name: String(prop), args })
    },
    set(target, prop, value) {
      target[prop] = value
      return true
    }
  })
  c.getContext = (type: string) => (type === '2d' ? ctx : null)
  return c
}
vi.stubGlobal('document', { createElement: () => canvas() })
vi.stubGlobal('Path2D', class {})

const COMPOSITOR = '../src/renderer/src/render/compositor'
const { drawFrame } = (await import(/* @vite-ignore */ COMPOSITOR)) as {
  drawFrame: (ctx: unknown, w: number, h: number, t: number, scene: unknown, src: unknown, options?: unknown, soundTime?: number) => void
}

const W = 1920
const H = 1080

function project(patch: Partial<Project> = {}): Project {
  const p = createProject({
    id: 'p',
    name: 'Secret',
    duration: 40,
    width: W,
    height: H,
    hasWebcam: true,
    hasAudio: true,
    webcamOffset: 0,
    zooms: [{ id: 'z', start: 1, end: 6, scale: 2, focus: { mode: 'cursor' }, auto: true }],
    cursorValid: true,
    capture: { method: 'native', cursorInVideo: false, region: null, target: 'screen', fps: 60 }
  })
  return { ...p, ...patch }
}

const click = (t: number, x = 0.5, y = 0.5, extra: Partial<GuideStep> = {}): GuideStep => ({ key: `c${Math.round(t * 1000)}`, t, kind: 'click', x, y, ...extra })

const BLUR: Shape = { id: 'b1', kind: 'blur', start: 0, end: 12, x: 0.45, y: 0.45, w: 0.1, h: 0.1, color: '#000000', strokeWidth: 6, fill: false, opacity: 1, strength: 0.5 }
const PIXELATE: Shape = { ...BLUR, id: 'p1', kind: 'pixelate', start: 20, end: 30 }
const ARROW: Shape = { ...BLUR, id: 'a1', kind: 'arrow' }

describe('test 14: privacy in shots (guideProject)', () => {
  const full = project({
    crop: { x: 0, y: 0, w: 1, h: 1 },
    grade: { screen: { temperature: 0.3 } },
    shapes: [BLUR, PIXELATE, ARROW],
    spotlights: [{ id: 's', mode: 'region', start: 0, end: 5, x: 0.1, y: 0.1, w: 0.2, h: 0.2, shape: 'rect', dim: 0.5, feather: 0 }],
    annotations: [{ id: 'n', start: 0, end: 5, text: 'Hi', x: 0.5, y: 0.5, size: 0.05, style: 'pill' }],
    titles: [{ id: 't', start: 0, end: 3, text: 'Title', style: 'lower-third' } as never],
    graphics: [{ id: 'g' } as never],
    overlays: [{ id: 'o' } as never],
    layouts: [{ id: 'l', start: 0, end: 5, layout: 'camera' } as never],
    watermark: { show: true, kind: 'text', text: 'W', position: 'top-left', size: 0.05, opacity: 1, margin: 0.02 },
    tilt: { enabled: true, rotateX: 10, rotateY: 5, perspective: 0.5, animate: 'none' },
    reframe: { mode: 'follow' } as never,
    joins: { style: 'slide' } as never,
    chapterBar: { show: true, place: 'auto', style: 'float', labels: 'all' },
    captions: { show: true } as never,
    inputEdits: { ignoredClicks: [{ ms: 1000 }] }
  })
  const g = guideProject(full)

  it('keeps the clips, the crop, the cursor without its click effect, input edits, every blur and pixelate shape and the grade', () => {
    expect(g.clips).toBe(full.clips)
    expect(g.crop).toEqual(full.crop)
    expect(g.inputEdits).toEqual(full.inputEdits)
    expect(g.shapes).toEqual([BLUR, PIXELATE])
    expect(g.grade).toEqual(full.grade)
    expect(g.cursor.show).toBe(full.cursor.show)
    expect(g.cursor.clickEffect).toBe(false)
  })

  it('drops zooms, camera, captions, titles, graphics, texts, other shapes, spotlights, images, watermark, tilt, layouts, reframe, joins and the progress bar', () => {
    expect(g.zooms).toEqual([])
    expect(g.autoZoom).toBe(false)
    expect(g.webcam.show).toBe(false)
    expect(g.captions!.show).toBe(false)
    expect(g.titles).toEqual([])
    expect(g.graphics).toEqual([])
    expect(g.annotations).toEqual([])
    expect(g.spotlights).toEqual([])
    expect(g.overlays).toEqual([])
    expect(g.layouts).toEqual([])
    expect(g.effects.keystrokes.show).toBe(false)
    for (const k of ['watermark', 'tilt', 'reframe', 'joins', 'chapterBar', 'director'] as const) expect(k in g, k).toBe(false)
    expect(g.style).toMatchObject({ padding: 0, cornerRadius: 0, shadow: 0, aspectRatio: 'auto' })
    expect(g.style.frame).toBeUndefined()
  })

  it('the shot drawn at a time inside the blur covers the click’s place with the blur', () => {
    const shot = guideProject(project({ shapes: [BLUR] }))
    const cursor: CursorTrack = { samples: [{ t: 0, x: 0.5, y: 0.5 }, { t: 40, x: 0.5, y: 0.5 }], clicks: [{ t: 3, x: 0.5, y: 0.5, button: 'left' }], valid: true }
    const scene = {
      project: shot,
      cursor,
      cursorPath: new SmoothedTrack(cursor.samples, shot.duration, shot.cursor.smoothing),
      focusPath: focusPathFor(cursor.samples, shot.duration)
    }
    const src = { screen: { readyState: 4, videoWidth: W, videoHeight: H }, webcam: null, background: null, screenFrame: { image: { tag: 'screen' }, width: W, height: H } }
    canvases = 0
    const c = canvas()
    calls.length = 0
    const t = shotTime(click(3), shot.clips, 60, false)
    drawFrame((c.getContext as (t: string) => unknown)('2d'), W, H, t, scene, src, { blurSamples: 1 }, t)
    const main = calls.filter((k) => k.canvas === 0 && k.name === 'drawImage')
    // The screen at the whole frame, then the blur over the box around the click.
    const blur = main.find((k) => k.args.length === 9 && Math.abs((k.args[5] as number) - BLUR.x * W) < 1 && Math.abs((k.args[6] as number) - BLUR.y * H) < 1)
    expect(blur).toBeDefined()
    expect(blur!.args[7] as number).toBeCloseTo(BLUR.w * W, 0)
    expect(blur!.args[8] as number).toBeCloseTo(BLUR.h * H, 0)
  })
})

describe('test 15: shotTime', () => {
  const clips: Clip[] = [
    { id: 'a', start: 0, end: 10, speed: 1 },
    { id: 'b', start: 20.01, end: 40, speed: 1 }
  ]
  it('one frame before a click at 60 and 30 fps', () => {
    expect(shotTime(click(3), clips, 60, false)).toBeCloseTo(3 - 1 / 60, 9)
    expect(shotTime(click(3), clips, 30, false)).toBeCloseTo(3 - 1 / 30, 9)
  })
  it('the clip’s start when that frame is cut', () => {
    expect(shotTime(click(20.02), clips, 60, false)).toBeCloseTo(20.01, 9)
  })
  it('before typing; after typing with `after` (+0.2 s)', () => {
    const typing: GuideStep = { key: 't21000', t: 21, kind: 'type', typing: { t: 21, end: 23, place: { x: 0.5, y: 0.5 } } }
    expect(shotTime(typing, clips, 60, false)).toBeCloseTo(21 - 1 / 60, 9)
    expect(shotTime(typing, clips, 60, true)).toBeCloseTo(23.2, 9)
    const joined = click(20.5, 0.5, 0.5, { typing: { t: 21, end: 23, place: { x: 0.5, y: 0.5 } } })
    expect(shotTime(joined, clips, 60, false)).toBeCloseTo(20.5 - 1 / 60, 9)
    expect(shotTime(joined, clips, 60, true)).toBeCloseTo(23.2, 9)
  })
  it('a screen change +0.75 s, a badge at its start, an added step at its time', () => {
    expect(shotTime({ key: 's12000', t: 12, kind: 'screen' }, [{ id: 'x', start: 0, end: 40, speed: 1 }], 60, false)).toBeCloseTo(12.75, 9)
    expect(shotTime({ key: 'b4000', t: 4, kind: 'badge', badge: { label: '1' } }, clips, 60, false)).toBe(4)
    expect(shotTime({ key: 'a5000', t: 5, kind: 'added' }, clips, 60, false)).toBe(5)
  })
})

describe('test 16: shotRect', () => {
  const frame = { w: W, h: H }
  it('950 px wide at scale 1 and 1425 at 1.5 on 1920 and 2880 px frames', () => {
    expect(shotRect(click(1, 0.5, 0.5), frame, null, 1, { whole: false }).rect.w).toBe(950)
    expect(shotRect(click(1, 0.5, 0.5), { w: 2880, h: 1620 }, null, 1.5, { whole: false }).rect.w).toBe(1425)
  })
  it('at least a third of the frame', () => {
    expect(shotRect(click(1), { w: 3840, h: 2160 }, null, 1, { whole: false }).rect.w).toBe(1280)
  })
  it('centred on the click, at the recording’s aspect, and moved inside at the edges', () => {
    const mid = shotRect(click(1, 0.5, 0.5), frame, null, 1, { whole: false }).rect
    expect(mid.x + mid.w / 2).toBeCloseTo(960, 6)
    expect(mid.y + mid.h / 2).toBeCloseTo(540, 6)
    expect(mid.h / mid.w).toBeCloseTo(H / W, 6)
    const corner = shotRect(click(1, 0.99, 0.01), frame, null, 1, { whole: false }).rect
    expect(corner.x + corner.w).toBeCloseTo(W, 6)
    expect(corner.y).toBe(0)
  })
  it('a long drag widens it to the whole frame', () => {
    const drag: GuideStep = { ...click(1, 0.05, 0.5), kind: 'drag', to: { x: 0.95, y: 0.5 } }
    expect(shotRect(drag, frame, null, 1, { whole: false }).rect).toEqual({ x: 0, y: 0, w: W, h: H })
    const short: GuideStep = { ...click(1, 0.4, 0.5), kind: 'drag', to: { x: 0.45, y: 0.5 } }
    expect(shotRect(short, frame, null, 1, { whole: false }).rect.w).toBe(950)
  })
  it('`whole`, key presses and screen changes give the whole frame; a stored rect wins', () => {
    expect(shotRect(click(1), frame, null, 1, { whole: true }).rect).toEqual({ x: 0, y: 0, w: W, h: H })
    expect(shotRect({ key: 'k1', t: 1, kind: 'keys', keys: 'Tab' }, frame, null, 1, { whole: false }).rect).toEqual({ x: 0, y: 0, w: W, h: H })
    expect(shotRect({ key: 's1', t: 1, kind: 'screen' }, frame, null, 1, { whole: false }).rect).toEqual({ x: 0, y: 0, w: W, h: H })
    expect(shotRect(click(1), frame, null, 1, { whole: false, rect: { x: 0.1, y: 0.2, w: 0.5, h: 0.5 } }).rect).toEqual({ x: 192, y: 216, w: 960, h: 540 })
  })
  it('a click outside project.crop gives `outside` and the whole shown frame', () => {
    const crop = { x: 0.5, y: 0, w: 0.5, h: 1 }
    const out = shotRect(click(1, 0.2, 0.5), frame, crop, 1, { whole: false })
    expect(out.outside).toBe(true)
    expect(out.rect).toEqual({ x: 960, y: 0, w: 960, h: 1080 })
    const inCrop = shotRect(click(1, 0.75, 0.5), frame, crop, 1, { whole: false })
    expect(inCrop.outside).toBe(false)
    expect(inCrop.rect.x).toBeGreaterThanOrEqual(960)
  })
})

describe('test 17: the ring and the arrow', () => {
  const frame = { w: W, h: H }
  it('a brand colour with 3:1 on white is used, #ffd400 (1.4:1) falls back to #0060df', () => {
    expect(ringColour(project({ brand: { colors: ['#b00020'] } }))).toBe('#b00020')
    expect(ringColour(project({ brand: { colors: ['#ffd400'] } }))).toBe(SHOT.ring)
    expect(ringColour(project())).toBe('#0060df')
    // Unticked Use the brand kit.
    expect(ringColour(project({ brand: { colors: ['#b00020'] }, guide: { brand: false } }))).toBe('#0060df')
  })
  it('ring sizes scale with the image width', () => {
    const rect = shotRect(click(1), frame, null, 1, { whole: false }).rect
    const at960 = ringOf(click(1), rect, 960, frame, null)!
    expect(at960).toMatchObject({ r: 22, width: 4, halo: 3 })
    expect(at960.cx).toBeCloseTo(480, 6)
    const at1920 = ringOf(click(1), rect, 1920, frame, null)!
    expect(at1920).toMatchObject({ r: 44, width: 8, halo: 6 })
  })
  it('a stored ring moves it; no ring for keys and screen changes', () => {
    const rect = { x: 0, y: 0, w: W, h: H }
    expect(ringOf(click(1), rect, 960, frame, null, { x: 0.25, y: 0.25 })).toMatchObject({ cx: 240, cy: 135 })
    expect(ringOf({ key: 'k1', t: 1, kind: 'keys', keys: 'Tab' }, rect, 960, frame, null)).toBeNull()
    expect(ringOf({ key: 's1', t: 1, kind: 'screen' }, rect, 960, frame, null)).toBeNull()
    // A click outside the shown frame has no ring.
    expect(ringOf(click(1, 0.2, 0.5), { x: 960, y: 0, w: 960, h: H }, 960, frame, { x: 0.5, y: 0, w: 0.5, h: 1 })).toBeNull()
  })
  it('a drag gets an arrow from press to release with a 16 px head at 960', () => {
    const drag: GuideStep = { ...click(1, 0.25, 0.5), kind: 'drag', to: { x: 0.75, y: 0.5 } }
    const a = arrowOf(drag, { x: 0, y: 0, w: W, h: H }, 960, frame, null)!
    expect(a).toEqual({ x0: 240, y0: 270, x1: 720, y1: 270, width: 4, head: 16 })
    expect(arrowOf(click(1), { x: 0, y: 0, w: W, h: H }, 960, frame, null)).toBeNull()
  })
  it('blur boxes: 30% × 10% on the click; the typed box from 40 px left of the typing place', () => {
    const b = blurBoxes(click(1, 0.5, 0.5, { typing: { t: 2, end: 3, place: { x: 0.5, y: 0.5 } } }), frame, 1)
    expect(b.area.w).toBeCloseTo(0.3, 9)
    expect(b.area.h).toBeCloseTo(0.1, 9)
    expect(b.area.x + b.area.w / 2).toBeCloseTo(0.5, 9)
    expect(b.typed!.x).toBeCloseTo((960 - 40) / W, 9)
    expect(b.typed!.w).toBeCloseTo(360 / W, 9)
    expect(b.typed!.h).toBeCloseTo(48 / H, 9)
    expect(blurBoxes(click(1, 0.99, 0.99), frame, 1).area.x + 0.3).toBeLessThanOrEqual(1 + 1e-9)
    expect(blurBoxes(click(1), frame, 1).typed).toBeNull()
  })
})
