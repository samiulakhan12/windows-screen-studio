// Sound levels, activity, gain automation and the shared sound decisions (shared/audio).
import { execFileSync, spawnSync } from 'node:child_process'
import { describe, expect, it } from 'vitest'
import { ffmpegPath } from '../src/main/ffmpeg'
import { combineLevels, detectActivity, kthSmallest, limitRanges, mergeRanges, rangesToOutput } from '../src/shared/audio/activity'
import { DUCK_TIMING, duckAmount, duckExpression, duckGainAt, duckKeyframes, duckRanges, fadeGainAt, fadeKeyframes, fitFades, gainAt, MAX_DUCK_RANGES } from '../src/shared/audio/automation'
import { integratedLoudness, kWeighting, LEVEL_WINDOW, LevelMeter, loudnessOf, normalizeGain, type AudioLevels } from '../src/shared/audio/loudness'
import { activitySources, audioLook, hasSoundtrack, musicEnd, needsAudioGraph, recordingMix, stemsOf } from '../src/shared/audio/settings'
import { analysisSources, editLoudness, heardLevels, musicDucking, previewNormalizeGain, recordingLoudness, soundActivity, sourceActivity } from '../src/shared/audio/soundtrack'
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
      expect(integratedLoudness({ power: env.power })).toBeCloseTo(-3.01, 1)
    }
  })

  it('sums the channels of interleaved stereo (dual mono is 3 dB louder than mono)', () => {
    const rate = 16000
    const meter = new LevelMeter(rate, 2)
    const n = rate
    const st = new Float32Array(n * 2)
    for (let i = 0; i < n; i++) st[2 * i] = st[2 * i + 1] = 0.5 * Math.sin((2 * Math.PI * 1000 * i) / rate)
    meter.push(st)
    const l = integratedLoudness({ power: meter.finish().power })
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
    const ours = integratedLoudness({ power: meter.finish().power })!
    expect(Math.abs(ours - reference)).toBeLessThan(0.5)
  })

  it('gates silence out and returns null for a silent recording', () => {
    const half = levels([...run(-20, 3), ...run(-300, 3)])
    // The silent half does not pull the loudness down 3 dB (only the blocks at the edge count, a little).
    expect(Math.abs(integratedLoudness(half)! - loudnessOf(10 ** -2))).toBeLessThan(0.5)
    expect(integratedLoudness(levels(run(-300, 2)))).toBeNull()
    expect(integratedLoudness({ power: [] })).toBeNull()
  })

  it('weighs each window by how long it lasts in the output', () => {
    // 2 s at -20 dB played at 2x (1 s heard) and 1 s at -30 dB: the quieter part counts as much.
    const power = levels([...run(-20, 2), ...run(-30, 1)]).power
    const weight = Float64Array.from(power, (_, i) => (i < 40 ? 0.5 : 1))
    const even = loudnessOf((10 ** -2 + 10 ** -3) / 2)
    expect(integratedLoudness({ power, weight })!).toBeCloseTo(even, 0)
    expect(integratedLoudness({ power })!).toBeGreaterThan(integratedLoudness({ power, weight })!)
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

  it('maps unsorted and overlapping ranges like their union', () => {
    const clips = [clip(0, 2), clip(4, 8, 2)]
    expect(rangesToOutput([{ start: 6, end: 9 }, { start: 1, end: 1.5 }, { start: 1.2, end: 5 }], clips)).toEqual([
      { start: 1, end: 2.5 },
      { start: 3, end: 4 }
    ])
    expect(rangesToOutput([], clips)).toEqual([])
  })

  it('finds the noise floor percentile without sorting (quickselect)', () => {
    let seed = 7
    const rnd = (): number => (seed = (seed * 16807) % 2147483647) / 2147483647
    for (let trial = 0; trial < 500; trial++) {
      const n = 1 + Math.floor(rnd() * 50)
      const kind = trial % 4
      // Random, ascending, descending, and with many duplicates.
      const values = Float64Array.from({ length: n }, (_, i) => (kind === 0 ? rnd() : kind === 1 ? i : kind === 2 ? n - i : Math.floor(rnd() * 3)))
      const k = Math.floor(rnd() * n)
      expect(kthSmallest(Float64Array.from(values), k)).toBe(Float64Array.from(values).sort()[k])
    }
  })

  it('limits the number of ranges by joining the closest neighbours first', () => {
    const ranges = [
      { start: 0, end: 1 },
      { start: 1.5, end: 2 }, // 0.5 s gap
      { start: 5, end: 6 }, // 3 s gap
      { start: 6.2, end: 7 }, // 0.2 s gap
      { start: 9, end: 10 } // 2 s gap
    ]
    expect(limitRanges(ranges, 10)).toEqual(ranges)
    expect(limitRanges(ranges, 4)).toEqual([{ start: 0, end: 1 }, { start: 1.5, end: 2 }, { start: 5, end: 7 }, { start: 9, end: 10 }])
    expect(limitRanges(ranges, 3)).toEqual([{ start: 0, end: 2 }, { start: 5, end: 7 }, { start: 9, end: 10 }])
    expect(limitRanges(ranges, 1)).toEqual([{ start: 0, end: 10 }])
    expect(limitRanges(ranges, 0)).toEqual([{ start: 0, end: 10 }])
    expect(limitRanges([], 3)).toEqual([])
    // Of equal gaps, the earliest are joined: exactly as many ranges as asked for, not one.
    const even = Array.from({ length: 10 }, (_, i) => ({ start: i, end: i + 0.5 }))
    const limited = limitRanges(even, 7)
    expect(limited).toHaveLength(7)
    expect(limited[0]).toEqual({ start: 0, end: 3.5 })
    expect(limited.slice(1)).toEqual(even.slice(4))
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

  it('keyframes a long, busy recording exactly, in linear time', () => {
    const shape = { depth: 0.7, ...DUCK_TIMING }
    let seed = 11
    const rnd = (): number => (seed = (seed * 16807) % 2147483647) / 2147483647
    // Unjoined input with bursts and pauses of every length, one starting before 0, one running past the end.
    const activity: { start: number; end: number }[] = [{ start: -1, end: 0.05 }]
    for (let t = 0.3; t < 590; ) {
      const len = 0.05 + rnd() * 2
      activity.push({ start: t, end: t + len })
      t += len + rnd() * 2
    }
    activity.push({ start: 599.9, end: 640 })
    const ranges = duckRanges(activity, shape)
    const keys = duckKeyframes(activity, 600, shape)
    expect(keys[0].t).toBe(0)
    expect(keys[keys.length - 1].t).toBe(600)
    for (let i = 1; i < keys.length; i++) expect(keys[i].t).toBeGreaterThan(keys[i - 1].t)
    for (let t = 0; t <= 600; t += 0.0371) expect(gainAt(keys, t)).toBeCloseTo(duckGainAt(ranges, t, shape), 5)
    // Thousands of ranges take milliseconds, not seconds.
    const many = Array.from({ length: 5000 }, (_, i) => ({ start: i, end: i + 0.2 }))
    const t0 = performance.now()
    expect(duckKeyframes(many, 5000, shape).length).toBeGreaterThan(4 * 4999)
    expect(performance.now() - t0).toBeLessThan(500)
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

  it('splits activity into a source-time step (per measurement) and the edit mapping', () => {
    const p = project({ clips: [clip(0, 1), clip(2, 10, 2)], audio: { volume: 1, muted: false, music } })
    const source = sourceActivity(p, { mix: speech })!
    expect(source).toEqual([{ start: 2, end: 4 }])
    expect(soundActivity(p, { mix: speech })).toEqual(rangesToOutput(source, p.clips))
    expect(sourceActivity(p, {})).toBeNull()
  })

  it('ducks under at most MAX_DUCK_RANGES ranges, the same in the preview and the export', () => {
    const p = project({ audio: { volume: 1, muted: false, music } })
    // A burst every 0.8 s for over an hour: more ranges than an export takes.
    const activity = Array.from({ length: MAX_DUCK_RANGES + 500 }, (_, i) => ({ start: i * 0.8, end: i * 0.8 + 0.15 }))
    const d = musicDucking(p, activity)!
    expect(d.ranges.length).toBeLessThanOrEqual(MAX_DUCK_RANGES)
    expect(d.ranges.length).toBeGreaterThan(MAX_DUCK_RANGES / 2)
    expect(d.ranges[0].start).toBe(0)
    expect(d.ranges[d.ranges.length - 1].end).toBeCloseTo(activity[activity.length - 1].end, 9)
    // Joined again by the export (duckRanges in duckExpression), the ranges stay the same.
    expect(duckRanges(d.ranges, d.shape)).toEqual(d.ranges)
    expect(musicDucking(p, activity.slice(0, 100))!.ranges).toHaveLength(100)
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
    // In two steps (the preview mixes once per measurement, then measures each edit).
    const heard = heardLevels(p, { mic, system: sys })!
    expect(editLoudness(heard, p.clips)).toBe(recordingLoudness(p, { mic, system: sys }))
    expect(heardLevels(project(), { mix: mic })).toBe(mic)
    expect(heardLevels(p, { mic })).toBeNull()
    // Only kept clips count: the quiet part is cut out.
    const loudThenQuiet = levels([...run(-20, 5), ...run(-40, 5)])
    expect(editLoudness(loudThenQuiet, [clip(0, 5)])!).toBeCloseTo(-20.691, 1)
  })
})
