import { autoStyleOnFirstCaptions, captionFrame } from '../../../shared/captions/autoStyle'
import { MAX_CAPTIONS, readTranscript } from '../../../shared/captions/captionData'
import { readWordList, type WordListEntry } from '../../../shared/captions/cleanup'
import { captionAlpha } from '../../../shared/captions/layout'
import { captionsOf } from '../../../shared/captions/settings'
import type { TranscribeOptions, TranscribeProgress } from '../../../shared/api/ai'
import { LOCAL_TRANSCRIBER_ID } from '../../../shared/api/speech'
import { planOf, videoTimeAt } from '../../../shared/engine/freeze'
import { formatTime } from '../../../shared/engine/project'
import { playableFrom } from '../../../shared/engine/timeline'
import type { CaptionSegment, Clip, Project, Transcript } from '../../../shared/types'
import type { EditorServices } from './context'
import { loadBrandLook } from './greatRun'
import type { PreviewPlayer } from './player'

/*
 * Captions outside the Captions tab: what the commands and the caption track ask the tab to do,
 * the transcription job (it goes on while another tab is open), and showing a caption on the preview.
 */

/* ---------- requests to the Captions tab ---------- */

/**
 * 'generate' and 'export' from the commands; `focus` a caption's text (a double-click on the
 * track); 'language' and 'cleanup' open Captions Studio's Languages › Add a language and Clean up
 * (docs/design/captions-studio.md §2.14).
 */
export type CaptionsRequest =
  | { kind: 'generate' }
  | { kind: 'export' }
  | { kind: 'focus'; id: string }
  | { kind: 'language'; via: 'ai' | 'local' }
  | { kind: 'cleanup'; ai: true }

let pending: CaptionsRequest | null = null
const requestListeners = new Set<() => void>()

/** A request for the Languages or Clean up section, kept until that section takes it (it may be mounting). */
type SectionRequest = Extract<CaptionsRequest, { kind: 'language' | 'cleanup' }>
let sectionPending: SectionRequest | null = null
const sectionListeners = new Set<() => void>()

/** Asks the Captions tab to act (it may be opening: it takes the request once mounted). */
export function requestCaptions(request: CaptionsRequest): void {
  pending = request
  if (request.kind === 'language' || request.kind === 'cleanup') {
    sectionPending = request
    for (const l of [...sectionListeners]) l()
  }
  for (const l of [...requestListeners]) l()
}

/** The Languages or Clean up request waiting for section `kind`, taken (null when there is none). */
export function takeSectionRequest<K extends SectionRequest['kind']>(kind: K): Extract<SectionRequest, { kind: K }> | null {
  const r = sectionPending
  if (!r || r.kind !== kind) return null
  sectionPending = null
  return r as Extract<SectionRequest, { kind: K }>
}

export function onSectionRequest(listener: () => void): () => void {
  sectionListeners.add(listener)
  return () => sectionListeners.delete(listener)
}

/** The request waiting for the tab, taken (null when there is none). */
export function takeCaptionsRequest(): CaptionsRequest | null {
  const r = pending
  pending = null
  return r
}

/** The request waiting for the tab, left there (Captions Studio: the Languages and Clean up sections take theirs). */
export function peekCaptionsRequest(): CaptionsRequest | null {
  return pending
}

export function onCaptionsRequest(listener: () => void): () => void {
  requestListeners.add(listener)
  return () => requestListeners.delete(listener)
}

/* ---------- the caption word list (prefs captionWordList, Captions Studio §2.9) ---------- */

/** The word list as last read or saved: Clean up shows it, and every transcription gets its terms as a spelling hint (§11.7 rule 4). */
let wordList: readonly WordListEntry[] = []
let wordListRead: Promise<readonly WordListEntry[]> | null = null
const wordListListeners = new Set<() => void>()

const setWordList = (next: readonly WordListEntry[]): void => {
  wordList = next
  for (const l of [...wordListListeners]) l()
}

/** The word list, read from the prefs once (empty when it cannot be read). */
export function loadWordList(): Promise<readonly WordListEntry[]> {
  wordListRead ??= (async () => {
    try {
      setWordList(readWordList(await window.api.getPref('captionWordList')))
    } catch {
      // Unreadable: an empty list, read again next time.
      wordListRead = null
    }
    return wordList
  })()
  return wordListRead
}

export const currentWordList = (): readonly WordListEntry[] => wordList

export function onWordList(listener: () => void): () => void {
  wordListListeners.add(listener)
  return () => wordListListeners.delete(listener)
}

/** Saves the word list (read back through readWordList, so what is kept is what the next read gives). */
export async function saveWordList(next: readonly WordListEntry[]): Promise<void> {
  const list = readWordList(next)
  await window.api.setPref('captionWordList', list)
  wordListRead = Promise.resolve(list)
  setWordList(list)
}

// Read at start, so the first transcription already spells the user's words.
void loadWordList()

/* ---------- showing a caption ---------- */

/**
 * Moves the playhead to caption `i` where the preview shows it: its first kept moment, just past
 * its fade-in when it fades in (a caption that follows another shows at once).
 */
export function showCaption(player: PreviewPlayer, segments: readonly CaptionSegment[], i: number, clips: Clip[]): void {
  const seg = segments[i]
  if (!seg) return
  const kept = playableFrom(clips, seg.start)
  let at = kept && kept.time < seg.end ? kept.time : seg.start
  if (captionAlpha(segments, i, at, clips) < 0.99) at = Math.min(at + 0.14 * (clips[kept?.index ?? 0]?.speed ?? 1), (at + seg.end) / 2)
  player.seek(at)
}

/* ---------- transcription ---------- */

export interface TranscriptionJob {
  projectId: string
  progress: TranscribeProgress | null
  /** Set once it failed (the tab shows it until the next attempt). */
  error: string | null
  /** Set when it worked but not all of it could be kept (shown until dismissed). */
  notice?: string
  running: boolean
  /** Cancelled, waiting for the main process to stop it. */
  stopping?: boolean
  /** When the job started (Date.now()): the time left and the time it took. */
  startedAt?: number
  /** On this PC: the model and the spoken language asked for ('' = detect). */
  local?: { model: string; language: string }
}

let job: TranscriptionJob | null = null
/** Counts transcribe() calls and cancels: a call whose number is no longer current drops its result or error. */
let generation = 0
const jobListeners = new Set<() => void>()

const setJob = (next: TranscriptionJob | null): void => {
  job = next
  for (const l of [...jobListeners]) l()
}

export const transcriptionJob = (): TranscriptionJob | null => job

export function onTranscriptionJob(listener: () => void): () => void {
  jobListeners.add(listener)
  return () => jobListeners.delete(listener)
}

/** An error from the main process without Electron's "Error invoking remote method" prefix. */
export const ipcMessage = (err: unknown): string => (err instanceof Error ? err.message : String(err)).replace(/^Error invoking remote method '[^']+': (\w*Error: )?/, '')

/** The main process stopped the job (Cancel, or the editor was closed): not a failure. */
const isCancel = (message: string): boolean => message === 'Cancelled.'

/**
 * What fetchTranscript got: the transcript (`leftOut`: the provider gave more than MAX_CAPTIONS
 * captions, so the ones after its last were left out), the error the job shows, or a cancel.
 */
export type FetchedTranscript = { transcript: Transcript; leftOut: boolean } | { error: string } | { cancelled: true }

/**
 * Sends the recording's sound to the provider and reads the transcript it returns, without
 * writing it anywhere (Polish in one click commits it with its other edits). Progress and errors
 * go to the job (transcriptionJob), which the Captions tab shows; the job ends when this
 * resolves, except that an error stays on it. A cancel (cancelTranscription) resolves
 * `{ cancelled }`, also when the provider answers late. With a job already running it resolves an
 * error at once and leaves that job alone.
 */
export async function fetchTranscript(projectId: string, duration: number, options: TranscribeOptions): Promise<FetchedTranscript> {
  if (job?.running) return { error: 'A transcription is already running' }
  const mine = ++generation
  const local = options.providerId === LOCAL_TRANSCRIBER_ID ? { model: options.model ?? '', language: options.language ?? '' } : undefined
  setJob({ projectId, progress: null, error: null, running: true, startedAt: Date.now(), ...(local ? { local } : {}) })
  const off = window.api.onTranscribeProgress((progress) => {
    if (mine === generation && progress.projectId === projectId && job?.running) setJob({ ...job, progress })
  })
  // The word list's terms as a spelling hint (§11.7 rule 4); main checks and caps them.
  const glossary = options.glossary ?? wordList.map((e) => e.term)
  try {
    const raw = await window.api.transcribe(projectId, glossary.length ? { ...options, glossary } : options)
    if (mine !== generation) return { cancelled: true }
    const transcript = readTranscript(raw, duration)
    if (!transcript) throw new Error('The provider returned something that is not a transcript')
    if (!transcript.segments.length) throw new Error('No speech was found in this recording')
    const given = (raw as { segments?: unknown } | null)?.segments
    setJob(null)
    return { transcript, leftOut: Array.isArray(given) && given.length > MAX_CAPTIONS && transcript.segments.length >= MAX_CAPTIONS }
  } catch (err) {
    if (mine !== generation) return { cancelled: true }
    const message = ipcMessage(err)
    if (isCancel(message)) {
      setJob(null)
      return { cancelled: true }
    }
    setJob({ projectId, progress: null, error: message, running: false, ...(local ? { local } : {}) })
    return { error: message }
  } finally {
    off()
  }
}

/**
 * Sends the recording's sound to the provider and stores the transcript it returns in the
 * project, with captions turned on (one undo step). Progress and errors go to the job
 * (transcriptionJob), which the Captions tab shows; a cancel just drops the result.
 */
export async function transcribe({ store }: EditorServices, options: TranscribeOptions): Promise<boolean> {
  const projectId = store.state.id
  if (job?.running) return false
  const fetched = await fetchTranscript(projectId, store.state.duration, options)
  if (!('transcript' in fetched)) return false
  const { transcript } = fetched
  // The first captions get Auto style's look (Captions Studio §11.6) in the same update: one undo step, no record.
  const brand = await loadBrandLook()
  store.update((p: Project) => (p.id !== projectId ? p : autoStyleOnFirstCaptions(p, { ...p, transcript, captions: { ...captionsOf(p), show: true } }, captionFrame(p), brand)))
  // A project keeps at most MAX_CAPTIONS captions: say where the kept ones stop rather than drop the rest silently.
  if (fetched.leftOut) {
    const last = transcript.segments[transcript.segments.length - 1]
    const at = formatTime(videoTimeAt(store.state.clips, planOf(store.state), last.end), false)
    setJob({ projectId, progress: null, error: null, running: false, notice: `A project keeps at most ${MAX_CAPTIONS} captions, so the captions after ${at} were left out.` })
  }
  return true
}

/**
 * Stops the running job. Its late result or error is dropped; it shows as running (Stopping…)
 * until the main process has let go of it, so a new Generate is not refused as a second job.
 */
export function cancelTranscription(): void {
  if (!job?.running || job.stopping) return
  generation++
  const { projectId } = job
  setJob({ ...job, progress: null, stopping: true })
  void window.api
    .cancelTranscription(projectId)
    .catch(() => undefined)
    .finally(() => {
      if (job?.projectId === projectId && job.stopping) setJob(null)
    })
}

/** Forgets a failed job's error or a finished job's notice (closing it, or before another attempt). */
export function clearTranscriptionError(): void {
  if (job && !job.running) setJob(null)
}
