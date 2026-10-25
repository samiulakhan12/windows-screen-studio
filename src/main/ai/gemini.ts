/**
 * Google Gemini with the user's key, through the official @google/genai SDK.
 *
 * Transcription: generateContent with the sound and a prompt, the answer constrained to JSON
 * segments with start and end times (responseMimeType "application/json" + responseJsonSchema).
 * Sound goes inline while the whole request stays under 20 MB, else through the Files API
 * (uploaded, waited on until ACTIVE, deleted afterwards; files expire after 48 hours anyway)
 * (https://ai.google.dev/gemini-api/docs/audio, https://ai.google.dev/gemini-api/docs/files,
 * https://ai.google.dev/api/generate-content).
 * Text tasks: generateContent with the task's JSON schema
 * (https://ai.google.dev/gemini-api/docs/structured-output). A blocked prompt or answer is
 * reported (promptFeedback.blockReason, finishReason SAFETY and the like) rather than parsed.
 */
import { readFile } from 'node:fs/promises'
import { ApiError, FileState, GoogleGenAI, type GenerateContentResponse, type Part } from '@google/genai'
import { AI_PROVIDER_KINDS } from '../../shared/api/ai'
import type { FailureInfo } from '../../shared/captions/transcriptErrors'
import { GEMINI_TRANSCRIPT_SCHEMA, parseGeminiTranscription } from '../../shared/captions/transcriptParse'
import { baseUrlOverride, testLimit } from './endpoints'
import { AiError, callWithRetry, isNetworkError, sleep } from './request'
import type { AiClient, AudioPart } from './types'

const OFFICIAL_URL = 'https://generativelanguage.googleapis.com/'
const PROVIDER = AI_PROVIDER_KINDS.gemini.label
/** Inline data must keep the whole request under 20 MB; base64 makes it a third larger. */
const INLINE_MAX = 14 * 1024 * 1024
/** Longest wait for an uploaded file to be processed. */
const FILE_READY_TIMEOUT = 5 * 60_000

const isObject = (v: unknown): v is Record<string, unknown> => typeof v === 'object' && v !== null && !Array.isArray(v)

/**
 * An SDK error as a FailureInfo. ApiError's message is the error body as JSON:
 * { error: { code, message, status: "INVALID_ARGUMENT", details: [{ reason: "API_KEY_INVALID" }] } }.
 * A 429 has the same message for a per-minute and a per-day limit: the QuotaFailure detail's
 * quotaId tells them apart, and its RetryInfo detail says how long to wait ("17s").
 */
export function geminiFailure(err: unknown): FailureInfo {
  if (err instanceof ApiError) {
    let code: string | undefined
    let message = err.message
    let retryAfter: number | undefined
    try {
      const body: unknown = JSON.parse(err.message)
      const e = isObject(body) && isObject(body.error) ? body.error : null
      if (e) {
        const details = Array.isArray(e.details) ? e.details.filter(isObject) : []
        const reasons = details.map((d) => (typeof d.reason === 'string' ? d.reason : '')).filter(Boolean)
        const quotaIds = details.flatMap((d) => (Array.isArray(d.violations) ? d.violations : [])).map((v) => (isObject(v) && typeof v.quotaId === 'string' ? v.quotaId : '')).filter(Boolean)
        code = [typeof e.status === 'string' ? e.status : '', ...reasons, ...quotaIds].filter(Boolean).join(' ') || undefined
        if (typeof e.message === 'string') message = e.message
        const delay = details.find((d) => typeof d.retryDelay === 'string')?.retryDelay as string | undefined
        if (delay !== undefined && Number.isFinite(parseFloat(delay))) retryAfter = parseFloat(delay)
      }
    } catch {
      // Not JSON: the message as it is.
    }
    return { status: err.status, code, message, ...(retryAfter !== undefined ? { retryAfter } : {}) }
  }
  if (isNetworkError(err)) return { network: true }
  return { message: err instanceof Error ? err.message : String(err) }
}

/** The text of an answer, or why there is none. */
function answerText(response: GenerateContentResponse): string {
  const blocked = response.promptFeedback?.blockReason
  if (blocked) throw new AiError({ kind: 'refused', retryable: false, message: `${PROVIDER} declined this request (${blocked}).` })
  const reason = response.candidates?.[0]?.finishReason
  if (reason === 'MAX_TOKENS') throw new AiError({ kind: 'other', retryable: false, message: `${PROVIDER} stopped before finishing the answer (it was too long). Try a shorter part.` })
  if (reason && reason !== 'STOP') throw new AiError({ kind: 'refused', retryable: false, message: `${PROVIDER} declined to answer (${reason}).` })
  const text = response.text
  if (!text) throw new AiError({ kind: 'other', retryable: false, message: `${PROVIDER} gave an empty answer. Try again.` })
  return text
}

function parseJson(text: string): unknown {
  try {
    return JSON.parse(text)
  } catch {
    throw new AiError({ kind: 'other', retryable: false, message: `${PROVIDER} answered with something that is not the expected JSON. Try again.` })
  }
}

const TRANSCRIBE_PROMPT =
  'Transcribe this screen recording\'s speech verbatim, in the language spoken, as JSON. Split it into segments of one sentence or short phrase (at most about 12 words or 6 seconds each). ' +
  'Give each segment its start and end time in seconds (with decimals) from the start of this audio, and when you can, each word with its own start and end time. ' +
  'Leave out silence, music and noises. If nobody speaks, return an empty list of segments.'

export function geminiClient(apiKey: string, model: string, transcriptionModel: string): AiClient {
  // Explicit base URL: GOOGLE_GEMINI_BASE_URL in the user's environment must not redirect their key.
  const ai = new GoogleGenAI({ apiKey, vertexai: false, httpOptions: { baseUrl: baseUrlOverride('gemini') ?? OFFICIAL_URL, retryOptions: { attempts: 1 } } })
  const base = { provider: PROVIDER, toFailure: geminiFailure }
  const inlineMax = testLimit('SSW_AI_GEMINI_INLINE_BYTES') ?? INLINE_MAX

  /** Uploads `part` and waits until it can be used; resolves with its name and URI. */
  async function upload(part: AudioPart, signal: AbortSignal): Promise<{ name: string; uri: string }> {
    const file = await callWithRetry(
      (s) => ai.files.upload({ file: part.file, config: { mimeType: part.mimeType, abortSignal: s } }),
      { ...base, signal, timeoutMs: 120_000 + part.bytes / 50 }
    )
    let current = file
    const until = Date.now() + FILE_READY_TIMEOUT
    while (current.state === FileState.PROCESSING) {
      if (Date.now() > until) throw new AiError({ kind: 'timeout', retryable: false, message: `${PROVIDER} took too long to process the uploaded sound.` })
      await sleep(1000, signal)
      current = await callWithRetry((s) => ai.files.get({ name: file.name!, config: { abortSignal: s } }), { ...base, signal, timeoutMs: 30_000 })
    }
    if (current.state === FileState.FAILED || !current.uri || !current.name) throw new AiError({ kind: 'other', retryable: false, message: `${PROVIDER} could not process the uploaded sound.` })
    return { name: current.name, uri: current.uri }
  }

  return {
    // Answers carry every word with its times: shorter parts keep them well under the output limit.
    partLimits: { maxSeconds: 300, maxBytes: 100 * 1024 * 1024 },

    async test(signal) {
      await callWithRetry((s) => ai.models.get({ model, config: { abortSignal: s } }), { ...base, model, signal, timeoutMs: 30_000, attempts: 2 })
      return `The key works, and “${model}” is available.`
    },

    async transcribe(part, call) {
      let audio: Part
      let uploaded: { name: string } | null = null
      if (part.bytes <= inlineMax) {
        audio = { inlineData: { mimeType: part.mimeType, data: (await readFile(part.file)).toString('base64') } }
      } else {
        call.onUpload?.()
        const file = await upload(part, call.signal)
        uploaded = file
        audio = { fileData: { mimeType: part.mimeType, fileUri: file.uri } }
      }
      try {
        const language = call.language ? ` The speech is in ${call.language} (BCP-47).` : ''
        const response = await callWithRetry(
          (signal) =>
            ai.models.generateContent({
              model: transcriptionModel,
              contents: [{ role: 'user', parts: [audio, { text: TRANSCRIBE_PROMPT + language }] }],
              config: { responseMimeType: 'application/json', responseJsonSchema: GEMINI_TRANSCRIPT_SCHEMA, abortSignal: signal }
            }),
          { ...base, model: transcriptionModel, signal: call.signal, timeoutMs: 180_000 + part.seconds * 1000 }
        )
        return parseGeminiTranscription(answerText(response), part.seconds)
      } finally {
        // Best effort: the file expires after 48 hours anyway.
        if (uploaded) await ai.files.delete({ name: uploaded.name }).catch(() => undefined)
      }
    },

    async json(prompt, { signal }) {
      const response = await callWithRetry(
        (s) =>
          ai.models.generateContent({
            model,
            contents: prompt.user,
            config: { systemInstruction: prompt.system, responseMimeType: 'application/json', responseJsonSchema: prompt.schema, abortSignal: s }
          }),
        { ...base, model, signal, timeoutMs: 10 * 60_000 }
      )
      return parseJson(answerText(response))
    }
  }
}
