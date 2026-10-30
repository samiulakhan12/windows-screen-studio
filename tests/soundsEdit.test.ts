// What the finder changes in a project, and the one gain curve the preview and the export play
// (docs/design/sound-finder.md §3, §4.4–4.6), plus the cache entries (§3.3).
import { describe, expect, it } from 'vitest'
import { gainAt } from '../src/shared/audio/automation'
import { SCORE_COLUMNS, SOUND_MODEL } from '../src/shared/audio/sounds'
import { cacheEntry, cacheMatches, entryScores, fromBase64, MAX_WINDOWS, readCacheEntry, toBase64 } from '../src/shared/audio/soundsCache'
import {
  addSpans,
  bringBack,
  cutRow,
  DUCK_GAIN,
  ignoreRow,
  joinGains,
  readSoundEdits,
  removeSpan,
  restoreCut,
  rowState,
  soundGainAt,
  soundGainExpression,
  soundGainFilters,
  soundGainKeyframes,
  soundGains,
  soundOutputKeyframes,
  SOUND_FADE,
  validSoundGains
} from '../src/shared/audio/soundsEdit'
import { freezePlan, NO_FREEZES } from '../src/shared/engine/freeze'
import { migrateProject } from '../src/shared/engine/project'
import { audioFilterGraph, planSoundtrack, recordingGraph } from '../src/shared/render/audioPlan'
import type { ExportJob } from '../src/shared/api/export'
import type { Clip, Project } from '../src/shared/types'

const clip = (start: number, end: number, speed = 1, id = `${start}`): Clip => ({ id, start, end, speed })

function project(over: Record<string, unknown> = {}): Project {
  return migrateProject({
    version: 2,
    id: 'p',
    name: 'p',
    createdAt: '',
    duration: 60,
    width: 1280,
    height: 720,
    hasWebcam: false,
    hasAudio: true,
    webcamOffset: 0,
    capture: { method: 'chromium', cursorInVideo: true, region: null },
    clips: [clip(0, 60)],
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

const row = (key: string, start: number, end: number) => ({ key, start, end })

/** An ffmpeg expression evaluated with the few functions it uses. */
const evaluate = (expr: string): ((t: number) => number) =>
  new Function('t', `const clip=(v,a,b)=>Math.min(b,Math.max(a,v)),lt=(a,b)=>a<b?1:0,iff=(c,a,b)=>c?a:b;return ${expr.replace(/\bif\(/g, 'iff(')}`) as (t: number) => number

describe('Project.sounds on disk', () => {
  it('leaves a project without it exactly as it was', () => {
    const p = project()
    expect('sounds' in p).toBe(false)
    expect(JSON.stringify(migrateProject(JSON.parse(JSON.stringify(p))))).toBe(JSON.stringify(p))
  })

  it('reads it sanitised, and drops it when nothing is left', () => {
    const p = project({
      sounds: {
        spans: [
          { start: 50, end: 70, action: 'duck', key: 'music-5000' },
          { start: 3, end: 3.5, action: 'mute', key: 'ping-300' },
          { start: 4, end: 4.001, action: 'mute', key: 'ping-400' },
          { start: 5, end: 6, action: 'shout', key: 'ping-500' },
          { start: 5, end: 6, action: 'mute', key: '../x' },
          { start: Number.NaN, end: 6, action: 'mute', key: 'ping-600' },
          null
        ],
        ignored: ['dog-100', 'dog-100', 7, 'Dog 1']
      }
    })
    expect(p.sounds).toEqual({
      spans: [
        { start: 3, end: 3.5, action: 'mute', key: 'ping-300' },
        { start: 50, end: 60, action: 'duck', key: 'music-5000' }
      ],
      ignored: ['dog-100']
    })
    expect('sounds' in project({ sounds: { spans: [], ignored: [] } })).toBe(false)
    expect('sounds' in project({ sounds: 'loud' })).toBe(false)
    expect(readSoundEdits({ spans: Array.from({ length: 5000 }, (_, i) => ({ start: i / 100, end: i / 100 + 0.5, action: 'mute', key: `ping-${i}` })) }, 60)!.spans.length).toBe(2000)
  })
})

describe('rows and actions', () => {
  it('mutes, lowers and restores, each a new project, and goes back to none', () => {
    const p = project()
    const muted = addSpans(p, [row('cough-1000', 10, 10.4)], 'mute')
    expect(muted.sounds).toEqual({ spans: [{ start: 10, end: 10.4, action: 'mute', key: 'cough-1000' }], ignored: [] })
    expect(rowState(muted, row('cough-1000', 10, 10.4))).toBe('muted')
    expect(addSpans(muted, [row('cough-1000', 10, 10.4)], 'duck')).toBe(muted)
    const both = addSpans(muted, [row('music-500', 5, 9), row('dog-2000', 20, 21)], 'duck')
    expect(both.sounds!.spans.map((s) => s.key)).toEqual(['music-500', 'cough-1000', 'dog-2000'])
    expect(rowState(both, row('dog-2000', 20, 21))).toBe('ducked')
    const back = removeSpan(removeSpan(removeSpan(both, 'music-500'), 'cough-1000'), 'dog-2000')
    expect('sounds' in back).toBe(false)
    expect(removeSpan(p, 'nope')).toBe(p)
  })

  it('cuts and restores a row as an ordinary cut', () => {
    const p = project()
    const cut = cutRow(p, row('dog-2000', 20, 21))
    expect(cut.clips.map((c) => [c.start, c.end])).toEqual([
      [0, 20],
      [21, 60]
    ])
    expect(rowState(cut, row('dog-2000', 20, 21))).toBe('cut')
    expect(cutRow(cut, row('dog-2000', 20, 21))).toBe(cut)
    const restored = restoreCut(cut, row('dog-2000', 20, 21))
    expect(restored.clips.map((c) => [c.start, c.end])).toEqual([[0, 60]])
    expect(restoreCut(restored, row('dog-2000', 20, 21))).toBe(restored)
    // Never the whole video.
    expect(cutRow(p, row('music-0', 0, 60))).toBe(p)
  })

  it('ignores and brings back', () => {
    const p = project()
    const ig = ignoreRow(p, 'ping-100')
    expect(rowState(ig, row('ping-100', 1, 1.2))).toBe('ignored')
    expect(ignoreRow(ig, 'ping-100')).toBe(ig)
    expect(rowState(ig, row('ping-200', 2, 2.2))).toBe('open')
    expect('sounds' in bringBack(ig, 'ping-100')).toBe(false)
    // Muting an ignored row takes it off the ignored list.
    expect(addSpans(ig, [row('ping-100', 1, 1.2)], 'mute').sounds!.ignored).toEqual([])
  })
})

describe('the gain curve', () => {
  const gains = joinGains([
    { start: 1, end: 2, gain: 0 },
    { start: 2.03, end: 3, gain: DUCK_GAIN }, // 30 ms after: joined, the lower gain wins
    { start: 5, end: 6, gain: DUCK_GAIN },
    { start: 0.01, end: 0.5, gain: 0 }
  ])

  it('joins stretches closer than two ramps', () => {
    expect(gains).toEqual([
      { start: 0.01, end: 0.5, gain: 0 },
      { start: 1, end: 3, gain: 0 },
      { start: 5, end: 6, gain: DUCK_GAIN }
    ])
    expect(soundGains(project({ sounds: { spans: [{ start: 5, end: 6, action: 'duck', key: 'dog-500' }, { start: 1, end: 2, action: 'mute', key: 'dog-100' }], ignored: [] } }))).toEqual([
      { start: 1, end: 2, gain: 0 },
      { start: 5, end: 6, gain: DUCK_GAIN }
    ])
  })

  it('ramps outside the stretch, which is fully muted or lowered', () => {
    expect(soundGainAt(gains, 0.98)).toBe(1)
    expect(soundGainAt(gains, 1 - SOUND_FADE / 2)).toBeCloseTo(0.5, 6)
    expect(soundGainAt(gains, 1)).toBe(0)
    expect(soundGainAt(gains, 2.5)).toBe(0)
    expect(soundGainAt(gains, 3 + SOUND_FADE / 4)).toBeCloseTo(0.25, 6)
    expect(soundGainAt(gains, 5.5)).toBeCloseTo(DUCK_GAIN, 9)
    expect(soundGainAt(gains, 7)).toBe(1)
    expect(soundGainAt([], 1)).toBe(1)
    const keys = soundGainKeyframes(gains)
    for (let t = -0.1; t < 7; t += 0.0007) expect(gainAt(keys, t)).toBeCloseTo(soundGainAt(gains, t), 6)
  })

  it('writes the same curve as an ffmpeg expression', () => {
    const fn = evaluate(soundGainExpression(gains))
    for (let t = 0; t < 7; t += 0.0013) expect(fn(t)).toBeCloseTo(soundGainAt(gains, t), 3)
    expect(soundGainExpression([])).toBe('1')
    expect(soundGainFilters([])).toBe('')
    expect(soundGainFilters(gains)).toMatch(/^asetnsamples=n=256:p=0,volume=volume='.*':eval=frame$/)
    // Many stretches: a balanced search.
    const many = joinGains(Array.from({ length: 3000 }, (_, i) => ({ start: i, end: i + 0.3, gain: i % 2 ? 0 : DUCK_GAIN })))
    const big = evaluate(soundGainExpression(many))
    for (let t = 0; t < 3000; t += 0.731) expect(big(t)).toBeCloseTo(soundGainAt(many, t), 3)
  })

  it('maps the curve onto the output timeline through cuts, speed changes and pause freezes', () => {
    const clips = [clip(0, 1.5), clip(2.5, 4, 2), clip(4, 10)]
    const g = joinGains([{ start: 1, end: 3, gain: 0 }, { start: 5, end: 6, gain: DUCK_GAIN }])
    const out = soundOutputKeyframes(g, clips, NO_FREEZES)
    for (let i = 1; i < out.length; i++) expect(out[i].t).toBeGreaterThan(out[i - 1].t)
    // Every source time a clip plays sounds at its gain at its output time.
    const outAt = (t: number): number => (t < 1.5 ? t : t < 4 ? 1.5 + (t - 2.5) / 2 : 2.25 + (t - 4))
    for (const [a, b] of [[0, 1.5], [2.5, 4], [4, 10]]) for (let t = a + 0.001; t < b - 0.001; t += 0.0031) expect(gainAt(out, outAt(t))).toBeCloseTo(soundGainAt(g, t), 4)
    expect(soundOutputKeyframes([], clips, NO_FREEZES)).toEqual([])
    // A pause freeze of 2 s at source 4.5 (inside the last clip): later times move by its length.
    const plan = freezePlan(clips, [{ id: 'f', at: 4.5, length: 2, sound: 'pause' }])
    const held = soundOutputKeyframes(g, clips, plan)
    expect(gainAt(held, 2.25 + (5.5 - 4) + 2)).toBeCloseTo(DUCK_GAIN, 6)
  })

  it('puts the curve on the export recording in source time, and changes nothing without it', () => {
    const clips = [clip(0, 5), clip(6, 10, 2)]
    const plain = recordingGraph({ clips, volume: 1, input: '1:a' }, 7)
    expect(recordingGraph({ clips, volume: 1, input: '1:a', sounds: [] }, 7)).toBe(plain)
    expect(plain).toBe(audioFilterGraph(clips, 1, 7))
    const withGain = recordingGraph({ clips, volume: 1, input: '1:a', sounds: [{ start: 1, end: 2, gain: 0 }] }, 7)
    expect(withGain).toContain("[1:a]aresample=48000:async=1:first_pts=0,asetnsamples=n=256:p=0,volume=volume='")
    // Before the split into clips: once, on the whole recording.
    expect(withGain.indexOf('volume=volume=')).toBeLessThan(withGain.indexOf('asplit'))
    const stems = recordingGraph({ clips, volume: 1, input: '1:a', stems: [{ input: '1:a', gain: 1, denoise: false }, { input: '2:a', gain: 0.5, denoise: false }], sounds: [{ start: 1, end: 2, gain: 0 }] }, 7)
    expect(stems).toMatch(/amix=inputs=2:duration=longest:dropout_transition=0:normalize=0,asetnsamples=n=256:p=0,volume=volume='[^']+':eval=frame,asplit/)
    const job = { frames: 210, fps: 30, audio: { clips, volume: 1, sounds: [{ start: 1, end: 2, gain: 0 }] } } as unknown as ExportJob
    expect(planSoundtrack(job, { mix: 'screen.mp4' }, 1).graph).toContain("volume=volume='")
    const none = { frames: 210, fps: 30, audio: { clips, volume: 1 } } as unknown as ExportJob
    expect(planSoundtrack(none, { mix: 'screen.mp4' }, 1).graph).not.toContain("volume=volume='")
  })

  it('validates export jobs', () => {
    expect(validSoundGains([{ start: 1, end: 2, gain: 0 }])).toBe(true)
    expect(validSoundGains([])).toBe(true)
    for (const bad of [null, 'x', [{ start: 2, end: 1, gain: 0 }], [{ start: -1, end: 1, gain: 0 }], [{ start: 1, end: 2, gain: 2 }], [{ start: 1, end: Infinity, gain: 0 }], [{ start: 1, end: 2 }], Array(4001).fill({ start: 1, end: 2, gain: 0 })])
      expect(validSoundGains(bad)).toBe(false)
  })
})

describe('cache entries', () => {
  it('round-trips base64', () => {
    for (const n of [0, 1, 2, 3, 4, 100]) {
      const b = Uint8Array.from({ length: n }, (_, i) => (i * 37) % 256)
      const text = toBase64(b)
      expect(text).toBe(Buffer.from(b).toString('base64'))
      expect([...fromBase64(text, n)!]).toEqual([...b])
    }
    expect(fromBase64('abc', 10)).toBeNull()
    expect(fromBase64('ab$=', 10)).toBeNull()
    expect(fromBase64('AAAA', 2)).toBeNull()
  })

  it('accepts what it wrote, refuses anything malformed, and matches only the same file, model, version and skip', () => {
    const scores = Uint8Array.from({ length: 10 * SCORE_COLUMNS.length }, (_, i) => i % 200)
    const e = cacheEntry({ size: 100, mtimeMs: 5 }, 'none', 10, scores)
    const read = readCacheEntry(JSON.parse(JSON.stringify(e)))!
    expect(read).toEqual(e)
    expect([...entryScores(read)]).toEqual([...scores])
    expect(read.model).toBe(SOUND_MODEL.sha256)
    expect(cacheMatches(read, { size: 100, mtimeMs: 5 }, 'none')).toBe(true)
    expect(cacheMatches(read, { size: 101, mtimeMs: 5 }, 'none')).toBe(false)
    expect(cacheMatches(read, { size: 100, mtimeMs: 6 }, 'none')).toBe(false)
    expect(cacheMatches(read, { size: 100, mtimeMs: 5 }, 'abcdef01')).toBe(false)
    expect(cacheMatches({ ...read, model: 'a'.repeat(64) }, { size: 100, mtimeMs: 5 }, 'none')).toBe(false)
    expect(cacheMatches({ ...read, scan: 2 }, { size: 100, mtimeMs: 5 }, 'none')).toBe(false)
    for (const bad of [
      null,
      [],
      { ...e, size: -1 },
      { ...e, model: 'x' },
      { ...e, skip: 'zz' },
      { ...e, n: 11 },
      { ...e, n: MAX_WINDOWS + 1 },
      { ...e, scores: e.scores.slice(0, -4) },
      { ...e, scores: `${e.scores.slice(0, -4)}$$$$` },
      { ...e, columns: ['speech', 'Bad name'] },
      { ...e, hop: 0 },
      { ...e, scan: 1.5 }
    ])
      expect(readCacheEntry(bad)).toBeNull()
  })
})
