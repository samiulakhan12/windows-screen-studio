/**
 * The text models of AI on this PC (docs/design/smart-tools.md §9.3): pinned by repository, commit,
 * bytes and SHA-256, Apache-2.0. Part P4 writes this file; the contracts' stub gives its types and
 * exported names so the other parts compile, with an empty catalogue.
 */
import type { AiTextTask } from '../api/ai'
import type { LocalModelId, LocalModelUse } from '../api/localAi'

export interface LocalModelSpec {
  id: LocalModelId
  name: string
  title: string
  hint: string
  file: string
  bytes: number
  sha256: string
  repo: string
  commit: string
  licence: 'Apache-2.0'
  maker: string
  family: 'qwen' | 'gemma'
  peakMB: number
  minTotalMemGB: number
  /** Default tokens a second read and written (§9.8). */
  read: number
  write: number
  loadS: number
  notes: Partial<Record<AiTextTask, string>>
}

/** Part P4 fills the catalogue (§9.3). */
export const LOCAL_MODELS: readonly LocalModelSpec[] = []

/** Qbexel's own mirror (§0 decision 2): null until it exists. */
export const LOCAL_MODEL_MIRROR: { repo: string; commit: string } | null = null

export function localModel(id: string): LocalModelSpec | undefined {
  return LOCAL_MODELS.find((m) => m.id === id)
}

export function localModelUrls(spec: LocalModelSpec): string[] {
  void spec
  return []
}

export function localModelBlock(spec: LocalModelSpec, pc: { totalMemBytes: number; avx2: boolean | null; helper: boolean }): 'memory' | 'processor' | 'helper' | null {
  void spec
  void pc
  return 'helper'
}

export function pickLocalModel(use: LocalModelUse, ready: readonly LocalModelId[], pc: { totalMemBytes: number; freeMemBytes: number; avx2: boolean | null; helper: boolean }): LocalModelId | null {
  void use
  void ready
  void pc
  return null
}

export function suggestedModel(pc: { totalMemBytes: number }): LocalModelId {
  void pc
  return 'gemma4-e2b'
}

export function llmThreads(logical: number): number {
  void logical
  return 1
}
