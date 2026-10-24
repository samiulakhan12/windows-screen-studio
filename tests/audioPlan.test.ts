// The export's soundtrack graph (shared/render/audioPlan): stems, noise reduction, loudness,
// music with fades and ducking, whole-soundtrack fades, and exact backwards compatibility.
// Graphs are checked as strings and by running them through ffmpeg.
import { execFileSync, spawnSync } from 'node:child_process'
import { mkdtempSync, readFileSync, rmSync } from 'node:fs'
import { tmpdir } from 'node:os'
import path from 'node:path'
import { afterAll, describe, expect, it } from 'vitest'
import { exportArgs, ffmpegPlan } from '../src/main/exportArgs'
import { ffmpegPath } from '../src/main/ffmpeg'
import type { ExportJob } from '../src/shared/api/export'
import { DUCK_TIMING } from '../src/shared/audio/automation'
import { denoiseFilter, musicGraph, NORMALIZE_FILTERS, planSoundtrack, recordingGraph, soundtrackGraph } from '../src/shared/render/audioPlan'
import type { Clip } from '../src/shared/types'

const clip = (start: number, end: number, speed = 1): Clip => ({ id: `${start}`, start, end, speed })

/** An audio-only (M4A) job of `seconds`. */
const m4a = (seconds: number, over: Partial<ExportJob> = {}): ExportJob => ({
  width: 0,
  height: 0,
  fps: 60,
  frames: Math.round(seconds * 60),
  format: 'm4a',
  quality: 'high',
  video: { kind: 'none' },
  outputPath: '/o.m4a',
  ...over
})

describe('backwards compatibility', () => {
  // Arguments the previous version produced for these jobs (generated from it).
  const legacy = JSON.parse(readFileSync(path.join(__dirname, 'fixtures/legacy-audio-args.json'), 'utf8')) as Record<string, string[]>
  const base: ExportJob = { width: 1280, height: 720, fps: 30, frames: 150, format: 'mp4', quality: 'high', video: { kind: 'raw', encoder: 'libx264', pixelFormat: 'rgba' }, outputPath: '/o.mp4' }
  const clips = [{ id: 'a', start: 0, end: 2, speed: 1 }, { id: 'b', start: 3, end: 5, speed: 2 }, { id: 'c', start: 6, end: 7, speed: 0.5 }]
  const io = { audioInput: '/p/screen.mp4', output: '/tmp/out.mp4' }
  const cases: Record<string, ExportJob> = {
    audio: { ...base, audio: { clips, volume: 0.8 } },
    audioClicks: { ...base, audio: { clips, volume: 1 }, clicks: { times: [0.5, 1, 4.2], volume: 0.6 } },
    clicks: { ...base, clicks: { times: [0.5, 4.9], volume: 1 } },
    m4a: { ...base, format: 'm4a', width: 0, height: 0, fps: 60, frames: 300, video: { kind: 'none' }, audio: { clips: [clips[0]], volume: 1.5 } }
  }
  for (const [name, job] of Object.entries(cases)) {
    it(`a project without stems, music or new settings exports exactly as before (${name})`, () => {
      expect(exportArgs(job, io)).toEqual(legacy[name])
    })
  }
  it('zero fades, no noise reduction and no normalisation change nothing', () => {
    const job = { ...cases.audio, fadeIn: 0, fadeOut: 0, audio: { clips, volume: 0.8, noiseReduction: 0, normalize: false } }
    expect(exportArgs(job, io)).toEqual(legacy.audio)
  })
})

describe('recording graph', () => {
  it('mixes two stems with their gains, cleans only the microphone, then cuts once', () => {
    const g = recordingGraph(
      {
        clips: [clip(0, 2), clip(3, 5, 2)],
        volume: 0.9,
        input: '1:a',
        stems: [
          { input: '1:a', gain: 1.5, denoise: true },
          { input: '2:a', gain: 1, denoise: false }
        ],
        noiseReduction: 0.5
      },
      3
    )
    expect(g).toContain(`[1:a]aresample=async=1:first_pts=0,${denoiseFilter(0.5)},volume=1.5[m0]`)
    expect(g).toContain('[2:a]aresample=async=1:first_pts=0[m1]')
    expect(g).toContain('[m0][m1]amix=inputs=2:duration=longest:dropout_transition=0:normalize=0,asplit=2[s0][s1]')
    expect(g).toContain('[s1]atrim=start=3:end=5,asetpts=PTS-STARTPTS,apad=whole_dur=2,atrim=end=2,atempo=2[c1]')
    expect(g).toMatch(/concat=n=2:v=0:a=1,volume=0\.9,apad=whole_dur=3,atrim=end=3\[aout\]$/)
  })

  it('cleans and normalises the mixed track when there are no stems', () => {
    const g = recordingGraph({ clips: [clip(0, 4)], volume: 1, input: '1:a', noiseReduction: 1, normalize: true }, 4)
    expect(g.startsWith(`[1:a]aresample=async=1:first_pts=0,${denoiseFilter(1)}[s0]`)).toBe(true)
    expect(g).toContain(`[c0]${NORMALIZE_FILTERS},apad=whole_dur=4`)
    expect(NORMALIZE_FILTERS).toContain('loudnorm=I=-16:TP=-1.5:LRA=11')
    expect(denoiseFilter(0)).toBe('afftdn=nr=8:nf=-60')
    expect(denoiseFilter(0.5)).toBe('afftdn=nr=19:nf=-46')
    expect(denoiseFilter(1)).toBe('afftdn=nr=30:nf=-32')
  })

  it('a single stem needs no mixing', () => {
    const g = recordingGraph({ clips: [clip(0, 4)], volume: 1, input: '3:a', stems: [{ input: '3:a', gain: 0.5, denoise: false }] }, 4)
    expect(g.startsWith('[3:a]aresample=async=1:first_pts=0,volume=0.5[s0]')).toBe(true)
  })
})

describe('music and the whole soundtrack', () => {
  it('cuts the music where it ends, fades and ducks it, then pads to the length', () => {
    const g = musicGraph({ input: '2:a', volume: 0.4, end: 6, fadeIn: 1, fadeOut: 2, duck: '1-0.5*clip(t,0,1)' }, 10)
    expect(g).toBe(
      "[2:a]aresample=async=1:first_pts=0,atrim=end=6,volume=0.4,afade=t=in:st=0:d=1,afade=t=out:st=4:d=2,asetnsamples=n=256:p=0,volume=volume='1-0.5*clip(t,0,1)':eval=frame,apad=whole_dur=10,atrim=end=10[mus]"
    )
  })

  it('reads the recording, then the music (looped by the demuxer), then the clicks', () => {
    const job = m4a(10, {
      audio: { clips: [clip(0, 10)], volume: 1 },
      music: { file: 'music.mp3', volume: 0.5, loop: true, fadeIn: 1, fadeOut: 1, duration: 3, duck: { depth: 0.7, ...DUCK_TIMING, ranges: [{ start: 2, end: 4 }] } },
      clicks: { times: [5], volume: 1 },
      fadeIn: 0.5,
      fadeOut: 1
    })
    const plan = planSoundtrack(job, { mix: '/p/screen.mp4', music: '/p/music.mp3' }, 0)
    expect(plan.args.slice(0, 9)).toEqual(['-vn', '-i', '/p/screen.mp4', '-stream_loop', '-1', '-vn', '-i', '/p/music.mp3', '-f'])
    expect(plan.graph).toContain('[1:a]aresample=async=1:first_pts=0,atrim=end=10,volume=0.5')
    expect(plan.graph).toContain("volume=volume='1-0.7*clip((t-1.85)/0.15,0,1)*clip((4.45-t)/0.45,0,1)':eval=frame")
    expect(plan.graph).toMatch(/\[rec\]\[mus\]\[clk\]amix=inputs=3:duration=first:dropout_transition=0:normalize=0,afade=t=in:st=0:d=0\.5,afade=t=out:st=9:d=1\[aout\]$/)
  })

  it('stops a non-looping track where it ends', () => {
    const job = m4a(10, { music: { file: 'music.mp3', volume: 1, loop: false, fadeIn: 0, fadeOut: 1, duration: 4 } })
    const plan = planSoundtrack(job, { mix: null, music: '/p/music.mp3' }, 0)
    expect(plan.args).toEqual(['-vn', '-i', '/p/music.mp3'])
    expect(plan.graph).toBe('[0:a]aresample=async=1:first_pts=0,atrim=end=4,afade=t=out:st=3:d=1,apad=whole_dur=10,atrim=end=10[aout]')
  })

  it('fades a lone recording with its own last step', () => {
    const g = soundtrackGraph({ duration: 5, audio: { clips: [clip(0, 5)], volume: 1, input: '1:a' }, fadeIn: 1 })!
    expect(g).toMatch(/\[rec\];\[rec\]afade=t=in:st=0:d=1\[aout\]$/)
  })

  it('reads the stems the job asks for, and refuses when one is missing', () => {
    const job = m4a(4, { audio: { clips: [clip(0, 4)], volume: 1, stems: { mic: 1, system: 0.5 }, noiseReduction: 0.3 } })
    const plan = planSoundtrack(job, { mix: '/p/screen.mp4', stems: { mic: '/p/mic.m4a', system: '/p/system.m4a' } }, 0)
    expect(plan.args).toEqual(['-vn', '-i', '/p/mic.m4a', '-vn', '-i', '/p/system.m4a'])
    expect(plan.graph).toContain(`[0:a]aresample=async=1:first_pts=0,${denoiseFilter(0.3)}[m0]`)
    expect(plan.graph).toContain('[1:a]aresample=async=1:first_pts=0,volume=0.5[m1]')
    expect(() => planSoundtrack(job, { mix: '/p/screen.mp4', stems: { mic: '/p/mic.m4a' } }, 0)).toThrow(/system sound/)
  })

  it('long ducking graphs go into a script file', () => {
    const ranges = Array.from({ length: 400 }, (_, i) => ({ start: i * 2, end: i * 2 + 1 }))
    const job: ExportJob = { ...m4a(800), music: { file: 'music.mp3', volume: 1, loop: true, fadeIn: 0, fadeOut: 0, duration: null, duck: { depth: 0.5, ...DUCK_TIMING, ranges } } }
    const plan = ffmpegPlan(job, { audioInput: null, music: '/p/music.mp3', output: '/tmp/o.m4a', tempStem: '/tmp/s' })
    expect(plan.capture).toContain('-filter_complex_script')
    expect(plan.scripts[0].content).toContain("volume=volume='1-0.5*if(lt(t,")
  })
})

describe('soundtrack graphs with ffmpeg', () => {
  const dir = mkdtempSync(path.join(tmpdir(), 'ssw-audioplan-'))
  afterAll(() => rmSync(dir, { recursive: true, force: true }))
  const ff = ffmpegPath()
  // Measured at the export's own rate: resampling to a low rate would delay the signal a little.
  const RATE = 48000

  const make = (name: string, lavfi: string, seconds: number): string => {
    const file = path.join(dir, name)
    execFileSync(ff, ['-v', 'error', '-f', 'lavfi', '-i', lavfi, '-t', String(seconds), '-c:a', 'aac', '-b:a', '128k', file])
    return file
  }

  /** Runs a planned soundtrack and returns its mono samples. */
  function render(job: ExportJob, files: Parameters<typeof planSoundtrack>[1]): Float32Array {
    const plan = planSoundtrack(job, files, 0)
    const r = spawnSync(ff, ['-v', 'error', ...plan.args, '-filter_complex', plan.graph!, '-map', '[aout]', '-ac', '1', '-ar', String(RATE), '-f', 'f32le', '-'], { maxBuffer: 1 << 28 })
    expect(r.status, r.stderr.toString()).toBe(0)
    return new Float32Array(r.stdout.buffer, r.stdout.byteOffset, r.stdout.length / 4)
  }

  /** RMS of [from, to) seconds. */
  const rms = (s: Float32Array, from: number, to: number): number => {
    let sum = 0
    const a = Math.round(from * RATE)
    const b = Math.round(to * RATE)
    for (let i = a; i < b; i++) sum += s[i] * s[i]
    return Math.sqrt(sum / (b - a))
  }

  it('music: fades in, loops, ducks under the recording, fades out, exactly as long as the video', () => {
    // A 3 s tone looped under an 8 s video, ducked by 80% from 3 to 5 s.
    const music = make('music.m4a', 'sine=frequency=440:sample_rate=48000', 3)
    const job = m4a(8, { music: { file: 'music.m4a', volume: 1, loop: true, fadeIn: 1, fadeOut: 1, duration: 3, duck: { depth: 0.8, ...DUCK_TIMING, ranges: [{ start: 3, end: 5 }] } } })
    const out = render(job, { mix: null, music })
    expect(out.length / RATE).toBeCloseTo(8, 2)
    const full = rms(out, 1.5, 2.5)
    // lavfi's sine is at 1/8 of full scale.
    expect(full).toBeGreaterThan(0.08)
    expect(rms(out, 0, 0.2) / full).toBeLessThan(0.15)
    // Looped: still playing after the 3 s file ended.
    expect(rms(out, 5.8, 6.6) / full).toBeCloseTo(1, 1)
    // Ducked to 20% while the recording has sound.
    expect(rms(out, 3.2, 4.8) / full).toBeCloseTo(0.2, 1)
    // The ramp starts before the sound (attack) and recovers after it (release).
    expect(rms(out, 2.86, 2.9) / full).toBeLessThan(0.9)
    expect(rms(out, 5.5, 5.6) / full).toBeCloseTo(1, 1)
    // Fade-out to silence at the end.
    expect(rms(out, 7.85, 8) / full).toBeLessThan(0.15)
  })

  it('stems: each source at its own gain, joined over a cut', () => {
    const mic = make('mic.m4a', "sine=frequency=1000:sample_rate=48000,volume='if(lt(t,2),1,0)':eval=frame", 4)
    const sys = make('system.m4a', "sine=frequency=300:sample_rate=48000,volume='if(gte(t,2),1,0)':eval=frame", 4)
    const job = m4a(3, { audio: { clips: [clip(0, 1.5), clip(2.5, 4)], volume: 1, stems: { mic: 0.25, system: 1 } } })
    const out = render(job, { mix: null, stems: { mic, system: sys } })
    expect(out.length / RATE).toBeCloseTo(3, 2)
    const micLevel = rms(out, 0.2, 1.3)
    const sysLevel = rms(out, 1.7, 2.8)
    expect(micLevel / sysLevel).toBeCloseTo(0.25, 1)
  })

  it('normalises a quiet recording to about -16 LUFS without moving it in time', () => {
    const quiet = make('quiet.m4a', "anoisesrc=color=pink:amplitude=0.05:seed=3,lowpass=f=5000,volume='if(lt(mod(t,1),0.5),1,0.05)':eval=frame", 8)
    const job = m4a(8, { audio: { clips: [clip(0, 8)], volume: 1, normalize: true } })
    const plan = planSoundtrack(job, { mix: quiet }, 0)
    const r = spawnSync(ff, ['-hide_banner', '-nostats', ...plan.args, '-filter_complex', `${plan.graph!};[aout]ebur128=framelog=quiet[m]`, '-map', '[m]', '-f', 'null', '-'], { encoding: 'utf8' })
    const loudness = Number(/I:\s+(-?[\d.]+) LUFS/.exec(r.stderr)?.[1])
    expect(loudness).toBeGreaterThan(-17.5)
    expect(loudness).toBeLessThan(-14.5)
    // Still bursts at the start of every second, exactly as long as the video.
    const out = render(job, { mix: quiet })
    expect(out.length / RATE).toBeCloseTo(8, 2)
    for (let s = 2; s < 7; s++) {
      expect(rms(out, s + 0.01, s + 0.04) / rms(out, s - 0.04, s - 0.01)).toBeGreaterThan(4)
    }
  })

  it('noise reduction lowers the noise between sounds, more at higher strength, and keeps the sound', () => {
    // A tone every other second over steady pink noise (a fan, a noisy room).
    const file = path.join(dir, 'noisy.m4a')
    execFileSync(ff, [
      '-v', 'error',
      '-filter_complex', "sine=frequency=700:sample_rate=48000,volume='if(lt(mod(t,2),1),0.15,0)':eval=frame[a];anoisesrc=color=pink:amplitude=0.01:seed=3:sample_rate=48000[n];[a][n]amix=inputs=2:normalize=0",
      '-t', '10', '-c:a', 'aac', '-b:a', '192k', file
    ])
    const levels = (noiseReduction: number): { gap: number; tone: number } => {
      const out = render(m4a(10, { audio: { clips: [clip(0, 10)], volume: 1, noiseReduction } }), { mix: file })
      return { gap: rms(out, 7.2, 7.8), tone: rms(out, 8.2, 8.8) }
    }
    const off = levels(0)
    const mid = levels(0.5)
    const strong = levels(1)
    const db = (v: number): number => 20 * Math.log10(v)
    expect(db(off.gap) - db(mid.gap)).toBeGreaterThan(3)
    expect(db(mid.gap) - db(strong.gap)).toBeGreaterThan(6)
    expect(Math.abs(db(strong.tone) - db(off.tone))).toBeLessThan(1)
  })
})
