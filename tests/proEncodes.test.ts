import { execFileSync, spawnSync } from 'node:child_process'
import { existsSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import path from 'node:path'
import { afterAll, afterEach, describe, expect, it } from 'vitest'
import type { ExportJob, FfmpegVideoEncoder, RawPixelFormat } from '../src/shared/api/export'
import { EXPORT_COLOR, ffmpegPlan } from '../src/main/exportArgs'
import { validateJob } from '../src/main/exportJob'
import { ffmpegPath } from '../src/main/ffmpeg'
import { CODEC_POLICY } from '../src/shared/render/proFormats'

/*
 * The wave 12 argument lists run by real ffmpegs (docs/design/output-and-languages.md §5.4-5.5): the
 * bundled Linux build and, when present, the system's 6.1 (the Windows binary's version). Each plan
 * goes through ffmpegPlan as an export does; the files are read back with ffprobe and decoded. GPU
 * encoders cannot run here: their arguments are pinned by tests 11-13, and only the WebCodecs copy
 * routes (an HEVC or AV1 stream muxed as it arrives) and the processor's encoders are run.
 */

const dir = mkdtempSync(path.join(tmpdir(), 'ssw-pro-encodes-'))
afterAll(() => rmSync(dir, { recursive: true, force: true }))
const policy = { ...CODEC_POLICY }
afterEach(() => Object.assign(CODEC_POLICY, policy))

const BINARIES = [ffmpegPath(), ...(existsSync('/usr/bin/ffmpeg') ? ['/usr/bin/ffmpeg'] : [])]
const PROBE = existsSync('/usr/bin/ffprobe') ? '/usr/bin/ffprobe' : null

type Stream = Record<string, string | number | Record<string, string>>
function probe(file: string): Stream[] {
  const entries = 'stream=codec_type,codec_name,codec_tag_string,pix_fmt,width,height,nb_read_frames,color_space,color_primaries,color_transfer,color_range,sample_rate,sample_fmt:stream_tags=vendor_id'
  return JSON.parse(execFileSync(PROBE!, ['-v', 'error', '-count_frames', '-show_entries', entries, '-of', 'json', file]).toString()).streams
}

/** The first frame of `file` as straight RGBA bytes (decoded with libvpx for WebM, which keeps alpha). */
function firstFrame(ff: string, file: string, webm = false): Buffer {
  return execFileSync(ff, ['-v', 'error', ...(webm ? ['-c:v', 'libvpx-vp9'] : []), '-i', file, '-frames:v', '1', '-f', 'rawvideo', '-pix_fmt', 'rgba', '-'], { maxBuffer: 1 << 26 })
}

/** `frames` frames of a test pattern in `pix` (I420 converted as the renderer does: BT.601 limited). */
function pattern(ff: string, w: number, h: number, fps: number, frames: number, pix: string): Buffer {
  const vf = pix === 'yuv420p' ? ['-vf', 'scale=out_color_matrix=bt601:out_range=tv'] : []
  return execFileSync(ff, ['-v', 'error', '-f', 'lavfi', '-i', `testsrc2=size=${w}x${h}:rate=${fps}`, '-frames:v', String(frames), ...vf, '-f', 'rawvideo', '-pix_fmt', pix, '-'], { maxBuffer: 1 << 28 })
}

/** Straight RGBA or BGRA frames: transparent, with an opaque red box in the middle and a 50% grey band at the top. */
function seeThrough(w: number, h: number, frames: number, order: 'rgba' | 'bgra'): Buffer {
  const one = Buffer.alloc(w * h * 4)
  for (let y = 0; y < h; y++)
    for (let x = 0; x < w; x++) {
      const i = (y * w + x) * 4
      const box = x >= w / 4 && x < (3 * w) / 4 && y >= h / 4 && y < (3 * h) / 4
      const band = y < h / 8
      const [r, g, b, a] = box ? [255, 0, 0, 255] : band ? [128, 128, 128, 128] : [0, 0, 0, 0]
      one.set(order === 'rgba' ? [r, g, b, a] : [b, g, r, a], i)
    }
  return Buffer.concat(Array.from({ length: frames }, () => one))
}

const sound = path.join(dir, 'sound.m4a')
execFileSync(ffmpegPath(), ['-v', 'error', '-f', 'lavfi', '-i', 'sine=frequency=440:sample_rate=48000', '-t', '2', '-c:a', 'aac', sound])

function job(x: Partial<ExportJob> & { encoder?: FfmpegVideoEncoder; pixelFormat?: RawPixelFormat }): ExportJob {
  const { encoder = 'cfhd', pixelFormat = 'bgr0', ...rest } = x
  const j: ExportJob = {
    width: 64,
    height: 48,
    fps: 30,
    frames: 10,
    format: 'mov',
    quality: 'medium',
    codec: 'cineform',
    video: { kind: 'raw', encoder, pixelFormat },
    audio: { clips: [{ id: 'c', start: 0, end: 10 / 30, speed: 1 }], volume: 1 },
    outputPath: '/v/out.mov',
    ...rest
  }
  if (j.codec === undefined) delete j.codec
  validateJob(j)
  return j
}

let runs = 0
/** Runs a whole plan with `input` on the capture's stdin; the output's path. */
function run(ff: string, j: ExportJob, input: Buffer): string {
  const stem = path.join(dir, `run${++runs}`)
  const output = `${stem}.${j.format}`
  const plan = ffmpegPlan(j, { audioInput: sound, output, tempStem: stem })
  for (const s of plan.scripts) writeFileSync(s.path, s.content)
  for (const args of [plan.capture, ...plan.passes]) {
    const r = spawnSync(ff, args, { input: args === plan.capture ? input : undefined, maxBuffer: 1 << 26 })
    expect(r.status, `${args.join(' ')}\n${r.stderr?.toString()}`).toBe(0)
  }
  return output
}

const at = (frame: Buffer, w: number, x: number, y: number): number[] => Array.from(frame.subarray((y * w + x) * 4, (y * w + x) * 4 + 4))
const near = (a: number[], b: number[], tol: number): boolean => a.every((v, i) => Math.abs(v - b[i]) <= tol)
const BT709 = { color_space: 'bt709', color_primaries: 'bt709', color_transfer: 'bt709' }
const BT601 = { color_space: 'smpte170m', color_primaries: 'bt709', color_transfer: 'bt709', color_range: 'tv' }

describe.runIf(PROBE).each(BINARIES)('wave 12 encodes with %s', (ff) => {
  it('CineForm: 10-bit 4:2:2, BT.709 tags, 32-bit float PCM at 48 kHz, every frame', () => {
    const out = run(ff, job({}), pattern(ff, 64, 48, 30, 10, 'bgr0'))
    const [v, a] = probe(out)
    expect(v).toMatchObject({ codec_name: 'cfhd', pix_fmt: 'yuv422p10le', width: 64, height: 48, nb_read_frames: '10', ...BT709 })
    expect(a).toMatchObject({ codec_type: 'audio', codec_name: 'pcm_f32le', sample_rate: '48000' })
  })

  it('CineForm with alpha: 12-bit RGBA that keeps the see-through corner, the opaque red and the 50% band', () => {
    const out = run(ff, job({ alpha: true, pixelFormat: 'bgra' }), seeThrough(64, 48, 10, 'bgra'))
    expect(probe(out)[0]).toMatchObject({ codec_name: 'cfhd', pix_fmt: 'gbrap12le', color_primaries: 'bt709', color_transfer: 'bt709' })
    // CineForm is lossy (12-bit, alpha PSNR about 51 dB): a level or two either way.
    const f = firstFrame(ff, out)
    expect(at(f, 64, 0, 47)[3]).toBeLessThanOrEqual(2)
    expect(near(at(f, 64, 32, 24), [255, 0, 0, 255], 2)).toBe(true)
    expect(near(at(f, 64, 2, 2), [128, 128, 128, 128], 3)).toBe(true)
  })

  it('Lossless (QuickTime Animation) with alpha: ARGB, bit-exact', () => {
    const frames = seeThrough(64, 48, 10, 'rgba')
    const out = run(ff, job({ codec: 'animation', encoder: 'qtrle', alpha: true, pixelFormat: 'rgba' }), frames)
    expect(probe(out)[0]).toMatchObject({ codec_name: 'qtrle', pix_fmt: 'argb', nb_read_frames: '10' })
    expect(firstFrame(ff, out).equals(frames.subarray(0, 64 * 48 * 4))).toBe(true)
    const opaque = run(ff, job({ codec: 'animation', encoder: 'qtrle', pixelFormat: 'bgr0' }), pattern(ff, 64, 48, 30, 10, 'bgr0'))
    expect(probe(opaque)[0]).toMatchObject({ codec_name: 'qtrle', pix_fmt: 'rgb24' })
  })

  it('VP9 with alpha (WebM): libvpx keeps the alpha; read back with libvpx', () => {
    const j = job({ format: 'webm', codec: undefined, alpha: true, encoder: 'libvpx-vp9', pixelFormat: 'bgra', outputPath: '/v/o.webm', width: 128, height: 96 })
    const out = run(ff, j, seeThrough(128, 96, 10, 'bgra'))
    expect(probe(out)[0]).toMatchObject({ codec_name: 'vp9', ...BT601 })
    const f = firstFrame(ff, out, true)
    expect(at(f, 128, 4, 90)[3]).toBeLessThanOrEqual(2)
    expect(at(f, 128, 64, 48)[3]).toBeGreaterThanOrEqual(253)
  })

  it('AV1 on the processor (libaom): MP4 and WebM, tagged and signalled as H.264 is', () => {
    const frames = pattern(ff, 320, 180, 30, 10, 'yuv420p')
    const mp4 = run(ff, job({ format: 'mp4', codec: 'av1', encoder: 'libaom-av1', pixelFormat: 'yuv420p', width: 320, height: 180, outputPath: '/v/o.mp4' }), frames)
    const [v, a] = probe(mp4)
    expect(v).toMatchObject({ codec_name: 'av1', pix_fmt: 'yuv420p', nb_read_frames: '10', ...BT601 })
    expect(a).toMatchObject({ codec_name: 'aac' })
    const webm = run(ff, job({ format: 'webm', codec: 'av1', encoder: 'libaom-av1', pixelFormat: 'yuv420p', width: 320, height: 180, outputPath: '/v/o.webm' }), frames)
    expect(probe(webm).map((s) => s.codec_name)).toEqual(['av1', 'opus'])
  })

  it('AV1 with a size target: two passes over the lossless intermediate land near the rate', () => {
    const j = job({ format: 'mp4', codec: 'av1', encoder: 'libaom-av1', pixelFormat: 'rgba', width: 320, height: 180, frames: 30, outputPath: '/v/o.mp4', bitrate: { video: 300_000, audio: 64_000 }, audio: { clips: [{ id: 'c', start: 0, end: 1, speed: 1 }], volume: 1 } })
    const out = run(ff, j, pattern(ff, 320, 180, 30, 30, 'rgba'))
    expect(probe(out)[0]).toMatchObject({ codec_name: 'av1', nb_read_frames: '30' })
    const bytes = readFileSync(out).length
    expect(bytes).toBeLessThan(((300_000 + 64_000) / 8) * 1.6)
  })

  it('the WebCodecs AV1 route: an IVF stream with fourcc AV01 is copied and tagged', () => {
    const ivf = path.join(dir, 'stream.ivf')
    execFileSync(ff, ['-v', 'error', '-y', '-f', 'lavfi', '-i', 'testsrc2=size=320x180:rate=30', '-frames:v', '10', '-pix_fmt', 'yuv420p', '-c:v', 'libaom-av1', '-cpu-used', '8', '-f', 'ivf', ivf])
    expect(readFileSync(ivf).subarray(8, 12).toString()).toBe('AV01')
    const out = run(ff, job({ format: 'mp4', codec: 'av1', video: { kind: 'av1', color: EXPORT_COLOR }, width: 320, height: 180, outputPath: '/v/o.mp4' }), readFileSync(ivf))
    expect(probe(out)[0]).toMatchObject({ codec_name: 'av1', nb_read_frames: '10', ...BT601 })
  })

  it('the WebCodecs HEVC route: an Annex B stream is copied, tagged hvc1 and given the BT.601 description', () => {
    // An Annex B stream stands in for what a graphics card's encoder hands over through WebCodecs (made here in
    // software only to have one), in frame order as the WebCodecs sink requires: no B-frames.
    const annexB = path.join(dir, 'stream.hevc')
    execFileSync(ff, ['-v', 'error', '-y', '-f', 'lavfi', '-i', 'testsrc2=size=320x180:rate=30', '-frames:v', '10', '-pix_fmt', 'yuv420p', '-c:v', 'libx265', '-x265-params', 'bframes=0:log-level=error', '-f', 'hevc', annexB])
    for (const format of ['mp4', 'mov'] as const) {
      const out = run(ff, job({ format, codec: 'hevc', video: { kind: 'hevc', color: EXPORT_COLOR }, width: 320, height: 180, outputPath: `/v/o.${format}` }), readFileSync(annexB))
      expect(probe(out)[0]).toMatchObject({ codec_name: 'hevc', codec_tag_string: 'hvc1', nb_read_frames: '10', ...BT601 })
    }
  })

  it('ProRes with the policy on: 4444 with alpha keeps it, and the file never claims to be Apple’s', () => {
    CODEC_POLICY.prores = true
    const out = run(ff, job({ codec: 'prores-4444', encoder: 'prores_ks', alpha: true, pixelFormat: 'bgra' }), seeThrough(64, 48, 10, 'bgra'))
    const [v] = probe(out)
    expect(v).toMatchObject({ codec_name: 'prores', pix_fmt: 'yuva444p12le', ...BT709 })
    expect((v.tags as Record<string, string> | undefined)?.vendor_id).not.toBe('appl')
    const f = firstFrame(ff, out)
    expect(at(f, 64, 0, 47)[3]).toBe(0)
    expect(at(f, 64, 32, 24)[3]).toBe(255)
  })
})
