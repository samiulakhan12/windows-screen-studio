import { describe, expect, it } from 'vitest'
import type { AiProviderInfo } from '../src/shared/api/ai'
import type { SpeechModelView, SpeechState } from '../src/shared/api/speech'
import { polishAvailability, polishTranscriber } from '../src/shared/editor/polish'
import { polishHint, polishSkipText } from '../src/shared/editor/polishCopy'
import { createProject } from '../src/shared/engine/project'
import { SPEECH_MODELS, type SpeechModelId } from '../src/shared/speech/catalog'
import { CAPTIONS_SKIPPED_NO_MODEL } from '../src/shared/speech/transcriber'

/* Polish in one click makes captions on this PC (docs/design/offline-captions.md §3.8). */

const openai: AiProviderInfo = { id: 'ai1', kind: 'openai', label: 'My OpenAI', model: 'm', transcriptionModel: 'whisper-1', maskedKey: '…', createdAt: '' }
const claude: AiProviderInfo = { id: 'ai2', kind: 'anthropic', label: 'Claude', model: 'm', maskedKey: '…', createdAt: '' }

function speech(installed: SpeechModelId[] = [], available = true): SpeechState {
  return {
    engine: available ? { available: true, build: 'standard', threads: 3 } : { available: false, build: null, threads: 1, reason: 'missing' },
    detector: { available },
    models: SPEECH_MODELS.map(
      (m): SpeechModelView => ({
        id: m.id,
        tier: m.tier,
        name: m.name,
        bytes: m.bytes,
        rtf4: m.rtf4,
        ramMB: m.ramMB,
        wer: m.wer,
        partSeconds: m.partSeconds,
        license: m.license,
        status: { state: installed.includes(m.id) ? 'installed' : 'missing' },
        inUse: false,
        allowed: true
      })
    ),
    defaultModel: 'whisper-base',
    disk: { free: 1e11, used: 0 },
    memory: { total: 16e9, free: 8e9 },
    cores: 4
  }
}

describe('polishTranscriber', () => {
  it('On this PC with a downloaded model comes first, with its model', () => {
    expect(polishTranscriber([openai], speech(['whisper-base']), null)).toEqual({ providerId: 'local', model: 'whisper-base' })
    expect(polishTranscriber([], speech(['whisper-tiny']), null)).toEqual({ providerId: 'local', model: 'whisper-tiny' })
  })

  it('a key user without a model keeps their provider', () => {
    expect(polishTranscriber([claude, openai], speech(), null)).toEqual({ providerId: 'ai1' })
    expect(polishTranscriber([openai], speech(['whisper-base']), 'ai1')).toEqual({ providerId: 'ai1' })
  })

  it('a remembered On this PC that is not ready skips captions even with a key: nothing is uploaded', () => {
    expect(polishTranscriber([openai], speech(), 'local')).toEqual({ skip: 'no-model' })
  })

  it('without keys and without a model: skipped for the model, never a download', () => {
    expect(polishTranscriber([], speech(), null)).toEqual({ skip: 'no-model' })
  })

  it('the speech engine unavailable or unread: keys only, as before', () => {
    expect(polishTranscriber([openai], null, 'local')).toEqual({ providerId: 'ai1' })
    expect(polishTranscriber([openai], speech([], false), null)).toEqual({ providerId: 'ai1' })
    expect(polishTranscriber([claude], null, null)).toEqual({ skip: 'no-provider' })
  })

  it('Bengali chosen in the Captions tab and the Bangla model downloaded: On this PC with it, in Bengali (§14.4)', () => {
    const both = speech(['whisper-base', 'whisper-bn-medium'])
    expect(polishTranscriber([], both, null, 'bn')).toEqual({ providerId: 'local', model: 'whisper-bn-medium', language: 'bn' })
    expect(polishTranscriber([openai], speech(['whisper-bn-medium']), null, 'bn')).toEqual({ providerId: 'local', model: 'whisper-bn-medium', language: 'bn' })
    expect(polishTranscriber([], both, 'local', 'bn-BD')).toEqual({ providerId: 'local', model: 'whisper-bn-medium', language: 'bn' })
    // Another language or detection: the general model and no language, exactly as before.
    for (const language of ['', 'en', 'hi']) expect(polishTranscriber([], both, null, language)).toEqual({ providerId: 'local', model: 'whisper-base' })
    expect(polishTranscriber([], both, null)).toEqual({ providerId: 'local', model: 'whisper-base' })
    // The Bangla model alone never makes captions in another language: skipped for the model, or the key.
    expect(polishTranscriber([], speech(['whisper-bn-medium']), null, '')).toEqual({ skip: 'no-model' })
    expect(polishTranscriber([openai], speech(['whisper-bn-medium']), null, 'en')).toEqual({ providerId: 'ai1' })
    // Bengali without the Bangla model: as before (the general model, no language passed).
    expect(polishTranscriber([], speech(['whisper-base']), null, 'bn')).toEqual({ providerId: 'local', model: 'whisper-base' })
    // A remembered key provider still wins.
    expect(polishTranscriber([openai], both, 'ai1', 'bn')).toEqual({ providerId: 'ai1' })
  })
})

describe('the Captions row with On this PC', () => {
  const project = createProject({
    id: 'p',
    name: 'p',
    duration: 10,
    width: 1280,
    height: 720,
    hasWebcam: false,
    hasAudio: true,
    webcamOffset: 0,
    zooms: [],
    cursorValid: false,
    capture: { method: 'chromium', cursorInVideo: true, region: null }
  })
  const recorded = { samples: [], clicks: [], valid: false }
  it('is disabled with CAPTIONS_SKIPPED_NO_MODEL when On this PC is not ready', () => {
    const a = polishAvailability(project, recorded, { hasCameraFile: false, transcribers: [{ id: 'local' }], transcribing: false, localNotReady: true })
    expect(a.captions).toBe('no-model')
    expect(polishSkipText('captions', 'no-model')).toBe(CAPTIONS_SKIPPED_NO_MODEL)
    expect(polishAvailability(project, recorded, { hasCameraFile: false, transcribers: [{ id: 'local' }], transcribing: false }).captions).toBeNull()
  })

  it('says nothing is uploaded when it runs on this PC', () => {
    expect(polishHint('captions', { silenceAction: 'cut', autoZoomOn: true, provider: null, local: true })).toBe('Runs on this PC: nothing is uploaded and it costs nothing.')
    expect(polishHint('captions', { silenceAction: 'cut', autoZoomOn: true, provider: openai })).toContain('My OpenAI')
    expect(polishHint('captions', { silenceAction: 'cut', autoZoomOn: true, provider: null, local: true, bangla: true })).toBe(
      'Runs on this PC with the Bangla model: nothing is uploaded and it costs nothing.'
    )
  })
})
