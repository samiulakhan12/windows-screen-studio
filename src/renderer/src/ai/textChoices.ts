/**
 * The choices a text tool offers (docs/design/smart-tools.md §20.0): the user's providers, their
 * services, and On this PC when a model is ready and the task is one it runs (never 'chapters' or
 * 'marks', decision 18). Each carries `place`, the one name every hint and cost line uses
 * ("OpenAI", "api.groq.com", "Ollama on this PC", "this PC"), so no hint says "OpenAI" for a Groq
 * service or "undefined" for On this PC.
 */
import { useMemo } from 'react'
import { LOCAL_TEXT_ID, type AiProviderInfo, type AiTextTask, type TextChoice } from '../../../shared/api/ai'
import { presetApplies, SERVICE_PRESETS, serviceName } from '../../../shared/ai/presets'
import { t } from '../../../shared/i18n/t'
import { useTextProviders } from '../editor/panels/LanguagesSection'
import { useLocalAiReady } from './localAiState'

/** What the hints called each kind of provider before services (KIND_NAMES of the text tools). */
const KIND_PLACES: Record<AiProviderInfo['kind'], string> = { openai: 'OpenAI', gemini: 'Gemini', anthropic: 'Claude' }

/** On this PC in a provider list, and the place its hints name, in the UI language. */
export const localChoiceLabel = (): string => t('captions.ai.localChoice')
export const localPlace = (): string => t('captions.ai.thisPc')

/** The tasks On this PC never runs: Find chapters chooses where to split, the model only names (§9.7). */
const NOT_LOCAL: readonly AiTextTask[] = ['chapters', 'marks']

/**
 * Where a provider's or service's requests go, by the name every hint uses. A service on this PC
 * goes by its preset's name in the UI language (serviceName gives the English one); every other by
 * its host or brand.
 */
export function placeOf(info: AiProviderInfo): string {
  if (!info.service) return KIND_PLACES[info.kind]
  const name = serviceName(info)
  const preset = info.service.preset
  if (name === SERVICE_PRESETS[preset].label && (preset === 'ollama' || preset === 'lmstudio')) return t(preset === 'ollama' ? 'settings.provider.preset.ollama' : 'settings.provider.preset.lmstudio')
  return name
}

/** A provider or service as a text choice. */
export function choiceOf(info: AiProviderInfo): TextChoice {
  const service = info.service
  const free = !!service && SERVICE_PRESETS[service.preset].free && presetApplies(service.preset, service.host)
  return {
    id: info.id,
    label: info.label || placeOf(info),
    kind: info.kind,
    model: info.model,
    ...(service ? { host: service.host } : {}),
    place: placeOf(info),
    ...(free ? { free: true as const } : {}),
    pictures: true
  }
}

/** On this PC as a text choice. */
export const LOCAL_CHOICE: TextChoice = {
  id: LOCAL_TEXT_ID,
  get label(): string {
    return localChoiceLabel()
  },
  kind: 'local',
  model: '',
  get place(): string {
    return localPlace()
  },
  pictures: false
}

/** The choices for `task` (pure): the providers and services in order, then On this PC when `localReady` and the task allows; with `pictures`, only those that can send them. */
export function textChoicesOf(providers: readonly AiProviderInfo[], task: AiTextTask, localReady: boolean, opts?: { pictures?: boolean }): TextChoice[] {
  const out = providers.map(choiceOf)
  if (localReady && !NOT_LOCAL.includes(task)) out.push(LOCAL_CHOICE)
  return opts?.pictures ? out.filter((c) => c.pictures) : out
}

/** The choices a text tool offers for `task`, kept up to date as providers change and a model gets ready. */
export function useTextChoices(task: AiTextTask, opts?: { pictures?: boolean }): TextChoice[] {
  return useTextChoiceList(task, opts) ?? NO_CHOICES
}

const NO_CHOICES: TextChoice[] = []

/** useTextChoices, null while the providers are first read (a tool waits for them before saying there is none). */
export function useTextChoiceList(task: AiTextTask, opts?: { pictures?: boolean }): TextChoice[] | null {
  const providers = useTextProviders()
  const localReady = useLocalAiReady()
  const pictures = !!opts?.pictures
  return useMemo(() => (providers === null ? null : textChoicesOf(providers, task, localReady, { pictures })), [providers, task, localReady, pictures])
}

/**
 * Who a result made with `choice` says made it (smart-tools.md §10.6, test 97): the provider's kind
 * with a service's host, or 'local' with `ran`, the model AI on this PC used (aiText's `model`: main
 * picks it once, before the run; read again after it, the free memory the helper still holds or a
 * changed Use could name another).
 */
export function madeBy(choice: TextChoice, ran?: string): { by: AiProviderInfo['kind'] | 'local'; model: string; host?: string } {
  if (choice.kind !== 'local') return { by: choice.kind, model: choice.model, ...(choice.host ? { host: choice.host } : {}) }
  return { by: 'local', model: ran ?? '' }
}

/** What a tool's hint says is sent: the captions' text (Languages: their timing stays) or their words (Make my captions great: only the picks come back). */
export type SentWhat = 'captionText' | 'captionWords'

const SENT_KEYS = {
  captionText: { local: 'captions.ai.sent.textLocal', free: 'captions.ai.sent.textFree', key: 'captions.ai.sent.textKey' },
  captionWords: { local: 'captions.ai.sent.wordsLocal', free: 'captions.ai.sent.wordsFree', key: 'captions.ai.sent.wordsKey' }
} as const

/**
 * The hint under a tool that sends `what` with `choice` ("The captions' text is sent to
 * api.groq.com with your key; their timing stays."), or that it stays on this PC: never "OpenAI"
 * for a service, never "undefined" (test 103).
 */
export function sentHint(choice: TextChoice, what: SentWhat): string {
  const keys = SENT_KEYS[what]
  if (choice.kind === 'local') return t(keys.local)
  return t(choice.free ? keys.free : keys.key, { place: choice.place })
}
