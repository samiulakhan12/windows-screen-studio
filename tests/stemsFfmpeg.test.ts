// Sound stems through the Linux ffmpeg (docs/design/output-and-languages.md §7, §23.1 tests 31-33):
// the stems add up to the soundtrack the preview plays (the video's graph with the fixed gain in place
// of loudnorm), each through the mix's own channel step; they are 32-bit float and keep peaks above
// 0 dBFS; and each is exactly the video's length in samples, from sample 0.
import { execFileSync, spawnSync } from 'node:child_process'
import { mkdtempSync, readFileSync, rmSync } from 'node:fs'
import { tmpdir } from 'node:os'
import path from 'node:path'
import { afterAll, describe, expect, it } from 'vitest'
import { ffmpegPath } from '../src/main/ffmpeg'
import { stemOutputArgs } from '../src/main/stemsArgs'
import type { ExportJob, SoundStem } from '../src/shared/api/export'
import { SOUND_EFFECTS } from '../src/shared/audio/soundLibrary'
import { soundtrackGraph, soundtrackParts, STEREO, type SoundFiles } from '../src/shared/render/audioPlan'
import { CUT_FADE } from '../src/shared/render/cutFades'
import { stemPlan, stemSamples } from '../src/shared/render/stems'

const ff = ffmpegPath()
const dir = mkdtempSync(path.join(tmpdir(), 'ssw-stems-'))
afterAll(() => rmSync(dir, { recursive: true, force: true }))
const LIBRARY = path.join(__dirname, '..', 'resources', 'sound-library')

/** A lossless source file made by lavfi (no codec priming: what goes in is what the graph reads). */
function make(name: string, lavfi: string, seconds: number): string {
  const file = path.join(dir, name)
  execFileSync(ff, ['-v', 'error', '-y', '-f', 'lavfi', '-i', lavfi, '-t', String(seconds), '-c:a', 'pcm_f32le', file])
  return file
}

const mic = make('mic.wav', 'aevalsrc=0.3*sin(2*PI*440*t)+0.05*sin(2*PI*3000*t):s=48000:c=mono', 5)
const system = make('system.wav', "aevalsrc='0.2*sin(2*PI*300*t)|0.15*sin(2*PI*520*t)':s=48000:c=stereo", 5)
const mix = make('screen.wav', "aevalsrc='0.25*sin(2*PI*330*t)|0.2*sin(2*PI*660*t)':s=48000:c=stereo", 5)
const music = make('music.wav', "aevalsrc='0.3*sin(2*PI*220*t)|0.3*sin(2*PI*277*t)':s=48000:c=stereo", 5)
const loud = make('loud.wav', "aevalsrc='0.71*sin(2*PI*200*t)|0.71*sin(2*PI*200*t)':s=48000:c=stereo", 3)
const dc = make('dc.wav', 'aevalsrc=0.5:s=48000:c=mono', 3)
const effect = SOUND_EFFECTS[0]

interface Wav {
  format: number
  bits: number
  channels: number
  rate: number
  samples: Float32Array
  bext: { description: string; originator: string; timeReference: number } | null
}

/** Reads a float WAV (RIFF or RF64): its format, its BWF chunk and its samples. */
function readWav(file: string): Wav {
  const b = readFileSync(file)
  let off = 12
  let fmt: Omit<Wav, 'samples' | 'bext'> | null = null
  let bext: Wav['bext'] = null
  while (off + 8 <= b.length) {
    const id = b.toString('ascii', off, off + 4)
    const size = b.readUInt32LE(off + 4)
    const body = off + 8
    if (id === 'fmt ') {
      const tag = b.readUInt16LE(body)
      fmt = { format: tag === 0xfffe ? b.readUInt16LE(body + 24) : tag, channels: b.readUInt16LE(body + 2), rate: b.readUInt32LE(body + 4), bits: b.readUInt16LE(body + 14) }
    } else if (id === 'bext') {
      const text = (from: number, n: number): string => b.toString('latin1', body + from, body + from + n).replace(/\0[\s\S]*$/, '')
      bext = { description: text(0, 256), originator: text(256, 32), timeReference: b.readUInt32LE(body + 338) + b.readUInt32LE(body + 342) * 2 ** 32 }
    } else if (id === 'data') {
      const bytes = new Uint8Array(b.subarray(body, body + size))
      return { ...fmt!, bext, samples: new Float32Array(bytes.buffer) }
    }
    off = body + size + (size & 1)
  }
  throw new Error(`no data chunk in ${file}`)
}

/** Runs the stem plan of `job` and returns each stem's WAV. */
function renderStems(job: ExportJob, files: SoundFiles, only?: SoundStem[]): Map<SoundStem, Wav> {
  const plan = stemPlan(job, files, 0, only)
  const out = new Map<SoundStem, string>(plan.outputs.map((o) => [o.stem, path.join(dir, `${Math.random().toString(36).slice(2)} - ${o.stem}.wav`)]))
  const args = ['-v', 'error', '-nostdin', ...plan.args, '-filter_complex', plan.graph, ...plan.outputs.flatMap((o) => ['-map', `[${o.label}]`, ...stemOutputArgs(o.stem, out.get(o.stem)!)])]
  const r = spawnSync(ff, args, { encoding: 'utf8' })
  expect(r.status, r.stderr).toBe(0)
  return new Map([...out].map(([stem, file]) => [stem, readWav(file)]))
}

/**
 * The soundtrack the preview plays: the video's own graph for `job` with the stems' fixed gain in
 * place of loudnorm, at full level on each side (STEREO) as the preview plays a mono mix, float
 * stereo, `samples` long.
 */
function renderMix(job: ExportJob, files: SoundFiles): Float32Array {
  const parts = soundtrackParts(job, files, 0)
  const audio = parts.audio && { ...parts.audio, normalize: undefined, ...(job.stems?.gainDb !== undefined ? { gainDb: job.stems.gainDb } : {}) }
  const graph = soundtrackGraph({ ...parts, audio, fadeIn: job.fadeIn, fadeOut: job.fadeOut })!
  const n = stemSamples(job.frames, job.fps)
  const r = spawnSync(ff, ['-v', 'error', '-nostdin', ...parts.args, '-filter_complex', `${graph};[aout]${STEREO},aformat=sample_fmts=flt:channel_layouts=stereo,apad=whole_len=${n},atrim=end_sample=${n}[ref]`, '-map', '[ref]', '-f', 'f32le', '-'], { maxBuffer: 1 << 28 })
  expect(r.status, r.stderr.toString()).toBe(0)
  return new Float32Array(new Uint8Array(r.stdout).buffer)
}

const rms = (s: Float32Array): number => Math.sqrt(s.reduce((a, v) => a + v * v, 0) / s.length)
const dbfs = (v: number): number => 20 * Math.log10(Math.max(v, 1e-30))

/** The residual (dBFS RMS) of the stems' sum against the preview's mix, and the mix's own level. */
function residual(stems: Map<SoundStem, Wav>, mixed: Float32Array): { residual: number; level: number } {
  const sum = new Float32Array(mixed.length)
  for (const w of stems.values()) {
    expect(w.samples.length).toBe(mixed.length)
    for (let i = 0; i < sum.length; i++) sum[i] += w.samples[i]
  }
  const diff = sum.map((v, i) => v - mixed[i])
  return { residual: dbfs(rms(diff)), level: dbfs(rms(mixed)) }
}

const base = (seconds: number, fps = 30): ExportJob => ({
  width: 1280,
  height: 720,
  fps,
  frames: Math.round(seconds * fps),
  format: 'mp4',
  quality: 'high',
  video: { kind: 'raw', encoder: 'libx264', pixelFormat: 'yuv420p' },
  outputPath: '/o.mp4'
})

describe('the stems add up to the preview mix at 1× speed (test 31)', () => {
  it('voice, system sound, music and effects: cuts, a pause freeze, smooth cuts, lowered sounds, noise reduction, the fixed gain and the fades', () => {
    // Clips 0-1.2 and 1.8-3.6 s, a 0.3 s freeze at 2.4 s: 3.3 s of video.
    const job: ExportJob = {
      ...base(3.3),
      audio: {
        clips: [{ id: 'a', start: 0, end: 1.2, speed: 1 }, { id: 'b', start: 1.8, end: 3.6, speed: 1 }],
        volume: 0.9,
        stems: { mic: 1, system: 0.6 },
        noiseReduction: 0.4,
        normalize: true,
        holds: [{ at: 2.4, length: 0.3 }],
        cutFade: CUT_FADE,
        sounds: [{ start: 0.4, end: 0.8, gain: 0.3 }]
      },
      music: { file: 'music-1.wav', volume: 0.8, loop: false, fadeIn: 0.5, fadeOut: 0.5, duration: 5, duck: { depth: 0.6, attack: 0.1, release: 0.3, ranges: [{ start: 0.5, end: 2 }] } },
      clicks: { times: [0.4, 1.5, 2.9], volume: 0.7 },
      pops: [{ times: [1], sound: 'pop' }],
      tones: [{ start: 2.1, end: 2.5 }],
      effects: [{ id: effect.id, times: [0.2, 2.6], gain: 0.9 }],
      fadeIn: 0.3,
      fadeOut: 0.4,
      stems: { stems: ['voice', 'system', 'music', 'effects'], gainDb: -4.5, gains: { system: 0.6 } }
    }
    const files: SoundFiles = { mix, stems: { mic, system }, music, effects: { [effect.id]: path.join(LIBRARY, effect.prepared.file) } }
    const stems = renderStems(job, files)
    expect([...stems.keys()]).toEqual(['voice', 'system', 'music', 'effects'])
    const r = residual(stems, renderMix(job, files))
    expect(r.level).toBeGreaterThan(-30)
    expect(r.residual).toBeLessThan(-120)
  })

  it('a mono microphone alone and with clicks: the voice at full level on each side, as the mix plays it', () => {
    for (const clicks of [undefined, { times: [0.5, 1.4], volume: 1 }]) {
      const job: ExportJob = {
        ...base(2),
        audio: { clips: [{ id: 'a', start: 0.5, end: 2.5, speed: 1 }], volume: 1, stems: { mic: 0.8 } },
        ...(clicks ? { clicks } : {}),
        stems: { stems: clicks ? ['voice', 'effects'] : ['voice'] }
      }
      const files: SoundFiles = { mix: null, stems: { mic } }
      const stems = renderStems(job, files)
      const voice = stems.get('voice')!.samples
      // Both sides equal: the mono microphone made stereo at full level (not 3 dB lower).
      for (let i = 0; i < voice.length; i += 2) expect(voice[i]).toBe(voice[i + 1])
      const r = residual(stems, renderMix(job, files))
      expect(r.level).toBeGreaterThan(-30)
      expect(r.residual).toBeLessThan(-120)
    }
  })

  it('a project with effects only: clicks, a pop and a tone, each through the mix channel step', () => {
    const job: ExportJob = { ...base(2), clicks: { times: [0.2, 0.9], volume: 0.8 }, pops: [{ times: [0.5], sound: 'ding' }], tones: [{ start: 1.2, end: 1.6 }], fadeOut: 0.5, stems: { stems: ['effects'] } }
    const files: SoundFiles = { mix: null }
    const stems = renderStems(job, files)
    expect([...stems.keys()]).toEqual(['effects'])
    const r = residual(stems, renderMix(job, files))
    expect(r.level).toBeGreaterThan(-40)
    expect(r.residual).toBeLessThan(-120)
  })

  it('a recording without separate files, with music', () => {
    const job: ExportJob = {
      ...base(3),
      audio: { clips: [{ id: 'a', start: 0, end: 1, speed: 1 }, { id: 'b', start: 2, end: 4, speed: 1 }], volume: 1.2, normalize: true, cutFade: CUT_FADE },
      music: { file: 'music-1.wav', volume: 0.5, loop: true, fadeIn: 0, fadeOut: 1, duration: null },
      stems: { stems: ['recording', 'music'], gainDb: 3.25 }
    }
    const files: SoundFiles = { mix, music }
    const stems = renderStems(job, files)
    expect([...stems.keys()]).toEqual(['recording', 'music'])
    const r = residual(stems, renderMix(job, files))
    expect(r.residual).toBeLessThan(-120)
  })
})

describe('stems are 32-bit float and keep peaks above 0 dBFS (test 32)', () => {
  it('music at gain 2 over a 0.71 source peaks at +3 dBFS in its stem, unclipped', () => {
    const job: ExportJob = { ...base(2), music: { file: 'music-1.wav', volume: 2, loop: false, fadeIn: 0, fadeOut: 0, duration: 3 }, stems: { stems: ['music'] } }
    const w = renderStems(job, { mix: null, music: loud }).get('music')!
    expect(w.format).toBe(3)
    expect(w.bits).toBe(32)
    expect(w.channels).toBe(2)
    expect(w.rate).toBe(48000)
    const peak = w.samples.reduce((m, v) => Math.max(m, Math.abs(v)), 0)
    expect(dbfs(peak)).toBeGreaterThan(2.9)
    expect(dbfs(peak)).toBeLessThan(3.2)
  })
})

describe('every stem is the video length in samples, from sample 0 (test 33)', () => {
  for (const fps of [24, 25, 30, 60, 120]) {
    it(`${fps} fps`, () => {
      const frames = 2 * fps + 7
      const job: ExportJob = {
        ...base(0, fps),
        frames,
        audio: { clips: [{ id: 'a', start: 0, end: 2.5, speed: 1 }], volume: 1 },
        music: { file: 'music-1.wav', volume: 0.5, loop: true, fadeIn: 0, fadeOut: 0, duration: null },
        clicks: { times: [0.1], volume: 1 },
        stems: { stems: ['recording', 'music', 'effects'] }
      }
      const stems = renderStems(job, { mix: dc, music })
      expect([...stems.keys()]).toEqual(['recording', 'music', 'effects'])
      const n = stemSamples(frames, fps)
      expect(n).toBe((frames * 48000) / fps)
      for (const [stem, w] of stems) {
        expect(w.samples.length / 2, stem).toBe(n)
        expect(w.bext?.timeReference, stem).toBe(0)
        expect(w.bext?.originator, stem).toBe('Flown')
      }
      expect(stems.get('recording')!.bext?.description).toBe('Recording')
      // The recording's first sample is its first sample: nothing is shifted or trimmed at the start.
      const rec = stems.get('recording')!.samples
      expect(rec[0]).toBeCloseTo(0.5, 6)
      expect(rec[1]).toBeCloseTo(0.5, 6)
    })
  }
})
