import { beforeEach, describe, expect, it, vi } from 'vitest'
import type { TranscribeProgress } from '../src/shared/api/ai'
import { MAX_CAPTIONS } from '../src/shared/captions/captionData'

/*
 * fetchTranscript (captionItems.ts): the Captions tab's transcription job without the store write,
 * which Polish in one click commits with its other edits (docs/design/polish-in-one-click.md §4.3).
 * The main process is stubbed as in tests/captionItems.test.ts.
 */

function deferred<T>(): { promise: Promise<T>; resolve: (v: T) => void; reject: (e: unknown) => void } {
  let resolve!: (v: T) => void
  let reject!: (e: unknown) => void
  const promise = new Promise<T>((a, b) => {
    resolve = a
    reject = b
  })
  return { promise, resolve, reject }
}

const calls = { transcribe: [] as ReturnType<typeof deferred<unknown>>[], cancel: [] as ReturnType<typeof deferred<void>>[], options: [] as unknown[] }
const listeners = new Set<(p: TranscribeProgress) => void>()
const progress = (p: TranscribeProgress): void => listeners.forEach((l) => l(p))
/** The caption word list in the prefs (Captions Studio §2.9), read when captionItems loads. */
const prefs: Record<string, unknown> = { captionWordList: [{ term: 'Flown', heard: ['flow in'] }, { term: 'Qbexel', heard: [] }] }
vi.stubGlobal('window', {
  api: {
    getPref: (key: string) => Promise.resolve(prefs[key] ?? null),
    setPref: (key: string, value: unknown) => {
      prefs[key] = value
      return Promise.resolve()
    },
    transcribe: (_id: string, options: unknown) => {
      const d = deferred<unknown>()
      calls.transcribe.push(d)
      calls.options.push(options)
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

type Fetched = { transcript: { segments: { text: string }[] }; leftOut: boolean } | { error: string } | { cancelled: true }
interface Items {
  fetchTranscript(projectId: string, duration: number, options: { providerId: string; glossary?: string[] }): Promise<Fetched>
  loadWordList(): Promise<readonly { term: string; heard: string[] }[]>
  saveWordList(list: readonly { term: string; heard: string[] }[]): Promise<void>
  cancelTranscription(): void
  transcriptionJob(): { running: boolean; progress: TranscribeProgress | null; error: string | null; stopping?: boolean } | null
  clearTranscriptionError(): void
}
// Renderer code: imported at run time so the Node typecheck of tests/ does not follow it.
const ITEMS = '../src/renderer/src/editor/captionItems'
const items = (await import(/* @vite-ignore */ ITEMS)) as Items

const flush = (): Promise<void> => new Promise((r) => setTimeout(r, 0))
const ipcError = (text: string): Error => new Error(`Error invoking remote method 'ai:transcribe': ${text}`)
const answer = (n: number): unknown => ({
  provider: 'openai',
  model: 'm',
  createdAt: '',
  segments: Array.from({ length: n }, (_, i) => ({ id: `s${i}`, start: i * 3, end: i * 3 + 2, text: `caption ${i}` }))
})

beforeEach(async () => {
  items.clearTranscriptionError()
  if (items.transcriptionJob()?.running) {
    items.cancelTranscription()
    calls.cancel.at(-1)?.resolve()
    await flush()
  }
  calls.transcribe.length = 0
  calls.cancel.length = 0
  calls.options.length = 0
})

describe('fetchTranscript', () => {
  it('runs the job with its progress and gives the transcript back, ending the job', async () => {
    const run = items.fetchTranscript('p1', 100, { providerId: 'x' })
    expect(items.transcriptionJob()).toMatchObject({ running: true, progress: null })
    progress({ projectId: 'p1', phase: 'transcribing', done: 1, total: 3 })
    expect(items.transcriptionJob()?.progress?.done).toBe(1)
    calls.transcribe[0].resolve(answer(2))
    const got = await run
    expect('transcript' in got && got.transcript.segments.map((s) => s.text)).toEqual(['caption 0', 'caption 1'])
    expect('transcript' in got && got.leftOut).toBe(false)
    expect(items.transcriptionJob()).toBeNull()
  })

  it('says when captions were left out over MAX_CAPTIONS', async () => {
    const run = items.fetchTranscript('p1', 100000, { providerId: 'x' })
    calls.transcribe[0].resolve(answer(MAX_CAPTIONS + 10))
    const got = await run
    expect('transcript' in got && got.transcript.segments.length).toBe(MAX_CAPTIONS)
    expect('transcript' in got && got.leftOut).toBe(true)
  })

  it('a failure is given back and stays on the job; no speech is a failure', async () => {
    const run = items.fetchTranscript('p1', 100, { providerId: 'x' })
    calls.transcribe[0].reject(ipcError('AiError: No credits or quota left.'))
    expect(await run).toEqual({ error: 'No credits or quota left.' })
    expect(items.transcriptionJob()).toMatchObject({ running: false, error: 'No credits or quota left.' })
    items.clearTranscriptionError()
    const empty = items.fetchTranscript('p1', 100, { providerId: 'x' })
    calls.transcribe[1].resolve(answer(0))
    expect(await empty).toEqual({ error: 'No speech was found in this recording' })
  })

  it('a cancel resolves cancelled, also when the answer comes late', async () => {
    const run = items.fetchTranscript('p1', 100, { providerId: 'x' })
    items.cancelTranscription()
    expect(items.transcriptionJob()).toMatchObject({ running: true, stopping: true })
    calls.transcribe[0].resolve(answer(2))
    expect(await run).toEqual({ cancelled: true })
    calls.cancel[0].resolve()
    await flush()
    expect(items.transcriptionJob()).toBeNull()
    // Stopped by the main process (the editor closed): not a failure.
    const stopped = items.fetchTranscript('p1', 100, { providerId: 'x' })
    calls.transcribe[1].reject(ipcError('AiError: Cancelled.'))
    expect(await stopped).toEqual({ cancelled: true })
    expect(items.transcriptionJob()).toBeNull()
  })

  it('leaves a job that is already running alone', async () => {
    const first = items.fetchTranscript('p1', 100, { providerId: 'x' })
    const second = await items.fetchTranscript('p1', 100, { providerId: 'x' })
    expect(second).toEqual({ error: 'A transcription is already running' })
    expect(calls.transcribe).toHaveLength(1)
    expect(items.transcriptionJob()).toMatchObject({ running: true, error: null })
    calls.transcribe[0].resolve(answer(1))
    expect('transcript' in (await first)).toBe(true)
  })
})

describe('fetchTranscript: the caption word list as a spelling hint (Captions Studio §11.7 rule 4)', () => {
  it("sends the word list's terms with every transcription", async () => {
    expect(await items.loadWordList()).toEqual([{ term: 'Flown', heard: ['flow in'] }, { term: 'Qbexel', heard: [] }])
    const run = items.fetchTranscript('p1', 100, { providerId: 'x' })
    expect(calls.options[0]).toEqual({ providerId: 'x', glossary: ['Flown', 'Qbexel'] })
    calls.transcribe[0].resolve(answer(1))
    await run
  })

  it('a saved list is used at once; an empty one sends nothing', async () => {
    await items.saveWordList([{ term: 'Flown', heard: [] }])
    expect(prefs.captionWordList).toEqual([{ term: 'Flown', heard: [] }])
    const one = items.fetchTranscript('p1', 100, { providerId: 'x' })
    calls.transcribe[0].resolve(answer(1))
    await one
    await items.saveWordList([])
    const none = items.fetchTranscript('p1', 100, { providerId: 'x' })
    calls.transcribe[1].resolve(answer(1))
    await none
    expect(calls.options).toEqual([{ providerId: 'x', glossary: ['Flown'] }, { providerId: 'x' }])
  })
})
