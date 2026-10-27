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
  BANGLA_MODEL,
  DEFAULT_SPEECH_MODEL,
  ENGINE_VERSION,
  isBengali,
  isLanguageModel,
  isSpeechModelId,
  memoryNeedMB,
  modelUrl,
  SPEECH_MODEL_REPO,
  SPEECH_MODELS,
  SPEECH_TIER_NAMES,
  speechModel,
  speechModelBlock,
  speechThreads,
  VAD_MODEL,
  VAD_THREADS,
  type SpeechModelId
} from '../src/shared/speech/catalog'
import { localErrorCode, localErrorMessage, modelBlockReason, quickerModel, tierLabel, UNAVAILABLE_REASONS, type LocalCaptionsError } from '../src/shared/speech/errors'
import { COMPAT_FACTOR, estimateSeconds, THREAD_SPEED, threadFactor, WINDOWS_FACTOR } from '../src/shared/speech/estimate'
import { SIDECAR } from '../src/shared/speech/protocol'
import { canTranscribeNow, CAPTIONS_SKIPPED_NO_MODEL, localModel, localModelFor, pickTranscriber } from '../src/shared/speech/transcriber'

const ROOT = path.resolve(__dirname, '..')
const sha256 = (file: string): string => createHash('sha256').update(fs.readFileSync(file)).digest('hex')

/** The pins measured and chosen in docs/design/offline-captions.md §2. */
const PINS: Record<SpeechModelId, { file: string; bytes: number; sha256: string }> = {
  'whisper-tiny': { file: 'ggml-tiny-q8_0.bin', bytes: 43537433, sha256: 'c2085835d3f50733e2ff6e4b41ae8a2b8d8110461e18821b09a15c40c42d1cca' },
  'whisper-base': { file: 'ggml-base-q5_1.bin', bytes: 59707625, sha256: '422f1ae452ade6f30a004d7e5c6a43195e4433bc370bf23fac9cc591f01a8898' },
  'whisper-small': { file: 'ggml-small-q5_1.bin', bytes: 190085487, sha256: 'ae85e4a935d7a567bd102fe55afc16bb595bdb618e11b2fc7591bc08120411bb' },
  'whisper-turbo': { file: 'ggml-large-v3-turbo-q5_0.bin', bytes: 574041195, sha256: '394221709cd5ad1f40c46e6031ca61bce88931e6e088c188294c6d5a55ffa7e2' },
  // §14: the Bangla model, a third-party ggml conversion pinned by commit.
  'whisper-bn-medium': { file: 'ggml-bengaliai-whisper-medium-q5_0.bin', bytes: 539257671, sha256: '2c64c7f1e2c8f2417ed1fe5b78c7238933c00a2cdc2ef33e7087a95475256605' }
}

describe('the speech model catalog', () => {
  it('pins each model by file, size and SHA-256, quickest first, with base as the default', () => {
    expect(SPEECH_MODELS.map((m) => m.id)).toEqual(['whisper-tiny', 'whisper-base', 'whisper-small', 'whisper-turbo', 'whisper-bn-medium'])
    expect(SPEECH_MODELS.map((m) => m.tier)).toEqual(['fast', 'standard', 'accurate', 'best', 'bangla'])
    for (const m of SPEECH_MODELS) {
      expect({ file: m.file, bytes: m.bytes, sha256: m.sha256 }).toEqual(PINS[m.id])
      expect(m.file).toMatch(/^[A-Za-z0-9._-]+$/)
      expect(m.license.name).toBe(m.language ? 'Apache-2.0' : 'MIT')
      expect(m.partSeconds).toBeGreaterThan(0)
      expect(m.rtf4).toBeGreaterThan(0)
    }
    expect(DEFAULT_SPEECH_MODEL).toBe('whisper-base')
    expect(speechModel('whisper-turbo')?.minTotalMemGB).toBe(8)
    expect(SPEECH_MODELS.filter((m) => m.minTotalMemGB !== undefined).map((m) => m.id)).toEqual(['whisper-turbo', 'whisper-bn-medium'])
    expect(SPEECH_MODELS.filter((m) => m.needsStandardBuild).map((m) => m.id)).toEqual(['whisper-turbo', 'whisper-bn-medium'])
    // The multilingual models are the only ones without a language; none of them sets its own chunks, timestamps or repository.
    expect(SPEECH_MODELS.filter((m) => !m.language).map((m) => m.id)).toEqual(['whisper-tiny', 'whisper-base', 'whisper-small', 'whisper-turbo'])
    expect(SPEECH_MODELS.filter((m) => m.maxChunkSeconds !== undefined || m.repo !== undefined || m.noTimestamps !== undefined).map((m) => m.id)).toEqual(['whisper-bn-medium'])
  })

  it('pins the Bangla model: Bangla only, 20 s chunks, its own repository commit, Apache-2.0, gated like turbo (§14)', () => {
    const bn = speechModel(BANGLA_MODEL)!
    expect(BANGLA_MODEL).toBe('whisper-bn-medium')
    expect(bn).toMatchObject({ tier: 'bangla', name: 'Bengali.AI Whisper medium', language: 'bn', maxChunkSeconds: 20, noTimestamps: true, minTotalMemGB: 8, needsStandardBuild: true, partSeconds: 180 })
    expect(bn).toMatchObject({ rtf4: 0.87, ramMB: 1200, wer: 0.183, startMedianMs: 40 })
    expect(bn.repo).toEqual({ repo: 'winshades/bengaliai-whisper-medium-ggml', commit: '11cf5cbd282e0e46a761093939952f74906ddce1' })
    expect(bn.license).toEqual({
      name: 'Apache-2.0',
      holder: 'Bengali.AI (the tugstugi team), fine-tuned from OpenAI Whisper; converted to ggml by WinShades',
      url: 'https://huggingface.co/bengaliAI/tugstugi_bengaliai-asr_whisper-medium'
    })
    expect(modelUrl(bn)).toBe('https://huggingface.co/winshades/bengaliai-whisper-medium-ggml/resolve/11cf5cbd282e0e46a761093939952f74906ddce1/ggml-bengaliai-whisper-medium-q5_0.bin')
    // The test base replaces its repository too.
    expect(modelUrl(bn, 'http://127.0.0.1:4321/hf/')).toBe('http://127.0.0.1:4321/hf/ggml-bengaliai-whisper-medium-q5_0.bin')
    expect(memoryNeedMB(bn)).toBe(1262)
    expect(isLanguageModel(bn)).toBe(true)
    expect(SPEECH_MODELS.filter(isLanguageModel).map((m) => m.id)).toEqual([BANGLA_MODEL])
    const GiB = 2 ** 30
    expect(speechModelBlock(bn, { totalMemBytes: 7.4 * GiB, build: 'standard' })).toBeNull()
    expect(speechModelBlock(bn, { totalMemBytes: 6 * GiB, build: 'standard' })).toBe('memory')
    expect(speechModelBlock(bn, { totalMemBytes: 16 * GiB, build: 'compatible' })).toBe('processor')
    expect(modelBlockReason('memory', bn, 4 * GiB)).toBe('Needs about 1.3 GB of memory and a PC with 8 GB in all; this one has 4 GB.')
    // On a 4-core Windows PC (3 threads): about 29 min for a 20-minute recording, slower than it.
    expect(Math.round(estimateSeconds(bn, 1200, 3) / 60)).toBe(29)
  })

  it('reads a Bengali spoken language in any form', () => {
    for (const yes of ['bn', 'BN', 'bn-BD', ' bn-IN ']) expect(isBengali(yes)).toBe(true)
    for (const no of ['', 'en', 'hi', 'bng', 'b', null, undefined]) expect(isBengali(no)).toBe(false)
  })

  it('keeps Whisper large-v3 turbo off PCs with too little memory or only the compatible build', () => {
    const turbo = speechModel('whisper-turbo')!
    const GiB = 2 ** 30
    // An "8 GB" PC can report 7.4 GB usable; a 6 GB one cannot pass.
    expect(speechModelBlock(turbo, { totalMemBytes: 7.4 * GiB, build: 'standard' })).toBeNull()
    expect(speechModelBlock(turbo, { totalMemBytes: 6 * GiB, build: 'standard' })).toBe('memory')
    expect(speechModelBlock(turbo, { totalMemBytes: Number.NaN, build: 'standard' })).toBe('memory')
    expect(speechModelBlock(turbo, { totalMemBytes: 16 * GiB, build: 'compatible' })).toBe('processor')
    expect(speechModelBlock(turbo, { totalMemBytes: 16 * GiB, build: 'host' })).toBeNull()
    for (const id of ['whisper-tiny', 'whisper-base', 'whisper-small'] as const) expect(speechModelBlock(speechModel(id)!, { totalMemBytes: 2 * GiB, build: 'compatible' })).toBeNull()
    expect(modelBlockReason('memory', turbo, 4 * GiB)).toBe('Needs about 1.1 GB of memory and a PC with 8 GB in all; this one has 4 GB.')
    expect(modelBlockReason('processor', turbo, 16 * GiB)).toContain('AVX2')
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
    for (const name of ['jfk-16k.flac', 'ls-1272-128104-0000.flac', 'bn-fleurs-blog-18s.flac', 'bn-fleurs-blog-18s.txt']) expect(readme).toContain(sha256(path.join(dir, name)))
  })
})

describe('frozen constants of the protocol, the speech detector and the estimates', () => {
  it('keeps the values the design gives', () => {
    expect(SIDECAR).toEqual({ lineMax: 1048576, totalMax: 67108864, exit: { ok: 0, error: 1, cancelled: 2 }, vadFrame: 0.032, maxChunk: 29, previewChars: 120, heartbeat: 15, detectMinSpeech: 10 })
    expect(VAD).toEqual({ threshold: 0.5, negThreshold: 0.35, minSpeech: 0.25, minSilence: 0.1, pad: 0.03, frame: 0.032 })
    expect(VOICE).toEqual({ tail: 0.3, lead: 0.1 })
    expect(VAD_TRUST).toEqual({ minSpeech: 2.0, minSound: 10.0 })
    expect(THREAD_SPEED).toEqual({ 1: 3.21, 2: 1.78, 3: 1.27, 4: 1.0 })
    expect(WINDOWS_FACTOR).toBe(1.3)
    expect(COMPAT_FACTOR).toBe(4.3)
  })

  it('levels without speech ranges are valid as before', () => {
    const levels: AudioLevels = { window: 0.05, power: new Float32Array(4) }
    expect(levels.speech).toBeUndefined()
  })
})

describe('time estimates', () => {
  it('scales by threads as measured, and above 4 threads by (4 / n) ^ 0.7, never below 0.6', () => {
    expect([1, 2, 3, 4].map(threadFactor)).toEqual([3.21, 1.78, 1.27, 1.0])
    expect(threadFactor(8)).toBeCloseTo(0.6156, 3)
    expect(threadFactor(32)).toBe(0.6)
    expect(threadFactor(0)).toBe(3.21)
    expect(threadFactor(Number.NaN)).toBe(3.21)
    expect(threadFactor(3.9)).toBe(1.27)
  })

  it('gives the design table for 20 minutes on a 4-core PC (3 threads), and slower on the compatible build', () => {
    const minutes = (id: SpeechModelId, build?: 'standard' | 'compatible'): number => estimateSeconds(speechModel(id)!, 1200, 3, null, build) / 60
    expect(minutes('whisper-tiny')).toBeCloseTo(1.39, 1)
    expect(minutes('whisper-base')).toBeCloseTo(2.61, 1)
    expect(minutes('whisper-small')).toBeCloseTo(9.67, 1)
    expect(minutes('whisper-turbo')).toBeCloseTo(37.56, 1)
    expect(minutes('whisper-base', 'compatible')).toBeCloseTo(2.61 * 4.3, 1)
    expect(minutes('whisper-base', 'standard')).toBeCloseTo(2.61, 1)
  })

  it("uses this PC's measured speed once known (it already includes the build and Windows)", () => {
    const base = speechModel('whisper-base')!
    expect(estimateSeconds(base, 1000, 3, { rtf: 0.2, threads: 3 }, 'compatible')).toBeCloseTo(200, 6)
    expect(estimateSeconds(base, 1000, 4, { rtf: 0.2, threads: 2 })).toBeCloseTo((1000 * 0.2 * 1.0) / 1.78, 6)
    expect(estimateSeconds(base, 1000, 3, { rtf: Number.NaN, threads: 3 })).toBeCloseTo(1000 * 0.079 * 1.27 * 1.3, 6)
  })
})

describe('the shared error sentences of captions on this PC', () => {
  const codes: LocalCaptionsError[] = ['unavailable', 'no-model', 'damaged', 'crashed', 'memory', 'stalled', 'protocol', 'language', 'blocked', 'outdated']

  it('name the tier first and the model once', () => {
    expect(SPEECH_TIER_NAMES).toEqual({ fast: 'Fast', standard: 'Standard', accurate: 'Accurate', best: 'Most accurate', bangla: 'Bangla' })
    expect(tierLabel('whisper-bn-medium')).toBe('Bangla (Bengali.AI Whisper medium)')
    // The Bangla model has no quicker tier (the others get most Bangla words wrong); turbo's is still small.
    expect(quickerModel('whisper-bn-medium')).toBeNull()
    expect(quickerModel('whisper-turbo')?.id).toBe('whisper-small')
    expect(localErrorMessage('memory', { model: 'whisper-bn-medium' })).toBe('This PC ran out of memory for Bangla (Bengali.AI Whisper medium). Close other apps and try again.')
    expect(localErrorCode(localErrorMessage('no-model', { model: 'whisper-bn-medium' }))).toBe('no-model')
    expect(localErrorCode(localErrorMessage('blocked', { model: 'whisper-bn-medium', block: 'processor' }))).toBe('blocked')
    expect(tierLabel('whisper-small')).toBe('Accurate (Whisper small)')
    expect(localErrorMessage('memory', { model: 'whisper-small' })).toBe('This PC ran out of memory for Accurate (Whisper small). Try Standard.')
    expect(localErrorMessage('memory', { model: 'whisper-tiny' })).toBe('This PC ran out of memory for Fast (Whisper tiny). Close other apps and try again.')
    expect(quickerModel('whisper-tiny')).toBeNull()
    expect(localErrorMessage('damaged', { model: 'whisper-base' })).toBe('The speech model for Standard (Whisper base) is damaged or missing, so it was not used. Download it again (60 MB).')
    expect(localErrorMessage('crashed', { part: 4, parts: 6 })).toBe('The speech engine stopped unexpectedly. The parts already done are kept: Generate captions again continues from part 4 of 6.')
    expect(localErrorMessage('unavailable', { reason: 'blocked' })).toBe(`Captions on this PC are not available here: ${UNAVAILABLE_REASONS.blocked}.`)
    // A helper that refuses the app's arguments (an older one bundled by mistake) says so, never "something unexpected".
    expect(localErrorMessage('outdated', { model: 'whisper-bn-medium' })).toBe(
      'The speech engine in this copy of Flown does not match this version, so it cannot run Bangla (Bengali.AI Whisper medium). Reinstall Flown to fix it.'
    )
    for (const code of codes) {
      for (const m of SPEECH_MODELS) {
        const text = localErrorMessage(code, { model: m.id })
        if (text.includes('Whisper')) expect(text).toContain(tierLabel(m.id))
      }
    }
  })

  it('round-trip through an Electron invoke rejection, and nothing else maps to a code', () => {
    const samples: [LocalCaptionsError, Parameters<typeof localErrorMessage>[1]][] = [
      ['unavailable', { reason: 'missing' }],
      ['unavailable', {}],
      ['no-model', { model: 'whisper-tiny' }],
      ['damaged', { model: 'whisper-turbo' }],
      ['crashed', { part: 2, parts: 3 }],
      ['crashed', {}],
      ['memory', { model: 'whisper-small' }],
      ['memory', { model: 'whisper-tiny' }],
      ['stalled', {}],
      ['protocol', {}],
      ['language', { language: 'xx' }],
      ['blocked', { model: 'whisper-turbo', block: 'processor' }],
      ['blocked', { model: 'whisper-turbo', block: 'memory' }],
      ['outdated', { model: 'whisper-bn-medium' }]
    ]
    for (const [code, params] of samples) {
      const message = localErrorMessage(code, params)
      expect(localErrorCode(message)).toBe(code)
      expect(localErrorCode(`Error invoking remote method 'ai:transcribe': Error: ${message}`)).toBe(code)
    }
    expect(new Set(codes.map((c) => localErrorMessage(c, { model: 'whisper-base' }))).size).toBe(codes.length)
    for (const other of ['This recording has no sound to transcribe.', 'Cancelled.', 'OpenAI rejected the API key.', "Error invoking remote method 'ai:transcribe': Error: The transcription was cancelled.", 'No speech was found in this recording', ''])
      expect(localErrorCode(other)).toBeNull()
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

  const state = (installed: SpeechModelId[] = [], opts: { available?: boolean; defaultModel?: SpeechModelId; blocked?: SpeechModelId[] } = {}): SpeechState => ({
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
      allowed: !opts.blocked?.includes(m.id)
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

  it('never picks the Bangla model without Bengali, even when it is the only model or named the default (§14)', () => {
    const bn = state(['whisper-bn-medium'])
    expect(localModel(bn)).toEqual({ model: 'whisper-base', installed: false })
    expect(localModel(state(['whisper-bn-medium', 'whisper-small']))).toEqual({ model: 'whisper-small', installed: true })
    // A default that names it (never written by Flown) is not used.
    expect(localModel(state(['whisper-bn-medium'], { defaultModel: 'whisper-bn-medium' }))).toEqual({ model: 'whisper-base', installed: false })
    for (const language of ['', 'en', 'hi', 'auto']) {
      expect(localModelFor(bn, language)).toEqual({ model: 'whisper-base', installed: false })
      expect(pickTranscriber([], bn, '', language)).toEqual({ kind: 'local', model: 'whisper-base', ready: false })
      expect(pickTranscriber([openai], bn, '', language)).toEqual({ kind: 'key', providerId: 'aiopen1' })
    }
    // Without a language, exactly as before.
    expect(pickTranscriber([openai], bn)).toEqual({ kind: 'key', providerId: 'aiopen1' })
  })

  it('uses the Bangla model for Bengali once it is downloaded and allowed here, else as before (§14)', () => {
    const both = state(['whisper-base', 'whisper-bn-medium'])
    expect(localModelFor(both, 'bn')).toEqual({ model: 'whisper-bn-medium', installed: true })
    expect(localModelFor(both, 'bn-BD')).toEqual({ model: 'whisper-bn-medium', installed: true })
    expect(localModelFor(both, 'en')).toEqual({ model: 'whisper-base', installed: true })
    // Bengali with the Bangla model: On this PC even when a key provider exists (an installed model, step 2).
    expect(pickTranscriber([openai], state(['whisper-bn-medium']), '', 'bn')).toEqual({ kind: 'local', model: 'whisper-bn-medium', ready: true })
    expect(canTranscribeNow(pickTranscriber([], state(['whisper-bn-medium']), '', 'bn'))).toBe(true)
    // Not downloaded, or not allowed on this PC: the general model, as before.
    expect(localModelFor(state(['whisper-base']), 'bn')).toEqual({ model: 'whisper-base', installed: true })
    expect(localModelFor(state(['whisper-base', 'whisper-bn-medium'], { blocked: ['whisper-bn-medium'] }), 'bn')).toEqual({ model: 'whisper-base', installed: true })
    expect(pickTranscriber([openai], state([]), '', 'bn')).toEqual({ kind: 'key', providerId: 'aiopen1' })
    // The remembered key provider still wins.
    expect(pickTranscriber([openai], state(['whisper-bn-medium']), 'aiopen1', 'bn')).toEqual({ kind: 'key', providerId: 'aiopen1' })
  })

  it('E-01 transcribes only what needs no consent', () => {
    expect(canTranscribeNow(pickTranscriber([], state()))).toBe(false)
    expect(canTranscribeNow(pickTranscriber([], state(['whisper-base'])))).toBe(true)
    expect(canTranscribeNow(pickTranscriber([openai], state()))).toBe(true)
    expect(canTranscribeNow(null)).toBe(false)
    expect(CAPTIONS_SKIPPED_NO_MODEL).toContain('60 MB')
  })
})
