import { beforeEach, describe, expect, it, vi } from 'vitest'
import type { AiProviderInfo } from '../src/shared/api/ai'
import { EditStore } from '../src/shared/editor/editStore'
import { createProject } from '../src/shared/engine/project'
import type { Project } from '../src/shared/types'

/*
 * Make my captions great with Better picks with AI asks the question before a paid run first
 * (docs/design/smart-tools.md §11.5), from its button and from the palette alike (both start
 * startCaptionsGreat): its cost line is in the options popover, so no click on the run's button is
 * held. Cancel sends nothing and changes nothing. The question itself (the amount, Always ask, an
 * unknown cost) is tested in costConfirm.test.ts; the runner in greatRun.test.ts.
 */

const runs = vi.hoisted(() => ({ options: [] as unknown[] }))
vi.mock('../src/renderer/src/editor/greatRun', async (importOriginal) => ({
  ...(await importOriginal<Record<string, unknown>>()),
  runCaptionsGreat: async (deps: { options: unknown }) => {
    runs.options.push(deps.options)
    return { notice: 'Captions: done' }
  }
}))
/** The question before a paid run: who and what it was asked about, and its answer. */
const question = vi.hoisted(() => ({ answer: true, asked: [] as { choice: { id: string; place: string; model: string }; request: { task: string; segments: unknown[]; marks?: unknown } }[] }))
vi.mock('../src/renderer/src/ai/costConfirm', async (importOriginal) => ({
  ...(await importOriginal<Record<string, unknown>>()),
  confirmRequest: async (choice: { id: string; place: string; model: string }, request: { task: string; segments: unknown[] }) => {
    question.asked.push({ choice, request })
    return question.answer
  }
}))

const OPENAI = { id: 'o1', kind: 'openai', label: 'OpenAI', model: 'gpt-6.1-sol', maskedKey: '…abcd', createdAt: '' } as AiProviderInfo
const prefs: Record<string, unknown> = {}
const providers: { list: AiProviderInfo[] } = { list: [OPENAI] }
vi.stubGlobal('window', {
  api: {
    getPref: async (k: string) => prefs[k] ?? null,
    setPref: async () => undefined,
    listAiProviders: async () => providers.list
  },
  addEventListener: () => undefined,
  removeEventListener: () => undefined
})

// Renderer code: imported at run time so the Node typecheck of tests/ does not follow it.
const GREAT = '../src/renderer/src/editor/captionsGreat'
const { startCaptionsGreat, captionsGreatBusy } = (await import(/* @vite-ignore */ GREAT)) as {
  startCaptionsGreat(deps: { store: EditStore<Project>; frame: { w: number; h: number }; notice: (m: string) => void }): Promise<void>
  captionsGreatBusy(): boolean
}

const project = (): Project => ({
  ...createProject({ id: 'p', name: 'p', duration: 10, width: 1080, height: 1920, hasWebcam: false, hasAudio: true, webcamOffset: 0, zooms: [], cursorValid: true, capture: { method: 'native', cursorInVideo: false, region: null } }),
  transcript: { language: 'en', segments: [{ id: 'c1', start: 0, end: 2, text: 'Make every word count today' }] } as Project['transcript']
})
const notices: string[] = []
const start = (store: EditStore<Project>): Promise<void> => startCaptionsGreat({ store, frame: { w: 1080, h: 1920 }, notice: (m) => notices.push(m) })

beforeEach(() => {
  for (const k of Object.keys(prefs)) delete prefs[k]
  providers.list = [OPENAI]
  runs.options.length = 0
  notices.length = 0
  question.answer = true
  question.asked.length = 0
})

describe('Make my captions great with AI picks asks before a paid run (smart-tools.md §11.5)', () => {
  it('Cancel: nothing is sent, nothing changes, and the button is free again', async () => {
    prefs.captionsGreat = { provider: 'o1' }
    question.answer = false
    const store = new EditStore(project())
    const before = store.state
    await start(store)
    expect(question.asked).toHaveLength(1)
    expect(question.asked[0].choice).toMatchObject({ id: 'o1', place: 'OpenAI', model: 'gpt-6.1-sol' })
    // What the options' cost line counts: the captions, with their language.
    expect(question.asked[0].request).toEqual({ task: 'marks', segments: before.transcript!.segments, marks: { language: 'en', captions: [] } })
    expect(runs.options).toEqual([])
    expect(notices).toEqual([])
    expect(store.state).toBe(before)
    expect(captionsGreatBusy()).toBe(false)
  })

  it('Run: the picks are asked for, once', async () => {
    prefs.captionsGreat = { provider: 'o1' }
    await start(new EditStore(project()))
    expect(question.asked).toHaveLength(1)
    expect(runs.options).toHaveLength(1)
    expect(runs.options[0]).toMatchObject({ provider: 'o1' })
    expect(notices).toEqual(['Captions: done'])
  })

  it('on this PC only, or with a provider no longer there, nothing is asked', async () => {
    await start(new EditStore(project()))
    prefs.captionsGreat = { provider: 'gone' }
    await start(new EditStore(project()))
    expect(question.asked).toEqual([])
    expect(runs.options).toHaveLength(2)
  })
})
