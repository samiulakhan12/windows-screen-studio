// The speech helper (native/speech) end to end on this machine: the host build, the committed
// speech detector model and fixtures, and the test model fetched by npm run fetch:test-speech
// (docs/design/offline-captions.md §10.2). Every line the helper prints is checked against the
// frozen protocol. Missing prerequisites fail the suite with the command that provides them.
import { spawn, spawnSync } from 'node:child_process'
import { createHash } from 'node:crypto'
import { copyFileSync, existsSync, mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from 'node:fs'
import { createRequire } from 'node:module'
import os from 'node:os'
import path from 'node:path'
import { pathToFileURL } from 'node:url'
import { afterAll, beforeAll, describe, expect, it } from 'vitest'
import { SIDECAR } from '../../src/shared/speech/protocol'
import { speechModel, VAD_MODEL } from '../../src/shared/speech/catalog'

const require = createRequire(import.meta.url)
const ROOT = path.resolve(__dirname, '..', '..')
const HELPER = process.env.SSW_SPEECH_HELPER_TEST ?? path.join(ROOT, 'native', 'bin', process.platform === 'win32' ? 'ssw-speech.exe' : 'ssw-speech')
const VAD = path.join(ROOT, 'resources', 'speech', VAD_MODEL.file)
const FIXTURES = path.join(ROOT, 'tests', 'fixtures', 'speech')
const MODEL_DIR = path.resolve(ROOT, process.env.SSW_TEST_SPEECH_CACHE || path.join('.cache', 'test-speech'))
const TINY = speechModel('whisper-tiny')!
const FFMPEG: string = require('ffmpeg-static')

type Line = Record<string, unknown> & { type: string }
interface Run {
  code: number | null
  signal: NodeJS.Signals | null
  lines: Line[]
  stderr: string
  ms: number
}

let tmp = ''

beforeAll(() => {
  const missing: string[] = []
  if (!existsSync(HELPER)) missing.push(`${path.relative(ROOT, HELPER)} (run npm run build:speech-host)`)
  if (!existsSync(path.join(MODEL_DIR, TINY.file))) missing.push(`${TINY.file} in ${path.relative(ROOT, MODEL_DIR)} (run npm run fetch:test-speech)`)
  if (!FFMPEG || !existsSync(FFMPEG)) missing.push('ffmpeg-static (run npm ci)')
  if (missing.length) throw new Error(`the speech helper tests need: ${missing.join('; ')}`)
  tmp = mkdtempSync(path.join(os.tmpdir(), 'ssw-speech-native-'))
})

afterAll(() => {
  if (tmp) rmSync(tmp, { recursive: true, force: true })
})

/** Checks one stdout line against the frozen protocol (src/shared/speech/protocol.ts). */
function checkLine(raw: string): Line {
  expect(Buffer.byteLength(raw)).toBeLessThanOrEqual(SIDECAR.lineMax)
  const v = JSON.parse(raw) as Line
  const num = (x: unknown): void => {
    expect(typeof x).toBe('number')
    expect(Number.isFinite(x)).toBe(true)
  }
  const keys = (want: string[]): void => expect(Object.keys(v).sort()).toEqual([...want, 'type'].sort())
  switch (v.type) {
    case 'cpu':
      keys(['sse42', 'avx', 'avx2', 'fma', 'f16c', 'bmi2', 'logical'])
      for (const k of ['sse42', 'avx', 'avx2', 'fma', 'f16c', 'bmi2']) expect(typeof v[k]).toBe('boolean')
      num(v.logical)
      break
    case 'vad':
      keys(['audio_s', 'frame', 'n', 'probs', 'detect_ms'])
      num(v.audio_s)
      num(v.detect_ms)
      expect(v.frame).toBe(SIDECAR.vadFrame)
      expect(Buffer.from(v.probs as string, 'base64').length).toBe(v.n)
      break
    case 'ready':
      keys(['model', 'multilingual', 'dtw', 'build', 'system'])
      expect(['standard', 'compatible', 'host']).toContain(v.build)
      break
    case 'speech':
      keys(['segments'])
      for (const r of v.segments as number[][]) {
        num(r[0])
        num(r[1])
        expect(r[1]).toBeGreaterThan(r[0])
      }
      break
    case 'progress':
      keys(['percent', 'at'])
      num(v.percent)
      num(v.at)
      expect(v.percent).toBeGreaterThanOrEqual(0)
      expect(v.percent).toBeLessThanOrEqual(100)
      break
    case 'segment':
      keys(['start', 'end', 'text', 'words'])
      num(v.start)
      num(v.end)
      expect(typeof v.text).toBe('string')
      for (const w of v.words as Record<string, unknown>[]) {
        expect(Object.keys(w).sort()).toEqual(['end', 'prob', 'start', 'text'])
        expect(typeof w.text).toBe('string')
        expect((w.text as string).length).toBeGreaterThan(0)
        num(w.start)
        num(w.end)
        expect(w.end as number).toBeGreaterThanOrEqual(w.start as number)
        expect(w.prob as number).toBeGreaterThanOrEqual(0)
        expect(w.prob as number).toBeLessThanOrEqual(1)
      }
      break
    case 'result': {
      keys(['language', 'language_s', 'duration', 'timing'])
      expect(typeof v.language).toBe('string')
      num(v.language_s)
      num(v.duration)
      const t = v.timing as Record<string, unknown>
      expect(Object.keys(t).sort()).toEqual(['asr_ms', 'load_ms', 'peak_rss_mb', 'rtf', 'vad_ms'])
      for (const k of Object.keys(t)) num(t[k])
      break
    }
    case 'cancelled':
      keys(['done_until'])
      num(v.done_until)
      break
    case 'error':
      keys(['code', 'message'])
      expect(['args', 'model', 'audio', 'language', 'memory', 'cpu', 'internal']).toContain(v.code)
      break
    default:
      throw new Error(`unknown line type ${v.type}`)
  }
  return v
}

/** Runs the helper; `onLine` may write to its stdin (the control channel). */
function helper(args: string[], opts: { input?: Buffer; onLine?: (l: Line, stdin: NodeJS.WritableStream) => void; closeStdin?: boolean } = {}): Promise<Run> {
  return new Promise((resolve, reject) => {
    const t0 = Date.now()
    const child = spawn(HELPER, args, { cwd: tmp, shell: false, stdio: ['pipe', 'pipe', 'pipe'], env: { PATH: process.env.PATH ?? '', LANG: 'C.UTF-8' } })
    const lines: Line[] = []
    let buf = ''
    let stderr = ''
    child.stdout.setEncoding('utf8')
    child.stdout.on('data', (d: string) => {
      buf += d
      let i: number
      while ((i = buf.indexOf('\n')) >= 0) {
        const raw = buf.slice(0, i)
        buf = buf.slice(i + 1)
        try {
          const l = checkLine(raw)
          lines.push(l)
          opts.onLine?.(l, child.stdin)
        } catch (err) {
          child.kill()
          reject(new Error(`bad line ${raw.slice(0, 300)}: ${(err as Error).message}`))
        }
      }
    })
    child.stderr.on('data', (d) => (stderr += String(d)))
    child.stdin.on('error', () => {})
    if (opts.input) child.stdin.end(opts.input)
    // Otherwise stdin stays open (with --stdin-control its end means cancel) until the helper exits.
    else if (opts.closeStdin) child.stdin.end()
    child.on('error', reject)
    child.on('close', (code, signal) => {
      child.stdin.destroy()
      resolve({ code, signal, lines, stderr, ms: Date.now() - t0 })
    })
  })
}

const one = (r: Run, type: string): Line => {
  const l = r.lines.filter((x) => x.type === type)
  expect(l, `${type} lines in ${JSON.stringify(r.lines).slice(0, 500)}\n${r.stderr.slice(-1500)}`).toHaveLength(1)
  return l[0]
}

/** 16 kHz mono float samples of a file (ffmpeg-static). */
function decode(file: string): Float32Array {
  const r = spawnSync(FFMPEG, ['-v', 'error', '-nostdin', '-i', file, '-ac', '1', '-ar', '16000', '-f', 'f32le', 'pipe:1'], { maxBuffer: 1 << 30 })
  if (r.status !== 0) throw new Error(`ffmpeg failed: ${r.stderr}`)
  return new Float32Array(r.stdout.buffer, r.stdout.byteOffset, r.stdout.length / 4).slice()
}

function concat(...parts: Float32Array[]): Float32Array {
  const out = new Float32Array(parts.reduce((n, p) => n + p.length, 0))
  let at = 0
  for (const p of parts) {
    out.set(p, at)
    at += p.length
  }
  return out
}

const silence = (s: number): Float32Array => new Float32Array(Math.round(s * 16000))

/** Brown noise at about -45 dBFS with 5 ms key clicks at 8 Hz: what a keyboard sounds like. */
function clatter(s: number): Float32Array {
  const out = new Float32Array(Math.round(s * 16000))
  let seed = 7
  const rnd = (): number => {
    seed = (seed * 1103515245 + 12345) & 0x7fffffff
    return seed / 0x7fffffff - 0.5
  }
  let b = 0
  for (let i = 0; i < out.length; i++) {
    b = 0.995 * b + rnd() * 0.02
    out[i] = b * 0.05
  }
  for (let c = 0; c < s * 8; c++) {
    const at = Math.round((c / 8 + 0.03) * 16000)
    for (let k = 0; k < 80 && at + k < out.length; k++) out[at + k] += rnd() * 0.6 * Math.exp(-k / 20)
  }
  return out
}

/** A 16 kHz mono WAV, PCM 16-bit (`rate` lets a test write a wrong one). */
function wav(file: string, pcm: Float32Array, rate = 16000): string {
  const data = Buffer.alloc(pcm.length * 2)
  pcm.forEach((v, i) => data.writeInt16LE(Math.max(-32768, Math.min(32767, Math.round(v * 32767))), i * 2))
  const h = Buffer.alloc(44)
  h.write('RIFF', 0, 'latin1')
  h.writeUInt32LE(36 + data.length, 4)
  h.write('WAVEfmt ', 8, 'latin1')
  h.writeUInt32LE(16, 16)
  h.writeUInt16LE(1, 20)
  h.writeUInt16LE(1, 22)
  h.writeUInt32LE(rate, 24)
  h.writeUInt32LE(rate * 2, 28)
  h.writeUInt16LE(2, 32)
  h.writeUInt16LE(16, 34)
  h.write('data', 36, 'latin1')
  h.writeUInt32LE(data.length, 40)
  const p = path.join(tmp, file)
  writeFileSync(p, Buffer.concat([h, data]))
  return p
}

const f32le = (pcm: Float32Array): Buffer => Buffer.from(pcm.buffer, pcm.byteOffset, pcm.byteLength)

/** Speech ranges from the `vad` line by Silero's rules (as speechFromProbs): seconds. */
function ranges(v: Line): [number, number][] {
  const p = [...Buffer.from(v.probs as string, 'base64')].map((b) => b / 255)
  const raw: [number, number][] = []
  let on = -1
  p.forEach((x, i) => {
    if (on < 0 && x >= 0.5) on = i
    else if (on >= 0 && x < 0.35) {
      raw.push([on, i])
      on = -1
    }
  })
  if (on >= 0) raw.push([on, p.length])
  const joined: [number, number][] = []
  for (const r of raw) {
    const last = joined[joined.length - 1]
    if (last && r[0] - last[1] <= 3) last[1] = r[1]
    else joined.push([...r])
  }
  return joined.filter((r) => r[1] - r[0] >= 8).map(([a, b]) => [Math.max(0, a * 0.032 - 0.03), b * 0.032 + 0.03])
}

const transcribeArgs = (audio: string, extra: string[] = [], dir = MODEL_DIR): string[] => [
  'transcribe',
  '--model-dir',
  dir,
  '--model',
  TINY.file,
  '--audio',
  audio,
  '--vad-model',
  VAD,
  '--threads',
  String(Math.max(1, Math.min(4, os.cpus().length))),
  '--low-priority',
  '--stdin-control',
  '--parent-pid',
  String(process.pid),
  ...extra
]

const wordsOf = (r: Run): { text: string; start: number; end: number }[] =>
  r.lines.filter((l) => l.type === 'segment').flatMap((s) => s.words as { text: string; start: number; end: number }[])
const norm = (t: string): string => t.toLowerCase().replace(/[^a-z0-9']/g, '')

let jfk: Float32Array
let ls: Float32Array

describe('ssw-speech (host build)', () => {
  beforeAll(() => {
    jfk = decode(path.join(FIXTURES, 'jfk-16k.flac'))
    ls = decode(path.join(FIXTURES, 'ls-1272-128104-0000.flac'))
  })

  it('uses the catalog pin for the test model', async () => {
    const script = pathToFileURL(path.join(ROOT, 'scripts', 'fetch-test-speech.mjs')).href
    const { TEST_MODEL } = (await import(script)) as { TEST_MODEL: { file: string; bytes: number; sha256: string } }
    expect(TEST_MODEL).toMatchObject({ file: TINY.file, bytes: TINY.bytes, sha256: TINY.sha256 })
    const h = createHash('sha256').update(readFileSync(path.join(MODEL_DIR, TINY.file))).digest('hex')
    expect(h).toBe(TINY.sha256)
  })

  it('cpu reports what the processor offers', async () => {
    const r = await helper(['cpu'], { closeStdin: true })
    expect(r.code).toBe(0)
    const c = one(r, 'cpu')
    expect(c.logical as number).toBeGreaterThanOrEqual(1)
  })

  it('vad finds the speech of JFK and none in keyboard clatter', async () => {
    const r = await helper(['vad', '--vad-model', VAD, '--audio', '-', '--format', 'f32le', '--threads', '1', '--low-priority', '--parent-pid', String(process.pid)], { input: f32le(jfk) })
    expect(r.code, r.stderr).toBe(0)
    const v = one(r, 'vad')
    expect(v.audio_s as number).toBeCloseTo(11.0, 1)
    expect(v.n).toBe(Math.ceil(jfk.length / 512))
    const sp = ranges(v)
    expect(sp.length).toBeGreaterThan(0)
    // Speech within [0.3, 10.8] s, ± 0.2 s.
    expect(sp[0][0]).toBeGreaterThanOrEqual(0.1)
    expect(sp[0][0]).toBeLessThanOrEqual(0.5)
    expect(sp[sp.length - 1][1]).toBeLessThanOrEqual(11.0)
    expect(sp[sp.length - 1][1]).toBeGreaterThanOrEqual(10.6)

    const noise = await helper(['vad', '--vad-model', VAD, '--audio', '-'], { input: f32le(clatter(3)) })
    expect(noise.code).toBe(0)
    expect(ranges(one(noise, 'vad'))).toEqual([])
    // A WAV file works too.
    const fromFile = await helper(['vad', '--vad-model', VAD, '--audio', wav('jfk.wav', jfk)])
    expect(ranges(one(fromFile, 'vad')).length).toBe(sp.length)
  })

  it('vad reads 11 minutes in 300 s windows and finds every utterance across the window joins', async () => {
    // Utterances placed so that two of them straddle the joins at about 298 s and 596 s.
    const starts = [5, 150, 292, 440, 590, 640]
    const total = 660
    const pcm = new Float32Array(total * 16000)
    for (const s of starts) pcm.set(ls, s * 16000)
    const r = await helper(['vad', '--vad-model', VAD, '--audio', '-', '--threads', '1'], { input: f32le(pcm) })
    expect(r.code, r.stderr).toBe(0)
    const v = one(r, 'vad')
    expect(v.n).toBe(total / 0.032)
    const sp = ranges(v)
    for (const s of starts) {
      const heard = sp.filter((x) => x[1] > s && x[0] < s + ls.length / 16000).reduce((t, x) => t + Math.min(x[1], s + 5.86) - Math.max(x[0], s), 0)
      expect(heard, `speech at ${s} s`).toBeGreaterThan(3.5)
    }
    for (const x of sp) expect(starts.some((s) => x[0] >= s - 0.3 && x[1] <= s + 6.2), `stray speech ${x}`).toBe(true)
  })

  it('transcribes JFK and LibriSpeech with words built from the segment lines alone', async () => {
    // JFK alone holds 7.9 s of speech, under the 10 s a detection must hear; with the
    // LibriSpeech clip after it (as in the end-to-end fixture) the chunk holds about 13 s.
    const r = await helper(transcribeArgs(wav('jfk-t.wav', concat(jfk, silence(0.5), ls))))
    expect(r.code, r.stderr).toBe(0)
    const ready = one(r, 'ready')
    expect(ready).toMatchObject({ model: 'tiny', multilingual: true, dtw: 'TINY', build: 'host' })
    const speech = one(r, 'speech').segments as [number, number][]
    const result = one(r, 'result')
    expect(result.language).toBe('en')
    expect(result.language_s as number).toBeGreaterThanOrEqual(SIDECAR.detectMinSpeech)
    expect((result.timing as Record<string, number>).peak_rss_mb).toBeGreaterThan(50)
    const words = wordsOf(r)
    const text = words.map((w) => norm(w.text))
    expect(text).toContain('americans')
    expect(text).toContain('country')
    expect(text.filter((w) => ['apostle', 'middle', 'classes', 'gospel'].includes(w)).length).toBeGreaterThanOrEqual(2)
    for (let i = 1; i < words.length; i++) expect(words[i].start).toBeGreaterThanOrEqual(words[i - 1].end)
    // Each word lies in speech (± 0.3 s): its start and its end are in a speech range, and a
    // word may bridge a short pause between two ranges.
    const inSpeech = (t: number): boolean => speech.some(([s, e]) => t >= s - 0.3 && t <= e + 0.3)
    for (const w of words) expect(inSpeech(w.start) && inSpeech(w.end), `${w.text} ${w.start}-${w.end} in ${JSON.stringify(speech)}`).toBe(true)
    // Progress lines come in order and reach 100.
    const pct = r.lines.filter((l) => l.type === 'progress').map((l) => l.percent as number)
    expect(pct[pct.length - 1]).toBe(100)
    expect([...pct].sort((a, b) => a - b)).toEqual(pct)
    // The result line is the last one.
    expect(r.lines[r.lines.length - 1].type).toBe('result')
  })

  it('detects the language on the chunk that heard enough speech, not on a short opening', async () => {
    // 1 s of JFK, 40 s of silence, then JFK and the LibriSpeech clip (13 s of talking).
    const pcm = concat(jfk.subarray(0, 16000), silence(40), jfk, silence(0.5), ls)
    const r = await helper(transcribeArgs(wav('late.wav', pcm)))
    expect(r.code, r.stderr).toBe(0)
    const res = one(r, 'result')
    expect(res.language).toBe('en')
    expect(res.language_s as number).toBeGreaterThanOrEqual(SIDECAR.detectMinSpeech)
    expect(res.language_s as number).toBeLessThan(20)
    const text = wordsOf(r).map((w) => norm(w.text))
    expect(text.filter((w) => ['apostle', 'middle', 'classes', 'gospel'].includes(w)).length).toBeGreaterThanOrEqual(2)
  })

  it('reports language_s 0 when the language is given, and no language for silence', async () => {
    const given = await helper(transcribeArgs(wav('jfk-en.wav', jfk), ['--lang', 'en']))
    expect(given.code, given.stderr).toBe(0)
    expect(one(given, 'result')).toMatchObject({ language: 'en', language_s: 0 })
    const quiet = await helper(transcribeArgs(wav('silence.wav', silence(5))))
    expect(quiet.code, quiet.stderr).toBe(0)
    expect(one(quiet, 'result')).toMatchObject({ language: '', language_s: 0 })
    expect(quiet.lines.filter((l) => l.type === 'segment')).toEqual([])
    expect(one(quiet, 'speech').segments).toEqual([])
    const unknown = await helper(transcribeArgs(wav('jfk-xx.wav', jfk), ['--lang', 'xx']))
    expect(unknown.code).toBe(SIDECAR.exit.error)
    expect(one(unknown, 'error').code).toBe('language')
  })

  it('cancels through stdin within 5 s', async () => {
    const long = concat(...Array.from({ length: 12 }, () => concat(jfk, silence(0.5), ls, silence(0.5))))
    let sent = 0
    const r = await helper(transcribeArgs(wav('long.wav', long)), {
      onLine: (l, stdin) => {
        if (l.type === 'ready') {
          sent = Date.now()
          stdin.write('cancel\n')
        }
      }
    })
    expect(r.code).toBe(SIDECAR.exit.cancelled)
    one(r, 'cancelled')
    expect(Date.now() - sent).toBeLessThan(5000)
    // The end of stdin cancels too.
    const eof = await helper(transcribeArgs(wav('long2.wav', long)), { closeStdin: true })
    expect(eof.code).toBe(SIDECAR.exit.cancelled)
    one(eof, 'cancelled')
  })

  it('refuses a truncated model, a wrong WAV and a model name that is a path, without crashing', async () => {
    const dir = path.join(tmp, 'cut')
    mkdirSync(dir, { recursive: true })
    const bytes = readFileSync(path.join(MODEL_DIR, TINY.file))
    for (const [name, len] of [
      ['half.bin', Math.floor(bytes.length / 2)],
      ['nearly.bin', bytes.length - 100],
      ['header.bin', 40]
    ] as const) {
      writeFileSync(path.join(dir, name), bytes.subarray(0, len))
      const r = await helper(transcribeArgs(wav('jfk-cut.wav', jfk), [], dir).map((a) => (a === TINY.file ? name : a)))
      expect(r.signal, `${name}: ${r.stderr.slice(-500)}`).toBe(null)
      expect(r.code, name).toBe(SIDECAR.exit.error)
      expect(one(r, 'error').code, name).toBe('model')
    }
    const narrow = await helper(transcribeArgs(wav('narrow.wav', jfk.subarray(0, 8000 * 2), 8000)))
    expect(narrow.code).toBe(SIDECAR.exit.error)
    expect(one(narrow, 'error').code).toBe('audio')
    const traversal = await helper(transcribeArgs(wav('jfk-p.wav', jfk)).map((a) => (a === TINY.file ? `../${TINY.file}` : a)))
    expect(one(traversal, 'error').code).toBe('args')
    const unknown = await helper(['transcribe', '--bogus'])
    expect(one(unknown, 'error').code).toBe('args')
  })

  it('opens the models from a non-ASCII folder', async () => {
    const dir = path.join(tmp, 'modèle-тест')
    mkdirSync(dir, { recursive: true })
    copyFileSync(path.join(MODEL_DIR, TINY.file), path.join(dir, TINY.file))
    copyFileSync(VAD, path.join(dir, VAD_MODEL.file))
    const audio = path.join(dir, 'données.wav')
    copyFileSync(wav('jfk-u.wav', jfk), audio)
    const args = transcribeArgs(audio, [], dir).map((a) => (a === VAD ? path.join(dir, VAD_MODEL.file) : a))
    const r = await helper(args)
    expect(r.code, r.stderr).toBe(0)
    expect(wordsOf(r).map((w) => norm(w.text))).toContain('country')
  })
})
