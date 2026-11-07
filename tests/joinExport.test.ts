/**
 * The export's side of smooth cuts (docs/design/editing-polish.md §5.8; §19.1 test 19, the export
 * path): the still frames copied where the feeds reach them, the camera still's person mask
 * prepared before A* is composed, A* waiting for its window's first frame, and dropped after it.
 */
import { describe, expect, it } from 'vitest'
import { createProject } from '../src/shared/engine/project'
import { planOf, videoFrames } from '../src/shared/engine/freeze'
import { joinFeed, joinPlan, trackTimes } from '../src/shared/render/joins'
import type { Project } from '../src/shared/types'

// Renderer code (DOM types): imported at run time so the Node typecheck of tests/ does not follow it.
const JOIN_EXPORT = '../src/renderer/src/editor/joinExport'
type Frame = { image: unknown; width: number; height: number }
const { ExportJoins } = (await import(/* @vite-ignore */ JOIN_EXPORT)) as {
  ExportJoins: new (
    feed: ReturnType<typeof joinFeed>,
    windows: ReturnType<typeof joinPlan>,
    deps: {
      copy(f: Frame): Frame
      prepareMask(f: Frame): Promise<void>
      compose(window: unknown, stills: { screen: Frame; camera: Frame | null }): unknown
      drop(image: unknown): void
    }
  ) => {
    stillOnly(kind: 'screen' | 'camera', pos: number): boolean
    took(kind: 'screen' | 'camera', pos: number, frame: Frame | null): void
    ready(): Promise<void>
    joinAt(video: number): { at: { window: unknown; p: number }; still: unknown } | null
    dispose(): void
  }
}

function project(): Project {
  const p = createProject({
    id: 'p',
    name: 'p',
    duration: 12,
    width: 1280,
    height: 720,
    hasWebcam: true,
    hasAudio: false,
    webcamOffset: 0.05,
    zooms: [],
    cursorValid: false,
    capture: { method: 'native', cursorInVideo: false, region: null }
  })
  p.webcam = { show: true, corner: 'bottom-right', size: 0.24, shape: 'circle' }
  return {
    ...p,
    clips: [
      { id: 'a', start: 0, end: 2, speed: 1 },
      { id: 'b', start: 3, end: 5, speed: 1 },
      { id: 'c', start: 6, end: 8, speed: 1 }
    ],
    joins: { all: { kind: 'crossfade', duration: 0.3 }, cuts: [{ clip: 'c', kind: 'dip' }] }
  }
}

describe('ExportJoins (test 19, the export path)', () => {
  it('copies the stills as the feeds reach them, prepares the camera mask before composing, and draws A* in its window only', async () => {
    const p = project()
    const fps = 30
    const windows = joinPlan(p)
    expect(windows.map((w) => w.kind)).toEqual(['crossfade', 'dip'])
    const { times, pictures } = videoFrames(p.clips, planOf(p), fps)
    const cameraTimes = times.map((t) => t - p.webcamOffset)
    const feed = joinFeed({ pictures, cameraTimes, windows, fps, screen: trackTimes(null, 60, 12), camera: trackTimes(null, 30, 12) })
    expect(feed.stills).toHaveLength(1)
    const log: string[] = []
    let copies = 0
    const joins = new ExportJoins(feed, windows, {
      copy: (f) => {
        log.push(`copy ${f.image}`)
        return { image: `copy${copies++} of ${f.image}`, width: f.width, height: f.height }
      },
      prepareMask: async (f) => void log.push(`mask ${f.image}`),
      compose: (_w, stills) => {
        log.push(`compose ${stills.screen.image} + ${stills.camera?.image}`)
        return 'A*'
      },
      drop: (image) => void log.push(`drop ${image}`)
    })
    // The export's loop: every position of each feed in order (still-only ones first), then the frame.
    let posS = 0
    let posC = 0
    const drawn: ({ p: number; still: unknown } | null)[] = []
    for (let i = 0; i < times.length; i++) {
      const atS = feed.draw.screen[i]
      const atC = feed.draw.camera[i]
      for (; posS < atS; posS++) if (joins.stillOnly('screen', posS)) joins.took('screen', posS, { image: `s${posS}`, width: 1, height: 1 })
      for (; posC < atC; posC++) if (joins.stillOnly('camera', posC)) joins.took('camera', posC, { image: `c${posC}`, width: 1, height: 1 })
      joins.took('screen', atS, { image: `s${atS}`, width: 1, height: 1 })
      joins.took('camera', atC, { image: `c${atC}`, width: 1, height: 1 })
      await joins.ready()
      const j = joins.joinAt(i / fps)
      drawn.push(j ? { p: j.at.p, still: j.still } : null)
      posS = atS + 1
      posC = atC + 1
    }
    const s = feed.stills[0]
    expect(log.slice(0, 2).sort()).toEqual([`copy c${s.camera}`, `copy s${s.screen}`].sort())
    // The camera copy's mask, then A* from both copies, then the copies go.
    const at = log.findIndex((l) => l.startsWith('mask'))
    expect(log[at]).toMatch(/^mask copy\d of c/)
    expect(log[at + 1]).toMatch(/^compose copy\d of s\d+ \+ copy\d of c\d+$/)
    expect(log.slice(at + 2, at + 4).every((l) => l.startsWith('drop copy'))).toBe(true)
    // A* is drawn in the crossfade's window (edit 2 s .. 2.3 s), at 1 − p by the compositor.
    const i0 = Math.ceil(windows[0].at * fps - 1e-9)
    expect(drawn[i0 - 1]).toBeNull()
    expect(drawn[i0]).toEqual({ p: 0, still: 'A*' })
    expect(drawn.filter((d) => d?.still === 'A*')).toHaveLength(9)
    // The dip needs no still; A* was let go once its window ended.
    const dip = drawn.filter((d) => d && d.still === null)
    expect(dip.length).toBeGreaterThan(0)
    expect(log.at(-1)).toBe('drop A*')
    joins.dispose()
  })

  it('draws a hard cut for a window whose still the feeds could not give', async () => {
    const p = project()
    const windows = joinPlan(p)
    const feed = joinFeed({ pictures: [0, 1, 1.9], cameraTimes: null, windows, fps: 30, screen: trackTimes(null, 60, 12), camera: null })
    // No output frame inside any window (three frames): nothing to compose.
    expect(feed.stills).toEqual([])
    const joins = new ExportJoins(feed, windows, { copy: (f) => f, prepareMask: async () => undefined, compose: () => 'A*', drop: () => undefined })
    await joins.ready()
    expect(joins.joinAt(windows[0].at + 0.01)).toEqual({ at: { window: windows[0], p: expect.any(Number) }, still: null })
  })
})
