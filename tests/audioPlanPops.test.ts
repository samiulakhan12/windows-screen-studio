import { spawnSync } from 'node:child_process'
import { describe, expect, it } from 'vitest'
import { ffmpegPath } from '../src/main/ffmpeg'
import type { ExportJob } from '../src/shared/api/export'
import { planSoundtrack, soundtrackGraph, toneTrackGraph } from '../src/shared/render/audioPlan'
import { POP_SOUNDS, POP_VOLUME, popSoundSource, toneSoundSource } from '../src/shared/render/popSound'

/*
 * Tests 26 and 27, the export's part (docs/design/captions-studio.md §16.1, §10.6, §11.7): the
 * graphics' pops and the bleep tones are mixed like the click track; a job without them builds
 * exactly the graph of before; the tone track's spans land on their samples. The graphs are run
 * through the pinned ffmpeg. (Muting the recording under a bleep goes through the sound finder's
 * gains: tests/soundsBleeps.test.ts and tests/bleepExportJob.test.ts.)
 */

const RATE = 48000
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

const ff = ffmpegPath()
function render(job: ExportJob): Float32Array {
  const plan = planSoundtrack(job, { mix: null }, 0)
  const r = spawnSync(ff, ['-v', 'error', ...plan.args, '-filter_complex', plan.graph!, '-map', '[aout]', '-ac', '1', '-ar', String(RATE), '-f', 'f32le', '-'], { maxBuffer: 1 << 28 })
  expect(r.status, r.stderr.toString()).toBe(0)
  return new Float32Array(r.stdout.buffer, r.stdout.byteOffset, r.stdout.length / 4)
}
const peak = (s: Float32Array, from: number, to: number): number => {
  let m = 0
  for (let i = Math.round(from * RATE); i < Math.round(to * RATE); i++) m = Math.max(m, Math.abs(s[i]))
  return m
}

describe('a job without pops and tones (test 26)', () => {
  it('builds exactly the graph and inputs of before', () => {
    const base = m4a(5, { clicks: { times: [0.5, 2], volume: 1 }, audio: { clips: [{ id: 'a', start: 0, end: 5, speed: 1 }], volume: 1 } })
    const before = planSoundtrack(base, { mix: '/p/screen.mp4' }, 0)
    expect(planSoundtrack({ ...base, pops: [], tones: [] }, { mix: '/p/screen.mp4' }, 0)).toEqual(before)
    // Pops and tones outside the export add nothing either.
    expect(planSoundtrack({ ...base, pops: [{ times: [9], sound: 'pop' }], tones: [{ start: 7, end: 8 }] }, { mix: '/p/screen.mp4' }, 0)).toEqual(before)
    expect(soundtrackGraph({ duration: 5, clicks: { sounds: { times: [1], volume: 1 }, input: '1:a' } })).toBe(soundtrackGraph({ duration: 5, clicks: { sounds: { times: [1], volume: 1 }, input: '1:a' }, pops: [] }))
  })
})

describe('pops in the export (test 26)', () => {
  it('one source per sound after the other inputs, each a track like the clicks at volume 0.35', () => {
    const job = m4a(4, { clicks: { times: [0.5], volume: 1 }, pops: [{ times: [1, 2], sound: 'pop' }, { times: [3], sound: 'ding' }] })
    const plan = planSoundtrack(job, { mix: null }, 2)
    expect(plan.args.filter((a) => a.startsWith('aevalsrc'))).toEqual([expect.stringContaining('aevalsrc'), popSoundSource('pop'), popSoundSource('ding')])
    expect(plan.graph).toContain('[3:a]aformat')
    expect(plan.graph).toContain('[4:a]aformat')
    expect(plan.graph).toContain(`volume=${POP_VOLUME}`)
    expect(plan.graph).toContain('amix=inputs=3')
  })

  it('each pop lands on its output time at its volume', () => {
    const out = render(m4a(3, { pops: [{ times: [1, 2.2], sound: 'pop' }] }))
    expect(out.length / RATE).toBeCloseTo(3, 2)
    expect(peak(out, 0, 0.99)).toBe(0)
    expect(peak(out, 1, 1.12)).toBeGreaterThan(0.1)
    expect(peak(out, 1.13, 2.19)).toBeLessThan(1e-3)
    expect(peak(out, 2.2, 2.32)).toBeGreaterThan(0.1)
    // The pop's own peak is under its partials' sum, scaled by the volume.
    const most = POP_SOUNDS.pop.partials.reduce((s, p) => s + p.amp, 0) * POP_VOLUME
    expect(peak(out, 0, 3)).toBeLessThanOrEqual(most + 1e-3)
  })
})

describe('bleep tones in the export (test 27, the tone track)', () => {
  it('the tone track cuts each span from one source, with ramps, at its samples, in time order', () => {
    const g = toneTrackGraph([{ start: 2, end: 2.5 }, { start: 0.5, end: 1 }], 4, '5:a')!
    expect(g).toContain('[5:a]aformat=sample_fmts=fltp:sample_rates=48000:channel_layouts=mono,asplit=2[t0][t1]')
    expect(g).toContain(`[t0]atrim=end_sample=${0.5 * RATE},afade=t=in:ss=0:ns=240,afade=t=out:ss=${0.5 * RATE - 240}:ns=240,apad=whole_len=${1.5 * RATE}`)
    expect(g).toContain(`atrim=end_sample=${4 * RATE}[tone]`)
    expect(toneTrackGraph([{ start: 5, end: 6 }], 4, '5:a')).toBeNull()
  })

  it('the source is as long as the longest span; tones sound at 0.25 over their spans only', () => {
    const job = m4a(3, { tones: [{ start: 0.5, end: 1 }, { start: 1.6, end: 2.4 }] })
    expect(planSoundtrack(job, { mix: null }, 0).args).toEqual(['-f', 'lavfi', '-i', toneSoundSource(0.8)])
    const out = render(job)
    expect(peak(out, 0, 0.49)).toBe(0)
    expect(peak(out, 0.6, 0.9)).toBeCloseTo(0.25, 2)
    expect(peak(out, 1.01, 1.59)).toBeLessThan(1e-3)
    expect(peak(out, 1.7, 2.3)).toBeCloseTo(0.25, 2)
    expect(peak(out, 2.41, 3)).toBeLessThan(1e-3)
  })

  it('a span split at a cut is two tones that touch, each with its ramps', () => {
    const out = render(m4a(2, { tones: [{ start: 0.5, end: 1 }, { start: 1, end: 1.4 }] }))
    // At the join both ramps meet at zero: no click.
    expect(Math.abs(out[RATE])).toBeLessThan(0.01)
    expect(peak(out, 0.6, 0.9)).toBeCloseTo(0.25, 2)
    expect(peak(out, 1.1, 1.3)).toBeCloseTo(0.25, 2)
  })
})
