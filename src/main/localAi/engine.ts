/**
 * The bundled helper ssw-llm.exe, one request at a time (docs/design/smart-tools.md §9.2). Part P4
 * writes this file; the contracts' stub gives its exported names and the helper's path with its
 * test hook (§22 test 104): SSW_LLM_HELPER is read only when the app is not packaged.
 */
import { app } from 'electron'
import type { spawn } from 'node:child_process'
import fs from 'node:fs'
import path from 'node:path'
import type { LocalAiProgress } from '../../shared/api/localAi'
import type { ChatPart } from '../../shared/localAi/chatFormat'
import type { LocalModelSpec } from '../../shared/localAi/catalog'

const NOT_IN_BUILD = 'AI on this PC is not part of this build.'

export class LlmEngine {
  constructor(opts: { helper: string; dir: string; spawn?: typeof spawn; idleMs?: number; graceMs?: number; stallMs?: number }) {
    void opts
  }

  run(req: {
    spec: LocalModelSpec
    parts: readonly ChatPart[]
    grammar: string
    maxTokens: number
    signal: AbortSignal
    onProgress(p: LocalAiProgress): void
  }): Promise<{ text: string; prompt: number; output: number; readMs: number; writeMs: number }> {
    void req
    return Promise.reject(new Error(NOT_IN_BUILD))
  }

  unload(): Promise<void> {
    return Promise.resolve()
  }

  dispose(): Promise<void> {
    return Promise.resolve()
  }
}

const isFile = (file: string): boolean => {
  try {
    return fs.statSync(file).isFile()
  } catch {
    return false
  }
}

/**
 * The helper of this build, or null when it is missing: packaged, process.resourcesPath/native/
 * ssw-llm.exe (beside the speech helpers); in development native/bin/ssw-llm[.exe]. SSW_LLM_HELPER
 * (a file: a fake helper for tests) replaces it only when the app is not packaged.
 */
export function llmHelperPath(): string | null {
  if (app.isPackaged) {
    const exe = path.join(process.resourcesPath, 'native', 'ssw-llm.exe')
    return isFile(exe) ? exe : null
  }
  const override = process.env.SSW_LLM_HELPER
  if (override) return isFile(override) ? override : null
  const dev = path.join(app.getAppPath(), 'native', 'bin', process.platform === 'win32' ? 'ssw-llm.exe' : 'ssw-llm')
  return isFile(dev) ? dev : null
}
