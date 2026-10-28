// Clean voice on real speech with added fan and keyboard noise (docs/design/clean-voice.md §2.2),
// through the shipped graph of each strength and the bundled models: how much quieter the pauses
// get, and that every voice (a clean LibriSpeech reading and the noisy, band-limited JFK speech)
// keeps its level and its detail. Prints the numbers.
import { execFileSync, spawnSync } from 'node:child_process'
import { mkdtempSync, rmSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import path from 'node:path'
import { afterAll, describe, expect, it } from 'vitest'
import { ffmpegPath } from '../src/main/ffmpeg'
import generalModel from '../src/main/voice/model/cb.rnnn?raw'
import speechModel from '../src/main/voice/model/sh.rnnn?raw'
import { VOICE_ENGINE, voiceGraph } from '../src/shared/audio/voiceClean'
import type { VoiceStrength } from '../src/shared/types'

const ff = ffmpegPath()
const RATE = 48000
const SPEECH = path.join(__dirname, 'fixtures/speech')
const dir = mkdtempSync(path.join(tmpdir(), 'ssw-voicebench-'))
afterAll(() => rmSync(dir, { recursive: true, force: true }))

/** Seconds of the clip: 1.5 s pause, LibriSpeech 1272-128104-0000 (5.86 s) and 1 s, a 2 s pause, JFK (11 s). */
const LS = [1.5, 7.36] as const
const PAUSES = [
  [0.1, 1.4],
  [8.5, 10.2]
] as const
const JFK = [10.6, 21.2] as const
const SECONDS = 21.36

const samples = (args: string[]): Float32Array => {
  const r = spawnSync(ff, ['-v', 'error', ...args, '-ac', '1', '-ar', String(RATE), '-f', 'f32le', '-'], { maxBuffer: 1 << 28 })
  expect(r.status, r.stderr.toString()).toBe(0)
  return new Float32Array(r.stdout.buffer.slice(r.stdout.byteOffset, r.stdout.byteOffset + r.stdout.length))
}

/** The speech alone, then with a fan (pink noise below 6 kHz, 100/200/300 Hz hum, a wobbling 230 Hz blade) and typing (clicks in bursts). */
function clips(): { clean: string; noisy: string } {
  const clean = path.join(dir, 'clean.wav')
  const noisy = path.join(dir, 'noisy.wav')
  execFileSync(ff, [
    '-v', 'error', '-y', '-i', path.join(SPEECH, 'ls-1272-128104-0000.flac'), '-i', path.join(SPEECH, 'jfk-16k.flac'),
    '-filter_complex',
    `[0:a]aresample=48000,aformat=sample_fmts=flt:channel_layouts=mono,apad=pad_dur=1[a];[1:a]aresample=48000,aformat=sample_fmts=flt:channel_layouts=mono[b];` +
      'anullsrc=r=48000:cl=mono,atrim=0:1.5[s0];anullsrc=r=48000:cl=mono,atrim=0:2[s1];[s0][a][s1][b]concat=n=4:v=0:a=1',
    '-c:a', 'pcm_f32le', clean
  ])
  const fan =
    `anoisesrc=color=pink:amplitude=0.012:sample_rate=48000:seed=11:d=${SECONDS},lowpass=f=6000[p];` +
    `aevalsrc='0.004*sin(2*PI*100*t)+0.002*sin(2*PI*200*t)+0.0012*sin(2*PI*300*t)+0.003*sin(2*PI*(230*t+3*sin(2*PI*0.4*t)))':s=48000:d=${SECONDS}[hum];[p][hum]amix=inputs=2:normalize=0[fan]`
  // About 7 key presses a second while typing (1.4 s of every 2 s), each a 4 ms decaying click.
  const keys =
    `anoisesrc=color=white:amplitude=0.6:sample_rate=48000:seed=5:d=${SECONDS},highpass=f=1500[w];` +
    `aevalsrc='if(lt(mod(t\\,2)\\,1.4)\\,exp(-mod(t\\,0.143)/0.004)\\,0)':s=48000:d=${SECONDS}[env];[w][env]amultiply,volume=0.25[keys]`
  execFileSync(ff, ['-v', 'error', '-y', '-i', clean, '-filter_complex', `${fan};${keys};[0:a][fan][keys]amix=inputs=3:normalize=0:duration=first`, '-c:a', 'pcm_f32le', noisy])
  return { clean, noisy }
}

const range = (s: Float32Array, [a, b]: readonly [number, number]): Float32Array => s.subarray(Math.round(a * RATE), Math.round(b * RATE))
const db = (s: Float32Array): number => {
  let sum = 0
  for (const v of s) sum += v * v
  return 10 * Math.log10(sum / s.length + 1e-20)
}

/** In-place radix-2 FFT magnitudes of `frame` (length a power of two). */
function magnitudes(frame: Float64Array): Float64Array {
  const n = frame.length
  const re = Float64Array.from(frame)
  const im = new Float64Array(n)
  for (let i = 1, j = 0; i < n; i++) {
    let bit = n >> 1
    for (; j & bit; bit >>= 1) j ^= bit
    j ^= bit
    if (i < j) [re[i], re[j]] = [re[j], re[i]]
  }
  for (let len = 2; len <= n; len <<= 1) {
    const ang = (-2 * Math.PI) / len
    for (let i = 0; i < n; i += len) {
      for (let k = 0; k < len / 2; k++) {
        const wr = Math.cos(ang * k)
        const wi = Math.sin(ang * k)
        const xr = re[i + k + len / 2] * wr - im[i + k + len / 2] * wi
        const xi = re[i + k + len / 2] * wi + im[i + k + len / 2] * wr
        re[i + k + len / 2] = re[i + k] - xr
        im[i + k + len / 2] = im[i + k] - xi
        re[i + k] += xr
        im[i + k] += xi
      }
    }
  }
  return Float64Array.from({ length: n / 2 + 1 }, (_, k) => Math.hypot(re[k], im[k]))
}

/** Frequency-weighted segmental SNR (25 mel bands, 1024-sample frames, half overlap) of `est` against `ref`. */
function fwSegSnr(ref: Float32Array, est: Float32Array): number {
  const N = 1024
  const mel = (f: number): number => 2595 * Math.log10(1 + f / 700)
  const edges = Array.from({ length: 26 }, (_, i) => 700 * (10 ** ((mel(50) + ((mel(8000) - mel(50)) * i) / 25) / 2595) - 1))
  const bandOf = Array.from({ length: N / 2 + 1 }, (_, k) => edges.findIndex((e, i) => i < 25 && (k * RATE) / N >= e && (k * RATE) / N < edges[i + 1]))
  const win = Float64Array.from({ length: N }, (_, i) => 0.5 - 0.5 * Math.cos((2 * Math.PI * i) / (N - 1)))
  const frames: { x: number[]; y: number[] }[] = []
  for (let at = 0; at + N <= ref.length; at += N / 2) {
    const X = magnitudes(Float64Array.from({ length: N }, (_, i) => ref[at + i] * win[i]))
    const Y = magnitudes(Float64Array.from({ length: N }, (_, i) => est[at + i] * win[i]))
    const x = new Array(25).fill(0)
    const y = new Array(25).fill(0)
    bandOf.forEach((b, k) => {
      if (b < 0) return
      x[b] += X[k]
      y[b] += Y[k]
    })
    frames.push({ x, y })
  }
  const loudest = Math.max(...frames.map((f) => f.x.reduce((a, b) => a + b, 0)))
  let total = 0
  let count = 0
  for (const { x, y } of frames) {
    if (x.reduce((a, b) => a + b, 0) < loudest * 1e-3) continue
    let num = 0
    let den = 0
    x.forEach((xb, b) => {
      const snr = Math.min(35, Math.max(-10, 10 * Math.log10((xb * xb) / ((xb - y[b]) ** 2 + 1e-12))))
      const w = xb ** 0.2
      num += w * snr
      den += w
    })
    total += num / den
    count++
  }
  return total / count
}

describe('Clean voice on noisy speech', () => {
  const { clean, noisy } = clips()
  const ref = samples(['-i', clean])
  const input = samples(['-i', noisy])
  // The models where arnndn finds them, as the app writes them.
  writeFileSync(path.join(dir, VOICE_ENGINE.models.speech.file), speechModel)
  writeFileSync(path.join(dir, VOICE_ENGINE.models.general.file), generalModel)
  const cleaned = (strength: VoiceStrength): Float32Array => {
    const out = path.join(dir, `${strength}.wav`)
    execFileSync(ff, ['-v', 'error', '-y', '-i', noisy, '-filter_complex', voiceGraph(strength), '-map', '[voice]', '-c:a', 'pcm_f32le', out], { cwd: dir })
    return samples(['-i', out])
  }
  const pauses = (s: Float32Array): number => db(Float32Array.from(PAUSES.flatMap((p) => [...range(s, p)])))
  const before = { pauses: pauses(input), fw: fwSegSnr(range(ref, LS), range(input, LS)) }
  const rows: string[] = [`input:  pauses ${before.pauses.toFixed(1)} dBFS, LibriSpeech fwSNRseg ${before.fw.toFixed(2)} dB`]
  afterAll(() => console.log(`Clean voice bench\n  ${rows.join('\n  ')}`))

  // Least reduction of the pauses' noise (dB) each strength must reach (measured: about 8, 12 and 23).
  const MIN_REDUCTION: Record<VoiceStrength, number> = { light: 6, normal: 10, strong: 20 }

  for (const strength of ['light', 'normal', 'strong'] as const) {
    it(`${strength}: quieter pauses, every voice kept`, () => {
      const out = cleaned(strength)
      expect(out.length).toBe(input.length)
      const reduction = before.pauses - pauses(out)
      const ls = db(range(out, LS)) - db(range(ref, LS))
      const jfk = db(range(out, JFK)) - db(range(ref, JFK))
      const fw = fwSegSnr(range(ref, LS), range(out, LS))
      rows.push(`${strength.padEnd(6)}: pauses -${reduction.toFixed(1)} dB, LibriSpeech ${ls.toFixed(2)} dB, JFK ${jfk.toFixed(2)} dB, fwSNRseg ${fw.toFixed(2)} dB`)
      expect(reduction).toBeGreaterThanOrEqual(MIN_REDUCTION[strength])
      // Every voice stays (JFK's own crowd noise goes too, so it loses a little more: about 2 dB).
      // Two passes of the speech model took 40 dB off JFK: what this guards against.
      expect(Math.abs(ls)).toBeLessThan(1)
      expect(Math.abs(jfk)).toBeLessThan(3)
      // The clean voice keeps its detail (measured: within about 2.5 dB of the noisy input's).
      expect(fw).toBeGreaterThan(before.fw - 3)
    }, 60_000)
  }
})
