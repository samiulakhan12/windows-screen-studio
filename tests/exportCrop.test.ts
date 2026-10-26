/**
 * Export sizes of a cropped recording (docs/design/crop-in-editor.md §4.4): 'auto' follows the
 * crop's shape, fixed shapes fit the cropped card, and very wide crops are capped as before.
 */
import { describe, expect, it } from 'vitest'
import { cropProject } from '../src/shared/engine/crop'
import { outputSize } from '../src/shared/engine/layout'
import { createProject } from '../src/shared/engine/project'
import { exportSize } from '../src/shared/render/exportPlan'
import type { ExportOptions } from '../src/shared/render/exportPresets'
import type { AspectRatio, NormRect, Project } from '../src/shared/types'

function project(width: number, height: number, crop?: NormRect, aspectRatio: AspectRatio = 'auto'): Project {
  const p = createProject({
    id: 'p',
    name: 'p',
    duration: 4,
    width,
    height,
    hasWebcam: false,
    hasAudio: false,
    webcamOffset: 0,
    zooms: [],
    cursorValid: true,
    capture: { method: 'native', cursorInVideo: false, region: null, target: 'screen' }
  })
  return { ...p, ...(crop ? { crop } : {}), style: { ...p.style, aspectRatio } }
}

const options = (resolution: ExportOptions['resolution'], extra: Partial<ExportOptions> = {}): ExportOptions => ({ format: 'mp4', resolution, fps: 60, quality: 'high', encoder: 'auto', ...extra })
const size = (p: Project, o: ExportOptions): { width: number; height: number } => {
  const s = exportSize(p, o)
  return { width: s.width, height: s.height }
}
/** The bottom `px` pixels of a `height` px tall recording cropped off. */
const taskbar = (px: number, height: number): NormRect => ({ x: 0, y: 0, w: 1, h: (height - px) / height })

describe('exportSize of a cropped recording', () => {
  it("follows the crop's shape with the Auto aspect", () => {
    const p = project(1280, 720, taskbar(48, 720))
    expect(size(p, options(720))).toEqual({ width: 1372, height: 720 })
    expect(size(p, options(1080))).toEqual({ width: 2058, height: 1080 })
    expect(size(project(1920, 1080, taskbar(48, 1080)), options(1080))).toEqual({ width: 2010, height: 1080 })
    expect(size(project(2560, 1440, taskbar(72, 1440)), options(1080))).toEqual({ width: 2022, height: 1080 })
  })

  it('keeps a fixed shape (the cropped card fits inside it)', () => {
    expect(size(project(1280, 720, taskbar(48, 720), '16:9'), options(1080))).toEqual({ width: 1920, height: 1080 })
    expect(size(project(1280, 720, taskbar(48, 720)), options(1080, { aspect: '9:16' }))).toEqual({ width: 1080, height: 1920 })
  })

  it('is the same for the project as drawn (the view)', () => {
    const p = project(1920, 1080, { x: 0.1, y: 0.05, w: 0.5, h: 0.7 })
    for (const r of [720, 1080, 1440, 2160] as const) expect(size(cropProject(p), options(r))).toEqual(size(p, options(r)))
  })

  it('caps a very wide crop as it caps a very wide recording', () => {
    const s = exportSize(project(1920, 1080, { x: 0, y: 0.4, w: 1, h: 64 / 1080 }), options(2160))
    expect(s.capped).toBe(true)
    expect(Math.max(s.width, s.height)).toBe(4096)
  })

  it('is exactly the size of before without a crop', () => {
    const sizes = [
      [1280, 720],
      [1920, 1080],
      [2560, 1440],
      [3840, 2160],
      [1366, 768],
      [1918, 1080],
      [3440, 1440],
      [1080, 1920],
      [800, 600],
      [1000, 37]
    ]
    for (const [w, h] of sizes) {
      for (const aspect of ['auto', '16:9', '1:1'] as const) {
        const want = outputSize(aspect, w, h, 1080)
        const got = exportSize(project(w, h, undefined, aspect), options(1080))
        expect(got.capped ? 'capped' : { width: got.width, height: got.height }, `${w}x${h} ${aspect}`).toEqual(got.capped ? 'capped' : want)
      }
    }
  })
})
