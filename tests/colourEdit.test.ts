/**
 * Editing colour, Auto colour and its Review mode row (docs/design/editing-polish.md §2.5, §9.6,
 * §11, §16; §19.1 tests 53, 54 and 55).
 */
import { describe, expect, it } from 'vitest'
import { autoCameraGrade, withAutoColour, type ColourSample } from '../src/shared/editor/autoColour'
import { resetSlider, settleGrade, withGrade, withLook, withLut } from '../src/shared/editor/colourEdit'
import { EditStore } from '../src/shared/editor/editStore'
import { createProject } from '../src/shared/engine/project'
import { decodeSrgb, encodeSrgb, gradePixelsCpu, gradeTable, resolveGrade } from '../src/shared/render/colorGrade'
import { COLOUR_KEY } from '../src/shared/review/colourReview'
import { keepItems, pendingCount, removeItems, reviewItems, reviewStatus } from '../src/shared/review/review'
import type { ColorGrade, Project } from '../src/shared/types'

function project(over: Partial<Project> = {}): Project {
  const p = createProject({
    id: 'p',
    name: 'p',
    duration: 20,
    width: 1280,
    height: 720,
    hasWebcam: true,
    hasAudio: false,
    webcamOffset: 0,
    zooms: [],
    cursorValid: false,
    capture: { method: 'native', cursorInVideo: false, region: null }
  })
  return { ...p, clips: [{ id: 'c', start: 2, end: 20, speed: 1 }], ...over }
}

/** The settle step the editor runs on every edit (only this part's, here). */
const store = (p: Project): EditStore<Project> => new EditStore(p, undefined, undefined, undefined, settleGrade)

/* ---------- synthetic camera frames ---------- */

const W = 64
const H = 48

/** A scene in linear light: greys and gently coloured patches, a lit wall. `f(x, y)` → linear RGB. */
function frame(f: (x: number, y: number) => [number, number, number], cast: [number, number, number] = [1, 1, 1], scale = 1): Uint8ClampedArray {
  const px = new Uint8ClampedArray(W * H * 4)
  for (let y = 0; y < H; y++)
    for (let x = 0; x < W; x++) {
      const l = f(x, y)
      for (let c = 0; c < 3; c++) px[(y * W + x) * 4 + c] = Math.round(encodeSrgb(l[c] * cast[c] * scale) * 255)
      px[(y * W + x) * 4 + 3] = 255
    }
  return px
}

/** Grey patches of many levels. */
const greys = (x: number, y: number): [number, number, number] => {
  const v = 0.04 + 0.6 * (((x >> 3) + (y >> 3) * 8) % 13) / 12
  return [v, v, v]
}

/** Mostly grey patches of many levels, some colour. */
const room = (x: number, y: number): [number, number, number] => {
  const v = 0.04 + 0.6 * (((x >> 3) + (y >> 3) * 8) % 13) / 12
  if ((x >> 3) % 4 === 3) return [v * 0.8, v, v * 0.7]
  if ((y >> 3) % 5 === 4) return [v, v * 0.85, v * 0.9]
  return [v, v, v]
}

/** The angle (degrees) between a colour and grey. */
function angle(c: readonly number[]): number {
  const dot = c[0] + c[1] + c[2]
  const n = Math.hypot(c[0], c[1], c[2])
  return (Math.acos(Math.min(1, dot / (n * Math.sqrt(3)))) * 180) / Math.PI
}

/** The mean linear colour of the grey patches of `px` (where the scene is grey). */
function greyMean(px: Uint8ClampedArray): [number, number, number] {
  const s = [0, 0, 0]
  let n = 0
  for (let y = 0; y < H; y++)
    for (let x = 0; x < W; x++) {
      const l = room(x, y)
      if (l[0] !== l[1] || l[1] !== l[2]) continue
      for (let c = 0; c < 3; c++) s[c] += decodeSrgb(px[(y * W + x) * 4 + c] / 255)
      n++
    }
  return [s[0] / n, s[1] / n, s[2] / n]
}

const sample = (pixels: Uint8ClampedArray, mask: Uint8ClampedArray | null = null, face: ColourSample['face'] = null): ColourSample => ({ pixels, mask, w: W, h: H, face })

describe('Auto colour (test 53)', () => {
  it('takes away at least 60 % of a warm cast’s angle, with |temperature| ≤ 0.6', () => {
    const warm = frame(room, [1.2, 1, 0.75])
    const samples = Array.from({ length: 12 }, () => sample(warm))
    const g = autoCameraGrade(samples)!
    expect(g.temperature).toBeLessThan(0)
    expect(Math.abs(g.temperature!)).toBeLessThanOrEqual(0.6)
    expect(g.exposure).toBeUndefined()
    const r = resolveGrade(g, 'camera')!
    const graded = warm.slice()
    gradePixelsCpu(graded, r, gradeTable(r), null)
    const before = angle(greyMean(warm))
    const after = angle(greyMean(graded))
    expect(before).toBeGreaterThan(8)
    expect(after).toBeLessThanOrEqual(before * 0.4)
  })

  it('reads the light from the background, not the person', () => {
    // A grey room; the person (left half, masked) wears warm orange, not too saturated to count.
    const px = frame((x, y) => (x < W / 2 ? [0.5, 0.33, 0.22] : greys(x, y)))
    const mask = new Uint8ClampedArray(W * H * 4)
    for (let y = 0; y < H; y++) for (let x = 0; x < W / 2; x++) mask[(y * W + x) * 4 + 3] = 255
    const masked = autoCameraGrade([sample(px, mask)])
    expect(Math.abs(masked?.temperature ?? 0)).toBeLessThanOrEqual(0.01)
    expect(Math.abs(masked?.tint ?? 0)).toBeLessThanOrEqual(0.01)
    // Without the mask the orange would be taken for the light.
    expect(autoCameraGrade([sample(px)])!.temperature).toBeLessThan(-0.1)
  })

  it('a dark frame gains at most 0.7 stops', () => {
    const dark = frame(room, [1, 1, 1], 0.12)
    const g = autoCameraGrade([sample(dark)])!
    expect(g.brightness).toBeGreaterThan(0)
    expect(g.exposure).toBeUndefined()
    const table = gradeTable(resolveGrade(g, 'camera')!)
    for (let code = 8; code < 256; code++) expect(table[256 + code] / decodeSrgb(code / 255)).toBeLessThanOrEqual(2 ** 0.7 * 1.0001)
  })

  it('a dark-skinned face over a bright wall does not raise the brightness', () => {
    const face = { x: 0.35, y: 0.2, w: 0.3, h: 0.45 }
    const inFace = (x: number, y: number): boolean => x / W >= face.x && x / W <= face.x + face.w && y / H >= face.y && y / H <= face.y + face.h
    const px = frame((x, y) => (inFace(x, y) ? [0.1, 0.045, 0.026] : [0.7, 0.7, 0.68]))
    const mask = new Uint8ClampedArray(W * H * 4)
    for (let y = 0; y < H; y++) for (let x = 0; x < W; x++) if (inFace(x, y)) mask[(y * W + x) * 4 + 3] = 255
    const g = autoCameraGrade([sample(px, mask, face)])
    expect(g?.brightness).toBeUndefined()
    expect(g?.exposure).toBeUndefined()
  })

  it('a face near clipping keeps the brightness down', () => {
    // A dim room (the median asks for more light) with a bright face that would clip.
    const face = { x: 0.3, y: 0.2, w: 0.4, h: 0.5 }
    const inFace = (x: number, y: number): boolean => x / W >= face.x && x / W <= face.x + face.w && y / H >= face.y && y / H <= face.y + face.h
    const px = frame((x, y) => (inFace(x, y) ? [0.9, 0.9, 0.9] : greys(x, y)))
    const dimmed = frame((x, y) => (inFace(x, y) ? [0.9, 0.9, 0.9] : (greys(x, y).map((v) => v * 0.12) as [number, number, number])))
    const free = autoCameraGrade([sample(dimmed)])!
    const guarded = autoCameraGrade([sample(dimmed, null, face)])
    expect(free.brightness).toBeGreaterThan(0)
    expect(guarded?.brightness ?? 0).toBeLessThan(free.brightness!)
    expect(autoCameraGrade([sample(px, null, face)])?.brightness).toBeUndefined()
  })

  it('the same input gives the same output; nothing usable gives null', () => {
    const warm = frame(room, [1.15, 1, 0.8])
    expect(autoCameraGrade([sample(warm), sample(warm)])).toEqual(autoCameraGrade([sample(warm), sample(warm)]))
    expect(autoCameraGrade([])).toBeNull()
    // A balanced, well-exposed room needs nothing.
    const fine = frame((x, y) => (x < 4 ? [0.002, 0.002, 0.002] : x > W - 5 ? [0.95, 0.95, 0.95] : greys(x, y)))
    expect(autoCameraGrade([sample(fine)])).toBeNull()
  })
})

describe('editing colour (test 54)', () => {
  it('each action is one project out, the input untouched; nothing to change returns the project itself', () => {
    const p = project()
    const warm = withLook(p, 'camera', 'warm')
    expect(warm).not.toBe(p)
    expect(p.grade).toBeUndefined()
    expect(warm.grade).toEqual({ camera: { look: 'warm' } })
    expect(withLook(warm, 'camera', 'warm')).toBe(warm)
    const half = withLook(warm, 'camera', 'warm', 0.5)
    expect(half.grade).toEqual({ camera: { look: 'warm', lookStrength: 0.5 } })
    // Another look starts at full strength.
    expect(withLook(half, 'camera', 'cool').grade).toEqual({ camera: { look: 'cool' } })
    // The screen takes Natural, Vivid and Mono only.
    expect(withLook(p, 'screen', 'warm')).toBe(p)
    expect(withLook(p, 'screen', 'mono').grade).toEqual({ screen: { look: 'mono' } })
    const slid = withGrade(warm, 'camera', { temperature: 0.2 })
    expect(slid.grade).toEqual({ camera: { look: 'warm', temperature: 0.2 } })
    expect(withGrade(slid, 'camera', { temperature: 0.2 })).toBe(slid)
    // Clamped and read as a load would; exposure only on the camera.
    expect(withGrade(p, 'camera', { contrast: 3 }).grade).toEqual({ camera: { contrast: 1 } })
    expect(withGrade(p, 'screen', { exposure: 1 })).toBe(p)
    expect(withGrade(p, 'camera', { exposure: 1 }).grade).toEqual({ camera: { exposure: 1 } })
  })

  it('Reset deletes an empty grade, and the project has no grade left', () => {
    const p = project()
    const a = withGrade(p, 'screen', { contrast: 0.3 })
    expect(resetSlider(a, 'screen', 'contrast')).toEqual(p)
    expect('grade' in resetSlider(a, 'screen', 'contrast')).toBe(false)
    expect(withGrade(a, 'screen', { contrast: 0 })).toEqual(p)
    const b = withLook(withGrade(a, 'camera', { tint: 0.1 }), 'camera', 'vivid', 0.4)
    expect(withGrade(b, 'camera', null).grade).toEqual({ screen: { contrast: 0.3 } })
    expect(resetSlider(b, 'camera', 'look').grade).toEqual({ screen: { contrast: 0.3 }, camera: { tint: 0.1 } })
    expect(resetSlider(b, 'camera', 'shadows')).toBe(b)
  })

  it('imports and removes a LUT', () => {
    const p = project()
    const lut = { file: 'lut-2.cube', sha256: 'c'.repeat(64), title: 'Teal ‮x', size: 33 }
    const withIt = withLut(p, 'screen', lut)
    expect(withIt.grade).toEqual({ screen: { lut: { ...lut, title: 'Teal x' } } })
    expect(withLut(p, 'screen', { ...lut, file: '../evil.cube' })).toBe(p)
    expect(withLut(withIt, 'screen', null)).toEqual(p)
    expect(withGrade(withIt, 'screen', { lut: { ...withIt.grade!.screen!.lut!, strength: 0.5 } }).grade!.screen!.lut!.strength).toBe(0.5)
  })

  it('a hand edit of the camera grade drops Auto colour’s record; the screen’s does not', () => {
    const p = withAutoColour(project(), { temperature: -0.3 })
    const s = store(p)
    s.update((q) => withGrade(q, 'screen', { contrast: 0.2 }))
    expect(s.state.grade?.auto).toEqual({ camera: null })
    s.update((q) => withGrade(q, 'camera', { tint: 0.1 }))
    expect(s.state.grade?.auto).toBeUndefined()
    expect(s.state.grade?.camera).toEqual({ temperature: -0.3, tint: 0.1 })
    // One undo step each.
    s.undo()
    expect(s.state.grade?.auto).toEqual({ camera: null })
    // settleGrade gives `next` itself when nothing applies.
    const next = { ...p, zooms: [] }
    expect(settleGrade(next, p)).toBe(next)
    const plain = project()
    expect(settleGrade(plain, plain)).toBe(plain)
  })

  it('a second Auto colour run keeps the first run’s record of the colour before', () => {
    const mine: ColorGrade = { look: 'cinematic', contrast: 0.1 }
    const p = withGrade(withLook(project(), 'camera', 'cinematic'), 'camera', { contrast: 0.1 })
    const s = store(p)
    s.update((q) => withAutoColour(q, { temperature: -0.2, brightness: 0.1 }))
    expect(s.state.grade).toEqual({ camera: { look: 'cinematic', temperature: -0.2, brightness: 0.1 }, auto: { camera: mine } })
    s.update((q) => withAutoColour(q, { temperature: -0.4 }))
    // The settle step does not take the second run for an edit by hand.
    expect(s.state.grade).toEqual({ camera: { look: 'cinematic', temperature: -0.4 }, auto: { camera: mine } })
  })
})

describe('the Review mode row of Auto colour (test 55)', () => {
  const balanced = (before: ColorGrade | null = null): Project => {
    let p = project()
    if (before) p = withGrade(p, 'camera', before)
    return withAutoColour(p, { temperature: -0.3, tint: 0.05 })
  }

  it('lists one row at the first clip’s start, pending while the record is there', () => {
    const p = balanced()
    const rows = reviewItems(p).filter((i) => i.kind === 'colour')
    expect(rows).toEqual([{ key: COLOUR_KEY, kind: 'colour', start: 2, end: 2, title: 'Camera colour balanced', detail: 'Auto colour' }])
    expect(pendingCount(p)).toBe(1)
    expect(reviewStatus(p, rows[0])).toBe('pending')
    expect(reviewItems(withGrade(project(), 'camera', { temperature: -0.3 })).filter((i) => i.kind === 'colour')).toEqual([])
  })

  it('Keep drops the record and reads kept', () => {
    const p = balanced()
    const [row] = reviewItems(p)
    const kept = keepItems(p, [row])
    expect(kept.grade).toEqual({ camera: { temperature: -0.3, tint: 0.05 } })
    expect(reviewStatus(kept, row)).toBe('kept')
    expect(reviewItems(kept)).toEqual([])
    expect(keepItems(kept, [row])).toBe(kept)
    // Changed by hand after it was kept: removed.
    expect(reviewStatus(withGrade(kept, 'camera', { tint: 0.2 }), row)).toBe('removed')
  })

  it('Remove puts back the colour from before (none: no grade at all) and reads removed', () => {
    const p = balanced()
    const [row] = reviewItems(p)
    const removed = removeItems(p, [row])
    expect('grade' in removed).toBe(false)
    expect(reviewStatus(removed, row)).toBe('removed')
    const mine = balanced({ look: 'vivid', saturation: 0.2 })
    const back = removeItems(mine, reviewItems(mine))
    expect(back.grade).toEqual({ camera: { look: 'vivid', saturation: 0.2 } })
  })

  it('after two runs Remove puts back the colour from before the first; Keep all and Remove all include it', () => {
    let p = withGrade(project(), 'camera', { contrast: 0.25 })
    p = withAutoColour(p, { temperature: -0.2 })
    p = withAutoColour(p, { temperature: -0.5, brightness: 0.2 })
    expect(removeItems(p, reviewItems(p)).grade).toEqual({ camera: { contrast: 0.25 } })
    const zoomed = { ...p, zooms: [{ id: 'z', start: 1, end: 3, scale: 2, focus: { mode: 'cursor' as const }, auto: true }] } as Project
    const all = reviewItems(zoomed)
    expect(all.map((i) => i.kind)).toEqual(['zoom', 'colour'])
    // Auto colour sets the camera's balance and levels (its contrast with them); Keep keeps them.
    expect(keepItems(zoomed, all).grade).toEqual({ camera: { temperature: -0.5, brightness: 0.2 } })
    expect(removeItems(zoomed, all).grade).toEqual({ camera: { contrast: 0.25 } })
    // One store update, one undo step.
    const s = store(zoomed)
    s.update((q) => removeItems(q, all))
    s.undo()
    expect(s.state).toBe(zoomed)
  })
})
