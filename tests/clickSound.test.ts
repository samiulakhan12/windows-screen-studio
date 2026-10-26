import { execFileSync } from 'node:child_process'
import { describe, expect, it } from 'vitest'
import { ffmpegPath } from '../src/main/ffmpeg'
import { effectiveTrack } from '../src/shared/engine/inputTrack'
import { createProject } from '../src/shared/engine/project'
import {
  CLICK_MIN_GAP,
  CLICK_SOUND,
  clickSample,
  clickSoundExpression,
  clickSoundJob,
  ClickSoundScheduler,
  clickSoundSource,
  clickWaveform,
  soundingClicks
} from '../src/shared/render/clickSound'
import type { ClickEvent, Clip, CursorTrack, Project } from '../src/shared/types'

const click = (t: number, x = 0.5, y = 0.5, button: ClickEvent['button'] = 'left'): ClickEvent => ({ t, x, y, button })
const track = (clicks: ClickEvent[], valid = true): CursorTrack => ({ samples: [], clicks, valid })

function project(cursor: Partial<Project['cursor']> = {}): Project {
  const p = createProject({
    id: 'rec-1',
    name: 'Test',
    duration: 20,
    width: 1920,
    height: 1080,
    hasWebcam: false,
    hasAudio: false,
    webcamOffset: 0,
    zooms: [],
    cursorValid: true,
    capture: { method: 'native', cursorInVideo: false, region: null }
  })
  return { ...p, cursor: { ...p.cursor, ...cursor } }
}

const full: Clip[] = [{ id: 'a', start: 0, end: 20, speed: 1 }]
// Output: 0..2 = source 1..3; source 3..5 is cut; 2..4 = source 5..9 at 2x; 4..5 = source 9..10 at 0.5x.
const edited: Clip[] = [
  { id: 'a', start: 1, end: 3, speed: 1 },
  { id: 'b', start: 5, end: 9, speed: 2 },
  { id: 'c', start: 9, end: 9.5, speed: 0.5 }
]

describe('clickSoundJob', () => {
  it('is null when click sounds are off (older projects have no setting)', () => {
    expect(clickSoundJob(project(), track([click(1)]), full)).toBeNull()
    const legacy = project()
    delete legacy.cursor.clickSound
    expect(clickSoundJob(legacy, track([click(1)]), full)).toBeNull()
  })

  it('is null without clicks, without cursor data or at zero volume', () => {
    expect(clickSoundJob(project({ clickSound: true }), track([]), full)).toBeNull()
    expect(clickSoundJob(project({ clickSound: true }), track([click(1)], false), full)).toBeNull()
    expect(clickSoundJob(project({ clickSound: true, clickSoundVolume: 0 }), track([click(1)]), full)).toBeNull()
  })

  it('places clicks at output times through cuts and speed changes, skipping cut clicks', () => {
    const clicks = [click(0.5), click(1.5), click(4), click(6), click(8.5), click(9.25), click(12)]
    const job = clickSoundJob(project({ clickSound: true, clickSoundVolume: 0.8 }), track(clicks), edited)
    expect(job).not.toBeNull()
    // 0.5: trimmed; 1.5 -> 0.5; 4: cut; 6 -> 2 + 1/2; 8.5 -> 2 + 3.5/2; 9.25 -> 4 + 0.25/0.5; 12: trimmed.
    expect(job!.times).toEqual([0.5, 2.5, 3.75, 4.5])
    expect(job!.volume).toBe(0.8)
  })

  it('every button sounds, but not clicks outside the recorded video', () => {
    const clicks = [click(1, 0.5, 0.5, 'right'), click(2, -0.1, 0.5), click(3, 0.5, 1.2), click(4, 1, 0, 'middle')]
    expect(clickSoundJob(project({ clickSound: true }), track(clicks), full)!.times).toEqual([1, 4])
  })

  it('sorts clicks and merges ones closer than the minimum gap (also after speeding up)', () => {
    const clicks = [click(3), click(1), click(1.01), click(2)]
    expect(clickSoundJob(project({ clickSound: true }), track(clicks), full)!.times).toEqual([1, 2, 3])
    // 40 ms apart in the recording, 5 ms apart at 8x.
    const fast: Clip[] = [{ id: 'a', start: 0, end: 20, speed: 8 }]
    const job = clickSoundJob(project({ clickSound: true }), track([click(1), click(1.04)]), fast)!
    expect(job.times).toEqual([0.125])
    expect(CLICK_MIN_GAP).toBeGreaterThan(0.005)
  })

  it('caches the sounding clicks per track', () => {
    const t = track([click(2), click(1)])
    expect(soundingClicks(t)).toBe(soundingClicks(t))
    expect(soundingClicks(t)).toEqual([1, 2])
  })
})

describe('click sound', () => {
  it('is a short, bounded click that starts and ends silent', () => {
    const w = clickWaveform(48000)
    expect(w.length).toBe(Math.round(CLICK_SOUND.duration * 48000))
    const peak = w.reduce((m, v) => Math.max(m, Math.abs(v)), 0)
    expect(peak).toBeGreaterThan(0.4)
    expect(peak).toBeLessThan(0.95)
    expect(w[0]).toBe(0)
    // Decayed to silence well before its end: no click when the buffer stops.
    expect(Math.abs(w[w.length - 1])).toBeLessThan(0.002)
    expect(clickSample(-0.01)).toBe(0)
    expect(clickSample(CLICK_SOUND.duration)).toBe(0)
  })

  it('is a filtergraph-safe aevalsrc source', () => {
    const src = clickSoundSource()
    expect(src.startsWith('aevalsrc=')).toBe(true)
    expect(src).toMatch(/:d=0\.06:s=48000$/)
    // No characters that would need escaping inside a filtergraph.
    expect(clickSoundExpression()).toMatch(/^[0-9A-Za-z.*+\-/()]+$/)
  })

  it('ffmpeg renders exactly the preview waveform', () => {
    const pcm = execFileSync(ffmpegPath(), ['-v', 'error', '-f', 'lavfi', '-i', clickSoundSource(), '-f', 'f32le', '-ac', '1', '-'], { maxBuffer: 1 << 24 })
    const rendered = new Float32Array(pcm.buffer, pcm.byteOffset, pcm.length / 4)
    const expected = clickWaveform(CLICK_SOUND.sampleRate)
    expect(rendered.length).toBe(expected.length)
    let maxDiff = 0
    for (let i = 0; i < expected.length; i++) maxDiff = Math.max(maxDiff, Math.abs(rendered[i] - expected[i]))
    expect(maxDiff).toBeLessThan(1e-4)
  })
})

describe('ClickSoundScheduler (preview playback)', () => {
  const clip = (start: number, end: number, speed = 1): Clip => ({ id: `${start}`, start, end, speed })

  /** Plays `clips` back to back at `fps` display frames per second; returns the clicks played (source times). */
  function play(s: ClickSoundScheduler, clips: Clip[], fps = 60): number[] {
    const played: number[] = []
    for (const c of clips) {
      s.restart(c.start)
      for (let t = c.start; t < c.end; t += c.speed / fps) for (const d of s.frame(t, c)) played.push(d.t)
    }
    return played
  }

  it('plays every click of a continuous playback exactly once', () => {
    const s = new ClickSoundScheduler([0.5, 1, 1.02, 3.3333, 7.9])
    expect(play(s, [clip(0, 10)])).toEqual([0.5, 1, 1.02, 3.3333, 7.9])
  })

  it('at any speed', () => {
    for (const speed of [0.25, 0.5, 2, 4, 8]) {
      const s = new ClickSoundScheduler([0.5, 1, 3.3333, 7.9])
      expect(play(s, [clip(0, 10, speed)], 60)).toEqual([0.5, 1, 3.3333, 7.9])
    }
  })

  it('never plays clicks in cuts', () => {
    const s = new ClickSoundScheduler([0.5, 2.5, 3, 4.99, 5, 6])
    // Source 2..5 is cut; the jump restarts the pass at the next clip's start.
    expect(play(s, [clip(0, 2), clip(5, 8, 2)])).toEqual([0.5, 5, 6])
  })

  it('a click right before a cut is not cut short by the lookahead', () => {
    const s = new ClickSoundScheduler([1.995])
    expect(play(s, [clip(0, 2)])).toEqual([1.995])
  })

  it('schedules a click slightly ahead with the delay at which it is due', () => {
    const s = new ClickSoundScheduler([1.01])
    s.restart(1)
    const due = s.frame(1, clip(0, 10, 2))
    expect(due).toHaveLength(1)
    // 0.01 s of source at 2x = 5 ms from now.
    expect(due[0].delay).toBeCloseTo(0.005, 9)
    expect(s.frame(1.0333, clip(0, 10, 2))).toEqual([])
  })

  it('a seek starts a new pass: no burst of skipped clicks, no replays', () => {
    const clicks = Array.from({ length: 50 }, (_, i) => 0.2 + i * 0.2)
    const s = new ClickSoundScheduler(clicks)
    s.restart(0)
    for (let t = 0; t < 1; t += 1 / 60) s.frame(t, clip(0, 20))
    // The playhead jumps forward 5 s (a seek while playing, with or without restart()).
    const after = s.frame(6.001, clip(0, 20))
    expect(after).toEqual([])
    // Backwards: nothing replays from the frame itself.
    expect(s.frame(2.001, clip(0, 20))).toEqual([])
    // ...and playback continues normally from there.
    const next: number[] = []
    for (let t = 2.001; t < 2.5; t += 1 / 60) for (const d of s.frame(t, clip(0, 20))) next.push(d.t)
    expect(next.map((v) => +v.toFixed(3))).toEqual([2.2, 2.4])
  })

  it('reset() forgets the pass (pausing then playing elsewhere)', () => {
    const s = new ClickSoundScheduler([1, 2])
    s.restart(0)
    s.frame(0.5, clip(0, 10))
    s.reset()
    expect(s.frame(1.9, clip(0, 10))).toEqual([])
    expect(s.frame(1.99, clip(0, 10)).map((d) => d.t)).toEqual([2])
  })

  it('caps the clicks played for one frame', () => {
    const s = new ClickSoundScheduler([1, 1.001, 1.002, 1.003, 1.004, 1.005])
    s.restart(1)
    expect(s.frame(1, clip(0, 10, 8)).length).toBeLessThanOrEqual(4)
  })
})

describe('ignored clicks (the effective track) make no sound', () => {
  it('soundingClicks and clickSoundJob leave them out, in preview and export alike', () => {
    const p = { ...project({ clickSound: true }), inputEdits: { ignoredClicks: [{ ms: 4000 }, { ms: 9000 }] } }
    const recorded = track([click(2), click(4, 0.5, 0.5, 'right'), click(9), click(12)])
    const cursor = effectiveTrack(recorded, p)
    expect(soundingClicks(recorded)).toEqual([2, 4, 9, 12])
    expect(soundingClicks(cursor)).toEqual([2, 12])
    expect(clickSoundJob(p, cursor, full)?.times).toEqual([2, 12])
    // Every click ignored: no sound job at all.
    const all = { ...p, inputEdits: { ignoredClicks: [2000, 4000, 9000, 12000].map((ms) => ({ ms })) } }
    expect(clickSoundJob(all, effectiveTrack(recorded, all), full)).toBeNull()
  })

  it('without input edits the track and the sounds are exactly as recorded', () => {
    const recorded = track([click(2), click(4)])
    const p = project({ clickSound: true })
    expect(effectiveTrack(recorded, p)).toBe(recorded)
    expect(clickSoundJob(p, effectiveTrack(recorded, p), full)).toEqual(clickSoundJob(p, recorded, full))
  })
})
