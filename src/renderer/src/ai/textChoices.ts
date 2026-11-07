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
import { useTextProviders } from '../editor/panels/LanguagesSection'
import { useLocalAiReady } from './localAiState'

/** What the hints called each kind of provider before services (KIND_NAMES of the text tools). */
const KIND_PLACES: Record<AiProviderInfo['kind'], string> = { openai: 'OpenAI', gemini: 'Gemini', anthropic: 'Claude' }

/** On this PC in a provider list. */
export const LOCAL_CHOICE_LABEL = 'On this PC (good for drafts)'
export const LOCAL_PLACE = 'this PC'

/** The tasks On this PC never runs: Find chapters chooses where to split, the model only names (§9.7). */
const NOT_LOCAL: readonly AiTextTask[] = ['chapters', 'marks']

/** Where a provider's or service's requests go, by the name every hint uses. */
export function placeOf(info: AiProviderInfo): string {
  return info.service ? serviceName(info) : KIND_PLACES[info.kind]
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
export const LOCAL_CHOICE: TextChoice = { id: LOCAL_TEXT_ID, label: LOCAL_CHOICE_LABEL, kind: 'local', model: '', place: LOCAL_PLACE, pictures: false }

/** The choices for `task` (pure): the providers and services in order, then On this PC when `localReady` and the task allows; with `pictures`, only those that can send them. */
export function textChoicesOf(providers: readonly AiProviderInfo[], task: AiTextTask, localReady: boolean, opts?: { pictures?: boolean }): TextChoice[] {
  const out = providers.map(choiceOf)
  if (localReady && !NOT_LOCAL.includes(task)) out.push(LOCAL_CHOICE)
  return opts?.pictures ? out.filter((c) => c.pictures) : out
}

/** The choices a text tool offers for `task`, kept up to date as providers change and a model gets ready. */
export function useTextChoices(task: AiTextTask, opts?: { pictures?: boolean }): TextChoice[] {
  const providers = useTextProviders()
  const localReady = useLocalAiReady()
  const pictures = !!opts?.pictures
  return useMemo(() => textChoicesOf(providers ?? [], task, localReady, { pictures }), [providers, task, localReady, pictures])
}
