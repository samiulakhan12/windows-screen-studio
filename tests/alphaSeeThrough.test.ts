import { describe, expect, it } from 'vitest'
import { createProject } from '../src/shared/engine/project'
import { exportProject, exportSize } from '../src/shared/render/exportPlan'
import { DEFAULT_EXPORT_OPTIONS, type ExportOptions } from '../src/shared/render/exportPresets'
import { CODEC_POLICY } from '../src/shared/render/proFormats'
import { alphaHint, alphaOf, seeThrough } from '../src/shared/render/alpha'
import type { LayoutSegment, Project } from '../src/shared/types'

/*
 * Transparent exports, the pure side (docs/design/output-and-languages.md §6.1, §2.1): which
 * background an export draws see-through (alphaOf), whether anything would be see-through
 * (seeThrough, test 27) and the Background row's standing hint that follows it.
 */

const W = 1280
const H = 720

function project(over: Partial<Project> = {}, style: Partial<Project['style']> = {}): Project {
  const p = createProject({ id: 'p', name: 'Demo', duration: 10, width: W, height: H, hasWebcam: false, hasAudio: true, webcamOffset: 0, zooms: [], cursorValid: false, capture: { method: 'chromium', cursorInVideo: true, region: null } })
  return { ...p, ...over, style: { ...p.style, aspectRatio: 'auto', ...style } }
}

const options = (o: Partial<ExportOptions>): ExportOptions => ({ ...DEFAULT_EXPORT_OPTIONS, ...o })

/** seeThrough for the export of `p` with `o`, as the dialog asks it: the project in the export's shape, at its size. */
function exported(p: Project, o: ExportOptions, alpha: 'background' | 'overlays' = 'background'): boolean {
  const shaped = exportProject(p, { aspect: o.aspect })
  const size = exportSize(shaped, o)
  return seeThrough(shaped, alpha, size.width, size.height)
}

describe('alphaOf: the RenderScene.alpha of an export', () => {
  it('is the Background of a format and codec that carry transparency', () => {
    expect(alphaOf(options({ format: 'webm', alpha: 'background' }))).toBe('background')
    expect(alphaOf(options({ format: 'webm', alpha: 'overlays' }))).toBe('overlays')
    expect(alphaOf(options({ format: 'mov', codec: 'cineform', alpha: 'background' }))).toBe('background')
    expect(alphaOf(options({ format: 'mov', codec: 'animation', alpha: 'overlays' }))).toBe('overlays')
  })

  it('is undefined for an opaque export, and for one whose codec cannot carry transparency', () => {
    expect(alphaOf(DEFAULT_EXPORT_OPTIONS)).toBeUndefined()
    expect(alphaOf(options({ format: 'webm' }))).toBeUndefined()
    expect(alphaOf(options({ format: 'mp4', alpha: 'background' }))).toBeUndefined()
    expect(alphaOf(options({ format: 'mov', alpha: 'background' }))).toBeUndefined()
    expect(alphaOf(options({ format: 'mov', codec: 'hevc', alpha: 'background' }))).toBeUndefined()
    expect(alphaOf(options({ format: 'webm', codec: 'av1', alpha: 'background' }))).toBeUndefined()
    expect(alphaOf(options({ format: 'gif', alpha: 'background' }))).toBeUndefined()
    expect(alphaOf(options({ format: 'webm', alpha: 'everything' as unknown as 'background' }))).toBeUndefined()
  })

  it('follows the codec policy: ProRes 4444 only while the owner turns ProRes on', () => {
    const o = options({ format: 'mov', codec: 'prores-4444', alpha: 'background' })
    expect(alphaOf(o)).toBeUndefined()
    CODEC_POLICY.prores = true
    try {
      expect(alphaOf(o)).toBe('background')
    } finally {
      CODEC_POLICY.prores = false
    }
  })
})

describe('seeThrough and the hint that follows it (test 27)', () => {
  const webm = options({ format: 'webm', alpha: 'background' })

  it('is false for aspect Project (auto) with padding 0: the card fills the frame', () => {
    expect(exported(project({}, { padding: 0 }), webm)).toBe(false)
    expect(exported(project({}, { padding: 0 }), { ...webm, resolution: 2160 })).toBe(false)
  })

  it('is true with a padding of 40 px', () => {
    expect(exported(project({}, { padding: 40 / H }), webm)).toBe(true)
    // The project's own padding (0.07 of the shorter side).
    expect(exported(project(), webm)).toBe(true)
  })

  it('is true for Overlays only, whatever the padding', () => {
    expect(exported(project({}, { padding: 0 }), webm, 'overlays')).toBe(true)
  })

  it('is true when the export shape leaves room around the card, a zoom pulls it back or the card is tilted', () => {
    expect(exported(project({}, { padding: 0 }), { ...webm, aspect: '9:16' })).toBe(true)
    expect(exported(project({}, { padding: 0 }), { ...webm, aspect: '4:5' })).toBe(true)
    const pulled = project({ zooms: [{ id: 'z', start: 2, end: 4, scale: 0.8, focus: { mode: 'cursor' }, auto: false }] }, { padding: 0 })
    expect(exported(pulled, webm)).toBe(true)
    const tilted = project({ tilt: { enabled: true, rotateX: 0, rotateY: 12, perspective: 0.5, animate: 'none' } }, { padding: 0 })
    expect(exported(tilted, webm)).toBe(true)
    // A tilt turned on but flat leaves the card as it is.
    expect(exported({ ...tilted, tilt: { ...tilted.tilt!, rotateY: 0 } }, webm)).toBe(false)
  })

  it('looks at every camera layout of the video: a side-by-side segment opens the frame', () => {
    const side: LayoutSegment = { id: 'l', start: 3, end: 6, layout: 'side-by-side' } as LayoutSegment
    const withCamera = project({ hasWebcam: true, webcam: { ...project().webcam, show: true }, layouts: [side] }, { padding: 0 })
    expect(exported({ ...withCamera, layouts: [] }, webm)).toBe(false)
    expect(exported(withCamera, webm)).toBe(true)
  })

  it('a device frame around the recording counts as card', () => {
    // A browser frame's chrome takes the room at the top: the outline still spans the frame's width.
    const framed = project({}, { padding: 0, frame: { kind: 'browser', theme: 'dark' } as Project['style']['frame'] })
    expect(exported(framed, webm)).toBe(true)
  })

  it('the standing hint: nothing see-through, else where it plays; none for an opaque export', () => {
    const p = project({}, { padding: 0 })
    const mov = options({ format: 'mov', codec: 'cineform', alpha: 'background' })
    expect(alphaHint(mov, exported(p, mov))).toBe('alpha.hint.fills')
    expect(alphaHint(webm, exported(p, webm))).toBe('alpha.hint.fills')
    const padded = project({}, { padding: 40 / H })
    expect(alphaHint(mov, exported(padded, mov))).toBe('alpha.hint.plays')
    const overlays = { ...mov, alpha: 'overlays' as const }
    expect(alphaHint(overlays, exported(p, overlays, 'overlays'))).toBe('alpha.hint.plays')
    expect(alphaHint(DEFAULT_EXPORT_OPTIONS, false)).toBeNull()
    expect(alphaHint(options({ format: 'mp4', alpha: 'background' }), false)).toBeNull()
  })
})
