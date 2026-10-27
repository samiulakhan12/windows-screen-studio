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
  /** Whether it can transcribe sound (OpenAI and Gemini; Claude cannot). Added in wave 4. */
  canTranscribe?: boolean
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
  /** A provider's id, or LOCAL_TRANSCRIBER_ID ('local', api/speech.ts) for captions made on this PC. */
  providerId: string
  /** Spoken language hint (BCP-47); absent = detect. */
  language?: string
  /** Which sound to send: the microphone track when the recording kept it apart, else the mixed sound. */
  source?: 'auto' | 'mic' | 'mixed'
  /** On this PC only: the speech model (a catalog id, speech/catalog.ts); absent = the default model. Ignored for providers. */
  model?: string
}

export interface TranscribeProgress {
  projectId: string
  /** 'loading': on this PC, the speech model is being loaded (before the first part). */
  phase: 'extracting' | 'loading' | 'uploading' | 'transcribing' | 'finishing'
  /** Parts done of `total` (long recordings are sent in parts). */
  done: number
  total: number
  /** On this PC: share of the whole job done, 0..1 (providers send none: the parts tell). */
  fraction?: number
  /** On this PC: source seconds transcribed so far. */
  at?: number
  /** On this PC: the newest words heard, at most 120 characters. */
  preview?: string
  /** On this PC: parts reused from an earlier run that was cancelled or failed. */
  resumed?: number
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

/** "Draft script" (speaker notes): the presenter's notes or bullet points, sent only on that click. */
export interface ScriptDraftRequest {
  /** 1 to SCRIPT_DRAFT_MAX_NOTES characters, not only white space. */
  notes: string
}

/** A script to read aloud: paragraphs separated by a blank line, covering the notes' points in order. */
export interface ScriptDraftResult {
  text: string
}

/** Longest notes "Draft script" sends (characters). */
export const SCRIPT_DRAFT_MAX_NOTES = 20_000

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
  /**
   * Turns notes or bullet points into a script to read aloud with provider `providerId`. One
   * draft runs at a time: a new one cancels the one before. Rejects with a message to show.
   */
  draftScript(providerId: string, request: ScriptDraftRequest): Promise<ScriptDraftResult>
  /** Stops the draft in progress (it then rejects); nothing when none runs. */
  cancelScriptDraft(): Promise<void>
}

/** What each kind of provider is called, can do and uses by default (shown in Settings). */
export interface AiProviderKindInfo {
  kind: AiProviderKind
  label: string
  /** Whether its API accepts sound: the Claude API does not, so Claude cannot transcribe. */
  canTranscribe: boolean
  /** Default model for text tasks. */
  defaultModel: string
  /** Default transcription model (providers that can transcribe). */
  defaultTranscriptionModel?: string
  /** Where the user creates an API key. */
  keyPage: string
  /** How keys of this provider usually start, as a placeholder. */
  keyPlaceholder: string
}

export const AI_PROVIDER_KINDS: Record<AiProviderKind, AiProviderKindInfo> = {
  openai: {
    kind: 'openai',
    label: 'OpenAI',
    canTranscribe: true,
    defaultModel: 'gpt-6.1-sol',
    // The only OpenAI transcription model that returns segment and word timings (timestamp_granularities).
    defaultTranscriptionModel: 'whisper-1',
    keyPage: 'https://platform.openai.com/api-keys',
    keyPlaceholder: 'sk-…'
  },
  gemini: {
    kind: 'gemini',
    label: 'Google Gemini',
    canTranscribe: true,
    defaultModel: 'gemini-3.8-flash',
    defaultTranscriptionModel: 'gemini-3.8-flash',
    keyPage: 'https://aistudio.google.com/apikey',
    keyPlaceholder: 'AIza…'
  },
  anthropic: {
    kind: 'anthropic',
    label: 'Anthropic Claude',
    canTranscribe: false,
    defaultModel: 'claude-opus-5-5',
    keyPage: 'https://platform.claude.com/settings/keys',
    keyPlaceholder: 'sk-ant-…'
  }
}

export const AI_TEXT_TASKS: readonly AiTextTask[] = ['cleanup', 'translate', 'chapters', 'title', 'summary']

/** Limits of what the renderer may send (checked again in the main process). */
export const AI_LIMITS = {
  maxProviders: 20,
  labelLength: 60,
  keyLength: 400,
  modelLength: 100,
  maxSegments: 20000,
  segmentTextLength: 2000,
  languageLength: 60
} as const
