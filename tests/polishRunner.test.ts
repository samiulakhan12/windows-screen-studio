import { beforeEach, describe, expect, it, vi } from 'vitest'
import type { TranscribeProgress } from '../src/shared/api/ai'
import type { AudioLevels } from '../src/shared/audio/loudness'
import type { AudioSource } from '../src/shared/audio/settings'
import { sourceActivity, type AudioAnalysis } from '../src/shared/audio/soundtrack'
import { EditStore } from '../src/shared/editor/editStore'
import { DEFAULT_POLISH_OPTIONS, type PolishOptions, type PolishResult, type PolishStep } from '../src/shared/editor/polish'
import { polishSkipText } from '../src/shared/editor/polishCopy'
import { createProject } from '../src/shared/engine/project'
import type { CursorTrack, Project } from '../src/shared/types'

/*
 * The run of Polish in one click (polishRunner.ts, docs/design/polish-in-one-click.md §4.3) on a
 * recording with microphone and system stems, against a stubbed main process: the sound levels
 * (analyzeAudio) and the transcription job (transcribe, cancelTranscription and its progress, as
 * in tests/fetchTranscript.test.ts). The modules are fresh for every test (the levels and the job
 * live for the editor session).
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

const analyzeAudio = vi.fn<(id: string, sources: AudioSource[]) => Promise<AudioAnalysis>>()
const calls = { transcribe: [] as ReturnType<typeof deferred<unknown>>[], cancel: [] as { projectId: string; done: ReturnType<typeof deferred<void>> }[] }
const listeners = new Set<(p: TranscribeProgress) => void>()
const progress = (p: TranscribeProgress): void => listeners.forEach((l) => l(p))
vi.stubGlobal('window', {
  api: {
    analyzeAudio,
    transcribe: () => {
      const d = deferred<unknown>()
      calls.transcribe.push(d)
      return d.promise
    },
    cancelTranscription: (projectId: string) => {
      const done = deferred<void>()
      calls.cancel.push({ projectId, done })
      return done.promise
    },
    onTranscribeProgress: (l: (p: TranscribeProgress) => void) => {
      listeners.add(l)
      return () => listeners.delete(l)
    }
  }
})

/** sourceActivity as the runner calls it: the real one, unless a test makes it throw. */
const hooks = { sourceActivity }
vi.doMock('../src/shared/audio/soundtrack', async (importOriginal) => ({
  ...(await importOriginal<object>()),
  sourceActivity: (...args: Parameters<typeof sourceActivity>) => hooks.sourceActivity(...args)
}))

type Row = { phase: 'waiting' | 'working' | 'done' | 'skipped'; text: string; canSkip?: boolean }
type Rows = Record<PolishStep, Row>
interface Run {
  done: Promise<{ before: Project; after: Project; result: PolishResult } | null>
  cancel(): void
  skipCaptions(): void
}
interface Runner {
  runPolish(
    services: { store: EditStore<Project>; player: { webcam: null } },
    recorded: CursorTrack,
    options: PolishOptions,
    ctx: { hasCameraFile: boolean; providerId: string | null; userPresets: readonly never[] },
    onProgress: (rows: Rows) => void
  ): Run
}
interface Items {
  transcriptionJob(): { running: boolean; stopping?: boolean } | null
}
// Renderer code: imported at run time so the Node typecheck of tests/ does not follow it.
const RUNNER = '../src/renderer/src/editor/polishRunner'
const ITEMS = '../src/renderer/src/editor/captionItems'

let runner: Runner
let items: Items

beforeEach(async () => {
  vi.resetModules()
  analyzeAudio.mockReset()
  calls.transcribe.length = 0
  calls.cancel.length = 0
  listeners.clear()
  hooks.sourceActivity = sourceActivity
  runner = (await import(/* @vite-ignore */ RUNNER)) as Runner
  items = (await import(/* @vite-ignore */ ITEMS)) as Items
})

const flush = (): Promise<void> => new Promise((r) => setTimeout(r, 0))

/** 12 s, one clip, no camera, the microphone and the system sound kept apart. */
function project(): Project {
  const p = createProject({
    id: 'p1',
    name: 'p1',
    duration: 12,
    width: 1280,
    height: 720,
    hasWebcam: false,
    hasAudio: true,
    webcamOffset: 0,
    zooms: [],
    cursorValid: false,
    capture: { method: 'chromium', cursorInVideo: false, region: null }
  })
  return { ...p, audioStems: { mic: true, system: true } }
}

const NO_INPUT: CursorTrack = { samples: [], clicks: [], keys: [], valid: false }
/** Remove silences, captions and the Studio style. */
const OPTIONS: PolishOptions = { ...DEFAULT_POLISH_OPTIONS, zoom: false, director: false, styleId: 'studio' }
const CTX = { hasCameraFile: false, providerId: 'openai-1', userPresets: [] as const }
const answer = (n: number): unknown => ({
  provider: 'openai',
  model: 'm',
  createdAt: '',
  segments: Array.from({ length: n }, (_, i) => ({ id: `s${i}`, start: i * 3, end: i * 3 + 2, text: `caption ${i}` }))
})

/** Talking at 1e-3 over 0.3-3.5 and 7.5-11.9 s of 12 s, quiet otherwise. */
function talking(): AudioLevels {
  const window = 0.05
  const power = new Float32Array(Math.round(12 / window)).fill(1e-7)
  for (const [s, e] of [
    [0.3, 3.5],
    [7.5, 11.9]
  ])
    for (let i = Math.round(s / window); i < Math.round(e / window); i++) power[i] = 1e-3
  return { window, power }
}

function start(): { store: EditStore<Project>; run: Run; rows: Rows[] } {
  const store = new EditStore(project())
  const rows: Rows[] = []
  const run = runner.runPolish({ store, player: { webcam: null } }, NO_INPUT, OPTIONS, CTX, (r) => rows.push(r))
  return { store, run, rows }
}

describe('runPolish', () => {
  it('skips only Remove silences when the sound cannot be measured, and applies the rest', async () => {
    const warn = vi.spyOn(console, 'warn').mockImplementation(() => undefined)
    // One stem ffmpeg cannot decode fails the request for both (main/audioAnalysis.ts).
    analyzeAudio.mockRejectedValue(new Error('Could not read the sound of system.m4a'))
    const { store, run, rows } = start()
    const before = store.state
    await flush()
    expect(analyzeAudio).toHaveBeenCalledWith('p1', ['mic', 'system'])
    // The row says so at once, in the summary's words; the transcription goes on.
    expect(rows.at(-1)?.silences).toEqual({ phase: 'skipped', text: polishSkipText('silences', 'not-measured') })
    expect(rows.at(-1)?.captions.phase).toBe('working')
    expect(items.transcriptionJob()?.running).toBe(true)

    calls.transcribe[0].resolve(answer(2))
    const r = await run.done
    expect(r).not.toBeNull()
    const step = (s: PolishStep): unknown => r?.result.summary.steps.find((x) => x.step === s)
    expect(step('silences')).toMatchObject({ status: 'skipped', reason: 'not-measured' })
    expect(step('captions')).toMatchObject({ status: 'changed' })
    expect(step('style')).toMatchObject({ status: 'changed' })
    expect(rows.at(-1)?.silences.phase).toBe('skipped')
    expect(store.state.clips).toBe(before.clips)
    expect(store.state.transcript?.segments).toHaveLength(2)
    expect(calls.cancel).toEqual([])
    warn.mockRestore()
  })

  it('cuts the silences when the sound is measured', async () => {
    analyzeAudio.mockResolvedValue({ mic: talking(), system: talking() })
    const { store, run, rows } = start()
    await flush()
    expect(rows.at(-1)?.silences.phase).toBe('waiting')
    calls.transcribe[0].resolve(answer(2))
    const r = await run.done
    expect(r?.result.summary.steps.find((x) => x.step === 'silences')).toMatchObject({ status: 'changed' })
    expect(store.state.clips.length).toBe(2)
  })

  it('stops its transcription when it fails, and its rows no longer change', async () => {
    const err = vi.spyOn(console, 'error').mockImplementation(() => undefined)
    analyzeAudio.mockResolvedValue({ mic: talking(), system: talking() })
    hooks.sourceActivity = () => {
      throw new Error('planning broke')
    }
    const { store, run, rows } = start()
    const before = store.state
    await expect(run.done).rejects.toThrow('planning broke')
    // The job this run started is cancelled: nobody waits for its paid result any more.
    expect(calls.cancel.map((c) => c.projectId)).toEqual(['p1'])
    expect(items.transcriptionJob()).toMatchObject({ running: true, stopping: true })
    const seen = rows.length
    progress({ projectId: 'p1', phase: 'transcribing', done: 1, total: 2 })
    calls.transcribe[0].reject(new Error("Error invoking remote method 'ai:transcribe': Cancelled."))
    calls.cancel[0].done.resolve()
    await flush()
    expect(rows).toHaveLength(seen)
    expect(items.transcriptionJob()).toBeNull()
    expect(store.state).toBe(before)
    expect(store.canUndo).toBe(false)
    err.mockRestore()
  })

  it('stops its transcription when cancelled, and writes nothing', async () => {
    analyzeAudio.mockResolvedValue({ mic: talking(), system: talking() })
    const { store, run, rows } = start()
    const before = store.state
    await flush()
    run.cancel()
    await expect(run.done).resolves.toBeNull()
    expect(calls.cancel.map((c) => c.projectId)).toEqual(['p1'])
    const seen = rows.length
    calls.transcribe[0].resolve(answer(2))
    await flush()
    expect(rows).toHaveLength(seen)
    expect(store.state).toBe(before)
  })
})
