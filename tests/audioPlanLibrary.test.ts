import { spawnSync } from 'node:child_process'
import path from 'node:path'
import { describe, expect, it } from 'vitest'
import { ffmpegPath } from '../src/main/ffmpeg'
import type { ExportJob, MusicSound } from '../src/shared/api/export'
import { bedLoop, bedSeconds, soundBed, soundEffect } from '../src/shared/audio/soundLibrary'
import { bedGraph, musicGraph, planSoundtrack, soundtrackGraph, STEREO } from '../src/shared/render/audioPlan'

/*
 * Editing polish, part P5 (docs/design/editing-polish.md §10.4, §10.8, §19.1 tests 60 and 64): a
 * library bed loops in its graph from its own loop start, sample for sample, and the library's
 * effects are mixed as click tracks; a job without effects or a bed builds the graph of before.
 * The graphs run through the pinned ffmpeg on the bundled files.
 */

const RATE = 48000
const LIBRARY = path.join(__dirname, '..', 'resources', 'sound-library')
const ff = ffmpegPath()

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
const music = (over: Partial<MusicSound> = {}): MusicSound => ({ file: 'music-1.ogg', volume: 1, loop: true, fadeIn: 0, fadeOut: 0, duration: null, ...over })

function run(args: string[]): Float32Array {
  const r = spawnSync(ff, ['-v', 'error', ...args, '-f', 'f32le', '-'], { maxBuffer: 1 << 30 })
  expect(r.status, r.stderr.toString()).toBe(0)
  return new Float32Array(r.stdout.buffer.slice(r.stdout.byteOffset, r.stdout.byteOffset + r.stdout.length))
}
/** The file decoded as interleaved stereo float at 48 kHz. */
const decoded = (file: string): Float32Array => run(['-i', file, '-ac', '2', '-ar', String(RATE)])
/** The job's soundtrack as interleaved stereo float. */
function render(job: ExportJob, files: Parameters<typeof planSoundtrack>[1]): Float32Array {
  const plan = planSoundtrack(job, files, 0)
  return run([...plan.args, '-filter_complex', plan.graph!, '-map', '[aout]', '-ac', '2', '-ar', String(RATE)])
}

describe('a library bed in the export (test 60)', () => {
  const bed = soundBed('upbeat-sweet-sun')!
  const { start: S, end: E } = bedLoop(bed)
  const part = { input: '1:a', volume: 0.35, end: 300, fadeIn: 1, fadeOut: 2 }

  it('the exact graph with Loop on: cut at E, the body from S looped, then the music chain of before', () => {
    expect(bedGraph(part, { start: S, end: E }, true, 300)).toBe(
      `[1:a]aresample=48000,aformat=sample_fmts=fltp:channel_layouts=stereo,atrim=end_sample=${E},asplit[bedhead][bedbody];` +
        `[bedbody]atrim=start_sample=${S},asetpts=PTS-STARTPTS,aloop=loop=-1:size=${E - S}[bedloop];` +
        '[bedhead][bedloop]concat=n=2:v=0:a=1,atrim=end=300,volume=0.35,afade=t=in:st=0:d=1,afade=t=out:st=298:d=2,apad=whole_dur=300,atrim=end=300[mus]'
    )
  })

  it('the exact graph with Loop off: atrim=end_sample=E and no aloop', () => {
    const g = bedGraph({ ...part, end: E / RATE }, { start: S, end: E }, false, 300, 'aout')
    expect(g).toBe(
      `[1:a]aresample=48000,aformat=sample_fmts=fltp:channel_layouts=stereo,atrim=end_sample=${E},atrim=end=${+(E / RATE).toFixed(6)},volume=0.35,afade=t=in:st=0:d=1,afade=t=out:st=${+(E / RATE - 2).toFixed(6)}:d=2,apad=whole_dur=300,atrim=end=300[aout]`
    )
    expect(g).not.toContain('aloop')
  })

  it('musicGraph without a bed gives the strings of before exactly', () => {
    expect(musicGraph(part, 300)).toBe(`[1:a]aresample=async=1:first_pts=0,${STEREO},atrim=end=300,volume=0.35,afade=t=in:st=0:d=1,afade=t=out:st=298:d=2,apad=whole_dur=300,atrim=end=300[mus]`)
    expect(musicGraph({ input: '2:a', volume: 1, end: 6, fadeIn: 0, fadeOut: 0, duck: '1-0.5*clip(t,0,1)' }, 10)).toBe(
      `[2:a]aresample=async=1:first_pts=0,${STEREO},atrim=end=6,asetnsamples=n=256:p=0,volume=volume='1-0.5*clip(t,0,1)':eval=frame,apad=whole_dur=10,atrim=end=10[mus]`
    )
    // A job naming no bed: -stream_loop and musicGraph, as before.
    const job = m4a(30, { music: music() })
    const plan = planSoundtrack(job, { mix: null, music: '/p/music-1.ogg' }, 0)
    expect(plan.args).toEqual(['-stream_loop', '-1', '-vn', '-i', '/p/music-1.ogg'])
    expect(plan.graph).toBe(musicGraph({ input: '0:a', volume: 1, end: 30, fadeIn: 0, fadeOut: 0 }, 30, 'aout'))
  })

  it('planSoundtrack with a checked bed: no -stream_loop, bedGraph, and one pass of E / 48000 without Loop', () => {
    const files = { mix: null, music: path.join(LIBRARY, bed.prepared.file), bed: { start: S, end: E } }
    const looped = planSoundtrack(m4a(200, { music: music() }), files, 0)
    expect(looped.args).toEqual(['-vn', '-i', files.music])
    expect(looped.graph).toBe(bedGraph({ input: '0:a', volume: 1, end: 200, fadeIn: 0, fadeOut: 0 }, { start: S, end: E }, true, 200, 'aout'))
    // Without Loop the music ends at E / 48000 (1:43.4), not at the file's length (the pad is never played).
    const once = planSoundtrack(m4a(200, { music: music({ loop: false, duration: (E + bed.prepared.pad) / RATE }) }), files, 0)
    expect(once.graph).toBe(bedGraph({ input: '0:a', volume: 1, end: bedSeconds(bed), fadeIn: 0, fadeOut: 0 }, { start: S, end: E }, false, 200, 'aout'))
    expect(once.graph).toContain(`atrim=end=${+(E / RATE).toFixed(6)}`)
  })

  it('ffmpeg plays decoded[0:E] and then decoded[S:E] over and over, sample for sample (240 s)', () => {
    const file = path.join(LIBRARY, bed.prepared.file)
    const src = decoded(file)
    expect(src.length / 2).toBe(bed.prepared.samples)
    const seconds = 240
    const out = render(m4a(seconds, { music: music() }), { mix: null, music: file, bed: { start: S, end: E } })
    const n = Math.round(seconds * RATE)
    expect(out.length / 2).toBe(n)
    let worst = 0
    for (let i = 0; i < n; i++) {
      const j = i < E ? i : S + ((i - E) % (E - S))
      worst = Math.max(worst, Math.abs(out[2 * i] - src[2 * j]), Math.abs(out[2 * i + 1] - src[2 * j + 1]))
    }
    expect(worst).toBe(0)
    // Without Loop: the bed, then silence from E on.
    const once = render(m4a(120, { music: music({ loop: false, duration: (E + bed.prepared.pad) / RATE }) }), { mix: null, music: file, bed: { start: S, end: E } })
    let tail = 0
    for (let i = 2 * E; i < once.length; i++) tail = Math.max(tail, Math.abs(once[i]))
    expect(tail).toBe(0)
    let body = 0
    for (let i = 0; i < 2 * E; i++) body = Math.max(body, Math.abs(once[i] - src[i]))
    expect(body).toBe(0)
  }, 60_000)
})

describe("the library's effects in the export (test 64)", () => {
  const effects = (): NonNullable<Parameters<typeof planSoundtrack>[1]['effects']> => ({
    'whoosh-soft': path.join(LIBRARY, soundEffect('whoosh-soft')!.prepared.file),
    pop: path.join(LIBRARY, soundEffect('pop')!.prepared.file)
  })

  it('one -i per effect at its resolved file, a click track each at its gain, mixed with the rest', () => {
    const job = m4a(6, {
      clicks: { times: [0.5], volume: 1 },
      effects: [
        { id: 'whoosh-soft', times: [1, 3], gain: 0.35 },
        { id: 'pop', times: [2], gain: 0.5 }
      ]
    })
    const plan = planSoundtrack(job, { mix: null, effects: effects() }, 1)
    expect(plan.args.slice(-6)).toEqual(['-vn', '-i', effects()['whoosh-soft'], '-vn', '-i', effects().pop])
    expect(plan.graph).toContain('[2:a]aformat=sample_fmts=fltp:sample_rates=48000:channel_layouts=mono,asplit=2')
    expect(plan.graph).toContain('[3:a]aformat=sample_fmts=fltp:sample_rates=48000:channel_layouts=mono')
    expect(plan.graph).toContain('volume=0.35,apad')
    expect(plan.graph).toContain('volume=0.5,apad')
    expect(plan.graph).toContain('[sfx0][sfx1]')
    expect(plan.graph).toContain('amix=inputs=3')
    // Effects outside the export add nothing.
    const outside = planSoundtrack(m4a(6, { clicks: { times: [0.5], volume: 1 }, effects: [{ id: 'pop', times: [9], gain: 1 }] }), { mix: null, effects: effects() }, 1)
    expect(outside).toEqual(planSoundtrack(m4a(6, { clicks: { times: [0.5], volume: 1 } }), { mix: null }, 1))
  })

  it("a job without effects or a bed gives today's graph string exactly", () => {
    const base = m4a(5, { clicks: { times: [0.5, 2], volume: 1 }, audio: { clips: [{ id: 'a', start: 0, end: 5, speed: 1 }], volume: 1 }, music: music(), pops: [{ times: [1], sound: 'pop' }] })
    const before = planSoundtrack(base, { mix: '/p/screen.mp4', music: '/p/music-1.ogg' }, 0)
    expect(planSoundtrack({ ...base, effects: [] }, { mix: '/p/screen.mp4', music: '/p/music-1.ogg', effects: effects(), bed: null }, 0)).toEqual(before)
    expect(soundtrackGraph({ duration: 5, clicks: { sounds: { times: [1], volume: 1 }, input: '1:a' }, effects: [] })).toBe(soundtrackGraph({ duration: 5, clicks: { sounds: { times: [1], volume: 1 }, input: '1:a' } }))
  })

  it('each effect lands on its sample at its gain, cut short where its next sound starts', () => {
    const file = effects()['whoosh-soft']
    const sound = decoded(file)
    const len = sound.length / 2
    const out = render(m4a(3, { effects: [{ id: 'whoosh-soft', times: [0.5, 0.6], gain: 0.5 }] }), { mix: null, effects: effects() })
    // Silence before, the effect from 0.5 s (its first 0.1 s, then the second one from 0.6 s).
    let before = 0
    for (let i = 0; i < 2 * Math.round(0.5 * RATE); i++) before = Math.max(before, Math.abs(out[i]))
    expect(before).toBe(0)
    let worst = 0
    for (let i = 0; i < len; i++) {
      const at = Math.round(0.6 * RATE) + i
      worst = Math.max(worst, Math.abs(out[2 * at] - 0.5 * sound[2 * i]))
      if (i < Math.round(0.1 * RATE)) worst = Math.max(worst, Math.abs(out[2 * (Math.round(0.5 * RATE) + i)] - 0.5 * sound[2 * i]))
    }
    expect(worst).toBeLessThan(1e-6)
  })

  it('a job naming an effect main has no file for is refused', () => {
    expect(() => planSoundtrack(m4a(3, { effects: [{ id: 'pop', times: [1], gain: 1 }] }), { mix: null }, 0)).toThrow(/sound effect/)
  })
})
