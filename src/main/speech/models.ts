/**
 * The speech models on this PC (docs/design/offline-captions.md §3.1, §4): userData/speech-models
 * holds the catalog's files, their .part downloads and speech.json (the default model, which
 * files were verified at which size and time, and the speed measured on this PC). Only catalog
 * files whose pin matched are ever handed out. Workstream B's own module (it may change).
 */
import type { SpeechModelView } from '../../shared/api/speech'
import type { SpeechModelId } from '../../shared/speech/catalog'

/** speech.json, as stored. */
export interface SpeechSettingsFile {
  version: 1
  defaultModel: SpeechModelId
  /** Files whose SHA-256 matched their pin, with the size and modification time they had then. */
  verified: Partial<Record<SpeechModelId, { bytes: number; mtimeMs: number }>>
  /** Processing time / audio time measured on this PC (parts of 60 s or more), smoothed. */
  measured: Partial<Record<SpeechModelId, { rtf: number; threads: number }>>
}

export const SPEECH_DIR = 'speech-models'
export const SPEECH_SETTINGS_FILE = 'speech.json'
/** .part files untouched for this long are deleted at startup. */
export const STALE_PART_MS = 30 * 24 * 3600_000

/** speech.json from anything: an unknown default becomes DEFAULT_SPEECH_MODEL, odd entries are dropped. */
export function sanitizeSpeechSettings(raw: unknown): SpeechSettingsFile {
  void raw
  throw new Error('sanitizeSpeechSettings: not implemented yet (workstream B)')
}

export class SpeechModelStore {
  constructor(readonly dir: string) {}

  /** Every catalog model with its status on this PC. */
  async views(): Promise<SpeechModelView[]> {
    throw new Error('SpeechModelStore.views: not implemented yet (workstream B)')
  }

  /** The verified file of `id` (hashed again when its size or time changed); rejects with a message when missing or damaged. */
  async installedFile(id: SpeechModelId): Promise<string> {
    void id
    throw new Error('SpeechModelStore.installedFile: not implemented yet (workstream B)')
  }

  /** Marks `id` in use while a transcription runs; returns the release function (Remove is refused meanwhile). */
  hold(id: SpeechModelId): () => void {
    void id
    return () => undefined
  }
}
