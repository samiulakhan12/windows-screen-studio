/**
 * Which transcriber makes captions when nobody chose one (docs/design/offline-captions.md §3.6):
 * the Captions tab's default and E-01 "Polish in one click". Pure, frozen.
 */
import type { AiProviderInfo } from '../api/ai'
import { LOCAL_TRANSCRIBER_ID, type SpeechState } from '../api/speech'
import type { SpeechModelId } from './catalog'

export type TranscriberChoice =
  /** On this PC with `model`; `ready` when the engine runs here and the model is installed (else a download needs the user's consent first). */
  | { kind: 'local'; model: SpeechModelId; ready: boolean }
  /** A provider with the user's key that can transcribe. */
  | { kind: 'key'; providerId: string }

/** What E-01 shows when it has to leave captions out. */
export const CAPTIONS_SKIPPED_NO_MODEL = 'Captions skipped: download a speech model in the Captions tab (free, 60 MB) or add an AI provider.'

/**
 * The model "On this PC" uses: the default model when it is installed, else the first
 * installed model in catalog order, else the default model (not installed).
 */
export function localModel(speech: Pick<SpeechState, 'defaultModel' | 'models'>): { model: SpeechModelId; installed: boolean } {
  const installed = (id: SpeechModelId): boolean => speech.models.some((m) => m.id === id && m.status.state === 'installed')
  if (installed(speech.defaultModel)) return { model: speech.defaultModel, installed: true }
  const other = speech.models.find((m) => m.status.state === 'installed')
  return other ? { model: other.id, installed: true } : { model: speech.defaultModel, installed: false }
}

/**
 * The transcriber to use, in this order:
 * 1. `remembered` (this session's choice in the Captions tab) when it is still possible;
 * 2. On this PC when a model is installed (installing one was consent to use it);
 * 3. the first provider with a key that can transcribe (no surprise for people who use one);
 * 4. On this PC, not ready (the Captions tab offers the download);
 * 5. null: nothing can transcribe here.
 * `providers` and `speech` are null while unknown (not read yet, or failed); a null `speech`
 * means On this PC is unavailable. E-01 transcribes only a key choice or a ready local one,
 * never starting a download.
 */
export function pickTranscriber(providers: readonly AiProviderInfo[] | null, speech: SpeechState | null, remembered = ''): TranscriberChoice | null {
  const capable = (providers ?? []).filter((p) => !!p.transcriptionModel)
  const local = speech?.engine.available ? localModel(speech) : null
  if (remembered === LOCAL_TRANSCRIBER_ID && local) return { kind: 'local', model: local.model, ready: local.installed }
  if (remembered && capable.some((p) => p.id === remembered)) return { kind: 'key', providerId: remembered }
  if (local?.installed) return { kind: 'local', model: local.model, ready: true }
  if (capable.length > 0) return { kind: 'key', providerId: capable[0].id }
  if (local) return { kind: 'local', model: local.model, ready: false }
  return null
}

/** Whether `choice` can transcribe right now without asking anything (E-01 runs only these). */
export const canTranscribeNow = (choice: TranscriberChoice | null): boolean => !!choice && (choice.kind === 'key' || choice.ready)
