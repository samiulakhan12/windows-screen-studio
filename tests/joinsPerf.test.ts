/**
 * Smooth cuts' pure parts are fast enough for edit-by-text's thousands of clips (docs/design/
 * editing-polish.md §15, the performance tests of §19.1): joinPlan of 20,000 clips under 20 ms,
 * joinAt under 2 µs, joinFeed of 20,000 output frames and 2,000 windows under 30 ms.
 */
import { describe, expect, it } from 'vitest'
import { createProject } from '../src/shared/engine/project'
import { joinAt, joinFeed, joinPlan, punchAt, trackTimes, type JoinWindow } from '../src/shared/render/joins'
import type { Clip, Project } from '../src/shared/types'

function project(n: number): Project {
  const p = createProject({ id: 'p', name: 'p', duration: n * 1.5, width: 1920, height: 1080, hasWebcam: false, hasAudio: true, webcamOffset: 0, zooms: [], cursorValid: true, capture: { method: 'native', cursorInVideo: false, region: null } })
  const clips: Clip[] = Array.from({ length: n }, (_, i) => ({ id: `c${i}`, start: i * 1.5, end: i * 1.5 + 1, speed: 1 }))
  return { ...p, clips, joins: { all: { kind: 'crossfade' }, cuts: [{ clip: 'c10', kind: 'dip' }, { clip: 'c20', kind: 'punch' }] } }
}

/** The best of a few runs, in ms (the machine is shared). */
function best(runs: number, fn: () => void): number {
  let min = Infinity
  for (let i = 0; i < runs; i++) {
    const t0 = performance.now()
    fn()
    min = Math.min(min, performance.now() - t0)
  }
  return min
}

describe('smooth cuts performance', () => {
  it('plans 20,000 clips under 20 ms', () => {
    // A fresh project each run (nothing memoised); only the plan is timed.
    const projects = Array.from({ length: 5 }, () => project(20000))
    let min = Infinity
    for (const p of projects) {
      const t0 = performance.now()
      const ws = joinPlan(p)
      min = Math.min(min, performance.now() - t0)
      expect(ws.length).toBeGreaterThan(19000)
    }
    expect(min).toBeLessThan(20)
  })

  it('finds the window of a video time under 2 µs, and the punch-in of a source time', () => {
    const p = project(20000)
    const ws = joinPlan(p)
    const n = 200000
    let found = 0
    const t0 = performance.now()
    for (let i = 0; i < n; i++) if (joinAt(ws, (i * 7.3) % 20000)) found++
    const each = ((performance.now() - t0) * 1000) / n
    expect(found).toBeGreaterThan(0)
    expect(each).toBeLessThan(2)
    const t1 = performance.now()
    for (let i = 0; i < n; i++) punchAt(p, (i * 3.1) % 30000)
    expect(((performance.now() - t1) * 1000) / n).toBeLessThan(2)
  })

  it('builds the feeds of 20,000 output frames and 2,000 windows under 30 ms', () => {
    const fps = 30
    const windows: JoinWindow[] = Array.from({ length: 2000 }, (_, k) => {
      const at = (k + 1) * 0.33
      return { index: k + 1, clip: `c${k + 1}`, kind: 'crossfade', from: at, to: at + 0.15, at, still: { screen: at * 1.5 - 1e-6, held: false, camera: at * 1.5 - 1e-6 } }
    })
    const pictures = Array.from({ length: 20000 }, (_, i) => (i / fps) * 1.5)
    const screen = trackTimes(null, 60, 1100)
    const camera = trackTimes(null, 30, 1100)
    let stills = 0
    const ms = best(5, () => {
      stills = joinFeed({ pictures, cameraTimes: pictures, windows, fps, screen, camera }).stills.length
    })
    expect(stills).toBeGreaterThan(1000)
    expect(ms).toBeLessThan(30)
  })
})

