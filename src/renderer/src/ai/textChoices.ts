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
 * with a service's host, or 'local' with the model AI on this PC used (read after the run, as main
 * picks it at run time).
 */
export async function madeBy(choice: TextChoice): Promise<{ by: AiProviderInfo['kind'] | 'local'; model: string; host?: string }> {
  if (choice.kind !== 'local') return { by: choice.kind, model: choice.model, ...(choice.host ? { host: choice.host } : {}) }
  const active = await window.api.localAiState().then(
    (s) => s?.active ?? null,
    () => null
  )
  return { by: 'local', model: active ?? '' }
}

/**
 * The hint under a tool that sends `what` with `choice` ("The captions' text is sent to
 * api.groq.com with your key"), or that it stays on this PC: never "OpenAI" for a service, never
 * "undefined" (test 103). `plural`: "The captions' words are sent…".
 */
export function sentHint(choice: TextChoice, what: string, rest = '', plural = false): string {
  if (choice.kind === 'local') return `${what} ${plural ? 'stay' : 'stays'} on this PC: nothing is sent${rest}.`
  return `${what} ${plural ? 'are' : 'is'} sent to ${choice.place}${choice.free ? '' : ' with your key'}${rest}.`
}
