/**
 * A service that speaks OpenAI's Chat Completions API (docs/design/smart-tools.md §10.3): Groq,
 * Together AI, OpenRouter, Azure OpenAI, Ollama and LM Studio on this PC, or any compatible address.
 *
 * - The OpenAI SDK with the stored base URL, its logging and its own retries off, no organisation or
 *   project from the environment, and a fetch that refuses redirects and checks before every request
 *   that its origin is the one the key was entered for (noRedirectFetch). Retries go through
 *   callWithRetry, which also scrubs any key out of a failure's message.
 * - JSON mode, found by Save and check (probeJsonMode) and kept on the service: a strict JSON schema
 *   ('schema'), else JSON mode with the schema described in the system text ('object'), else plain
 *   text read from its first `{` to the matching `}` ('text'). The check sends only a fixed tiny
 *   request and the key, never project text. A real request that fails with a 400 naming the
 *   response format drops one level, tries once more and keeps the new level.
 * - Every answer still goes through the task's validator; OpenRouter with `keepNoData` asks for hosts
 *   that do not keep prompts (provider.data_collection 'deny'); the tokens a service reports are
 *   passed to onUsage. A service on this PC without a key sends no Authorization header.
 */
import OpenAI from 'openai'
import type { AiProviderInfo, ListedModel, ServiceInfo } from '../../shared/api/ai'
import { presetApplies } from '../../shared/ai/presets'
import { readOpenRouterPrice } from '../../shared/ai/prices'
import type { TextPrompt } from '../../shared/captions/transcriptText'
import type { FailureInfo } from '../../shared/captions/transcriptErrors'
import { openAiFailure } from './openai'
import { fetchModelJson, MODEL_LIST_TIMEOUT_MS, noRedirectFetch, readListedIds, RefusedRequest } from './listFetch'

export { noRedirectFetch, OTHER_ORIGIN_MESSAGE, RefusedRequest } from './listFetch'
import { AiError, callWithRetry } from './request'
import { registerSecret } from './secrets'
import { noteUsage } from './usage'
import type { ServiceStore } from './serviceStore'
import type { AiClient } from './types'

/** A failure of a service's request as a FailureInfo: a refused redirect or origin in its own words, the rest as OpenAI's. */
function serviceFailure(err: unknown): FailureInfo {
  const cause = err instanceof RefusedRequest ? err : (err as { cause?: unknown } | null)?.cause
  if (cause instanceof RefusedRequest) return { message: cause.message }
  return openAiFailure(err)
}

/** The fixed probe Save and check sends (never project text). */
const PROBE: TextPrompt = {
  name: 'check',
  system: 'Answer with this JSON object and nothing else: {"ok": true}',
  user: 'Check.',
  schema: { type: 'object', properties: { ok: { type: 'boolean' } }, required: ['ok'], additionalProperties: false }
}

/** The words Save and check shows for each JSON mode. */
export const JSON_MODE_WORDS: Readonly<Record<ServiceInfo['json'], { head: string; detail: string }>> = {
  schema: { head: 'Works.', detail: 'Answers in JSON with a schema.' },
  object: { head: 'Works; Flown checks its answers more closely.', detail: 'Answers in plain JSON.' },
  text: { head: 'Works; Flown checks its answers more closely.', detail: 'Answers in plain text.' }
}

const LOWER: Readonly<Record<ServiceInfo['json'], ServiceInfo['json'] | null>> = { schema: 'object', object: 'text', text: null }

/** The text of the first `{ … }` object in `text` (braces inside strings ignored), or null. */
export function firstObject(text: string): string | null {
  const start = text.indexOf('{')
  if (start < 0) return null
  let depth = 0
  let inString = false
  let escaped = false
  for (let i = start; i < text.length; i++) {
    const c = text[i]
    if (inString) {
      if (escaped) escaped = false
      else if (c === '\\') escaped = true
      else if (c === '"') inString = false
      continue
    }
    if (c === '"') inString = true
    else if (c === '{') depth++
    else if (c === '}' && --depth === 0) return text.slice(start, i + 1)
  }
  return null
}

/** The system text for a level without a strict schema: the schema described in words and JSON. */
const withSchema = (prompt: TextPrompt): string => `${prompt.system}\n\nAnswer with one JSON object only, no other text, matching this JSON schema:\n${JSON.stringify(prompt.schema)}`

/** Whether a failed request was a 400 or 422 about the response format (the service does not take that JSON mode). */
function formatRefused(err: unknown, anyBadRequest: boolean): boolean {
  if (!(err instanceof OpenAI.APIError) || (err.status !== 400 && err.status !== 422)) return false
  return anyBadRequest || /response_format|json_schema|json_object|structured|schema/i.test(`${err.message} ${JSON.stringify(err.error ?? '')}`)
}

/** Carries a response-format refusal out of callWithRetry untouched, so the caller can drop a level. */
class FormatRefused extends AiError {
  constructor(readonly raw: unknown) {
    super({ kind: 'bad-request', retryable: false, message: 'The service did not take this JSON mode.' })
  }
}

/**
 * A client for service `info` with its key (null for one on this PC without a key). `store` keeps the
 * JSON mode a check or a request found.
 */
export function compatibleClient(info: AiProviderInfo, apiKey: string | null, store: Pick<ServiceStore, 'setJsonMode'>, base: typeof fetch = globalThis.fetch): AiClient & { probe(signal: AbortSignal): Promise<ServiceInfo['json']> } {
  const service = info.service
  if (!service) throw new Error('Not a service.')
  const origin = new URL(service.baseUrl).origin
  if (apiKey) registerSecret(apiKey)
  const azure = service.preset === 'azure' && presetApplies('azure', service.host)
  const fetchFn = noRedirectFetch(origin, base)
  // A service on this PC without a key: no Authorization header at all.
  const send: typeof fetch = apiKey
    ? fetchFn
    : (((input: string | URL | Request, init?: RequestInit) => {
        const headers = new Headers(init?.headers)
        headers.delete('authorization')
        return fetchFn(input, { ...init, headers })
      }) as typeof fetch)
  const client = new OpenAI({
    apiKey: apiKey ?? 'no-key',
    organization: null,
    project: null,
    adminAPIKey: null,
    baseURL: service.baseUrl,
    maxRetries: 0,
    timeout: 30 * 60_000,
    logLevel: 'off',
    fetch: send,
    // Azure OpenAI takes its keys in an api-key header.
    ...(azure && apiKey ? { defaultHeaders: { 'api-key': apiKey } } : {})
  })
  const provider = service.host
  const model = info.model
  let level: ServiceInfo['json'] = service.json

  /** One request of `prompt` at JSON mode `at`; the raw failure of a refused response format is carried out as FormatRefused. */
  async function ask(prompt: TextPrompt, at: ServiceInfo['json'], signal: AbortSignal, timeoutMs: number, anyBadRequest = false): Promise<OpenAI.Chat.Completions.ChatCompletion> {
    const body: Record<string, unknown> = {
      model,
      messages: [
        { role: 'system', content: at === 'schema' ? prompt.system : withSchema(prompt) },
        { role: 'user', content: prompt.user }
      ],
      ...(at === 'schema' ? { response_format: { type: 'json_schema', json_schema: { name: prompt.name, schema: prompt.schema, strict: true } } } : {}),
      ...(at === 'object' ? { response_format: { type: 'json_object' } } : {}),
      ...(service!.keepNoData ? { provider: { data_collection: 'deny' } } : {})
    }
    return callWithRetry(
      async (s) => {
        try {
          return await client.chat.completions.create(body as unknown as OpenAI.Chat.Completions.ChatCompletionCreateParamsNonStreaming, { signal: s })
        } catch (err) {
          if (at !== 'text' && formatRefused(err, anyBadRequest)) throw new FormatRefused(err)
          throw err
        }
      },
      { provider, model, signal, timeoutMs, toFailure: serviceFailure }
    )
  }

  /** The JSON of an answer: parsed whole, else its first object; null when there is none. */
  function readAnswer(res: OpenAI.Chat.Completions.ChatCompletion): unknown {
    const choice = res.choices?.[0]
    const message = choice?.message as { content?: string | null; refusal?: string | null } | undefined
    if (message?.refusal) throw new AiError({ kind: 'refused', retryable: false, message: `${provider} declined this request: ${String(message.refusal).slice(0, 200)}` })
    if (choice?.finish_reason === 'length') throw new AiError({ kind: 'other', retryable: false, message: `${provider} stopped before finishing the answer (it was too long). Try a shorter part.` })
    if (choice?.finish_reason === 'content_filter') throw new AiError({ kind: 'refused', retryable: false, message: `${provider} declined this request.` })
    const text = typeof message?.content === 'string' ? message.content : ''
    for (const candidate of [text.trim(), firstObject(text)]) {
      if (!candidate) continue
      try {
        return JSON.parse(candidate)
      } catch {
        // The next candidate.
      }
    }
    return null
  }

  const notJson = (): AiError => new AiError({ kind: 'other', retryable: false, message: `${provider} answered with something that is not the expected JSON. Try again.` })

  const keep = (next: ServiceInfo['json']): void => {
    level = next
    store.setJsonMode(info.id, next)
  }

  /** Save and check: the fixed probe at each JSON mode in turn, until one answers; keeps the mode. */
  async function probe(signal: AbortSignal): Promise<ServiceInfo['json']> {
    let at: ServiceInfo['json'] | null = 'schema'
    while (at) {
      try {
        const res = await ask(PROBE, at, signal, 60_000, true)
        const answer = readAnswer(res)
        if (answer && typeof answer === 'object' && !Array.isArray(answer)) {
          keep(at)
          return at
        }
        if (at === 'text') throw notJson()
      } catch (err) {
        if (!(err instanceof FormatRefused)) throw err
      }
      at = LOWER[at]
    }
    throw notJson()
  }

  return {
    pictures: false,
    probe,

    async test(signal) {
      const found = await probe(signal)
      const words = JSON_MODE_WORDS[found]
      return `${words.head}\n${words.detail}`
    },

    async json(prompt, { signal, onUsage }) {
      let res: OpenAI.Chat.Completions.ChatCompletion
      try {
        res = await ask(prompt, level, signal, 10 * 60_000)
      } catch (err) {
        const next = err instanceof FormatRefused ? LOWER[level] : null
        if (!next) throw err instanceof FormatRefused ? new AiError({ kind: 'bad-request', retryable: false, message: `${provider} rejected the request's JSON mode.` }) : err
        keep(next)
        res = await ask(prompt, next, signal, 10 * 60_000)
      }
      const usage = res.usage
      if (usage && Number.isFinite(usage.prompt_tokens) && Number.isFinite(usage.completion_tokens)) {
        const used = { input: usage.prompt_tokens, output: usage.completion_tokens }
        onUsage?.(used)
        const content = res.choices?.[0]?.message?.content
        noteUsage(service.host, model, prompt, typeof content === 'string' ? content : '', used)
      }
      const answer = readAnswer(res)
      if (answer === null) throw notJson()
      return answer
    },

    async models(signal) {
      const openRouter = presetApplies('openrouter', service.host)
      const headers: Record<string, string> = { Accept: 'application/json' }
      if (apiKey) headers.Authorization = `Bearer ${apiKey}`
      if (azure && apiKey) headers['api-key'] = apiKey
      const body = await fetchModelJson(`${service.baseUrl}/models`, headers, AbortSignal.any([signal, AbortSignal.timeout(MODEL_LIST_TIMEOUT_MS)]), fetchFn, provider)
      const data = body && typeof body === 'object' && Array.isArray((body as { data?: unknown }).data) ? (body as { data: unknown[] }).data : []
      return readListedIds(data, (entry): Omit<ListedModel, 'id'> => {
        if (!openRouter) return {}
        const params = (entry as { supported_parameters?: unknown }).supported_parameters
        return { prices: readOpenRouterPrice(entry), ...(Array.isArray(params) && params.includes('structured_outputs') ? { schema: true } : {}) }
      })
    }
  }
}

/** How service `client` answers in JSON (Save and check, §10.3): 'text' for a client that cannot be checked. */
export async function probeJsonMode(client: AiClient, signal: AbortSignal): Promise<ServiceInfo['json']> {
  const probe = (client as { probe?: (signal: AbortSignal) => Promise<ServiceInfo['json']> }).probe
  return probe ? probe(signal) : 'text'
}
