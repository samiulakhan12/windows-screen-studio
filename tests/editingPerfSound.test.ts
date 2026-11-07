import { describe, expect, it } from 'vitest'
import { sfxJob } from '../src/shared/render/sfxJob'
import type { Annotation, Project, ZoomSegment } from '../src/shared/types'

/*
 * Editing polish's performance budget for part P5 (docs/design/editing-polish.md §19.1
 * Performance): sfxJob of 2,000 zooms and 500 callouts under 10 ms (it runs once per export and
 * once per change in the preview). The other parts' budgets live beside their code.
 */

describe('sfxJob within its budget', () => {
  it('2,000 zooms and 500 callouts in under 10 ms', () => {
    const zooms: ZoomSegment[] = Array.from({ length: 2000 }, (_, i) => ({ id: `z${i}`, start: i * 3, end: i * 3 + 1.5, scale: 2, focus: { mode: 'fixed', x: 0.5, y: 0.5 }, auto: true }))
    const annotations: Annotation[] = Array.from({ length: 500 }, (_, i) => ({ id: `a${i}`, start: i * 12 + 0.5, end: i * 12 + 2, text: 'x', x: 0.5, y: 0.5, size: 0.05, style: 'pill' }))
    const clips = Array.from({ length: 300 }, (_, i) => ({ id: `c${i}`, start: i * 20, end: i * 20 + 19.5, speed: 1 }))
    const p = { id: 'p', clips, zooms, annotations, graphics: [], soundFx: { zoomIn: 'sfx:whoosh-soft', zoomOut: 'sfx:whoosh-out', callouts: 'sfx:pop' } } as unknown as Project
    // Warm up, then the best of a few runs.
    sfxJob({ ...p })
    let best = Infinity
    let job: ReturnType<typeof sfxJob> = []
    for (let k = 0; k < 5; k++) {
      const q = { ...p, zooms: [...zooms] }
      const t0 = performance.now()
      job = sfxJob(q)
      best = Math.min(best, performance.now() - t0)
    }
    expect(job.length).toBe(3)
    expect(best).toBeLessThan(10)
  })
})
