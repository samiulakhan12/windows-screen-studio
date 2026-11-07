import type { ModelList } from '../ai/modelList'
import type { PriceList } from '../ai/prices'
import type { AiProviderKind, CaptionSegment, Transcript } from '../types'
import type { PublishLength, PublishTone } from '../publish/pack'

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
  /** A service reached at a base URL (docs/design/smart-tools.md §10): `kind` is then 'openai', the API it speaks. */
  service?: ServiceInfo
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
  /** A service (§10.1): saved to ai-services.json, never to ai-providers.json; `kind` must be 'openai'. */
  service?: { preset: ServicePreset; baseUrl: string; keepNoData?: boolean }
}

/** The id of AI on this PC among text providers (§9.6): the same string as LOCAL_TRANSCRIBER_ID; stored ids (^ai…, ^svc…) never collide with it. */
export const LOCAL_TEXT_ID = 'local'

/** The services More services offers (§10.5). */
export type ServicePreset = 'azure' | 'openrouter' | 'groq' | 'together' | 'ollama' | 'lmstudio' | 'other'

/** A service as the renderer sees it (§10.1): never its key. */
export interface ServiceInfo {
  preset: ServicePreset
  /** Normalised (§10.2). */
  baseUrl: string
  /** ASCII (an internationalised name in its xn-- form): where the key and the text go. */
  host: string
  /** localhost, 127.0.0.0/8 or [::1]: plain http allowed, the key optional. */
  loopback: boolean
  /** How it answers in JSON, found by Save and check (§10.3): 'text' until checked. */
  json: 'schema' | 'object' | 'text'
  /** OpenRouter: provider.data_collection 'deny' is sent (§0 decision 5). */
  keepNoData?: true
}

/**
 * One choice in a text tool's provider list (§20.0): a provider, a service, or On this PC. `place`
 * is the one name every hint and cost line uses: "OpenAI", "api.groq.com", "Ollama on this PC" or
 * "this PC".
 */
export interface TextChoice {
  /** A provider's or service's id, or LOCAL_TEXT_ID. */
  id: string
  label: string
  kind: AiProviderKind | 'local'
  model: string
  /** A service's host. */
  host?: string
  place: string
  /** No cost: a free model, or Ollama or LM Studio on this PC (§11.5). */
  free?: true
  /** It can send pictures (§5.3.1): a service or built-in provider, never On this PC. */
  pictures?: boolean
}

/** Whose models to list (§10.4): a saved provider or service, or a form not saved yet. */
export type ModelListTarget = { providerId: string } | { draft: AiProviderInput }

/** One model of a provider's list. */
export interface ListedModel {
  id: string
  /** US$ per million tokens (OpenRouter), or 'varies' for its router models. */
  prices?: { input: number; output: number } | 'varies'
  /** It accepts a strict JSON schema (OpenRouter's structured_outputs). */
  schema?: boolean
}

/** Tokens a provider reported for an action's requests, summed (§11.6). */
export interface AiUsage {
  input: number
  output: number
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
  /** The caption word list's terms (prefs captionWordList), a spelling hint for every route (Captions Studio §11.7 rule 4). */
  glossary?: string[]
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

/**
 * 'marks' (Captions Studio §11.2): emphasis, emoji, numbers, lists and quotes picked by word
 * index, checked by validateMarksAnswer (transcriptText.ts).
 */
export type AiTextTask = 'cleanup' | 'translate' | 'chapters' | 'title' | 'summary' | 'marks' | PackTextTask | 'names'

/** The publishing copy pack's own tasks (NW-13, docs/design/publish-pack.md). */
export type PackTextTask = 'youtube' | 'linkedin' | 'xpost' | 'article' | 'releaseNotes'

export interface AiTextRequest {
  task: AiTextTask
  /** The captions to work on (source seconds). */
  segments: CaptionSegment[]
  /** For 'translate'. */
  targetLanguage?: string
  /** For the pack's tasks (NW-13): how it sounds and how long it is (others ignore them). */
  tone?: PublishTone
  length?: PublishLength
  /** For the pack's tasks: the recording's name and its chapter titles, sent as data. */
  context?: { title?: string; chapters?: string[] }
  /** For 'marks': the words of each caption, sent as data. */
  marks?: MarksBatch
  /** For 'names' (smart-tools.md §5.3, §5.4, §7.6, §8.4): what to name, sent as data; `segments` may be empty. */
  names?: NamesRequest
  /** Lets cancelAiText and the progress of AI on this PC find this request (§20.0). */
  requestId?: string
}

/**
 * The 'names' task: a short name for each item from the words said in it (a chapter, a short clip,
 * a guide's step) or a short note (a step's note). `action` is a step's action in words ("click,
 * top right of the screen"); `image` its screenshot as JPEG (§5.3.1, part P6).
 */
export interface NamesRequest {
  kind: 'chapter' | 'clip' | 'step' | 'note'
  language?: string
  items: { id: string; text: string; action?: string; image?: Uint8Array }[]
}

/**
 * One batch of the 'marks' task (Captions Studio §11.2): each caption's words as studioWordTexts
 * splits them, numbered from 0. No times are sent.
 */
export interface MarksBatch {
  language?: string
  captions: { id: string; w: string[] }[]
}

/**
 * The 'marks' answer as validateMarksAnswer leaves it: word indexes and listed emoji only, so
 * nothing the provider writes can reach the video (§11.2).
 */
export interface MarksAnswer {
  captions: { id: string; emphasis: number[]; emoji: string; emojiWord: number }[]
  numbers: { id: string; from: number; to: number }[]
  lists: { id: string; from: number; to: number; items: { id: string; from: number; to: number }[] }[]
  quotes: { id: string; from: number; to: number }[]
}

export type AiTextResult =
  /** 'cleanup' and 'translate': the same segments (ids and times kept), new text. */
  | { task: 'cleanup' | 'translate'; segments: CaptionSegment[] }
  /** 'chapters': chapter starts (source seconds) with titles. */
  | { task: 'chapters'; chapters: { t: number; title: string }[] }
  | { task: 'title' | 'summary'; text: string }
  /** 'marks': the checked picks. */
  | { task: 'marks'; answer: MarksAnswer }
  /** The pack (NW-13): checked, cleaned plain text; the YouTube description's text has no chapters (Flown adds them). */
  | { task: 'youtube'; text: string; tags: string[] }
  | { task: 'linkedin' | 'xpost' | 'article' | 'releaseNotes'; text: string }
  /** 'names': a checked name for each item named (validateNamesAnswer: known ids once, no private-like text). */
  | { task: 'names'; names: { id: string; name: string }[] }

/** "Draft script" (speaker notes): the presenter's notes or bullet points, sent only on that click. */
export interface ScriptDraftRequest {
  /** 1 to SCRIPT_DRAFT_MAX_NOTES characters, not only white space. */
  notes: string
  /** Lets cancelAiText stop this draft, as it stops aiText's requests (smart-tools.md §20.0). */
  requestId?: string
}

/** A script to read aloud: paragraphs separated by a blank line, covering the notes' points in order. */
export interface ScriptDraftResult {
  text: string
}

/** Longest notes "Draft script" sends (characters). */
export const SCRIPT_DRAFT_MAX_NOTES = 20_000

export interface AiApi {
  listAiProviders(): Promise<AiProviderInfo[]>
  /** The suggested models and the retiring ones (NW-15; bundled, or refreshed from GitHub). */
  getAiModelList(): Promise<ModelList>
  saveAiProvider(input: AiProviderInput): Promise<AiProviderInfo>
  removeAiProvider(id: string): Promise<void>
  /** Checks the key with a tiny request. */
  testAiProvider(id: string): Promise<{ ok: boolean; message: string }>
  /** Sends the recording's sound to the provider and returns the transcript (source seconds). */
  transcribe(projectId: string, options: TranscribeOptions): Promise<Transcript>
  cancelTranscription(projectId: string): Promise<void>
  onTranscribeProgress(listener: (progress: TranscribeProgress) => void): () => void
  /**
   * `requestId` (optional, `^[A-Za-z0-9_-]{1,64}$`) lets cancelAiText stop it; a second request with
   * the same id stops the first. `providerId` may be LOCAL_TEXT_ID (AI on this PC). `usage`: the
   * tokens the provider reported for its requests, summed, when it reported them.
   */
  aiText(providerId: string, request: AiTextRequest, requestId?: string): Promise<AiTextResult & { usage?: AiUsage }>
  /** Stops text request `requestId` (it then rejects); nothing when none runs. */
  cancelAiText(requestId: string): Promise<void>
  /**
   * Turns notes or bullet points into a script to read aloud with provider `providerId`. One
   * draft runs at a time: a new one cancels the one before. Rejects with a message to show.
   */
  draftScript(providerId: string, request: ScriptDraftRequest): Promise<ScriptDraftResult>
  /** Stops the draft in progress (it then rejects); nothing when none runs. */
  cancelScriptDraft(): Promise<void>
  /** The models a provider, a service or a form not saved yet can use (§10.4); rejects with a message to show. */
  listModels(target: ModelListTarget): Promise<ListedModel[]>
  /** The price list (§11.4): the newer of the bundled and downloaded lists. */
  getAiPriceList(): Promise<PriceList>
}

/** Smart tools' AI channels (§20.0, §21). */
export const AI_SMART_CHANNELS = {
  /** invoke (target) → ListedModel[]: part P5's listModels */
  listModels: 'ai:listModels',
  /** invoke () → PriceList: part P5's priceList().shown */
  priceList: 'ai:priceList'
} as const

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
    // OpenAI retires it on 26 February 2027: near that day the model list suggests gpt-transcribe
    // instead (docs/design/transcription.md §2.1).
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

export const AI_TEXT_TASKS: readonly AiTextTask[] = ['cleanup', 'translate', 'chapters', 'title', 'summary', 'marks', 'youtube', 'linkedin', 'xpost', 'article', 'releaseNotes', 'names']

/** Limits of what the renderer may send (checked again in the main process). */
export const AI_LIMITS = {
  maxProviders: 20,
  labelLength: 60,
  keyLength: 400,
  modelLength: 100,
  maxSegments: 20000,
  segmentTextLength: 2000,
  languageLength: 60,
  /**
   * The 'names' task (§20.0): at most 200 items of 1,500 characters and an action of 80, 320,000
   * characters in all; pictures JPEG, at most 512 KB each, 50 a request and 200 in all.
   */
  names: { items: 200, text: 1500, total: 320_000, action: 80, image: 512 * 1024, imagesPerRequest: 50, images: 200 }
} as const
