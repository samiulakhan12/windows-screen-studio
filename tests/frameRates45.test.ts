import { describe, expect, it } from 'vitest'
import { AUDIO_RATE } from '../src/shared/render/audioPlan'
import { createProject } from '../src/shared/engine/project'
import { outputSize } from '../src/shared/engine/layout'
import { DEFAULT_REFRAME, isTall } from '../src/shared/engine/reframeData'
import { exportProject, exportSize } from '../src/shared/render/exportPlan'
import { aspectFileLabel, type ExportOptions } from '../src/shared/render/exportPresets'
import { blurSamplesFor, encodeSecondsEstimate, estimateBytes, EXPORT_FPS, MB_PER_MINUTE_1080P60, rateFps } from '../src/shared/render/proFormats'
import { COMMON_SAFE, textArea } from '../src/shared/render/safeZones'
import { targetBitrate } from '../src/main/exportArgs'
import type { Project } from '../src/shared/types'

/*
 * Frame rates, 4:5, and the size and time estimates of part P1 (docs/design/output-and-languages.md
 * §5.6, §5.8, §5.10; tests 19, 20 and the estimates of 22).
 */

describe('frame rates (test 19)', () => {
  it('rateFps is the rate itself up to 60 fps and 60 + (fps − 60) / 2 above', () => {
    expect(rateFps(24)).toBe(24)
    expect(rateFps(25)).toBe(25)
    expect(rateFps(30)).toBe(30)
    expect(rateFps(60)).toBe(60)
    expect(rateFps(120)).toBe(90)
    // Every rate of before gives itself, so their bit rates do not change.
    for (const fps of [15, 30, 60]) expect(rateFps(fps)).toBe(fps)
  })

  it('blurSamplesFor: 10 sub-frames up to 60 fps, 5 at 120 (the same sub-frames a second)', () => {
    expect(blurSamplesFor(60)).toBe(10)
    expect(blurSamplesFor(30)).toBe(10)
    expect(blurSamplesFor(24)).toBe(10)
    expect(blurSamplesFor(25)).toBe(10)
    expect(blurSamplesFor(120)).toBe(5)
    expect(blurSamplesFor(120) * 120).toBe(blurSamplesFor(60) * 60)
  })

  it('every export rate has a whole number of 48 kHz samples per frame', () => {
    expect(EXPORT_FPS).toEqual([24, 25, 30, 60, 120])
    expect(EXPORT_FPS.map((fps) => AUDIO_RATE / fps)).toEqual([2000, 1920, 1600, 800, 400])
    for (const fps of EXPORT_FPS) expect(Number.isInteger(AUDIO_RATE / fps)).toBe(true)
  })

  it('bit rates of rate-driven encoders scale with rateFps: 120 fps asks for 1.5 × 60 fps, the rates of before as they were', () => {
    const job = { width: 1920, height: 1080, quality: 'high' as const }
    expect(targetBitrate({ ...job, fps: 60 })).toBe(Math.round(1920 * 1080 * 60 * 0.12))
    expect(targetBitrate({ ...job, fps: 30 })).toBe(Math.round(1920 * 1080 * 30 * 0.12))
    expect(targetBitrate({ ...job, fps: 120 })).toBe(Math.round(1920 * 1080 * 90 * 0.12))
  })
})

/** A 1920×1080 recording of 30 s, its captions on, with `extra`. */
function project(extra: Partial<Project> = {}): Project {
  const p = createProject({
    id: 'p',
    name: 'p',
    duration: 30,
    width: 1920,
    height: 1080,
    hasWebcam: false,
    hasAudio: true,
    webcamOffset: 0,
    zooms: [],
    cursorValid: false,
    capture: { method: 'native', cursorInVideo: false, region: null, target: 'screen' }
  })
  return { ...p, ...extra }
}

const options = (o: Partial<ExportOptions> = {}): ExportOptions => ({ format: 'mp4', resolution: 1080, fps: 30, quality: 'high', encoder: 'auto', ...o })

describe('4:5 (test 20)', () => {
  it('outputSize gives 720×900, 1080×1350, 1440×1800 and 2160×2700, each tall', () => {
    expect([720, 1080, 1440, 2160].map((h) => outputSize('4:5', 1920, 1080, h))).toEqual([
      { width: 720, height: 900 },
      { width: 1080, height: 1350 },
      { width: 1440, height: 1800 },
      { width: 2160, height: 2700 }
    ])
    for (const h of [720, 1080, 1440, 2160]) {
      const s = outputSize('4:5', 1920, 1080, h)
      expect(isTall(s.width, s.height)).toBe(true)
    }
    expect(exportSize(project(), options({ aspect: '4:5' }))).toMatchObject({ width: 1080, height: 1350, fps: 30, capped: false })
  })

  it('the batch file label is 4x5', () => {
    expect(aspectFileLabel('4:5')).toBe('4x5')
  })

  it('exportProject applies 4:5 to the copy only, with the app safe zones off, so captions take the whole frame', () => {
    const p = project({ reframe: { ...DEFAULT_REFRAME, mode: 'fit', appSafe: true } })
    const copy = exportProject(p, { aspect: '4:5' })
    expect(copy).not.toBe(p)
    expect(copy.style.aspectRatio).toBe('4:5')
    expect(copy.reframe?.appSafe).toBe(false)
    expect(p.style.aspectRatio).toBe('auto')
    expect(p.reframe?.appSafe).toBe(true)
    // textArea is unchanged: the 4:5 copy gets today's full-frame placement, not COMMON_SAFE.
    expect(textArea(copy, 1080, 1350, 1920, 1080, 1)).toBeNull()
    // The project's own settings at 4:5 would have confined the text to COMMON_SAFE.
    const asProject = { ...p, style: { ...p.style, aspectRatio: '4:5' as const } }
    expect(textArea(asProject, 1080, 1350, 1920, 1080, 1)).toEqual({ x: COMMON_SAFE.x * 1080, y: COMMON_SAFE.y * 1350, w: COMMON_SAFE.w * 1080, h: COMMON_SAFE.h * 1350 })
  })

  it('a 9:16 copy keeps the app safe zones', () => {
    const p = project({ reframe: { ...DEFAULT_REFRAME, mode: 'fit', appSafe: true } })
    const copy = exportProject(p, { aspect: '9:16' })
    expect(copy.reframe?.appSafe).toBe(true)
    expect(textArea(copy, 1080, 1920, 1920, 1080, 1)).toEqual({ x: COMMON_SAFE.x * 1080, y: COMMON_SAFE.y * 1920, w: COMMON_SAFE.w * 1080, h: COMMON_SAFE.h * 1920 })
  })
})

describe('sizes and times (test 22)', () => {
  const at1080p60 = { width: 1920, height: 1080 }
  const at2160p30 = { width: 3840, height: 2160 }
  const minute = 60
  const mov = (o: Partial<ExportOptions>): ExportOptions => options({ format: 'mov', fps: 60, ...o })

  it('estimateBytes: an editing format’s MB a minute at 1080p60, scaled by pixels and rateFps', () => {
    expect(estimateBytes(mov({ codec: 'cineform' }), at1080p60, minute)).toBe(1500e6)
    expect(estimateBytes(mov({ codec: 'cineform', alpha: 'background' }), at1080p60, minute)).toBe(3600e6)
    expect(estimateBytes(mov({ codec: 'animation' }), at1080p60, minute)).toBe(2500e6)
    expect(estimateBytes(mov({ codec: 'prores-422' }), at1080p60, minute)).toBe(3300e6)
    expect(estimateBytes(mov({ codec: 'prores-4444' }), at1080p60, minute)).toBe(5000e6)
    // 2160p30: four times the pixels at half the rate.
    expect(estimateBytes(mov({ codec: 'cineform', fps: 30 }), at2160p30, minute)).toBe(3000e6)
    expect(estimateBytes(mov({ codec: 'animation', fps: 30 }), at2160p30, minute)).toBe(5000e6)
    expect(estimateBytes(mov({ codec: 'prores-4444', fps: 30, alpha: 'overlays' }), at2160p30, minute)).toBe(10000e6)
    // 120 fps counts as 90 (rateFps), half a minute as half.
    expect(estimateBytes(mov({ codec: 'cineform', fps: 120 }), at1080p60, 30)).toBe(1125e6)
  })

  it('estimateBytes: the WAV format and each stem at 23.04 MB a minute; nothing for what its encoder sizes', () => {
    expect(MB_PER_MINUTE_1080P60.stem).toBe((48000 * 2 * 4 * 60) / 1e6)
    expect(estimateBytes(options({ format: 'wav' }), { width: 0, height: 0 }, minute)).toBe(23.04e6)
    expect(estimateBytes(options(), at1080p60, minute, 4)).toBe(4 * 23.04e6)
    expect(estimateBytes(mov({ codec: 'cineform' }), at1080p60, minute, 2)).toBe(1500e6 + 2 * 23.04e6)
    for (const o of [options(), options({ codec: 'hevc' }), options({ codec: 'av1' }), options({ format: 'webm' }), options({ format: 'webm', alpha: 'background' }), options({ format: 'gif' }), options({ format: 'm4a' })])
      expect(estimateBytes(o, at1080p60, minute)).toBe(0)
  })

  it('encodeSecondsEstimate: AV1 on the processor takes about 4.5 s per second at 1080p60, 0 for other codecs', () => {
    expect(encodeSecondsEstimate(options({ codec: 'av1', fps: 60 }), at1080p60, 10)).toBeCloseTo(45, 6)
    expect(encodeSecondsEstimate(options({ format: 'webm', codec: 'av1', fps: 60 }), at1080p60, 10)).toBeCloseTo(45, 6)
    expect(encodeSecondsEstimate(options({ codec: 'av1', fps: 30 }), { width: 1280, height: 720 }, 60)).toBeCloseTo(60 * 4.5 * (1280 * 720) / (1920 * 1080) / 2, 6)
    expect(encodeSecondsEstimate(options({ codec: 'av1', fps: 120 }), at1080p60, 10)).toBeCloseTo(45 * 1.5, 6)
    expect(encodeSecondsEstimate(options(), at1080p60, 10)).toBe(0)
    expect(encodeSecondsEstimate(options({ codec: 'hevc' }), at1080p60, 10)).toBe(0)
  })
})
