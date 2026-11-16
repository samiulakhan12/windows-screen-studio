import { readFileSync } from 'node:fs'
import path from 'node:path'
import { describe, expect, it } from 'vitest'
import { validateJob } from '../src/main/exportJob'
import type { ExportCapabilities, ExportJob } from '../src/shared/api/export'
import { outputSize } from '../src/shared/engine/layout'
import { createProject } from '../src/shared/engine/project'
import { avcLevel, colorTagsFrom } from '../src/shared/render/codec'
import { studioMetrics } from '../src/shared/captions/studioLayout'
import { studioPreset } from '../src/shared/captions/studioPresets'
import { DEFAULT_REFRAME, followApplies, isTall } from '../src/shared/engine/reframeData'
import { capSize, CINEFORM_MIN, cineformSizeWorks, exportDimensions, exportPreviewSize, exportRoutes, exportSize, MAX_EXPORT_SIDE, routeLabel } from '../src/shared/render/exportPlan'
import type { ExportSettings } from '../src/shared/types'

/**
 * FFmpeg's CineForm encoder with Flown's arguments over a grid of sizes: per width (a multiple of 16),
 * one character per height of `heights`: '1' both builds encoded 2 frames and both decoded both, 'e' a
 * build refused to encode, 'd' a file was made that a build could not decode. `refused`: widths that
 * are not a multiple of 16, refused by both builds at every height tried.
 */
interface CineformTable {
  heights: number[]
  opaque: Record<string, string>
  alpha: Record<string, string>
  refused: { widths: number[]; heights: number[] }
}

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
      { video: 'webcodecs', codec: 'h264', hardware: true },
      { video: 'ffmpeg', encoder: 'h264_nvenc' },
      { video: 'ffmpeg', encoder: 'h264_mf' },
      { video: 'ffmpeg', encoder: 'libx264' }
    ])
    expect(exportRoutes(settings, noGpu)).toEqual([
      { video: 'webcodecs', codec: 'h264', hardware: true },
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
      codec: 'h264',
      hardware: false
    })
  })
  it('names routes for the UI', () => {
    expect(routeLabel({ video: 'webcodecs', codec: 'h264', hardware: true }, 'mp4')).toBe('GPU (WebCodecs)')
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

  it('CineForm widths are a multiple of 16, which FFmpeg\'s cfhd needs (1080 wide fails); other codecs keep their sizes', () => {
    const cine = { ...settings, format: 'mov' as const, codec: 'cineform' as const }
    const shapedAs = (aspectRatio: '9:16' | '1:1' | '16:9'): typeof project => ({ ...project, style: { ...project.style, aspectRatio } })
    // The height grows with the width, so the frame keeps its shape (follow framing, the camera band
    // and the tall-frame rules decide as for the H.264 file).
    expect(exportSize(shapedAs('9:16'), cine)).toEqual({ width: 1088, height: 1934, fps: 60, capped: false })
    expect(exportSize(shapedAs('1:1'), cine)).toMatchObject({ width: 1088, height: 1088 })
    // 4:5 at 1080p sits on the tall line (1350 = 1.25 x 1080) and stays on it.
    expect(exportSize(project, { ...cine, aspect: '4:5', alpha: 'background' })).toMatchObject({ width: 1088, height: 1360 })
    expect(isTall(1088, 1360)).toBe(true)
    // 'auto' on a 3:2 laptop screen: 1620x1080 and 1080x720.
    expect(exportSize(shaped(1500, 1000), cine)).toMatchObject({ width: 1632, height: 1088 })
    expect(exportSize(shaped(1500, 1000), { ...cine, resolution: 720 })).toMatchObject({ width: 1088, height: 726 })
    // A width limit is kept (down to the multiple of 16 below it); the 4096 cap is one already.
    expect(exportSize(project, { ...cine, maxWidth: 1000 })).toMatchObject({ width: 992, height: 558 })
    expect(exportSize(shaped(5120, 2160), { ...cine, resolution: 2160 })).toMatchObject({ width: 4096, height: 1728, capped: true })
    // A frame half a pixel from the tall line stays on its side: 1082x1352 is not tall, and 1072x1340 would be.
    expect(exportSize(project, { ...settings, resolution: 1440, aspect: '4:5', maxWidth: 1082 })).toMatchObject({ width: 1082, height: 1352 })
    expect(exportSize(project, { ...cine, resolution: 1440, aspect: '4:5', maxWidth: 1082 })).toMatchObject({ width: 1072, height: 1338 })
    // Standard 16:9 sizes and every other codec are as before.
    expect(exportSize(shapedAs('16:9'), cine)).toMatchObject({ width: 1920, height: 1080 })
    expect(exportSize(shapedAs('9:16'), settings)).toMatchObject({ width: 1080, height: 1920 })
    expect(exportSize(shapedAs('9:16'), { ...cine, codec: 'animation' })).toMatchObject({ width: 1080, height: 1920 })
    expect(exportSize(shapedAs('9:16'), { ...cine, codec: undefined })).toMatchObject({ width: 1080, height: 1920 })
    for (const resolution of [720, 1080, 1440, 2160] as const)
      for (const aspect of ['auto', '16:9', '9:16', '1:1', '4:3', '4:5'] as const)
        for (const [w, h] of [[1918, 1080], [1500, 1000], [2580, 1080], [1000, 1300], [300, 1300], [1000, 1250], [1200, 1500], [1080, 1920], [1115, 1000], [1256, 2000], [1600, 1800]]) {
          const s = exportSize(shaped(w, h), { ...cine, resolution, aspect })
          expect(s.width % 16, `${w}x${h} ${aspect} ${resolution}p`).toBe(0)
          // Tall and following exactly when the H.264 file is, so follow framing, the camera band and captions lay out alike.
          const h264 = exportSize(shaped(w, h), { ...settings, resolution, aspect })
          expect(isTall(s.width, s.height), `tall ${w}x${h} ${aspect} ${resolution}p`).toBe(isTall(h264.width, h264.height))
          const follows = { reframe: { ...DEFAULT_REFRAME } }
          expect(followApplies(follows, s.width, s.height, w, h), `follow ${w}x${h} ${aspect} ${resolution}p`).toBe(followApplies(follows, h264.width, h264.height, w, h))
          expect(() => validateJob({ ...job, width: s.width, height: s.height, format: 'mov', codec: 'cineform', video: { kind: 'raw', encoder: 'cfhd', pixelFormat: 'bgr0' }, outputPath: '/tmp/x.mov' })).not.toThrow()
        }
  })

  const cine = { ...settings, format: 'mov' as const, codec: 'cineform' as const }
  const clear = { ...cine, alpha: 'background' as const }

  it('CineForm sizes FFmpeg encodes but cannot decode are not given: an odd multiple of 16 wide takes an even count of 8-row strips (opaque)', () => {
    // FFmpeg's cfhd made each of these (exit 0), and no decoder read a frame of it ("Invalid data").
    const undecodable: [number, number][] = [[720, 900], [3248, 2166], [1808, 1446], [2704, 2164]]
    for (const [w, h] of undecodable) {
      expect(cineformSizeWorks(w, h, false), `${w}x${h}`).toBe(false)
      expect(cineformSizeWorks(w, h, true), `${w}x${h} with alpha`).toBe(true)
    }
    const as45 = { ...cine, aspect: '4:5' as const }
    // 4:5 at 720p: 720x900 in H.264. 736 is a multiple of 32, and 920 = 1.25 x 736 keeps the frame tall.
    expect(exportSize(project, { ...as45, resolution: 720 })).toMatchObject({ width: 736, height: 920 })
    expect(exportSize(project, { ...as45, ...clear, resolution: 720 })).toMatchObject({ width: 720, height: 900 })
    // 'auto' at 2160p on a 3:2 screen (3240x2160 in H.264) and at 1440p and 2160p on a 5:4 one (1800x1440, 2700x2160).
    for (const [w, h] of [[3000, 2000], [2256, 1504]]) {
      expect(exportSize(shaped(w, h), { ...cine, resolution: 2160 }), `${w}x${h}`).toMatchObject({ width: 3232, height: 2154 })
      expect(exportSize(shaped(w, h), { ...clear, resolution: 2160 }), `${w}x${h}`).toMatchObject({ width: 3248, height: 2166 })
    }
    expect(exportSize(shaped(1280, 1024), { ...cine, resolution: 1440 })).toMatchObject({ width: 1792, height: 1434 })
    expect(exportSize(shaped(1280, 1024), { ...cine, resolution: 2160 })).toMatchObject({ width: 2688, height: 2150 })
    expect(exportSize(shaped(1280, 1024), { ...clear, resolution: 1440 })).toMatchObject({ width: 1808, height: 1446 })
  })

  it('every CineForm size of the sweep is one cfhd round-trips, within maxWidth and 4096, in the H.264 frame\'s shape and on its sides of the tall and follow lines', () => {
    const follows = { reframe: { ...DEFAULT_REFRAME } }
    const sides = (w: number, h: number, rw: number, rh: number): string => `${isTall(w, h)},${followApplies(follows, w, h, rw, rh)}`
    // Whether any frame CineForm takes within `max` columns lies on these sides (brute force, for the rare frames that do not).
    const anyKeeps = (want: string, max: number, alpha: boolean, rw: number, rh: number): boolean => {
      for (let w = 16; w <= max; w += 16) for (let h = CINEFORM_MIN.height; h <= MAX_EXPORT_SIDE; h += 2) if (cineformSizeWorks(w, h, alpha) && sides(w, h, rw, rh) === want) return true
      return false
    }
    const problems: string[] = []
    const thin: string[] = []
    const conflicts: string[] = []
    let checked = 0
    for (const rh of [1000, 777])
      for (let rw = 100; rw <= 4000; rw++) {
        const p = shaped(rw, rh)
        for (const aspect of ['auto', '16:9', '9:16', '1:1', '4:3', '4:5'] as const)
          for (const resolution of [720, 1080, 1440, 2160] as const)
            for (const maxWidth of [undefined, 64, 333, 720, 1082, 1250, 1920])
              for (const alpha of [false, true]) {
                const o = { ...settings, resolution, aspect, maxWidth }
                const h264 = exportSize(p, o)
                const s = exportSize(p, { ...o, format: 'mov', codec: 'cineform', ...(alpha ? { alpha: 'background' as const } : {}) })
                const at = `${rw}x${rh} ${aspect} ${resolution}p maxWidth ${maxWidth} ${alpha ? 'alpha' : 'opaque'}: ${h264.width}x${h264.height} -> ${s.width}x${s.height}`
                checked++
                if (!cineformSizeWorks(s.width, s.height, alpha) || s.width > (maxWidth ?? MAX_EXPORT_SIDE) || s.height > MAX_EXPORT_SIDE) problems.push(`size ${at}`)
                else if (cineformSizeWorks(h264.width, h264.height, alpha) && (s.width !== h264.width || s.height !== h264.height)) problems.push(`moved ${at}`)
                // Under 32 rows CineForm cannot keep the shape: the frame gets the rows it needs.
                else if (h264.height < CINEFORM_MIN.height) thin.push(at)
                else if (Math.abs(s.height - (h264.height * s.width) / h264.width) > 3) problems.push(`shape ${at}`)
                else if (sides(s.width, s.height, rw, rh) !== sides(h264.width, h264.height, rw, rh)) {
                  // Only where no frame within the limits is on both sides; the follow line is then kept.
                  const follow = followApplies(follows, s.width, s.height, rw, rh) === followApplies(follows, h264.width, h264.height, rw, rh)
                  if (!follow || anyKeeps(sides(h264.width, h264.height, rw, rh), Math.min(MAX_EXPORT_SIDE, maxWidth ?? MAX_EXPORT_SIDE), alpha, rw, rh)) problems.push(`sides ${at}`)
                  else conflicts.push(at)
                }
              }
      }
    expect(checked).toBe(2 * 3901 * 6 * 4 * 7 * 2)
    expect(problems.slice(0, 20)).toEqual([])
    // The frames no CineForm size can match: 4:5 a pixel under the tall line (1082x1352, 1250x1562) and
    // following a recording about 0.89 times as wide as tall by a hair, with no even height between the
    // lines under 1282 columns. They stay following, and become tall as 4:5 frames are.
    expect(conflicts.length).toBeLessThanOrEqual(16)
    for (const c of conflicts) expect(c).toMatch(/ 4:5 \d+p maxWidth (1082|1250) .*: (1082x1352 -> 1072x1340|1250x1562 -> 1248x1560)$/)
    // Under 32 rows only with the smallest width a preset can set.
    expect(thin.length).toBeGreaterThan(0)
    for (const t of thin) expect(t).toMatch(/ maxWidth 64 .*x32$/)
  }, 120_000)

  it('every measured CineForm size agrees with cineformSizeWorks (tests/fixtures/cineformSizes.json)', () => {
    const table = JSON.parse(readFileSync(path.join(__dirname, 'fixtures', 'cineformSizes.json'), 'utf8')) as CineformTable
    // The grid: every even height residue mod 64 among small heights and among large ones, every
    // multiple of 16 up to 256, and the widths of 4:5 at 720p and 'auto' at 1440p and 2160p before and after the rule.
    for (const band of [table.heights.filter((h) => h <= 130), table.heights.filter((h) => h >= 1024)]) expect(new Set(band.map((h) => h % 64)).size).toBe(32)
    for (const kind of ['opaque', 'alpha'] as const) {
      const widths = Object.keys(table[kind]).map(Number)
      for (let w = 16; w <= 256; w += 16) expect(widths).toContain(w)
      for (const w of [720, 736, 1792, 1808, 2688, 2704, 3232, 3248, 3840, 4096]) expect(widths).toContain(w)
    }
    let pairs = 0
    for (const kind of ['opaque', 'alpha'] as const) {
      for (const [w, row] of Object.entries(table[kind])) {
        expect(row).toHaveLength(table.heights.length)
        row.split('').forEach((c, i) => {
          expect(cineformSizeWorks(Number(w), table.heights[i], kind === 'alpha'), `${kind} ${w}x${table.heights[i]}: ${c}`).toBe(c === '1')
          pairs++
        })
      }
      for (const w of table.refused.widths) for (const h of table.refused.heights) expect(cineformSizeWorks(w, h, kind === 'alpha'), `${kind} ${w}x${h}`).toBe(false)
      pairs += table.refused.widths.length * table.refused.heights.length
    }
    expect(pairs).toBeGreaterThan(40000)
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

describe("the export dialog's picture", () => {
  // ExportDialog's box for its frame picture.
  const box = { width: 236, height: 236 }

  it('of a 4:5 export is tall at every display scale, so Bold Pop is sized and wrapped as in the file', () => {
    const look = studioPreset('bold-pop')!.look
    const out = { width: 1080, height: 1350 }
    const file = studioMetrics(look, out.width, out.height)
    expect(file.tall).toBe(true)
    for (const dpr of [1, 1.25, 1.5, 1.75, 2]) {
      const { css, pixels } = exportPreviewSize(out, box, dpr)
      expect(css).toEqual({ width: 189, height: 236 })
      const m = studioMetrics(look, pixels.width, pixels.height)
      expect(m.tall, `at ${dpr}: ${pixels.width}x${pixels.height}`).toBe(true)
      expect(m.px / pixels.width).toBeCloseTo(file.px / out.width, 3)
      expect(m.maxChars).toBe(file.maxChars)
    }
  })

  it('is tall or wide as its export, in its shape, for every size, box and display scale', () => {
    let checked = 0
    for (const out of [{ width: 1080, height: 1350 }, { width: 864, height: 1080 }, { width: 1080, height: 1920 }, { width: 1920, height: 1080 }, { width: 1080, height: 1080 }, { width: 1000, height: 1249 }, { width: 1000, height: 1250 }, { width: 2, height: 2 }]) {
      for (const dpr of [1, 1.1, 1.25, 1.5, 1.75, 2, 3]) {
        for (let side = 40; side <= 600; side += 13) {
          for (const b of [box, { width: side, height: side }, { width: side, height: 236 }, { width: 236, height: side }]) {
            const { css, pixels } = exportPreviewSize(out, b, dpr)
            expect(isTall(pixels.width, pixels.height), `${out.width}x${out.height} in ${b.width}x${b.height} at ${dpr}`).toBe(isTall(out.width, out.height))
            expect(pixels.width).toBe(Math.max(2, Math.round(css.width * dpr)))
            // The height moves only toward the export's side of the line, by at most the pixels rounding cost.
            const move = pixels.height - Math.max(2, Math.round(css.height * dpr))
            expect(isTall(out.width, out.height) ? move : -move).toBeGreaterThanOrEqual(0)
            expect(Math.abs(move)).toBeLessThanOrEqual(2)
            expect(Math.abs((pixels.height / pixels.width) * (out.width / out.height) - 1)).toBeLessThan(0.04)
            checked++
          }
        }
      }
    }
    expect(checked).toBeGreaterThan(1000)
  })
})
