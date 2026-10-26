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

/**
 * The same head and neck, but the shoulders widen row by row from the neck (16 wide at y 76)
 * to 120 wide at y 100, as a real segmentation mask does, instead of in one step.
 */
const slopedPerson =
  (cx = 166) =>
  (x: number, y: number): boolean => {
    if (((x - cx) / 20) ** 2 + ((y - 48) / 26) ** 2 <= 1) return true
    if (y >= 48 && y < 76 && Math.abs(x - cx) <= 8) return true
    if (y >= 76) return Math.abs(x - cx) <= 8 + Math.min(1, (y - 76) / 24) * 52
    return false
  }

/**
 * A real mask: what the bundled person segmentation made of the e2e camera fixture
 * (tests/e2e/camera-fixtures.cjs, the person at 0.62 of a 640 x 360 picture, scaled to 256 x 144:
 * hair from y 0.12, eyes at 0.34, chin at 0.55, 0.19 wide; shoulders from 0.6 down). Rows as
 * "y:x0-x1,..." runs of person pixels (alpha >= 128, x1 exclusive).
 */
const REAL_MASK =
  '18:153-163,164-165 19:149-167 20:147-169 21:146-171 22:144-172 23:143-174 24:140-174 25:139-176 26:138-177 27:138-178 28:138-179 29:137-179 30:137-179 ' +
  '31:137-179 32:137-179 33:137-180 34:137-180 35:135-179,180-181 36:135-179,180-181 37:135-176,178-179,180-181 38:135-176,178-179,180-181 39:135-177,180-181 ' +
  '40:135-177,180-181,182-183 41:135-178,180-181,182-183 42:135-178,180-181,182-183 43:135-178,180-181,182-183 44:135-178,180-181,182-183 45:135-178 46:135-178 ' +
  '47:135-180 48:135-136,137-181 49:136-181 50:136-182 51:136-183 52:136-184 53:136-183 54:136-183 55:136-183 56:136-182 57:136-181 58:137-181 59:137-179,180-181 ' +
  '60:137-178,180-181 61:137-178 62:138-178 63:138-178 64:140-178 65:141-178 66:141-177 67:142-177 68:142-175,176-177 69:142-175 70:144-174 71:145-173 72:146-172 ' +
  '73:146-171 74:146-170 75:147-169 76:147-169 77:147-169 78:147-169 79:147-169 80:147-169 81:147-169 82:147-169 83:147-169 84:147-169 85:147-170 86:146-171 ' +
  '87:146-173 88:141-144,145-146,147-173,174-175 89:140-178 90:137-181 91:131-132,135-184 92:131-187 93:128-189 94:125-194 95:122-197 96:116-200 97:113-203 ' +
  '98:112-203 99:109-207 100:109-209 101:108-209 102:107-209 103:106-211 104:105-211 105:105-211 106:104-213 107:103-213 108:103-214 109:103-215 110:103-215 ' +
  '111:103-215 112:103-215 113:103-215 114:103-215 115:103-215 116:103-215 117:103-215 118:103-215 119:103-215 120:103-104,105-215 121:105-214 122:105-215 ' +
  '123:103-215 124:103-215 125:103-215 126:103-215 127:102-215 128:102-215 129:102-215 130:102-215 131:102-215 132:102-215 133:102-215 134:101-215 135:101-215 ' +
  '136:101-213,214-215 137:101-213,214-215 138:101-213,214-215 139:101-213,214-215 140:101-213,214-215 141:101-213,214-215 142:100-213 143:101-210'

/** A mask (W x H) of "y:x0-x1,..." runs. */
function maskOfRuns(text: string): Uint8ClampedArray {
  const rows = new Map(
    text.split(' ').map((row) => {
      const [y, runs] = row.split(':')
      return [Number(y), runs.split(',').map((r) => r.split('-').map(Number))] as const
    })
  )
  return mask((x, y) => (rows.get(Math.floor(y)) ?? []).some(([x0, x1]) => x >= x0 && x < x1))
}

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

  it('finds shoulders that widen gradually from the neck', () => {
    // Measured against the row above, no row of the slope is 1.6x wider: the head would be
    // taken as 0.2 of the height tall and the eyes put on the forehead (0.24).
    const b = faceBoxOfMask(mask(slopedPerson()), W, H)
    expect(b).not.toBeNull()
    expect(Math.abs(b!.cx - box!.cx)).toBeLessThanOrEqual(0.005)
    expect(Math.abs(b!.eyeY - 0.33)).toBeLessThanOrEqual(0.02)
    expect(b!.h).toBeGreaterThan(FACE.headRows + 1 / H)
  })

  it('puts the eyes where they are in a real segmentation mask', () => {
    const b = faceBoxOfMask(maskOfRuns(REAL_MASK), W, H)
    expect(b).not.toBeNull()
    expect(Math.abs(b!.cx - 0.62)).toBeLessThanOrEqual(0.01)
    expect(Math.abs(b!.w - 0.19)).toBeLessThanOrEqual(0.02)
    // The drawn eyes are at 0.34 (0.216 when the shoulders were missed).
    expect(Math.abs(b!.eyeY - 0.34)).toBeLessThanOrEqual(0.03)
    // The framing of the e2e test (camera only: cap 1.3) and of the worked example (cropY about 0.40).
    const f = framingFromFaces(Array.from({ length: 8 }, () => b), 640, 360, FACE.largeCameraZoom)!
    expect(f.zoom).toBe(1.3)
    expect(Math.abs(f.cropX - 0.62)).toBeLessThanOrEqual(0.01)
    expect(Math.abs(f.cropY - 0.4)).toBeLessThanOrEqual(0.03)
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
