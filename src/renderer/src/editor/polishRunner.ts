/**
 * The run of Polish in one click (docs/design/polish-in-one-click.md §4.3). It first collects
 * what takes time, with progress for each row: the sound levels (shared with preview ducking,
 * smart speed and the director through loadAudioAnalysis), the transcript (the Captions tab's
 * transcription job, without writing it), the director's speech and the face. Then it commits
 * planPolish on the project as it is at that moment, in one store.update between two seals, so
 * the whole polish is one undo step. Nothing is written before that; Cancel writes nothing.
 */
import { activitySources, type AudioSource } from '../../../shared/audio/settings'
import { sourceActivity } from '../../../shared/audio/soundtrack'
import { speechLevelSource, type DirectorSpeech } from '../../../shared/audio/speech'
import { applyingLabel } from '../../../shared/editor/directorCopy'
import { planPolish, polishAvailability, POLISH_STEPS, type PolishInput, type PolishOptions, type PolishResult, type PolishSkip, type PolishStep } from '../../../shared/editor/polish'
import { polishSkipText, transcribePhaseText } from '../../../shared/editor/polishCopy'
import { BUILT_IN_PRESETS, type StylePreset } from '../../../shared/editor/stylePresets'
import { effectiveTrack } from '../../../shared/engine/inputTrack'
import { faceSampleTimes, type FramingOutcome } from '../../../shared/render/faceFraming'
import type { CursorTrack, Project } from '../../../shared/types'
import { loadAudioAnalysis } from './audioAnalysis'
import { cancelTranscription, fetchTranscript, onTranscriptionJob, transcriptionJob, type FetchedTranscript } from './captionItems'
import type { EditorServices } from './context'
import { loadDirectorSpeech, measureFraming } from './directorAnalysis'

/** What a row of the running dialog shows. `canSkip`: its Skip button (captions, the face). */
export type PolishRowState = { phase: 'waiting' | 'working' | 'done' | 'skipped'; text: string; canSkip?: boolean }

export interface PolishRun {
  /**
   * The committed polish (`after` is `before` when nothing changed), or null when cancelled.
   * Rejects when the run failed: nothing was written, and the run is stopped as by cancel().
   */
  done: Promise<{ before: Project; after: Project; result: PolishResult } | null>
  /** Stops everything (the transcription too, when this run started it); nothing is written. */
  cancel(): void
  /** Stops the transcription; the run goes on without captions. */
  skipCaptions(): void
  /** Stops measuring the face; the camera is directed without framing it. */
  skipFace(): void
}

const WAITING: PolishRowState = { phase: 'waiting', text: 'Waiting…' }

const plural = (n: number, word: string): string => `${n} ${word}${n === 1 ? '' : 's'}`

/** Whether `options` asks for `step` (a style is asked for by choosing a preset). */
const chosen = (options: PolishOptions, step: PolishStep): boolean => (step === 'style' ? options.styleId !== null : options[step])

/**
 * Runs a polish with `options` on the project in `services.store`. `ctx.providerId` is the
 * provider captions are made with (pickTranscriber; null: none can transcribe), `ctx.userPresets`
 * the user's style presets. `onProgress` gets every row after each change.
 */
export function runPolish(
  services: EditorServices,
  recorded: CursorTrack,
  options: PolishOptions,
  ctx: { hasCameraFile: boolean; providerId: string | null; model?: string; language?: string; userPresets: readonly StylePreset[] },
  onProgress: (rows: Record<PolishStep, PolishRowState>) => void
): PolishRun {
  const { store, player } = services
  const run = new AbortController()
  const face = new AbortController()
  // The transcription this run started is still going (Skip and Cancel stop it, and only it).
  let transcribing = false
  const start = store.state
  const available = polishAvailability(start, recorded, {
    hasCameraFile: ctx.hasCameraFile,
    transcribers: ctx.providerId ? [{ id: ctx.providerId }] : [],
    transcribing: !!transcriptionJob()?.running
  })
  const found = options.styleId ? ([...BUILT_IN_PRESETS, ...ctx.userPresets].find((p) => p.id === options.styleId) ?? null) : null
  const blocked: Partial<Record<PolishStep, PolishSkip>> = {}
  const errors: Partial<Record<PolishStep, string>> = {}
  // What the planner cannot see: no provider, a job already running, the camera file missing.
  if (available.captions === 'busy' || available.captions === 'no-provider') blocked.captions = available.captions
  if (available.director === 'no-camera') blocked.director = 'no-camera'

  const rows = {} as Record<PolishStep, PolishRowState>
  for (const step of POLISH_STEPS) {
    const why: PolishSkip | null = !chosen(options, step) ? 'off' : step === 'style' && !found ? 'no-preset' : available[step]
    rows[step] = why ? { phase: 'skipped', text: polishSkipText(step, why) } : WAITING
  }
  const runs = (step: PolishStep): boolean => rows[step].phase !== 'skipped'
  const setRow = (step: PolishStep, state: PolishRowState): void => {
    if (run.signal.aborted) return
    rows[step] = state
    onProgress({ ...rows })
  }
  onProgress({ ...rows })

  const aborted = new Promise<null>((resolve) => run.signal.addEventListener('abort', () => resolve(null), { once: true }))
  /** `work`, or null as soon as the run is cancelled. */
  const until = <T>(work: Promise<T>): Promise<T | null> => Promise.race([work, aborted])

  /** The sound levels the silences and the director's speech are measured from, then where the recording is heard. */
  const measureSound = async (): Promise<PolishInput['sound']> => {
    const sources = new Set<AudioSource>(runs('silences') ? activitySources(start) : [])
    const speechSource = runs('director') ? speechLevelSource(start) : null
    if (speechSource) sources.add(speechSource)
    if (sources.size === 0) return null
    if (runs('silences')) setRow('silences', { phase: 'working', text: 'Measuring the sound…' })
    if (runs('director')) setRow('director', { phase: 'working', text: applyingLabel({ listening: true, done: 0, total: 0 }) })
    // A source that cannot be measured is left out (sourceActivity is then null).
    const levels = await loadAudioAnalysis(start.id, [...sources]).catch((err: unknown) => {
      console.warn('Could not measure the sound:', err)
      return {}
    })
    if (!runs('silences')) return null
    // Not measured: only the silences are skipped (the director asks for its own source again, and
    // falls back to the transcript when that fails too).
    const sound = sourceActivity(start, levels)
    setRow('silences', sound ? WAITING : { phase: 'skipped', text: polishSkipText('silences', 'not-measured') })
    return sound
  }

  /** The transcript, through the Captions tab's job (its progress shown on the row). */
  const fetchCaptions = async (): Promise<FetchedTranscript | null> => {
    if (!runs('captions') || !ctx.providerId) return null
    const show = (): void => {
      const job = transcriptionJob()
      if (transcribing && job?.running) setRow('captions', { phase: 'working', text: transcribePhaseText(job.progress, !!job.stopping), canSkip: !job.stopping })
    }
    const off = onTranscriptionJob(show)
    try {
      // `language` only with a model made for one language (the Bangla model): otherwise detected, as before.
      const fetching = fetchTranscript(start.id, start.duration, { providerId: ctx.providerId, source: 'auto', ...(ctx.model ? { model: ctx.model } : {}), ...(ctx.language ? { language: ctx.language } : {}) })
      // fetchTranscript starts its job at once (none was running: the row is not 'busy').
      transcribing = !!transcriptionJob()?.running
      show()
      return await fetching
    } finally {
      transcribing = false
      off()
    }
  }

  /** The face framing for the director's plan on the project as polished so far (DirectorSection's direct()). */
  const measureFace = async (gathered: Omit<PolishInput, 'project'>, speech: DirectorSpeech | null): Promise<FramingOutcome> => {
    const video = player.webcam
    if (!runs('director') || !video) return { status: 'skipped' }
    const plan = planPolish({ ...gathered, project: store.state }, options).directorPlan
    if (!plan?.settings.frameFace) return { status: 'skipped' }
    const showFace = (done: number, total: number): void =>
      setRow('director', { phase: 'working', text: applyingLabel({ listening: false, done, total }), canSkip: true })
    try {
      const p = store.state
      const times = faceSampleTimes(plan.cameraShown, speech?.ranges ?? null, p.webcamOffset, video.duration || p.duration)
      showFace(0, times.length)
      return await measureFraming(video.currentSrc || video.src, times, plan.framingCap, { onProgress: ({ done, total }) => showFace(done, total), signal: face.signal })
    } catch (err) {
      return { status: 'unavailable', reason: (err instanceof Error ? err.message : String(err)).replace(/[.\s]+$/, '') || 'unknown error' }
    }
  }

  const work = async (): Promise<{ before: Project; after: Project; result: PolishResult } | null> => {
    // 1. Sound and captions, side by side.
    const collected = await until(Promise.all([measureSound(), fetchCaptions()]))
    if (!collected || run.signal.aborted) return null
    const [sound, fetched] = collected
    const transcript = fetched && 'transcript' in fetched ? fetched.transcript : null
    if (transcript) setRow('captions', { phase: 'done', text: plural(transcript.segments.length, 'caption') })
    else if (fetched && 'error' in fetched) {
      blocked.captions = 'failed'
      errors.captions = fetched.error
      setRow('captions', { phase: 'skipped', text: polishSkipText('captions', 'failed', fetched.error) })
    } else if (fetched) {
      blocked.captions = 'cancelled'
      setRow('captions', { phase: 'skipped', text: polishSkipText('captions', 'cancelled') })
    }

    // 2. The director's speech: from the levels measured above (asked for again if they failed), refined
    // by this run's transcript.
    let speech: DirectorSpeech | null = null
    if (runs('director')) {
      setRow('director', { phase: 'working', text: applyingLabel({ listening: true, done: 0, total: 0 }) })
      const heard = await until(loadDirectorSpeech({ ...start, transcript: transcript ?? start.transcript }, effectiveTrack(recorded, start)))
      if (!heard || run.signal.aborted) return null
      speech = heard.speech
    }

    // 3. The face, sampled where the planned camera shows.
    const gathered: Omit<PolishInput, 'project'> = {
      recorded,
      sound,
      transcript,
      transcriptLeftOut: !!fetched && 'transcript' in fetched && fetched.leftOut,
      speech,
      framing: { status: 'skipped' },
      preset: found ? { name: found.name, look: found.look } : null,
      blocked,
      errors
    }
    const framing = await until(measureFace(gathered, speech))
    if (!framing || run.signal.aborted) return null

    // 4. One undo step, planned again from the project as it is now.
    for (const step of POLISH_STEPS) if (runs(step)) setRow(step, { phase: 'working', text: 'Applying…' })
    const before = store.state
    let result = null as PolishResult | null
    store.seal()
    // EditStore.update calls the function once, before anything is pushed: a throw changes nothing.
    store.update((p) => (result = planPolish({ ...gathered, framing, project: p }, options)).project)
    store.seal()
    if (!result) throw new Error('nothing was planned')
    return { before, after: store.state, result }
  }

  const cancel = (): void => {
    if (run.signal.aborted) return
    run.abort()
    face.abort()
    if (transcribing) cancelTranscription()
  }
  return {
    // A run that fails stops as a cancelled one does: its transcription ends and its rows no longer change.
    done: Promise.race([work(), aborted]).catch((err: unknown) => {
      cancel()
      throw err
    }),
    cancel,
    skipCaptions: () => {
      if (transcribing) cancelTranscription()
    },
    skipFace: () => face.abort()
  }
}
