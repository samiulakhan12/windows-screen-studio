/**
 * The sentences shared by the main process and the Captions tab when captions on this PC cannot
 * be made (docs/design/offline-captions.md §7.2), and why a model is not offered on a PC (§7.3).
 * Electron passes only the message of a rejected invoke, so the message itself carries the
 * reason: main throws `new Error(localErrorMessage(code, params))`, and the renderer maps the
 * text back with localErrorCode to pick the button it offers. The Captions tab names a model by
 * its tier first ("Accurate (Whisper small)"), so every sentence here does. Pure, frozen.
 */
import type { SpeechUnavailable } from '../api/speech'
import { memoryNeedMB, SPEECH_MODELS, SPEECH_TIER_NAMES, speechModel, type SpeechModelBlock, type SpeechModelId, type SpeechModelSpec } from './catalog'

/** Why a transcription on this PC failed. */
export type LocalCaptionsError =
  /** The speech engine cannot run here (`reason`). */
  | 'unavailable'
  /** The model is not downloaded and verified; this path never downloads. */
  | 'no-model'
  /** The model file failed its check, or the engine could not load it: [Download again]. */
  | 'damaged'
  /** The engine crashed on one part twice; finished parts are kept (`part` of `parts`). */
  | 'crashed'
  /** The engine ran out of memory: [Use {the next quicker tier}]. */
  | 'memory'
  /** No output for SPEECH_TIMING.stallMs, or a part ran far over its time limit. */
  | 'stalled'
  /** Malformed output, too much of it, or a run that ended without a result. */
  | 'protocol'
  /** The model does not know the spoken language asked for (`language`). */
  | 'language'
  /** The model may not be used on this PC (`block`, speechModelBlock). */
  | 'blocked'

export interface LocalErrorParams {
  model?: SpeechModelId
  /** The part the job stopped in (1-based) and the number of parts. */
  part?: number
  parts?: number
  reason?: SpeechUnavailable
  language?: string
  block?: SpeechModelBlock
}

/** The end of "Captions on this PC are not available here: …." for each reason. */
export const UNAVAILABLE_REASONS: Readonly<Record<SpeechUnavailable, string>> = {
  missing: 'part of Flown is missing; reinstall it to get them back',
  cpu: "this PC's processor cannot run the speech model",
  blocked: 'Windows or an antivirus blocked the speech engine',
  failed: 'the speech engine did not start'
}

const mb = (bytes: number): string => `${Math.round(bytes / 1e6)} MB`

/** "Standard (Whisper base)": the tier, then the model's name once. */
export function tierLabel(id: SpeechModelId): string {
  const spec = speechModel(id)!
  return `${SPEECH_TIER_NAMES[spec.tier]} (${spec.name})`
}

/** The next quicker model of the catalog, or null for the quickest. */
export function quickerModel(id: SpeechModelId): SpeechModelSpec | null {
  const i = SPEECH_MODELS.findIndex((m) => m.id === id)
  return i > 0 ? SPEECH_MODELS[i - 1] : null
}

/** The sentence for `code` (shown after "Captions could not be made: "). */
export function localErrorMessage(code: LocalCaptionsError, params: LocalErrorParams = {}): string {
  const spec = speechModel(params.model) ?? speechModel('whisper-base')!
  const label = tierLabel(spec.id)
  switch (code) {
    case 'unavailable':
      return `Captions on this PC are not available here: ${UNAVAILABLE_REASONS[params.reason ?? 'failed']}.`
    case 'no-model':
      return `${label} is not downloaded yet: download it in the Captions tab (${mb(spec.bytes)}, free).`
    case 'damaged':
      return `The speech model for ${label} is damaged or missing, so it was not used. Download it again (${mb(spec.bytes)}).`
    case 'crashed':
      return params.part && params.parts
        ? `The speech engine stopped unexpectedly. The parts already done are kept: Generate captions again continues from part ${params.part} of ${params.parts}.`
        : 'The speech engine stopped unexpectedly. Generate captions again continues where it stopped.'
    case 'memory': {
      const quicker = quickerModel(spec.id)
      return quicker ? `This PC ran out of memory for ${label}. Try ${SPEECH_TIER_NAMES[quicker.tier]}.` : `This PC ran out of memory for ${label}. Close other apps and try again.`
    }
    case 'stalled':
      return 'The speech engine stopped responding and was closed. Generate captions again continues where it stopped.'
    case 'protocol':
      return 'The speech engine returned something unexpected.'
    case 'language':
      return `The speech model does not know the language “${params.language ?? ''}”. Choose another spoken language, or Detect automatically.`
    case 'blocked':
      return params.block === 'memory' ? `${label} needs a PC with ${spec.minTotalMemGB ?? 8} GB of memory in all.` : `${label} is too slow for this PC's processor. Choose a quicker tier.`
  }
}

const PATTERNS: readonly [LocalCaptionsError, RegExp][] = [
  ['unavailable', /^Captions on this PC are not available here: /],
  ['no-model', /^\S.* \(.+\) is not downloaded yet: download it in the Captions tab /],
  ['damaged', /^The speech model for .+ is damaged or missing, so it was not used\./],
  ['crashed', /^The speech engine stopped unexpectedly\./],
  ['memory', /^This PC ran out of memory for /],
  ['stalled', /^The speech engine stopped responding and was closed\./],
  ['protocol', /^The speech engine returned something unexpected\./],
  ['language', /^The speech model does not know the language /],
  ['blocked', /^\S.* \(.+\) (is too slow for this PC's processor\.|needs a PC with \d+ GB of memory in all\.)/]
]

/**
 * The code of a message made by localErrorMessage, with or without Electron's "Error invoking
 * remote method '…': Error: " prefix; null for any other message (cloud providers, "This
 * recording has no sound to transcribe.", "Cancelled.").
 */
export function localErrorCode(message: string): LocalCaptionsError | null {
  const text = message.replace(/^Error invoking remote method '[^']*':\s*/, '').replace(/^(?:[A-Za-z]*Error):\s*/, '')
  for (const [code, re] of PATTERNS) if (re.test(text)) return code
  return null
}

/** Why a model row in Settings cannot be downloaded (SpeechModelView.reason). */
export function modelBlockReason(block: SpeechModelBlock, spec: Pick<SpeechModelSpec, 'ramMB' | 'partSeconds' | 'minTotalMemGB'>, totalMemBytes: number): string {
  if (block === 'processor') return "Too slow for this PC's processor: it needs one with AVX2 (most PCs from 2013 on)."
  const need = (memoryNeedMB(spec) / 1000).toFixed(1)
  return `Needs about ${need} GB of memory and a PC with ${spec.minTotalMemGB ?? 8} GB in all; this one has ${Math.round(totalMemBytes / 2 ** 30)} GB.`
}
