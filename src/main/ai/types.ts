import type { RawTranscript } from '../../shared/captions/transcriptParse'
import type { TextPrompt } from '../../shared/captions/transcriptText'

/** A stretch of sound to transcribe, as a compressed file. */
export interface AudioPart {
  file: string
  mimeType: string
  bytes: number
  seconds: number
}

/** How large a part a provider takes in one request. */
export interface PartLimits {
  maxSeconds: number
  maxBytes: number
}

export interface TranscribeCall {
  /** Spoken language hint (BCP-47); absent = the provider detects it. */
  language?: string
  signal: AbortSignal
  /** Called while a part is uploaded on its own before it is transcribed (Gemini's Files API). */
  onUpload?: () => void
}

/** How hard the model should think about a text task (Claude's effort; others ignore it). */
export type TextEffort = 'low' | 'medium' | 'high'

/** One provider, set up with the user's key. Every call retries and reports failures as AiError. */
export interface AiClient {
  /** Checks the key (and model) with a tiny request; resolves with what was checked. */
  test(signal: AbortSignal): Promise<string>
  /** Runs a text task prompt and returns the parsed JSON answer. */
  json(prompt: TextPrompt, opts: { signal: AbortSignal; effort: TextEffort }): Promise<unknown>
  /** Transcribes one part (times from its start); absent for providers that cannot. */
  transcribe?: (part: AudioPart, call: TranscribeCall) => Promise<RawTranscript>
  partLimits?: PartLimits
}
