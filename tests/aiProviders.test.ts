/**
 * The AI providers end to end in the main process, against the local mock of their HTTP APIs
 * (tests/e2e/ai-mock-server.cjs): key storage through the IPC handlers, the key test, the
 * transcription pipeline with real ffmpeg (sound picked, decoded, split in pauses, sent, merged),
 * the text tasks with each provider, error messages, retries and cancelling.
 */
import { EventEmitter } from 'node:events'
import Anthropic from '@anthropic-ai/sdk'
import { execFileSync } from 'node:child_process'
import { existsSync, mkdirSync, mkdtempSync, readdirSync, readFileSync, rmSync, utimesSync, writeFileSync } from 'node:fs'
import { createRequire } from 'node:module'
import os from 'node:os'
import path from 'node:path'
import { pathToFileURL } from 'node:url'
import { afterAll, beforeAll, describe, expect, it, vi } from 'vitest'
import type { AiProviderInfo, AiTextResult, TranscribeProgress } from '../src/shared/api/ai'
import type { Transcript } from '../src/shared/types'

const h = vi.hoisted(() => ({
  root: require('node:fs').mkdtempSync(require('node:path').join(require('node:os').tmpdir(), 'ssw-ai-')) as string,
  packaged: false,
  handlers: new Map<string, (...args: unknown[]) => unknown>(),
  appEvents: new Map<string, () => void>()
}))

vi.mock('electron', () => ({
  app: {
    getPath: (name: string) => require('node:path').join(h.root, name),
    get isPackaged() {
      return h.packaged
    },
    on: (event: string, fn: () => void) => h.appEvents.set(event, fn)
  },
  session: {},
  ipcMain: { handle: (channel: string, fn: (...args: unknown[]) => unknown) => h.handlers.set(channel, fn) },
  // A stand-in for safeStorage: reversible, never the plain text.
  safeStorage: {
    isEncryptionAvailable: () => true,
    getSelectedStorageBackend: () => 'gnome_libsecret',
    encryptString: (s: string) => Buffer.concat([Buffer.from('v10'), Buffer.from(s).map((b) => b ^ 0x5a)]),
    decryptString: (b: Buffer) => Buffer.from(b.subarray(3).map((x) => x ^ 0x5a)).toString()
  }
}))

import { registerAiIpc } from '../src/main/aiIpc'
import { anthropicFailure, claudeAnswerText, claudeRequest } from '../src/main/ai/anthropic'
import { baseUrlOverride } from '../src/main/ai/endpoints'
import { geminiClient, geminiFailure } from '../src/main/ai/gemini'
import { refreshModelList, resetModelList } from '../src/main/ai/modelList'
import { callWithRetry } from '../src/main/ai/request'
import { today } from '../src/main/ai/retired'
import { partArgs, stopTranscription, sweepTranscribeTemp, validateTranscribeOptions, wavPartArgs } from '../src/main/ai/transcribe'
import { ffmpegPath } from '../src/main/ffmpeg'
import { BUNDLED_MODEL_LIST } from '../src/shared/ai/modelList'
import { ApiError } from '@google/genai'

const req = createRequire(import.meta.url)
const { startMockAi, mockAiEnv, burstAudioArgs } = req('./e2e/ai-mock-server.cjs') as {
  startMockAi: (o: { ffmpeg: string }) => Promise<{ url: string; requests: Record<string, any>[]; files: Map<string, { deleted: boolean }>; close: () => Promise<void> }>
  mockAiEnv: (url: string) => Record<string, string>
  burstAudioArgs: (starts: number[], seconds: number) => string[]
}

const appEvent = { senderFrame: { url: pathToFileURL(path.join(__dirname, '../src/renderer/index.html')).href }, sender: Object.assign(new EventEmitter(), { isDestroyed: () => false, send: vi.fn() }) }
const call = <T>(channel: string, ...args: unknown[]): Promise<T> => Promise.resolve(h.handlers.get(channel)!(appEvent, ...args) as T)
/** The IPC error as the renderer sees its message. */
const failure = async (p: Promise<unknown>): Promise<string> => {
  try {
    await p
  } catch (err) {
    return err instanceof Error ? err.message : String(err)
  }
  throw new Error('expected a failure')
}

let mock: Awaited<ReturnType<typeof startMockAi>>
const projectsRoot = path.join(h.root, 'videos', 'Flown')
/** "Word k" bursts start at these times (seconds). */
const STARTS = [1, 3.6, 6.2, 8.8, 11.4, 14, 16.6]

function seedProject(id: string, opts: { stems?: boolean } = {}): void {
  const dir = path.join(projectsRoot, id)
  mkdirSync(dir, { recursive: true })
  const enc = ['-c:a', 'aac', '-b:a', '96k']
  // The mixed sound has only the first two words; the microphone stem has all of them.
  execFileSync(ffmpegPath(), ['-v', 'error', '-y', ...burstAudioArgs(opts.stems ? STARTS.slice(0, 2) : STARTS, 19), ...enc, '-f', 'mp4', path.join(dir, 'screen.mp4')])
  if (opts.stems) execFileSync(ffmpegPath(), ['-v', 'error', '-y', ...burstAudioArgs(STARTS, 19), ...enc, path.join(dir, 'mic.m4a')])
  const project = {
    version: 2, id, name: id, createdAt: new Date().toISOString(), duration: 19, width: 1280, height: 720,
    hasWebcam: false, hasAudio: true, webcamOffset: 0, capture: { method: 'chromium', cursorInVideo: true, region: null },
    clips: [{ id: 'c0', start: 0, end: 19, speed: 1 }], zooms: [], autoZoom: false, annotations: [],
    style: { background: { type: 'color', color: '#000000' }, padding: 0, cornerRadius: 0, shadow: 0, aspectRatio: 'auto' },
    cursor: { show: false, size: 1.4, smoothing: 0.6, clickEffect: false, hideWhenIdle: true },
    webcam: { show: false, corner: 'bottom-right', size: 0.24, shape: 'circle' },
    effects: { motionBlur: 0, keystrokes: { show: false, position: 'bottom', size: 0.035 } },
    audio: { volume: 1, muted: false },
    ...(opts.stems ? { audioStems: { mic: true, system: false } } : {})
  }
  writeFileSync(path.join(dir, 'project.json'), JSON.stringify(project))
}

const transcribeTemps = (): string[] => readdirSync(os.tmpdir()).filter((f) => f.startsWith('ssw-transcribe-'))

/** Checks a transcript of the STARTS fixture: every word once, in order, at its source time. */
function expectWords(t: Transcript, starts = STARTS): void {
  expect(t.segments.map((s) => s.text)).toEqual(starts.map((_, k) => `Word ${k}`))
  t.segments.forEach((s, k) => {
    expect(s.start).toBeCloseTo(starts[k], 1)
    expect(s.end).toBeCloseTo(starts[k] + 1.2, 1)
    expect(s.id).toBe(`t${k + 1}`)
  })
}

beforeAll(async () => {
  mock = await startMockAi({ ffmpeg: ffmpegPath() })
  Object.assign(process.env, mockAiEnv(mock.url), { SSW_AI_MAX_PART_SECONDS: '8' })
  registerAiIpc()
  seedProject('rec-words')
  seedProject('rec-stems', { stems: true })
}, 60_000)

afterAll(async () => {
  await mock?.close()
  for (const k of ['SSW_AI_BASE_URL_OPENAI', 'SSW_AI_BASE_URL_GEMINI', 'SSW_AI_BASE_URL_ANTHROPIC', 'SSW_AI_MAX_PART_SECONDS', 'SSW_AI_GEMINI_INLINE_BYTES']) delete process.env[k]
  rmSync(h.root, { recursive: true, force: true })
})

const providers: Record<string, AiProviderInfo> = {}
const add = async (name: string, kind: AiProviderInfo['kind'], apiKey: string, extra: { transcriptionModel?: string } = {}): Promise<AiProviderInfo> =>
  (providers[name] = await call<AiProviderInfo>('ai:saveProvider', { kind, label: name, apiKey, ...extra }))

describe('base URL overrides', () => {
  it('are honoured only when the app is not packaged', () => {
    expect(baseUrlOverride('openai')).toBe(`${mock.url}/openai/v1`)
    h.packaged = true
    try {
      expect(baseUrlOverride('openai')).toBeUndefined()
      expect(baseUrlOverride('anthropic')).toBeUndefined()
    } finally {
      h.packaged = false
    }
  })

  it("send Gemini requests to Google itself in a packaged app, whatever GOOGLE_GEMINI_BASE_URL says", async () => {
    const urls: string[] = []
    const fetchSpy = vi.spyOn(globalThis, 'fetch').mockImplementation(async (input) => {
      urls.push(String(input instanceof Request ? input.url : input))
      throw new TypeError('fetch failed')
    })
    h.packaged = true
    process.env.GOOGLE_GEMINI_BASE_URL = `${mock.url}/gemini`
    try {
      await geminiClient('AIza-packaged-key', 'gemini-x', 'gemini-x')
        .test(new AbortController().signal)
        .catch(() => undefined)
    } finally {
      h.packaged = false
      delete process.env.GOOGLE_GEMINI_BASE_URL
      fetchSpy.mockRestore()
    }
    expect(urls.length).toBeGreaterThan(0)
    for (const u of urls) expect(u.startsWith('https://generativelanguage.googleapis.com/')).toBe(true)
  }, 30_000)
})

describe('request failures', () => {
  const hang = (s: AbortSignal): Promise<never> => new Promise((_, reject) => s.addEventListener('abort', () => reject(new Error('aborted')), { once: true }))

  it("report the caller's time limit as a time-out, not as cancelled", async () => {
    const o = { provider: 'OpenAI', toFailure: () => ({ network: true }), timeoutMs: 10_000, attempts: 2 }
    // During an attempt...
    expect(await failure(callWithRetry(hang, { ...o, signal: AbortSignal.timeout(100) }))).toMatch(/OpenAI took too long to answer/)
    // ...and during the wait before the next one.
    expect(await failure(callWithRetry(() => Promise.reject(new Error('down')), { ...o, signal: AbortSignal.timeout(100) }))).toMatch(/OpenAI took too long to answer/)
    // A real cancel stays a cancel.
    const c = new AbortController()
    setTimeout(() => c.abort(), 50)
    expect(await failure(callWithRetry(hang, { ...o, signal: c.signal }))).toBe('Cancelled.')
  })

  it('reads an SSE error event (after HTTP 200, no status) from Claude as the status it stands for', () => {
    const body = { type: 'error', error: { type: 'overloaded_error', message: 'Overloaded' } }
    const info = anthropicFailure(new Anthropic.APIError(undefined, body, undefined, new Headers(), 'overloaded_error'))
    expect(info).toMatchObject({ status: 529, code: 'overloaded_error', message: 'Overloaded' })
  })

  it("reads Gemini's per-minute rate limit as retryable after its RetryInfo delay, and the per-day one as quota", () => {
    const body = (quotaId: string): string =>
      JSON.stringify({
        error: {
          code: 429,
          message: 'You exceeded your current quota, please check your plan and billing details.',
          status: 'RESOURCE_EXHAUSTED',
          details: [
            { '@type': 'type.googleapis.com/google.rpc.QuotaFailure', violations: [{ quotaId }] },
            { '@type': 'type.googleapis.com/google.rpc.RetryInfo', retryDelay: '17s' }
          ]
        }
      })
    const minute = geminiFailure(new ApiError({ message: body('GenerateRequestsPerMinutePerProjectPerModel-FreeTier'), status: 429 }))
    expect(minute).toMatchObject({ status: 429, retryAfter: 17 })
    expect(minute.code).toContain('PerMinute')
    expect(geminiFailure(new ApiError({ message: body('GenerateRequestsPerDayPerProjectPerModel-FreeTier'), status: 429 })).code).toContain('PerDay')
  })
})

describe('providers over IPC', () => {
  it('only answers the app page', async () => {
    const evil = { ...appEvent, senderFrame: { url: 'https://example.com/' } }
    expect(() => h.handlers.get('ai:listProviders')!(evil)).toThrow('Not allowed')
  })

  it('stores providers with their keys encrypted; the renderer sees masked keys only', async () => {
    // No transcription model chosen: the suggested whisper-1 (until the list moves it), word times from the provider.
    await add('OpenAI', 'openai', 'sk-good-openai-key-0001')
    await add('Gemini', 'gemini', 'AIza-good-gemini-key-0002')
    await add('Claude', 'anthropic', 'sk-ant-good-claude-key-0003')
    const list = await call<AiProviderInfo[]>('ai:listProviders')
    expect(list.map((p) => [p.label, p.maskedKey, p.canTranscribe])).toEqual([
      ['OpenAI', '…0001', true],
      ['Gemini', '…0002', true],
      ['Claude', '…0003', false]
    ])
    const disk = readFileSync(path.join(h.root, 'userData', 'ai-providers.json'), 'utf8')
    for (const key of ['sk-good-openai-key-0001', 'AIza-good-gemini-key-0002', 'sk-ant-good-claude-key-0003']) {
      expect(disk).not.toContain(key)
      expect(JSON.stringify(list)).not.toContain(key)
    }
  })

  it('tests keys with a tiny request, saying clearly what is wrong', async () => {
    for (const name of ['OpenAI', 'Gemini', 'Claude']) expect(await call('ai:testProvider', providers[name].id)).toMatchObject({ ok: true })
    const bad = await Promise.all([add('Bad OpenAI', 'openai', 'bad-openai-key-1'), add('Bad Gemini', 'gemini', 'bad-gemini-key-1'), add('Bad Claude', 'anthropic', 'bad-claude-key-1')])
    for (const p of bad) {
      const r = await call<{ ok: boolean; message: string }>('ai:testProvider', p.id)
      expect(r.ok).toBe(false)
      expect(r.message).toMatch(/did not accept the API key/)
      expect(r.message).not.toContain('bad-')
    }
    const quota = await add('Broke OpenAI', 'openai', 'quota-openai-key-1')
    expect((await call<{ message: string }>('ai:testProvider', quota.id)).message).toMatch(/no credits or quota left/)
    // Each key went to its own provider only.
    for (const r of mock.requests) {
      if (r.provider === 'openai') expect(r.key).toMatch(/openai/)
      if (r.provider === 'gemini' && r.key) expect(r.key).toMatch(/gemini/)
      if (r.provider === 'anthropic') expect(r.key).toMatch(/claude/)
    }
  })
})

describe('transcription', () => {
  it('transcribes with OpenAI in parts cut in pauses, with word timings, in source seconds', async () => {
    const progress: TranscribeProgress[] = []
    appEvent.sender.send = vi.fn((_c: string, p: TranscribeProgress) => progress.push(p))
    const before = mock.requests.length
    const t = await call<Transcript>('ai:transcribe', 'rec-words', { providerId: providers.OpenAI.id })
    expectWords(t)
    expect(t).toMatchObject({ provider: 'openai', model: 'whisper-1', language: 'en' })
    expect(t.segments[3].words?.map((w) => w.text)).toEqual(['Word', '3'])
    const sent = mock.requests.slice(before).filter((r) => r.route === '/audio/transcriptions')
    expect(sent.length).toBe(3)
    expect(sent[0].fields).toMatchObject({ model: 'whisper-1', response_format: 'verbose_json', 'timestamp_granularities[]': ['segment', 'word'] })
    expect(sent[0].fields.file).toMatch(/bytes audio\/mpeg/)
    expect(progress.map((p) => `${p.phase} ${p.done}/${p.total}`)).toEqual(['extracting 0/1', 'transcribing 0/3', 'transcribing 1/3', 'transcribing 2/3', 'finishing 3/3'])
    expect(transcribeTemps()).toEqual([])
  }, 60_000)

  it('uses the microphone stem when there is one, and the mixed sound when asked', async () => {
    expectWords(await call<Transcript>('ai:transcribe', 'rec-stems', { providerId: providers.OpenAI.id, source: 'auto' }))
    expectWords(await call<Transcript>('ai:transcribe', 'rec-stems', { providerId: providers.OpenAI.id, source: 'mixed' }), STARTS.slice(0, 2))
    expect(await failure(call('ai:transcribe', 'rec-words', { providerId: providers.OpenAI.id, source: 'mic' }))).toMatch(/no separate microphone track/)
  }, 60_000)

  it('transcribes with Gemini inline and through the Files API', async () => {
    const t = await call<Transcript>('ai:transcribe', 'rec-words', { providerId: providers.Gemini.id, language: 'en' })
    expectWords(t)
    expect(t).toMatchObject({ provider: 'gemini', model: 'gemini-3.8-flash', language: 'en' })
    const sent = mock.requests.filter((r) => r.provider === 'gemini' && /generateContent/.test(r.route))
    expect(sent[sent.length - 1].json.generationConfig.responseMimeType).toBe('application/json')
    expect(sent[sent.length - 1].json.contents[0].parts[0].inlineData.mimeType).toBe('audio/mpeg')

    process.env.SSW_AI_GEMINI_INLINE_BYTES = '1000'
    try {
      const before = mock.requests.length
      expectWords(await call<Transcript>('ai:transcribe', 'rec-words', { providerId: providers.Gemini.id }))
      const routes = mock.requests.slice(before).map((r) => `${r.method} ${r.route.replace(/file\d+$/, 'fileN')}`)
      expect(routes.filter((r) => r === 'POST /upload/v1beta/files')).toHaveLength(3)
      expect(routes.filter((r) => r === 'DELETE /v1beta/files/fileN')).toHaveLength(3)
      expect([...mock.files.values()].every((f) => f.deleted)).toBe(true)
    } finally {
      delete process.env.SSW_AI_GEMINI_INLINE_BYTES
    }
  }, 60_000)

  it('transcribes with gpt-transcribe (whisper-1\'s replacement): text only, every word timed from the sound and estimated', async () => {
    const text = await add('OpenAI text', 'openai', 'sk-good-openai-key-0009', { transcriptionModel: 'gpt-transcribe' })
    expect(text.transcriptionModel).toBe('gpt-transcribe')
    const before = mock.requests.length
    const t = await call<Transcript>('ai:transcribe', 'rec-words', { providerId: text.id, language: 'en' })
    expect(t).toMatchObject({ provider: 'openai', model: 'gpt-transcribe', language: 'en' })
    expect(t.segments.map((s) => s.text)).toEqual(STARTS.map((_, k) => `Word ${k}.`))
    t.segments.forEach((s, k) => {
      expect(s.words?.every((w) => w.estimated === true)).toBe(true)
      // Spread over the burst's sound: within 0.6 s of where it is heard.
      expect(Math.abs(s.words![0].start - STARTS[k])).toBeLessThan(0.6)
      expect(Math.abs(s.words![s.words!.length - 1].end - (STARTS[k] + 1.2))).toBeLessThan(0.6)
    })
    const sent = mock.requests.slice(before).filter((r) => r.route === '/audio/transcriptions')
    expect(sent.length).toBe(3)
    expect(sent[0].fields).toMatchObject({ model: 'gpt-transcribe', response_format: 'json', 'languages[]': 'en' })
    expect(sent[0].fields).not.toHaveProperty('timestamp_granularities[]')
    expect(sent[0].fields).not.toHaveProperty('language')
    expect(transcribeTemps()).toEqual([])
  }, 60_000)

  it('labels Gemini speakers', async () => {
    const t = await call<Transcript>('ai:transcribe', 'rec-words', { providerId: providers.Gemini.id })
    expect(t.segments.map((s) => s.speaker)).toEqual(STARTS.map((_, k) => `Speaker ${k % 2 === 0 ? 1 : 2}`))
    const sent = mock.requests.filter((r) => r.provider === 'gemini' && /generateContent/.test(r.route))
    expect(sent[sent.length - 1].json.generationConfig.responseJsonSchema.properties.segments.items.properties.speaker.type).toBe('string')
  }, 60_000)

  it('says plainly what to do when a retired model fails, from its day on', async () => {
    const old = await add('Retired OpenAI', 'openai', 'retired-openai-key-1', { transcriptionModel: 'whisper-1' })
    process.env.SSW_AI_TODAY = '2027-02-25'
    try {
      expect(await failure(call('ai:transcribe', 'rec-words', { providerId: old.id }))).toMatch(/does not know the model “whisper-1”/)
      process.env.SSW_AI_TODAY = '2027-02-26'
      // The bundled list still suggests whisper-1.
      expect(await failure(call('ai:transcribe', 'rec-words', { providerId: old.id }))).toBe(
        'OpenAI retired whisper-1 on 26 February 2027. Choose another transcription model in Settings › AI providers, or make captions On this PC.'
      )
      // Near the day the downloaded list suggests gpt-transcribe (docs/design/transcription.md §2.1).
      const onTheDay = { ...BUNDLED_MODEL_LIST, updated: '2027-02-20', providers: { ...BUNDLED_MODEL_LIST.providers, openai: { ...BUNDLED_MODEL_LIST.providers.openai, transcriptionModel: 'gpt-transcribe' } } }
      expect(await refreshModelList('https://example.test/ai-models.json', async () => new Response(JSON.stringify(onTheDay)))).toBe(true)
      expect(await failure(call('ai:transcribe', 'rec-words', { providerId: old.id }))).toBe(
        'OpenAI retired whisper-1 on 26 February 2027. Choose gpt-transcribe as the transcription model in Settings › AI providers, or make captions On this PC.'
      )
      // A packaged app ignores the test date.
      expect(today()).toBe('2027-02-26')
      h.packaged = true
      try {
        expect(today()).toBe(new Date().toISOString().slice(0, 10))
      } finally {
        h.packaged = false
      }
    } finally {
      delete process.env.SSW_AI_TODAY
      resetModelList()
    }
  }, 60_000)

  it('retries rate limits and server errors', async () => {
    const flaky = await add('Flaky OpenAI', 'openai', 'flaky-openai-key-1', { transcriptionModel: 'whisper-1' })
    expectWords(await call<Transcript>('ai:transcribe', 'rec-words', { providerId: flaky.id }))
  }, 60_000)

  it('explains why Claude cannot transcribe, and reports bad keys and options', async () => {
    expect(await failure(call('ai:transcribe', 'rec-words', { providerId: providers.Claude.id }))).toMatch(/Claude API does not accept sound/)
    expect(await failure(call('ai:transcribe', 'rec-words', { providerId: providers['Bad OpenAI'].id }))).toMatch(/did not accept the API key/)
    expect(await failure(call('ai:transcribe', '../evil', { providerId: providers.OpenAI.id }))).toMatch(/Invalid project id/)
    expect(await failure(call('ai:transcribe', 'rec-words', { providerId: providers.OpenAI.id, language: 'english; drop' }))).toMatch(/language must be a code/)
    expect(await failure(call('ai:transcribe', 'rec-words', { providerId: 'ainope' }))).toMatch(/no longer exists/)
    expect(transcribeTemps()).toEqual([])
  }, 60_000)

  it('cancels: requests are aborted, ffmpeg stopped and temporary files removed', async () => {
    const slow = await add('Slow OpenAI', 'openai', 'slow-openai-key-1')
    let started!: () => void
    const transcribing = new Promise<void>((r) => (started = r))
    appEvent.sender.send = vi.fn((_c: string, p: TranscribeProgress) => p.phase === 'transcribing' && started())
    const run = call<Transcript>('ai:transcribe', 'rec-words', { providerId: slow.id })
    await transcribing
    // A second job for the same recording is refused while one runs.
    expect(await failure(call('ai:transcribe', 'rec-words', { providerId: slow.id }))).toMatch(/already being transcribed/)
    expect(transcribeTemps().length).toBe(1)
    const t0 = Date.now()
    await call('ai:cancelTranscription', 'rec-words')
    expect(await failure(run)).toBe('Cancelled.')
    expect(Date.now() - t0).toBeLessThan(5000)
    expect(transcribeTemps()).toEqual([])
    // The editor closing or the project being deleted stops it the same way (stopAnalyses calls this).
    await stopTranscription('rec-words')
  }, 60_000)

  it('a reload or navigation of the page that asked stops its job as Cancel does', async () => {
    const slow = providers['Slow OpenAI'] ?? (await add('Slow OpenAI', 'openai', 'slow-openai-key-1'))
    let started!: () => void
    const transcribing = new Promise<void>((r) => (started = r))
    appEvent.sender.send = vi.fn((_c: string, p: TranscribeProgress) => p.phase === 'transcribing' && started())
    const run = call<Transcript>('ai:transcribe', 'rec-words', { providerId: slow.id })
    await transcribing
    appEvent.sender.emit('did-navigate')
    expect(await failure(run)).toBe('Cancelled.')
    expect(transcribeTemps()).toEqual([])
    // Nothing is left listening on the page once the job has ended.
    expect(['did-navigate', 'destroyed', 'render-process-gone'].map((n) => appEvent.sender.listenerCount(n))).toEqual([0, 0, 0])
  }, 60_000)

  it('removes the temporary files at once when the app quits mid-transcription', async () => {
    const slow = providers['Slow OpenAI'] ?? (await add('Slow OpenAI', 'openai', 'slow-openai-key-1'))
    let started!: () => void
    const transcribing = new Promise<void>((r) => (started = r))
    appEvent.sender.send = vi.fn((_c: string, p: TranscribeProgress) => p.phase === 'transcribing' && started())
    const run = call<Transcript>('ai:transcribe', 'rec-words', { providerId: slow.id })
    await transcribing
    expect(transcribeTemps().length).toBe(1)
    // Nothing asynchronous runs after will-quit: the folder must be gone when the handler returns.
    h.appEvents.get('will-quit')!()
    expect(transcribeTemps()).toEqual([])
    expect(await failure(run)).toBe('Cancelled.')
  }, 60_000)

  it('sweeps temporary folders a crash left behind, but not young ones another copy of the app may use', async () => {
    const dir = mkdtempSync(path.join(h.root, 'tmp-'))
    const old = path.join(dir, 'ssw-transcribe-old')
    const young = path.join(dir, 'ssw-transcribe-young')
    const other = path.join(dir, 'unrelated-old')
    for (const d of [old, young, other]) mkdirSync(d)
    writeFileSync(path.join(old, 'sound.pcm'), 'pcm')
    const day = new Date(Date.now() - 24 * 3600_000)
    utimesSync(old, day, day)
    utimesSync(other, day, day)
    expect(await sweepTranscribeTemp(dir)).toEqual([old])
    expect(readdirSync(dir).sort()).toEqual(['ssw-transcribe-young', 'unrelated-old'])
  })
})

describe('transcription options and part arguments (On this PC)', () => {
  it('accepts a catalog model for the local provider, rejects an unknown one, ignores model for providers', () => {
    expect(validateTranscribeOptions({ providerId: 'local', model: 'whisper-base' })).toEqual({ providerId: 'local', source: 'auto', model: 'whisper-base' })
    expect(validateTranscribeOptions({ providerId: 'local' })).toEqual({ providerId: 'local', source: 'auto' })
    for (const bad of ['whisper-huge', '../ggml-base.bin', 'https://huggingface.co/x', 7]) expect(() => validateTranscribeOptions({ providerId: 'local', model: bad })).toThrow('Unknown speech model.')
    expect(validateTranscribeOptions({ providerId: 'aiabc', model: 'whisper-base', language: 'pt-BR' })).toEqual({ providerId: 'aiabc', source: 'auto', language: 'pt-BR' })
    expect(validateTranscribeOptions({ providerId: 'aiabc', model: 'anything' })).toEqual({ providerId: 'aiabc', source: 'auto' })
  })

  it('the Bangla model makes captions in Bangla only (§14)', () => {
    expect(validateTranscribeOptions({ providerId: 'local', model: 'whisper-bn-medium', language: 'bn' })).toEqual({ providerId: 'local', source: 'auto', model: 'whisper-bn-medium', language: 'bn' })
    expect(validateTranscribeOptions({ providerId: 'local', model: 'whisper-bn-medium', language: 'bn-BD' }).language).toBe('bn-BD')
    // Without a language, main uses the model's own.
    expect(validateTranscribeOptions({ providerId: 'local', model: 'whisper-bn-medium' })).toEqual({ providerId: 'local', source: 'auto', model: 'whisper-bn-medium' })
    for (const other of ['en', 'hi', 'pt-BR']) {
      expect(() => validateTranscribeOptions({ providerId: 'local', model: 'whisper-bn-medium', language: other })).toThrow('Bangla (Bengali.AI Whisper medium) makes captions in Bangla only.')
    }
    // The general models take any language, as before.
    expect(validateTranscribeOptions({ providerId: 'local', model: 'whisper-small', language: 'bn' }).language).toBe('bn')
  })

  it('writes WAV parts losslessly with the same cut as the MP3 parts, which are unchanged', () => {
    expect(wavPartArgs('in.pcm', 12.5, 600, 'part-1.wav')).toEqual([
      '-v', 'error', '-nostdin', '-y', '-f', 's16le', '-ar', '16000', '-ac', '1', '-ss', '12.500', '-t', '600.000', '-i', 'in.pcm', '-c:a', 'pcm_s16le', '-f', 'wav', 'part-1.wav'
    ])
    expect(partArgs('in.pcm', 12.5, 600, 'part-1.mp3')).toEqual([
      '-v', 'error', '-nostdin', '-y', '-f', 's16le', '-ar', '16000', '-ac', '1', '-ss', '12.500', '-t', '600.000', '-i', 'in.pcm', '-c:a', 'libmp3lame', '-b:a', '32k', 'part-1.mp3'
    ])
  })
})

describe('text tasks', () => {
  const segments = [
    { id: 't1', start: 1, end: 2.2, text: 'word zero', words: [{ text: 'word', start: 1, end: 1.6 }, { text: 'zero', start: 1.6, end: 2.2 }] },
    { id: 't2', start: 30, end: 31.2, text: 'word one' },
    { id: 't3', start: 200, end: 201, text: 'word two' }
  ]

  for (const name of ['OpenAI', 'Gemini', 'Claude']) {
    it(`runs cleanup, translation, chapters, title and summary with ${name}`, async () => {
      const id = providers[name].id
      const cleanup = await call<AiTextResult>('ai:text', id, { task: 'cleanup', segments })
      expect(cleanup).toEqual({
        task: 'cleanup',
        segments: [
          { id: 't1', start: 1, end: 2.2, text: 'Word zero.', words: [{ text: 'Word', start: 1, end: 1.6 }, { text: 'zero.', start: 1.6, end: 2.2 }] },
          { id: 't2', start: 30, end: 31.2, text: 'Word one.' },
          { id: 't3', start: 200, end: 201, text: 'Word two.' }
        ]
      })
      const translated = await call<AiTextResult>('ai:text', id, { task: 'translate', segments, targetLanguage: 'Bengali' })
      expect(translated).toEqual({ task: 'translate', segments: segments.map(({ words: _w, ...s }) => ({ ...s, text: `[Bengali] ${s.text}` })) })
      expect(await call('ai:text', id, { task: 'chapters', segments })).toEqual({ task: 'chapters', chapters: [{ t: 1, title: 'Introduction' }, { t: 30, title: 'Main part' }] })
      expect(await call('ai:text', id, { task: 'title', segments })).toEqual({ task: 'title', text: 'Mock title' })
      expect(await call('ai:text', id, { task: 'summary', segments })).toEqual({ task: 'summary', text: 'A mock summary of the recording.' })
    }, 30_000)
  }

  it('sends Claude requests with adaptive thinking, an effort, structured output and the refusal fallback', () => {
    const last = [...mock.requests].reverse().find((r) => r.provider === 'anthropic' && r.route === '/v1/messages')!
    expect(last.query).toBe('?beta=true')
    expect(last.beta).toContain('server-side-fallback-2026-07-01')
    expect(last.json).toMatchObject({ model: 'claude-opus-5-5', stream: true, thinking: { type: 'adaptive' }, fallbacks: 'default', output_config: { effort: 'low', format: { type: 'json_schema' } } })
    expect(last.headers['anthropic-version']).toBeTruthy()
    // Older models get neither adaptive thinking nor the fallback.
    const old = claudeRequest('claude-haiku-4-5', { system: 's', user: 'u', schema: {} }, 'medium')
    expect(old).not.toHaveProperty('thinking')
    expect(old).not.toHaveProperty('fallbacks')
    expect(old.output_config).toEqual({ format: { type: 'json_schema', schema: {} } })
  })

  it("joins the partial answer and the fallback model's continuation, and reports refusals", async () => {
    const fb = await add('Claude fallback', 'anthropic', 'fallback-claude-key-1')
    expect(await call('ai:text', fb.id, { task: 'title', segments })).toEqual({ task: 'title', text: 'Mock title' })
    expect(await call('ai:text', fb.id, { task: 'chapters', segments })).toEqual({ task: 'chapters', chapters: [{ t: 1, title: 'Introduction' }, { t: 30, title: 'Main part' }] })
    const content = [
      { type: 'text', text: 'ab', citations: null },
      { type: 'fallback', from: { model: 'claude-opus-5-5' }, to: { model: 'claude-opus-4-8' } },
      { type: 'text', text: 'cd', citations: null }
    ] as unknown as Parameters<typeof claudeAnswerText>[0]['content']
    expect(claudeAnswerText({ content, stop_reason: 'end_turn', stop_details: null })).toBe('abcd')
    for (const [kind, key] of [['openai', 'refuse-openai-key'], ['gemini', 'refuse-gemini-key'], ['anthropic', 'refuse-claude-key']] as const) {
      const p = await add(`Refusing ${kind}`, kind, key)
      expect(await failure(call('ai:text', p.id, { task: 'summary', segments }))).toMatch(/declined/)
    }
    expect(() => claudeAnswerText({ content: [], stop_reason: 'max_tokens', stop_details: null })).toThrow(/too long/)
  }, 30_000)

  it('retries an overloaded error that arrives mid-stream from Claude, and a per-minute rate limit from Gemini', async () => {
    for (const [name, kind, key] of [['Claude mid-stream', 'anthropic', 'midstream-claude-key-1'], ['Gemini per-minute', 'gemini', 'ratemin-gemini-key-1']] as const) {
      const p = await add(name, kind, key)
      const before = mock.requests.length
      expect(await call('ai:text', p.id, { task: 'title', segments })).toEqual({ task: 'title', text: 'Mock title' })
      expect(mock.requests.slice(before).filter((r) => r.key === key).length).toBe(2)
    }
  }, 30_000)

  it('rejects malformed requests before calling anyone', async () => {
    const before = mock.requests.length
    expect(await failure(call('ai:text', providers.OpenAI.id, { task: 'cleanup', segments: [{ id: 't1', start: 2, end: 1, text: 'x' }] }))).toMatch(/Invalid captions/)
    expect(await failure(call('ai:text', providers.OpenAI.id, { task: 'translate', segments }))).toMatch(/language to translate into/)
    expect(await failure(call('ai:text', providers.OpenAI.id, { task: 'rm', segments }))).toMatch(/Unknown AI task/)
    expect(mock.requests.length).toBe(before)
  })

  it('removes providers', async () => {
    await call('ai:removeProvider', providers['Bad OpenAI'].id)
    expect((await call<AiProviderInfo[]>('ai:listProviders')).some((p) => p.id === providers['Bad OpenAI'].id)).toBe(false)
    expect(existsSync(path.join(h.root, 'userData', 'ai-providers.json'))).toBe(true)
  })
})
