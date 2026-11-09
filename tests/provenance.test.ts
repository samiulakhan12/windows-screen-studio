import { describe, expect, it, vi } from 'vitest'
import { trackRows, withTranslation } from '../src/shared/captions/captionTracks'
import { createProject } from '../src/shared/engine/project'
import type { Project } from '../src/shared/types'

/*
 * Who made a result (docs/design/smart-tools.md §10.6, §22 test 97): a translation through a service
 * is written as OpenAI's with the service's host, and Languages says "translated with api.groq.com";
 * one made on this PC is by 'local' with the id of the model that ran (aiText's `model`), "translated
 * on this PC"; a provider's says its name. madeBy gives each tool the maker of its choice. (Find
 * chapters' and Make my captions great's own host records are tested with their tools: chapterAuto
 * and the contracts' readers.)
 */

// Read after a run, the state can name another model (the helper still holds memory, or Use changed).
vi.stubGlobal('window', { api: { localAiState: async () => ({ active: 'qwen3.5-2b' }) } })
const CHOICES = '../src/renderer/src/ai/textChoices'
const { madeBy, choiceOf } = (await import(/* @vite-ignore */ CHOICES)) as {
  madeBy: (c: unknown, ran?: string) => { by: string; model: string; host?: string }
  choiceOf: (info: unknown) => unknown
}

const SEG = { id: 's1', start: 0, end: 2, text: 'Open the report.' }
const base = (): Project => ({
  ...createProject({ id: 'p', name: 'p', duration: 10, width: 1920, height: 1080, hasWebcam: false, hasAudio: true, webcamOffset: 0, zooms: [], cursorValid: true, capture: { method: 'native', cursorInVideo: false, region: null } }),
  transcript: { language: 'en', segments: [SEG] } as Project['transcript']
})
const translate = (by: 'openai' | 'gemini' | 'local', model: string, host?: string): Project =>
  withTranslation(base(), { language: 'bn', by, model, createdAt: '2026-11-09T10:00:00.000Z', sent: [SEG], answer: [{ ...SEG, text: 'রিপোর্ট খুলুন।' }], ...(host ? { host } : {}) })!

describe('provenance (test 97)', () => {
  it("a translation through a service is OpenAI's with its host, and Languages names the host", () => {
    const p = translate('openai', 'llama-4-scout', 'api.groq.com')
    expect(p.captionTracks).toMatchObject([{ language: 'bn', by: 'openai', model: 'llama-4-scout', host: 'api.groq.com' }])
    expect(trackRows(p)[1].label).toBe('Bengali · translated with api.groq.com')
  })

  it('one made on this PC is by local with the model, "translated on this PC"; a provider says its name', () => {
    const local = translate('local', 'gemma4-e2b')
    expect(local.captionTracks).toMatchObject([{ by: 'local', model: 'gemma4-e2b' }])
    expect(local.captionTracks![0]).not.toHaveProperty('host')
    expect(trackRows(local)[1].label).toBe('Bengali · translated on this PC')
    const gemini = translate('gemini', 'gemini-3.8-flash', 'api.groq.com')
    expect(gemini.captionTracks![0]).not.toHaveProperty('host')
    expect(trackRows(gemini)[1].label).toBe('Bengali · translated with Gemini')
  })

  it("madeBy: a service's host, a provider's kind, the model that ran on this PC", async () => {
    const groq = choiceOf({ id: 'svc1', kind: 'openai', label: 'Groq', model: 'llama-4-scout', maskedKey: '', createdAt: '', service: { preset: 'groq', baseUrl: 'https://api.groq.com/openai/v1', host: 'api.groq.com', loopback: false, json: 'schema' } })
    expect(madeBy(groq)).toEqual({ by: 'openai', model: 'llama-4-scout', host: 'api.groq.com' })
    expect(madeBy(choiceOf({ id: 'ai1', kind: 'gemini', label: 'G', model: 'gemini-x', maskedKey: '', createdAt: '' }))).toEqual({ by: 'gemini', model: 'gemini-x' })
    // The model aiText says ran, never the state read again after the run.
    expect(madeBy({ id: 'local', kind: 'local', label: 'On this PC', model: '', place: 'this PC' }, 'gemma4-e2b')).toEqual({ by: 'local', model: 'gemma4-e2b' })
  })
})
