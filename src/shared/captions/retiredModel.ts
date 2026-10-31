/**
 * A request to a model its maker has retired fails with a plain sentence saying what to do, not
 * the provider's error (NW-09, docs/design/transcription.md §5). The retiring list is the list of
 * suggested models (shared/ai/modelList.ts); before the day the request is sent as usual.
 */
import { dayText, type ModelList, type RetiringModel } from '../ai/modelList'
import type { AiProviderKind } from '../types'
import type { AiFailureKind } from './transcriptErrors'

const MAKERS: Record<AiProviderKind, string> = { openai: 'OpenAI', gemini: 'Google', anthropic: 'Anthropic' }

/** Today as YYYY-MM-DD (UTC), as the list's dates are compared. */
export const todayUtc = (now = new Date()): string => now.toISOString().slice(0, 10)

/**
 * Failures a retired model can explain (an unknown model is a 404, a refused one a 400, one the key
 * has no access to a 403): not a bad key (401), quota, rate limit, a server error, the network or a
 * cancel.
 */
const EXPLAINED: readonly AiFailureKind[] = ['not-found', 'bad-request', 'other', 'refused']
const explained = (failure: AiFailureKind, status?: number): boolean => EXPLAINED.includes(failure) || (failure === 'auth' && status === 403)

/**
 * The message for a failed request to `model` of `kind` when the model is retired by `today`, or
 * null. `use` is 'transcription' (suggests the list's transcription model and On this PC) or
 * 'text'. `failure`: the kind of failure, when there was one (absent: any), and `status` its HTTP
 * status (a key with no access, 403, is explained; a bad key, 401, is not).
 */
export function retiredMessage(
  list: ModelList,
  kind: AiProviderKind,
  model: string,
  today: string,
  use: 'transcription' | 'text',
  failure?: AiFailureKind,
  status?: number
): string | null {
  if (failure && !explained(failure, status)) return null
  const retired = (name: string): RetiringModel | undefined => list.retiring.find((x) => x.provider === kind && x.model === name && x.on <= today)
  const r = retired(model)
  if (!r) return null
  const head = `${MAKERS[kind]} retired ${model} on ${dayText(r.on)}.`
  if (use === 'text') return `${head} Choose another model in Settings › AI providers.`
  // Never the list's suggestion when it is retired too (whisper-1 goes with the gpt-4o models).
  const next = list.providers[kind]?.transcriptionModel
  const suggestion = next && !retired(next) ? `Choose ${next} as the transcription model in Settings › AI providers` : 'Choose another transcription model in Settings › AI providers'
  return `${head} ${suggestion}, or make captions On this PC.`
}
