import { execFileSync } from 'node:child_process'
import { existsSync, mkdtempSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import path from 'node:path'
import { describe, expect, it } from 'vitest'
import { ffmpegPath } from '../src/main/ffmpeg'
import { cropFilter, muxAudioArgs, ON_TIMESTAMPS, proxyArgs, regionPixels, stemArgs } from '../src/main/proxyArgs'
import { fitContent } from '../src/shared/recording/windowGeometry'

const arg = (args: string[], flag: string): string | undefined => args[args.indexOf(flag) + 1]

describe('proxyArgs', () => {
  it('defaults to a fast software encode with short GOPs at 60 fps CFR', () => {
    const args = proxyArgs('in.webm', 'out.mp4', true)
    expect(arg(args, '-c:v')).toBe('libx264')
    expect(arg(args, '-preset')).toBe('superfast')
    expect(arg(args, '-g')).toBe('15')
    expect(arg(args, '-r')).toBe('60')
    expect(arg(args, '-fps_mode')).toBe('cfr')
    expect(args).toContain('aac')
    expect(args.at(-1)).toBe('out.mp4')
  })

  it('uses a detected GPU encoder with NV12 input where required', () => {
    const nv = proxyArgs('in.webm', 'out.mp4', false, { encoder: 'h264_nvenc' })
    expect(arg(nv, '-c:v')).toBe('h264_nvenc')
    expect(arg(nv, '-vf')).toContain('format=yuv420p')
    const qsv = proxyArgs('in.webm', 'out.mp4', false, { encoder: 'h264_qsv' })
    expect(arg(qsv, '-c:v')).toBe('h264_qsv')
    expect(arg(qsv, '-vf')).toContain('format=nv12')
    expect(arg(qsv, '-g')).toBe('15')
  })

  it('keeps the camera at its own frame rate', () => {
    expect(arg(proxyArgs('cam.webm', 'cam.mp4', false, { fps: 30 }), '-r')).toBe('30')
  })

  it('fits frames of another size into the fixed output without stretching', () => {
    const vf = arg(proxyArgs('in.webm', 'out.mp4', false, { size: { width: 1280, height: 720 } }), '-vf')!
    // fitContent's rule: the smaller scale of the two axes, centred, bars on both sides even.
    expect(vf).toContain('scale=w=max(2\\,1280-4*round((1280-iw*min(1280/iw\\,720/ih))/4)):h=max(2\\,720-4*round((720-ih*min(1280/iw\\,720/ih))/4))')
    expect(vf).toContain('pad=1280:720:(ow-iw)/2:(oh-ih)/2')
  })

  it('drops audio when there is none and can report progress', () => {
    const args = proxyArgs('in.webm', 'out.mp4', false, { progress: true })
    expect(args).toContain('-an')
    expect(args.join(' ')).toContain('-progress pipe:1 -nostats')
    expect(args.at(-1)).toBe('out.mp4')
  })

  it('makes Media Foundation use the GPU (it defaults to a software encoder)', () => {
    const mf = proxyArgs('in.webm', 'out.mp4', false, { encoder: 'h264_mf' })
    expect(arg(mf, '-c:v')).toBe('h264_mf')
    expect(arg(mf, '-hw_encoding')).toBe('1')
    expect(arg(mf, '-vf')).toContain('format=nv12')
  })

  it('can skip faststart for an intermediate file', () => {
    expect(proxyArgs('in.webm', 'out.mp4', false)).toContain('+faststart')
    expect(proxyArgs('in.webm', 'out.mp4', false, { faststart: false })).not.toContain('+faststart')
  })
})

describe('muxAudioArgs', () => {
  it('adds a separate audio file at its offset, cut to the video length', () => {
    const later = muxAudioArgs('v.mp4', 'o.mp4', { input: 'a.webm', offset: 0.25 }, 2.5)
    expect(later.join(' ')).toContain('-i v.mp4 -i a.webm')
    expect(later.join(' ')).toContain('-map 0:v:0 -map 1:a:0?')
    expect(arg(later, '-c:v')).toBe('copy')
    expect(arg(later, '-af')).toBe(`${ON_TIMESTAMPS},adelay=250:all=1,apad,atrim=end=2.500000`)
    expect(later.at(-1)).toBe('o.mp4')
    const earlier = muxAudioArgs('v.mp4', 'o.mp4', { input: 'a.webm', offset: -0.4 }, 3)
    expect(earlier.join(' ')).toContain('-ss 0.400 -i a.webm')
    expect(arg(earlier, '-af')).toBe(`${ON_TIMESTAMPS},apad,atrim=end=3.000000`)
    expect(earlier).toContain('aac')
  })

  it('leaves the audio untrimmed when the video length is unknown', () => {
    const args = muxAudioArgs('v.mp4', 'o.mp4', { input: 'a.webm', offset: 0 }, null)
    // Still placed on its timestamps (see 'recorded sound with a dropped packet').
    expect(arg(args, '-af')).toBe(ON_TIMESTAMPS)
  })
})

describe('regionPixels', () => {
  it('converts a normalised region to even pixels inside the frame', () => {
    expect(regionPixels({ x: 0.1, y: 0.2, w: 0.5, h: 0.5 }, 1920, 1080)).toEqual({ x: 192, y: 216, width: 960, height: 540 })
    const r = regionPixels({ x: 0.3337, y: 0.1, w: 0.6663, h: 0.3001 }, 1366, 768)
    expect(r.width % 2).toBe(0)
    expect(r.height % 2).toBe(0)
    expect(r.x + r.width).toBeLessThanOrEqual(1366)
  })
})

const ffmpeg = ffmpegPath()
const haveFfmpeg = ffmpeg !== 'ffmpeg' && existsSync(ffmpeg)

describe.skipIf(!haveFfmpeg)('proxy filters (real ffmpeg)', () => {
  const probeSize = (file: string): string =>
    execFileSync(ffmpeg, ['-hide_banner', '-i', file], { encoding: 'utf8', stdio: ['ignore', 'pipe', 'pipe'] }).toString()

  const sizeOf = (file: string): string => {
    try {
      probeSize(file)
    } catch (err) {
      const log = String((err as { stderr?: Buffer }).stderr ?? '')
      return /Video: [^\n]*?(\d{2,5}x\d{2,5})/.exec(log)?.[1] ?? 'none'
    }
    return 'none'
  }

  /** Container duration from ffmpeg's own banner ("Duration: 00:00:02.50"). */
  const containerSeconds = (file: string): number => {
    let log = ''
    try {
      execFileSync(ffmpeg, ['-hide_banner', '-i', file], { encoding: 'utf8', stdio: ['ignore', 'pipe', 'pipe'] })
    } catch (err) {
      log = String((err as { stderr?: Buffer }).stderr ?? '')
    }
    const m = /Duration: (\d+):(\d+):([\d.]+)/.exec(log)
    return m ? Number(m[1]) * 3600 + Number(m[2]) * 60 + Number(m[3]) : NaN
  }

  const makeInput = (dir: string, size: string): string => {
    const file = path.join(dir, `in-${size}.mkv`)
    execFileSync(ffmpeg, ['-hide_banner', '-loglevel', 'error', '-f', 'lavfi', '-i', `testsrc=size=${size}:rate=30:duration=0.5`, '-c:v', 'ffv1', file])
    return file
  }

  it('crops a region exactly to the computed pixel size', () => {
    const dir = mkdtempSync(path.join(tmpdir(), 'ssw-proxy-'))
    const region = { x: 0.25, y: 0.1, w: 0.5013, h: 0.4999 }
    const px = regionPixels(region, 1366, 768)
    const out = path.join(dir, 'crop.mp4')
    const args = proxyArgs(makeInput(dir, '1366x768'), out, false, { size: { width: px.width, height: px.height }, crop: region, fps: 30 })
    execFileSync(ffmpeg, args, { stdio: 'ignore' })
    expect(sizeOf(out)).toBe(`${px.width}x${px.height}`)
    expect(cropFilter(region)).toContain('exact=1')
  })

  it('gives the native proxy exactly the video duration, whether the audio runs longer or shorter (seams-2)', () => {
    const dir = mkdtempSync(path.join(tmpdir(), 'ssw-mux-'))
    const gen = (args: string[]): void => void execFileSync(ffmpeg, ['-hide_banner', '-loglevel', 'error', '-y', ...args])
    gen(['-f', 'lavfi', '-i', 'testsrc=size=320x240:rate=60:duration=2.5', '-c:v', 'libx264', '-g', '60', path.join(dir, 'native.mp4')])
    gen(['-f', 'lavfi', '-i', 'sine=duration=2.9', '-c:a', 'libopus', path.join(dir, 'long.webm')])
    gen(['-f', 'lavfi', '-i', 'sine=duration=1', '-c:a', 'libopus', path.join(dir, 'short.webm')])
    const video = path.join(dir, 'video.mp4')
    execFileSync(ffmpeg, proxyArgs(path.join(dir, 'native.mp4'), video, false, { fps: 60, faststart: false }), { stdio: 'ignore' })
    for (const [audio, offset] of [['long.webm', 0.05], ['short.webm', 0.5], ['long.webm', -0.2]] as const) {
      const out = path.join(dir, `out-${audio}-${offset}.mp4`)
      execFileSync(ffmpeg, muxAudioArgs(video, out, { input: path.join(dir, audio), offset }, 150 / 60, false), { stdio: 'ignore' })
      // The container is exactly as long as the video: no frozen frames after the last one.
      expect(containerSeconds(out)).toBeCloseTo(2.5, 2)
    }
  })

  it('fits a window resized mid-recording by fitContent\'s rule, centred (cursor mapping matches the pixels)', () => {
    const dir = mkdtempSync(path.join(tmpdir(), 'ssw-proxy-'))
    const gen = (args: string[]): void => void execFileSync(ffmpeg, ['-hide_banner', '-loglevel', 'error', '-y', ...args])
    // White window content; like Chromium's WebM, the frame size changes mid-stream.
    const sizes = [
      { width: 1280, height: 720 },
      { width: 1000, height: 640 },
      { width: 1280, height: 520 }
    ]
    const parts = sizes.map(({ width, height }, i) => {
      const file = path.join(dir, `part${i}.webm`)
      gen(['-f', 'lavfi', '-i', `color=white:size=${width}x${height}:rate=30:duration=0.4`, '-c:v', 'libvpx', '-b:v', '1M', file])
      return `file '${file}'`
    })
    writeFileSync(path.join(dir, 'list.txt'), parts.join('\n'))
    const input = path.join(dir, 'resized.webm')
    gen(['-f', 'concat', '-safe', '0', '-i', path.join(dir, 'list.txt'), '-c', 'copy', input])
    const out = { width: 1280, height: 720 }
    const proxy = path.join(dir, 'proxy.mp4')
    execFileSync(ffmpeg, proxyArgs(input, proxy, false, { size: out, fps: 30 }), { stdio: 'ignore' })
    expect(sizeOf(proxy)).toBe('1280x720')
    sizes.forEach((content, i) => {
      // The middle of each part, as 8-bit grey.
      const frame = execFileSync(ffmpeg, ['-hide_banner', '-loglevel', 'error', '-ss', String(i * 0.4 + 0.2), '-i', proxy, '-frames:v', '1', '-f', 'rawvideo', '-pix_fmt', 'gray', '-'], {
        maxBuffer: 16 << 20
      })
      const lit = (x: number, y: number): boolean => frame[y * out.width + x] > 128
      const row = Array.from({ length: out.width }, (_, x) => lit(x, out.height >> 1))
      const col = Array.from({ length: out.height }, (_, y) => lit(out.width >> 1, y))
      const fit = fitContent(content, out)
      // Within a pixel of the exact (fractional) fit: what the cursor mapping assumes.
      expect(Math.abs(row.indexOf(true) - fit.dx)).toBeLessThanOrEqual(1)
      expect(Math.abs(row.lastIndexOf(true) + 1 - (fit.dx + fit.width))).toBeLessThanOrEqual(1)
      expect(Math.abs(col.indexOf(true) - fit.dy)).toBeLessThanOrEqual(1)
      expect(Math.abs(col.lastIndexOf(true) + 1 - (fit.dy + fit.height))).toBeLessThanOrEqual(1)
    })
  }, 60000)

  it('fits a differently sized frame (resized window) into the fixed output size', () => {
    const dir = mkdtempSync(path.join(tmpdir(), 'ssw-proxy-'))
    const out = path.join(dir, 'fit.mp4')
    execFileSync(ffmpeg, proxyArgs(makeInput(dir, '1000x640'), out, false, { size: { width: 1280, height: 720 }, fps: 30 }), { stdio: 'ignore' })
    expect(sizeOf(out)).toBe('1280x720')
  })
})

describe('stemArgs', () => {
  it('shifts a stem like the mixed sound, pads and cuts it to the video, as AAC only', () => {
    const later = stemArgs('mic.webm', 'mic.m4a', 0.25, 2.5)
    expect(arg(later, '-af')).toBe(`${ON_TIMESTAMPS},adelay=250:all=1,apad,atrim=end=2.500000`)
    expect(later).not.toContain('-ss')
    expect(later.join(' ')).toContain('-map 0:a:0 -vn')
    expect(arg(later, '-c:a')).toBe('aac')
    expect(later[later.length - 1]).toBe('mic.m4a')
    const earlier = stemArgs('system.webm', 'system.m4a', -0.5, null)
    expect(arg(earlier, '-ss')).toBe('0.500')
    expect(earlier.indexOf('-ss')).toBeLessThan(earlier.indexOf('-i'))
    expect(arg(earlier, '-af')).toBe(ON_TIMESTAMPS)
  })

  it('makes a stem exactly as long as the video with ffmpeg', () => {
    const dir = mkdtempSync(path.join(tmpdir(), 'ssw-stem-'))
    const raw = path.join(dir, 'mic.webm')
    execFileSync(ffmpegPath(), ['-v', 'error', '-f', 'lavfi', '-i', 'sine=frequency=500:sample_rate=48000', '-t', '1.7', '-c:a', 'libopus', raw])
    const out = path.join(dir, 'mic.m4a')
    execFileSync(ffmpegPath(), stemArgs(raw, out, 0.1, 2.25))
    const pcm = execFileSync(ffmpegPath(), ['-v', 'error', '-i', out, '-ac', '1', '-ar', '48000', '-f', 'f32le', '-'], { maxBuffer: 1 << 26 })
    // AAC rounds the end up to its last frame (a few ms past the video, never short of it).
    const seconds = pcm.length / 4 / 48000
    expect(seconds).toBeGreaterThanOrEqual(2.25)
    expect(seconds).toBeLessThan(2.25 + 0.03)
    // Silent for the offset, then the tone.
    const s = new Float32Array(pcm.buffer, pcm.byteOffset, pcm.length / 4)
    const peak = (a: number, b: number): number => Math.max(...Array.from(s.subarray(a * 48, b * 48), Math.abs))
    expect(peak(0, 80)).toBeLessThan(0.01)
    expect(peak(150, 400)).toBeGreaterThan(0.05)
  })
})

describe.skipIf(!haveFfmpeg)('recorded sound with a dropped packet (real ffmpeg)', () => {
  const run = (args: string[]): void => void execFileSync(ffmpeg, ['-hide_banner', '-loglevel', 'error', '-y', ...args])

  /** The first audio stream of `file`, mono at 48 kHz. */
  const decode = (file: string): Float32Array => {
    const pcm = execFileSync(ffmpeg, ['-v', 'error', '-i', file, '-map', '0:a:0', '-ac', '1', '-ar', '48000', '-f', 'f32le', '-'], { maxBuffer: 1 << 26 })
    return new Float32Array(pcm.buffer, pcm.byteOffset, pcm.length / 4)
  }
  const onset = (s: Float32Array): number => s.findIndex((v) => Math.abs(v) > 0.1) / 48000

  /**
   * A MediaRecorder-like Opus track in WebM (60 ms packets) with a beep at 1.5 s, and packet 10
   * (0.6-0.66 s) dropped, as the recorder does under load: the timestamps jump over it.
   * `video` adds a picture stream (the Chromium screen recording with its mixed sound).
   */
  const gapped = (dir: string, video = false): string => {
    const tone = path.join(dir, 'tone.wav')
    run(['-f', 'lavfi', '-i', 'aevalsrc=0.5*between(t\\,1.5\\,1.7)*sin(2*PI*500*t):s=48000:d=2.4', tone])
    const whole = path.join(dir, video ? 'whole-av.webm' : 'whole.webm')
    run([
      ...(video ? ['-f', 'lavfi', '-i', 'color=gray:size=320x240:rate=30:duration=2.4'] : []),
      '-i', tone,
      ...(video ? ['-c:v', 'libvpx', '-b:v', '200k'] : []),
      '-c:a', 'libopus', '-frame_duration', '60', whole
    ])
    const out = path.join(dir, video ? 'gapped-av.webm' : 'gapped.webm')
    run(['-i', whole, '-map', '0', '-c', 'copy', '-bsf:a', 'noise=drop=eq(n\\,10)', out])
    return out
  }

  it('keeps a stem as long as the video, with the sound after the gap on time', () => {
    const dir = mkdtempSync(path.join(tmpdir(), 'ssw-gap-'))
    const out = path.join(dir, 'mic.m4a')
    execFileSync(ffmpeg, stemArgs(gapped(dir), out, 0, 2.4), { stdio: 'ignore' })
    const s = decode(out)
    // Encoded as is, the stem was 60 ms short and the beep 60 ms early.
    expect(s.length / 48000).toBeGreaterThanOrEqual(2.4)
    expect(Math.abs(onset(s) - 1.5)).toBeLessThan(0.01)
  })

  it("keeps the native recording's sound on time after the gap", () => {
    const dir = mkdtempSync(path.join(tmpdir(), 'ssw-gap-'))
    const video = path.join(dir, 'video.mp4')
    run(['-f', 'lavfi', '-i', 'testsrc=size=320x240:rate=30:duration=2.4', '-c:v', 'libx264', video])
    const out = path.join(dir, 'screen.mp4')
    execFileSync(ffmpeg, muxAudioArgs(video, out, { input: gapped(dir), offset: 0 }, 2.4, false), { stdio: 'ignore' })
    const s = decode(out)
    expect(s.length / 48000).toBeGreaterThanOrEqual(2.4)
    expect(Math.abs(onset(s) - 1.5)).toBeLessThan(0.01)
  })

  it('leaves a packet that arrives a little late alone: no silence is inserted into the sound', () => {
    const dir = mkdtempSync(path.join(tmpdir(), 'ssw-late-'))
    const tone = path.join(dir, 'tone.wav')
    run(['-f', 'lavfi', '-i', 'aevalsrc=0.5*sin(2*PI*500*t):s=48000:d=2.4', tone])
    const whole = path.join(dir, 'whole.webm')
    run(['-i', tone, '-c:a', 'libopus', '-frame_duration', '60', whole])
    // Packets from the 11th on are stamped 25 ms late (the WebM time base is 1 ms).
    const late = path.join(dir, 'late.webm')
    run(['-i', whole, '-c', 'copy', '-bsf:a', 'setts=ts=TS+if(gte(N\\,10)\\,25\\,0)', late])
    const out = path.join(dir, 'mic.m4a')
    execFileSync(ffmpeg, stemArgs(late, out, 0, 2.4), { stdio: 'ignore' })
    const s = decode(out)
    // The longest run of near-silence inside the continuous tone (a 500 Hz sine crosses zero
    // every 1 ms, so a run of a few ms can only be inserted silence).
    let longest = 0
    let run0 = -1
    for (let i = Math.round(0.1 * 48000); i < Math.round(2.3 * 48000); i++) {
      if (Math.abs(s[i]) < 0.01) {
        if (run0 < 0) run0 = i
        longest = Math.max(longest, i - run0 + 1)
      } else run0 = -1
    }
    expect(longest / 48000).toBeLessThan(0.005)
  })

  it("keeps a Chromium recording's mixed sound on time after the gap", () => {
    const dir = mkdtempSync(path.join(tmpdir(), 'ssw-gap-'))
    const out = path.join(dir, 'screen.mp4')
    execFileSync(ffmpeg, proxyArgs(gapped(dir, true), out, true, { fps: 30 }), { stdio: 'ignore' })
    expect(Math.abs(onset(decode(out)) - 1.5)).toBeLessThan(0.01)
  })
})
