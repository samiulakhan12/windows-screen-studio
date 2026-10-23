import { describe, expect, it } from 'vitest'
import type { ExportCapabilities } from '../src/shared/api/export'
import { createProject } from '../src/shared/engine/project'
import { avcLevel, colorTagsFrom } from '../src/shared/render/codec'
import { exportDimensions, exportRoutes, routeLabel } from '../src/shared/render/exportPlan'
import type { ExportSettings } from '../src/shared/types'

const settings: ExportSettings = { format: 'mp4', resolution: 1080, fps: 60, quality: 'high', encoder: 'auto' }
const noGpu: ExportCapabilities = { hardwareEncoders: [], overrides: {} }

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
