import type { AiProviderKind, CaptionSegment, Transcript } from '../types'

/** A configured AI provider as the renderer sees it: the API key itself never leaves the main process. */
export interface AiProviderInfo {
  id: string
  kind: AiProviderKind
  /** Name the user gave it ("My OpenAI"). */
  label: string
  /** Model used for text tasks (cleanup, translation, chapters). */
  model: string
  /** Model used for transcription; absent for providers that cannot transcribe (Claude). */
  transcriptionModel?: string
  /** Last characters of the key, e.g. "…a1b2". */
  maskedKey: string
  createdAt: string
}

export interface AiProviderInput {
  /** Present to update an existing provider. */
  id?: string
  kind: AiProviderKind
  label: string
  /** Required when adding; omitted to keep the stored key when editing. */
  apiKey?: string
  model?: string
  transcriptionModel?: string
}

export interface TranscribeOptions {
  providerId: string
  /** Spoken language hint (BCP-47); absent = detect. */
  language?: string
  /** Which sound to send: the microphone track when the recording kept it apart, else the mixed sound. */
  source?: 'auto' | 'mic' | 'mixed'
}

export interface TranscribeProgress {
  projectId: string
  phase: 'extracting' | 'uploading' | 'transcribing' | 'finishing'
  /** Parts done of `total` (long recordings are sent in parts). */
  done: number
  total: number
}

export type AiTextTask = 'cleanup' | 'translate' | 'chapters' | 'title' | 'summary'

export interface AiTextRequest {
  task: AiTextTask
  /** The captions to work on (source seconds). */
  segments: CaptionSegment[]
  /** For 'translate'. */
  targetLanguage?: string
}

export type AiTextResult =
  /** 'cleanup' and 'translate': the same segments (ids and times kept), new text. */
  | { task: 'cleanup' | 'translate'; segments: CaptionSegment[] }
  /** 'chapters': chapter starts (source seconds) with titles. */
  | { task: 'chapters'; chapters: { t: number; title: string }[] }
  | { task: 'title' | 'summary'; text: string }

export interface AiApi {
  listAiProviders(): Promise<AiProviderInfo[]>
  saveAiProvider(input: AiProviderInput): Promise<AiProviderInfo>
  removeAiProvider(id: string): Promise<void>
  /** Checks the key with a tiny request. */
  testAiProvider(id: string): Promise<{ ok: boolean; message: string }>
  /** Sends the recording's sound to the provider and returns the transcript (source seconds). */
  transcribe(projectId: string, options: TranscribeOptions): Promise<Transcript>
  cancelTranscription(projectId: string): Promise<void>
  onTranscribeProgress(listener: (progress: TranscribeProgress) => void): () => void
  aiText(providerId: string, request: AiTextRequest): Promise<AiTextResult>
}
