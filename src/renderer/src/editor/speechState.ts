import { useEffect, useRef, useSyncExternalStore } from 'react'
import type { TranscribeOptions } from '../../../shared/api/ai'
import { LOCAL_TRANSCRIBER_ID, type SpeechModelView, type SpeechState } from '../../../shared/api/speech'
import { speechModel, type SpeechModelId } from '../../../shared/speech/catalog'
import { badgeTitle, readyNotice, SPEECH_COPY } from '../../../shared/speech/speechCopy'
import type { Transcript } from '../../../shared/types'
import { cancelTranscription, ipcMessage, onTranscriptionJob, transcribe, transcriptionJob } from './captionItems'
import type { EditorServices } from './context'
import { useEditor } from './context'

/*
 * Captions on this PC outside the Captions tab (docs/design/offline-captions.md §7.6): the speech
 * engine's state as the renderer knows it (loading kept apart from failure), the quality chosen
 * in the Captions tab for this app session, the "download, then make captions" intent of each
 * project, the runs made this session (for their summary), the badge on the Captions tab and the
 * notices shown while another tab is open. Module-level stores: they outlive the tab.
 */

/* ---------- the speech state ---------- */

/** Where the read of the speech state stands; 'failed' counts as unavailable (logged once per read). */
export type SpeechRead = { status: 'loading' } | { status: 'ready'; state: SpeechState } | { status: 'failed'; error: string }

let read: SpeechRead = { status: 'loading' }
let reading = false
let watching = false
const listeners = new Set<() => void>()

const emit = (): void => {
  for (const l of [...listeners]) l()
}

const setRead = (next: SpeechRead): void => {
  read = next
  emit()
}

export const speechRead = (): SpeechRead => read

export function onSpeechRead(listener: () => void): () => void {
  listeners.add(listener)
  return () => listeners.delete(listener)
}

/**
 * Reads the speech state (again after a failure, or when `force`): the first read also checks
 * which build of the helper runs here, so it can take seconds. A rejected read (no handler, an
 * error) is unavailable, and logged.
 */
export function loadSpeechState(force = false): void {
  const api = typeof window !== 'undefined' ? window.api : undefined
  if (!watching && typeof api?.onSpeechState === 'function') {
    watching = true
    api.onSpeechState((state) => setRead({ status: 'ready', state }))
  }
  if (reading || (read.status === 'ready' && !force)) return
  reading = true
  let request: Promise<SpeechState>
  try {
    if (typeof api?.getSpeechState !== 'function') throw new Error('The speech engine cannot be asked from this window')
    request = api.getSpeechState()
  } catch (err) {
    request = Promise.reject(err)
  }
  request
    .then((state) => {
      if (!state || typeof state !== 'object' || !Array.isArray(state.models)) throw new Error('The speech state could not be read')
      setRead({ status: 'ready', state })
    })
    .catch((err: unknown) => {
      console.warn('Captions on this PC: the speech state could not be read, so only AI providers are offered:', err)
      if (read.status !== 'ready') setRead({ status: 'failed', error: ipcMessage(err) })
    })
    .finally(() => {
      reading = false
    })
}

/** The speech state, read once per app session (and again after a failed read when a tab asks). */
export function useSpeechState(): SpeechRead {
  const now = useSyncExternalStore(onSpeechRead, speechRead)
  useEffect(() => loadSpeechState(), [])
  return now
}

/** The engine's state when it was read and can run here; null while loading, after a failed read or when unavailable. */
export const availableState = (r: SpeechRead): SpeechState | null => (r.status === 'ready' && r.state.engine.available ? r.state : null)

/** The view of model `id`. */
export const modelView = (state: SpeechState, id: SpeechModelId): SpeechModelView | null => state.models.find((m) => m.id === id) ?? null

/* ---------- the quality chosen for this session ---------- */

let sessionModel: SpeechModelId | null = null

/** The model of the Captions tab's quality chips: the session's choice, else the default model. Never changes the default. */
export const chosenModel = (state: Pick<SpeechState, 'defaultModel'>): SpeechModelId => sessionModel ?? state.defaultModel

export function chooseModel(id: SpeechModelId): void {
  if (!speechModel(id)) return
  sessionModel = id
  emit()
}

/* ---------- editors that are open ---------- */

interface Host {
  services: EditorServices
  notice: (message: string) => void
  captionsOpen: () => boolean
}

const hosts = new Map<string, Host>()

/* ---------- download, then captions ---------- */

interface Intent {
  model: SpeechModelId
  options: TranscribeOptions
}

const intents = new Map<string, Intent>()

/** The pending "then make captions" of project `projectId`, or null. */
export const captionsIntent = (projectId: string): Intent | null => intents.get(projectId) ?? null

/** Forgets the intent (Cancel, closing the editor): the download goes on, captions do not start. */
export function dropIntent(projectId: string): void {
  if (intents.delete(projectId)) emit()
}

/**
 * Downloads `model` after the user's click on a button that named it and its size, then makes
 * it the default (the user picked that tier and agreed to its download) and makes captions with
 * `options`, only if project `projectId`'s editor is still open and the intent still pending.
 * Never starts captions for another project. A failure while another tab is open gives a notice.
 */
export async function downloadThenCaptions(projectId: string, model: SpeechModelId, options: TranscribeOptions): Promise<void> {
  intents.set(projectId, { model, options: { ...options, providerId: LOCAL_TRANSCRIBER_ID, model } })
  sessionModel = model
  emit()
  try {
    await window.api.downloadSpeechModel(model)
  } catch (err) {
    const message = ipcMessage(err)
    if (intents.get(projectId)?.model === model) {
      intents.delete(projectId)
      emit()
      const host = hosts.get(projectId)
      if (host && !host.captionsOpen() && message !== 'Cancelled.') host.notice(SPEECH_COPY.downloadFailedNotice)
    }
    if (message !== 'Cancelled.') console.warn(`The speech model ${model} could not be downloaded:`, message)
    return
  }
  try {
    await window.api.setDefaultSpeechModel(model)
  } catch (err) {
    console.warn(`The speech model ${model} could not be made the default:`, err)
  }
  const intent = intents.get(projectId)
  if (!intent || intent.model !== model) return
  intents.delete(projectId)
  emit()
  const host = hosts.get(projectId)
  if (host) void startLocalCaptions(host.services, intent.options)
}

/* ---------- runs ---------- */

/** A run made this session: what the summary says right after it. */
export interface LocalRun {
  createdAt: string
  took: number
  detected: boolean
}

const runs = new Map<string, LocalRun>()
const kept = new Map<string, { kept: number; parts: number }>()

/** The run that made `transcript` in this session, or null (the transcript stores neither detection nor time). */
export function localRun(projectId: string, transcript: Pick<Transcript, 'provider' | 'createdAt'> | undefined): LocalRun | null {
  const run = runs.get(projectId)
  return run && transcript?.provider === 'local' && transcript.createdAt === run.createdAt ? run : null
}

/** Parts kept by the last Cancel of project `projectId` (shown until the next run), or null. */
export const keptParts = (projectId: string): { kept: number; parts: number } | null => kept.get(projectId) ?? null

/**
 * Makes captions on this PC (captionItems.transcribe, one undo step). When it ends while another
 * tab is open, the editor's notice says so.
 */
export async function startLocalCaptions(services: EditorServices, options: TranscribeOptions): Promise<boolean> {
  const projectId = services.store.state.id
  kept.delete(projectId)
  const startedAt = Date.now()
  const ok = await transcribe(services, { ...options, providerId: LOCAL_TRANSCRIBER_ID })
  const host = hosts.get(projectId)
  if (ok) {
    const transcript = services.store.state.transcript
    const took = (Date.now() - startedAt) / 1000
    if (transcript) runs.set(projectId, { createdAt: transcript.createdAt, took, detected: !options.language })
    emit()
    if (host && !host.captionsOpen() && transcript) host.notice(readyNotice(transcript.segments.length, took))
  } else {
    const job = transcriptionJob()
    if (host && !host.captionsOpen() && job?.projectId === projectId && job.error) host.notice(SPEECH_COPY.jobFailedNotice)
  }
  return ok
}

/** Cancel of a job on this PC: remembers how many parts were finished, so the tab can say they are kept. */
export function cancelLocalCaptions(): void {
  const job = transcriptionJob()
  if (job?.running && job.local && job.progress && job.progress.total > 0) kept.set(job.projectId, { kept: Math.min(job.progress.done, job.progress.total), parts: job.progress.total })
  cancelTranscription()
  emit()
}

/* ---------- the Captions tab's badge ---------- */

export interface CaptionsBadge {
  phase: 'download' | 'verify' | 'job'
  title: string
}

function badgeOf(projectId: string): CaptionsBadge | null {
  const job = transcriptionJob()
  if (job?.running && job.projectId === projectId) {
    const p = job.progress
    const share = p ? (p.fraction ?? (p.total > 0 ? p.done / p.total : null)) : null
    return { phase: 'job', title: badgeTitle('job', share) }
  }
  const intent = intents.get(projectId)
  const state = read.status === 'ready' ? read.state : null
  const status = intent && state ? modelView(state, intent.model)?.status : null
  if (status?.state === 'downloading') return { phase: 'download', title: badgeTitle('download', status.total > 0 ? status.received / status.total : null) }
  if (status?.state === 'verifying' || (intent && status?.state === 'installed')) return { phase: 'verify', title: badgeTitle('verify', null) }
  return null
}

let badgeKey = ''
let badgeValue: CaptionsBadge | null = null

/**
 * For the editor (Inspector): registers the open editor of `projectId` (captions may start for it,
 * notices go to `onNotice` while `captionsOpen` is false), drops its intent when it closes, and
 * returns the badge of its captions download or job.
 */
export function useCaptionsHost(projectId: string, onNotice: (message: string) => void, captionsOpen: boolean): CaptionsBadge | null {
  const services = useEditor()
  const latest = useRef({ onNotice, captionsOpen })
  latest.current = { onNotice, captionsOpen }
  useEffect(() => {
    hosts.set(projectId, { services, notice: (m) => latest.current.onNotice(m), captionsOpen: () => latest.current.captionsOpen })
    loadSpeechState()
    return () => {
      if (hosts.get(projectId)?.services === services) hosts.delete(projectId)
      // Closing the editor drops the intent: nothing would stop a job started then.
      dropIntent(projectId)
    }
  }, [projectId, services])
  const get = (): CaptionsBadge | null => {
    const next = badgeOf(projectId)
    const key = next ? `${projectId}:${next.phase}:${next.title}` : ''
    if (key !== badgeKey) {
      badgeKey = key
      badgeValue = next
    }
    return badgeValue
  }
  return useSyncExternalStore(onBadge, get)
}

function onBadge(listener: () => void): () => void {
  const a = onSpeechRead(listener)
  const b = onTranscriptionJob(listener)
  return () => {
    a()
    b()
  }
}
