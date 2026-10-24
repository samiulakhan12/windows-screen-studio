// Sound levels, activity, gain automation and the shared sound decisions (shared/audio).
import { execFileSync, spawnSync } from 'node:child_process'
import { describe, expect, it } from 'vitest'
import { ffmpegPath } from '../src/main/ffmpeg'
import { combineLevels, detectActivity, mergeRanges, rangesToOutput } from '../src/shared/audio/activity'
import { DUCK_TIMING, duckAmount, duckExpression, duckGainAt, duckKeyframes, duckRanges, fadeGainAt, fadeKeyframes, fitFades, gainAt } from '../src/shared/audio/automation'
import { integratedLoudness, kWeighting, LEVEL_WINDOW, LevelMeter, loudnessOf, normalizeGain, type AudioLevels } from '../src/shared/audio/loudness'
import { activitySources, audioLook, hasSoundtrack, musicEnd, needsAudioGraph, recordingMix, stemsOf } from '../src/shared/audio/settings'
import { analysisSources, musicDucking, previewNormalizeGain, recordingLoudness, soundActivity } from '../src/shared/audio/soundtrack'
import { migrateProject } from '../src/shared/engine/project'
import type { Clip, Project } from '../src/shared/types'

const clip = (start: number, end: number, speed = 1): Clip => ({ id: `${start}`, start, end, speed })

/** An envelope from per-window dB levels. */
const levels = (db: number[], window = LEVEL_WINDOW): AudioLevels => ({ window, power: Float32Array.from(db, (v) => (v <= -200 ? 0 : 10 ** (v / 10))) })
/** `seconds` of `db`. */
const run = (db: number, seconds: number): number[] => new Array(Math.round(seconds / LEVEL_WINDOW)).fill(db)

function project(over: Partial<Project> = {}): Project {
  return migrateProject({
    version: 2,
    id: 'p',
    name: 'p',
    createdAt: '',
    duration: 10,
    width: 1280,
    height: 720,
    hasWebcam: false,
    hasAudio: true,
    webcamOffset: 0,
    capture: { method: 'chromium', cursorInVideo: true, region: null },
    clips: [clip(0, 10)],
    zooms: [],
    autoZoom: false,
    annotations: [],
    style: { background: { type: 'color', color: '#000' }, padding: 0, cornerRadius: 0, shadow: 0, aspectRatio: 'auto' },
    cursor: { show: false, size: 1, smoothing: 0.5, clickEffect: false, hideWhenIdle: false },
    webcam: { show: false, corner: 'bottom-right', size: 0.2, shape: 'circle' },
    effects: { motionBlur: 0, keystrokes: { show: false, position: 'bottom', size: 0.03 } },
    audio: { volume: 1, muted: false },
    ...over
  })
}

describe('K-weighting and the level meter', () => {
  it('gives the coefficients BS.1770 tabulates at 48 kHz', () => {
    const [shelf, hp] = kWeighting(48000)
    expect(shelf.b0).toBeCloseTo(1.53512485958697, 9)
    expect(shelf.b1).toBeCloseTo(-2.69169618940638, 9)
    expect(shelf.b2).toBeCloseTo(1.19839281085285, 9)
    expect(shelf.a1).toBeCloseTo(-1.69065929318241, 9)
    expect(shelf.a2).toBeCloseTo(0.73248077421585, 9)
    expect([hp.b0, hp.b1, hp.b2]).toEqual([1, -2, 1])
    expect(hp.a1).toBeCloseTo(-1.99004745483398, 9)
    expect(hp.a2).toBeCloseTo(0.99007225036621, 9)
  })

  it('measures a full-scale 1 kHz sine at -3.01 LUFS (mono), at any sample rate', () => {
    for (const rate of [16000, 48000]) {
      const meter = new LevelMeter(rate, 1)
      const n = rate * 3
      const sine = new Float32Array(n)
      for (let i = 0; i < n; i++) sine[i] = Math.sin((2 * Math.PI * 1000 * i) / rate)
      // Pushed in odd-sized chunks, like a decoder's output.
      for (let i = 0; i < n; i += 777) meter.push(sine.subarray(i, i + 777))
      const env = meter.finish()
      expect(env.power.length).toBe(60)
      const windows = Array.from(env.power, (power) => ({ power, weight: 1 }))
      expect(integratedLoudness(windows)).toBeCloseTo(-3.01, 1)
    }
  })

  it('sums the channels of interleaved stereo (dual mono is 3 dB louder than mono)', () => {
    const rate = 16000
    const meter = new LevelMeter(rate, 2)
    const n = rate
    const st = new Float32Array(n * 2)
    for (let i = 0; i < n; i++) st[2 * i] = st[2 * i + 1] = 0.5 * Math.sin((2 * Math.PI * 1000 * i) / rate)
    meter.push(st)
    const l = integratedLoudness(Array.from(meter.finish().power, (power) => ({ power, weight: 1 })))
    expect(l).toBeCloseTo(-3.01 - 6.02 + 3.01, 1)
  })

  it('agrees with ffmpeg ebur128 on band-limited noise decoded at 16 kHz', () => {
    const ff = ffmpegPath()
    const src = ['-f', 'lavfi', '-i', 'anoisesrc=color=pink:amplitude=0.3:seed=7:d=6,lowpass=f=4000,volume=0.5']
    // ebur128 prints its summary (integrated loudness) on stderr.
    const r = spawnSync(ff, ['-hide_banner', '-nostats', ...src, '-af', 'ebur128=framelog=quiet', '-f', 'null', '-'], { encoding: 'utf8' })
    const reference = Number(/I:\s+(-?[\d.]+) LUFS/.exec(r.stderr)?.[1])
    expect(Number.isFinite(reference)).toBe(true)
    const pcm = execFileSync(ff, ['-v', 'error', ...src, '-ac', '2', '-ar', '16000', '-f', 'f32le', '-'], { maxBuffer: 1 << 26 })
    const meter = new LevelMeter(16000, 2)
    meter.push(new Float32Array(pcm.buffer, pcm.byteOffset, pcm.length / 4))
    const ours = integratedLoudness(Array.from(meter.finish().power, (power) => ({ power, weight: 1 })))!
    expect(Math.abs(ours - reference)).toBeLessThan(0.5)
  })

  it('gates silence out and returns null for a silent recording', () => {
    const half = [...run(-20, 3), ...run(-300, 3)].map((db) => ({ power: db <= -200 ? 0 : 10 ** (db / 10), weight: 1 }))
    // The silent half does not pull the loudness down 3 dB (only the blocks at the edge count, a little).
    expect(Math.abs(integratedLoudness(half)! - loudnessOf(10 ** -2))).toBeLessThan(0.5)
    expect(integratedLoudness(run(-300, 2).map(() => ({ power: 0, weight: 1 })))).toBeNull()
    expect(integratedLoudness([])).toBeNull()
  })

  it('normalises to -16 LUFS within ±30 dB, and leaves silence alone', () => {
    expect(normalizeGain(-22)).toBeCloseTo(10 ** (6 / 20), 6)
    expect(normalizeGain(-10)).toBeCloseTo(10 ** (-6 / 20), 6)
    expect(normalizeGain(-90)).toBeCloseTo(10 ** (30 / 20), 6)
    expect(normalizeGain(null)).toBe(1)
  })
})

describe('sound activity', () => {
  it('finds speech above the noise floor and bridges short pauses', () => {
    // 1 s noise, 2 s speech with a 0.3 s pause, 1 s noise, 1 s speech, 1 s noise.
    const env = levels([...run(-60, 1), ...run(-20, 1), ...run(-60, 0.3), ...run(-20, 0.7), ...run(-60, 1), ...run(-25, 1), ...run(-60, 1)])
    const r = detectActivity(env)
    expect(r).toHaveLength(2)
    expect(r[0].start).toBeCloseTo(1, 6)
    expect(r[0].end).toBeCloseTo(3, 6)
    expect(r[1].start).toBeCloseTo(4, 6)
    expect(r[1].end).toBeCloseTo(5, 6)
  })

  it('ignores clicks shorter than the minimum length', () => {
    const env = levels([...run(-60, 1), ...run(-10, 0.05), ...run(-60, 1)])
    expect(detectActivity(env)).toEqual([])
  })

  it('raises the threshold over a noisy floor, but never above the ceiling', () => {
    const noisy = levels([...run(-40, 2), ...run(-15, 1), ...run(-40, 2)])
    expect(detectActivity(noisy).map((r) => [r.start, r.end])).toEqual([[2, 3]])
    // Speech all the way through: still active.
    expect(detectActivity(levels(run(-24, 3)))).toHaveLength(1)
    // Digital silence only: nothing.
    expect(detectActivity(levels(run(-300, 3)))).toEqual([])
  })

  it('combines sources in power', () => {
    const a = levels([-20, -300])
    const b = levels([-20, -20, -20])
    const c = combineLevels([a, b])!
    expect(c.power.length).toBe(3)
    expect(10 * Math.log10(c.power[0])).toBeCloseTo(-16.99, 1)
    expect(combineLevels([])).toBeNull()
  })

  it('maps ranges onto the output through cuts and speed changes', () => {
    const clips = [clip(0, 2), clip(4, 8, 2)]
    expect(rangesToOutput([{ start: 1, end: 5 }], clips)).toEqual([{ start: 1, end: 2.5 }])
    expect(rangesToOutput([{ start: 2.5, end: 3.5 }], clips)).toEqual([])
    expect(rangesToOutput([{ start: 6, end: 9 }], clips)).toEqual([{ start: 3, end: 4 }])
  })

  it('merges ranges closer than a gap', () => {
    expect(mergeRanges([{ start: 3, end: 4 }, { start: 0, end: 1 }, { start: 1.2, end: 2 }], 0.3)).toEqual([
      { start: 0, end: 2 },
      { start: 3, end: 4 }
    ])
  })
})

describe('gain automation', () => {
  it('fades in and out linearly, fitting fades into short sounds', () => {
    expect(fadeGainAt(0, 10, 2, 3)).toBe(0)
    expect(fadeGainAt(1, 10, 2, 3)).toBeCloseTo(0.5)
    expect(fadeGainAt(5, 10, 2, 3)).toBe(1)
    expect(fadeGainAt(8.5, 10, 2, 3)).toBeCloseTo(0.5)
    expect(fadeKeyframes(10, 2, 3)).toEqual([
      { t: 0, gain: 0 },
      { t: 2, gain: 1 },
      { t: 7, gain: 1 },
      { t: 10, gain: 0 }
    ])
    expect(fitFades(1, 5, 5)).toEqual({ fadeIn: 1, fadeOut: 1 })
    expect(fadeKeyframes(10, 0, 0)).toEqual([
      { t: 0, gain: 1 },
      { t: 10, gain: 1 }
    ])
  })

  it('ducks with a lead-in attack and a release, joining close ranges', () => {
    const shape = { depth: 0.8, ...DUCK_TIMING }
    const ranges = duckRanges([{ start: 2, end: 3 }, { start: 3.3, end: 4 }, { start: 8, end: 9 }], shape)
    expect(ranges).toEqual([
      { start: 2, end: 4 },
      { start: 8, end: 9 }
    ])
    expect(duckGainAt(ranges, 1, shape)).toBe(1)
    expect(duckGainAt(ranges, 2 - DUCK_TIMING.attack / 2, shape)).toBeCloseTo(0.6)
    expect(duckGainAt(ranges, 3, shape)).toBeCloseTo(0.2)
    expect(duckGainAt(ranges, 4 + DUCK_TIMING.release, shape)).toBeCloseTo(1)
    const keys = duckKeyframes(ranges, 10, shape)
    for (let t = 0; t <= 10; t += 0.01) expect(gainAt(keys, t)).toBeCloseTo(duckGainAt(ranges, t, shape), 5)
  })

  it('writes the same curve as an ffmpeg expression (a binary search over the ranges)', () => {
    const shape = { depth: 0.75, attack: 0.2, release: 0.5 }
    const activity = Array.from({ length: 9 }, (_, i) => ({ start: 0.1 + i * 2, end: 0.9 + i * 2 }))
    const expr = duckExpression(activity, shape)
    expect(expr.startsWith('1-0.75*if(lt(t,')).toBe(true)
    expect(expr).toContain('t+0.1')
    // Evaluate it with a tiny interpreter of the few functions it uses.
    const fn = new Function('t', `const clip=(v,a,b)=>Math.min(b,Math.max(a,v)),lt=(a,b)=>a<b?1:0,iff=(c,a,b)=>c?a:b;return ${expr.replace(/\bif\(/g, 'iff(')}`) as (t: number) => number
    const ranges = duckRanges(activity, shape)
    for (let t = 0; t <= 18; t += 0.013) expect(fn(t)).toBeCloseTo(duckGainAt(ranges, t, shape), 3)
    expect(duckExpression([], shape)).toBe('1')
    expect(duckExpression(activity, { ...shape, depth: 0 })).toBe('1')
  })

  it('never ducks more than the depth, even for overlapping input', () => {
    const shape = { depth: 1, ...DUCK_TIMING }
    expect(duckAmount([{ start: 0, end: 1 }, { start: 0.5, end: 2 }], 0.7, shape)).toBe(1)
  })
})

describe('sound settings', () => {
  it('fills in defaults for older projects and sanitises odd values', () => {
    const look = audioLook({ volume: 1, muted: false })
    expect(look).toEqual({
      volume: 1,
      muted: false,
      mic: { volume: 1, muted: false },
      system: { volume: 1, muted: false },
      noiseReduction: 0,
      normalize: false,
      fadeIn: 0,
      fadeOut: 0,
      music: null
    })
    const odd = audioLook({ volume: 9, muted: false, noiseReduction: -1, music: { path: '../x.mp3', volume: 1, ducking: 1, loop: true, fadeIn: 0, fadeOut: 0 } })
    expect(odd.volume).toBe(2)
    expect(odd.noiseReduction).toBe(0)
    expect(odd.music).toBeNull()
  })

  it('uses the mixed track unless a source has its own gain (or the export cleans the microphone)', () => {
    const stems = { audioStems: { mic: true, system: true } }
    expect(recordingMix(project())).toEqual({ kind: 'mix', volume: 1 })
    expect(recordingMix(project(stems))).toEqual({ kind: 'mix', volume: 1 })
    expect(recordingMix(project({ ...stems, audio: { volume: 0.8, muted: false, mic: { volume: 1.5, muted: false } } }))).toEqual({
      kind: 'stems',
      volume: 0.8,
      stems: { mic: 1.5, system: 1 }
    })
    expect(recordingMix(project({ ...stems, audio: { volume: 1, muted: false, system: { volume: 1, muted: true } } }))).toEqual({ kind: 'stems', volume: 1, stems: { mic: 1 } })
    const nr = project({ ...stems, audio: { volume: 1, muted: false, noiseReduction: 0.5 } })
    expect(recordingMix(nr).kind).toBe('mix')
    expect(recordingMix(nr, { denoise: true }).kind).toBe('stems')
    expect(recordingMix(project({ ...stems, audio: { volume: 1, muted: false, mic: { volume: 0, muted: false }, system: { volume: 1, muted: true } } }))).toEqual({ kind: 'none' })
    expect(recordingMix(project({ audio: { volume: 1, muted: true } }))).toEqual({ kind: 'none' })
    expect(recordingMix(project({ hasAudio: false }))).toEqual({ kind: 'none' })
  })

  it('knows the stems, the activity sources and when the preview needs Web Audio', () => {
    expect(stemsOf(project())).toEqual([])
    expect(stemsOf(project({ audioStems: { mic: true, system: false } }))).toEqual(['mic'])
    expect(stemsOf(project({ hasAudio: false, audioStems: { mic: true, system: true } }))).toEqual([])
    expect(activitySources(project())).toEqual(['mix'])
    expect(activitySources(project({ audioStems: { mic: true, system: true }, audio: { volume: 1, muted: false, system: { volume: 1, muted: true } } }))).toEqual(['mic'])
    expect(needsAudioGraph(project())).toBe(false)
    expect(needsAudioGraph(project({ audio: { volume: 1.5, muted: false } }))).toBe(true)
    expect(needsAudioGraph(project({ audio: { volume: 1, muted: false, fadeIn: 1 } }))).toBe(true)
    expect(needsAudioGraph(project({ audio: { volume: 1, muted: true, fadeIn: 1 } }))).toBe(false)
    const music = { path: 'music.mp3', volume: 0.4, ducking: 0.5, loop: true, fadeIn: 1, fadeOut: 1 }
    expect(needsAudioGraph(project({ hasAudio: false, audio: { volume: 1, muted: false, music } }))).toBe(true)
    expect(hasSoundtrack(project({ hasAudio: false }), false)).toBe(false)
    expect(hasSoundtrack(project({ hasAudio: false, audio: { volume: 1, muted: false, music } }), false)).toBe(true)
    expect(hasSoundtrack(project({ hasAudio: false }), true)).toBe(true)
  })

  it('plays non-looping music until it runs out', () => {
    expect(musicEnd(30, 12, false)).toBe(12)
    expect(musicEnd(30, 12, true)).toBe(30)
    expect(musicEnd(30, 45, false)).toBe(30)
    expect(musicEnd(30, null, false)).toBe(30)
  })
})

describe('shared preview/export sound decisions', () => {
  const music = { path: 'music.m4a', volume: 0.5, ducking: 0.6, loop: true, fadeIn: 0, fadeOut: 0 }
  const speech = levels([...run(-60, 2), ...run(-20, 2), ...run(-60, 6)])

  it('asks only for the levels it needs', () => {
    expect(analysisSources(project())).toEqual([])
    expect(analysisSources(project({ audio: { volume: 1, muted: false, music } }))).toEqual(['mix'])
    expect(analysisSources(project({ audioStems: { mic: true, system: true }, audio: { volume: 1, muted: false, music } }))).toEqual(['mic', 'system'])
    expect(analysisSources(project({ audio: { volume: 1, muted: false, normalize: true } }))).toEqual(['mix'])
  })

  it('finds activity on the output timeline, or null until the levels are known', () => {
    const p = project({ clips: [clip(0, 1), clip(2, 10)], audio: { volume: 1, muted: false, music } })
    expect(soundActivity(p, {})).toBeNull()
    expect(soundActivity(p, { mix: speech })).toEqual([{ start: 1, end: 3 }])
    expect(soundActivity(project({ audio: { volume: 1, muted: true, music } }), {})).toEqual([])
    const d = musicDucking(p, soundActivity(p, { mix: speech }))!
    expect(d.shape.depth).toBe(0.6)
    expect(d.ranges).toEqual([{ start: 1, end: 3 }])
    expect(musicDucking(project(), [{ start: 0, end: 1 }])).toBeNull()
  })

  it('measures the loudness as heard: kept clips, stem gains, speed', () => {
    const mic = levels(run(-23.0 + 0.691, 10))
    const sys = levels(run(-300, 10))
    const p = project({ audioStems: { mic: true, system: true }, audio: { volume: 1, muted: false, mic: { volume: 2, muted: false }, normalize: true } })
    // Twice the gain: 6 dB louder than the file.
    expect(recordingLoudness(p, { mic, system: sys })).toBeCloseTo(-23 + 6.02, 1)
    expect(previewNormalizeGain(p, { mic, system: sys })).toBeCloseTo(10 ** ((-16 - (-23 + 6.02)) / 20), 2)
    expect(recordingLoudness(p, { mic })).toBeNull()
    expect(previewNormalizeGain(project({ hasAudio: false }), {})).toBe(1)
  })
})
