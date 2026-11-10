// The WAV format and the stems' ffmpeg arguments and names (docs/design/output-and-languages.md §7,
// §23.1 tests 30 and 35): the WAV format is the M4A job's soundtrack byte for byte, written as 32-bit
// float WAV; each stem's output carries no input's tags and a BWF chunk from sample 0; stem names are
// free and never the video's.
import { execFileSync, spawnSync } from 'node:child_process'
import { mkdtempSync, readFileSync, rmSync } from 'node:fs'
import { tmpdir } from 'node:os'
import path from 'node:path'
import { describe, expect, it } from 'vitest'
import { ffmpegPlan, GRAPH_INLINE_MAX } from '../src/main/exportArgs'
import { ffmpegPath } from '../src/main/ffmpeg'
import { stemOutputArgs, stemPaths, wavPlan } from '../src/main/stemsArgs'
import type { ExportJob } from '../src/shared/api/export'

/** An audio-only job of `seconds` (the exporter's M4A job: no video, 60 fps). */
const audioJob = (format: 'm4a' | 'wav', over: Partial<ExportJob> = {}): ExportJob => ({
  width: 0,
  height: 0,
  fps: 60,
  frames: 180,
  format,
  quality: 'high',
  video: { kind: 'none' },
  audio: { clips: [{ id: 'a', start: 0, end: 1, speed: 1 }, { id: 'b', start: 2, end: 4, speed: 1.5 }], volume: 0.9, normalize: true, stems: { mic: 1, system: 0.5 } },
  music: { file: 'music-1.mp3', volume: 0.4, loop: true, fadeIn: 1, fadeOut: 1, duration: null },
  clicks: { times: [0.5, 2], volume: 0.6 },
  fadeOut: 0.5,
  chapters: [{ start: 0, title: 'Intro' }, { start: 1.5, title: 'Main' }],
  bitrate: { video: 0, audio: 96_000 },
  outputPath: '/o/out',
  ...over
})
const given = { audioInput: '/p/screen.mp4', stems: { mic: '/p/mic.m4a', system: '/p/system.m4a' }, music: '/p/music-1.mp3', output: '/o/.out.partial', tempStem: '/t/s' }

const graphOf = (args: string[]): string => args[args.indexOf('-filter_complex') + 1]
/** The arguments before the graph (the inputs). */
const inputsOf = (args: string[]): string[] => args.slice(0, args.indexOf('-filter_complex'))

describe('the WAV format (test 30)', () => {
  it("is the M4A job's soundtrack graph, byte for byte, with the same inputs", () => {
    const m4a = ffmpegPlan(audioJob('m4a', { chapters: undefined }), given)
    const wav = wavPlan(audioJob('wav'), given)
    expect(graphOf(wav.capture)).toBe(graphOf(m4a.capture))
    expect(graphOf(wav.capture)).toContain('loudnorm')
    expect(inputsOf(wav.capture)).toEqual(inputsOf(m4a.capture))
    expect(wav.passes).toEqual([])
  })

  it('writes 32-bit float PCM at 48 kHz as WAV, RF64 past 4 GiB, with no chapters and no input tags', () => {
    const args = wavPlan(audioJob('wav'), given).capture
    const tail = args.slice(args.indexOf('[aout]') + 1)
    expect(tail).toEqual(['-map_metadata:g', '-1', '-map_chapters', '-1', '-c:a', 'pcm_f32le', '-ar', '48000', '-rf64', 'auto', '-f', 'wav', '/o/.out.partial'])
    expect(args.join(' ')).toContain('-c:a pcm_f32le -ar 48000 -rf64 auto -f wav')
    // No AAC, no bit rate, no M4A container, no chapters file: a WAV holds none of them.
    for (const gone of ['aac', '-b:a', 'ipod', '-movflags', 'ffmetadata']) expect(args).not.toContain(gone)
  })

  it('moves a long graph into a script file as every export does', () => {
    const clips = Array.from({ length: 400 }, (_, i) => ({ id: `c${i}`, start: i, end: i + 0.5, speed: 1 }))
    const job = audioJob('wav', { frames: 60 * 200, audio: { clips, volume: 1 } })
    const plan = wavPlan(job, given)
    const m4a = ffmpegPlan({ ...job, format: 'm4a', chapters: undefined }, given)
    expect(plan.capture).toContain('-filter_complex_script')
    expect(plan.scripts).toEqual(m4a.scripts)
    expect(plan.scripts).toHaveLength(1)
    expect(plan.scripts[0].content.length).toBeGreaterThan(GRAPH_INLINE_MAX)
    expect(plan.temps).toEqual([plan.scripts[0].path])
  })

  it('a job with nothing to hear is refused as the same job in M4A is', () => {
    const silent = audioJob('wav', { audio: { clips: [], volume: 1 }, music: undefined, clicks: undefined })
    expect(() => ffmpegPlan({ ...silent, format: 'm4a' }, given)).toThrow(/no sound to export/)
    expect(() => wavPlan(silent, given)).toThrow(/no sound to export/)
  })

  it('ffmpegPlan sends the WAV format to it', () => {
    expect(ffmpegPlan(audioJob('wav'), given)).toEqual(wavPlan(audioJob('wav'), given))
  })

  it('makes a float WAV with the Linux ffmpeg', () => {
    const dir = mkdtempSync(path.join(tmpdir(), 'ssw-wav-'))
    try {
      const ff = ffmpegPath()
      const source = path.join(dir, 'screen.wav')
      execFileSync(ff, ['-v', 'error', '-f', 'lavfi', '-i', 'aevalsrc=0.4*sin(2*PI*440*t):s=48000:c=mono', '-t', '4', '-c:a', 'pcm_s16le', source])
      const out = path.join(dir, 'out.wav')
      const job = audioJob('wav', { audio: { clips: [{ id: 'a', start: 0, end: 3, speed: 1 }], volume: 1 }, music: undefined, clicks: undefined })
      const plan = wavPlan(job, { audioInput: source, output: out, tempStem: path.join(dir, 's') })
      const r = spawnSync(ff, plan.capture, { encoding: 'utf8' })
      expect(r.status, r.stderr).toBe(0)
      const b = readFileSync(out)
      expect(b.toString('ascii', 0, 4)).toBe('RIFF')
      const fmt = b.indexOf('fmt ')
      const tag = b.readUInt16LE(fmt + 8)
      // IEEE float (3), directly or as WAVE_FORMAT_EXTENSIBLE's sub-format; 32 bits; 48 kHz.
      expect(tag === 0xfffe ? b.readUInt16LE(fmt + 32) : tag).toBe(3)
      expect(b.readUInt32LE(fmt + 12)).toBe(48000)
      expect(b.readUInt16LE(fmt + 22)).toBe(32)
      // The video's length: 180 frames at 60 fps, 3 s of mono float.
      const data = b.indexOf('data')
      expect(b.readUInt32LE(data + 4)).toBe(3 * 48000 * 4)
    } finally {
      rmSync(dir, { recursive: true, force: true })
    }
  })
})

describe("a stem's output arguments", () => {
  it('float WAV with a BWF chunk from sample 0 naming the stem in English, and no input tags', () => {
    expect(stemOutputArgs('system', '/o/Demo - System sound.wav')).toEqual([
      '-map_metadata', '-1',
      '-c:a', 'pcm_f32le', '-ar', '48000', '-rf64', 'auto',
      '-write_bext', '1',
      '-metadata', 'time_reference=0',
      '-metadata', 'originator=Flown',
      '-metadata', 'description=System sound',
      '-f', 'wav', '/o/Demo - System sound.wav'
    ])
  })
})

describe('stem names next to the video (test 35)', () => {
  it('"<base> - <Word>.wav" next to the video, in the order asked', () => {
    expect(stemPaths('/v/Demo.mp4', ['voice', 'system', 'music', 'effects'], () => false)).toEqual({
      voice: '/v/Demo - Voice.wav',
      system: '/v/Demo - System sound.wav',
      music: '/v/Demo - Music.wav',
      effects: '/v/Demo - Effects.wav'
    })
    expect(stemPaths('/v/My.video.webm', ['recording'], () => false)).toEqual({ recording: '/v/My.video - Recording.wav' })
  })

  it('adds " (2)", " (3)" for taken names and never replaces a file', () => {
    const taken = new Set(['/v/Demo - Voice.wav', '/v/Demo - Voice (2).wav', '/v/Demo - Music.wav'])
    expect(stemPaths('/v/Demo.mp4', ['voice', 'music', 'effects'], (p) => taken.has(p))).toEqual({
      voice: '/v/Demo - Voice (3).wav',
      music: '/v/Demo - Music (2).wav',
      effects: '/v/Demo - Effects.wav'
    })
  })

  it('never returns the video path, whatever exists says', () => {
    for (const output of ['/v/Demo.wav', '/v/Demo - Voice.wav', '/v/demo - voice - Voice.WAV']) {
      const paths = Object.values(stemPaths(output, ['voice', 'system', 'recording', 'music', 'effects'], () => false))
      expect(paths).toHaveLength(5)
      expect(new Set(paths).size).toBe(5)
      for (const p of paths) expect(p!.toLowerCase()).not.toBe(output.toLowerCase())
    }
  })
})
