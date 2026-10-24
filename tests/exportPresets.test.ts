import { describe, expect, it } from 'vitest'
import type { ExportCapabilities } from '../src/shared/api/export'
import { createProject } from '../src/shared/engine/project'
import { ivfFileHeader, ivfFrameHeader, vp9Codec, vp9Level, vp9MetadataFilter } from '../src/shared/render/codec'
import { exportProject, exportRoutes, exportSize, MB, routeLabel, sizeError, targetBitrates } from '../src/shared/render/exportPlan'
import {
  applyPreset,
  batchFileNames,
  batchItems,
  DEFAULT_EXPORT_OPTIONS,
  EXPORT_PRESETS,
  matchesPreset,
  normalizeOptions,
  presetById,
  safeFileName,
  tweakOptions,
  type ExportOptions
} from '../src/shared/render/exportPresets'
import { projectMediaUrl } from '../src/shared/render/mediaUrl'

describe('projectMediaUrl (cursor assets for the export)', () => {
  it("points at another file of the screen proxy's project", () => {
    expect(projectMediaUrl('studio-media://project/rec%201/screen.mp4?v=12', 'my cursor.png')).toBe('studio-media://project/rec%201/my%20cursor.png?v=12')
  })
})

const project = createProject({
  id: 'p',
  name: 'Demo',
  duration: 10,
  width: 1920,
  height: 1080,
  hasWebcam: false,
  hasAudio: true,
  webcamOffset: 0,
  zooms: [],
  cursorValid: false,
  capture: { method: 'chromium', cursorInVideo: true, region: null }
})
const preset = (id: string) => presetById(id)!
const noGpu: Pick<ExportCapabilities, 'hardwareEncoders' | 'overrides'> = { hardwareEncoders: [], overrides: {} }

describe('destination presets', () => {
  it('every preset has a unique id and a label usable in a file name', () => {
    expect(new Set(EXPORT_PRESETS.map((p) => p.id)).size).toBe(EXPORT_PRESETS.length)
    for (const p of EXPORT_PRESETS) expect(safeFileName(p.label)).toBe(p.label)
  })

  it('Instagram Reels: 1080x1920 MP4 at 30 fps, aspect only for the export', () => {
    const o = applyPreset(DEFAULT_EXPORT_OPTIONS, preset('reels'))
    expect(o).toMatchObject({ format: 'mp4', resolution: 1080, fps: 30, aspect: '9:16', preset: 'reels' })
    expect(exportSize(project, o)).toEqual({ width: 1080, height: 1920, fps: 30, capped: false })
    // The project keeps its own aspect; the export draws a copy.
    const drawn = exportProject(project, o)
    expect(drawn.style.aspectRatio).toBe('9:16')
    expect(project.style.aspectRatio).toBe('auto')
    expect(drawn).not.toBe(project)
    expect(exportProject(project, { aspect: undefined })).toBe(project)
  })

  it('sizes every destination right for a 16:9 recording', () => {
    const sizes = Object.fromEntries(EXPORT_PRESETS.map((p) => [p.id, exportSize(project, applyPreset(DEFAULT_EXPORT_OPTIONS, p))]))
    expect(sizes['youtube-1080']).toMatchObject({ width: 1920, height: 1080, fps: 60 })
    expect(sizes['youtube-4k']).toMatchObject({ width: 3840, height: 2160, fps: 60 })
    expect(sizes.x).toMatchObject({ width: 1920, height: 1080 })
    expect(sizes.tiktok).toMatchObject({ width: 1080, height: 1920 })
    expect(sizes.shorts).toMatchObject({ width: 1080, height: 1920, fps: 60 })
    expect(sizes.square).toMatchObject({ width: 1080, height: 1080 })
    // Slack: 720 px wide, 15 fps GIF.
    expect(sizes['slack-gif']).toMatchObject({ width: 720, height: 406, fps: 15 })
    expect(sizes.email).toMatchObject({ width: 1280, height: 720, fps: 30 })
  })

  it('keeps the user encoder, sets targets only where the preset has one', () => {
    const base: ExportOptions = { ...DEFAULT_EXPORT_OPTIONS, encoder: 'software', targetSizeMB: 99, aspect: '4:3' }
    const yt = applyPreset(base, preset('youtube-1080'))
    expect(yt.encoder).toBe('software')
    expect(yt.targetSizeMB).toBeUndefined()
    expect(yt.aspect).toBe('16:9')
    expect(applyPreset(base, preset('email'))).toMatchObject({ targetSizeMB: 25, resolution: 720 })
    expect(applyPreset(base, preset('email')).aspect).toBeUndefined()
    expect(applyPreset(base, preset('slack-gif'))).toMatchObject({ format: 'gif', maxWidth: 720, targetSizeMB: 15 })
  })

  it('a tweak makes the settings Custom; an unchanged value keeps the preset', () => {
    const reels = applyPreset(DEFAULT_EXPORT_OPTIONS, preset('reels'))
    expect(matchesPreset(reels, preset('reels'))).toBe(true)
    expect(tweakOptions(reels, { encoder: 'software' }).preset).toBe('reels')
    expect(tweakOptions(reels, { fps: 30 }).preset).toBe('reels')
    const tweaked = tweakOptions(reels, { fps: 60 })
    expect(tweaked.preset).toBeUndefined()
    expect(tweaked.aspect).toBe('9:16')
    // Clearing a field removes it (no undefined values in stored settings).
    expect('aspect' in tweakOptions(reels, { aspect: undefined })).toBe(false)
  })

  it('reads remembered settings defensively', () => {
    expect(normalizeOptions(null)).toEqual(DEFAULT_EXPORT_OPTIONS)
    expect(normalizeOptions({ format: 'avi', resolution: 999, fps: 24, targetSizeMB: -5, aspect: '2:1', preset: 'nope' })).toEqual(DEFAULT_EXPORT_OPTIONS)
    const reels = applyPreset(DEFAULT_EXPORT_OPTIONS, preset('reels'))
    expect(normalizeOptions(JSON.parse(JSON.stringify(reels)))).toEqual(reels)
    expect(normalizeOptions({ format: 'webm', targetSizeMB: 10 })).toMatchObject({ format: 'webm', targetSizeMB: 10 })
  })
})

describe('batch export naming', () => {
  it('names files "<name> - <preset>.<ext>" in gallery order, then aspect variants', () => {
    const items = batchItems(['reels', 'youtube-1080', 'slack-gif'], ['1:1', '9:16'], { ...DEFAULT_EXPORT_OPTIONS, encoder: 'software' })
    expect(items.map((i) => i.key)).toEqual(['youtube-1080', 'reels', 'slack-gif', 'aspect:9:16', 'aspect:1:1'])
    expect(items.every((i) => i.options.encoder === 'software')).toBe(true)
    expect(items[3].options).toMatchObject({ aspect: '9:16', resolution: 1080, format: 'mp4' })
    expect(batchFileNames('Demo: take 2?', items)).toEqual([
      'Demo- take 2- - YouTube 1080p60.mp4',
      'Demo- take 2- - Instagram Reels.mp4',
      'Demo- take 2- - Slack GIF.gif',
      'Demo- take 2- - 1080p 9x16.mp4',
      'Demo- take 2- - 1080p 1x1.mp4'
    ])
  })
  it('never gives two files of a batch the same name (case-insensitive)', () => {
    const o = DEFAULT_EXPORT_OPTIONS
    expect(batchFileNames('a', [{ fileLabel: 'X', options: o }, { fileLabel: 'x', options: o }, { fileLabel: 'X', options: { ...o, format: 'gif' } }])).toEqual([
      'a - X.mp4',
      'a - x 2.mp4',
      'a - X.gif'
    ])
  })
  it('makes Windows-safe names', () => {
    expect(safeFileName('  a/b\\c:d*e?f"g<h>i|j. ')).toBe('a-b-c-d-e-f-g-h-i-j')
    expect(safeFileName('...')).toBe('Recording')
    expect(safeFileName('CON')).toBe('CON-')
  })
})

describe('target file size', () => {
  const base = { seconds: 60, hasAudio: true, format: 'mp4' as const, width: 1280, height: 720, fps: 30 }
  it('splits the budget between audio and video and keeps a small margin', () => {
    const r = targetBitrates({ ...base, targetMB: 25 })
    const bytes = ((r.video + r.audio) * 60) / 8
    expect(bytes).toBeLessThan(25 * MB)
    expect(bytes).toBeGreaterThan(0.93 * 25 * MB)
    expect(r.audio).toBe(160_000)
    expect(r.feasible).toBe(true)
    expect(r.bpp).toBeCloseTo(r.video / (1280 * 720 * 30), 6)
  })
  it('gives the audio less when the budget is tight and Opus a little less than AAC', () => {
    expect(targetBitrates({ ...base, targetMB: 6 }).audio).toBe(96_000)
    expect(targetBitrates({ ...base, targetMB: 100, format: 'webm' }).audio).toBe(128_000)
    expect(targetBitrates({ ...base, targetMB: 25, hasAudio: false }).audio).toBe(0)
  })
  it('flags targets too small for any video', () => {
    const r = targetBitrates({ ...base, targetMB: 0.5 })
    expect(r.feasible).toBe(false)
    expect(r.video).toBe(100_000)
  })
  it('audio-only exports spend everything on the audio (32-320 kbit/s)', () => {
    expect(targetBitrates({ ...base, format: 'm4a', targetMB: 1 })).toMatchObject({ video: 0, audio: 127_200 })
    expect(targetBitrates({ ...base, format: 'm4a', targetMB: 100 }).audio).toBe(320_000)
  })
  it('measures how far a file is from its target', () => {
    expect(sizeError(26.25 * MB, 25)).toBeCloseTo(0.05)
    expect(sizeError(20 * MB, 25)).toBeCloseTo(-0.2)
  })
})

describe('routes for the new formats', () => {
  it('WebM: WebCodecs VP9 on the GPU, then in software, then libvpx (two passes for a size target)', () => {
    expect(exportRoutes({ format: 'webm', encoder: 'auto' }, { hardwareEncoders: ['h264_nvenc'], overrides: {} })).toEqual([
      { video: 'webcodecs', codec: 'vp9', hardware: true },
      { video: 'webcodecs', codec: 'vp9', hardware: false },
      { video: 'ffmpeg', encoder: 'libvpx-vp9' }
    ])
    expect(exportRoutes({ format: 'webm', encoder: 'auto', targetSizeMB: 10 }, noGpu)).toEqual([
      { video: 'webcodecs', codec: 'vp9', hardware: true },
      { video: 'ffmpeg', encoder: 'libvpx-vp9' }
    ])
    expect(exportRoutes({ format: 'webm', encoder: 'software' }, noGpu)).toEqual([{ video: 'ffmpeg', encoder: 'libvpx-vp9' }])
    expect(exportRoutes({ format: 'webm', encoder: 'auto' }, { hardwareEncoders: [], overrides: { videoEncoder: 'webcodecs-software' } })[0]).toEqual({
      video: 'webcodecs',
      codec: 'vp9',
      hardware: false
    })
  })
  it('MOV uses the H.264 chain; M4A renders nothing', () => {
    expect(exportRoutes({ format: 'mov', encoder: 'auto' }, { hardwareEncoders: ['h264_qsv'], overrides: {} })).toEqual([
      { video: 'webcodecs', codec: 'h264', hardware: true },
      { video: 'ffmpeg', encoder: 'h264_qsv' },
      { video: 'ffmpeg', encoder: 'libx264' }
    ])
    expect(exportRoutes({ format: 'm4a', encoder: 'auto' }, noGpu)).toEqual([{ video: 'none' }])
  })
  it('names the routes', () => {
    expect(routeLabel({ video: 'webcodecs', codec: 'vp9', hardware: true }, 'webm')).toBe('GPU (WebCodecs VP9)')
    expect(routeLabel({ video: 'ffmpeg', encoder: 'libvpx-vp9' }, 'webm')).toBe('Software (VP9)')
    expect(routeLabel({ video: 'none' }, 'm4a')).toBe('Audio only (AAC)')
  })
})

describe('VP9 / IVF helpers', () => {
  it('writes the IVF file header ffmpeg expects (DKIF, VP90, size, 1/fps time base)', () => {
    const h = ivfFileHeader(1920, 1080, 60)
    const v = new DataView(h.buffer)
    expect(h.byteLength).toBe(32)
    expect(String.fromCharCode(...h.slice(0, 4))).toBe('DKIF')
    expect(v.getUint16(6, true)).toBe(32)
    expect(String.fromCharCode(...h.slice(8, 12))).toBe('VP90')
    expect([v.getUint16(12, true), v.getUint16(14, true), v.getUint32(16, true), v.getUint32(20, true)]).toEqual([1920, 1080, 60, 1])
    const f = new DataView(ivfFrameHeader(1234, 2 ** 32 + 5).buffer)
    expect([f.getUint32(0, true), f.getUint32(4, true), f.getUint32(8, true)]).toEqual([1234, 5, 1])
  })
  it('picks VP9 levels by size and rate', () => {
    expect(vp9Level(1280, 720, 30)).toBe(31)
    expect(vp9Level(1920, 1080, 30)).toBe(40)
    expect(vp9Level(1920, 1080, 60)).toBe(41)
    expect(vp9Level(3840, 2160, 60)).toBe(51)
    expect(vp9Codec(1080, 1920, 30)).toBe('vp09.00.40.08')
  })
  it('maps colour tags to the vp9_metadata filter', () => {
    expect(vp9MetadataFilter({ primaries: 1, transfer: 1, matrix: 6, fullRange: false })).toBe('vp9_metadata=color_space=smpte170:color_range=tv')
    expect(vp9MetadataFilter({ primaries: 1, transfer: 1, matrix: 1, fullRange: null })).toBe('vp9_metadata=color_space=bt709')
    expect(vp9MetadataFilter({ primaries: 1, transfer: 1, matrix: null, fullRange: null })).toBeNull()
  })
})
