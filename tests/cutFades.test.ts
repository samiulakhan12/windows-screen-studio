// Smooth cuts (NW-06, docs/design/edit-by-text.md §4.8, §4.9): fades at every cut in the export's
// graph and the preview's timing, checked as strings and by running the graph through ffmpeg.
import { execFileSync, spawnSync } from 'node:child_process'
import { mkdtempSync, rmSync } from 'node:fs'
import { tmpdir } from 'node:os'
import path from 'node:path'
import { afterAll, describe, expect, it } from 'vitest'
import { ffmpegPath } from '../src/main/ffmpeg'
import type { ExportJob } from '../src/shared/api/export'
import { AUDIO_RATE, pieceSampleBounds, planSoundtrack, recordingGraph, soundPieces } from '../src/shared/render/audioPlan'
import { CUT_FADE, cutFadeAhead, cutFadeFilters, editHasCuts, pieceCutFades } from '../src/shared/render/cutFades'
import type { Clip } from '../src/shared/types'

const clip = (start: number, end: number, speed = 1): Clip => ({ id: `${start}`, start, end, speed })

describe('which pieces fade', () => {
  it('fades only where the source jumps: not at speed splits, not at the edit ends', () => {
    expect(pieceCutFades([{ start: 0, end: 2 }, { start: 3, end: 4 }, { start: 4, end: 6 }, { start: 8, end: 9 }])).toEqual([
      { fadeIn: false, fadeOut: true },
      { fadeIn: true, fadeOut: false },
      { fadeIn: false, fadeOut: true },
      { fadeIn: true, fadeOut: false }
    ])
    expect(pieceCutFades([{ start: 0, end: 5 }])).toEqual([{ fadeIn: false, fadeOut: false }])
  })

  it('knows an edit with cuts from one that is only trimmed or split', () => {
    expect(editHasCuts([clip(0, 2), clip(3, 4)])).toBe(true)
    expect(editHasCuts([clip(1, 2), clip(2, 4, 2)])).toBe(false)
    expect(editHasCuts([clip(1, 9)])).toBe(false)
  })
})

describe('fade filters', () => {
  it('fades in at the start and out at the end, each min(fade, length / 2) long', () => {
    expect(cutFadeFilters({ fadeIn: true, fadeOut: true }, 2, 0.01)).toBe(',afade=t=in:st=0:d=0.01,afade=t=out:st=1.99:d=0.01')
    expect(cutFadeFilters({ fadeIn: false, fadeOut: true }, 0.012, 0.01)).toBe(',afade=t=out:st=0.006:d=0.006')
    expect(cutFadeFilters({ fadeIn: false, fadeOut: false }, 2, 0.01)).toBe('')
    expect(cutFadeFilters({ fadeIn: true, fadeOut: true }, 0, 0.01)).toBe('')
    // After a pause freeze's silence of `offset` seconds.
    expect(cutFadeFilters({ fadeIn: true, fadeOut: true }, 2, 0.01, 1)).toBe(',afade=t=in:st=1:d=0.01,afade=t=out:st=2.99:d=0.01')
  })
})

describe('recordingGraph with cutFade', () => {
  const clips = [clip(0, 2), clip(3, 5), clip(5, 6, 2), clip(8, 9)]

  it('builds exactly the earlier graph without cutFade or with 0', () => {
    const base = recordingGraph({ clips, volume: 1, input: '1:a' }, 6)
    expect(recordingGraph({ clips, volume: 1, input: '1:a', cutFade: 0 }, 6)).toBe(base)
    expect(base).not.toContain('afade')
  })

  it('fades the recording at every cut, last, on the exact samples and after a pause freeze', () => {
    const plain = [clip(0, 2), clip(3, 5)]
    const g = recordingGraph({ clips: plain, volume: 1, input: '1:a', cutFade: CUT_FADE }, 4)
    expect(g).toContain('[s0]atrim=start=0:end=2,asetpts=PTS-STARTPTS,apad=whole_dur=2,atrim=end=2,afade=t=out:st=1.99:d=0.01[c0]')
    expect(g).toContain('[s1]atrim=start=3:end=5,asetpts=PTS-STARTPTS,apad=whole_dur=2,atrim=end=2,afade=t=in:st=0:d=0.01[c1]')
    // A re-timed edit: on the exact samples the video gives each piece (atempo's output is a little
    // off), the fade in after the freeze's silence.
    const holds = [{ at: 3, length: 1 }]
    const r = recordingGraph({ clips, volume: 1, input: '1:a', cutFade: CUT_FADE, holds }, 8)
    const bounds = pieceSampleBounds(soundPieces(clips, holds).pieces)
    expect(bounds[2] - bounds[1]).toBe(3 * AUDIO_RATE)
    expect(r).toContain('[s1]atrim=start=3:end=5,asetpts=PTS-STARTPTS,apad=whole_dur=2,atrim=end=2,adelay=delays=48000S:all=1,apad=whole_len=144000,atrim=end_sample=144000,afade=t=in:st=1:d=0.01[c1]')
    expect(r).toContain('atrim=start_sample=500,asetpts=PTS-STARTPTS,apad=whole_len=24000,atrim=end_sample=24000,afade=t=out:st=0.49:d=0.01[c2]')
    // The speed split (5..6 at 2x continues 3..5): no fade between them.
    expect((r.match(/afade=t=in/g) ?? []).length).toBe(2)
    expect((r.match(/afade=t=out/g) ?? []).length).toBe(2)
  })

  it('passes cutFade from the job through planSoundtrack', () => {
    const job: ExportJob = { width: 0, height: 0, fps: 60, frames: 240, format: 'm4a', quality: 'high', video: { kind: 'none' }, outputPath: '/o.m4a', audio: { clips: [clip(0, 2), clip(3, 5)], volume: 1, cutFade: CUT_FADE } }
    expect(planSoundtrack(job, { mix: '/p/screen.mp4' }, 0).graph).toContain('afade=t=in')
    const { cutFade: _, ...without } = job.audio!
    expect(planSoundtrack({ ...job, audio: without }, { mix: '/p/screen.mp4' }, 0).graph).not.toContain('afade')
  })
})

describe('the preview: when to fade out', () => {
  const clips = [clip(0, 2), clip(3, 5), clip(5, 6, 2)]
  const F60 = 1 / 60
  const F30 = 1 / 30

  it('fades out at the last callback that leaves the whole fade, ending at the jump (60 fps)', () => {
    // The jump comes at the callback within one frame of the end: two callbacks ahead is too early.
    expect(cutFadeAhead(clips, 2 - 3 * F60, 1, F60, 0)).toBeNull()
    expect(cutFadeAhead(clips, 2 - 2 * F60, 1, F60, 0)).toBeCloseTo(F60)
    // At the jump's own callback: silent now.
    expect(cutFadeAhead(clips, 2 - F60, 1, F60, 0)).toBe(0)
  })

  it('follows the recording frame rate (30 fps) and the measured callback step', () => {
    expect(cutFadeAhead(clips, 2 - 2 * F30, 1, F30, 0)).toBeCloseTo(F30)
    expect(cutFadeAhead(clips, 2 - 3 * F30, 1, F30, 0)).toBeNull()
    // Between frames: the jump is at the next callback, one frame on.
    expect(cutFadeAhead(clips, 0.9453 + 1, 1, F30, 0)).toBeCloseTo(F30)
    // Callbacks measured 1/120 s apart at 2x (1/240 s of wall time each): it waits for the third before the jump.
    const at = (k: number): number => 2 - 2 * F60 - k / 120
    expect(cutFadeAhead(clips, at(4), 2, F60, 1 / 120)).toBeNull()
    expect(cutFadeAhead(clips, at(3), 2, F60, 1 / 120)).toBeCloseTo(3 / 240)
  })

  it('starts earlier when the fade is longer in wall time (slow preview speed)', () => {
    // 0.5x: callbacks 1/30 s apart in wall time, so a 20 ms fade starts at the callback before the jump.
    const at = (k: number): number => 2 - 0.5 * F60 - k * F60
    expect(cutFadeAhead(clips, at(1), 0.5, F60, 0, 0.02)).toBeCloseTo(F30)
    expect(cutFadeAhead(clips, at(2), 0.5, F60, 0, 0.02)).toBeNull()
    // A fade longer than a callback interval starts two callbacks ahead.
    expect(cutFadeAhead(clips, 2 - 3 * F60, 1, F60, 0, 0.025)).toBeCloseTo(2 * F60)
  })

  it('does nothing where the next clip continues, at the end, in a cut, or when stopped', () => {
    expect(cutFadeAhead(clips, 4.99, 1, F60, 0)).toBeNull()
    expect(cutFadeAhead(clips, 5.99, 2, F60, 0)).toBeNull()
    expect(cutFadeAhead(clips, 2.5, 1, F60, 0)).toBeNull()
    expect(cutFadeAhead(clips, 1.99, 0, F60, 0)).toBeNull()
  })
})

describe('fades with ffmpeg', () => {
  const dir = mkdtempSync(path.join(tmpdir(), 'ssw-cutfades-'))
  afterAll(() => rmSync(dir, { recursive: true, force: true }))
  const ff = ffmpegPath()
  const tone = path.join(dir, 'tone.wav')
  execFileSync(ff, ['-v', 'error', '-f', 'lavfi', '-i', 'sine=frequency=330:sample_rate=48000', '-t', '3', '-af', 'volume=0.5', '-c:a', 'pcm_s16le', tone])

  /** The soundtrack of a 330 Hz tone with the source cut at [1.0013, 1.5), as mono samples. */
  function render(cutFade?: number): Float32Array {
    const job: ExportJob = {
      width: 0,
      height: 0,
      fps: 60,
      frames: Math.round((3 - 0.4987) * 60),
      format: 'm4a',
      quality: 'high',
      video: { kind: 'none' },
      outputPath: '/o.m4a',
      audio: { clips: [clip(0, 1.0013), clip(1.5, 3)], volume: 1, ...(cutFade ? { cutFade } : {}) }
    }
    const plan = planSoundtrack(job, { mix: tone }, 0)
    const r = spawnSync(ff, ['-v', 'error', ...plan.args, '-filter_complex', plan.graph!, '-map', '[aout]', '-ac', '1', '-ar', '48000', '-f', 'f32le', '-'], { maxBuffer: 1 << 26 })
    expect(r.status, r.stderr.toString()).toBe(0)
    return new Float32Array(r.stdout.buffer.slice(r.stdout.byteOffset, r.stdout.byteOffset + r.stdout.length))
  }

  /** Largest step between neighbouring samples in output seconds [from, to). */
  const maxStep = (s: Float32Array, from: number, to: number): number => {
    let m = 0
    for (let i = Math.round(from * 48000) + 1; i < Math.round(to * 48000); i++) m = Math.max(m, Math.abs(s[i] - s[i - 1]))
    return m
  }
  const peak = (s: Float32Array, from: number, to: number): number => {
    let m = 0
    for (let i = Math.round(from * 48000); i < Math.round(to * 48000); i++) m = Math.max(m, Math.abs(s[i]))
    return m
  }

  it('a plain join clicks; with the fades it does not, and the tone away from the cut is untouched', () => {
    const joint = 1.0013
    const hard = render()
    const soft = render(CUT_FADE)
    const tone = maxStep(hard, 0.5, 0.9)
    // Without fades the waveform jumps at the joint (a click).
    expect(maxStep(hard, joint - 0.002, joint + 0.002)).toBeGreaterThan(tone * 3)
    // With them it goes smoothly to silence and back.
    expect(maxStep(soft, joint - 0.002, joint + 0.002)).toBeLessThan(tone * 1.2)
    const level = peak(hard, 0.5, 0.9)
    expect(peak(soft, joint - 0.0005, joint + 0.0005)).toBeLessThan(level * 0.1)
    expect(peak(soft, joint - 0.0075, joint - 0.0025)).toBeLessThan(level * 0.8)
    expect(peak(soft, 0.5, 0.9)).toBeCloseTo(level, 4)
    expect(peak(soft, joint + 0.02, joint + 0.3)).toBeCloseTo(level, 2)
    expect(soft.length).toBe(hard.length)
  })
})
