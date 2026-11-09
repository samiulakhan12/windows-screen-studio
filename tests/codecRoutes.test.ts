import { afterEach, describe, expect, it } from 'vitest'
import type { Av1Encoder, HevcEncoder } from '../src/shared/api/export'
import { amfAv1Fits, codecRoutes, type CodecCaps } from '../src/shared/render/codecRoutes'
import { exportRoutes, routeLabel, type ExportRoute } from '../src/shared/render/exportPlan'
import type { ExportOptions } from '../src/shared/render/exportPresets'
import { CODEC_POLICY } from '../src/shared/render/proFormats'

/*
 * The routes of the wave 12 codecs (docs/design/output-and-languages.md §5.3; test 15 and the
 * av1_amf sizes of test 13).
 */

const HEVC_GPU: HevcEncoder[] = ['hevc_nvenc', 'hevc_qsv', 'hevc_amf', 'hevc_mf']
const AV1_GPU: Av1Encoder[] = ['av1_nvenc', 'av1_qsv', 'av1_amf']
const NO_CAPS: CodecCaps = { webcodecs: { hevc: false, av1: false }, gpu: { hevc: [], av1: [] }, overrides: {} }
const ALL_CAPS: CodecCaps = { webcodecs: { hevc: true, av1: true }, gpu: { hevc: HEVC_GPU, av1: AV1_GPU }, overrides: {} }
const HD = { width: 1920, height: 1080 }
const UHD = { width: 3840, height: 2160 }

const o = (x: Partial<ExportOptions>): ExportOptions => ({ format: 'mp4', resolution: 1080, fps: 60, quality: 'high', encoder: 'auto', ...x })
const ff = (encoder: string): ExportRoute => ({ video: 'ffmpeg', encoder }) as ExportRoute
const wc = (codec: 'hevc' | 'av1', hardware = true): ExportRoute => ({ video: 'webcodecs', codec, hardware })
const encoders = (routes: ExportRoute[]): string[] => routes.map((r) => (r.video === 'ffmpeg' ? r.encoder : r.video === 'webcodecs' ? `webcodecs-${r.codec}-${r.hardware ? 'gpu' : 'cpu'}` : 'none'))

const policy = { ...CODEC_POLICY }
afterEach(() => Object.assign(CODEC_POLICY, policy))

describe('codecRoutes (test 15)', () => {
  it('HEVC: WebCodecs on the GPU, then the probed GPU encoders in the order nvenc, qsv, amf, mf', () => {
    expect(codecRoutes(o({ codec: 'hevc' }), ALL_CAPS, HD)).toEqual([wc('hevc'), ff('hevc_nvenc'), ff('hevc_qsv'), ff('hevc_amf'), ff('hevc_mf')])
    // The probe's order does not matter: the routes keep §5.3's.
    const caps = { ...NO_CAPS, gpu: { hevc: ['hevc_mf', 'hevc_qsv'] as HevcEncoder[], av1: [] } }
    expect(codecRoutes(o({ codec: 'hevc' }), caps, HD)).toEqual([ff('hevc_qsv'), ff('hevc_mf')])
    expect(codecRoutes(o({ format: 'mov', codec: 'hevc' }), { ...NO_CAPS, webcodecs: { hevc: true, av1: false } }, HD)).toEqual([wc('hevc')])
  })

  it('HEVC with no GPU encoder gives no route, and Software gives none: never libx265 while the policy is off', () => {
    expect(codecRoutes(o({ codec: 'hevc' }), NO_CAPS, HD)).toEqual([])
    expect(codecRoutes(o({ codec: 'hevc', encoder: 'software' }), ALL_CAPS, HD)).toEqual([])
    // A capability list naming libx265 (it never does) changes nothing.
    const sneaky = { ...ALL_CAPS, gpu: { hevc: [...HEVC_GPU, 'libx265'] as HevcEncoder[], av1: AV1_GPU } }
    for (const encoder of ['auto', 'software'] as const)
      for (const caps of [NO_CAPS, ALL_CAPS, sneaky]) expect(encoders(codecRoutes(o({ codec: 'hevc', encoder }), caps, HD))).not.toContain('libx265')
  })

  it('with the HEVC software policy on (decision 1 (b)), libx265 comes last, and alone for Software', () => {
    CODEC_POLICY.hevcSoftware = true
    expect(codecRoutes(o({ codec: 'hevc' }), ALL_CAPS, HD)).toEqual([wc('hevc'), ...HEVC_GPU.map(ff), ff('libx265')])
    expect(codecRoutes(o({ codec: 'hevc', encoder: 'software' }), ALL_CAPS, HD)).toEqual([ff('libx265')])
    expect(codecRoutes(o({ codec: 'hevc' }), NO_CAPS, HD)).toEqual([ff('libx265')])
  })

  it('AV1: WebCodecs on the GPU, nvenc, qsv, amf where it does not pad, then libaom; Software is libaom', () => {
    expect(codecRoutes(o({ codec: 'av1' }), ALL_CAPS, UHD)).toEqual([wc('av1'), ff('av1_nvenc'), ff('av1_qsv'), ff('av1_amf'), ff('libaom-av1')])
    expect(codecRoutes(o({ codec: 'av1' }), ALL_CAPS, HD)).toEqual([wc('av1'), ff('av1_nvenc'), ff('av1_qsv'), ff('libaom-av1')])
    expect(codecRoutes(o({ codec: 'av1' }), NO_CAPS, HD)).toEqual([ff('libaom-av1')])
    expect(codecRoutes(o({ codec: 'av1', encoder: 'software' }), ALL_CAPS, UHD)).toEqual([ff('libaom-av1')])
    expect(codecRoutes(o({ format: 'webm', codec: 'av1' }), { ...NO_CAPS, webcodecs: { hevc: false, av1: true } }, HD)).toEqual([wc('av1'), ff('libaom-av1')])
  })

  it("the test overrides: 'webcodecs-software' puts WebCodecs' software AV1 first; 'ffmpeg' skips WebCodecs", () => {
    const soft = { ...ALL_CAPS, overrides: { videoEncoder: 'webcodecs-software' as const } }
    expect(codecRoutes(o({ codec: 'av1' }), soft, HD)).toEqual([wc('av1', false), ff('libaom-av1')])
    expect(codecRoutes(o({ codec: 'av1', encoder: 'software' }), soft, HD)).toEqual([wc('av1', false), ff('libaom-av1')])
    const ffmpegOnly = { ...ALL_CAPS, overrides: { videoEncoder: 'ffmpeg' as const } }
    expect(codecRoutes(o({ codec: 'av1' }), ffmpegOnly, UHD)).toEqual([ff('av1_nvenc'), ff('av1_qsv'), ff('av1_amf'), ff('libaom-av1')])
    expect(codecRoutes(o({ codec: 'hevc' }), ffmpegOnly, HD)).toEqual(HEVC_GPU.map(ff))
    // There is no software HEVC in WebCodecs: the override never adds one.
    expect(encoders(codecRoutes(o({ codec: 'hevc' }), soft, HD))).toEqual(HEVC_GPU)
  })

  it('transparent exports and the editing formats get raw-frame routes only', () => {
    expect(codecRoutes(o({ format: 'webm', alpha: 'background' }), ALL_CAPS, HD)).toEqual([ff('libvpx-vp9')])
    expect(codecRoutes(o({ format: 'mov', codec: 'cineform' }), ALL_CAPS, HD)).toEqual([ff('cfhd')])
    expect(codecRoutes(o({ format: 'mov', codec: 'cineform', alpha: 'overlays' }), ALL_CAPS, HD)).toEqual([ff('cfhd')])
    expect(codecRoutes(o({ format: 'mov', codec: 'animation', alpha: 'background' }), ALL_CAPS, HD)).toEqual([ff('qtrle')])
    for (const x of [o({ format: 'webm', alpha: 'background' }), o({ format: 'mov', codec: 'cineform', alpha: 'background' }), o({ format: 'mov', codec: 'animation', alpha: 'overlays' })])
      for (const r of codecRoutes(x, ALL_CAPS, HD)) expect(r.video).toBe('ffmpeg')
    // A codec that cannot carry alpha gets no route with it (validateJob refuses such a job too).
    expect(codecRoutes(o({ codec: 'hevc', alpha: 'background' }), ALL_CAPS, HD)).toEqual([])
    expect(codecRoutes(o({ format: 'webm', codec: 'av1', alpha: 'background' }), ALL_CAPS, HD)).toEqual([])
  })

  it('ProRes and a CineForm turned off by the policy have no route; ProRes is prores_ks with the policy on', () => {
    expect(codecRoutes(o({ format: 'mov', codec: 'prores-422' }), ALL_CAPS, HD)).toEqual([])
    expect(codecRoutes(o({ format: 'mov', codec: 'prores-4444', alpha: 'background' }), ALL_CAPS, HD)).toEqual([])
    CODEC_POLICY.prores = true
    expect(codecRoutes(o({ format: 'mov', codec: 'prores-422' }), ALL_CAPS, HD)).toEqual([ff('prores_ks')])
    expect(codecRoutes(o({ format: 'mov', codec: 'prores-4444', alpha: 'background' }), ALL_CAPS, HD)).toEqual([ff('prores_ks')])
    CODEC_POLICY.cineform = false
    expect(codecRoutes(o({ format: 'mov', codec: 'cineform' }), ALL_CAPS, HD)).toEqual([])
  })

  it('exportRoutes hands the new codecs to codecRoutes with the caps and size, and labels each route', () => {
    const caps = { hardwareEncoders: ['h264_nvenc' as const, 'libx264' as const], overrides: {} }
    expect(exportRoutes(o({ codec: 'av1' }), caps, ALL_CAPS, UHD)).toEqual(codecRoutes(o({ codec: 'av1' }), ALL_CAPS, UHD))
    // Without probed caps (none asked for yet): what needs no GPU.
    expect(exportRoutes(o({ codec: 'av1' }), caps)).toEqual([ff('libaom-av1')])
    expect(exportRoutes(o({ codec: 'hevc' }), caps)).toEqual([])
    expect(routeLabel(wc('hevc'), 'mp4')).toBe('GPU (WebCodecs HEVC)')
    expect(routeLabel(wc('av1', false), 'webm')).toBe('WebCodecs AV1 (software)')
    expect(routeLabel(ff('libaom-av1'), 'mp4')).toBe('Software (AV1)')
    expect(routeLabel(ff('cfhd'), 'mov')).toBe('Software (CineForm)')
    expect(routeLabel(ff('hevc_qsv'), 'mov')).toBe('GPU (Intel Quick Sync)')
  })
})

describe('av1_amf only where it does not pad (test 13)', () => {
  it('skips 1920×1080 and 1080×1350, uses 1280×720, 2560×1440 and 3840×2160', () => {
    expect(amfAv1Fits(1920, 1080)).toBe(false)
    expect(amfAv1Fits(1080, 1350)).toBe(false)
    expect(amfAv1Fits(1280, 720)).toBe(true)
    expect(amfAv1Fits(2560, 1440)).toBe(true)
    expect(amfAv1Fits(3840, 2160)).toBe(true)
    const amf = (size: { width: number; height: number }): boolean => encoders(codecRoutes(o({ codec: 'av1' }), ALL_CAPS, size)).includes('av1_amf')
    expect([{ width: 1920, height: 1080 }, { width: 1080, height: 1350 }].map(amf)).toEqual([false, false])
    expect([{ width: 1280, height: 720 }, { width: 2560, height: 1440 }, { width: 3840, height: 2160 }].map(amf)).toEqual([true, true, true])
  })
})
