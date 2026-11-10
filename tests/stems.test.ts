// Sound stems, the pure part (docs/design/output-and-languages.md §7, §23.1 tests 32-34): which stems
// a project and a job write, the fixed gain in place of loudnorm, the exact length, and the one graph
// that writes them, built from today's soundtrack functions. The stems through ffmpeg are in
// stemsFfmpeg.test.ts, the main-process step in stemsRun.test.ts.
import { describe, expect, it, vi } from 'vitest'
import type { ExportJob } from '../src/shared/api/export'
import { LEVEL_WINDOW, type AudioLevels } from '../src/shared/audio/loudness'
import { recordingMix } from '../src/shared/audio/settings'
import { previewNormalizeGain } from '../src/shared/audio/soundtrack'
import { createProject } from '../src/shared/engine/project'
import { EFFECT_JOIN, NORMALIZE_FILTERS, planSoundtrack, recordingGraph, STEREO, type SoundFiles } from '../src/shared/render/audioPlan'
import { CUT_FADE } from '../src/shared/render/cutFades'
import type { ExportOptions } from '../src/shared/render/exportPresets'
import { STEM_FILE_WORDS, stemJobOf, stemPlan, stemSamples, stemSoundJob, stemsOfJob } from '../src/shared/render/stems'
import type { Project } from '../src/shared/types'
import { validateJob } from '../src/main/exportJob'

const MP4: ExportOptions = { format: 'mp4', resolution: 1080, fps: 30, quality: 'high', encoder: 'auto' }

function project(extra: Partial<Project> = {}): Project {
  const p = createProject({
    id: 'p',
    name: 'p',
    duration: 6,
    width: 1920,
    height: 1080,
    hasWebcam: false,
    hasAudio: true,
    webcamOffset: 0,
    zooms: [],
    cursorValid: false,
    capture: { method: 'native', cursorInVideo: false, region: null, fps: 30 }
  })
  return { ...p, ...extra }
}

const separate = (audio: Partial<Project['audio']> = {}): Project => project({ audioStems: { mic: true, system: true }, audio: { volume: 1, muted: false, ...audio } })

/** Levels of a source at a constant power for `seconds`. */
const levels = (power: number, seconds = 6): AudioLevels => ({ window: LEVEL_WINDOW, power: new Float32Array(Math.round(seconds / LEVEL_WINDOW)).fill(power) })

describe('which stems a project writes (test 34)', () => {
  it('a project without separate files gives one Recording stem', () => {
    expect(stemJobOf(project(), MP4, null)).toEqual({ stems: ['recording'] })
  })

  it('separate files at their default gains still give Voice and System sound, though the video mixes screen.mp4', () => {
    const p = separate()
    expect(recordingMix(p).kind).toBe('mix')
    expect(stemJobOf(p, MP4, null)).toEqual({ stems: ['voice', 'system'] })
  })

  it('a muted or silent source gives no stem; a changed gain is carried', () => {
    expect(stemJobOf(separate({ system: { volume: 1, muted: true } }), MP4, null)).toEqual({ stems: ['voice'] })
    expect(stemJobOf(separate({ mic: { volume: 0, muted: false }, system: { volume: 0.5, muted: false } }), MP4, null)).toEqual({ stems: ['system'], gains: { system: 0.5 } })
    expect(stemJobOf(project({ hasAudio: false }), MP4, null)).toBeUndefined()
    expect(stemJobOf(project({ audio: { volume: 1, muted: true } }), MP4, null)).toBeUndefined()
    expect(stemJobOf(project({ audio: { volume: 0, muted: false } }), MP4, null)).toBeUndefined()
  })

  it('music when it plays; effects when click sounds, a pop or a bleep tone may sound', () => {
    const music = { path: 'music.mp3', volume: 0.4, ducking: 0.5, loop: true, fadeIn: 1, fadeOut: 1 }
    expect(stemJobOf(project({ audio: { volume: 1, muted: false, music } }), MP4, null)).toEqual({ stems: ['recording', 'music'] })
    expect(stemJobOf(project({ audio: { volume: 1, muted: false, music: { ...music, volume: 0 } } }), MP4, null)).toEqual({ stems: ['recording'] })
    const clicking = project({ hasAudio: false })
    clicking.cursor = { ...clicking.cursor, clickSound: true, clickSoundVolume: 0.5 }
    expect(stemJobOf(clicking, MP4, null)).toEqual({ stems: ['effects'] })
    const toned = project({ hasAudio: false, bleeps: [{ id: 'b', start: 1, end: 1.4, word: 'x', sound: 'tone' }] })
    expect(stemJobOf(toned, MP4, null)).toEqual({ stems: ['effects'] })
  })

  it('never for a GIF; the WAV and M4A formats have stems too', () => {
    expect(stemJobOf(project(), { ...MP4, format: 'gif' }, null)).toBeUndefined()
    expect(stemJobOf(project(), { ...MP4, format: 'wav' }, null)).toEqual({ stems: ['recording'] })
    expect(stemJobOf(project(), { ...MP4, format: 'm4a' }, null)).toEqual({ stems: ['recording'] })
  })

  it('the file words are English', () => {
    expect(STEM_FILE_WORDS).toEqual({ voice: 'Voice', system: 'System sound', recording: 'Recording', music: 'Music', effects: 'Effects' })
  })
})

describe('the fixed gain (test 32)', () => {
  it('is 20·log10 of the gain the preview plays, only while the video evens out loudness', () => {
    const quiet = project({ audio: { volume: 1, muted: false, normalize: true } })
    const analysis = { mix: levels(0.0004) }
    const g = previewNormalizeGain(quiet, analysis)
    expect(g).not.toBeCloseTo(1, 2)
    const job = stemJobOf(quiet, MP4, analysis)!
    expect(job.gainDb).toBeCloseTo(20 * Math.log10(g), 9)
    expect(stemJobOf(project(), MP4, analysis)!.gainDb).toBeUndefined()
    // Levels not measured: the preview plays the recording as it is, and so do the stems.
    expect(stemJobOf(quiet, MP4, null)!.gainDb).toBe(0)
    // Music alone carries no recording gain.
    const music = { path: 'music.mp3', volume: 0.4, ducking: 0, loop: true, fadeIn: 1, fadeOut: 1 }
    expect(stemJobOf(project({ hasAudio: false, audio: { volume: 1, muted: false, normalize: true, music } }), MP4, analysis)).toEqual({ stems: ['music'] })
  })

  it('follows the separate files the preview measures', () => {
    const p = separate({ normalize: true, system: { volume: 0.5, muted: false } })
    const analysis = { mic: levels(0.01), system: levels(0.002) }
    expect(stemJobOf(p, MP4, analysis)!.gainDb).toBeCloseTo(20 * Math.log10(previewNormalizeGain(p, analysis)), 9)
  })

  it('stays within ±30 dB, so the job is valid however quiet or loud the recording is', () => {
    for (const power of [1e-12, 50]) {
      const p = project({ audio: { volume: 1, muted: false, normalize: true } })
      const stems = stemJobOf(p, MP4, { mix: levels(power) })!
      expect(Math.abs(stems.gainDb!)).toBeLessThanOrEqual(30)
      const job: ExportJob = { width: 1280, height: 720, fps: 30, frames: 30, format: 'mp4', quality: 'high', video: { kind: 'raw', encoder: 'libx264', pixelFormat: 'yuv420p' }, audio: { clips: p.clips, volume: 1, normalize: true }, stems, outputPath: '/o.mp4' }
      expect(() => validateJob(job)).not.toThrow()
    }
  })

  it('clamps a gain outside ±30 dB itself', async () => {
    vi.resetModules()
    vi.doMock('../src/shared/audio/soundtrack', async (orig) => ({ ...(await orig<object>()), previewNormalizeGain: () => 1e4 }))
    const loud = await import('../src/shared/render/stems')
    expect(loud.stemGainDb(project(), null)).toBe(30)
    vi.doUnmock('../src/shared/audio/soundtrack')
    vi.resetModules()
    vi.doMock('../src/shared/audio/soundtrack', async (orig) => ({ ...(await orig<object>()), previewNormalizeGain: () => 1e-4 }))
    const quiet = await import('../src/shared/render/stems')
    expect(quiet.stemGainDb(project(), null)).toBe(-30)
    vi.doUnmock('../src/shared/audio/soundtrack')
  })

  it('sits where loudnorm sits in the recording graph; 0 dB adds nothing; graphs without it are as before', () => {
    const rec = { clips: [{ id: 'a', start: 0, end: 2, speed: 1 }], volume: 0.8, input: '1:a' }
    const before = recordingGraph(rec, 2)
    expect(recordingGraph({ ...rec, normalize: true }, 2)).toContain(`${NORMALIZE_FILTERS},volume=0.8`)
    // loudnorm, when asked for, wins: the video's own graph never carries both.
    expect(recordingGraph({ ...rec, normalize: true, gainDb: -4.5 }, 2)).toBe(recordingGraph({ ...rec, normalize: true }, 2))
    expect(recordingGraph({ ...rec, gainDb: -4.5 }, 2)).toBe(before.replace('volume=0.8,', 'volume=-4.5dB,volume=0.8,'))
    expect(recordingGraph({ ...rec, gainDb: 0 }, 2)).toBe(before)
    expect(recordingGraph({ ...rec, gainDb: 0.00001 }, 2)).toBe(before)
  })
})

describe('the stems of a job with the files main resolved (test 34)', () => {
  const job = (over: Partial<ExportJob> = {}): ExportJob => ({
    width: 1280,
    height: 720,
    fps: 30,
    frames: 90,
    format: 'mp4',
    quality: 'high',
    video: { kind: 'raw', encoder: 'libx264', pixelFormat: 'yuv420p' },
    outputPath: '/o.mp4',
    audio: { clips: [{ id: 'a', start: 0, end: 3, speed: 1 }], volume: 1, stems: { mic: 1, system: 1 } },
    stems: { stems: ['voice', 'system', 'music', 'effects'] },
    ...over
  })
  const files: SoundFiles = { mix: '/p/screen.mp4', stems: { mic: '/p/mic.m4a', system: '/p/system.m4a' }, music: '/p/music.mp3' }

  it('the separate files that are there and heard', () => {
    expect(stemsOfJob(job(), files)).toEqual(['voice', 'system'])
    expect(stemsOfJob(job(), { ...files, stems: { mic: '/p/mic.m4a' } })).toEqual(['voice'])
    expect(stemsOfJob(job({ audio: { clips: job().audio!.clips, volume: 1, stems: { mic: 1, system: 0 } } }), files)).toEqual(['voice'])
    expect(stemsOfJob(job({ audio: { clips: job().audio!.clips, volume: 0, stems: { mic: 1, system: 1 } } }), files)).toEqual([])
  })

  it('the mixed track when the job mixes no separate files, also in place of Voice and System sound whose files went missing', () => {
    const mixed = { clips: job().audio!.clips, volume: 1 }
    expect(stemsOfJob(job({ audio: mixed, stems: { stems: ['recording'] } }), files)).toEqual(['recording'])
    expect(stemsOfJob(job({ audio: mixed }), files)).toEqual(['recording'])
    expect(stemsOfJob(job({ audio: mixed }), { ...files, mix: null })).toEqual([])
  })

  it('music only when it plays; effects only when one sounds inside the video', () => {
    const music = { file: 'music-1.mp3', volume: 0.5, loop: true, fadeIn: 0, fadeOut: 0, duration: null }
    expect(stemsOfJob(job({ music }), files)).toEqual(['voice', 'system', 'music'])
    expect(stemsOfJob(job({ music: { ...music, volume: 0 } }), files)).toEqual(['voice', 'system'])
    expect(stemsOfJob(job({ music }), { ...files, music: null })).toEqual(['voice', 'system'])
    expect(stemsOfJob(job({ clicks: { times: [5], volume: 1 } }), files)).toEqual(['voice', 'system'])
    expect(stemsOfJob(job({ clicks: { times: [1], volume: 0 } }), files)).toEqual(['voice', 'system'])
    expect(stemsOfJob(job({ clicks: { times: [1], volume: 1 } }), files)).toEqual(['voice', 'system', 'effects'])
    expect(stemsOfJob(job({ tones: [{ start: 1, end: 1.3 }] }), files)).toEqual(['voice', 'system', 'effects'])
    expect(stemsOfJob(job({ pops: [{ times: [4], sound: 'pop' }] }), files)).toEqual(['voice', 'system'])
    expect(stemsOfJob(job({ effects: [{ id: 'x', times: [1], gain: 0.5 }] }), { ...files, effects: { x: '/l/x.ogg' } })).toEqual(['voice', 'system', 'effects'])
    expect(stemsOfJob(job({ effects: [{ id: 'x', times: [1], gain: 0 }] }), { ...files, effects: { x: '/l/x.ogg' } })).toEqual(['voice', 'system'])
  })

  it('only the stems the job asks for, and none without a StemJob', () => {
    expect(stemsOfJob(job({ stems: { stems: ['system'] } }), files)).toEqual(['system'])
    expect(stemsOfJob(job({ stems: undefined }), files)).toEqual([])
  })
})

describe('the length of a stem (test 33)', () => {
  it('is round(frames / fps × 48000), whole samples per frame at every rate', () => {
    expect([24, 25, 30, 60, 120].map((fps) => stemSamples(1, fps))).toEqual([2000, 1920, 1600, 800, 400])
    expect(stemSamples(7, 24)).toBe(14000)
    expect(stemSamples(36_000, 60)).toBe(28_800_000)
  })
})

describe('the stem graph (§7.2, test 34)', () => {
  const clips = [{ id: 'a', start: 0, end: 1, speed: 1 }, { id: 'b', start: 2, end: 3, speed: 1 }]
  const job: ExportJob = {
    width: 1280,
    height: 720,
    fps: 30,
    frames: 60,
    format: 'mp4',
    quality: 'high',
    video: { kind: 'raw', encoder: 'libx264', pixelFormat: 'yuv420p' },
    outputPath: '/o.mp4',
    audio: { clips, volume: 1, stems: { mic: 1, system: 0.5 }, normalize: true, cutFade: CUT_FADE, noiseReduction: 0.3 },
    music: { file: 'music-1.mp3', volume: 0.5, loop: true, fadeIn: 0, fadeOut: 0, duration: null },
    clicks: { times: [0.5], volume: 1 },
    tones: [{ start: 1, end: 1.2 }],
    fadeIn: 0.2,
    stems: { stems: ['voice', 'system', 'music', 'effects'], gainDb: -4.5, gains: { system: 0.5 } }
  }
  const files: SoundFiles = { mix: '/p/screen.mp4', stems: { mic: '/p/mic.m4a', system: '/p/system.m4a' }, music: '/p/music.mp3' }
  const n = stemSamples(60, 30)
  const chainOf = (graph: string, label: string): string => graph.split(';').find((c) => c.endsWith(`[${label}]`))!

  it('one output per stem, each exactly the video long, float stereo, after the soundtrack fades', () => {
    const plan = stemPlan(job, files, 0)
    expect(plan.outputs).toEqual(['voice', 'system', 'music', 'effects'].map((s) => ({ stem: s, label: s })))
    for (const s of ['voice', 'system', 'music', 'effects']) {
      expect(chainOf(plan.graph, s)).toMatch(new RegExp(`afade=t=in:st=0:d=0\\.2,aformat=sample_fmts=flt:channel_layouts=stereo,apad=whole_len=${n},atrim=end_sample=${n}\\[${s}\\]$`))
    }
    // The inputs are today's: the separate files, the music looped by the demuxer, the click and tone sources.
    expect(plan.args.filter((a) => a.startsWith('/p/'))).toEqual(['/p/mic.m4a', '/p/system.m4a', '/p/music.mp3'])
    expect(plan.args).toContain('-stream_loop')
  })

  it('each stem through the channel step of the mix: the recording made stereo, every effect joined as the mix joins it', () => {
    const plan = stemPlan(job, files, 0)
    expect(chainOf(plan.graph, 'voice').startsWith(`[voice0]${STEREO},`)).toBe(true)
    expect(chainOf(plan.graph, 'system').startsWith(`[system0]${STEREO},`)).toBe(true)
    // The music's branch is stereo already, as the mix takes it.
    expect(chainOf(plan.graph, 'music').startsWith('[music0]afade')).toBe(true)
    expect(plan.graph).toContain(`[clk0]${EFFECT_JOIN}[clk]`)
    expect(plan.graph).toContain(`[tone0]${EFFECT_JOIN}[tone]`)
    expect(plan.graph).toContain('[clk][tone]amix=inputs=2:duration=first:dropout_transition=0:normalize=0[effects0]')
  })

  it('the fixed gain in place of loudnorm, once in each recording stem; the noise reduction on the microphone only', () => {
    const plan = stemPlan(job, files, 0)
    expect(plan.graph).not.toContain('loudnorm')
    expect(plan.graph.match(/volume=-4\.5dB/g)).toHaveLength(2)
    expect(plan.graph.match(/afftdn/g)).toHaveLength(1)
    const voice = stemPlan(job, files, 0, ['voice']).graph
    expect(voice).toContain('afftdn')
    expect(stemPlan(job, files, 0, ['system']).graph).not.toContain('afftdn')
    // Each recording stem is the recording's graph with that one file, as recordingGraph builds it.
    const one = recordingGraph({ clips, volume: 1, input: '0:a', stems: [{ input: '0:a', gain: 1, denoise: true }], noiseReduction: 0.3, cutFade: CUT_FADE, gainDb: -4.5 }, 2, 'voice0')
    expect(voice.startsWith(one)).toBe(true)
  })

  it('only some stems: their inputs only', () => {
    const plan = stemPlan(job, files, 0, ['music', 'effects'])
    expect(plan.outputs.map((o) => o.stem)).toEqual(['music', 'effects'])
    expect(plan.args.filter((a) => a.startsWith('/p/'))).toEqual(['/p/music.mp3'])
    expect(plan.graph).not.toContain('[voice')
    expect(plan.graph).not.toContain('afftdn')
    // Input numbers follow the inputs before them.
    expect(stemPlan(job, files, 3, ['music']).graph.startsWith('[3:a]')).toBe(true)
    expect(stemPlan(job, files, 0, ['recording'])).toEqual({ args: [], graph: '', outputs: [] })
  })

  it('a project without stems plans the same soundtrack as before', () => {
    const { stems: _stems, ...plain } = job
    void _stems
    expect(planSoundtrack(job, files, 0)).toEqual(planSoundtrack(plain, files, 0))
    expect(planSoundtrack(job, files, 0).graph).toContain('loudnorm')
  })
})

describe('the job the stems are resolved from (§7.6)', () => {
  const job: ExportJob = {
    width: 1280,
    height: 720,
    fps: 30,
    frames: 60,
    format: 'mp4',
    quality: 'high',
    video: { kind: 'raw', encoder: 'libx264', pixelFormat: 'yuv420p' },
    outputPath: '/o.mp4',
    // The video mixes screen.mp4's track: the gains are the default.
    audio: { clips: [{ id: 'a', start: 0, end: 2, speed: 1 }], volume: 1, voice: 'normal' },
    music: { file: 'music-1.mp3', volume: 0.5, loop: true, fadeIn: 0, fadeOut: 0, duration: null },
    clicks: { times: [0.5], volume: 1 },
    stems: { stems: ['voice', 'system', 'music', 'effects'], gains: { system: 0.5 } }
  }

  it('asks for the separate files at the stems gains, also where the video mixed screen.mp4', () => {
    const asked = stemSoundJob(job, ['voice', 'system', 'music', 'effects'])
    expect(asked.audio).toEqual({ ...job.audio, stems: { mic: 1, system: 0.5 } })
    expect(asked.music).toEqual(job.music)
    expect(asked.clicks).toEqual(job.clicks)
  })

  it('leaves out what no stem asked for needs', () => {
    const asked = stemSoundJob(job, ['music'])
    expect(asked.audio).toBeUndefined()
    expect(asked.clicks).toBeUndefined()
    expect(asked.stems?.stems).toEqual(['music'])
    expect(stemSoundJob(job, ['voice']).audio?.stems).toEqual({ mic: 1 })
    const recording = stemSoundJob({ ...job, audio: { ...job.audio!, stems: { mic: 1 } } }, ['recording'])
    expect(recording.audio && 'stems' in recording.audio).toBe(false)
  })

  it('without a StemJob (a timeline rendering Music and Effects), takes the gains the job mixes', () => {
    const { stems: _stems, ...plain } = job
    void _stems
    expect(stemSoundJob({ ...plain, audio: { ...plain.audio!, stems: { mic: 0.7 } } }, ['voice']).audio?.stems).toEqual({ mic: 0.7 })
    expect(stemSoundJob(plain, ['music', 'effects']).stems).toEqual({ stems: ['music', 'effects'] })
  })
})
