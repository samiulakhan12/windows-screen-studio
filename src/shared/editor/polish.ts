/**
 * Polish in one click (E-01, docs/design/polish-in-one-click.md): one pure planner that runs the
 * existing automatic edits in order (style, auto zoom, remove silences, captions, camera
 * director) over inputs a renderer runner collected first, so the whole polish is one undo step.
 * The project schema does not change; the options are an app preference ('polish').
 *
 * Contracts commit: types, POLISH_STEPS, DEFAULT_POLISH_OPTIONS, readPolishOptions,
 * polishKeepRanges and pickTranscriber are implemented; planPolish, polishAvailability and
 * autoZoomHasInput are filled by E-01 (TODO(E-01) below). Only E-01's dialog calls them.
 */
import type { AiProviderInfo } from '../api/ai'
import type { DirectorSpeech } from '../audio/speech'
import type { FramingOutcome } from '../render/faceFraming'
import type { CursorTrack, Project, Transcript } from '../types'
import type { DirectorPlan } from './cameraDirector'
import { SMART_SPEED_ACTIONS, type SmartSpeedAction, type TimeRange } from './smartSpeed'
import type { PresetLook } from './stylePresets'

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
  /** Output seconds the video got shorter: max(0, outputDuration(before) − outputDuration(after)). */
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
}

/** The polished project and what each step did. Pure and synchronous; input.project itself when nothing changes. */
export function planPolish(input: PolishInput, options: PolishOptions): PolishResult {
  // TODO(E-01): design §4.1.
  void input
  void options
  throw new Error('planPolish: not implemented yet (E-01)')
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

/** Which rows are disabled, and why (null: available). The same rules as planPolish (design §4.2). */
export function polishAvailability(project: Project, recorded: CursorTrack, ctx: PolishContext): Record<PolishStep, PolishSkip | null> {
  // TODO(E-01): design §4.2.
  void project
  void recorded
  void ctx
  return { style: null, zoom: null, silences: null, captions: null, director: null }
}

/**
 * Source ranges remove silences keeps as they are: the title cards, as ClipPanel's `keep`.
 * TODO(E-01): append freezeKeepRanges(project.freezes) (engine/freeze.ts, E-11).
 */
export function polishKeepRanges(project: Project): TimeRange[] {
  return (project.titles ?? []).map(({ start, end }) => ({ start, end }))
}

/** Whether auto zoom has anything to zoom on in the recorded track (ZoomPanel's hasInput). */
export function autoZoomHasInput(recorded: CursorTrack): boolean {
  // TODO(E-01): a zoom click (isZoomClick(c, true)), a typing burst on a valid track, or a mark.
  void recorded
  return false
}

/** The provider captions are made with: the remembered one if it can still transcribe, else the first that can, else null. */
export function pickTranscriber(providers: readonly AiProviderInfo[], remembered: string | null): AiProviderInfo | null {
  const capable = providers.filter((p) => !!p.transcriptionModel)
  return capable.find((p) => p.id === remembered) ?? capable[0] ?? null
}
