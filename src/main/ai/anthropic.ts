/**
 * Anthropic Claude with the user's key, through the official SDK, for text tasks only: the
 * Claude API does not accept sound, so Claude cannot transcribe.
 *
 * Each task is one streamed Messages request (long transcripts mean long answers; streaming
 * avoids HTTP time-outs) with adaptive thinking, an explicit effort, and the answer constrained
 * to the task's JSON schema with output_config.format
 * (https://platform.claude.com/docs/en/build-with-claude/structured-outputs). A request a
 * safety classifier declines is retried server-side on the model Anthropic recommends for its
 * category (fallbacks "default", beta server-side-fallback-2026-07-01); stop_reason is checked
 * before the content is read, and when the answer switched models mid-way only the text after
 * the last fallback block is the answer
 * (https://platform.claude.com/docs/en/build-with-claude/refusals-and-fallback).
 */
import Anthropic from '@anthropic-ai/sdk'
import { AI_PROVIDER_KINDS } from '../../shared/api/ai'
import type { FailureInfo } from '../../shared/captions/transcriptErrors'
import { baseUrlOverride } from './endpoints'
import { AiError, callWithRetry, isNetworkError, retryAfterSeconds } from './request'
import type { AiClient } from './types'

const OFFICIAL_URL = 'https://api.anthropic.com'
const PROVIDER = AI_PROVIDER_KINDS.anthropic.label
/** Models with adaptive thinking and output_config.effort. */
const ADAPTIVE_RE = /^claude-(fable|mythos|opus|sonnet|haiku)-5|^claude-(opus|sonnet)-4-[6-9]/
/** Models with server-side refusal fallback. */
const FALLBACK_RE = /^claude-(fable-5(-1)?|opus-5(-5)?|sonnet-5-5)$/

/** An SDK error as a FailureInfo (abort and time-outs are handled by callWithRetry). */
export function anthropicFailure(err: unknown): FailureInfo {
  // APIConnectionError (and its time-out subclass) extends APIError: checked first.
  if (err instanceof Anthropic.APIConnectionError) return { network: true }
  if (err instanceof Anthropic.APIError) {
    return { status: err.status, code: err.type ?? undefined, message: err.message, retryAfter: retryAfterSeconds(err.headers?.get('retry-after')) }
  }
  if (isNetworkError(err)) return { network: true }
  return { message: err instanceof Error ? err.message : String(err) }
}

/** The request body of a text task for `model`. */
export function claudeRequest(model: string, prompt: { system: string; user: string; schema: Record<string, unknown> }, effort: 'low' | 'medium' | 'high'): Anthropic.Beta.Messages.MessageCreateParamsStreaming {
  const adaptive = ADAPTIVE_RE.test(model)
  const fallback = FALLBACK_RE.test(model)
  return {
    model,
    max_tokens: 64000,
    stream: true,
    ...(adaptive ? { thinking: { type: 'adaptive' as const } } : {}),
    output_config: { ...(adaptive ? { effort } : {}), format: { type: 'json_schema', schema: prompt.schema } },
    ...(fallback ? { betas: ['server-side-fallback-2026-07-01'], fallbacks: 'default' as const } : {}),
    system: prompt.system,
    messages: [{ role: 'user', content: prompt.user }]
  }
}

/** The answer's text: only what follows the last fallback block (output before a model switch is discarded). */
export function claudeAnswerText(message: Pick<Anthropic.Beta.Messages.BetaMessage, 'content' | 'stop_reason' | 'stop_details'>): string {
  if (message.stop_reason === 'refusal') {
    const category = message.stop_details?.category
    throw new AiError({ kind: 'refused', retryable: false, message: `${PROVIDER} declined this request${category ? ` (${category})` : ''}. Try another provider for this task.` })
  }
  if (message.stop_reason === 'max_tokens' || message.stop_reason === 'model_context_window_exceeded') {
    throw new AiError({ kind: 'other', retryable: false, message: `${PROVIDER} stopped before finishing the answer (it was too long). Try a shorter transcript.` })
  }
  let start = 0
  message.content.forEach((block, i) => {
    if (block.type === 'fallback') start = i + 1
  })
  return message.content
    .slice(start)
    .map((block) => (block.type === 'text' ? block.text : ''))
    .join('')
}

export function anthropicClient(apiKey: string, model: string): AiClient {
  // Explicit base URL and no auth token: ANTHROPIC_BASE_URL / ANTHROPIC_AUTH_TOKEN in the user's
  // environment must not apply; and no logging, whatever ANTHROPIC_LOG says.
  const client = new Anthropic({ apiKey, authToken: null, baseURL: baseUrlOverride('anthropic') ?? OFFICIAL_URL, maxRetries: 0, timeout: 30 * 60_000, logLevel: 'off' })
  const base = { provider: PROVIDER, model, toFailure: anthropicFailure }
  return {
    async test(signal) {
      await callWithRetry((s) => client.models.retrieve(model, {}, { signal: s }), { ...base, signal, timeoutMs: 30_000, attempts: 2 })
      return `The key works, and “${model}” is available. Claude can clean up, translate and summarise transcripts; it cannot transcribe sound.`
    },

    async json(prompt, { signal, effort }) {
      const message = await callWithRetry((s) => client.beta.messages.stream(claudeRequest(model, prompt, effort), { signal: s }).finalMessage(), {
        ...base,
        signal,
        timeoutMs: 15 * 60_000
      })
      const text = claudeAnswerText(message)
      try {
        return JSON.parse(text)
      } catch {
        throw new AiError({ kind: 'other', retryable: false, message: `${PROVIDER} answered with something that is not the expected JSON. Try again.` })
      }
    }
  }
}
