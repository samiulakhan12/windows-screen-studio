/**
 * The colour maths' cost (docs/design/editing-polish.md §15, §19.1 Performance): baking the
 * per-channel table under 1 ms, parsing a 33³ .cube under 40 ms, and the CPU path grading a 1080p
 * screen picture within the 45 ms budget. Each is the best of a few runs, so a busy machine's
 * pauses are not counted.
 */
import { describe, expect, it } from 'vitest'
import { gradePixelsCpu, gradeTable, resolveGrade } from '../src/shared/render/colorGrade'
import { parseCube } from '../src/shared/render/cubeLut'

const best = (runs: number, fn: () => void): number => {
  let ms = Infinity
  for (let i = 0; i < runs; i++) {
    const t0 = performance.now()
    fn()
    ms = Math.min(ms, performance.now() - t0)
  }
  return ms
}

describe('colour performance', () => {
  it('bakes the per-channel table in under 1 ms', () => {
    const g = resolveGrade({ look: 'cinematic', temperature: 0.3, brightness: 0.2, exposure: 0.5 }, 'camera')!
    expect(best(20, () => gradeTable(g))).toBeLessThan(1)
  })

  it('parses a 33³ .cube in under 40 ms', () => {
    const n = 33
    const lines = ['TITLE "Bench"', `LUT_3D_SIZE ${n}`]
    for (let b = 0; b < n; b++) for (let g = 0; g < n; g++) for (let r = 0; r < n; r++) lines.push(`${(b / (n - 1)).toFixed(6)} ${(g / (n - 1)).toFixed(6)} ${(r / (n - 1)).toFixed(6)}`)
    const bytes = new TextEncoder().encode(lines.join('\n') + '\n')
    expect(best(5, () => parseCube(bytes))).toBeLessThan(40)
  })

  it('grades a 1080p screen picture on the CPU within its budget', () => {
    const px = new Uint8ClampedArray(1920 * 1080 * 4)
    const panels = [
      [245, 245, 245],
      [30, 120, 220],
      [250, 250, 252],
      [60, 60, 70],
      [255, 255, 255]
    ]
    for (let y = 0; y < 1080; y++)
      for (let x = 0; x < 1920; x++) {
        const c = (x * 7 + y * 13) % 41 === 0 ? [20, 20, 30] : panels[((x >> 7) + (y >> 6)) % 5]
        px.set([c[0], c[1], c[2], 255], (y * 1920 + x) * 4)
      }
    const g = resolveGrade({ look: 'vivid', temperature: -0.2 }, 'screen')!
    const table = gradeTable(g)
    expect(best(5, () => gradePixelsCpu(px.slice(), g, table, null))).toBeLessThan(45)
  })
})
