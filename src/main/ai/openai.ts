/**
 * OpenAI with the user's key, through the official SDK.
 *
 * Transcription: POST /v1/audio/transcriptions; files up to 25 MB
 * (https://developers.openai.com/api/docs/guides/speech-to-text,
 * https://developers.openai.com/api/reference/resources/audio/subresources/transcriptions/methods/create).
 * whisper-1 (retired 26 February 2027): response_format "verbose_json" with
 * timestamp_granularities ["segment", "word"], which only it supports. Every other model
 * (gpt-transcribe, its replacement): response_format "json", `languages` hints, an answer of text
 * only, sent in 30 s parts and timed from the sound by the job (docs/design/transcription.md §3).
 * A request to a retired model fails with a plain message (retiredModel.ts).
 * Text tasks: the Responses API with a strict JSON schema (text.format type "json_schema");
 * a refusal comes back as a "refusal" content item instead of the JSON
 * (https://developers.openai.com/api/docs/guides/structured-outputs).
 */
import { readFile } from 'node:fs/promises'
import OpenAI, { toFile } from 'openai'
import { AI_PROVIDER_KINDS } from '../../shared/api/ai'
import type { FailureInfo } from '../../shared/captions/transcriptErrors'
import { parseOpenAiText, parseOpenAiTranscription } from '../../shared/captions/transcriptParse'
import { isTextOnlyOpenAiModel, TEXT_PART_SECONDS } from '../../shared/captions/transcriptTiming'
import { baseUrlOverride } from './endpoints'
import { AiError, callWithRetry, isNetworkError, retryAfterSeconds } from './request'
import { retiredFailure } from './retired'
import type { AiClient } from './types'

const OFFICIAL_URL = 'https://api.openai.com/v1'
const PROVIDER = AI_PROVIDER_KINDS.openai.label
/** OpenAI takes files up to 25 MB per transcription request. */
const MAX_UPLOAD = 25 * 1024 * 1024

/** An SDK error as a FailureInfo (abort and time-outs are handled by callWithRetry). */
export function openAiFailure(err: unknown): FailureInfo {
  if (err instanceof OpenAI.APIConnectionError) return { network: true }
  if (err instanceof OpenAI.APIError) {
    return { status: err.status, code: err.code ?? err.type ?? undefined, message: err.message, retryAfter: retryAfterSeconds(err.headers?.get('retry-after')) }
  }
  if (isNetworkError(err)) return { network: true }
  return { message: err instanceof Error ? err.message : String(err) }
}

export function openAiClient(apiKey: string, model: string, transcriptionModel: string): AiClient {
  // An explicit base URL: OPENAI_BASE_URL in the user's environment must not redirect their key;
  // and no logging, whatever OPENAI_LOG says (requests carry the key).
  const client = new OpenAI({ apiKey, baseURL: baseUrlOverride('openai') ?? OFFICIAL_URL, maxRetries: 0, timeout: 30 * 60_000, logLevel: 'off' })
  const base = { provider: PROVIDER, toFailure: openAiFailure }
  // Text without times: short parts, timed from the sound by the job.
  const textOnly = isTextOnlyOpenAiModel(transcriptionModel)
  const retired = (use: 'transcription' | 'text', name: string) => (err: unknown): never => {
    throw retiredFailure(err, 'openai', name, use)
  }
  return {
    partLimits: { maxSeconds: textOnly ? TEXT_PART_SECONDS : 600, maxBytes: MAX_UPLOAD },

    async test(signal) {
      await callWithRetry((s) => client.models.list({ signal: s }), { ...base, signal, timeoutMs: 30_000, attempts: 2 })
      return 'The key works.'
    },

    async transcribe(part, call) {
      const bytes = await readFile(part.file)
      const language = call.language ? call.language.split('-')[0].toLowerCase() : undefined
      if (textOnly) {
        const json = await callWithRetry(
          async (signal) =>
            client.audio.transcriptions.create(
              {
                file: await toFile(bytes, 'audio.mp3', { type: part.mimeType }),
                model: transcriptionModel,
                response_format: 'json',
                ...(language ? { languages: [language] } : {})
              },
              { signal }
            ),
          { ...base, model: transcriptionModel, signal: call.signal, timeoutMs: 120_000 + part.seconds * 1000 }
        ).catch(retired('transcription', transcriptionModel))
        return parseOpenAiText(json, part.seconds)
      }
      const json = await callWithRetry(
        async (signal) =>
          client.audio.transcriptions.create(
            {
              file: await toFile(bytes, 'audio.mp3', { type: part.mimeType }),
              model: transcriptionModel,
              response_format: 'verbose_json',
              timestamp_granularities: ['segment', 'word'],
              ...(language ? { language } : {})
            },
            { signal }
          ),
        // About a minute per minute of sound at worst, plus the upload.
        { ...base, model: transcriptionModel, signal: call.signal, timeoutMs: 120_000 + part.seconds * 1000 }
      ).catch(retired('transcription', transcriptionModel))
      return parseOpenAiTranscription(json, part.seconds)
    },

    async json(prompt, { signal }) {
      const response = await callWithRetry(
        (s) =>
          client.responses.create(
            {
              model,
              instructions: prompt.system,
              input: prompt.user,
              text: { format: { type: 'json_schema', name: prompt.name, schema: prompt.schema, strict: true } }
            },
            { signal: s }
          ),
        { ...base, model, signal, timeoutMs: 10 * 60_000 }
      ).catch(retired('text', model))
      for (const item of response.output ?? []) {
        if (item.type !== 'message') continue
        for (const c of item.content) {
          if (c.type === 'refusal') throw new AiError({ kind: 'refused', retryable: false, message: `${PROVIDER} declined this request${c.refusal ? `: ${c.refusal.slice(0, 200)}` : '.'}` })
        }
      }
      if (response.status === 'incomplete') {
        const reason = response.incomplete_details?.reason
        throw new AiError({
          kind: reason === 'content_filter' ? 'refused' : 'other',
          retryable: false,
          message: reason === 'content_filter' ? `${PROVIDER} declined this request.` : `${PROVIDER} stopped before finishing the answer (${reason ?? 'incomplete'}). Try a shorter transcript.`
        })
      }
      try {
        return JSON.parse(response.output_text)
      } catch {
        throw new AiError({ kind: 'other', retryable: false, message: `${PROVIDER} answered with something that is not the expected JSON. Try again.` })
      }
    }
  }
}
