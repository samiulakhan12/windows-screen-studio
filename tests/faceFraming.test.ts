import { describe, expect, it } from 'vitest'
import type { Range } from '../src/shared/audio/activity'
import { FACE, faceBoxOfMask, faceSampleTimes, framingFromFaces, type FaceBox } from '../src/shared/render/faceFraming'

const W = 256
const H = 144

/** A person mask (RGBA, alpha = person) of W x H with the pixels whose centre `inside` accepts. */
function mask(inside: (x: number, y: number) => boolean, w = W, h = H): Uint8ClampedArray {
  const px = new Uint8ClampedArray(w * h * 4)
  for (let y = 0; y < h; y++) {
    for (let x = 0; x < w; x++) {
      if (!inside(x + 0.5, y + 0.5)) continue
      const i = (y * w + x) * 4
      px[i] = px[i + 1] = px[i + 2] = 255
      px[i + 3] = 255
    }
  }
  return px
}

/** Head ellipse centre (cx, 48), radii 20 x 26; neck 16 wide to y 80; shoulders a trapezoid from y 80 (80 wide) to 144 (120 wide). */
const person =
  (cx = 166) =>
  (x: number, y: number): boolean => {
    if (((x - cx) / 20) ** 2 + ((y - 48) / 26) ** 2 <= 1) return true
    if (y >= 48 && y < 80 && Math.abs(x - cx) <= 8) return true
    if (y >= 80) return Math.abs(x - cx) <= 40 + (20 * (y - 80)) / 64
    return false
  }

const either =
  (...shapes: ((x: number, y: number) => boolean)[]) =>
  (x: number, y: number): boolean =>
    shapes.some((s) => s(x, y))

const box = faceBoxOfMask(mask(person()), W, H)

describe('faceBoxOfMask', () => {
  it('finds the head of the fixture person', () => {
    expect(box).not.toBeNull()
    expect(box!.cx).toBeCloseTo(0.648, 1)
    expect(Math.abs(box!.cx - 0.648)).toBeLessThanOrEqual(0.01)
    expect(Math.abs(box!.w - 0.152)).toBeLessThanOrEqual(0.01)
    expect(Math.abs(box!.eyeY - 0.33)).toBeLessThanOrEqual(0.02)
    // The head's height stops at its width ratio, above the shoulders.
    expect(box!.h * H).toBeLessThanOrEqual(FACE.headRatio * box!.w * W + 1e-9)
    expect(box!.cy).toBeGreaterThan(22 / H)
    expect(box!.cy).toBeLessThan(80 / H)
  })

  it('is null for an empty mask or a person under 2% of the picture', () => {
    expect(faceBoxOfMask(mask(() => false), W, H)).toBeNull()
    // About 1% coverage: a 19 x 19 block.
    expect(faceBoxOfMask(mask((x, y) => x > 100 && x < 119 && y > 40 && y < 59), W, H)).toBeNull()
  })

  it('is null when only shoulders or a hand show at the bottom', () => {
    expect(faceBoxOfMask(mask((_x, y) => y > 0.65 * H), W, H)).toBeNull()
  })

  it('reads half-transparent pixels as background', () => {
    const px = mask(person())
    for (let i = 3; i < px.length; i += 4) if (px[i] === 255) px[i] = 127
    expect(faceBoxOfMask(px, W, H)).toBeNull()
  })

  it('ignores a chair back at the far left', () => {
    const chair = (x: number, y: number): boolean => x < 22 && y > 20
    const withChair = faceBoxOfMask(mask(either(person(), chair)), W, H)
    expect(withChair).not.toBeNull()
    expect(Math.abs(withChair!.cx - box!.cx)).toBeLessThanOrEqual(0.005)
    expect(Math.abs(withChair!.w - box!.w)).toBeLessThanOrEqual(0.005)
  })

  it('takes a head 0.2 of the height tall when no shoulders show', () => {
    // A head with a neck to the bottom and nothing wider.
    const head = (x: number, y: number): boolean => ((x - 128) / 24) ** 2 + ((y - 50) / 30) ** 2 <= 1 || (y > 50 && Math.abs(x - 128) <= 12)
    const b = faceBoxOfMask(mask(head), W, H)
    expect(b).not.toBeNull()
    expect(b!.cx).toBeCloseTo(0.5, 2)
    expect(b!.h).toBeLessThanOrEqual(FACE.headRows + 1 / H)
  })

  it('works on a mask of another shape', () => {
    // A 4:3 camera (192 x 144): the same person, normalised to that picture.
    const b = faceBoxOfMask(mask(person(96), 192, 144), 192, 144)
    expect(b!.cx).toBeCloseTo(0.5, 2)
    expect(Math.abs(b!.w - 39 / 192)).toBeLessThanOrEqual(0.01)
  })
})

describe('framingFromFaces', () => {
  const twelve = Array.from({ length: 12 }, () => box)

  it('frames the fixture face in a 1280 x 720 camera', () => {
    const f = framingFromFaces(twelve, 1280, 720, 1.6)!
    expect(Math.abs(f.zoom - 1.55)).toBeLessThanOrEqual(0.05)
    expect(Math.abs(f.cropX - 0.648)).toBeLessThanOrEqual(0.01)
    expect(Math.abs(f.cropY - 0.38)).toBeLessThanOrEqual(0.02)
    expect(f).toMatchObject({ found: 12, sampled: 12, steady: true })
    // Rounded as the Framing section does.
    expect(Math.round(f.zoom / FACE.zoomStep) * FACE.zoomStep).toBeCloseTo(f.zoom, 9)
    expect(f.cropX).toBe(Number(f.cropX.toFixed(4)))
    expect(f.cropY).toBe(Number(f.cropY.toFixed(4)))
  })

  it('caps the zoom when the camera is shown large', () => {
    const f = framingFromFaces(twelve, 1280, 720, FACE.largeCameraZoom)!
    expect(f.zoom).toBe(1.3)
    // The eyes stay about 42% down the visible part at the lower zoom too.
    expect(f.cropY).toBeCloseTo(box!.eyeY + (FACE.headroom * (720 / 1.3)) / 720, 4)
  })

  it('needs at least 4 faces and 40% of the samples', () => {
    const fourOfTwelve = [...Array.from({ length: 4 }, () => box), ...Array.from({ length: 8 }, () => null)]
    expect(framingFromFaces(fourOfTwelve, 1280, 720, 1.6)).toBeNull()
    const fiveOfTwelve = [...Array.from({ length: 5 }, () => box), ...Array.from({ length: 7 }, () => null)]
    expect(framingFromFaces(fiveOfTwelve, 1280, 720, 1.6)).toMatchObject({ found: 5, sampled: 12 })
    expect(framingFromFaces([box, box, box], 1280, 720, 1.6)).toBeNull()
    expect(framingFromFaces([], 1280, 720, 1.6)).toBeNull()
  })

  it('zooms gently on a person who moves around', () => {
    const moving = Array.from({ length: 12 }, (_, i): FaceBox => ({ ...box!, cx: i % 2 ? 0.7 : 0.4 }))
    const f = framingFromFaces(moving, 1280, 720, 1.6)!
    expect(f.zoom).toBeLessThanOrEqual(FACE.spreadZoom)
    expect(f.steady).toBe(false)
  })

  it('frames a person who leaves the picture from the pictures they are in', () => {
    // In the first 8 of 12 pictures, then gone: still enough faces, centred where they sat.
    const leaves = Array.from({ length: 12 }, (_, i) => (i < 8 ? box : null))
    expect(framingFromFaces(leaves, 1280, 720, 1.6)).toMatchObject({ found: 8, sampled: 12, steady: true, cropX: Number(box!.cx.toFixed(4)) })
    // Gone from most of them: too few to trust.
    expect(framingFromFaces(Array.from({ length: 12 }, (_, i) => (i < 4 ? box : null)), 1280, 720, 1.6)).toBeNull()
  })

  it('does not zoom on a head that already fills the bubble', () => {
    const big: FaceBox = { ...box!, w: 0.4 }
    expect(framingFromFaces(Array.from({ length: 8 }, () => big), 1280, 720, 1.6)?.zoom).toBe(1)
    // Just under the minimum zoom is no zoom either.
    const near: FaceBox = { ...box!, w: (FACE.headShare * 720) / (1.08 * 1280) }
    expect(framingFromFaces(Array.from({ length: 8 }, () => near), 1280, 720, 1.6)?.zoom).toBe(1)
  })

  it('never crops past the picture', () => {
    const low: FaceBox = { ...box!, eyeY: 0.99, cx: 1.2 }
    const f = framingFromFaces(Array.from({ length: 8 }, () => low), 1280, 720, 1.6)!
    expect(f.cropY).toBeLessThanOrEqual(1)
    expect(f.cropX).toBeLessThanOrEqual(1)
  })
})

describe('faceSampleTimes', () => {
  const r = (start: number, end: number): Range => ({ start, end })

  it('takes one picture per 6 s of camera shown, 6 to 16', () => {
    expect(faceSampleTimes([r(0, 12)], null, 0, 100)).toHaveLength(6)
    expect(faceSampleTimes([r(0, 60)], null, 0, 100)).toHaveLength(10)
    expect(faceSampleTimes([r(0, 600)], null, 0, 1000)).toHaveLength(16)
    expect(faceSampleTimes([], null, 0, 100)).toEqual([])
  })

  it('samples inside the shown ranges, sorted, at the slot middles without speech', () => {
    const shown = [r(0, 6), r(30, 48)]
    const times = faceSampleTimes(shown, null, 0, 100)
    expect(times).toEqual([...times].sort((a, b) => a - b))
    expect(times.every((t) => shown.some((s) => t >= s.start && t <= s.end))).toBe(true)
    // 24 s shown, 6 slots of 4 s.
    expect(times[0]).toBeCloseTo(2, 9)
    // The second slot spans the gap: [4, 6] and [30, 32]; its middle is where the first range ends.
    expect(times[1]).toBeCloseTo(6, 9)
    expect(times[2]).toBeCloseTo(34, 9)
  })

  it('prefers the middle of the longest speech in each slot', () => {
    const times = faceSampleTimes([r(0, 36)], [r(1, 2), r(3, 5.5), r(13, 13.4)], 0, 100)
    expect(times[0]).toBeCloseTo(4.25, 9)
    expect(times[2]).toBeCloseTo(13.2, 9)
    expect(times[1]).toBeCloseTo(9, 9)
  })

  it('shifts by the webcam offset and skips times outside the camera', () => {
    const base = faceSampleTimes([r(0, 36)], null, 0, 100)
    const shifted = faceSampleTimes([r(0, 36)], null, 1.5, 100)
    // The first slot's middle (3 s) is camera time 1.5; nothing below 0.
    expect(shifted).toEqual(base.map((t) => t - 1.5))
    expect(faceSampleTimes([r(0, 36)], null, 4, 100)).toEqual(base.map((t) => t - 4).filter((t) => t >= 0))
    // A camera shorter than the recording: times past its end (less a frame) are skipped.
    const short = faceSampleTimes([r(0, 36)], null, 0, 21.05)
    expect(short.every((t) => t <= 21)).toBe(true)
    expect(short).toHaveLength(4)
  })
})
