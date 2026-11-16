/**
 * The sentences shared by the main process and the Captions tab when captions on this PC cannot
 * be made (docs/design/offline-captions.md §7.2), and why a model is not offered on a PC (§7.3).
 * Each is an errors message in the UI language (main imports this file), one whole sentence for
 * each shape. Electron passes only the message of a rejected invoke, so the message itself carries
 * the reason: main throws `new Error(localErrorMessage(code, params))`, and the renderer maps the
 * text back with localErrorCode to pick the button it offers (today's English patterns, and in
 * another language the same messages read from the catalogue main formats them from). The Captions
 * tab names a model by its tier first ("Accurate (Whisper small)"), so every sentence here does.
 * Pure, frozen.
 */
import type { SpeechUnavailable } from '../api/speech'
import { t, uiLanguage, type MessageKey, type MessageValues } from '../i18n/t'
import { isLanguageModel, memoryNeedMB, SPEECH_MODELS, SPEECH_TIER_NAMES, speechModel, type SpeechModelBlock, type SpeechModelId, type SpeechModelSpec } from './catalog'

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
  /**
   * The speech helper refused the app's own arguments (its error code `args`): it is not the one
   * built with this version of Flown, for example an older one that lacks `--no-timestamps`, which
   * the Bangla model needs. Reinstalling Flown brings the matching one.
   */
  | 'outdated'

export interface LocalErrorParams {
  model?: SpeechModelId
  /** The part the job stopped in (1-based) and the number of parts. */
  part?: number
  parts?: number
  reason?: SpeechUnavailable
  language?: string
  block?: SpeechModelBlock
}

/**
 * Why the speech engine cannot run, as a clause: Settings › Captions on this PC puts it in brackets
 * after "Speech engine: not available". The sentences of localErrorMessage('unavailable') are whole
 * messages of their own.
 */
export const UNAVAILABLE_REASONS: Readonly<Record<SpeechUnavailable, string>> = {
  get missing(): string {
    return t('errors.localCaptions.reason.missing')
  },
  get cpu(): string {
    return t('errors.localCaptions.reason.cpu')
  },
  get blocked(): string {
    return t('errors.localCaptions.reason.blocked')
  },
  get failed(): string {
    return t('errors.localCaptions.reason.failed')
  }
}

/** "Captions on this PC are not available here: …." for each reason, as one sentence. */
const UNAVAILABLE_KEYS: Readonly<Record<SpeechUnavailable, MessageKey>> = {
  missing: 'errors.localCaptions.unavailable.missing',
  cpu: 'errors.localCaptions.unavailable.cpu',
  blocked: 'errors.localCaptions.unavailable.blocked',
  failed: 'errors.localCaptions.unavailable.failed'
}

const mb = (bytes: number): string => `${Math.round(bytes / 1e6)} MB`

/** "Standard (Whisper base)": the tier, then the model's name once. */
export function tierLabel(id: SpeechModelId): string {
  const spec = speechModel(id)!
  return t('errors.localCaptions.tierLabel', { tier: SPEECH_TIER_NAMES[spec.tier], name: spec.name })
}

/**
 * The next quicker model of the catalog, or null for the quickest. A model made for one language
 * (the Bangla model) has none: the others make most of its language's words wrong.
 */
export function quickerModel(id: SpeechModelId): SpeechModelSpec | null {
  const general = SPEECH_MODELS.filter((m) => !isLanguageModel(m))
  const i = general.findIndex((m) => m.id === id)
  return i > 0 ? general[i - 1] : null
}

/** The message key and values of `code`'s sentence (localErrorMessage). */
function localError(code: LocalCaptionsError, params: LocalErrorParams): { key: MessageKey; values: MessageValues } {
  const spec = speechModel(params.model) ?? speechModel('whisper-base')!
  const model = tierLabel(spec.id)
  switch (code) {
    case 'unavailable':
      return { key: UNAVAILABLE_KEYS[params.reason ?? 'failed'], values: {} }
    case 'no-model':
      return { key: 'errors.localCaptions.noModel', values: { model, size: mb(spec.bytes) } }
    case 'damaged':
      return { key: 'errors.localCaptions.damaged', values: { model, size: mb(spec.bytes) } }
    case 'crashed':
      return params.part && params.parts
        ? { key: 'errors.localCaptions.crashedAt', values: { part: String(params.part), parts: String(params.parts) } }
        : { key: 'errors.localCaptions.crashed', values: {} }
    case 'memory': {
      const quicker = quickerModel(spec.id)
      return quicker ? { key: 'errors.localCaptions.memoryTry', values: { model, tier: SPEECH_TIER_NAMES[quicker.tier] } } : { key: 'errors.localCaptions.memory', values: { model } }
    }
    case 'stalled':
      return { key: 'errors.localCaptions.stalled', values: {} }
    case 'protocol':
      return { key: 'errors.localCaptions.protocol', values: {} }
    case 'language':
      return { key: 'errors.localCaptions.language', values: { language: params.language ?? '' } }
    case 'blocked':
      return params.block === 'memory' ? { key: 'errors.localCaptions.blockedMemory', values: { model, gb: String(spec.minTotalMemGB ?? 8) } } : { key: 'errors.localCaptions.blockedProcessor', values: { model } }
    case 'outdated':
      return { key: 'errors.localCaptions.outdated', values: { model } }
  }
}

/** The sentence for `code` (shown after "Captions could not be made: "). */
export function localErrorMessage(code: LocalCaptionsError, params: LocalErrorParams = {}): string {
  const { key, values } = localError(code, params)
  return t(key, values)
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
  ['blocked', /^\S.* \(.+\) (is too slow for this PC's processor\.|needs a PC with \d+ GB of memory in all\.)/],
  ['outdated', /^The speech engine in this copy of Flown does not match this version, so it cannot run /]
]

/** Every message each code is said with, and the placeholders it fills (localError). */
const CODE_KEYS: readonly [LocalCaptionsError, MessageKey, readonly string[]][] = [
  ...Object.values(UNAVAILABLE_KEYS).map((key): [LocalCaptionsError, MessageKey, readonly string[]] => ['unavailable', key, []]),
  ['no-model', 'errors.localCaptions.noModel', ['model', 'size']],
  ['damaged', 'errors.localCaptions.damaged', ['model', 'size']],
  ['crashed', 'errors.localCaptions.crashedAt', ['part', 'parts']],
  ['crashed', 'errors.localCaptions.crashed', []],
  ['memory', 'errors.localCaptions.memoryTry', ['model', 'tier']],
  ['memory', 'errors.localCaptions.memory', ['model']],
  ['stalled', 'errors.localCaptions.stalled', []],
  ['protocol', 'errors.localCaptions.protocol', []],
  ['language', 'errors.localCaptions.language', ['language']],
  ['blocked', 'errors.localCaptions.blockedMemory', ['model', 'gb']],
  ['blocked', 'errors.localCaptions.blockedProcessor', ['model']],
  ['outdated', 'errors.localCaptions.outdated', ['model']]
]

/** A stand-in no message holds, for a placeholder while a message becomes a pattern. */
const SLOT = '\u{F0000}'
const escape = (s: string): string => s.replace(/[.*+?^${}()|[\]\\]/g, '\\$&')

/** The UI language's messages as patterns (any text where a placeholder goes), for a language other than English. */
function catalogPatterns(): [LocalCaptionsError, RegExp][] {
  return CODE_KEYS.map(([code, key, slots]) => {
    const shown = t(key, Object.fromEntries(slots.map((name) => [name, SLOT])))
    return [code, new RegExp(`^${shown.split(SLOT).map(escape).join('[\\s\\S]*')}$`, 'u')]
  })
}

/**
 * The code of a message made by localErrorMessage, with or without Electron's "Error invoking
 * remote method '…': Error: " prefix; null for any other message (cloud providers, "This
 * recording has no sound to transcribe.", a cancel). English reads today's patterns; another
 * language first reads its own messages, which main formats from the same catalogue.
 */
export function localErrorCode(message: string): LocalCaptionsError | null {
  const text = message.replace(/^Error invoking remote method '[^']*':\s*/, '').replace(/^(?:[A-Za-z]*Error):\s*/, '')
  const patterns = uiLanguage() === 'en' ? PATTERNS : [...catalogPatterns(), ...PATTERNS]
  for (const [code, re] of patterns) if (re.test(text)) return code
  return null
}

/** Why a model row in Settings cannot be downloaded (SpeechModelView.reason). */
export function modelBlockReason(block: SpeechModelBlock, spec: Pick<SpeechModelSpec, 'ramMB' | 'partSeconds' | 'minTotalMemGB'>, totalMemBytes: number): string {
  if (block === 'processor') return t('errors.localCaptions.modelProcessor')
  const need = (memoryNeedMB(spec) / 1000).toFixed(1)
  return t('errors.localCaptions.modelMemory', { need, gb: String(spec.minTotalMemGB ?? 8), have: String(Math.round(totalMemBytes / 2 ** 30)) })
}
