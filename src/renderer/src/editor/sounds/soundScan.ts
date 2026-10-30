/**
 * Finding unwanted sounds in the editor (docs/design/sound-finder.md §4.7): per project, where the
 * listening stands, outside the Audio panel (switching tabs does not stop it). The stored scores are
 * used when they match; the other sources are listened to at once, one worker each, their samples
 * pulled from the main process one chunk ahead of the worker. The rows are made from the scores, the
 * speech detector's ranges and the sound levels (findSounds).
 */
import type { Range } from '../../../../shared/audio/activity'
import type { AudioLevels } from '../../../../shared/audio/loudness'
import type { AudioSource } from '../../../../shared/audio/settings'
import { findSounds, scanSources, voiceSource, type SoundRow, type SourceScores } from '../../../../shared/audio/sounds'
import { cacheEntry, cacheMatches, entryScores } from '../../../../shared/audio/soundsCache'
import { SOUNDS_COPY } from '../../../../shared/audio/soundsCopy'
import { skipKey } from '../../../../shared/audio/soundsScan'
import { SOUNDS_STOPPED, type SoundsApi } from '../../../../shared/api/sounds'
import type { Project } from '../../../../shared/types'
import { loadAudioAnalysis } from '../audioAnalysis'
import type { FromWorker, ToWorker } from './protocol'

export type ScanState =
  /** Not listened to yet (or Cancel); `checking`: looking for stored scores. */
  | { status: 'idle'; checking?: boolean }
  /** `progress` 0..1; `preparing` while the levels and the speech detector are measured first. */
  | { status: 'listening'; progress: number; preparing?: boolean }
  | { status: 'done'; rows: SoundRow[]; fromCache: boolean }
  | { status: 'failed'; message: string }

type ScanProject = Pick<Project, 'id' | 'hasAudio' | 'audioStems' | 'duration'>

const IDLE: ScanState = { status: 'idle' }
const CANCELLED = 'cancelled'

/** "Error invoking remote method 'x': Error: message" -> "message". */
const ipcMessage = (err: unknown): string => (err instanceof Error ? err.message : String(err)).replace(/^Error invoking remote method '[^']+': (Error: )?/, '')

/** What a source needs to be listened to: a worker and its stream. */
export interface Listener {
  /** Resolves with the source's scores; rejects with a sentence, or CANCELLED. */
  done: Promise<{ n: number; scores: Uint8Array }>
  stop(): void
}

/** Starts a worker on one source (replaced in tests). */
export type ListenFn = (api: SoundsApi, project: ScanProject, source: AudioSource, skip: Range[] | null, onSeconds: (s: number) => void) => Promise<{ info: { size: number; mtimeMs: number }; listener: Listener }>

/** Listens to one source in a new worker, pulling its samples one chunk ahead. */
export const listenInWorker: ListenFn = async (api, project, source, skip, onSeconds) => {
  const worker = new Worker(new URL('./sounds.worker.ts', import.meta.url), { type: 'module' })
  let stream: number | null = null
  let stopped = false
  // The worker's messages, read in order by `expect`.
  const inbox: FromWorker[] = []
  let wake: (() => void) | null = null
  const deliver = (msg: FromWorker): void => {
    inbox.push(msg)
    const w = wake
    wake = null
    w?.()
  }
  worker.onmessage = (e: MessageEvent<FromWorker>) => deliver(e.data)
  worker.onerror = (e) => {
    e.preventDefault()
    deliver({ type: 'failed', reason: e.message || 'it could not start' })
  }
  const stop = (): void => {
    if (stopped) return
    stopped = true
    worker.terminate()
    if (stream !== null) void api.soundsClose(stream).catch(() => undefined)
    const w = wake
    wake = null
    w?.()
  }
  const expect = async <T extends FromWorker['type']>(type: T): Promise<Extract<FromWorker, { type: T }>> => {
    for (;;) {
      if (stopped) throw new Error(CANCELLED)
      const msg = inbox.shift()
      if (msg) {
        if (msg.type === 'failed') throw new Error(`${SOUNDS_COPY.workerFailed} ${msg.reason}`)
        if (msg.type !== type) throw new Error(`The sound finder answered ${msg.type}, not ${type}`)
        return msg as Extract<FromWorker, { type: T }>
      }
      await new Promise<void>((resolve) => (wake = resolve))
    }
  }
  const post = (msg: ToWorker, transfer: Transferable[] = []): void => worker.postMessage(msg, transfer)
  let info: { stream: number; size: number; mtimeMs: number }
  try {
    post({ type: 'start', skip })
    const opened = api.soundsOpen(project.id, source)
    await expect('ready')
    info = await opened
    stream = info.stream
    if (stopped) throw new Error(CANCELLED)
  } catch (err) {
    stop()
    throw err
  }
  const run = async (): Promise<{ n: number; scores: Uint8Array }> => {
    try {
      let pending = api.soundsRead(info.stream)
      for (;;) {
        const chunk = await pending
        if (stopped) throw new Error(CANCELLED)
        if (!chunk) break
        // The next chunk is decoded while the worker classifies this one.
        pending = api.soundsRead(info.stream)
        pending.catch(() => undefined)
        post({ type: 'chunk', samples: chunk }, [chunk])
        onSeconds((await expect('progress')).seconds)
      }
      stream = null
      post({ type: 'end' })
      const done = await expect('done')
      return { n: done.n, scores: new Uint8Array(done.scores) }
    } finally {
      stop()
    }
  }
  return { info, listener: { done: run(), stop } }
}

/* ---------- the store ---------- */

interface Entry {
  state: ScanState
  /** Bumped by Cancel and by every new start: what an older run finds afterwards is dropped. */
  epoch: number
  listeners: Listener[]
}

const entries = new Map<string, Entry>()
const subscribers = new Set<() => void>()
let version = 0

const entry = (id: string): Entry => {
  let e = entries.get(id)
  if (!e) entries.set(id, (e = { state: IDLE, epoch: 0, listeners: [] }))
  return e
}

function set(id: string, state: ScanState): void {
  entry(id).state = state
  version++
  for (const s of [...subscribers]) s()
}

export const scanState = (id: string): ScanState => entries.get(id)?.state ?? IDLE
export const scanVersion = (): number => version

export function subscribeScan(listener: () => void): () => void {
  subscribers.add(listener)
  return () => subscribers.delete(listener)
}

/** What the rows are made from besides the scores: each source's levels, and the voice's speech ranges. */
async function inputs(project: ScanProject): Promise<{ sources: AudioSource[]; levels: Partial<Record<AudioSource, AudioLevels>>; speech: Range[] | null }> {
  const sources = scanSources(project)
  const voice = voiceSource(project)
  const levels = await loadAudioAnalysis(project.id, [...new Set([...sources, voice])])
  return { sources, levels, speech: levels[voice]?.speech ?? null }
}

/** The stored scores of every source when they all match, else null. */
async function stored(api: SoundsApi, project: ScanProject, sources: readonly AudioSource[], skip: string): Promise<Map<AudioSource, SourceScores>> {
  const out = new Map<AudioSource, SourceScores>()
  for (const source of sources) {
    const e = await api.soundsCached(project.id, source).catch(() => null)
    if (e && cacheMatches(e, e, skip)) out.set(source, { source, n: e.n, scores: entryScores(e) })
  }
  return out
}

/**
 * On opening the Audio tab: shows the rows at once when every source's scores are stored (nothing is
 * listened to); otherwise stays idle. Does nothing while listening or once done.
 */
export async function checkStored(api: SoundsApi, project: ScanProject): Promise<void> {
  const e = entry(project.id)
  if (e.state.status !== 'idle' || e.state.checking) return
  const epoch = ++e.epoch
  const sources = scanSources(project)
  if (sources.length === 0) return
  set(project.id, { status: 'idle', checking: true })
  try {
    // Without stored scores for every source there is nothing to show: no need to wait for the levels and the speech detector.
    const any = await Promise.all(sources.map((source) => api.soundsCached(project.id, source).catch(() => null)))
    if (any.some((e) => !e)) {
      if (entry(project.id).epoch === epoch) set(project.id, IDLE)
      return
    }
    const { levels, speech } = await inputs(project)
    const have = await stored(api, project, sources, skipKey(speech))
    if (entry(project.id).epoch !== epoch) return
    if (have.size === sources.length) set(project.id, { status: 'done', rows: findSounds({ sources: sources.map((s) => have.get(s)!), speech, levels }), fromCache: true })
    else set(project.id, IDLE)
  } catch (err) {
    console.warn('Could not read the stored sound scores:', err)
    if (entry(project.id).epoch === epoch) set(project.id, IDLE)
  }
}

/**
 * Find unwanted sounds: stored scores where they match, the other sources listened to at once.
 * Resolves when done, failed or cancelled (the state says which).
 */
export async function startScan(api: SoundsApi, project: ScanProject, listen: ListenFn = listenInWorker): Promise<void> {
  const id = project.id
  const e = entry(id)
  if (e.state.status === 'listening') return
  const epoch = ++e.epoch
  const live = (): boolean => entry(id).epoch === epoch
  set(id, { status: 'listening', progress: 0, preparing: true })
  const listeners: Listener[] = []
  e.listeners = listeners
  try {
    const { sources, levels, speech } = await inputs(project)
    if (!live()) return
    if (sources.length === 0) throw new Error(SOUNDS_COPY.noSound)
    const skip = skipKey(speech)
    const have = await stored(api, project, sources, skip)
    const missing = sources.filter((s) => !have.has(s))
    if (live()) set(id, { status: 'listening', progress: 0 })
    const length = Math.max(1, project.duration)
    const seconds = new Map<AudioSource, number>()
    const report = (): void => {
      if (!live()) return
      const heard = missing.reduce((t, s) => t + Math.min(length, seconds.get(s) ?? 0), 0)
      set(id, { status: 'listening', progress: Math.min(0.99, heard / (length * missing.length)) })
    }
    // A failure of one source stops the other at once.
    let aborted = false
    const runs = missing.map(async (source) => {
      const { info, listener } = await listen(api, project, source, speech, (s) => {
        seconds.set(source, s)
        report()
      })
      listeners.push(listener)
      if (!live() || aborted) listener.stop()
      const { n, scores } = await listener.done
      have.set(source, { source, n, scores })
      // Kept for next time; a failure to keep it only means listening again then.
      await api.soundsSave(id, source, cacheEntry(info, skip, n, scores)).catch((err: unknown) => console.warn(`Could not keep the ${source} sound scores:`, ipcMessage(err)))
    })
    await Promise.all(runs).catch((err: unknown) => {
      aborted = true
      throw err
    })
    if (!live()) return
    set(id, { status: 'done', rows: findSounds({ sources: sources.map((s) => have.get(s)!), speech, levels }), fromCache: missing.length === 0 })
  } catch (err) {
    for (const l of listeners) l.stop()
    if (!live()) return
    const message = ipcMessage(err)
    if (message === CANCELLED || message === SOUNDS_STOPPED) set(id, IDLE)
    else {
      console.warn('Could not find unwanted sounds:', message)
      set(id, { status: 'failed', message })
    }
  }
}

/** Cancel: the workers stop, the decoding stops, nothing is kept. */
export function cancelScan(id: string): void {
  const e = entries.get(id)
  if (!e || e.state.status !== 'listening') return
  e.epoch++
  for (const l of e.listeners) l.stop()
  e.listeners = []
  set(id, IDLE)
}

