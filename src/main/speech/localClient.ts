/**
 * "On this PC" as a transcription client of the existing pipeline (ai/transcribe.ts runJob,
 * docs/design/offline-captions.md §3.2): each part is a 16 kHz mono WAV transcribed by one run
 * of the speech helper, cached in the project's .cache/transcript-parts by its content, so a
 * cancelled or failed job continues where it stopped. Workstream B's own module (it may change).
 */
import type { SpeechModelSpec } from '../../shared/speech/catalog'
import type { AiClient } from '../ai/types'

export interface LocalClientDeps {
  /** The project's folder (its .cache holds finished parts). */
  projectDir: string
}

/** The client for model `modelId` (absent: the default model); rejects with a message when the engine or the model is not ready. */
export async function localSpeechClient(modelId: string | undefined, deps: LocalClientDeps): Promise<AiClient> {
  void modelId
  void deps
  throw new Error('Captions on this PC are not available yet.')
}

/** Cache key of a finished part: its WAV's SHA-256, the model's SHA-256, the language asked for and ENGINE_VERSION. */
export function partCacheKey(partSha256: string, spec: Pick<SpeechModelSpec, 'sha256'>, language: string | undefined, engine: string): string {
  void partSha256
  void spec
  void language
  void engine
  throw new Error('partCacheKey: not implemented yet (workstream B)')
}
