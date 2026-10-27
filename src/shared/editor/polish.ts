/**
 * Polish in one click (E-01, docs/design/polish-in-one-click.md): one pure planner that runs the
 * existing automatic edits in order (style, auto zoom, remove silences, captions, camera
 * director) over inputs a renderer runner collected first, so the whole polish is one undo step.
 * The project schema does not change; the options are an app preference ('polish').
 *
 * Each step is the function its panel already calls, with the panel's rule for what it keeps:
 * the Auto zoom toggle (automatic zooms are made only when auto zoom is off), the Clip panel's
 * Remove silences with its defaults (title cards and freeze frames kept), the Captions tab's
 * transcript write (never replacing captions), the Camera tab's Direct again with its saved
 * options, and a style preset. Auto zoom and the director see the recording through the crop
 * (crop.ts regenerateInFrame / cropView), and nothing here writes the crop or the freezes.
 */
import type { AiProviderInfo } from '../api/ai'
import { LOCAL_TRANSCRIBER_ID, type SpeechState } from '../api/speech'
import { activitySources } from '../audio/settings'
import type { DirectorSpeech } from '../audio/speech'
import { captionsOf } from '../captions/settings'
import { cropView, regenerateInFrame } from '../engine/crop'
import { directorSettingsOf } from '../engine/directorData'
import { freezeKeepRanges, planOf, videoDuration, videoTimeAt } from '../engine/freeze'
import { effectiveTrack } from '../engine/inputTrack'
import { isZoomClick, zoomSettingsOf } from '../engine/zoom'
import type { FramingOutcome } from '../render/faceFraming'
import type { CursorTrack, Project, Transcript } from '../types'
import { applyDirectorPlan, planDirector, type DirectorPlan } from './cameraDirector'
import { speechModel, type SpeechModelId } from '../speech/catalog'
import { canTranscribeNow, pickTranscriber as pickSpeechTranscriber } from '../speech/transcriber'
import { applySmartSpeed, planSilences, SILENCE_LENGTH, SILENCE_PADDING, SMART_SPEED_ACTIONS, type SmartSpeedAction, type TimeRange } from './smartSpeed'
import { applyPreset, presetMatches, type PresetLook } from './stylePresets'

export type PolishStep = 'style' | 'zoom' | 'silences' | 'captions' | 'director'
/** Run order (decision 2); the dialog lists rows in this order too. */
export const POLISH_STEPS: readonly PolishStep[] = ['style', 'zoom', 'silences', 'captions', 'director']

export interface PolishOptions {
  /** A style preset id (BUILT_IN_PRESETS or the user's), or null: keep the current look. */
  styleId: string | null
  zoom: boolean
  silences: boolean
  /** What happens to each silence (smartSpeed.ts). */
  silenceAction: SmartSpeedAction
  captions: boolean
  /** Transcription provider id; null or no longer able to transcribe: the first that can (pickTranscriber). */
  captionsProvider: string | null
  director: boolean
}

export const DEFAULT_POLISH_OPTIONS: Readonly<PolishOptions> = Object.freeze({
  styleId: null,
  zoom: true,
  silences: true,
  silenceAction: 'cut',
  captions: true,
  captionsProvider: null,
  director: true
})

/** Why a step did not run. */
export type PolishSkip =
  /** not selected */
  | 'off'
  /** no zoom clicks, typing or marks were captured */
  | 'no-input'
  /** project.hasAudio false */
  | 'no-sound'
  /** activitySources(project) is empty (muted, volume 0, every stem off) */
  | 'muted'
  /** the sound levels could not be read (sourceActivity returned null) */
  | 'not-measured'
  /** measured, but nothing is heard (sourceActivity returned []) */
  | 'nothing-heard'
  /** project.transcript exists: never replaced */
  | 'has-captions'
  /** no AI provider can transcribe */
  | 'no-provider'
  /** On this PC is the choice and its speech model is not downloaded (CAPTIONS_SKIPPED_NO_MODEL): nothing is uploaded instead */
  | 'no-model'
  /** a transcription job is already running (Captions tab) */
  | 'busy'
  /** the provider failed (PolishInput.errors.captions) */
  | 'failed'
  /** skipped by the user while it ran */
  | 'cancelled'
  /** no camera (project.hasWebcam false, or the file is missing) */
  | 'no-camera'
  /** webcam.show false */
  | 'camera-hidden'
  /** options.styleId names a preset that no longer exists */
  | 'no-preset'

export interface PolishInput {
  project: Project
  /** cursor.json as recorded; read through effectiveTrack(recorded, project). */
  recorded: CursorTrack
  /** sourceActivity(project, levels): source ranges where the recording is heard; [] nothing heard; null not measured. */
  sound: TimeRange[] | null
  /** A transcript fetched for this run (readTranscript), or null. */
  transcript: Transcript | null
  /** The provider gave more than MAX_CAPTIONS captions, so the ones after `transcript`'s last were left out. */
  transcriptLeftOut?: boolean
  /** loadDirectorSpeech(project with this run's transcript, …).speech; null when unknown. */
  speech: DirectorSpeech | null
  /** Face framing for the director; { status: 'skipped' } when not measured. */
  framing: FramingOutcome
  /** The chosen preset, resolved by the runner; null when styleId is null or the preset is gone. */
  preset: { name: string; look: PresetLook } | null
  /** Reasons the runner knows and the planner cannot see (provider, failure, cancel, camera file). */
  blocked?: Partial<Record<PolishStep, PolishSkip>>
  /** Error text of a failed step (captions). */
  errors?: Partial<Record<PolishStep, string>>
  /** Ids of new director segments (tests inject a counter). */
  newId?: () => string
}

export interface PolishStepResult {
  step: PolishStep
  status: 'changed' | 'unchanged' | 'skipped'
  reason?: PolishSkip
  error?: string
}

export interface PolishSummary {
  /** One per POLISH_STEPS entry, in order. */
  steps: PolishStepResult[]
  /**
   * Seconds the video got shorter: max(0, videoDuration(before) − videoDuration(after)), which is
   * outputDuration without freeze frames (freeze.ts: a pause freeze adds its hold to the video).
   */
  saved: number
  /** Silences acted on, and how. */
  silences: number
  silenceAction: SmartSpeedAction
  /** Zooms after polishing: automatic ones, and the user's (auto: false). */
  zooms: { auto: number; kept: number }
  /** The director's parts after polishing (DirectorPlan.parts, by kind). */
  camera: { intro: boolean; outro: boolean; hidden: number; moves: number }
  /** The face framing outcome used (shown with framingLine); null when the director did not run. */
  framing: FramingOutcome | null
  /** Captions written (0 unless the captions step changed the project). */
  captions: number
  /** With captions left out (PolishInput.transcriptLeftOut): the video second (past the pause freezes) the written ones stop at, else null. */
  captionsLeftOutAfter: number | null
  /** Name of the preset applied or matched, or null. */
  style: string | null
}

export interface PolishResult {
  /** The polished project; input.project itself when nothing changed. */
  project: Project
  summary: PolishSummary
  /** The director's plan on the polished cuts (cameraShown, framingCap), null when it did not run. */
  directorPlan: DirectorPlan | null
}

export interface PolishContext {
  /** The camera file was found and loaded (Editor's !!data.webcamUrl). */
  hasCameraFile: boolean
  /** Providers that can transcribe; null while the list is read. */
  transcribers: readonly Pick<AiProviderInfo, 'id'>[] | null
  /** transcriptionJob()?.running for this project. */
  transcribing: boolean
  /** On this PC is the choice but no speech model is downloaded (polishTranscriber): captions are skipped. */
  localNotReady?: boolean
}

/** The Clip panel's Remove silences defaults: pauses of 1.0 s or more, 0.25 s kept next to the sound. */
const SILENCES = { minLength: SILENCE_LENGTH.default, padding: SILENCE_PADDING.default }

/**
 * The polished project and what each step did, the steps run in POLISH_STEPS order (design §4.1).
 * Pure and synchronous. Each step keeps the project object when it changes nothing, so
 * input.project itself comes back when nothing changes (store.update then adds no undo step) and
 * polishing a polished project again changes nothing.
 */
export function planPolish(input: PolishInput, options: PolishOptions): PolishResult {
  const base = input.project
  let p = base
  const steps: PolishStepResult[] = []
  const summary: PolishSummary = {
    steps,
    saved: 0,
    silences: 0,
    silenceAction: options.silenceAction,
    zooms: { auto: 0, kept: 0 },
    camera: { intro: false, outro: false, hidden: 0, moves: 0 },
    framing: null,
    captions: 0,
    captionsLeftOutAfter: null,
    style: null
  }
  let directorPlan: DirectorPlan | null = null
  /** The step ran: `next` is `p` itself when it changed nothing. */
  const ran = (step: PolishStep, next: Project): void => {
    steps.push({ step, status: next === p ? 'unchanged' : 'changed' })
    p = next
  }
  const skip = (step: PolishStep, reason: PolishSkip, error?: string): void => {
    steps.push(error ? { step, status: 'skipped', reason, error } : { step, status: 'skipped', reason })
  }

  // Style: a preset's look. The aspect ratio, the crop and each zoom's own settings stay.
  const preset = input.preset
  if (!options.styleId) skip('style', 'off')
  else if (!preset) skip('style', 'no-preset')
  else if (presetMatches(p, preset.look)) {
    summary.style = preset.name
    ran('style', p)
  } else {
    const next = applyPreset(p, preset.look)
    if (next !== p) summary.style = preset.name
    ran('style', next)
  }

  // Auto zoom, the toggle's rule: turned on when it is off. While it is on, the zooms already are
  // the automatic ones without those you removed, so they are left exactly as they are.
  if (!options.zoom) skip('zoom', 'off')
  else if (!autoZoomHasInput(input.recorded)) skip('zoom', 'no-input')
  else if (zoomSettingsOf(p).auto.enabled) ran('zoom', p)
  else {
    const settings = zoomSettingsOf(p)
    const auto = { ...settings.auto, enabled: true }
    // Zooms you made or edited (auto: false) are kept; automatic ones over them are not added.
    const { zooms } = regenerateInFrame(p.zooms, effectiveTrack(input.recorded, p), p, auto)
    ran('zoom', { ...p, autoZoom: true, zoomSettings: { ...settings, auto }, zooms })
  }

  // Remove silences, as the Clip panel's: a silence across a cut is acted on at both sides of it.
  if (!options.silences) skip('silences', 'off')
  else if (!p.hasAudio) skip('silences', 'no-sound')
  else if (activitySources(p).length === 0) skip('silences', 'muted')
  else if (input.sound === null) skip('silences', 'not-measured')
  else if (input.sound.length === 0) skip('silences', 'nothing-heard')
  else {
    const plan = planSilences(input.sound, p.clips, SILENCES, options.silenceAction, polishKeepRanges(p))
    const clips = plan.parts.length ? applySmartSpeed(p.clips, plan.parts.flatMap((x) => x.pieces), options.silenceAction) : p.clips
    if (clips !== p.clips) summary.silences = plan.parts.length
    ran('silences', clips === p.clips ? p : { ...p, clips })
  }

  // Captions: the Captions tab's write. A transcript already there holds your edits: never replaced.
  if (!options.captions) skip('captions', 'off')
  else if (p.transcript) skip('captions', 'has-captions')
  else if (!p.hasAudio) skip('captions', 'no-sound')
  else if (input.blocked?.captions) skip('captions', input.blocked.captions, input.errors?.captions)
  else if (!input.transcript) skip('captions', 'failed', input.errors?.captions)
  else {
    const transcript = input.transcript
    ran('captions', { ...p, transcript, captions: { ...captionsOf(p), show: true } })
    summary.captions = transcript.segments.length
    const last = transcript.segments[transcript.segments.length - 1]
    // The clips are final here: only remove silences changes them, and it ran.
    if (input.transcriptLeftOut && last) summary.captionsLeftOutAfter = videoTimeAt(p.clips, planOf(p), last.end)
  }

  // Camera director, last: it plans in output seconds on the final clips, finds the demo from the
  // final zooms and their style, and listens to speech the transcript refined. Direct again:
  // only its own earlier segments are replaced.
  if (!options.director) skip('director', 'off')
  else if (input.blocked?.director) skip('director', input.blocked.director)
  // Without a camera to show (layoutsApply), applying would still write Project.director.
  else if (!p.hasWebcam) skip('director', 'no-camera')
  else if (!p.webcam.show) skip('director', 'camera-hidden')
  else {
    const view = cropView(p, effectiveTrack(input.recorded, p))
    const plan = planDirector({ project: view.project, cursor: view.cursor, speech: input.speech, newId: input.newId }, directorSettingsOf(p))
    directorPlan = plan
    const count = (kind: DirectorPlan['parts'][number]['kind']): number => plan.parts.filter((x) => x.kind === kind).length
    summary.camera = { intro: count('intro') > 0, outro: count('outro') > 0, hidden: count('hidden'), moves: count('corner') }
    summary.framing = input.framing
    ran('director', applyDirectorPlan(p, plan, input.framing))
  }

  summary.zooms = { auto: p.zooms.filter((z) => z.auto).length, kept: p.zooms.filter((z) => !z.auto).length }
  summary.saved = Math.max(0, videoDuration(base.clips, planOf(base)) - videoDuration(p.clips, planOf(p)))
  return { project: p, summary, directorPlan }
}

const MAX_ID = 64
const isId = (v: unknown): v is string => typeof v === 'string' && v.length >= 1 && v.length <= MAX_ID

/**
 * The remembered options (preference 'polish'), sanitised: the defaults for anything that is not
 * a plain object; each field kept only when it is valid (booleans, a SMART_SPEED_ACTIONS value,
 * ids of 1..64 characters or null), its default otherwise; unknown keys dropped. Idempotent.
 */
export function readPolishOptions(raw: unknown): PolishOptions {
  if (!raw || typeof raw !== 'object' || Array.isArray(raw)) return { ...DEFAULT_POLISH_OPTIONS }
  const o = raw as Partial<Record<keyof PolishOptions, unknown>>
  const D = DEFAULT_POLISH_OPTIONS
  const flag = (v: unknown, d: boolean): boolean => (typeof v === 'boolean' ? v : d)
  return {
    styleId: isId(o.styleId) ? o.styleId : null,
    zoom: flag(o.zoom, D.zoom),
    silences: flag(o.silences, D.silences),
    silenceAction: SMART_SPEED_ACTIONS.find((a) => a === o.silenceAction) ?? D.silenceAction,
    captions: flag(o.captions, D.captions),
    captionsProvider: isId(o.captionsProvider) ? o.captionsProvider : null,
    director: flag(o.director, D.director)
  }
}

/**
 * Which rows are disabled, and why (null: available). The same rules as planPolish (design §4.2);
 * the director's is directUnavailable's. While `ctx.transcribers` is null the Captions row is
 * available here and the dialog shows it as still looking.
 */
export function polishAvailability(project: Project, recorded: CursorTrack, ctx: PolishContext): Record<PolishStep, PolishSkip | null> {
  const captions = (): PolishSkip | null => {
    if (project.transcript) return 'has-captions'
    if (!project.hasAudio) return 'no-sound'
    if (ctx.transcribing) return 'busy'
    if (ctx.localNotReady) return 'no-model'
    return ctx.transcribers?.length === 0 ? 'no-provider' : null
  }
  return {
    style: null,
    zoom: autoZoomHasInput(recorded) ? null : 'no-input',
    silences: !project.hasAudio ? 'no-sound' : activitySources(project).length === 0 ? 'muted' : null,
    captions: captions(),
    director: !ctx.hasCameraFile || !project.hasWebcam ? 'no-camera' : !project.webcam.show ? 'camera-hidden' : null
  }
}

/**
 * Source ranges remove silences keeps as they are: the title cards, as ClipPanel's `keep`, and
 * the freeze frames (a pause freeze is silent: without this it would be cut).
 */
export function polishKeepRanges(project: Project): TimeRange[] {
  return [...(project.titles ?? []).map(({ start, end }) => ({ start, end })), ...freezeKeepRanges(project.freezes)]
}

/**
 * Whether auto zoom has anything to zoom on in the recorded track: ZoomPanel's hasInput, which
 * counts the recorded clicks (ignored ones too, right clicks too) and typing only with cursor
 * data, and zoom-here marks always.
 */
export function autoZoomHasInput(recorded: CursorTrack): boolean {
  if ((recorded.marks?.length ?? 0) > 0) return true
  return recorded.valid && (recorded.clicks.some((c) => isZoomClick(c, true)) || (recorded.typing?.length ?? 0) > 0)
}

/**
 * What Polish makes captions with: a key provider, or On this PC with its model (and, for a model
 * made for one language, that language); or why it cannot.
 */
export type PolishTranscriber = { providerId: string; model?: SpeechModelId; language?: string } | { skip: 'no-model' | 'no-provider' }

/**
 * The transcriber for Polish (docs/design/offline-captions.md §3.8), by the frozen
 * speech/transcriber.ts: the remembered choice, else On this PC with a downloaded model, else the
 * first key provider that can transcribe, else On this PC not ready. A choice that cannot transcribe
 * now (On this PC without a model) skips captions with 'no-model', even when a key provider exists:
 * nothing is uploaded against the user's choice, and Polish never starts a download. `speech` null:
 * On this PC is unavailable (its state could not be read). `language` is the Captions tab's spoken
 * language this session ('' detects): with Bengali and the Bangla model downloaded, On this PC
 * makes the captions with it, in Bengali (§14.4); otherwise no language is passed, as before.
 */
export function polishTranscriber(providers: readonly AiProviderInfo[], speech: SpeechState | null, remembered: string | null, language = ''): PolishTranscriber {
  const choice = pickSpeechTranscriber(providers, speech, remembered ?? '', language)
  if (!choice) return { skip: 'no-provider' }
  if (!canTranscribeNow(choice)) return { skip: 'no-model' }
  if (choice.kind === 'key') return { providerId: choice.providerId }
  const only = speechModel(choice.model)?.language
  return { providerId: LOCAL_TRANSCRIBER_ID, model: choice.model, ...(only ? { language: only } : {}) }
}

/** The provider captions are made with: the remembered one if it can still transcribe, else the first that can, else null. */
export function pickTranscriber(providers: readonly AiProviderInfo[], remembered: string | null): AiProviderInfo | null {
  const capable = providers.filter((p) => !!p.transcriptionModel)
  return capable.find((p) => p.id === remembered) ?? capable[0] ?? null
}
