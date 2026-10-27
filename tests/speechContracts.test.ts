import { createHash } from 'node:crypto'
import fs from 'node:fs'
import path from 'node:path'
import { describe, expect, it } from 'vitest'
import type { AiProviderInfo } from '../src/shared/api/ai'
import { LOCAL_TRANSCRIBER_ID, SPEECH_CHANNELS, type SpeechModelStatus, type SpeechState } from '../src/shared/api/speech'
import type { AudioLevels } from '../src/shared/audio/loudness'
import { VAD } from '../src/shared/audio/vad'
import { VAD_TRUST, VOICE } from '../src/shared/audio/voice'
import { readTranscript } from '../src/shared/captions/captionData'
import {
  DEFAULT_SPEECH_MODEL,
  ENGINE_VERSION,
  isSpeechModelId,
  memoryNeedMB,
  modelUrl,
  SPEECH_MODEL_REPO,
  SPEECH_MODELS,
  speechModel,
  speechThreads,
  VAD_MODEL,
  VAD_THREADS,
  type SpeechModelId
} from '../src/shared/speech/catalog'
import { THREAD_SPEED, WINDOWS_FACTOR } from '../src/shared/speech/estimate'
import { SIDECAR } from '../src/shared/speech/protocol'
import { canTranscribeNow, CAPTIONS_SKIPPED_NO_MODEL, localModel, pickTranscriber } from '../src/shared/speech/transcriber'

const ROOT = path.resolve(__dirname, '..')
const sha256 = (file: string): string => createHash('sha256').update(fs.readFileSync(file)).digest('hex')

/** The pins measured and chosen in docs/design/offline-captions.md §2. */
const PINS: Record<SpeechModelId, { file: string; bytes: number; sha256: string }> = {
  'whisper-tiny': { file: 'ggml-tiny-q8_0.bin', bytes: 43537433, sha256: 'c2085835d3f50733e2ff6e4b41ae8a2b8d8110461e18821b09a15c40c42d1cca' },
  'whisper-base': { file: 'ggml-base-q5_1.bin', bytes: 59707625, sha256: '422f1ae452ade6f30a004d7e5c6a43195e4433bc370bf23fac9cc591f01a8898' },
  'whisper-small': { file: 'ggml-small-q5_1.bin', bytes: 190085487, sha256: 'ae85e4a935d7a567bd102fe55afc16bb595bdb618e11b2fc7591bc08120411bb' },
  'whisper-turbo': { file: 'ggml-large-v3-turbo-q5_0.bin', bytes: 574041195, sha256: '394221709cd5ad1f40c46e6031ca61bce88931e6e088c188294c6d5a55ffa7e2' }
}

describe('the speech model catalog', () => {
  it('pins each model by file, size and SHA-256, quickest first, with base as the default', () => {
    expect(SPEECH_MODELS.map((m) => m.id)).toEqual(['whisper-tiny', 'whisper-base', 'whisper-small', 'whisper-turbo'])
    expect(SPEECH_MODELS.map((m) => m.tier)).toEqual(['fast', 'standard', 'accurate', 'best'])
    for (const m of SPEECH_MODELS) {
      expect({ file: m.file, bytes: m.bytes, sha256: m.sha256 }).toEqual(PINS[m.id])
      expect(m.file).toMatch(/^[A-Za-z0-9._-]+$/)
      expect(m.license.name).toBe('MIT')
      expect(m.partSeconds).toBeGreaterThan(0)
      expect(m.rtf4).toBeGreaterThan(0)
    }
    expect(DEFAULT_SPEECH_MODEL).toBe('whisper-base')
    expect(speechModel('whisper-turbo')?.minTotalMemGB).toBe(8)
    expect(SPEECH_MODELS.filter((m) => m.minTotalMemGB !== undefined).map((m) => m.id)).toEqual(['whisper-turbo'])
  })

  it('downloads only from the pinned Hugging Face commit (or a test base)', () => {
    expect(SPEECH_MODEL_REPO.commit).toMatch(/^[0-9a-f]{40}$/)
    expect(modelUrl(speechModel('whisper-base')!)).toBe('https://huggingface.co/ggerganov/whisper.cpp/resolve/5359861c739e955e79d9a303bcbc70fb988958b1/ggml-base-q5_1.bin')
    expect(modelUrl({ file: 'ggml-tiny-q8_0.bin' }, 'http://127.0.0.1:4321/hf/')).toBe('http://127.0.0.1:4321/hf/ggml-tiny-q8_0.bin')
  })

  it('names models by catalog id only', () => {
    for (const bad of ['../x', 'C:\\models\\a.bin', 'https://example.com/a.bin', 'ggml-base-q5_1.bin', '', null, 7, {}]) {
      expect(speechModel(bad)).toBeNull()
      expect(isSpeechModelId(bad)).toBe(false)
    }
    expect(SPEECH_MODELS.every((m) => isSpeechModelId(m.id))).toBe(true)
  })

  it('leaves a core for the editor and uses one thread for the speech detector', () => {
    expect([1, 2, 4, 8, 16, Number.NaN].map(speechThreads)).toEqual([1, 1, 3, 7, 8, 1])
    expect(VAD_THREADS).toBe(1)
    expect(memoryNeedMB(speechModel('whisper-base')!)).toBe(399)
    expect(ENGINE_VERSION).toBe('ssw-speech/1')
  })

  it('ships the speech detector model it pins', () => {
    const file = path.join(ROOT, 'resources', 'speech', VAD_MODEL.file)
    expect(fs.statSync(file).size).toBe(VAD_MODEL.bytes)
    expect(sha256(file)).toBe(VAD_MODEL.sha256)
    expect(fs.readFileSync(path.join(ROOT, 'resources', 'speech', 'MODEL.md'), 'utf8')).toContain(VAD_MODEL.sha256)
  })

  it('has the committed speech fixtures with their recorded hashes', () => {
    const dir = path.join(ROOT, 'tests', 'fixtures', 'speech')
    const readme = fs.readFileSync(path.join(dir, 'README.md'), 'utf8')
    for (const name of ['jfk-16k.flac', 'ls-1272-128104-0000.flac']) expect(readme).toContain(sha256(path.join(dir, name)))
  })
})

describe('frozen constants of the protocol, the speech detector and the estimates', () => {
  it('keeps the values the design gives', () => {
    expect(SIDECAR).toEqual({ lineMax: 1048576, totalMax: 67108864, exit: { ok: 0, error: 1, cancelled: 2 }, vadFrame: 0.032, maxChunk: 29, previewChars: 120 })
    expect(VAD).toEqual({ threshold: 0.5, negThreshold: 0.35, minSpeech: 0.25, minSilence: 0.1, pad: 0.03, frame: 0.032 })
    expect(VOICE).toEqual({ tail: 0.3, lead: 0.1 })
    expect(VAD_TRUST).toEqual({ minSpeech: 2.0, minSound: 10.0 })
    expect(THREAD_SPEED).toEqual({ 1: 3.21, 2: 1.78, 3: 1.27, 4: 1.0 })
    expect(WINDOWS_FACTOR).toBe(1.3)
  })

  it('levels without speech ranges are valid as before', () => {
    const levels: AudioLevels = { window: 0.05, power: new Float32Array(4) }
    expect(levels.speech).toBeUndefined()
  })
})

describe('the IPC contract', () => {
  it('uses distinct speech: channels, all of them in the preload', () => {
    const names = Object.values(SPEECH_CHANNELS)
    expect(new Set(names).size).toBe(names.length)
    const preload = fs.readFileSync(path.join(ROOT, 'src', 'preload', 'speech.ts'), 'utf8')
    for (const name of names) {
      expect(name).toMatch(/^speech:[A-Za-z]+$/)
      expect(preload).toContain(`'${name}'`)
    }
    expect(fs.readFileSync(path.join(ROOT, 'src', 'preload', 'brand.ts'), 'utf8')).toContain("'brand:notices'")
  })

  it('reserves an id no stored provider can have (keyStore ids match /^ai[a-z0-9]{1,30}$/)', () => {
    expect(LOCAL_TRANSCRIBER_ID).toBe('local')
    expect(/^ai[a-z0-9]{1,30}$/.test(LOCAL_TRANSCRIBER_ID)).toBe(false)
    expect(fs.readFileSync(path.join(ROOT, 'src', 'main', 'ai', 'keyStore.ts'), 'utf8')).toContain('const ID_RE = /^ai[a-z0-9]{1,30}$/')
  })
})

describe('transcripts made on this PC', () => {
  const raw = { provider: 'local', model: 'whisper-base', createdAt: '2026-10-27T00:00:00Z', language: 'en', segments: [{ id: 't1', start: 1, end: 2, text: 'Hello there.', words: [{ text: 'Hello', start: 1, end: 1.4 }, { text: 'there.', start: 1.5, end: 2 }] }] }

  it('keep their provider and words', () => {
    const t = readTranscript(raw, 10)!
    expect(t.provider).toBe('local')
    expect(t.model).toBe('whisper-base')
    expect(t.segments[0].words).toHaveLength(2)
  })

  it('an unknown provider still reads as openai, as before', () => {
    expect(readTranscript({ ...raw, provider: 'somewhere' }, 10)!.provider).toBe('openai')
  })
})

describe('pickTranscriber', () => {
  const openai: AiProviderInfo = { id: 'aiopen1', kind: 'openai', label: 'My OpenAI', model: 'm', transcriptionModel: 'whisper-1', maskedKey: '…1', createdAt: '' }
  const gemini: AiProviderInfo = { id: 'aigem1', kind: 'gemini', label: 'My Gemini', model: 'm', transcriptionModel: 'g', maskedKey: '…2', createdAt: '' }
  const textOnly: AiProviderInfo = { id: 'aitext1', kind: 'anthropic', label: 'Text only', model: 'm', maskedKey: '…3', createdAt: '' }

  const state = (installed: SpeechModelId[] = [], opts: { available?: boolean; defaultModel?: SpeechModelId } = {}): SpeechState => ({
    engine: { available: opts.available ?? true, build: 'host', threads: 3 },
    detector: { available: true },
    models: SPEECH_MODELS.map((m) => ({
      id: m.id,
      tier: m.tier,
      name: m.name,
      bytes: m.bytes,
      rtf4: m.rtf4,
      ramMB: m.ramMB,
      wer: m.wer,
      partSeconds: m.partSeconds,
      license: m.license,
      status: (installed.includes(m.id) ? { state: 'installed' } : { state: 'missing' }) as SpeechModelStatus,
      inUse: false,
      allowed: true
    })),
    defaultModel: opts.defaultModel ?? DEFAULT_SPEECH_MODEL,
    disk: { free: 1e10, used: 0 },
    memory: { total: 8e9, free: 4e9 },
    cores: 4
  })

  it('prefers an installed model, then a key provider, then the download offer', () => {
    expect(pickTranscriber([openai], state(['whisper-base']))).toEqual({ kind: 'local', model: 'whisper-base', ready: true })
    expect(pickTranscriber([textOnly, openai, gemini], state())).toEqual({ kind: 'key', providerId: 'aiopen1' })
    expect(pickTranscriber([textOnly], state())).toEqual({ kind: 'local', model: 'whisper-base', ready: false })
    expect(pickTranscriber([], state())).toEqual({ kind: 'local', model: 'whisper-base', ready: false })
  })

  it('keeps the choice remembered for the session when it is still possible', () => {
    expect(pickTranscriber([openai, gemini], state(['whisper-base']), 'aigem1')).toEqual({ kind: 'key', providerId: 'aigem1' })
    expect(pickTranscriber([openai], state(), LOCAL_TRANSCRIBER_ID)).toEqual({ kind: 'local', model: 'whisper-base', ready: false })
    expect(pickTranscriber([openai], state(), 'aigone')).toEqual({ kind: 'key', providerId: 'aiopen1' })
    expect(pickTranscriber([openai], state([], { available: false }), LOCAL_TRANSCRIBER_ID)).toEqual({ kind: 'key', providerId: 'aiopen1' })
  })

  it('uses another installed model when the default one is not installed', () => {
    expect(localModel(state(['whisper-small']))).toEqual({ model: 'whisper-small', installed: true })
    expect(pickTranscriber([], state(['whisper-small', 'whisper-tiny']))).toEqual({ kind: 'local', model: 'whisper-tiny', ready: true })
    expect(localModel(state(['whisper-small'], { defaultModel: 'whisper-small' }))).toEqual({ model: 'whisper-small', installed: true })
  })

  it('without the engine or anything that can transcribe: keys only, or nothing', () => {
    expect(pickTranscriber([textOnly], state(['whisper-base'], { available: false }))).toBeNull()
    expect(pickTranscriber([openai], null)).toEqual({ kind: 'key', providerId: 'aiopen1' })
    expect(pickTranscriber(null, null)).toBeNull()
  })

  it('E-01 transcribes only what needs no consent', () => {
    expect(canTranscribeNow(pickTranscriber([], state()))).toBe(false)
    expect(canTranscribeNow(pickTranscriber([], state(['whisper-base'])))).toBe(true)
    expect(canTranscribeNow(pickTranscriber([openai], state()))).toBe(true)
    expect(canTranscribeNow(null)).toBe(false)
    expect(CAPTIONS_SKIPPED_NO_MODEL).toContain('60 MB')
  })
})
