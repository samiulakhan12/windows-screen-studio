import { describe, expect, it } from 'vitest'
import { captionPoses, flashSafeChunks } from '../src/shared/captions/motion'
import { studioChunkAt, studioLayout, type StudioFace, type StudioLayout } from '../src/shared/captions/studioLayout'
import { studioPreset } from '../src/shared/captions/studioPresets'
import type { CaptionSegment, CaptionWord, Clip } from '../src/shared/types'

/*
 * Test 30 (docs/design/captions-studio.md §16.1, §9.8): 5,000 captions laid out and poses for
 * 10,000 frames, under a 6× margin of the budget (layout of a 12-word caption under 0.1 ms cold,
 * poses under 20 µs a frame), so a slow CI machine still passes and a regression does not.
 */

const MARGIN = 6
const WORDS = ['open', 'the', 'settings', 'and', 'click', 'export', 'to', 'save', 'your', 'video', 'right', 'now', 'Visual', 'Studio', 'Code', 'grew', '300', 'percent']
const FACE: StudioFace = { stack: 'test', weight: 700, tracking: 0 }
const measure = (text: string, px: number): number => text.length * 0.55 * px

function captions(n: number): CaptionSegment[] {
  const out: CaptionSegment[] = []
  let t = 0
  for (let i = 0; i < n; i++) {
    const words: CaptionWord[] = []
    for (let k = 0; k < 12; k++) {
      const text = WORDS[(i * 7 + k * 3) % WORDS.length] + (k === 5 ? ',' : k === 11 ? '.' : '')
      words.push({ text, start: t + k * 0.3, end: t + k * 0.3 + 0.25 })
    }
    out.push({ id: `c${i}`, start: t, end: t + 3.6, text: words.map((w) => w.text).join(' '), words })
    t += 3.8
  }
  return out
}

describe('performance (test 30)', () => {
  const segs = captions(5000)
  const clips: Clip[] = [{ id: 'a', start: 0, end: segs[segs.length - 1].end + 1, speed: 1 }]

  for (const id of ['subtitle', 'bold-pop', 'stacked']) {
    it(`${id}: 5,000 captions laid out and 10,000 frames of poses within the budget`, () => {
      const studio = studioPreset(id)!.look
      const t0 = performance.now()
      const layouts: StudioLayout[] = segs.map((s) => studioLayout(s, studio, 1080, 1920, measure, { faceOf: () => FACE, language: 'en', marks: [{ from: 4, to: 4 }] }))
      const layoutMs = performance.now() - t0
      expect(layouts.every((l) => l.chunks.length > 0)).toBe(true)
      expect(layoutMs, `layout ${layoutMs.toFixed(0)} ms`).toBeLessThan(5000 * 0.1 * MARGIN)
      const safe = layouts.map((l) => flashSafeChunks(l, clips, 1080 * 1920, () => 0))
      const end = segs[segs.length - 1].end
      const t1 = performance.now()
      let drawn = 0
      for (let f = 0; f < 10000; f++) {
        const t = (f / 10000) * end
        // The caption at t (as the layer finds it), its chunk and the poses.
        let lo = 0
        let hi = segs.length - 1
        while (lo < hi) {
          const mid = (lo + hi + 1) >> 1
          if (segs[mid].start <= t) lo = mid
          else hi = mid - 1
        }
        if (!(t >= segs[lo].start && t < segs[lo].end)) continue
        const c = studioChunkAt(safe[lo], t)
        if (c < 0) continue
        const poses = captionPoses(safe[lo], c, t, clips, studio, 1080, segs[lo + 1]?.start ?? null)
        drawn += poses.words.length
      }
      const posesMs = performance.now() - t1
      expect(drawn).toBeGreaterThan(10000)
      expect(posesMs, `poses ${posesMs.toFixed(0)} ms`).toBeLessThan(10000 * 0.02 * MARGIN)
    })
  }
})
