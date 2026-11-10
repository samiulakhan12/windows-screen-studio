import { afterEach, describe, expect, it } from 'vitest'
import type { ExportJob, FfmpegVideoEncoder, RawPixelFormat } from '../src/shared/api/export'
import type { ExportCodec, ExportFormat } from '../src/shared/types'
import { EXPORT_COLOR, ffmpegPlan, isTwoPass, type FfmpegPlan, type PlanPaths } from '../src/main/exportArgs'
import { copyProArgs, proAudioArgs, proPlan, proVideoArgs } from '../src/main/proArgs'
import { probeArgs } from '../src/main/hwEncoders'
import { AV1_ENCODERS, HEVC_ENCODERS, probeCodecArgs } from '../src/main/codecProbe'
import { validateJob } from '../src/main/exportJob'
import { ALLOWED_ENCODERS, codecAllowed, CODEC_POLICY, FORMAT_CODECS, nearestCodec } from '../src/shared/render/proFormats'
import { t } from '../src/shared/i18n/t'

/*
 * ffmpeg arguments of the wave 12 codecs (docs/design/output-and-languages.md §5.4-5.7, §18.4):
 * tests 11, 12 (encodes), 13 (arguments), 14, 21, 23 and 81.
 */

const policy = { ...CODEC_POLICY }
afterEach(() => Object.assign(CODEC_POLICY, policy))

const words = (s: string): string[] => s.split(' ')
const after = (args: string[], flag: string): string => args[args.indexOf(flag) + 1]
const allAfter = (args: string[], flag: string): string[] => args.flatMap((a, i) => (a === flag ? [args[i + 1]] : []))

const COLOR = words('-color_primaries bt709 -color_trc bt709 -colorspace smpte170m -color_range tv')
const HEVC_TAIL = ['-bsf:v', 'hevc_metadata=colour_primaries=1:transfer_characteristics=1:matrix_coefficients=6:video_full_range_flag=0', ...COLOR, '-tag:v', 'hvc1']
const AV1_TAIL = ['-bsf:v', 'av1_metadata=color_primaries=1:transfer_characteristics=1:matrix_coefficients=6:color_range=tv', ...COLOR]
const QUALITIES = ['high', 'medium', 'small'] as const

function job(x: Partial<ExportJob> & { encoder?: FfmpegVideoEncoder; pixelFormat?: RawPixelFormat } = {}): ExportJob {
  const { encoder = 'hevc_nvenc', pixelFormat = 'yuv420p', ...rest } = x
  return {
    width: 1920,
    height: 1080,
    fps: 60,
    frames: 120,
    format: 'mp4',
    quality: 'high',
    codec: 'hevc',
    video: { kind: 'raw', encoder, pixelFormat },
    audio: { clips: [{ id: 'c', start: 0, end: 2, speed: 1 }], volume: 1 },
    outputPath: '/v/out.mp4',
    ...rest
  }
}
const paths: PlanPaths = { audioInput: '/p/screen.mp4', output: '/v/.out.partial.mp4', tempStem: '/tmp/ssw-1' }
const B = 4_000_000
const target = { bitrate: { video: B, audio: 128_000 } }
const VBV = ['-maxrate', String(1.5 * B), '-bufsize', String(2 * B)]

describe('HEVC arguments (test 11)', () => {
  it('each GPU encoder at Studio, Web and Small file gives §5.4’s settings, then hevc_metadata, the tags and hvc1, with -g = 2 × fps', () => {
    const want: Record<string, (q: number) => string> = {
      hevc_nvenc: (q) => `-c:v hevc_nvenc -preset p5 -tune hq -rc vbr -cq ${[22, 26, 30][q]} -b:v 0 -spatial-aq 1 -profile:v main -g 120`,
      hevc_qsv: (q) => `-c:v hevc_qsv -preset medium -global_quality ${[23, 27, 31][q]} -g 120`,
      hevc_amf: (q) => `-c:v hevc_amf -quality balanced -rc cqp -qp_i ${[20, 24, 28][q]} -qp_p ${[22, 26, 30][q]} -g 120`,
      // round(0.7 × the H.264 bit rate of the quality: 1920 × 1080 × 60 × 0.12, 0.07, 0.04).
      hevc_mf: (q) => `-c:v hevc_mf -hw_encoding 1 -b:v ${[10450944, 6096384, 3483648][q]} -g 120`
    }
    for (const encoder of ['hevc_nvenc', 'hevc_qsv', 'hevc_amf', 'hevc_mf'] as const)
      QUALITIES.forEach((quality, q) => expect(proVideoArgs(job({ encoder, quality }), encoder), `${encoder} ${quality}`).toEqual([...words(want[encoder](q)), ...HEVC_TAIL]))
  })

  it('a size target switches each to its bit rate with peaks up to 1.5 B over a 2 B buffer', () => {
    const want: Record<string, string[]> = {
      hevc_nvenc: [...words(`-c:v hevc_nvenc -preset p5 -tune hq -rc vbr -b:v ${B}`), ...VBV, ...words('-spatial-aq 1 -profile:v main -g 120')],
      hevc_qsv: [...words(`-c:v hevc_qsv -preset medium -b:v ${B}`), ...VBV, '-g', '120'],
      hevc_amf: [...words(`-c:v hevc_amf -quality balanced -rc vbr_peak -b:v ${B}`), ...VBV, '-g', '120'],
      hevc_mf: [...words(`-c:v hevc_mf -hw_encoding 1 -b:v ${B}`), ...VBV, '-g', '120']
    }
    for (const encoder of ['hevc_nvenc', 'hevc_qsv', 'hevc_amf', 'hevc_mf'] as const) {
      expect(proVideoArgs(job({ encoder, ...target }), encoder)).toEqual([...want[encoder], ...HEVC_TAIL])
      // One pass on the graphics card: no intermediate, no second pass.
      expect(isTwoPass(job({ encoder, ...target }))).toBe(false)
      expect(proPlan(job({ encoder, ...target }), paths).passes).toEqual([])
    }
  })

  it('-g follows the frame rate', () => {
    for (const fps of [24, 25, 30, 120]) expect(after(proVideoArgs(job({ fps }), 'hevc_nvenc'), '-g')).toBe(String(2 * fps))
  })

  it('raw frames are converted as H.264’s are (BT.601 limited), to NV12 for Quick Sync, AMF and Media Foundation', () => {
    const graph = (encoder: FfmpegVideoEncoder): string => after(proPlan(job({ encoder }), paths).capture, '-filter_complex').split(';')[0]
    expect(graph('hevc_nvenc')).toBe('[0:v]scale=out_color_matrix=bt601:out_range=tv,format=yuv420p[vout]')
    for (const e of ['hevc_qsv', 'hevc_amf', 'hevc_mf'] as const) expect(graph(e)).toBe('[0:v]scale=out_color_matrix=bt601:out_range=tv,format=nv12[vout]')
    const capture = proPlan(job(), paths).capture
    expect(capture.slice(5, 15)).toEqual(words('-f rawvideo -pix_fmt yuv420p -s 1920x1080 -framerate 60 -i pipe:0'))
    expect(capture.slice(capture.indexOf('-map'), capture.indexOf('-map') + 2)).toEqual(['-map', '[vout]'])
    // MP4 and MOV with HEVC: AAC and faststart as today.
    expect(after(capture, '-c:a')).toBe('aac')
    expect(after(capture, '-movflags')).toBe('+faststart+write_colr')
    expect(capture.at(-1)).toBe(paths.output)
    const mov = proPlan(job({ format: 'mov', outputPath: '/v/out.mov' }), paths).capture
    expect(after(mov, '-f')).toBe('rawvideo')
    expect(mov.slice(-5)).toEqual(['-movflags', '+faststart+write_colr', '-f', 'mov', paths.output])
    expect(after(mov, '-tag:v')).toBe('hvc1')
  })

  it('the WebCodecs route muxes an Annex B stream: -f hevc at the frame rate, -c:v copy, hevc_metadata and hvc1', () => {
    expect(copyProArgs('hevc')).toEqual(['-c:v', 'copy', ...HEVC_TAIL])
    const plan = proPlan(job({ video: { kind: 'hevc', color: EXPORT_COLOR } }), paths)
    const a = plan.capture
    expect(a.slice(5, 11)).toEqual(['-f', 'hevc', '-r', '60', '-i', 'pipe:0'])
    expect(a.slice(a.indexOf('-map'), a.indexOf('-map') + 2 + 2 + HEVC_TAIL.length)).toEqual(['-map', '0:v:0', '-c:v', 'copy', ...HEVC_TAIL])
    expect(a.join(' ')).not.toContain('[vout]')
    // The colours the encoder reported, as WebCodecs H.264 is tagged today; an unknown matrix is left as the stream has it.
    const reported = proPlan(job({ video: { kind: 'hevc', color: { primaries: 1, transfer: 1, matrix: 1, fullRange: false } } }), paths).capture
    expect(after(reported, '-bsf:v')).toBe('hevc_metadata=colour_primaries=1:transfer_characteristics=1:matrix_coefficients=1:video_full_range_flag=0')
    const unknown = proPlan(job({ video: { kind: 'hevc', color: { primaries: 1, transfer: 1, matrix: null, fullRange: null } } }), paths).capture
    expect(after(unknown, '-bsf:v')).toBe('hevc_metadata=colour_primaries=1:transfer_characteristics=1')
    expect(unknown).not.toContain('-colorspace')
  })
})

describe('hevc_mf runs on the graphics card only (test 12)', () => {
  it('carries -hw_encoding 1 in the probe and in every encode: each quality, a size target, the whole plan', () => {
    const hw = (args: string[]): boolean => args.join(' ').includes('-c:v hevc_mf -hw_encoding 1 ')
    expect(probeCodecArgs('hevc_mf').join(' ')).toContain('-c:v hevc_mf -hw_encoding 1 ')
    for (const quality of QUALITIES) expect(hw(proVideoArgs(job({ encoder: 'hevc_mf', quality }), 'hevc_mf'))).toBe(true)
    expect(hw(proVideoArgs(job({ encoder: 'hevc_mf', ...target }), 'hevc_mf'))).toBe(true)
    for (const format of ['mp4', 'mov'] as const) {
      const plan = proPlan(job({ encoder: 'hevc_mf', format, outputPath: `/v/out.${format}` }), paths)
      expect([plan.capture, ...plan.passes].filter((a) => a.includes('hevc_mf')).every(hw)).toBe(true)
    }
  })
})

describe('AV1 arguments (test 13)', () => {
  const av1 = (x: Partial<ExportJob> & { encoder?: FfmpegVideoEncoder } = {}): ExportJob => job({ codec: 'av1', encoder: 'libaom-av1', ...x })

  it('the four encoders at Studio, Web and Small file, then av1_metadata and the BT.601 tags', () => {
    const want: Record<string, (q: number) => string> = {
      av1_nvenc: (q) => `-c:v av1_nvenc -preset p5 -tune hq -rc vbr -cq ${[30, 34, 38][q]} -b:v 0 -spatial-aq 1 -g 120`,
      av1_qsv: (q) => `-c:v av1_qsv -preset medium -global_quality ${[30, 34, 38][q]} -g 120`,
      av1_amf: (q) => `-c:v av1_amf -quality balanced -rc cqp -qp_i ${[120, 136, 152][q]} -qp_p ${[128, 144, 160][q]} -g 120`,
      'libaom-av1': (q) => `-c:v libaom-av1 -usage good -cpu-used 6 -row-mt 1 -tiles 2x2 -crf ${[30, 34, 38][q]} -b:v 0 -g 120`
    }
    for (const encoder of AV1_ENCODERS.concat(['libaom-av1'] as const))
      QUALITIES.forEach((quality, q) => expect(proVideoArgs(av1({ encoder, quality }), encoder), `${encoder} ${quality}`).toEqual([...words(want[encoder](q)), ...AV1_TAIL]))
  })

  it('size targets: one pass with peaks on the graphics card, two passes for libaom', () => {
    expect(proVideoArgs(av1({ encoder: 'av1_nvenc', ...target }), 'av1_nvenc')).toEqual([...words(`-c:v av1_nvenc -preset p5 -tune hq -rc vbr -b:v ${B}`), ...VBV, ...words('-spatial-aq 1 -g 120'), ...AV1_TAIL])
    expect(proVideoArgs(av1({ encoder: 'av1_qsv', ...target }), 'av1_qsv')).toEqual([...words(`-c:v av1_qsv -preset medium -b:v ${B}`), ...VBV, '-g', '120', ...AV1_TAIL])
    expect(proVideoArgs(av1({ encoder: 'av1_amf', ...target }), 'av1_amf')).toEqual([...words(`-c:v av1_amf -quality balanced -rc vbr_peak -b:v ${B}`), ...VBV, '-g', '120', ...AV1_TAIL])
    expect(proVideoArgs(av1({ ...target }), 'libaom-av1')).toEqual([...words(`-c:v libaom-av1 -usage good -cpu-used 6 -row-mt 1 -tiles 2x2 -b:v ${B} -g 120`), ...AV1_TAIL])
  })

  it('WebM with AV1 carries Opus; the WebCodecs route reads IVF and copies', () => {
    const webm = proPlan(av1({ format: 'webm', outputPath: '/v/out.webm' }), paths).capture
    expect(after(webm, '-c:a')).toBe('libopus')
    expect(webm.slice(-3)).toEqual(['-f', 'webm', paths.output])
    expect(copyProArgs('av1')).toEqual(['-c:v', 'copy', ...AV1_TAIL])
    const ivf = proPlan(av1({ video: { kind: 'av1', color: EXPORT_COLOR } }), paths).capture
    expect(ivf.slice(5, 9)).toEqual(['-f', 'ivf', '-i', 'pipe:0'])
    expect(ivf.slice(ivf.indexOf('-map'), ivf.indexOf('-map') + 4 + AV1_TAIL.length)).toEqual(['-map', '0:v:0', '-c:v', 'copy', ...AV1_TAIL])
  })
})

describe('two passes (test 14)', () => {
  const twoPass = (j: ExportJob): FfmpegPlan => {
    expect(isTwoPass(j)).toBe(true)
    return proPlan(j, paths)
  }
  const check = (plan: FfmpegPlan, encoder: string): void => {
    const [pass1, pass2] = plan.passes
    // Over today's lossless intermediate: BT.601 limited 4:2:0, x264 at qp 0.
    expect(plan.capture.join(' ')).toContain('-vf scale=out_color_matrix=bt601:out_range=tv,format=yuv420p -c:v libx264 -preset ultrafast -qp 0 -f matroska /tmp/ssw-1.mkv')
    expect(after(pass1, '-i')).toBe('/tmp/ssw-1.mkv')
    expect(after(pass1, '-c:v')).toBe(encoder)
    expect(after(pass1, '-b:v')).toBe(String(B))
    expect(pass1.slice(-8)).toEqual(['-pass', '1', '-passlogfile', '/tmp/ssw-1.pass', '-an', '-f', 'null', '-'])
    expect(after(pass2, '-i')).toBe('/tmp/ssw-1.mkv')
    expect(after(pass2, '-c:v')).toBe(encoder)
    expect(pass2.join(' ')).toContain('-pass 2 -passlogfile /tmp/ssw-1.pass')
    expect(pass2.at(-1)).toBe(paths.output)
    expect(plan.temps).toEqual(expect.arrayContaining(['/tmp/ssw-1.mkv', '/tmp/ssw-1.pass-0.log']))
  }

  it('libaom with a size target: pass 1 to the null muxer, pass 2 with the log, the sound and av1_metadata', () => {
    const plan = twoPass(job({ codec: 'av1', encoder: 'libaom-av1', pixelFormat: 'rgba', ...target }))
    check(plan, 'libaom-av1')
    expect(plan.passes[1].join(' ')).toContain(AV1_TAIL.join(' '))
    expect(after(plan.passes[1], '-c:a')).toBe('aac')
    expect(plan.passes[1].join(' ')).not.toContain('-crf')
  })

  it('libx265 with the policy on, likewise; refused while it is off', () => {
    const j = job({ encoder: 'libx265', ...target })
    expect(isTwoPass(j)).toBe(false)
    expect(() => proPlan(j, paths)).toThrow(/Invalid export settings/)
    expect(() => validateJob(j)).toThrow(/Invalid export settings/)
    CODEC_POLICY.hevcSoftware = true
    const plan = twoPass(j)
    check(plan, 'libx265')
    expect(plan.passes[1].join(' ')).toContain(HEVC_TAIL.join(' '))
    // Without a size target, one pass at its constant rate factor.
    const crf = proPlan(job({ encoder: 'libx265' }), paths)
    expect(crf.passes).toEqual([])
    expect(crf.capture.join(' ')).toContain('-c:v libx265 -preset fast -crf 21 -g 120 -x265-params log-level=error')
  })

  it('a transparent job never runs two passes: size targets are off for alpha', () => {
    const j = job({ format: 'webm', codec: undefined, alpha: true, encoder: 'libvpx-vp9', pixelFormat: 'bgra', outputPath: '/v/o.webm', ...target })
    expect(isTwoPass(j)).toBe(false)
    const plan = proPlan(j, paths)
    expect(plan.passes).toEqual([])
    expect(after(plan.capture, '-deadline')).toBe('realtime')
    expect(plan.capture).not.toContain(String(B))
  })
})

describe('the editing formats (test 21)', () => {
  const mov = (x: Partial<ExportJob> & { encoder?: FfmpegVideoEncoder; pixelFormat?: RawPixelFormat }): ExportJob =>
    job({ format: 'mov', codec: 'cineform', encoder: 'cfhd', pixelFormat: 'bgr0', outputPath: '/v/out.mov', ...x })
  const graph = (j: ExportJob): string => after(proPlan(j, paths).capture, '-filter_complex').split(';')[0]

  it('CineForm: BT.709 10-bit 4:2:2, the quality’s level, 1-1-1 tags; with alpha 12-bit RGBA and no matrix', () => {
    const plan = proPlan(mov({}), paths).capture
    expect(graph(mov({}))).toBe('[0:v]scale=out_color_matrix=bt709:out_range=tv,format=yuv422p10le[vout]')
    expect(proVideoArgs(mov({}), 'cfhd')).toEqual(words('-c:v cfhd -quality film1 -color_primaries bt709 -color_trc bt709 -colorspace bt709 -color_range tv'))
    expect(QUALITIES.map((quality) => after(proVideoArgs(mov({ quality }), 'cfhd'), '-quality'))).toEqual(['film1', 'high', 'medium'])
    expect(after(plan, '-c:a')).toBe('pcm_f32le')
    expect(after(plan, '-ar')).toBe('48000')
    expect(after(plan, '-movflags')).toBe('+write_colr')
    expect(plan.join(' ')).not.toContain('faststart')
    const alpha = mov({ alpha: true, pixelFormat: 'bgra' })
    expect(graph(alpha)).toBe('[0:v]format=gbrap12le[vout]')
    expect(proVideoArgs(alpha, 'cfhd')).toEqual(words('-c:v cfhd -quality film1 -color_primaries bt709 -color_trc bt709'))
  })

  it('Animation: ARGB with alpha, RGB without, RGB tags; no quality', () => {
    const anim = mov({ codec: 'animation', encoder: 'qtrle', alpha: true, pixelFormat: 'rgba' })
    expect(graph(anim)).toBe('[0:v]format=argb[vout]')
    expect(proVideoArgs(anim, 'qtrle')).toEqual(words('-c:v qtrle -color_primaries bt709 -color_trc bt709'))
    expect(graph(mov({ codec: 'animation', encoder: 'qtrle' }))).toBe('[0:v]format=rgb24[vout]')
    expect(after(proPlan(anim, paths).capture, '-movflags')).toBe('+write_colr')
    expect(proAudioArgs(anim)).toEqual(['-c:a', 'pcm_f32le', '-ar', '48000'])
  })

  it('a size target is ignored: editing formats are sized by quality', () => {
    const plan = proPlan(mov({ ...target }), paths)
    expect(plan.passes).toEqual([])
    expect(plan.capture).not.toContain('-b:v')
    expect(plan.capture).not.toContain(String(B))
  })

  it('frames that arrive as I420 are read as BT.601 before the BT.709 conversion', () => {
    expect(graph(mov({ pixelFormat: 'yuv420p' }))).toBe('[0:v]scale=in_color_matrix=bt601:in_range=tv:out_color_matrix=bt709:out_range=tv,format=yuv422p10le[vout]')
  })

  it('VP9 with alpha: straight RGBA to YUV with alpha, today’s VP9 settings, Opus', () => {
    const j = job({ format: 'webm', codec: undefined, alpha: true, encoder: 'libvpx-vp9', pixelFormat: 'bgra', outputPath: '/v/o.webm' })
    expect(graph(j)).toBe('[0:v]scale=out_color_matrix=bt601:out_range=tv,format=yuva420p[vout]')
    const a = proPlan(j, paths).capture
    expect(a.join(' ')).toContain('-c:v libvpx-vp9 -row-mt 1 -tile-columns 2 -frame-parallel 0 -g 120 -deadline realtime -cpu-used 7 -crf 27 -b:v 0 ' + COLOR.join(' '))
    expect(after(a, '-c:a')).toBe('libopus')
  })

  it('a transparent job must send straight RGBA or BGRA, and a codec its encoder makes', () => {
    expect(() => proPlan(mov({ alpha: true, pixelFormat: 'bgr0' }), paths)).toThrow(/Invalid export settings/)
    expect(() => proPlan(mov({ encoder: 'qtrle' }), paths)).toThrow(/Invalid export settings/)
    expect(() => proPlan(job({ encoder: 'libx264' }), paths)).toThrow(/Invalid export settings/)
    expect(() => proPlan(job({ format: 'gif' }), paths)).toThrow(/Invalid export settings/)
  })
})

describe('ProRes (test 23)', () => {
  const prores = (x: Partial<ExportJob> & { pixelFormat?: RawPixelFormat } = {}): ExportJob =>
    job({ format: 'mov', codec: 'prores-422', encoder: 'prores_ks', pixelFormat: 'bgr0', outputPath: '/v/out.mov', ...x })

  it('with the policy on: profiles 3, 2, 1 for 422 and 4 for 4444, alpha bits 16 or 0, never -vendor', () => {
    CODEC_POLICY.prores = true
    expect(QUALITIES.map((quality) => after(proVideoArgs(prores({ quality }), 'prores_ks'), '-profile:v'))).toEqual(['3', '2', '1'])
    const opaque = prores({ codec: 'prores-4444' })
    const alpha = prores({ codec: 'prores-4444', alpha: true, pixelFormat: 'bgra' })
    expect(proVideoArgs(opaque, 'prores_ks')).toEqual(words('-c:v prores_ks -profile:v 4 -alpha_bits 0 -color_primaries bt709 -color_trc bt709 -colorspace bt709 -color_range tv'))
    expect(proVideoArgs(alpha, 'prores_ks').slice(0, 6)).toEqual(words('-c:v prores_ks -profile:v 4 -alpha_bits 16'))
    expect(after(proPlan(alpha, paths).capture, '-filter_complex')).toContain('format=yuva444p10le[vout]')
    expect(after(proPlan(opaque, paths).capture, '-filter_complex')).toContain('format=yuv444p10le[vout]')
    expect(after(proPlan(prores(), paths).capture, '-filter_complex')).toContain('scale=out_color_matrix=bt709:out_range=tv,format=yuv422p10le[vout]')
    for (const j of [prores(), opaque, alpha, ...QUALITIES.map((quality) => prores({ quality }))]) {
      validateJob(j)
      expect(proPlan(j, paths).capture).not.toContain('-vendor')
    }
  })

  it('with the policy off, as shipped: no ProRes codec, route or plan', () => {
    expect(FORMAT_CODECS.mov.filter(codecAllowed)).toEqual(['h264', 'hevc', 'cineform', 'animation'])
    expect(nearestCodec('prores-422', 'mov')).toBe('cineform')
    expect(nearestCodec('prores-4444', 'mov')).toBe('cineform')
    expect(() => proPlan(prores(), paths)).toThrow(/Invalid export settings/)
    expect(() => validateJob(prores())).toThrow(/Invalid export settings/)
  })
})

/* ---------- Test 81: the allow-list ---------- */

const VIDEO_ENCODERS: FfmpegVideoEncoder[] = [
  'h264_nvenc', 'h264_qsv', 'h264_amf', 'h264_mf', 'libx264', 'libvpx-vp9',
  'hevc_nvenc', 'hevc_qsv', 'hevc_amf', 'hevc_mf', 'libx265',
  'av1_nvenc', 'av1_qsv', 'av1_amf', 'libaom-av1',
  'cfhd', 'qtrle', 'prores_ks'
]
const FORMATS: ExportFormat[] = ['mp4', 'mov', 'webm', 'gif', 'm4a', 'wav']
const PIXELS: RawPixelFormat[] = ['yuv420p', 'bgra', 'rgb0']

/** Every job the validator lets through, over the tables, qualities, size targets, frame rates, alpha and stream kinds. */
function* everyJob(): Generator<ExportJob> {
  for (const format of FORMATS) {
    const codecs: (ExportCodec | undefined)[] = [undefined, ...FORMAT_CODECS[format]]
    for (const codec of codecs)
      for (const quality of QUALITIES)
        for (const bitrate of [undefined, { video: B, audio: 128_000 }])
          for (const alpha of [undefined, true as const])
            for (const fps of [30, 120]) {
              const common = { format, codec, quality, alpha, fps, outputPath: `/v/out.${format}`, ...(bitrate ? { bitrate } : {}) }
              const videos: ExportJob['video'][] = [
                ...VIDEO_ENCODERS.flatMap((encoder) => PIXELS.map((pixelFormat) => ({ kind: 'raw' as const, encoder, pixelFormat }))),
                ...(['h264', 'vp9', 'hevc', 'av1'] as const).map((kind) => ({ kind, color: EXPORT_COLOR })),
                { kind: 'none' as const }
              ]
              for (const video of videos) {
                const j = job({ ...common, video })
                if (j.codec === undefined) delete j.codec
                if (j.alpha === undefined) delete j.alpha
                try {
                  validateJob(j)
                } catch {
                  continue
                }
                yield j
              }
            }
  }
}

/** Every -c:v and -c:a value of a job's plan, or null when the plan's part is not built yet (the WAV format before P3). */
function encodersOf(j: ExportJob): string[] | null {
  let plan: FfmpegPlan
  try {
    plan = ffmpegPlan(j, paths)
  } catch (e) {
    if ((e as Error).message === t('errors.feature.notReady')) return null
    throw e
  }
  return [plan.capture, ...plan.passes].flatMap((a) => [...allAfter(a, '-c:v'), ...allAfter(a, '-c:a')])
}

function collect(): { names: Set<string>; jobs: number } {
  const names = new Set<string>()
  let jobs = 0
  for (const j of everyJob()) {
    const found = encodersOf(j)
    if (!found) continue
    jobs++
    for (const n of found) names.add(n)
  }
  for (const e of [...HEVC_ENCODERS, ...AV1_ENCODERS]) names.add(after(probeCodecArgs(e), '-c:v'))
  for (const e of ['h264_nvenc', 'h264_qsv', 'h264_amf', 'h264_mf'] as const) names.add(after(probeArgs(e), '-c:v'))
  return { names, jobs }
}

describe('the encoder allow-list (test 81)', () => {
  it('as shipped: every value the builders emit is on ALLOWED_ENCODERS, never libx265 or prores_ks', () => {
    const { names, jobs } = collect()
    expect(jobs).toBeGreaterThan(500)
    for (const n of names) expect(ALLOWED_ENCODERS, n).toContain(n)
    expect(names).not.toContain('libx265')
    expect(names).not.toContain('prores_ks')
    // The new codecs are reached: the list is exercised, not empty.
    for (const n of ['hevc_nvenc', 'hevc_mf', 'av1_amf', 'libaom-av1', 'cfhd', 'qtrle', 'copy', 'aac', 'libopus', 'pcm_f32le', 'libx264', 'libvpx-vp9', 'ffv1']) expect(names, n).toContain(n)
  })

  it('libx265 and prores_ks appear only with their policy flags on, and nothing else joins', () => {
    for (const [flag, name] of [['hevcSoftware', 'libx265'], ['prores', 'prores_ks']] as const) {
      Object.assign(CODEC_POLICY, policy, { [flag]: true })
      const { names } = collect()
      expect(names).toContain(name)
      for (const n of names) if (n !== name) expect(ALLOWED_ENCODERS, n).toContain(n)
      expect(names).not.toContain(name === 'libx265' ? 'prores_ks' : 'libx265')
    }
  })
})
