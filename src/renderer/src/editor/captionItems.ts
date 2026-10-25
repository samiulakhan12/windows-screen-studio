import { MAX_CAPTIONS, readTranscript } from '../../../shared/captions/captionData'
import { captionAlpha } from '../../../shared/captions/layout'
import { captionsOf } from '../../../shared/captions/settings'
import type { TranscribeOptions, TranscribeProgress } from '../../../shared/api/ai'
import { formatTime } from '../../../shared/engine/project'
import { playableFrom } from '../../../shared/engine/timeline'
import { viewingTime } from '../../../shared/render/overlays'
import type { CaptionSegment, Clip, Project } from '../../../shared/types'
import type { EditorServices } from './context'
import type { PreviewPlayer } from './player'

/*
 * Captions outside the Captions tab: what the commands and the caption track ask the tab to do,
 * the transcription job (it goes on while another tab is open), and showing a caption on the preview.
 */

/* ---------- requests to the Captions tab ---------- */

/** 'generate' and 'export' from the commands; `focus` a caption's text (a double-click on the track). */
export type CaptionsRequest = { kind: 'generate' } | { kind: 'export' } | { kind: 'focus'; id: string }

let pending: CaptionsRequest | null = null
const requestListeners = new Set<() => void>()

/** Asks the Captions tab to act (it may be opening: it takes the request once mounted). */
export function requestCaptions(request: CaptionsRequest): void {
  pending = request
  for (const l of [...requestListeners]) l()
}

/** The request waiting for the tab, taken (null when there is none). */
export function takeCaptionsRequest(): CaptionsRequest | null {
  const r = pending
  pending = null
  return r
}

export function onCaptionsRequest(listener: () => void): () => void {
  requestListeners.add(listener)
  return () => requestListeners.delete(listener)
}

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
 * Sends the recording's sound to the provider and stores the transcript it returns in the
 * project, with captions turned on (one undo step). Progress and errors go to the job
 * (transcriptionJob), which the Captions tab shows; a cancel just drops the result.
 */
export async function transcribe({ store }: EditorServices, options: TranscribeOptions): Promise<boolean> {
  const projectId = store.state.id
  if (job?.running) return false
  const mine = ++generation
  setJob({ projectId, progress: null, error: null, running: true })
  const off = window.api.onTranscribeProgress((progress) => {
    if (mine === generation && progress.projectId === projectId && job?.running) setJob({ ...job, progress })
  })
  try {
    const raw = await window.api.transcribe(projectId, options)
    if (mine !== generation) return false
    const transcript = readTranscript(raw, store.state.duration)
    if (!transcript) throw new Error('The provider returned something that is not a transcript')
    if (!transcript.segments.length) throw new Error('No speech was found in this recording')
    store.update((p: Project) => (p.id !== projectId ? p : { ...p, transcript, captions: { ...captionsOf(p), show: true } }))
    // A project keeps at most MAX_CAPTIONS captions: say where the kept ones stop rather than drop the rest silently.
    const given = (raw as { segments?: unknown } | null)?.segments
    if (Array.isArray(given) && given.length > MAX_CAPTIONS && transcript.segments.length >= MAX_CAPTIONS) {
      const last = transcript.segments[transcript.segments.length - 1]
      const at = formatTime(viewingTime(store.state.clips, last.end), false)
      setJob({ projectId, progress: null, error: null, running: false, notice: `A project keeps at most ${MAX_CAPTIONS} captions, so the captions after ${at} were left out.` })
    } else setJob(null)
    return true
  } catch (err) {
    if (mine !== generation) return false
    const message = ipcMessage(err)
    setJob(isCancel(message) ? null : { projectId, progress: null, error: message, running: false })
    return false
  } finally {
    off()
  }
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
