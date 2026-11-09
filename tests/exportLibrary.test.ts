import { spawnSync } from 'node:child_process'
import { chmodSync, existsSync, mkdirSync, mkdtempSync, promises as fsp, readdirSync, readFileSync, rmSync, statSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import path from 'node:path'
import { afterAll, describe, expect, it, vi } from 'vitest'
import { ffmpegPath } from '../src/main/ffmpeg'
import { isLibraryBed, resolveSoundInputs, validateJob, validEffects } from '../src/main/exportJob'
import { CACHE_SPARE_BYTES, loopableMusic, loopsCleanly, MUSIC_CACHE_COPY, parseMusicProbe } from '../src/main/musicLoopCache'
import { copiedFile } from '../src/main/projectCopy'
import type { ExportJob, MusicSound } from '../src/shared/api/export'
import { bedLoop, soundBed, soundEffect } from '../src/shared/audio/soundLibrary'
import { planSoundtrack } from '../src/shared/render/audioPlan'

// One more effect than the sixteen of today's catalogue, so a job can name 17 different ones.
vi.mock('../src/shared/audio/soundLibrary', async (original) => {
  const real = await original<typeof import('../src/shared/audio/soundLibrary')>()
  const extra = { ...real.SOUND_EFFECTS[0], id: 'test-extra', prepared: { ...real.SOUND_EFFECTS[0].prepared, file: 'sfx-test-extra.ogg' } }
  const effects = [...real.SOUND_EFFECTS, extra]
  return { ...real, SOUND_EFFECTS: effects, soundEffect: (id: string) => effects.find((e) => e.id === id) ?? null }
})

/*
 * Editing polish, part P5 (docs/design/editing-polish.md §0 decision 2, §10.4, §10.8, §19.1 tests
 * 65 and 66): the main process checks the library's part of an export job, plays a bed only when
 * its file is the catalogue's, and decodes a user's own looping Opus or M4A music once so it loops
 * without a glitch.
 */

const ROOT = mkdtempSync(path.join(tmpdir(), 'ssw-export-library-'))
afterAll(() => rmSync(ROOT, { recursive: true, force: true }))
const LIBRARY = path.join(__dirname, '..', 'resources', 'sound-library')
const FF = ffmpegPath()
const RATE = 48000

let n = 0
const folder = (): string => {
  const dir = path.join(ROOT, `p${n++}`)
  mkdirSync(dir, { recursive: true })
  return dir
}
const exists = async (f: string): Promise<boolean> => existsSync(f)

const video = (seconds = 10, over: Partial<ExportJob> = {}): ExportJob => ({
  width: 640,
  height: 360,
  fps: 30,
  frames: Math.round(seconds * 30),
  format: 'mp4',
  quality: 'high',
  video: { kind: 'raw', encoder: 'libx264', pixelFormat: 'rgba' },
  outputPath: '/o.mp4',
  ...over
})
const music = (over: Partial<MusicSound> = {}): MusicSound => ({ file: 'music-1.ogg', volume: 0.35, loop: true, fadeIn: 1, fadeOut: 2, duration: null, ...over })

describe('validEffects and the bed in the job (test 65)', () => {
  const ok = { id: 'whoosh-soft', times: [1, 2.5], gain: 0.35 }

  it('accepts catalogue effects, each once, with bounded times and gains', () => {
    expect(validEffects([ok])).toBe(true)
    expect(validEffects([])).toBe(true)
    expect(() => validateJob(video(10, { effects: [ok] }))).not.toThrow()
  })

  it('refuses an unknown id, a repeated id, 17 effects, 501 times, a gain of 2.1 and an id like ../x', () => {
    expect(validEffects([{ ...ok, id: 'nope' }])).toBe(false)
    expect(validEffects([ok, { ...ok, times: [4] }])).toBe(false)
    const ids = ['whoosh-in', 'whoosh-out', 'whoosh-soft', 'swish-quick', 'pop', 'pop-soft', 'pop-bubble', 'click', 'tick', 'bell', 'chime', 'success', 'rise', 'fall', 'bubble-in', 'drop']
    expect(validEffects(ids.map((id) => ({ id, times: [1], gain: 1 })))).toBe(true)
    expect(validEffects([...ids, 'whoosh-in'].map((id) => ({ id, times: [1], gain: 1 })))).toBe(false)
    // Seventeen different effects of the catalogue: one too many.
    expect(soundEffect('test-extra')).not.toBeNull()
    expect(validEffects([...ids, 'test-extra'].map((id) => ({ id, times: [1], gain: 1 })))).toBe(false)
    expect(validEffects([...ids.slice(1), 'test-extra'].map((id) => ({ id, times: [1], gain: 1 })))).toBe(true)
    expect(validEffects([{ ...ok, times: Array.from({ length: 501 }, (_, i) => i) }])).toBe(false)
    expect(validEffects([{ ...ok, times: Array.from({ length: 500 }, (_, i) => i) }])).toBe(true)
    expect(validEffects([{ ...ok, gain: 2.1 }])).toBe(false)
    expect(validEffects([{ ...ok, id: '../x' }])).toBe(false)
    expect(validEffects([{ ...ok, id: '../sfx-pop.ogg' }])).toBe(false)
    expect(validEffects([{ ...ok, times: [NaN] }])).toBe(false)
    expect(validEffects([{ ...ok, times: [-1] }])).toBe(false)
    expect(validEffects('pop')).toBe(false)
    for (const bad of [[{ ...ok, id: 'nope' }], [{ ...ok, gain: 2.1 }]]) expect(() => validateJob(video(10, { effects: bad }))).toThrow('Invalid export settings')
    // Never on a GIF.
    expect(() => validateJob(video(10, { format: 'gif', effects: [ok], video: { kind: 'raw', encoder: 'libx264', pixelFormat: 'rgba' } }))).toThrow()
  })

  it('refuses an unknown bed id, and accepts a catalogue one', () => {
    expect(() => validateJob(video(10, { music: music({ bed: 'upbeat-sweet-sun' }) }))).not.toThrow()
    expect(() => validateJob(video(10, { music: music({ bed: 'nope' }) }))).toThrow('Invalid export settings')
    expect(() => validateJob(video(10, { music: music({ bed: '../bed-upbeat-sweet-sun.ogg' }) }))).toThrow('Invalid export settings')
  })

  it('a bed file whose hash matches plays as the bed; one whose hash differs plays as a user own file', async () => {
    const bed = soundBed('upbeat-sweet-sun')!
    const dir = folder()
    const real = readFileSync(path.join(LIBRARY, bed.prepared.file))
    writeFileSync(path.join(dir, 'music-1.ogg'), real)
    expect(await isLibraryBed(path.join(dir, 'music-1.ogg'), bed.id)).toBe(true)
    const job = video(200, { music: music({ bed: bed.id }) })
    const good = await resolveSoundInputs(job, dir, exists, [], { soundDir: LIBRARY })
    expect(good.bed).toEqual(bedLoop(bed))
    expect(good.job.music?.bed).toBe(bed.id)
    // A byte changed: same size, another hash.
    const changed = Buffer.from(real)
    changed[changed.length - 10] ^= 0xff
    writeFileSync(path.join(dir, 'music-2.ogg'), changed)
    const bad = await resolveSoundInputs({ ...job, music: music({ file: 'music-2.ogg', bed: bed.id }) }, dir, exists, [], { soundDir: LIBRARY })
    expect(bad.bed).toBeUndefined()
    expect(bad.job.music).toEqual(music({ file: 'music-2.ogg' }))
    expect('bed' in bad.job.music!).toBe(false)
    // Then the graph is a user's own file's: -stream_loop, no aloop.
    const plan = planSoundtrack(bad.job, { mix: null, music: bad.music }, 0)
    expect(plan.args).toContain('-stream_loop')
    expect(plan.graph).not.toContain('aloop')
    // Another bed's id on this file: not that bed either.
    expect(await isLibraryBed(path.join(dir, 'music-1.ogg'), 'lofi-coexistenz')).toBe(false)
  })

  it('effects map by id to the bundled folder only; a missing file is refused with a message', async () => {
    const dir = folder()
    const job = video(10, { effects: [{ id: 'pop', times: [1], gain: 1 }] })
    const r = await resolveSoundInputs(job, dir, exists, [], { soundDir: LIBRARY })
    expect(r.effects).toEqual({ pop: path.join(LIBRARY, soundEffect('pop')!.prepared.file) })
    await expect(resolveSoundInputs(job, dir, exists, [], { soundDir: path.join(ROOT, 'nowhere') })).rejects.toThrow(/sound effect of the library is missing/)
    await expect(resolveSoundInputs(job, dir, exists, [])).rejects.toThrow(/sound effect of the library is missing/)
  })
})

/** A sine of `amp` at `freq` Hz, `seconds` long, encoded as `file` with `codec`. */
function tone(file: string, codec: string[], seconds = 1.3, freq = 440, amp = 0.5): void {
  // ffmpeg's sine source has an amplitude of 1/8.
  const r = spawnSync(FF, ['-v', 'error', '-y', '-f', 'lavfi', '-i', `sine=f=${freq}:d=${seconds}:r=${RATE}`, '-af', `volume=${amp * 8}`, '-ac', '1', ...codec, file])
  expect(r.status, r.stderr.toString()).toBe(0)
}
/** `file` looped by -stream_loop for `seconds`, as mono float at 48 kHz. */
function looped(file: string, seconds: number): Float32Array {
  const r = spawnSync(FF, ['-v', 'error', '-stream_loop', '-1', '-i', file, '-t', String(seconds), '-ac', '1', '-ar', String(RATE), '-f', 'f32le', '-'], { maxBuffer: 1 << 28 })
  expect(r.status, r.stderr.toString()).toBe(0)
  return new Float32Array(r.stdout.buffer.slice(r.stdout.byteOffset, r.stdout.byteOffset + r.stdout.length))
}
/** The largest error against the pure sine the file holds (`amp` at `freq`, restarting every `period` seconds). */
function seamError(samples: Float32Array, period: number, freq = 440, amp = 0.5): number {
  let worst = 0
  const p = Math.round(period * RATE)
  for (let i = 0; i < samples.length; i++) {
    const j = i % p
    // Away from the ends of each pass, where the encoder's own fade would count.
    if (j < 0.05 * RATE || j > p - 0.05 * RATE) {
      const want = amp * Math.sin((2 * Math.PI * freq * j) / RATE)
      if (j > 0.002 * RATE && j < p - 0.002 * RATE) worst = Math.max(worst, Math.abs(samples[i] - want))
    }
  }
  return worst
}

/** A fake ffmpeg: logs each call, prints a probe as `probe` says, and sleeps on a decode (kill test). */
function fakeFfmpeg(probe: string): { bin: string; calls: () => string[] } {
  const dir = mkdtempSync(path.join(ROOT, 'ff-'))
  const log = path.join(dir, 'calls.log')
  const bin = path.join(dir, 'ffmpeg')
  writeFileSync(
    bin,
    `#!/bin/sh\necho "$*" >> "${log}"\ncase "$*" in *-c:a*) exec sleep 30;; *) echo '${probe}' 1>&2; exit 1;; esac\n`
  )
  chmodSync(bin, 0o755)
  return { bin, calls: () => (existsSync(log) ? readFileSync(log, 'utf8').trim().split('\n') : []) }
}

describe("users' own looping music (test 66, §0 decision 2)", () => {
  const opts = (seconds: number, signal = new AbortController().signal): Parameters<typeof loopableMusic>[3] => ({ seconds, signal, timeoutMs: 60_000 })

  it('reads the header: Ogg Vorbis and FLAC loop cleanly, Ogg Opus does not', async () => {
    const dir = folder()
    tone(path.join(dir, 'music-1.ogg'), ['-c:a', 'libvorbis'])
    tone(path.join(dir, 'music-2.ogg'), ['-c:a', 'libopus'])
    tone(path.join(dir, 'music-3.mp3'), ['-c:a', 'libmp3lame'])
    tone(path.join(dir, 'music-4.wav'), [])
    tone(path.join(dir, 'music-5.flac'), [])
    tone(path.join(dir, 'music-6.m4a'), ['-c:a', 'aac'])
    tone(path.join(dir, 'music-7.opus'), ['-c:a', 'libopus'])
    expect(await loopsCleanly(path.join(dir, 'music-1.ogg'))).toBe(true)
    expect(await loopsCleanly(path.join(dir, 'music-2.ogg'))).toBe(false)
    for (const f of ['music-3.mp3', 'music-4.wav', 'music-5.flac']) expect(await loopsCleanly(path.join(dir, f)), f).toBe(true)
    for (const f of ['music-6.m4a', 'music-7.opus']) expect(await loopsCleanly(path.join(dir, f)), f).toBe(false)
    // Those are read as they are: no decode, no cache.
    for (const f of ['music-1.ogg', 'music-3.mp3', 'music-4.wav', 'music-5.flac']) expect(await loopableMusic(dir, f, FF, opts(30))).toBe(path.join(dir, f))
    expect(existsSync(path.join(dir, '.cache'))).toBe(false)
  })

  it('a looping Opus file is decoded once to .cache/…flac by its hash, and the loop has no glitch', async () => {
    const dir = folder()
    tone(path.join(dir, 'music-2.opus'), ['-c:a', 'libopus'])
    const first = await loopableMusic(dir, 'music-2.opus', FF, opts(30))
    expect(path.dirname(first)).toBe(path.join(dir, '.cache'))
    expect(path.basename(first)).toMatch(/^music-2\.[0-9a-f]{16}\.flac$/)
    const made = statSync(first).mtimeMs
    // Used again as it is.
    expect(await loopableMusic(dir, 'music-2.opus', FF, opts(30))).toBe(first)
    expect(statSync(first).mtimeMs).toBe(made)
    // The glitch: -stream_loop on the Opus file jumps at every seam; on the copy it does not.
    const period = 1.3
    const raw = seamError(looped(path.join(dir, 'music-2.opus'), 6), period + 0.0)
    const fixed = seamError(looped(first, 6), period)
    expect(raw).toBeGreaterThan(0.2)
    expect(fixed).toBeLessThan(0.05)
  }, 60_000)

  it('M4A too; music longer than the video is read as it is', async () => {
    const dir = folder()
    tone(path.join(dir, 'music-1.m4a'), ['-c:a', 'aac'], 2)
    expect(path.basename(await loopableMusic(dir, 'music-1.m4a', FF, opts(10)))).toMatch(/^music-1\.[0-9a-f]{16}\.flac$/)
    const long = folder()
    tone(path.join(long, 'music-1.m4a'), ['-c:a', 'aac'], 4)
    expect(await loopableMusic(long, 'music-1.m4a', FF, opts(3))).toBe(path.join(long, 'music-1.m4a'))
    expect(existsSync(path.join(long, '.cache'))).toBe(false)
  }, 60_000)

  it('only up to the output length (-t), and the job reads that file', async () => {
    const dir = folder()
    tone(path.join(dir, 'music-1.opus'), ['-c:a', 'libopus'], 1.3)
    const fake = fakeFfmpeg('  Duration: 00:00:01.30, start: 0.000000, bitrate: 74 kb/s\n  Stream #0:0: Audio: opus, 48000 Hz, stereo, fltp')
    const signal = new AbortController()
    const run = loopableMusic(dir, 'music-1.opus', fake.bin, { seconds: 42.5, signal: signal.signal, timeoutMs: 60_000 })
    await new Promise((r) => setTimeout(r, 300))
    const stopped = Date.now()
    signal.abort()
    await expect(run).rejects.toThrow(MUSIC_CACHE_COPY.cancelled)
    // The decode was killed at once (the stand-in would sleep for 30 s).
    expect(Date.now() - stopped).toBeLessThan(5000)
    const decode = fake.calls().find((c) => c.includes('-c:a'))!
    expect(decode).toContain('-t 42.5')
    expect(decode).toContain(`-i ${path.join(dir, 'music-1.opus')}`)
    expect(decode).toMatch(/-f flac \S+\.flac\.partial$/)
    // A cancelled export kills the decode and leaves no file behind.
    expect(readdirSync(path.join(dir, '.cache'))).toEqual([])
    // resolveSoundInputs hands the export the copy.
    const job = video(20, { music: music({ file: 'music-1.opus' }) })
    const r = await resolveSoundInputs(job, dir, exists, [], { soundDir: LIBRARY, loopable: (file, seconds) => loopableMusic(dir, file, FF, opts(seconds)) })
    expect(r.music).toMatch(/\.cache[\\/]music-1\.[0-9a-f]{16}\.flac$/)
    expect(planSoundtrack(r.job, { mix: null, music: r.music }, 0).args).toEqual(['-stream_loop', '-1', '-vn', '-i', r.music])
    // Not looping: the file itself, no copy asked for.
    let asked = 0
    const once = await resolveSoundInputs({ ...job, music: music({ file: 'music-1.opus', loop: false, duration: 1.3 }) }, dir, exists, [], {
      soundDir: LIBRARY,
      loopable: async (f) => {
        asked++
        return f
      }
    })
    expect(asked).toBe(0)
    expect(once.music).toBe(path.join(dir, 'music-1.opus'))
  }, 60_000)

  it('too little free space fails with a message before the decode runs', async () => {
    const dir = folder()
    tone(path.join(dir, 'music-1.opus'), ['-c:a', 'libopus'])
    // Music of 500 s under a 600 s video: 500 s of stereo 16-bit at 48 kHz is 96 MB, plus the spare.
    const fake = fakeFfmpeg('  Duration: 00:08:20.00, start: 0.000000\n  Stream #0:0: Audio: opus, 48000 Hz, stereo, fltp')
    const need = 500 * 48000 * 2 * 2 + CACHE_SPARE_BYTES
    await expect(loopableMusic(dir, 'music-1.opus', fake.bin, { ...opts(600), freeBytes: async () => need - 5e6 })).rejects.toThrow(MUSIC_CACHE_COPY.space(5))
    // Only the probe ran.
    expect(fake.calls().some((c) => c.includes('-c:a'))).toBe(false)
    expect(fake.calls().length).toBe(1)
  })

  it('a copy another app holds for a moment (an antivirus scan) is renamed once it is let go', async () => {
    const dir = folder()
    tone(path.join(dir, 'music-1.opus'), ['-c:a', 'libopus'])
    const real = fsp.rename
    let held = 0
    const spy = vi.spyOn(fsp, 'rename').mockImplementation(async (from, to) => {
      if (String(from).endsWith('.flac.partial') && held < 2) {
        held++
        throw Object.assign(new Error(`EPERM: operation not permitted, rename '${String(from)}'`), { code: 'EPERM' })
      }
      return real(from, to)
    })
    try {
      const copy = await loopableMusic(dir, 'music-1.opus', FF, opts(10))
      expect(held).toBe(2)
      expect(path.basename(copy)).toMatch(/^music-1\.[0-9a-f]{16}\.flac$/)
      expect(readdirSync(path.join(dir, '.cache'))).toEqual([path.basename(copy)])
    } finally {
      spy.mockRestore()
    }
  }, 60_000)

  it('a new copy deletes the older music-*.flac copies; Duplicate never copies .cache/', async () => {
    const dir = folder()
    tone(path.join(dir, 'music-1.opus'), ['-c:a', 'libopus'])
    const a = await loopableMusic(dir, 'music-1.opus', FF, opts(10))
    writeFileSync(path.join(dir, '.cache', 'speech.json'), '{}')
    tone(path.join(dir, 'music-2.opus'), ['-c:a', 'libopus'], 1.3, 660)
    const b = await loopableMusic(dir, 'music-2.opus', FF, opts(10))
    expect(existsSync(a)).toBe(false)
    expect(readdirSync(path.join(dir, '.cache')).sort()).toEqual([path.basename(b), 'speech.json'].sort())
    expect(copiedFile(`.cache/${path.basename(b)}`)).toBe(null)
    expect(copiedFile(path.basename(b))).toBe(null)
  }, 60_000)

  it('reads the probe: length and channels', () => {
    expect(parseMusicProbe('  Duration: 00:01:02.50, start: 0\n    Stream #0:0: Audio: aac (LC) (mp4a / 0x6134706D), 44100 Hz, stereo, fltp, 128 kb/s')).toEqual({ seconds: 62.5, channels: 2 })
    expect(parseMusicProbe('Duration: N/A\nStream #0:0: Audio: opus, 48000 Hz, 5.1, fltp')).toEqual({ seconds: null, channels: 6 })
    expect(parseMusicProbe('Stream #0:0: Audio: flac, 48000 Hz, 3 channels, s16')).toEqual({ seconds: null, channels: 3 })
    expect(parseMusicProbe('')).toEqual({ seconds: null, channels: 2 })
  })

  it('refuses a name that is not a music pick', async () => {
    await expect(loopableMusic(folder(), '../music-1.opus', FF, opts(10))).rejects.toThrow('Invalid export settings')
  })
})
