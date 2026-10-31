import { describe, expect, it } from 'vitest'
import { frameView, type ViewScene } from '../src/shared/engine/frameView'
import { toOutput } from '../src/shared/engine/outputPoint'
import { createProject } from '../src/shared/engine/project'
import { DEFAULT_ZOOM_SETTINGS, focusPathFor } from '../src/shared/engine/zoom'
import { actionRects } from '../src/shared/render/actionRects'
import type { Clip, CursorTrack, Project, ZoomSegment } from '../src/shared/types'

/* The action under a caption (docs/design/captions-studio.md §8.6, §14.1): cursor, clicks and typing, in output pixels. */

const W = 1920
const H = 1080
const ZOOM = DEFAULT_ZOOM_SETTINGS.auto

function setup(track: Partial<CursorTrack>, zooms: ZoomSegment[] = []): { scene: ViewScene; cursor: CursorTrack; project: Project } {
  const project = { ...createProject({ id: 'p', name: 'p', duration: 10, width: W, height: H, hasWebcam: false, hasAudio: true, webcamOffset: 0, zooms, cursorValid: true, capture: { method: 'native', cursorInVideo: false, region: null } as Project['capture'] }) }
  const cursor: CursorTrack = { samples: [{ t: 0, x: 0.5, y: 0.9 }, { t: 10, x: 0.5, y: 0.9 }], clicks: [], valid: true, ...track }
  return { scene: { project, cursor, focusPath: focusPathFor(cursor.samples, project.duration) }, cursor, project }
}
const centre = (r: { x: number; y: number; w: number; h: number }): { x: number; y: number } => ({ x: r.x + r.w / 2, y: r.y + r.h / 2 })

describe('actionRects (§8.6)', () => {
  it('samples the cursor every 0.1 s, padded by 0.08 u, where the cursor layer draws it', () => {
    const { scene, cursor, project } = setup({})
    const out = actionRects(scene, cursor, ZOOM, W, H, W, H, 1, 2, project.clips)
    expect(out.length).toBe(11)
    expect(out[1].t - out[0].t).toBeCloseTo(0.1, 9)
    const { layout, cam } = frameView(scene, W, H, W, H, 1.5)
    const expected = toOutput(layout.screen, cam)(0.5, 0.9)
    const mid = out.find((a) => Math.abs(a.t - 1.5) < 1e-6)!
    expect(centre(mid.rect).x).toBeCloseTo(expected.x, 6)
    expect(centre(mid.rect).y).toBeCloseTo(expected.y, 6)
    expect(mid.rect.w).toBeCloseTo(0.16 * H, 9)
  })

  it('follows the zoom and pan', () => {
    const zoom: ZoomSegment = { id: 'z', start: 0, end: 10, scale: 2, focus: { mode: 'fixed', x: 0.5, y: 0.5 } } as ZoomSegment
    const flat = setup({})
    const zoomed = setup({}, [zoom])
    const a = actionRects(flat.scene, flat.cursor, ZOOM, W, H, W, H, 5, 5.2, flat.project.clips)[0]
    const b = actionRects(zoomed.scene, zoomed.cursor, ZOOM, W, H, W, H, 5, 5.2, zoomed.project.clips)[0]
    // Zoomed in 2× on the centre, the cursor near the bottom moves further from the middle.
    expect(Math.abs(centre(b.rect).y - H / 2)).toBeGreaterThan(Math.abs(centre(a.rect).y - H / 2))
  })

  it('adds clicks and the place typed into, and skips cut time', () => {
    const { scene, cursor, project } = setup({ clicks: [{ t: 1.25, x: 0.2, y: 0.3, button: 'left' }, { t: 1.45, x: 0.9, y: 0.1, button: 'left' }], typing: [{ t: 1.7, end: 2.6 }] })
    const clips: Clip[] = [
      { id: 'a', start: 0, end: 1.3, speed: 1 },
      { id: 'b', start: 1.6, end: 10, speed: 1 }
    ]
    const out = actionRects(scene, cursor, ZOOM, W, H, W, H, 1, 2.5, clips)
    // Nothing in the cut.
    expect(out.some((a) => a.t > 1.3 + 1e-9 && a.t < 1.6 - 1e-9)).toBe(false)
    // The click at 1.25 is there; the one in the cut is not.
    expect(out.some((a) => a.t === 1.25)).toBe(true)
    expect(out.some((a) => a.t === 1.45)).toBe(false)
    // The typing place (the click into the field, else the cursor) shows while typing overlaps.
    const typing = out.filter((a) => a.t >= 1.7 && a.t <= 2.5)
    expect(typing.length).toBeGreaterThan(8)
    expect(out.map((a) => a.t)).toEqual([...out.map((a) => a.t)].sort((x, y) => x - y))
  })

  it('samples a 2× clip by viewing time', () => {
    const { scene, cursor } = setup({})
    const out = actionRects(scene, cursor, ZOOM, W, H, W, H, 2, 4, [{ id: 'a', start: 0, end: 10, speed: 2 }])
    expect(out.length).toBe(11)
    expect(out[1].t - out[0].t).toBeCloseTo(0.2, 9)
  })

  it('has no action without cursor data', () => {
    const { scene, project } = setup({})
    expect(actionRects(scene, null, ZOOM, W, H, W, H, 1, 2, project.clips)).toEqual([])
    expect(actionRects(scene, { samples: [], clicks: [], valid: false }, ZOOM, W, H, W, H, 1, 2, project.clips)).toEqual([])
  })
})
