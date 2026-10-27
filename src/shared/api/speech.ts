/**
 * Captions on this PC (docs/design/offline-captions.md §5): the model manager and the state of
 * the speech engine and the speech detector, as the renderer sees them. The renderer names
 * models by catalog id only, never by path or address; the main process checks every argument.
 * Transcription itself goes through the AI API's `transcribe` with providerId
 * LOCAL_TRANSCRIBER_ID.
 */
import type { SpeechLicense, SpeechModelId, SpeechTier } from '../speech/catalog'

/**
 * The providerId of the built-in transcriber ("On this PC"). Stored providers' ids always
 * match /^ai[a-z0-9]{1,30}$/ (keyStore.ts), so this one can never collide with one.
 */
export const LOCAL_TRANSCRIBER_ID = 'local'

export const SPEECH_CHANNELS = {
  /** invoke → SpeechState */
  state: 'speech:state',
  /** invoke (id) → void, once the model is installed and verified; rejects with a message */
  download: 'speech:download',
  /** invoke (id, discard?: boolean) → void */
  cancelDownload: 'speech:cancelDownload',
  /** invoke (id) → void; refused while a transcription uses the model */
  remove: 'speech:remove',
  /** invoke (id) → void */
  setDefault: 'speech:setDefault',
  /** invoke → void: opens the models folder in the file manager */
  showFolder: 'speech:showFolder',
  /** send main → app page: SpeechState, whenever it changes (at most 4 a second while downloading) */
  changed: 'speech:changed'
} as const

/** Why a download failed. */
export type SpeechDownloadError =
  /** The server could not be reached, or the connection broke and the retries ran out. */
  | 'network'
  /** The server answered with an error (`status`). */
  | 'http'
  /** 403, 404 or 410: the file is not at its pinned address. */
  | 'missing'
  /** Size or SHA-256 did not match the pin: the file was deleted. */
  | 'mismatch'
  /** Not enough free space. */
  | 'disk'
  | 'other'

/** Where one model stands on this PC. */
export type SpeechModelStatus =
  | { state: 'missing' }
  | { state: 'downloading'; received: number; total: number; bytesPerSecond: number }
  | { state: 'verifying' }
  /** A download was cancelled or the app closed during one: the part already here is kept (Continue or Delete). */
  | { state: 'stopped'; received: number; total: number }
  | { state: 'installed' }
  /** The file on disk no longer matches its pin: it is never used (Download again). */
  | { state: 'damaged' }
  | { state: 'failed'; received: number; total: number; error: SpeechDownloadError; status?: number; message: string }

/** A catalog model as Settings and the Captions tab show it. */
export interface SpeechModelView {
  id: SpeechModelId
  tier: SpeechTier
  name: string
  bytes: number
  rtf4: number
  ramMB: number
  wer: number
  partSeconds: number
  license: SpeechLicense
  status: SpeechModelStatus
  /** A transcription is using it (it cannot be removed now). */
  inUse: boolean
  /** Whether this PC may download it (Whisper large-v3 turbo needs 8 GB of memory in all). */
  allowed: boolean
  /** Why not, when not allowed (a sentence to show). */
  reason?: string
  /** Processing time / audio time measured on this PC (absent until a part of at least 60 s ran). */
  measured?: { rtf: number; threads: number }
}

/** Why captions cannot be made on this PC. */
export type SpeechUnavailable =
  /** The helper is not part of this build (development without it, Linux packages). */
  | 'missing'
  /** Neither build of the helper runs on this processor. */
  | 'cpu'
  /** Windows or an antivirus refused to start the helper. */
  | 'blocked'
  /** The helper started but failed its check. */
  | 'failed'

export interface SpeechEngineInfo {
  available: boolean
  /** 'standard' (AVX2), 'compatible' (any x64 processor, slower) or 'host' (the development build); null when unavailable. */
  build: 'standard' | 'compatible' | 'host' | null
  /** Threads a transcription uses (speechThreads). */
  threads: number
  reason?: SpeechUnavailable
  /** More about the reason, for Settings. */
  detail?: string
}

export interface SpeechDetectorInfo {
  /** The bundled speech detector can run (helper and model present, model hash checked). */
  available: boolean
  /** Why not, as a sentence. */
  reason?: string
}

export interface SpeechState {
  engine: SpeechEngineInfo
  detector: SpeechDetectorInfo
  /** Every catalog model, in catalog order. */
  models: SpeechModelView[]
  /** The model used for new captions (the Captions tab's chips and Settings both set it). */
  defaultModel: SpeechModelId
  /** Free bytes on the drive of the models folder (null when unknown) and bytes the models use. */
  disk: { free: number | null; used: number }
  /** Bytes of memory in all and free now. */
  memory: { total: number; free: number }
  /** Logical processors. */
  cores: number
}

export interface SpeechApi {
  /** The current state; the first call also checks which build of the helper runs here. */
  getSpeechState(): Promise<SpeechState>
  /**
   * Downloads model `id` (or continues a stopped download) and verifies it. Resolves once it is
   * installed; rejects with a message to show ('Cancelled.' when cancelled). Starts only from a
   * click on a button that names the model and its size.
   */
  downloadSpeechModel(id: SpeechModelId): Promise<void>
  /** Stops the download of `id`; `discard` also deletes the part already downloaded. */
  cancelSpeechDownload(id: SpeechModelId, discard?: boolean): Promise<void>
  /** Deletes the model's file (and any part of a download). Rejects while a transcription uses it. */
  removeSpeechModel(id: SpeechModelId): Promise<void>
  /** The model used for new captions. */
  setDefaultSpeechModel(id: SpeechModelId): Promise<void>
  /** Opens the models folder in the file manager. */
  showSpeechModelsFolder(): Promise<void>
  /** Every change of the state (downloads in progress included); returns the unsubscribe function. */
  onSpeechState(listener: (state: SpeechState) => void): () => void
}
