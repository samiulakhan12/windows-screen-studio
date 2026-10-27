/**
 * "On this PC" as a transcription client (src/main/speech/localClient.ts) against the fake
 * helper: the part cache and its key, the language carried only from a part that heard enough
 * speech, resuming, progress, the model hold, and every failure as a shared sentence that maps
 * back to its code. The last block runs the whole job through transcribeProject (real ffmpeg).
 */
import { execFileSync } from 'node:child_process'
import { chmodSync, mkdirSync, mkdtempSync, readdirSync, readFileSync, rmSync, statSync, truncateSync, writeFileSync } from 'node:fs'
import path from 'node:path'
import { pathToFileURL } from 'node:url'
import { afterAll, afterEach, beforeEach, describe, expect, it, vi } from 'vitest'
import type { TranscribeProgress } from '../src/shared/api/ai'

const h = vi.hoisted(() => ({
  root: require('node:fs').mkdtempSync(require('node:path').join(require('node:os').tmpdir(), 'ssw-local-client-')) as string,
  handlers: new Map<string, (...args: unknown[]) => unknown>()
}))

vi.mock('electron', () => ({
  app: {
    isPackaged: false,
    getAppPath: () => require('node:path').resolve(__dirname, '..'),
    getPath: (name: string) => require('node:path').join(h.root, name),
    getVersion: () => '0.0.0-test',
    on: () => undefined
  },
  session: {},
  net: {},
  ipcMain: { handle: (channel: string, fn: (...args: unknown[]) => unknown) => h.handlers.set(channel, fn) },
  safeStorage: { isEncryptionAvailable: () => false, getSelectedStorageBackend: () => 'basic_text' }
}))

import { resetHelperSelection } from '../src/main/speech/helper'
import { helperLanguage, localSpeechClient, PART_CACHE_DIR, partCacheKey, type LocalClientDeps } from '../src/main/speech/localClient'
import type { SpeechModelStore } from '../src/main/speech/models'
import type { PartProgress } from '../src/main/ai/types'
import { ENGINE_VERSION, speechModel, type SpeechModelId } from '../src/shared/speech/catalog'
import { localErrorCode } from '../src/shared/speech/errors'

const FAKE = path.resolve(__dirname, 'fixtures/fake-speech-helper.cjs')
const VAD = path.resolve(__dirname, '../resources/speech/ggml-silero-v6.2.0.bin')
const log = path.join(h.root, 'calls.jsonl')
const counter = path.join(h.root, 'counter')
const calls = (): string[][] => readFileSync(log, 'utf8').trim().split('\n').filter(Boolean).map((l) => JSON.parse(l).args)
const transcribeCalls = (): string[][] => calls().filter((a) => a[0] === 'transcribe')
const argOf = (args: string[], name: string): string => args[args.indexOf(name) + 1]

/** A stand-in for the model store: the model "installed", and what the client asks of it. */
function fakeStore(over: Partial<Record<string, unknown>> = {}) {
  const s = {
    held: 0,
    cleared: [] as string[],
    learned: [] as { id: string; rtf: number; threads: number; build: string }[],
    defaultModel: () => 'whisper-tiny' as SpeechModelId,
    installedFile: async (id: SpeechModelId) => path.join(h.root, 'models', speechModel(id)!.file),
    measured: () => null,
    hold: () => {
      s.held++
      return () => s.held--
    },
    clearVerified: (id: string) => s.cleared.push(id),
    recordMeasured: (id: string, rtf: number, threads: number, build: string) => s.learned.push({ id, rtf, threads, build }),
    ...over
  }
  return s
}

let projectDir: string
let tmp: string
const deps = (store = fakeStore(), extra: Partial<LocalClientDeps> = {}): LocalClientDeps => ({
  projectDir,
  store: store as unknown as SpeechModelStore,
  vadModel: VAD,
  cores: 4,
  totalMemBytes: 16 * 2 ** 30,
  ...extra
})

/** A 16 kHz mono s16 WAV of `seconds` (silence; the fake reads only its length); `tag` makes its bytes unique. */
function wav(name: string, seconds: number, tag = 0): string {
  const file = path.join(tmp, name)
  const data = Buffer.alloc(Math.round(seconds * 32000))
  data[0] = tag
  writeFileSync(file, Buffer.concat([Buffer.alloc(44), data]))
  return file
}
const part = (file: string, seconds: number) => ({ file, mimeType: 'audio/wav', bytes: statSync(file).size, seconds })
const signal = (): AbortSignal => new AbortController().signal
const failure = async (p: Promise<unknown>): Promise<string> => {
  try {
    await p
  } catch (err) {
    return (err as Error).message
  }
  throw new Error('expected a failure')
}

const ENV = ['SSW_SPEECH_HELPER', 'FAKE_SPEECH_MODE', 'FAKE_SPEECH_LOG', 'FAKE_SPEECH_LANG_S', 'FAKE_SPEECH_LANG', 'FAKE_SPEECH_MATCH', 'FAKE_SPEECH_TIMES', 'FAKE_SPEECH_COUNTER', 'FAKE_SPEECH_PART_SPEECH']
beforeEach(() => {
  resetHelperSelection()
  process.env.SSW_SPEECH_HELPER = FAKE
  process.env.FAKE_SPEECH_LOG = log
  process.env.FAKE_SPEECH_COUNTER = counter
  writeFileSync(log, '')
  rmSync(counter, { force: true })
  projectDir = mkdtempSync(path.join(h.root, 'project-'))
  tmp = mkdtempSync(path.join(h.root, 'job-'))
})
afterEach(() => {
  for (const k of ENV) delete process.env[k]
})
afterAll(() => rmSync(h.root, { recursive: true, force: true }))

describe('partCacheKey', () => {
  it('changes with the part, the model, the language and the engine version', () => {
    const tiny = speechModel('whisper-tiny')!
    const base = speechModel('whisper-base')!
    const k = partCacheKey('a'.repeat(64), tiny, 'en', ENGINE_VERSION)
    expect(k).toMatch(/^[0-9a-f]{64}$/)
    expect(partCacheKey('b'.repeat(64), tiny, 'en', ENGINE_VERSION)).not.toBe(k)
    expect(partCacheKey('a'.repeat(64), base, 'en', ENGINE_VERSION)).not.toBe(k)
    expect(partCacheKey('a'.repeat(64), tiny, 'de', ENGINE_VERSION)).not.toBe(k)
    expect(partCacheKey('a'.repeat(64), tiny, 'en', 'ssw-speech/2')).not.toBe(k)
    // Detect automatically is one key, however it is written.
    expect(partCacheKey('a'.repeat(64), tiny, undefined, ENGINE_VERSION)).toBe(partCacheKey('a'.repeat(64), tiny, 'auto', ENGINE_VERSION))
  })

  it('passes a chosen language as its primary subtag', () => {
    expect(helperLanguage('pt-BR')).toBe('pt')
    expect(helperLanguage('EN')).toBe('en')
    expect(helperLanguage(undefined)).toBeUndefined()
  })
})

describe('localSpeechClient', () => {
  it('takes WAV parts of the model’s partSeconds and names the model', async () => {
    for (const id of ['whisper-tiny', 'whisper-small'] as const) {
      const c = await localSpeechClient(id, deps())
      expect(c.input).toBe('wav')
      expect(c.model).toBe(id)
      expect(c.partLimits).toEqual({ maxSeconds: speechModel(id)!.partSeconds, maxBytes: Infinity })
      c.dispose!()
    }
    // Absent: the default model.
    expect((await localSpeechClient(undefined, deps(fakeStore({ defaultModel: () => 'whisper-base' })))).model).toBe('whisper-base')
  })

  it('runs the helper with the arguments of the protocol and builds the part from its segment lines', async () => {
    const store = fakeStore()
    const c = await localSpeechClient('whisper-tiny', deps(store))
    expect(store.held).toBe(1)
    const file = wav('part-0.wav', 4)
    const progress: PartProgress[] = []
    const t = await c.transcribe!(part(file, 4), { signal: signal(), onProgress: (p) => progress.push(p) })
    expect(t.language).toBe('en')
    expect(t.segments.map((s) => s.text).join(' ')).toBe('w0 w1 w2 w3')
    expect(t.segments.flatMap((s) => s.words!.map((w) => w.start))).toEqual([0, 1, 2, 3])
    const [args] = transcribeCalls()
    expect(args).toEqual([
      'transcribe', '--model-dir', path.join(h.root, 'models'), '--model', 'ggml-tiny-q8_0.bin', '--audio', file, '--vad-model', VAD,
      '--lang', 'auto', '--threads', '3', '--stdin-control', '--low-priority', '--parent-pid', String(process.pid)
    ])
    expect(progress[0]).toEqual({ phase: 'loading', fraction: 0 })
    expect(progress.some((p) => p.phase === 'transcribing' && p.fraction === 1 && p.preview === 'w2 w3')).toBe(true)
    // Cached in the project, by content.
    expect(readdirSync(path.join(projectDir, PART_CACHE_DIR))).toHaveLength(1)
    c.dispose!()
    expect(store.held).toBe(0)
  })

  it('carries a detected language to later parts only from a part with language_s >= 10', async () => {
    process.env.FAKE_SPEECH_LANG = 'de'
    process.env.FAKE_SPEECH_LANG_S = '4'
    const short = await localSpeechClient('whisper-tiny', deps())
    await short.transcribe!(part(wav('p0.wav', 3, 1), 3), { signal: signal() })
    await short.transcribe!(part(wav('p1.wav', 3, 2), 3), { signal: signal() })
    expect(transcribeCalls().map((a) => argOf(a, '--lang'))).toEqual(['auto', 'auto'])

    writeFileSync(log, '')
    process.env.FAKE_SPEECH_LANG_S = '12'
    const long = await localSpeechClient('whisper-tiny', deps())
    await long.transcribe!(part(wav('q0.wav', 3, 3), 3), { signal: signal() })
    const second = await long.transcribe!(part(wav('q1.wav', 3, 4), 3), { signal: signal() })
    expect(transcribeCalls().map((a) => argOf(a, '--lang'))).toEqual(['auto', 'de'])
    expect(second.language).toBe('de')

    // A chosen language is passed as asked, never 'auto'.
    writeFileSync(log, '')
    const chosen = await localSpeechClient('whisper-tiny', deps())
    await chosen.transcribe!(part(wav('r0.wav', 2, 5), 2), { signal: signal(), language: 'pt-BR' })
    expect(argOf(transcribeCalls()[0], '--lang')).toBe('pt')
  })

  it('a resumed job takes finished parts from the cache and makes the same language choice', async () => {
    process.env.FAKE_SPEECH_LANG = 'fr'
    process.env.FAKE_SPEECH_LANG_S = '15'
    const files = [wav('a0.wav', 3, 7), wav('a1.wav', 3, 8)]
    const first = await localSpeechClient('whisper-tiny', deps())
    const results = [await first.transcribe!(part(files[0], 3), { signal: signal() }), await first.transcribe!(part(files[1], 3), { signal: signal() })]
    expect(transcribeCalls()).toHaveLength(2)

    writeFileSync(log, '')
    const again = await localSpeechClient('whisper-tiny', deps())
    const progress: PartProgress[] = []
    const resumed = [
      await again.transcribe!(part(files[0], 3), { signal: signal(), onProgress: (p) => progress.push(p) }),
      await again.transcribe!(part(files[1], 3), { signal: signal(), onProgress: (p) => progress.push(p) })
    ]
    expect(transcribeCalls()).toHaveLength(0)
    expect(resumed).toEqual(results)
    expect(progress.filter((p) => p.cached)).toHaveLength(2)

    // A cache file that was tampered with is not trusted: the part runs again.
    const dir = path.join(projectDir, PART_CACHE_DIR)
    for (const f of readdirSync(dir)) writeFileSync(path.join(dir, f), JSON.stringify({ version: 1, transcript: { segments: 'x' } }))
    const third = await localSpeechClient('whisper-tiny', deps())
    await third.transcribe!(part(files[0], 3), { signal: signal() })
    expect(transcribeCalls()).toHaveLength(1)
  })

  it('learns this PC’s speed, for the build that ran, from parts of 60 s or more that are at least half speech', async () => {
    const store = fakeStore()
    const c = await localSpeechClient('whisper-tiny', deps(store))
    await c.transcribe!(part(wav('short.wav', 5, 1), 5), { signal: signal() })
    expect(store.learned).toEqual([])
    // Only the detected speech is transcribed: a mostly silent part runs several times faster and teaches nothing.
    process.env.FAKE_SPEECH_PART_SPEECH = '[[0,11],[40,45]]'
    await c.transcribe!(part(wav('sparse.wav', 61, 3), 61), { signal: signal() })
    expect(store.learned).toEqual([])
    delete process.env.FAKE_SPEECH_PART_SPEECH
    await c.transcribe!(part(wav('long.wav', 61, 2), 61), { signal: signal() })
    expect(store.learned).toHaveLength(1)
    expect(store.learned[0]).toMatchObject({ id: 'whisper-tiny', threads: 3, build: 'host' })
    expect(store.learned[0].rtf).toBeGreaterThan(0)
  })

  it('refuses before running anything when the engine, the model or the PC is not ready', async () => {
    process.env.SSW_SPEECH_HELPER = '/nonexistent/helper'
    expect(localErrorCode(await failure(localSpeechClient('whisper-tiny', deps())))).toBe('unavailable')
    resetHelperSelection()
    process.env.SSW_SPEECH_HELPER = FAKE
    const blocked = await failure(localSpeechClient('whisper-turbo', deps(fakeStore(), { totalMemBytes: 4 * 2 ** 30 })))
    expect(localErrorCode(blocked)).toBe('blocked')
    const missing = fakeStore({
      installedFile: async () => {
        throw new Error((await import('../src/shared/speech/errors')).localErrorMessage('no-model', { model: 'whisper-tiny' }))
      }
    })
    expect(localErrorCode(await failure(localSpeechClient('whisper-tiny', deps(missing))))).toBe('no-model')
    expect(missing.held).toBe(0)
  })

  it('refuses with "part of Flown is missing" when the bundled speech detector model is missing or damaged, never blaming the Whisper model', async () => {
    const damaged = path.join(h.root, 'silero-damaged.bin')
    writeFileSync(damaged, readFileSync(VAD).subarray(0, 1000))
    for (const vadModel of [damaged, path.join(h.root, 'no-such-silero.bin')]) {
      const store = fakeStore()
      const message = await failure(localSpeechClient('whisper-tiny', deps(store, { vadModel })))
      expect(localErrorCode(message)).toBe('unavailable')
      expect(message).toContain('part of Flown is missing')
      expect(store.cleared).toEqual([])
      expect(store.held).toBe(0)
    }
    expect(transcribeCalls()).toEqual([])
  })

  describe('failures, each a shared sentence', () => {
    const run = async (mode: string, extra: Record<string, string> = {}, store = fakeStore(), clientDeps: Partial<LocalClientDeps> = {}): Promise<{ message: string; store: ReturnType<typeof fakeStore> }> => {
      process.env.FAKE_SPEECH_MODE = mode
      process.env.FAKE_SPEECH_MATCH = 'part-'
      Object.assign(process.env, extra)
      const c = await localSpeechClient('whisper-tiny', deps(store, clientDeps))
      const message = await failure(c.transcribe!(part(wav('part-1.wav', 2), 2), { signal: signal(), part: { index: 1, count: 3 } }))
      c.dispose!()
      return { message, store }
    }

    it('a crash twice → crashed with the part numbers; the verified record is cleared and threads halved', async () => {
      const { message, store } = await run('crash')
      expect(localErrorCode(message)).toBe('crashed')
      expect(message).toContain('part 2 of 3')
      expect(store.cleared).toContain('whisper-tiny')
      expect(transcribeCalls().map((a) => argOf(a, '--threads'))).toEqual(['3', '1'])
      expect(store.held).toBe(0)
    })

    it('one crash, then the retry succeeds', async () => {
      process.env.FAKE_SPEECH_MODE = 'crash'
      process.env.FAKE_SPEECH_MATCH = 'x.wav'
      process.env.FAKE_SPEECH_TIMES = '1'
      const c = await localSpeechClient('whisper-tiny', deps())
      const t = await c.transcribe!(part(wav('x.wav', 2), 2), { signal: signal() })
      expect(t.segments.length).toBeGreaterThan(0)
      expect(transcribeCalls()).toHaveLength(2)
    })

    it('error memory → memory; error model → damaged (record cleared); error language → language', async () => {
      expect(localErrorCode((await run('memory')).message)).toBe('memory')
      const damaged = await run('model')
      expect(localErrorCode(damaged.message)).toBe('damaged')
      expect(damaged.store.cleared).toEqual(['whisper-tiny'])
      expect(localErrorCode((await run('language')).message)).toBe('language')
    })

    it('a stall twice → stalled, retried with the same threads', async () => {
      const { message } = await run('stall', {}, fakeStore(), { stallMs: 300 })
      expect(localErrorCode(message)).toBe('stalled')
      expect(transcribeCalls().map((a) => argOf(a, '--threads'))).toEqual(['3', '3'])
    })

    it('garbage, overflow or no result → protocol', async () => {
      expect(localErrorCode((await run('garbage')).message)).toBe('protocol')
      expect(localErrorCode((await run('no-result')).message)).toBe('protocol')
      expect(localErrorCode((await run('overflow')).message)).toBe('protocol')
    })

    it('an illegal instruction on the only (host) build → unavailable (cpu)', async () => {
      const { message } = await run('illegal')
      expect(localErrorCode(message)).toBe('unavailable')
      expect(message).toContain("processor cannot run")
    })

    it('a helper that cannot be started → unavailable (missing, blocked), never a crash: no retry, the model still trusted', async () => {
      const store = fakeStore()
      const gone = await localSpeechClient('whisper-tiny', deps(store, { helper: async () => ({ exe: path.join(h.root, 'gone', 'ssw-speech'), build: 'standard' }) }))
      const missing = await failure(gone.transcribe!(part(wav('s0.wav', 2, 1), 2), { signal: signal(), part: { index: 0, count: 2 } }))
      expect(localErrorCode(missing)).toBe('unavailable')
      expect(missing).toContain('part of Flown is missing')
      // A file the system refuses to run (EACCES here; EPERM or UNKNOWN when an antivirus blocks it on Windows).
      const refused = path.join(h.root, 'ssw-speech-refused')
      writeFileSync(refused, '#!/bin/sh\n')
      chmodSync(refused, 0o644)
      const blocked = await localSpeechClient('whisper-tiny', deps(store, { helper: async () => ({ exe: refused, build: 'standard' }) }))
      const message = await failure(blocked.transcribe!(part(wav('s1.wav', 2, 2), 2), { signal: signal() }))
      expect(localErrorCode(message)).toBe('unavailable')
      expect(message).toContain('Windows or an antivirus blocked the speech engine')
      expect(store.cleared).toEqual([])
    })

    it('a cancel is "Cancelled.", never a crash or a retry', async () => {
      process.env.FAKE_SPEECH_MODE = 'hang'
      const store = fakeStore()
      const c = await localSpeechClient('whisper-tiny', deps(store))
      const controller = new AbortController()
      setTimeout(() => controller.abort(), 150)
      expect(await failure(c.transcribe!(part(wav('y.wav', 2), 2), { signal: controller.signal }))).toBe('Cancelled.')
      expect(transcribeCalls()).toHaveLength(1)
      expect(store.cleared).toEqual([])
    })
  })
})

describe('a whole job through transcribeProject', () => {
  it('decodes, cuts WAV parts, runs the helper per part, merges, reports progress and clears the part cache', async () => {
    const { registerAiIpc } = await import('../src/main/aiIpc')
    if (!h.handlers.has('ai:transcribe')) registerAiIpc()
    process.env.SSW_AI_MAX_PART_SECONDS = '8'
    try {
      // The model as installed: a file of the pinned size whose verified record matches its size and time.
      const dir = path.join(h.root, 'userData', 'speech-models')
      mkdirSync(dir, { recursive: true })
      const spec = speechModel('whisper-tiny')!
      const model = path.join(dir, spec.file)
      writeFileSync(model, '')
      truncateSync(model, spec.bytes)
      const st = statSync(model)
      writeFileSync(path.join(dir, 'speech.json'), JSON.stringify({ version: 1, defaultModel: 'whisper-tiny', verified: { 'whisper-tiny': { bytes: st.size, mtimeMs: st.mtimeMs } }, measured: {} }))

      const id = 'rec-local'
      const pdir = path.join(h.root, 'videos', 'Flown', id)
      mkdirSync(pdir, { recursive: true })
      const { ffmpegPath } = await import('../src/main/ffmpeg')
      execFileSync(ffmpegPath(), ['-v', 'error', '-y', '-f', 'lavfi', '-i', 'sine=frequency=300:duration=19', '-c:a', 'aac', '-f', 'mp4', path.join(pdir, 'screen.mp4')])
      writeFileSync(path.join(pdir, 'project.json'), JSON.stringify({ version: 2, id, name: id, createdAt: new Date().toISOString(), duration: 19, width: 1280, height: 720, hasWebcam: false, hasAudio: true, webcamOffset: 0, capture: { method: 'chromium', cursorInVideo: true, region: null }, clips: [{ id: 'c0', start: 0, end: 19, speed: 1 }], zooms: [], autoZoom: false, annotations: [], style: { background: { type: 'color', color: '#000' }, padding: 0, cornerRadius: 0, shadow: 0, aspectRatio: 'auto' }, cursor: { show: false, size: 1.4, smoothing: 0.6, clickEffect: false, hideWhenIdle: true }, webcam: { show: false, corner: 'bottom-right', size: 0.24, shape: 'circle' }, effects: { motionBlur: 0, keystrokes: { show: false, position: 'bottom', size: 0.035 } }, audio: { volume: 1, muted: false } }))

      const progress: TranscribeProgress[] = []
      const appEvent = { senderFrame: { url: pathToFileURL(path.join(__dirname, '../src/renderer/index.html')).href }, sender: { isDestroyed: () => false, send: (_c: string, p: TranscribeProgress) => progress.push(p) } }
      const transcript = (await h.handlers.get('ai:transcribe')!(appEvent, id, { providerId: 'local', model: 'whisper-tiny' })) as import('../src/shared/types').Transcript
      expect(transcript).toMatchObject({ provider: 'local', model: 'whisper-tiny', language: 'en' })
      const words = transcript.segments.flatMap((s) => s.words ?? [])
      // One word a second, each once, in order, in source seconds across the parts.
      expect(words.length).toBeGreaterThanOrEqual(17)
      for (let i = 1; i < words.length; i++) expect(words[i].start).toBeGreaterThanOrEqual(words[i - 1].end)
      for (const s of transcript.segments) expect(s.text).toBe(s.words!.map((w) => w.text).join(' '))
      const parts = transcribeCalls()
      expect(parts.length).toBeGreaterThanOrEqual(3)
      expect(parts.every((a) => /part-\d+\.wav$/.test(argOf(a, '--audio')))).toBe(true)
      expect(progress[0].phase).toBe('extracting')
      expect(progress.some((p) => p.phase === 'loading')).toBe(true)
      const fractions = progress.filter((p) => p.fraction !== undefined).map((p) => p.fraction!)
      expect(fractions.every((f, i) => i === 0 || f >= fractions[i - 1] - 1e-9)).toBe(true)
      expect(progress[progress.length - 1]).toMatchObject({ phase: 'finishing', fraction: 1 })
      expect(progress.some((p) => p.preview)).toBe(true)
      // Merged: the part cache is gone, and nothing was left in the temp folder.
      expect(readdirSync(pdir)).not.toContain('.cache')

      // A model that is not installed: the shared sentence, nothing runs.
      writeFileSync(log, '')
      const msg = await failure(Promise.resolve(h.handlers.get('ai:transcribe')!(appEvent, id, { providerId: 'local', model: 'whisper-base' })))
      expect(localErrorCode(msg)).toBe('no-model')
      expect(transcribeCalls()).toEqual([])
      // An unknown model is refused by the validation.
      expect(await failure(Promise.resolve(h.handlers.get('ai:transcribe')!(appEvent, id, { providerId: 'local', model: '../x' })))).toBe('Unknown speech model.')
    } finally {
      delete process.env.SSW_AI_MAX_PART_SECONDS
    }
  }, 60_000)
})
