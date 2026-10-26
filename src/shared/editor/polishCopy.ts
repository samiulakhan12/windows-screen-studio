/**
 * Every string the Polish dialog and its notice show (E-01, docs/design/polish-in-one-click.md
 * §5). Pure, so the copy is tested without a DOM. A few strings of the Clip, Captions and Camera
 * tabs are file-local there, so they are copied here (the silence chips, the transcription
 * phases, the provider names); the camera's words and the framing line are directorCopy's own.
 */
import type { AiProviderInfo, TranscribeProgress } from '../api/ai'
import { MAX_CAPTIONS } from '../captions/captionData'
import { formatTime } from '../engine/project'
import { framingLine, zoomText } from './directorCopy'
import { POLISH_STEPS, type PolishSkip, type PolishStep, type PolishStepResult, type PolishSummary } from './polish'
import { SILENCE_LENGTH, type SmartSpeedAction } from './smartSpeed'

const STEP_LABEL: Record<PolishStep, string> = {
  style: 'Style',
  zoom: 'Auto zoom',
  silences: 'Remove silences',
  captions: 'Captions',
  director: 'Camera director'
}

/** A row's name in the dialog. */
export function polishStepLabel(step: PolishStep): string {
  return STEP_LABEL[step]
}

/** The "Silence action" chips: as the Clip panel's Remove silences offers them, Cut first. */
export const SILENCE_ACTION_CHIPS: readonly { value: SmartSpeedAction; label: string; title: string }[] = [
  { value: 'cut', label: 'Cut', title: 'Remove pauses from the video' },
  { value: 2, label: '2×', title: 'Play pauses twice as fast' },
  { value: 4, label: '4×', title: 'Play pauses four times as fast' },
  { value: 8, label: '8×', title: 'Play pauses eight times as fast' }
]

export const POLISH_TITLE = 'Polish in one click'
export const POLISH_LEAD = 'Runs the automatic edits in one go. Zooms, camera changes and captions you made are kept, and it is all one undo step.'
export const POLISH_FOOTNOTE = 'All of this is one undo step.'
/** The Polish button's title when nothing would run. */
export const NOTHING_CHOSEN = 'Choose at least one step'
/** The Captions row while the providers are read. */
export const LOOKING_FOR_PROVIDERS = 'Looking for your AI providers…'
/** The Style select's first option (styleId null). */
export const KEEP_LOOK = 'Keep the current look'
/** Undo polish, once the project is no longer the polished one. */
export const CHANGED_SINCE = 'The video changed since'
export const CANCELLED_NOTICE = 'Polish cancelled: nothing was changed'
export const UNDONE_NOTICE = 'Polish undone'
/** The title-bar button's title (withShortcut adds the key). */
export const POLISH_BUTTON_TITLE = 'Polish in one click: silences, zooms, captions, camera and style'

/** Planning threw (a bug): nothing was written. */
export const polishFailed = (message: string): string => `Polish failed: ${message.replace(/[.\s]+$/, '') || 'unknown error'}. Nothing was changed.`

const KIND_NAMES: Record<AiProviderInfo['kind'], string> = { openai: 'OpenAI', gemini: 'Gemini', anthropic: 'Claude' }

/** A provider as the user named it, else its kind ("My OpenAI", "Gemini"). */
export const providerName = (p: Pick<AiProviderInfo, 'label' | 'kind'>): string => p.label || KIND_NAMES[p.kind]

/** A transcription provider in the picker, as the Captions tab lists it: "My OpenAI · whisper-1". */
export const transcriberLabel = (p: Pick<AiProviderInfo, 'label' | 'kind' | 'transcriptionModel'>): string =>
  `${providerName(p)} · ${p.transcriptionModel || KIND_NAMES[p.kind]}`

const plural = (n: number, word: string): string => `${n} ${word}${n === 1 ? '' : 's'}`
/** The Clip panel's seconds: "3.5 s" under a minute, else "1:12.0". */
const shorter = (s: number): string => (s < 60 ? `${s.toFixed(1)} s` : formatTime(s))
/** Below this the video is not called shorter (smart speed's MIN_SAVING). */
const MIN_SHORTER = 0.05
const lowerFirst = (s: string): string => s.charAt(0).toLowerCase() + s.slice(1)
const minSilence = `${SILENCE_LENGTH.default.toFixed(1)} s`

/** What the dialog says under an available row. */
export function polishHint(
  step: PolishStep,
  state: { silenceAction: SmartSpeedAction; autoZoomOn: boolean; provider: Pick<AiProviderInfo, 'label' | 'kind'> | null }
): string {
  switch (step) {
    case 'style':
      return 'Changes the background, card, cursor look and zoom style. The aspect ratio and crop stay.'
    case 'zoom':
      return state.autoZoomOn ? 'Auto zoom is on: your zooms stay as they are.' : 'Turns auto zoom on. Zooms you added or edited are kept.'
    case 'silences': {
      const action = state.silenceAction
      return `${action === 'cut' ? 'Cuts' : 'Plays'} pauses of ${minSilence} or more${action === 'cut' ? '' : ` ${action}× as fast`}, keeping a quarter second next to the sound.`
    }
    case 'captions':
      return `The sound is sent to ${state.provider ? providerName(state.provider) : 'the provider'} with your key and billed to your account.`
    case 'director':
      return 'Uses your Camera tab options: intro and outro, bubble corners, hiding in long silences, centring your face. Camera blocks you placed or changed are kept.'
  }
}

/** Why a row is disabled or a step was skipped ("This recording has no sound", …). */
export function polishSkipText(step: PolishStep, reason: PolishSkip, error?: string): string {
  switch (reason) {
    case 'off':
      return step === 'style' ? 'The current look is kept' : 'Not selected'
    case 'no-input':
      return 'No clicks were captured'
    case 'no-sound':
      return 'This recording has no sound'
    case 'muted':
      return 'The sound is muted: turn it on in the Audio tab'
    case 'not-measured':
      return 'The sound could not be measured, so nothing was cut'
    case 'nothing-heard':
      return 'Nothing is heard in this recording, so nothing was cut'
    case 'has-captions':
      return 'This video already has captions; they are kept'
    case 'no-provider':
      return 'Add an AI provider that can transcribe (OpenAI or Gemini)'
    case 'busy':
      return 'A transcription is already running in the Captions tab'
    case 'failed': {
      const why = error?.replace(/[.\s]+$/, '')
      if (step !== 'captions') return why ? `It failed: ${why}` : 'It failed'
      return `Captions not made${why ? `: ${why}` : ''}. Try again in the Captions tab.`
    }
    case 'cancelled':
      return 'Skipped'
    case 'no-camera':
      return 'This recording has no camera'
    case 'camera-hidden':
      return 'Show the camera first'
    case 'no-preset':
      return 'The chosen style preset no longer exists'
  }
}

/** The Captions row while it runs, in the Captions tab's words ("Transcribing… Part 2 of 3."). */
export function transcribePhaseText(progress: TranscribeProgress | null, stopping: boolean): string {
  const p = progress
  const phase = stopping
    ? 'Stopping…'
    : !p
      ? 'Starting…'
      : p.phase === 'extracting'
        ? 'Preparing the sound…'
        : p.phase === 'uploading'
          ? 'Sending the sound…'
          : p.phase === 'transcribing'
            ? 'Transcribing…'
            : 'Finishing…'
  return p && !stopping && p.total > 1 ? `${phase} Part ${Math.min(p.done + 1, p.total)} of ${p.total}.` : phase
}

/** The camera's parts in directedNotice's words: "intro", "1 bubble move", "2 hidden", "outro". */
function cameraWords(c: PolishSummary['camera']): string[] {
  const what: string[] = []
  if (c.intro) what.push('intro')
  if (c.moves) what.push(plural(c.moves, 'bubble move'))
  if (c.hidden) what.push(`${c.hidden} hidden`)
  if (c.outro) what.push('outro')
  return what
}

const cameraChanges = (c: PolishSummary['camera']): number => (c.intro ? 1 : 0) + (c.outro ? 1 : 0) + c.hidden + c.moves

/** The summary line of one step. A skipped step is named before its reason ("Auto zoom: no clicks were captured"). */
function resultText(summary: PolishSummary, r: PolishStepResult): string {
  const changed = r.status === 'changed'
  if (r.status === 'skipped') {
    const text = polishSkipText(r.step, r.reason ?? 'off', r.error)
    return r.step === 'captions' && r.reason === 'failed' ? text : `${polishStepLabel(r.step)}: ${lowerFirst(text)}`
  }
  switch (r.step) {
    case 'style':
      if (!summary.style) return 'Style: unchanged'
      return changed ? `Style: ${summary.style}` : `Style: already ${summary.style}`
    case 'zoom': {
      const { auto, kept } = summary.zooms
      if (!changed) return `Auto zoom: already on · ${plural(auto + kept, 'zoom')}`
      return `Auto zoom turned on: ${plural(auto, 'zoom')}${kept ? ` · ${kept} of yours kept` : ''}`
    }
    case 'silences': {
      const action = summary.silenceAction
      if (!changed) return `No silences of ${minSilence} or more${action === 'cut' ? '' : ' to speed up'}`
      const what = action === 'cut' ? `Cut ${plural(summary.silences, 'silence')}` : `Sped up ${plural(summary.silences, 'silence')} ${action}×`
      return `${what}: ${shorter(summary.saved)} shorter`
    }
    case 'captions': {
      const at = summary.captionsLeftOutAfter
      const left = at === null ? '' : `. A project keeps at most ${MAX_CAPTIONS} captions, so the captions after ${formatTime(at, false)} were left out.`
      return `Captions: ${plural(summary.captions, 'caption')}${left}`
    }
    case 'director': {
      const f = summary.framing
      const face = f?.status === 'framed' ? `face centred (${zoomText(f.zoom)})` : ''
      const what = cameraWords(summary.camera)
      const body = !changed ? 'already directed' : what.length ? what.join(', ') + (face ? `; ${face}` : '') : face || 'nothing to change'
      // Why the face was not framed (not found, unavailable); nothing when it was not asked for.
      const why = f && f.status !== 'framed' ? framingLine(f, false)?.text : null
      return `Camera: ${body}${why ? `. ${why}` : ''}`
    }
  }
}

/** The summary's lines, one per step, in POLISH_STEPS order. */
export function polishResultLines(summary: PolishSummary): { step: PolishStep; status: PolishStepResult['status']; text: string }[] {
  return POLISH_STEPS.flatMap((step) => {
    const r = summary.steps.find((s) => s.step === step)
    return r ? [{ step, status: r.status, text: resultText(summary, r) }] : []
  })
}

/** "Polished: the video is 1:12.0 shorter", "Polished" or "Already polished: nothing to change". */
export function polishHeadline(summary: PolishSummary, changed: boolean): string {
  if (!changed) return 'Already polished: nothing to change'
  return summary.saved >= MIN_SHORTER ? `Polished: the video is ${shorter(summary.saved)} shorter` : 'Polished'
}

/**
 * The notice when the dialog closes: the steps that changed something, then `undo` (undoHint):
 * "Polished: 1:12.0 shorter · Studio style · auto zoom on · 9 silences cut · 63 captions · 4 camera changes · Ctrl + Z to undo".
 */
export function polishNotice(summary: PolishSummary, changed: boolean, undo: string): string {
  if (!changed) return 'Already polished: nothing to change'
  const parts = [summary.saved >= MIN_SHORTER ? `Polished: ${shorter(summary.saved)} shorter` : 'Polished']
  for (const { step, status } of summary.steps) {
    if (status !== 'changed') continue
    if (step === 'style' && summary.style) parts.push(`${summary.style} style`)
    if (step === 'zoom') parts.push('auto zoom on')
    if (step === 'silences') {
      const n = plural(summary.silences, 'silence')
      parts.push(summary.silenceAction === 'cut' ? `${n} cut` : `${n} sped up ${summary.silenceAction}×`)
    }
    if (step === 'captions') parts.push(plural(summary.captions, 'caption'))
    if (step === 'director') {
      const n = cameraChanges(summary.camera)
      const face = summary.framing?.status === 'framed'
      if (n) parts.push(`${plural(n, 'camera change')}${face ? ', face centred' : ''}`)
      else if (face) parts.push('face centred')
    }
  }
  return parts.join(' · ') + undo
}
