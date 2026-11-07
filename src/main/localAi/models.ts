/**
 * The text models on disk (docs/design/smart-tools.md §9.4): downloads from the pinned sources, the
 * Use choice and the measured speeds. Part P4 writes this file; the contracts' stub gives its
 * exported names and the test catalogue's hook (§22 test 104): SSW_TEXT_MODEL_TEST_CATALOG is read
 * only when the app is not packaged.
 */
import { app } from 'electron'
import fs from 'node:fs'
import os from 'node:os'
import path from 'node:path'
import type { LocalAiState, LocalModelId } from '../../shared/api/localAi'
import type { LocalModelSpec } from '../../shared/localAi/catalog'

const NOT_IN_BUILD = 'AI on this PC is not part of this build.'

/** userData/text-models (§4.7). */
export const TEXT_MODELS_DIR = 'text-models'

export async function localAiState(): Promise<LocalAiState> {
  return { models: [], use: 'auto', active: null, pc: { totalMemBytes: os.totalmem(), freeMemBytes: os.freemem(), avx2: null, helper: false }, speeds: {} }
}

export async function downloadLocalModel(id: unknown, opts: { signal: AbortSignal; onProgress(s: LocalAiState): void }): Promise<LocalAiState> {
  void id
  void opts
  throw new Error(NOT_IN_BUILD)
}

export async function removeLocalModel(id: unknown): Promise<LocalAiState> {
  void id
  throw new Error(NOT_IN_BUILD)
}

export async function setLocalModelUse(use: unknown): Promise<LocalAiState> {
  void use
  throw new Error(NOT_IN_BUILD)
}

export async function blendSpeed(id: LocalModelId, readTps: number, writeTps: number): Promise<void> {
  void id
  void readTps
  void writeTps
}

/**
 * The catalogue a test names (a small model on a local server, for the e2e run): the JSON array in
 * the file SSW_TEXT_MODEL_TEST_CATALOG names, read only when the app is not packaged; null otherwise
 * or when the file cannot be read. Part P4 checks its entries.
 */
export function testCatalog(): readonly LocalModelSpec[] | null {
  if (app.isPackaged) return null
  const file = process.env.SSW_TEXT_MODEL_TEST_CATALOG
  if (!file) return null
  try {
    const raw = JSON.parse(fs.readFileSync(path.resolve(file), 'utf8')) as unknown
    return Array.isArray(raw) ? (raw as LocalModelSpec[]) : null
  } catch {
    return null
  }
}
