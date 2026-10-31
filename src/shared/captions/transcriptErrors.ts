/**
 * What went wrong with a request to an AI provider, in words the user can act on, and whether
 * trying again may help (rate limits, overloaded or failing servers, the network). Each provider
 * module reads its SDK's error into a FailureInfo; the wording is the same for all of them.
 */

export type AiFailureKind = 'auth' | 'quota' | 'rate-limit' | 'server' | 'network' | 'timeout' | 'too-large' | 'not-found' | 'bad-request' | 'cancelled' | 'refused' | 'other'

export interface FailureInfo {
  /** HTTP status of the answer, when there was one. */
  status?: number
  /** The provider's error code or type ("insufficient_quota", "authentication_error", "RESOURCE_EXHAUSTED"). */
  code?: string
  /** The provider's error message (never shown for key problems, and shortened). */
  message?: string
  /** No answer: the connection failed. */
  network?: boolean
  /** No answer in time. */
  timeout?: boolean
  /** Stopped by the user (or because the project closed). */
  cancelled?: boolean
  /** Seconds the provider asked to wait (retry-after). */
  retryAfter?: number
}

export interface Failure {
  kind: AiFailureKind
  retryable: boolean
  message: string
  retryAfter?: number
  /** HTTP status, kept for a 403 (no access to the model), which a retired model also gets (retiredModel.ts). */
  status?: number
}

const QUOTA_RE = /insufficient_quota|billing|credit balance|exceeded your current quota.*(plan|billing)|per ?day|PerDay/i
/** A 429 that waiting a minute will not fix. */
const QUOTA_429_RE = /insufficient_quota|per ?day|PerDay/i
const AUTH_RE = /invalid_api_key|api[_ ]key[_ ]invalid|api key not valid|incorrect api key|authentication_error|invalid x-api-key/i

const short = (s: string | undefined): string => (s ?? '').replace(/\s+/g, ' ').trim().slice(0, 200)

/** The failure of a request to `provider` (its name as shown, "OpenAI"), using `model` in messages. */
export function describeFailure(info: FailureInfo, provider: string, model?: string): Failure {
  const text = `${info.code ?? ''} ${info.message ?? ''}`
  const status = info.status
  if (info.cancelled) return { kind: 'cancelled', retryable: false, message: 'Cancelled.' }
  if (info.timeout) return { kind: 'timeout', retryable: true, message: `${provider} took too long to answer. Try again in a moment.` }
  if (info.network) return { kind: 'network', retryable: true, message: `Could not reach ${provider}. Check the internet connection and try again.` }
  if (status === 401 || AUTH_RE.test(text)) return { kind: 'auth', retryable: false, message: `${provider} did not accept the API key. Check the key in Settings → AI providers.` }
  // A 429 is a rate limit unless it says the quota is gone for good (OpenAI) or for the day (Gemini):
  // Gemini words its per-minute limits like running out of quota.
  if (status === 429 && !QUOTA_429_RE.test(text)) {
    return { kind: 'rate-limit', retryable: true, retryAfter: info.retryAfter, message: `${provider} is limiting requests (rate limit). Wait a minute and try again, or check your plan's limits.` }
  }
  if (status === 402 || status === 429 || QUOTA_RE.test(text)) {
    return { kind: 'quota', retryable: false, message: `Your ${provider} account has no credits or quota left. Check its billing and usage limits, then try again.` }
  }
  if (status === 403) return { kind: 'auth', status, retryable: false, message: `${provider} refused the request: this key has no access to ${model ? `the model “${model}”` : 'that API'}.` }
  if (status === 404) return { kind: 'not-found', retryable: false, message: `${provider} does not know the model${model ? ` “${model}”` : ''}. Check the model name in Settings → AI providers.` }
  if (status === 413) return { kind: 'too-large', retryable: false, message: `The sound was too large for ${provider}.` }
  if (status === 408 || status === 409 || (status !== undefined && status >= 500)) {
    return { kind: 'server', retryable: true, retryAfter: info.retryAfter, message: `${provider} had a problem answering (HTTP ${status}). Try again in a moment.` }
  }
  if (status === 400 || status === 422) {
    const detail = short(info.message)
    return { kind: 'bad-request', retryable: false, message: `${provider} rejected the request${detail ? `: ${detail}` : '.'}` }
  }
  const detail = short(info.message)
  return { kind: 'other', retryable: false, message: `${provider} failed${detail ? `: ${detail}` : '.'}` }
}

/** Wait before retry number `attempt` (1-based): what the provider asked (at most 30 s), else 1 s, 2 s, 4 s ... with jitter. */
export function retryDelay(attempt: number, retryAfter?: number, random: () => number = Math.random): number {
  if (retryAfter !== undefined && Number.isFinite(retryAfter) && retryAfter >= 0) return Math.min(retryAfter, 30) * 1000
  return Math.min(1000 * 2 ** (attempt - 1), 16000) * (0.75 + random() * 0.5)
}
