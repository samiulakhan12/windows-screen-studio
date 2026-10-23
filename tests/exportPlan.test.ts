import { describe, expect, it } from 'vitest'
import { validateJob } from '../src/main/exportJob'
import type { ExportCapabilities, ExportJob } from '../src/shared/api/export'
import { outputSize } from '../src/shared/engine/layout'
import { createProject } from '../src/shared/engine/project'
import { avcLevel, colorTagsFrom } from '../src/shared/render/codec'
import { capSize, exportDimensions, exportRoutes, exportSize, MAX_EXPORT_SIDE, routeLabel } from '../src/shared/render/exportPlan'
import type { ExportSettings } from '../src/shared/types'

const settings: ExportSettings = { format: 'mp4', resolution: 1080, fps: 60, quality: 'high', encoder: 'auto' }
const noGpu: Pick<ExportCapabilities, 'hardwareEncoders' | 'overrides'> = { hardwareEncoders: [], overrides: {} }
const job: ExportJob = {
  width: 1280,
  height: 720,
  fps: 60,
  frames: 60,
  format: 'mp4',
  quality: 'high',
  video: { kind: 'raw', encoder: 'libx264', pixelFormat: 'rgba' },
  outputPath: '/tmp/x.mp4'
}

describe('exportRoutes', () => {
  it('Auto: WebCodecs GPU, then ffmpeg GPU encoders, then x264', () => {
    const routes = exportRoutes(settings, { hardwareEncoders: ['h264_nvenc', 'h264_mf'], overrides: {} })
    expect(routes).toEqual([
      { video: 'webcodecs', hardware: true },
      { video: 'ffmpeg', encoder: 'h264_nvenc' },
      { video: 'ffmpeg', encoder: 'h264_mf' },
      { video: 'ffmpeg', encoder: 'libx264' }
    ])
    expect(exportRoutes(settings, noGpu)).toEqual([
      { video: 'webcodecs', hardware: true },
      { video: 'ffmpeg', encoder: 'libx264' }
    ])
  })
  it('Software always means x264', () => {
    expect(exportRoutes({ ...settings, encoder: 'software' }, { hardwareEncoders: ['h264_nvenc'], overrides: {} })).toEqual([
      { video: 'ffmpeg', encoder: 'libx264' }
    ])
  })
  it('GIFs always use raw frames', () => {
    expect(exportRoutes({ ...settings, format: 'gif' }, noGpu)).toEqual([{ video: 'ffmpeg', encoder: 'libx264' }])
  })
  it('honours the test overrides', () => {
    expect(exportRoutes(settings, { hardwareEncoders: [], overrides: { videoEncoder: 'ffmpeg' } })).toEqual([{ video: 'ffmpeg', encoder: 'libx264' }])
    expect(exportRoutes({ ...settings, encoder: 'software' }, { hardwareEncoders: [], overrides: { videoEncoder: 'webcodecs-software' } })[0]).toEqual({
      video: 'webcodecs',
      hardware: false
    })
  })
  it('names routes for the UI', () => {
    expect(routeLabel({ video: 'webcodecs', hardware: true }, 'mp4')).toBe('GPU (WebCodecs)')
    expect(routeLabel({ video: 'ffmpeg', encoder: 'h264_nvenc' }, 'mp4')).toMatch(/NVENC/)
    expect(routeLabel({ video: 'ffmpeg', encoder: 'libx264' }, 'gif')).toMatch(/GIF/)
  })
})

describe('exportDimensions', () => {
  const project = createProject({
    id: 'p',
    name: 'p',
    duration: 10,
    width: 1918,
    height: 1080,
    hasWebcam: false,
    hasAudio: false,
    webcamOffset: 0,
    zooms: [],
    cursorValid: false,
    capture: { method: 'chromium', cursorInVideo: true, region: null }
  })
  it('gives standard 4K for a near-16:9 recording', () => {
    expect(exportDimensions(project, { ...settings, resolution: 2160 })).toEqual({ width: 3840, height: 2160, fps: 60 })
  })
  it('GIFs: real sizes (up to 1080p) at 15 fps', () => {
    expect(exportDimensions(project, { ...settings, format: 'gif', resolution: 720 })).toEqual({ width: 1280, height: 720, fps: 15 })
    expect(exportDimensions(project, { ...settings, format: 'gif', resolution: 2160 }).height).toBe(1080)
  })

  const shaped = (width: number, height: number): typeof project => ({ ...project, width, height })
  it('caps the long side of very wide or tall auto-aspect exports, keeping even sizes and the shape (audit-B-3)', () => {
    const cases: [number, number, ExportSettings['resolution']][] = [
      [1920, 200, 1080],
      [2400, 400, 1440],
      [300, 1300, 2160],
      [1920, 32, 720],
      [32, 1080, 2160],
      [5120, 2160, 2160]
    ]
    for (const [w, h, resolution] of cases) {
      for (const format of ['mp4', 'gif'] as const) {
        const s = exportSize(shaped(w, h), { ...settings, format, resolution })
        const full = outputSize('auto', w, h, format === 'gif' ? Math.min(resolution, 1080) : resolution)
        expect(s.capped).toBe(Math.max(full.width, full.height) > MAX_EXPORT_SIDE)
        if (!s.capped) {
          expect(s).toMatchObject(full)
          continue
        }
        expect(Math.max(s.width, s.height)).toBe(MAX_EXPORT_SIDE)
        expect(Math.min(s.width, s.height)).toBeGreaterThanOrEqual(2)
        expect(s.width % 2 + (s.height % 2)).toBe(0)
        // Same shape as the recording within rounding to even pixels.
        expect(Math.abs(s.width / s.height - w / h) / (w / h)).toBeLessThan(w > h ? 2.5 / s.height : 2.5 / s.width)
        // The main process accepts it (it used to answer 'Invalid export settings').
        expect(() => validateJob({ ...job, width: s.width, height: s.height, format })).not.toThrow()
      }
    }
    expect(exportSize(shaped(1920, 200), settings)).toEqual({ width: 4096, height: 426, fps: 60, capped: true })
    // Ultrawide at 4K stays on the GPU encoders' 4096 limit; as a GIF (1080p at most) it is not capped.
    expect(exportSize(shaped(5120, 2160), { ...settings, resolution: 2160 })).toMatchObject({ width: 4096, height: 1728 })
    expect(exportSize(shaped(5120, 2160), { ...settings, format: 'gif', resolution: 2160 })).toMatchObject({ width: 2560, height: 1080, capped: false })
    expect(exportSize(shaped(300, 1300), { ...settings, resolution: 2160 })).toMatchObject({ width: 946, height: 4096 })
  })

  it('leaves standard shapes and presets alone at every resolution', () => {
    for (const resolution of [720, 1080, 1440, 2160] as const) {
      for (const aspectRatio of ['auto', '16:9', '9:16', '1:1', '4:3'] as const) {
        const p = { ...project, style: { ...project.style, aspectRatio } }
        expect(exportSize(p, { ...settings, resolution }).capped).toBe(false)
      }
    }
    expect(exportSize(shaped(3440, 1440), { ...settings, resolution: 1440 })).toEqual({ width: 3440, height: 1440, fps: 60, capped: false })
  })

  it('capSize keeps sizes within the limit untouched', () => {
    expect(capSize({ width: 4096, height: 2160 })).toEqual({ width: 4096, height: 2160, capped: false })
    expect(capSize({ width: 9000, height: 2 })).toEqual({ width: 4096, height: 2, capped: true })
  })
})

describe('readable export errors (audit-B-3)', () => {
  it('names the size instead of "Invalid export settings"', () => {
    expect(() => validateJob({ ...job, width: 10368, height: 1080 })).toThrow(/export size 10368×1080 is not supported.*at most 8192/)
    expect(() => validateJob({ ...job, width: 1281 })).toThrow(/export size/)
  })
})

describe('avcLevel', () => {
  it('picks the lowest level that fits size and rate', () => {
    expect(avcLevel(1280, 720, 30)).toBe(0x1f)
    expect(avcLevel(1920, 1080, 30)).toBe(0x28)
    expect(avcLevel(1920, 1080, 60)).toBe(0x2a)
    expect(avcLevel(2560, 1440, 60)).toBe(0x33)
    expect(avcLevel(3840, 2160, 30)).toBe(0x33)
    expect(avcLevel(3840, 2160, 60)).toBe(0x34)
  })
  it('respects the per-side limit of each level for very wide frames', () => {
    // 256 macroblocks wide needs level 4 (sqrt(8 x 8192) = 256), however few macroblocks the frame has.
    expect(avcLevel(4096, 200, 30)).toBe(0x28)
    expect(avcLevel(4096, 426, 30)).toBe(0x28)
    expect(avcLevel(426, 4096, 60)).toBe(0x2a)
    expect(avcLevel(2704, 200, 30)).toBe(0x1f)
  })
})

describe('colorTagsFrom', () => {
  it("keeps the encoder's matrix and range but always tags sRGB-like primaries/transfer", () => {
    expect(colorTagsFrom({ matrix: 'smpte170m', fullRange: false })).toEqual({ primaries: 1, transfer: 1, matrix: 6, fullRange: false })
    expect(colorTagsFrom({ matrix: 'bt709', fullRange: true })).toEqual({ primaries: 1, transfer: 1, matrix: 1, fullRange: true })
  })
  it('leaves matrix and range alone when the encoder does not report them', () => {
    expect(colorTagsFrom(undefined)).toEqual({ primaries: 1, transfer: 1, matrix: null, fullRange: null })
    expect(colorTagsFrom({ matrix: 'something-new' })).toEqual({ primaries: 1, transfer: 1, matrix: null, fullRange: null })
  })
})
