/**
 * Every string the Polish dialog and its notice show (E-01, docs/design/polish-in-one-click.md
 * §5). Pure, so the copy is tested without a DOM. A few strings of the Clip, Captions and Camera
 * tabs are file-local there, so they are copied here (the silence chips, the transcription
 * phases, the provider names); the camera's words and the framing line are directorCopy's own.
 * The words are messages of the review namespace (docs/design/output-and-languages.md §9.1), made
 * where they are shown: what were constants are functions.
 */
import type { AiProviderInfo, TranscribeProgress } from '../api/ai'
import { MAX_CAPTIONS } from '../captions/captionData'
import { phaseLine, SPEECH_COPY } from '../speech/speechCopy'
import { framingLine } from './directorCopy'
import { POLISH_STEPS, type PolishSkip, type PolishStep, type PolishStepResult, type PolishSummary } from './polish'
import { SILENCE_LENGTH, type SmartSpeedAction } from './smartSpeed'
import { fmt } from '../i18n/fmt'
import { t, uiLanguage, type MessageKey } from '../i18n/t'

const STEP_LABEL: Record<PolishStep, MessageKey> = {
  style: 'review.polish.step.style',
  zoom: 'review.polish.step.zoom',
  silences: 'review.polish.step.silences',
  smoothCuts: 'review.polish.step.smoothCuts',
  captions: 'review.polish.step.captions',
  chapters: 'review.polish.step.chapters',
  captionLook: 'review.polish.step.captionLook',
  director: 'review.polish.step.director'
}

/** A row's name in the dialog. */
export function polishStepLabel(step: PolishStep): string {
  return t(STEP_LABEL[step])
}

/** The "Silence action" chips: as the Clip panel's Remove silences offers them, Cut first. */
export function silenceActionChips(): { value: SmartSpeedAction; label: string; title: string }[] {
  return [
    { value: 'cut', label: t('review.polish.silence.cut'), title: t('review.polish.silence.cutHint') },
    { value: 2, label: fmt.factor(2), title: t('review.polish.silence.x2') },
    { value: 4, label: fmt.factor(4), title: t('review.polish.silence.x4') },
    { value: 8, label: fmt.factor(8), title: t('review.polish.silence.x8') }
  ]
}

export const polishTitle = (): string => t('review.polish.title')
export const polishLead = (): string => t('review.polish.lead')
export const polishFootnote = (): string => t('review.polish.footnote')
/** The Polish button's title when nothing would run. */
export const nothingChosen = (): string => t('review.polish.nothingChosen')
/** The Captions row while the providers are read. */
export const lookingForProviders = (): string => t('review.polish.lookingForProviders')
/** The Style select's first option (styleId null). */
export const keepLook = (): string => t('review.polish.keepLook')
/** Undo polish, once the project is no longer the polished one. */
export const changedSince = (): string => t('review.polish.changedSince')
export const cancelledNotice = (): string => t('review.polish.cancelled')
export const undoneNotice = (): string => t('review.polish.undone')
/** The title-bar button's title (withShortcut adds the key), made when the title bar is drawn. */
export const polishButtonTitle = (): string => t('review.polish.buttonTitle')

/** Planning threw (a bug): nothing was written. */
export const polishFailed = (message: string): string => t('review.polish.failed', { reason: message.replace(/[.\s]+$/, '') || t('review.polish.unknownError') })

const KIND_NAMES: Record<AiProviderInfo['kind'], string> = { openai: 'OpenAI', gemini: 'Gemini', anthropic: 'Claude' }

/** A provider as the user named it, else its kind ("My OpenAI", "Gemini"). */
export const providerName = (p: Pick<AiProviderInfo, 'label' | 'kind'>): string => p.label || KIND_NAMES[p.kind]

/** A transcription provider in the picker, as the Captions tab lists it: "My OpenAI · whisper-1". */
export const transcriberLabel = (p: Pick<AiProviderInfo, 'label' | 'kind' | 'transcriptionModel'>): string =>
  `${providerName(p)} · ${p.transcriptionModel || KIND_NAMES[p.kind]}`

/** A count and its plural for a message: { count, n }. */
const counted = (count: number): { count: number; n: string } => ({ count, n: fmt.count(count) })
/** The Clip panel's seconds: "3.5 s" under a minute, else "1:12.0". */
const shorter = (s: number): string => (s < 60 ? `${fmt.number(s, { max: 1 })} s` : fmt.clock(s))
/** Below this the video is not called shorter (smart speed's MIN_SAVING). */
const MIN_SHORTER = 0.05
/** A reason after a step's name (§9.6): English lower-cases its first letter, as before; other languages leave it as it is. */
const lowerFirst = (s: string): string => (uiLanguage() === 'en' ? s.charAt(0).toLowerCase() + s.slice(1) : s)
const minSilence = (): string => `${fmt.number(SILENCE_LENGTH.default, { max: 1 })} s`

/** What the dialog says under an available row. */
export function polishHint(
  step: PolishStep,
  /** `bangla`: On this PC makes the captions with the Bangla model (Bengali chosen in the Captions tab). */
  state: { silenceAction: SmartSpeedAction; autoZoomOn: boolean; provider: Pick<AiProviderInfo, 'label' | 'kind'> | null; local?: boolean; bangla?: boolean; wide?: boolean }
): string {
  switch (step) {
    case 'style':
      return t('review.polish.hint.style')
    case 'zoom':
      return state.autoZoomOn ? t('review.polish.hint.zoomOn') : t('review.polish.hint.zoomOff')
    case 'silences': {
      const action = state.silenceAction
      return action === 'cut' ? t('review.polish.hint.silencesCut', { length: minSilence() }) : t('review.polish.hint.silencesFaster', { length: minSilence(), factor: fmt.number(action) })
    }
    case 'smoothCuts':
      return t('review.polish.hint.smoothCuts')
    case 'captions':
      if (state.local) return state.bangla ? SPEECH_COPY.readyHintBangla : SPEECH_COPY.readyHint
      return state.provider ? t('review.polish.hint.captionsTo', { provider: providerName(state.provider) }) : t('review.polish.hint.captionsToAny')
    case 'chapters':
      return t('review.polish.hint.chapters')
    case 'captionLook':
      // In wide frames Polish adds no pop-ups (Captions Studio §2.8, §11.8).
      return state.wide ? t('review.polish.hint.captionLookWide') : t('review.polish.hint.captionLook')
    case 'director':
      return t('review.polish.hint.director')
  }
}

/** Why a row is disabled or a step was skipped ("This recording has no sound", …), by reason. */
const SKIP_TEXT: Record<Exclude<PolishSkip, 'off' | 'failed'>, MessageKey> = {
  'no-input': 'review.polish.skip.noInput',
  'no-cuts': 'review.polish.skip.noCuts',
  'kept-style': 'review.polish.skip.keptStyle',
  'has-chapters': 'review.polish.skip.hasChapters',
  'short-video': 'review.polish.skip.shortVideo',
  'no-speech': 'review.polish.skip.noSpeech',
  'no-sound': 'review.polish.skip.noSound',
  muted: 'review.polish.skip.muted',
  'not-measured': 'review.polish.skip.notMeasured',
  'nothing-heard': 'review.polish.skip.nothingHeard',
  'has-captions': 'review.polish.skip.hasCaptions',
  'no-provider': 'review.polish.skip.noProvider',
  'no-model': 'review.polish.skip.noModel',
  busy: 'review.polish.skip.busy',
  'no-captions': 'review.polish.skip.noCaptions',
  cancelled: 'review.polish.skip.cancelled',
  'no-camera': 'review.polish.skip.noCamera',
  'camera-hidden': 'review.polish.skip.cameraHidden',
  'no-preset': 'review.polish.skip.noPreset'
}

/** Why a row is disabled or a step was skipped ("This recording has no sound", …). */
export function polishSkipText(step: PolishStep, reason: PolishSkip, error?: string): string {
  if (reason === 'off') return step === 'style' ? t('review.polish.skip.keptLook') : t('review.polish.skip.off')
  if (reason === 'failed') {
    const why = error?.replace(/[.\s]+$/, '')
    if (step !== 'captions') return why ? t('review.polish.skip.failedWhy', { why }) : t('review.polish.skip.failed')
    return why ? t('review.polish.skip.captionsFailedWhy', { why }) : t('review.polish.skip.captionsFailed')
  }
  return t(SKIP_TEXT[reason])
}

/** The Captions row while it runs, in the Captions tab's words ("Transcribing… Part 2 of 3."). */
export function transcribePhaseText(progress: TranscribeProgress | null, stopping: boolean): string {
  const p = progress
  const phase = stopping
    ? t('review.polish.phase.stopping')
    : !p
      ? t('review.polish.phase.starting')
      : p.phase === 'extracting'
        ? t('review.polish.phase.extracting')
        : p.phase === 'loading'
          ? phaseLine('loading')
          : p.phase === 'uploading'
            ? t('review.polish.phase.uploading')
            : p.phase === 'transcribing'
              ? t('review.polish.phase.transcribing')
              : t('review.polish.phase.finishing')
  return p && !stopping && p.total > 1 ? t('review.polish.phase.part', { phase, part: fmt.count(Math.min(p.done + 1, p.total)), total: fmt.count(p.total) }) : phase
}

/** The camera's parts in directedNotice's words: "intro", "1 bubble move", "2 hidden", "outro". */
function cameraWords(c: PolishSummary['camera']): string[] {
  const what: string[] = []
  if (c.intro) what.push(t('review.polish.camera.intro'))
  if (c.moves) what.push(t('review.polish.camera.moves', counted(c.moves)))
  if (c.hidden) what.push(t('review.polish.camera.hidden', { n: fmt.count(c.hidden) }))
  if (c.outro) what.push(t('review.polish.camera.outro'))
  return what
}

const cameraChanges = (c: PolishSummary['camera']): number => (c.intro ? 1 : 0) + (c.outro ? 1 : 0) + c.hidden + c.moves

/** The summary line of one step. A skipped step is named before its reason ("Auto zoom: no clicks were captured"). */
function resultText(summary: PolishSummary, r: PolishStepResult): string {
  const changed = r.status === 'changed'
  if (r.status === 'skipped') {
    const text = polishSkipText(r.step, r.reason ?? 'off', r.error)
    return r.step === 'captions' && (r.reason === 'failed' || r.reason === 'no-model') ? text : t('review.polish.result.skipped', { step: polishStepLabel(r.step), reason: lowerFirst(text) })
  }
  switch (r.step) {
    case 'style':
      if (!summary.style) return t('review.polish.result.styleUnchanged')
      return changed ? t('review.polish.result.style', { name: summary.style }) : t('review.polish.result.styleAlready', { name: summary.style })
    case 'zoom': {
      const { auto, kept } = summary.zooms
      if (!changed) return t('review.polish.result.zoomAlready', counted(auto + kept))
      return kept ? t('review.polish.result.zoomOnKept', { ...counted(auto), kept: fmt.count(kept) }) : t('review.polish.result.zoomOn', counted(auto))
    }
    case 'silences': {
      const action = summary.silenceAction
      if (!changed) return action === 'cut' ? t('review.polish.result.noSilences', { length: minSilence() }) : t('review.polish.result.noSilencesToSpeed', { length: minSilence() })
      const saved = shorter(summary.saved)
      return action === 'cut'
        ? t('review.polish.result.silencesCut', { ...counted(summary.silences), saved })
        : t('review.polish.result.silencesSped', { ...counted(summary.silences), factor: fmt.number(action), saved })
    }
    case 'smoothCuts':
      return changed ? t('review.polish.result.smoothCuts', counted(summary.smoothCuts ?? 0)) : t('review.polish.result.smoothCutsUnchanged')
    case 'captions': {
      const at = summary.captionsLeftOutAfter
      return at === null
        ? t('review.polish.result.captions', counted(summary.captions))
        : t('review.polish.result.captionsLeftOut', { ...counted(summary.captions), max: fmt.count(MAX_CAPTIONS), time: fmt.clock(at, 'whole') })
    }
    case 'chapters':
      return changed ? t('review.polish.result.chapters', counted(summary.chapters ?? 0)) : t('review.polish.result.chaptersNone')
    case 'captionLook':
      return changed ? t('review.polish.result.captionLook') : t('review.polish.result.captionLookUnchanged')
    case 'director': {
      const f = summary.framing
      const face = f?.status === 'framed' ? t('review.polish.camera.face', { zoom: fmt.factor(f.zoom) }) : ''
      const what = cameraWords(summary.camera)
      const nothing = t('review.polish.camera.nothing')
      const body = !changed
        ? what.length
          ? t('review.polish.camera.already')
          : nothing
        : what.length
          ? face
            ? t('review.polish.camera.withFace', { what: what.join(', '), face })
            : what.join(', ')
          : face || nothing
      // Why the face was not framed (not found, unavailable); nothing when it was not asked for.
      const why = f && f.status !== 'framed' ? framingLine(f, false)?.text : null
      return why ? t('review.polish.result.cameraWhy', { body, why }) : t('review.polish.result.camera', { body })
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
  if (!changed) return t('review.polish.headline.already')
  return summary.saved >= MIN_SHORTER ? t('review.polish.headline.shorter', { saved: shorter(summary.saved) }) : t('review.polish.headline.done')
}

/**
 * The notice when the dialog closes: the steps that changed something, then `undo` (undoHint):
 * "Polished: 1:12.0 shorter · Studio style · auto zoom on · 9 silences cut · 63 captions · 4 camera changes · Ctrl + Z to undo".
 */
export function polishNotice(summary: PolishSummary, changed: boolean, undo: string): string {
  if (!changed) return t('review.polish.headline.already')
  const parts = [summary.saved >= MIN_SHORTER ? t('review.polish.notice.shorter', { saved: shorter(summary.saved) }) : t('review.polish.headline.done')]
  for (const { step, status } of summary.steps) {
    if (status !== 'changed') continue
    if (step === 'style' && summary.style) parts.push(t('review.polish.notice.style', { name: summary.style }))
    if (step === 'zoom') parts.push(t('review.polish.notice.autoZoom'))
    if (step === 'silences') {
      const n = counted(summary.silences)
      parts.push(summary.silenceAction === 'cut' ? t('review.polish.notice.silencesCut', n) : t('review.polish.notice.silencesSped', { ...n, factor: fmt.number(summary.silenceAction) }))
    }
    if (step === 'captions') parts.push(t('review.polish.notice.captions', counted(summary.captions)))
    if (step === 'chapters' && summary.chapters) parts.push(t('review.polish.notice.chapters', counted(summary.chapters)))
    if (step === 'director') {
      const n = cameraChanges(summary.camera)
      const face = summary.framing?.status === 'framed'
      if (n) parts.push(t(face ? 'review.polish.notice.cameraFace' : 'review.polish.notice.camera', counted(n)))
      else if (face) parts.push(t('review.polish.notice.face'))
    }
  }
  return parts.join(' · ') + undo
}
