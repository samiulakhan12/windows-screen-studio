import { beforeEach, describe, expect, it, vi } from 'vitest'
import type { TranscribeProgress } from '../src/shared/api/ai'
import { MAX_CAPTIONS } from '../src/shared/captions/captionData'
import { studioPreset } from '../src/shared/captions/studioPresets'

/** What a call to the main process rejects with in the renderer (Electron puts the error's name first). */
const ipcError = (channel: string, text: string): Error => new Error(`Error invoking remote method '${channel}': ${text}`)

function deferred<T>(): { promise: Promise<T>; resolve: (v: T) => void; reject: (e: unknown) => void } {
  let resolve!: (v: T) => void
  let reject!: (e: unknown) => void
  const promise = new Promise<T>((a, b) => {
    resolve = a
    reject = b
  })
  return { promise, resolve, reject }
}

const calls = { transcribe: [] as ReturnType<typeof deferred<unknown>>[], cancel: [] as ReturnType<typeof deferred<void>>[] }
const listeners = new Set<(p: TranscribeProgress) => void>()
const progress = (p: TranscribeProgress): void => listeners.forEach((l) => l(p))
/** The brand kit main hands out (Captions Studio's caption style, §4.6). */
const kit: { captionStyle?: unknown } = {}
vi.stubGlobal('window', {
  api: {
    getBrandKit: () => Promise.resolve(kit),
    transcribe: () => {
      const d = deferred<unknown>()
      calls.transcribe.push(d)
      return d.promise
    },
    cancelTranscription: () => {
      const d = deferred<void>()
      calls.cancel.push(d)
      return d.promise
    },
    onTranscribeProgress: (l: (p: TranscribeProgress) => void) => {
      listeners.add(l)
      return () => listeners.delete(l)
    }
  }
})

interface Job {
  projectId: string
  progress: TranscribeProgress | null
  error: string | null
  notice?: string
  running: boolean
  stopping?: boolean
}
interface Items {
  requestCaptions(request: { kind: string; [k: string]: unknown }): void
  takeCaptionsRequest(): { kind: string } | null
  takeSectionRequest(kind: 'language' | 'cleanup'): { kind: string; [k: string]: unknown } | null
  onSectionRequest(listener: () => void): () => void
  ipcMessage(err: unknown): string
  transcribe(services: unknown, options: { providerId: string }): Promise<boolean>
  cancelTranscription(): void
  transcriptionJob(): Job | null
  clearTranscriptionError(): void
}
// Renderer code: imported at run time so the Node typecheck of tests/ does not follow it.
const ITEMS = '../src/renderer/src/editor/captionItems'
const items = (await import(/* @vite-ignore */ ITEMS)) as Items

const flush = (): Promise<void> => new Promise((r) => setTimeout(r, 0))
function services(): { store: { state: Record<string, unknown>; update: (fn: (p: Record<string, unknown>) => Record<string, unknown>) => void } } {
  const store = {
    state: { id: 'p1', duration: 100000, clips: [{ id: 'c', start: 0, end: 100000, speed: 1 }] } as Record<string, unknown>,
    update(fn: (p: Record<string, unknown>) => Record<string, unknown>) {
      store.state = fn(store.state)
    }
  }
  return { store }
}

beforeEach(async () => {
  // Leaves no job from the test before.
  items.clearTranscriptionError()
  if (items.transcriptionJob()?.running) {
    items.cancelTranscription()
    calls.cancel.at(-1)?.resolve()
    await flush()
  }
  calls.transcribe.length = 0
  calls.cancel.length = 0
})

describe('captionItems: errors from the main process', () => {
  it('shows the message without the error class name (CAP-5)', () => {
    expect(items.ipcMessage(ipcError('ai:transcribe', 'AiError: OpenAI did not accept the key.'))).toBe('OpenAI did not accept the key.')
    expect(items.ipcMessage(ipcError('ai:text', "AiOutputError: The AI's answer could not be used."))).toBe("The AI's answer could not be used.")
    expect(items.ipcMessage(ipcError('ai:text', 'Error: Plain.'))).toBe('Plain.')
    expect(items.ipcMessage(new Error('Not from IPC'))).toBe('Not from IPC')
  })

  it('a job the main process stopped (the editor was closed) is not a failure (W4-07, CAP-8)', async () => {
    const run = items.transcribe(services(), { providerId: 'x' })
    expect(items.transcriptionJob()?.running).toBe(true)
    calls.transcribe[0].reject(ipcError('ai:transcribe', 'AiError: Cancelled.'))
    expect(await run).toBe(false)
    expect(items.transcriptionJob()).toBeNull()
  })

  it('a real failure stays on the job', async () => {
    const run = items.transcribe(services(), { providerId: 'x' })
    calls.transcribe[0].reject(ipcError('ai:transcribe', 'AiError: The key was refused.'))
    await run
    expect(items.transcriptionJob()).toMatchObject({ running: false, error: 'The key was refused.' })
  })
})

describe('captionItems: cancelling (CAP-8)', () => {
  it('stays running until the main process has stopped; the late rejection never overwrites a newer job', async () => {
    const s = services()
    const first = items.transcribe(s, { providerId: 'x' })
    items.cancelTranscription()
    // Still running (stopping): Generate is not offered while main lets go of the job.
    expect(items.transcriptionJob()).toMatchObject({ running: true, stopping: true })
    expect(await items.transcribe(s, { providerId: 'x' })).toBe(false)
    expect(calls.transcribe).toHaveLength(1)
    // Progress of the cancelled job is ignored.
    progress({ projectId: 'p1', phase: 'transcribing', done: 0, total: 1 })
    expect(items.transcriptionJob()?.progress).toBeNull()
    calls.cancel[0].resolve()
    await flush()
    expect(items.transcriptionJob()).toBeNull()

    // A new job starts; the first call's rejection arrives late.
    const second = items.transcribe(s, { providerId: 'x' })
    calls.transcribe[0].reject(ipcError('ai:transcribe', 'AiError: Cancelled.'))
    expect(await first).toBe(false)
    expect(items.transcriptionJob()).toMatchObject({ running: true, error: null })
    progress({ projectId: 'p1', phase: 'transcribing', done: 0, total: 1 })
    expect(items.transcriptionJob()?.progress?.phase).toBe('transcribing')
    calls.transcribe[1].resolve({ provider: 'openai', model: 'm', createdAt: '', segments: [{ id: 'a', start: 0, end: 1, text: 'hi' }] })
    expect(await second).toBe(true)
    expect(items.transcriptionJob()).toBeNull()
    expect((s.store.state.transcript as { segments: unknown[] }).segments).toHaveLength(1)
  })

  it('a result that arrives after Cancel is dropped', async () => {
    const s = services()
    const run = items.transcribe(s, { providerId: 'x' })
    items.cancelTranscription()
    calls.transcribe[0].resolve({ provider: 'openai', model: 'm', createdAt: '', segments: [{ id: 'a', start: 0, end: 1, text: 'hi' }] })
    expect(await run).toBe(false)
    expect(s.store.state.transcript).toBeUndefined()
  })
})

describe('captionItems: a transcript longer than a project keeps (AI-8)', () => {
  it('stores the first MAX_CAPTIONS captions and says where they stop', async () => {
    const s = services()
    const run = items.transcribe(s, { providerId: 'x' })
    const segments = Array.from({ length: MAX_CAPTIONS + 100 }, (_, i) => ({ id: `s${i}`, start: i * 3, end: i * 3 + 2, text: `caption ${i}` }))
    calls.transcribe[0].resolve({ provider: 'openai', model: 'm', createdAt: '', segments })
    expect(await run).toBe(true)
    expect((s.store.state.transcript as { segments: unknown[] }).segments).toHaveLength(MAX_CAPTIONS)
    // The last kept caption ends at (5000 - 1) * 3 + 2 = 14999 s = 249:59.
    expect(items.transcriptionJob()).toMatchObject({ running: false, error: null, notice: expect.stringContaining('after 249:59') })
    items.clearTranscriptionError()
    expect(items.transcriptionJob()).toBeNull()
  })

  it('says nothing when everything was kept', async () => {
    const run = items.transcribe(services(), { providerId: 'x' })
    calls.transcribe[0].resolve({ provider: 'openai', model: 'm', createdAt: '', segments: [{ id: 'a', start: 0, end: 1, text: 'hi' }] })
    await run
    expect(items.transcriptionJob()).toBeNull()
  })
})

describe('captionItems: the first captions get Auto style (Captions Studio test 40, §11.6)', () => {
  const tall = (): ReturnType<typeof services> => {
    const s = services()
    s.store.state = { ...s.store.state, width: 1920, height: 1080, style: { aspectRatio: '9:16' } }
    return s
  }
  const segments = [{ id: 'a', start: 0, end: 1, text: 'hi there' }]

  it('in the same update that writes the transcript, with no record', async () => {
    const s = tall()
    let updates = 0
    const write = s.store.update
    s.store.update = (fn) => {
      updates++
      write(fn)
    }
    const run = items.transcribe(s, { providerId: 'x' })
    calls.transcribe[0].resolve({ provider: 'openai', model: 'm', createdAt: '', segments })
    expect(await run).toBe(true)
    expect(updates).toBe(1)
    expect(s.store.state.captions).toMatchObject({ show: true, studio: { from: 'clean-short' } })
    expect(s.store.state.captionAuto).toBeUndefined()
  })

  it("the brand kit's caption style wins", async () => {
    kit.captionStyle = studioPreset('bold-pop')!.look
    try {
      const s = tall()
      const run = items.transcribe(s, { providerId: 'x' })
      calls.transcribe[0].resolve({ provider: 'openai', model: 'm', createdAt: '', segments })
      await run
      expect(s.store.state.captions).toMatchObject({ studio: { from: 'brand' } })
    } finally {
      delete kit.captionStyle
    }
  })

  it('captions made again keep the look the project has', async () => {
    const s = tall()
    s.store.state = { ...s.store.state, transcript: { language: 'en', provider: 'local', model: 'm', createdAt: '', segments } }
    const run = items.transcribe(s, { providerId: 'x' })
    calls.transcribe[0].resolve({ provider: 'openai', model: 'm', createdAt: '', segments })
    await run
    expect((s.store.state.captions as { studio?: unknown }).studio).toBeUndefined()
  })
})

describe('captionItems: requests for the Languages and Clean up sections (Captions Studio §2.14, test 57)', () => {
  it('a language or clean-up request waits for its section, which takes it once', () => {
    let heard = 0
    const off = items.onSectionRequest(() => heard++)
    items.requestCaptions({ kind: 'language', via: 'ai' })
    expect(heard).toBe(1)
    // The tab opens (it takes its own request) and the Languages section takes the form's.
    expect(items.takeCaptionsRequest()).toEqual({ kind: 'language', via: 'ai' })
    expect(items.takeSectionRequest('cleanup')).toBeNull()
    expect(items.takeSectionRequest('language')).toEqual({ kind: 'language', via: 'ai' })
    expect(items.takeSectionRequest('language')).toBeNull()
    items.requestCaptions({ kind: 'cleanup', ai: true })
    expect(items.takeSectionRequest('cleanup')).toEqual({ kind: 'cleanup', ai: true })
    // Other requests are the tab's only.
    items.requestCaptions({ kind: 'generate' })
    expect(heard).toBe(2)
    expect(items.takeSectionRequest('language')).toBeNull()
    off()
    items.takeCaptionsRequest()
  })
})
