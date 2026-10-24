import { execFileSync, spawnSync } from 'node:child_process'
import { existsSync, mkdtempSync, rmSync, statSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import path from 'node:path'
import { afterAll, describe, expect, it, vi } from 'vitest'

// An audible click for the ffmpeg tests (the real sound is the cursor builder's; see clickSound.ts).
const CLICK = 'sine=frequency=2000:sample_rate=48000:duration=0.04'
vi.mock('../src/shared/render/clickSound', async (orig) => ({ ...(await orig<object>()), clickSoundSource: () => CLICK }))

import {
  clickPositions,
  clickTrackGraph,
  describeGifFit,
  exportArgs,
  externalizeGraph,
  ffmpegPlan,
  gifEncodeArgs,
  gifPaletteArgs,
  GRAPH_INLINE_MAX,
  isTwoPass,
  nextGifFit,
  soundtrackGraph,
  videoEncoderArgs,
  vp9EncoderArgs
} from '../src/main/exportArgs'
import { batchFileOk, freeBatchPath, isPng, validateJob } from '../src/main/exportJob'
import { ffmpegPath } from '../src/main/ffmpeg'
import type { ExportJob } from '../src/shared/api/export'
import type { Clip } from '../src/shared/types'

const dir = mkdtempSync(path.join(tmpdir(), 'ssw-export-formats-'))
afterAll(() => rmSync(dir, { recursive: true, force: true }))

const after = (args: string[], flag: string): string => args[args.indexOf(flag) + 1]
const clip = (start: number, end: number, speed = 1): Clip => ({ id: `${start}`, start, end, speed })
const color = { primaries: 1, transfer: 1, matrix: 6, fullRange: false }
const base: ExportJob = {
  width: 1280,
  height: 720,
  fps: 30,
  frames: 90,
  format: 'mp4',
  quality: 'high',
  video: { kind: 'raw', encoder: 'libx264', pixelFormat: 'rgba' },
  outputPath: '/v/out.mp4'
}
const io = { audioInput: '/p/screen.mp4', output: '/v/.out.partial.mp4' }
const withAudio = (job: ExportJob): ExportJob => ({ ...job, audio: { clips: [clip(0, 3)], volume: 1 } })

describe('WebM (VP9 + Opus)', () => {
  const webm: ExportJob = withAudio({ ...base, format: 'webm', video: { kind: 'raw', encoder: 'libvpx-vp9', pixelFormat: 'bgra' } })
  it('raw frames: libvpx-vp9 in fast constant-quality mode, BT.601 conversion, tagged colours, Opus at 48 kHz', () => {
    const a = exportArgs(webm, io)
    expect(after(a, '-c:v')).toBe('libvpx-vp9')
    expect(after(a, '-deadline')).toBe('realtime')
    expect(after(a, '-row-mt')).toBe('1')
    expect(Number(after(a, '-crf'))).toBeGreaterThan(0)
    expect(after(a, '-filter_complex')).toContain('[0:v]scale=out_color_matrix=bt601:out_range=tv,format=yuv420p[vout]')
    expect(a.join(' ')).toContain('-color_primaries bt709 -color_trc bt709 -colorspace smpte170m -color_range tv')
    expect(a).not.toContain('-bsf:v')
    expect(a.join(' ')).toContain('-map [aout] -c:a libopus -b:a 128k -ar 48000')
    expect(a.slice(-3)).toEqual(['-f', 'webm', io.output])
  })
  it('WebCodecs VP9: IVF from stdin, stream copied, colour written into the bitstream and the container', () => {
    const a = exportArgs({ ...webm, video: { kind: 'vp9', color } }, io)
    expect(a.join(' ')).toContain('-f ivf -i pipe:0')
    expect(after(a, '-c:v')).toBe('copy')
    expect(after(a, '-bsf:v')).toBe('vp9_metadata=color_space=smpte170:color_range=tv')
    expect(a.join(' ')).toContain('-colorspace smpte170m -color_range tv')
  })
})

describe('MOV (H.264 + AAC in QuickTime)', () => {
  it('writes a QuickTime file with the same tagged H.264 as MP4', () => {
    const a = exportArgs(withAudio({ ...base, format: 'mov' }), io)
    expect(a.slice(-3)).toEqual(['-f', 'mov', io.output])
    expect(after(a, '-movflags')).toBe('+faststart+write_colr')
    expect(after(a, '-bsf:v')).toContain('h264_metadata=colour_primaries=1')
    expect(a.join(' ')).toContain('-c:a aac -b:a 192k')
    const copy = exportArgs({ ...base, format: 'mov', video: { kind: 'h264', color } }, io)
    expect(copy.join(' ')).toContain('-f h264 -r 30 -i pipe:0')
  })
})

describe('M4A (audio only)', () => {
  const m4a: ExportJob = withAudio({ ...base, format: 'm4a', video: { kind: 'none' }, width: 0, height: 0 })
  it('reads no frames: the proxy audio is input 0, AAC in an .m4a (ipod) file', () => {
    const a = exportArgs(m4a, io)
    expect(a).toContain('-nostdin')
    expect(a).not.toContain('pipe:0')
    expect(a.join(' ')).toContain('-vn -i /p/screen.mp4')
    expect(after(a, '-filter_complex')).toMatch(/^\[0:a\]aresample/)
    expect(a).not.toContain('-c:v')
    expect(a.slice(-3)).toEqual(['-f', 'ipod', io.output])
    expect(() => validateJob(m4a)).not.toThrow()
  })
  it('a silent project has nothing to export', () => {
    expect(() => exportArgs({ ...m4a, audio: undefined }, io)).toThrow(/no sound/)
    expect(() => validateJob({ ...m4a, audio: undefined })).toThrow(/no sound/)
  })
  it('click sounds alone are a soundtrack', () => {
    const a = exportArgs({ ...m4a, audio: undefined, clicks: { times: [0.5], volume: 1 } }, io)
    expect(a.join(' ')).toContain(`-f lavfi -i ${CLICK}`)
    expect(after(a, '-filter_complex')).toContain('[aout]')
  })
})

describe('size targets on every encoder', () => {
  const job: ExportJob = { ...base, bitrate: { video: 4_000_000, audio: 128_000 } }
  it('GPU encoders switch to an average bit rate with peak limits', () => {
    expect(videoEncoderArgs('h264_nvenc', job).join(' ')).toContain('-rc vbr -b:v 4000000 -maxrate 6000000 -bufsize 8000000')
    expect(videoEncoderArgs('h264_nvenc', job)).not.toContain('-cq')
    expect(videoEncoderArgs('h264_qsv', job).join(' ')).toContain('-b:v 4000000 -maxrate 6000000 -bufsize 8000000')
    expect(videoEncoderArgs('h264_qsv', job)).not.toContain('-global_quality')
    expect(videoEncoderArgs('h264_amf', job).join(' ')).toContain('-rc vbr_peak -b:v 4000000 -maxrate 6000000')
    expect(videoEncoderArgs('h264_mf', job).join(' ')).toContain('-b:v 4000000 -maxrate 6000000')
    expect(videoEncoderArgs('libx264', job)).not.toContain('-crf')
  })
  it('x264 runs two passes over a lossless intermediate; the audio is mixed in the second', () => {
    const plan = ffmpegPlan(withAudio(job), { ...io, tempStem: '/tmp/screen-studio-gif-1-a' })
    expect(isTwoPass(job)).toBe(true)
    expect(plan.capture.join(' ')).toContain('-c:v libx264 -preset ultrafast -qp 0 -f matroska /tmp/screen-studio-gif-1-a.mkv')
    expect(plan.capture.join(' ')).toContain('scale=out_color_matrix=bt601:out_range=tv,format=yuv420p')
    const [p1, p2] = plan.passes
    expect(p1.join(' ')).toContain('-b:v 4000000 -g 60 -pass 1 -passlogfile /tmp/screen-studio-gif-1-a.pass -an -f null -')
    expect(p2.join(' ')).toContain('-pass 2 -passlogfile /tmp/screen-studio-gif-1-a.pass')
    expect(p2.join(' ')).toContain('-map [aout] -c:a aac -b:a 128k')
    expect(after(p2, '-bsf:v')).toContain('h264_metadata')
    expect(p2.slice(-3)).toEqual(['-f', 'mp4', io.output])
    expect(plan.temps).toEqual(expect.arrayContaining(['/tmp/screen-studio-gif-1-a.mkv', '/tmp/screen-studio-gif-1-a.pass-0.log', '/tmp/screen-studio-gif-1-a.pass-0.log.mbtree']))
  })
  it('VP9 with a size target: two passes in good mode', () => {
    const vp9 = { ...job, format: 'webm' as const, video: { kind: 'raw' as const, encoder: 'libvpx-vp9' as const, pixelFormat: 'rgba' as const } }
    const plan = ffmpegPlan(vp9, { ...io, tempStem: '/tmp/s' })
    expect(plan.passes).toHaveLength(2)
    expect(after(plan.passes[1], '-deadline')).toBe('good')
    expect(vp9EncoderArgs(vp9, 2)).toContain('4000000')
  })
  it('GPU and WebCodecs routes stay one process', () => {
    expect(ffmpegPlan({ ...job, video: { kind: 'raw', encoder: 'h264_nvenc', pixelFormat: 'bgra' } }, { ...io, tempStem: '/tmp/s' }).passes).toEqual([])
    expect(ffmpegPlan({ ...job, video: { kind: 'h264', color } }, { ...io, tempStem: '/tmp/s' }).passes).toEqual([])
  })
})

describe('click sounds in the soundtrack', () => {
  it('places each click on its sample, in time order, cut short by the next one', () => {
    expect(clickPositions([2, 0.5, -1, 0.5, 9], 3)).toEqual([24000, 96000])
    const g = clickTrackGraph({ times: [0.5, 0.52, 2], volume: 0.6 }, 3, '2:a')!
    expect(g).toContain('[2:a]aformat=sample_fmts=fltp:sample_rates=48000:channel_layouts=mono,asplit=3[k0][k1][k2]')
    expect(g).toContain('anullsrc=r=48000:cl=mono,aformat=sample_fmts=fltp:sample_rates=48000:channel_layouts=mono,atrim=end_sample=24000[z]')
    expect(g).toContain('[k0]apad=whole_len=960,atrim=end_sample=960[p0]')
    expect(g).toContain('[k2]apad=whole_len=48000,atrim=end_sample=48000[p2]')
    expect(g).toContain('[z][p0][p1][p2]concat=n=4:v=0:a=1,volume=0.6,apad=whole_len=144000,atrim=end_sample=144000[clk]')
    expect(clickTrackGraph({ times: [5], volume: 1 }, 3, '2:a')).toBeNull()
  })
  it('mixes clicks over the edited recording without renormalising it', () => {
    const g = soundtrackGraph({ duration: 3, audio: { clips: [clip(0, 3)], volume: 1, input: '1:a' }, clicks: { sounds: { times: [1], volume: 1 }, input: '2:a' } })!
    expect(g).toContain('[rec]')
    expect(g).toContain('[rec][clk]amix=inputs=2:duration=first:dropout_transition=0:normalize=0[aout]')
    expect(soundtrackGraph({ duration: 3 })).toBeNull()
    // No clicks job (the contract's stub returns null): the graph is the plain soundtrack.
    expect(soundtrackGraph({ duration: 3, audio: { clips: [clip(0, 3)], volume: 1, input: '1:a' } })).toMatch(/\[aout\]$/)
  })
  it('adds the click source as the next input after the recording', () => {
    const a = exportArgs({ ...withAudio(base), clicks: { times: [1, 2], volume: 0.5 } }, io)
    expect(a.join(' ')).toContain(`-vn -i /p/screen.mp4 -f lavfi -i ${CLICK}`)
    expect(after(a, '-filter_complex')).toContain('[2:a]aformat')
  })
  it('long graphs (hundreds of clicks) go into a script file instead of the command line', () => {
    const times = Array.from({ length: 400 }, (_, i) => 0.1 + i * 0.05)
    const job: ExportJob = { ...withAudio(base), frames: 900, clicks: { times, volume: 1 } }
    const plan = ffmpegPlan(job, { ...io, tempStem: '/tmp/screen-studio-gif-1-b' })
    expect(plan.capture).toContain('-filter_complex_script')
    expect(plan.capture).not.toContain('-filter_complex')
    expect(plan.scripts[0].path).toBe('/tmp/screen-studio-gif-1-b.graph.txt')
    expect(plan.scripts[0].content.length).toBeGreaterThan(GRAPH_INLINE_MAX)
    expect(plan.temps).toContain('/tmp/screen-studio-gif-1-b.graph.txt')
    expect(plan.capture.join(' ').length).toBeLessThan(2000)
    expect(externalizeGraph(['-filter_complex', 'x'], '/s').script).toBeNull()
  })
})

describe('GIF size limit', () => {
  const size = { width: 1280, height: 720, fps: 15 }
  it('lowers the frame rate first, then the size, then the colours, until nothing is left', () => {
    let fit = { fps: 15, scale: 1, colors: 256 }
    const first = nextGifFit(fit, size, 30e6, 15e6)!
    expect(first.fps).toBe(10)
    expect(first.scale).toBeLessThan(1)
    expect(first.colors).toBe(256)
    // Far too big: everything goes down.
    const hard = nextGifFit(fit, size, 200e6, 15e6)!
    expect(hard).toEqual({ fps: 10, scale: 0.32, colors: 256 })
    // Still far too big: the size bottoms out at 320 px, then colours and frame rate go down.
    const harder = nextGifFit(hard, size, 60e6, 15e6)!
    expect(harder.scale).toBe(0.25)
    expect(harder.colors).toBe(128)
    let steps = 0
    for (let next: typeof fit | null = harder; next; next = nextGifFit(next, size, 200e6, 15e6)) {
      fit = next
      steps++
    }
    expect(steps).toBeLessThan(8)
    expect(fit).toEqual({ fps: 8, scale: 0.25, colors: 32 })
    expect(describeGifFit({ fps: 10, scale: 0.5, colors: 128 }, size)).toBe('10 fps · 640×360 · 128 colours')
  })
  it('re-runs the palette and GIF passes with the reduced setting', () => {
    const fit = { fps: 10, scale: 0.5, colors: 128 }
    expect(after(gifPaletteArgs('/t/x.mkv', '/t/x.png', fit, size), '-vf')).toBe('fps=10,scale=640:360:flags=lanczos,palettegen=max_colors=128:stats_mode=diff')
    expect(after(gifEncodeArgs('/t/x.mkv', '/t/x.png', '/v/a.gif', fit, size), '-filter_complex')).toBe(
      '[0:v]fps=10,scale=640:360:flags=lanczos[g];[g][1:v]paletteuse=dither=bayer:bayer_scale=4:diff_mode=rectangle'
    )
  })
})

describe('validateJob for the new formats', () => {
  const ok = (job: ExportJob): void => expect(() => validateJob(job)).not.toThrow()
  const bad = (job: ExportJob): void => expect(() => validateJob(job)).toThrow()
  it('accepts each format with its own kind of video', () => {
    ok({ ...base, format: 'webm', video: { kind: 'raw', encoder: 'libvpx-vp9', pixelFormat: 'rgba' } })
    ok({ ...base, format: 'webm', video: { kind: 'vp9', color } })
    ok({ ...base, format: 'mov', video: { kind: 'h264', color } })
    ok({ ...base, bitrate: { video: 1e6, audio: 96e3 }, clicks: { times: [1, 2], volume: 0.6 } })
    ok({ ...base, format: 'gif', maxBytes: 15e6 })
  })
  it('refuses mismatched or out-of-range jobs', () => {
    bad({ ...base, format: 'mp4', video: { kind: 'raw', encoder: 'libvpx-vp9', pixelFormat: 'rgba' } })
    bad({ ...base, format: 'webm', video: { kind: 'h264', color } })
    bad({ ...base, format: 'webm' })
    bad({ ...base, format: 'mp4', video: { kind: 'none' } })
    bad({ ...base, format: 'gif', video: { kind: 'h264', color } })
    bad({ ...base, format: 'avi' as never })
    bad({ ...base, bitrate: { video: -1, audio: 0 } })
    bad({ ...base, maxBytes: 1e6 })
    bad({ ...base, clicks: { times: [Number.NaN], volume: 1 } })
  })
})

describe('batch paths and thumbnails', () => {
  it('accepts only plain export file names', () => {
    expect(batchFileOk('Demo - YouTube 1080p60.mp4')).toBe(true)
    expect(batchFileOk('Demo - Slack GIF.gif')).toBe(true)
    for (const name of ['../x.mp4', 'a/b.mp4', 'a\\b.mp4', 'x.exe', '.hidden.mp4', 'C:x.mp4', 'x.mp4 ', '', 42]) expect(batchFileOk(name)).toBe(false)
  })
  it('never replaces a file: adds (2), (3), ...', () => {
    const taken = new Set([path.join('/out', 'a.mp4'), path.join('/out', 'a (2).mp4')])
    expect(freeBatchPath('/out', 'a.mp4', (f) => taken.has(f))).toBe(path.join('/out', 'a (3).mp4'))
    expect(freeBatchPath('/out', 'b.mp4', (f) => taken.has(f))).toBe(path.join('/out', 'b.mp4'))
  })
  it('recognises PNG data', () => {
    expect(isPng(new Uint8Array([0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a, 0]))).toBe(true)
    expect(isPng(new Uint8Array([0xff, 0xd8, 0xff, 0, 0, 0, 0, 0, 0]))).toBe(false)
  })
})

/* ---------- Real encodes (the bundled ffmpeg, and ffmpeg 6.1 like the Windows build when installed) ---------- */

const BINARIES = [ffmpegPath(), ...(existsSync('/usr/bin/ffmpeg') ? ['/usr/bin/ffmpeg'] : [])]
const PROBE = existsSync('/usr/bin/ffprobe') ? '/usr/bin/ffprobe' : null

function probe(file: string): { streams: Record<string, string>[]; format: Record<string, string> } {
  return JSON.parse(
    execFileSync(PROBE!, ['-v', 'error', '-count_frames', '-show_entries', 'stream=codec_type,codec_name,width,height,nb_read_frames,duration,color_space,color_primaries,color_transfer,color_range,sample_rate:format=format_name,duration', '-of', 'json', file]).toString()
  )
}

/** Onsets (s) of tone bursts in the first audio stream, 5 ms resolution. */
function onsets(ff: string, file: string): { at: number[]; duration: number } {
  const pcm = execFileSync(ff, ['-v', 'error', '-i', file, '-map', '0:a:0', '-ac', '1', '-ar', '8000', '-f', 'f32le', '-'], { maxBuffer: 1 << 26 })
  const s = new Float32Array(pcm.buffer, pcm.byteOffset, pcm.length / 4)
  const at: number[] = []
  let on = false
  for (let i = 0; i + 40 <= s.length; i += 40) {
    let peak = 0
    for (let j = i; j < i + 40; j++) peak = Math.max(peak, Math.abs(s[j]))
    if (!on && peak > 0.1) {
      at.push(i / 8000)
      on = true
    } else if (on && peak < 0.02) on = false
  }
  return { at, duration: s.length / 8000 }
}

/** Raw RGBA frames of a busy test pattern. */
function rgbaFrames(width: number, height: number, fps: number, frames: number): Buffer {
  return execFileSync(ffmpegPath(), ['-v', 'error', '-f', 'lavfi', '-i', `testsrc2=size=${width}x${height}:rate=${fps}`, '-frames:v', String(frames), '-f', 'rawvideo', '-pix_fmt', 'rgba', '-'], {
    maxBuffer: 1 << 30
  })
}

/** Runs a whole plan: frames on the capture's stdin, then the passes. */
function runPlan(ff: string, job: ExportJob, audioInput: string | null, stem: string): string {
  const output = path.join(dir, path.basename(job.outputPath))
  const plan = ffmpegPlan(job, { audioInput, output, tempStem: stem })
  for (const s of plan.scripts) writeFileSync(s.path, s.content)
  const input = job.video.kind === 'raw' ? rgbaFrames(job.width, job.height, job.fps, job.frames) : undefined
  for (const args of [plan.capture, ...plan.passes]) {
    const r = spawnSync(ff, args, { input, maxBuffer: 1 << 26 })
    expect(r.status, r.stderr?.toString()).toBe(0)
  }
  return output
}

const beeps = path.join(dir, 'beeps.m4a')
execFileSync(ffmpegPath(), ['-v', 'error', '-f', 'lavfi', '-i', 'sine=frequency=1000:sample_rate=48000', '-t', '4', '-af', "volume='if(lt(mod(t,1),0.1),1,0)':eval=frame", '-c:a', 'aac', beeps])

describe.each(BINARIES)('real exports with %s', (ff) => {
  const tag = ff === ffmpegPath() ? 'bundled' : 'system'
  const small = { width: 320, height: 180, fps: 30, frames: 60 }

  it.runIf(PROBE)('M4A: the edited soundtrack with clicks mixed in at their output times, nothing else', () => {
    // Keep 0-1 s and 2-4 s: beeps at 0, 2, 3 -> output 0, 1, 2. Clicks at 0.5 and 2.5 s (output).
    const job: ExportJob = {
      ...base,
      ...small,
      frames: 90,
      format: 'm4a',
      video: { kind: 'none' },
      audio: { clips: [clip(0, 1), clip(2, 4)], volume: 1 },
      clicks: { times: [0.5, 2.5], volume: 1 },
      outputPath: `/v/${tag}.m4a`
    }
    const out = runPlan(ff, job, beeps, path.join(dir, `${tag}-m4a`))
    const info = probe(out)
    expect(info.streams.map((s) => s.codec_name)).toEqual(['aac'])
    expect(info.format.format_name).toContain('mp4')
    const { at, duration } = onsets(ff, out)
    expect(duration).toBeCloseTo(3, 1)
    const want = [0, 0.5, 1, 2, 2.5]
    expect(at).toHaveLength(want.length)
    at.forEach((t, i) => expect(Math.abs(t - want[i])).toBeLessThan(0.03))
  })

  it.runIf(PROBE)('click track alone, with overlapping clicks and hundreds of them (script file), stays on time', () => {
    const times = [0.25, 0.26, ...Array.from({ length: 300 }, (_, i) => 0.6 + i * 0.01), 4.5, 5.25]
    const job: ExportJob = { ...base, ...small, frames: 180, format: 'm4a', video: { kind: 'none' }, clicks: { times, volume: 1 }, outputPath: `/v/${tag}-clicks.m4a` }
    const out = runPlan(ff, job, null, path.join(dir, `${tag}-clicks`))
    const { at, duration } = onsets(ff, out)
    expect(duration).toBeCloseTo(6, 1)
    expect(Math.abs(at[0] - 0.25)).toBeLessThan(0.02)
    // The last two clicks come after a dense run of 300: no drift.
    expect(Math.abs(at[at.length - 2] - 4.5)).toBeLessThan(0.02)
    expect(Math.abs(at[at.length - 1] - 5.25)).toBeLessThan(0.02)
  })

  it.runIf(PROBE)('WebM from raw frames: VP9 + Opus, every frame, tagged BT.601 limited range', () => {
    const job: ExportJob = withAudio({ ...base, ...small, format: 'webm', video: { kind: 'raw', encoder: 'libvpx-vp9', pixelFormat: 'rgba' }, outputPath: `/v/${tag}.webm` })
    const out = runPlan(ff, { ...job, audio: { clips: [clip(0, 2)], volume: 1 } }, beeps, path.join(dir, `${tag}-webm`))
    const info = probe(out)
    const v = info.streams.find((s) => s.codec_type === 'video')!
    const a = info.streams.find((s) => s.codec_type === 'audio')!
    expect(info.format.format_name).toContain('webm')
    expect([v.codec_name, Number(v.nb_read_frames), v.width, v.height]).toEqual(['vp9', 60, 320, 180])
    expect([v.color_space, v.color_primaries, v.color_transfer, v.color_range]).toEqual(['smpte170m', 'bt709', 'bt709', 'tv'])
    expect([a.codec_name, a.sample_rate]).toEqual(['opus', '48000'])
  })

  it.runIf(PROBE)('WebM from a WebCodecs-style IVF stream: copied, colour description written in', () => {
    const ivf = path.join(dir, `${tag}.ivf`)
    execFileSync(ffmpegPath(), ['-v', 'error', '-y', '-f', 'lavfi', '-i', 'testsrc2=size=320x180:rate=30', '-frames:v', '30', '-c:v', 'libvpx-vp9', '-deadline', 'realtime', '-f', 'ivf', ivf])
    const job: ExportJob = { ...base, ...small, frames: 30, format: 'webm', video: { kind: 'vp9', color }, outputPath: `/v/${tag}-copy.webm` }
    const output = path.join(dir, `${tag}-copy.webm`)
    const r = spawnSync(ff, exportArgs(job, { audioInput: null, output }), { input: require('node:fs').readFileSync(ivf) })
    expect(r.status, r.stderr.toString()).toBe(0)
    const v = probe(output).streams[0]
    expect([v.codec_name, Number(v.nb_read_frames), v.color_space, v.color_range]).toEqual(['vp9', 30, 'smpte170m', 'tv'])
  })

  it.runIf(PROBE)('MOV: QuickTime with tagged H.264 and AAC', () => {
    const job: ExportJob = withAudio({ ...base, ...small, format: 'mov', outputPath: `/v/${tag}.mov` })
    const out = runPlan(ff, { ...job, audio: { clips: [clip(0, 2)], volume: 1 } }, beeps, path.join(dir, `${tag}-mov`))
    const info = probe(out)
    const v = info.streams.find((s) => s.codec_type === 'video')!
    expect(info.format.format_name).toContain('mov')
    expect([v.codec_name, Number(v.nb_read_frames)]).toEqual(['h264', 60])
    expect([v.color_space, v.color_primaries, v.color_transfer, v.color_range]).toEqual(['smpte170m', 'bt709', 'bt709', 'tv'])
    expect(info.streams.find((s) => s.codec_type === 'audio')!.codec_name).toBe('aac')
  })

  it.runIf(PROBE)('a size target lands within 10% (x264 two-pass and VP9 two-pass)', () => {
    for (const format of ['mp4', 'webm'] as const) {
      const video = 300_000
      const job: ExportJob = {
        ...base,
        width: 640,
        height: 360,
        fps: 30,
        frames: 150,
        format,
        video: { kind: 'raw', encoder: format === 'webm' ? 'libvpx-vp9' : 'libx264', pixelFormat: 'rgba' },
        bitrate: { video, audio: 0 },
        outputPath: `/v/${tag}-target.${format}`
      }
      const out = runPlan(ff, job, null, path.join(dir, `${tag}-target-${format}`))
      const want = (video * 5) / 8
      const got = statSync(out).size
      expect(Math.abs(got / want - 1), `${format}: ${got} bytes for ${want}`).toBeLessThan(0.1)
      expect(Number(probe(out).streams[0].nb_read_frames)).toBe(150)
    }
  }, 120_000)
})

describe('the click sound source of the cursor contract', () => {
  it.runIf(PROBE)('is a valid lavfi source (whatever the cursor builder makes it)', async () => {
    const real = await vi.importActual<typeof import('../src/shared/render/clickSound')>('../src/shared/render/clickSound')
    const out = path.join(dir, 'click.wav')
    const r = spawnSync(ffmpegPath(), ['-v', 'error', '-y', '-f', 'lavfi', '-i', real.clickSoundSource(), '-t', '1', out])
    expect(r.status, r.stderr.toString()).toBe(0)
  })
})
