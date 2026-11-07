/**
 * AI on this PC (docs/design/smart-tools.md §2.5, §9): the text models Flown downloads and runs in
 * its bundled helper. The channels are fixed here (contracts); part P4's localAiIpc.ts registers
 * their handlers, each checking its sender and taking only catalogue ids.
 */

/** The models of the catalogue (§9.3): Recommended and Small. */
export type LocalModelId = 'gemma4-e2b' | 'qwen3.5-2b'
/** Settings › AI on this PC › Use: Automatic, or one model pinned. */
export type LocalModelUse = 'auto' | LocalModelId

/** One model as Settings shows it. */
export interface LocalModelState {
  id: LocalModelId
  state: 'missing' | 'downloading' | 'ready' | 'damaged'
  /** The model file's size. */
  bytes: number
  /** While downloading: bytes so far. */
  done?: number
  /** Why this PC cannot use it (§9.5), or null. */
  block: 'memory' | 'processor' | 'helper' | null
}

export interface LocalAiState {
  models: LocalModelState[]
  use: LocalModelUse
  /** The model a run would use now (pickLocalModel), or null. */
  active: LocalModelId | null
  /** `avx2` null: the processor could not be checked (§9.5). `helper`: ssw-llm.exe is part of this build. */
  pc: { totalMemBytes: number; freeMemBytes: number; avx2: boolean | null; helper: boolean }
  /** Measured tokens a second, blended per model (§9.8). */
  speeds: Partial<Record<LocalModelId, { read: number; write: number }>>
}

/** Progress of a request to AI on this PC, sent to the page that asked, by its request id (§9.2). */
export interface LocalAiProgress {
  requestId?: string
  phase: 'waiting' | 'loading' | 'reading' | 'writing'
  done: number
  total: number
  secondsLeft?: number
}

export interface LocalAiApi {
  localAiState(): Promise<LocalAiState>
  /** Downloads a model from its pinned sources (§9.4); resolves when it is ready, rejects with a message to show. */
  downloadLocalModel(id: LocalModelId): Promise<LocalAiState>
  cancelLocalDownload(id: LocalModelId): Promise<void>
  removeLocalModel(id: LocalModelId): Promise<LocalAiState>
  setLocalModelUse(use: LocalModelUse): Promise<LocalAiState>
  /** The state when it changes (downloads at most every 250 ms); returns an unsubscribe function. */
  onLocalAiState(listener: (s: LocalAiState) => void): () => void
  /** Progress of this page's requests; returns an unsubscribe function. */
  onLocalAiProgress(listener: (p: LocalAiProgress) => void): () => void
}

/** The channels (§9.4). */
export const LOCAL_AI_CHANNELS = {
  /** invoke () → LocalAiState */
  state: 'localAi:state',
  /** invoke (id) → LocalAiState */
  download: 'localAi:download',
  /** invoke (id) → void */
  cancel: 'localAi:cancel',
  /** invoke (id) → LocalAiState */
  remove: 'localAi:remove',
  /** invoke (use) → LocalAiState */
  setUse: 'localAi:setUse',
  /** event LocalAiState, at most every 250 ms */
  changed: 'localAi:changed',
  /** event LocalAiProgress, to the page that asked */
  progress: 'localAi:progress'
} as const
