/**
 * The one model store of the app and the state the renderer sees (SpeechState), shared by the
 * IPC handlers (speechIpc.ts), the local transcription client and the speech detector.
 * Workstream B's own module.
 */
import { app } from 'electron'
import { promises as fs } from 'node:fs'
import os from 'node:os'
import path from 'node:path'
import type { SpeechEngineInfo, SpeechState } from '../../shared/api/speech'
import { speechThreads } from '../../shared/speech/catalog'
import { probedProcessor, selectHelper, type HelperChoice } from './helper'
import { SPEECH_DIR, SpeechModelStore } from './models'
import { detectorInfo } from './vad'

let store: SpeechModelStore | null = null
let choice: HelperChoice | null = null
const listeners = new Set<() => void>()

/** Logical processors (the probe's count when it ran). */
export const cores = (): number => probedProcessor()?.logical || os.cpus().length || 1

/** The test hook for downloads: unpackaged only. */
export const modelBaseUrl = (): string | null => (app.isPackaged ? null : process.env.SSW_SPEECH_MODEL_BASE_URL || null)

/** Free bytes on the drive of `dir` (its nearest existing folder); null when unknown. */
export async function freeBytes(dir: string): Promise<number | null> {
  let at = dir
  for (let i = 0; i < 32; i++) {
    const st = await fs.statfs(at).catch(() => null)
    if (st) return Number(st.bavail) * Number(st.bsize)
    const up = path.dirname(at)
    if (up === at) return null
    at = up
  }
  return null
}

/** The build running here, once the probe ran (null before or when unavailable). */
export const currentBuild = (): 'standard' | 'compatible' | 'host' | null => (choice && 'build' in choice ? choice.build : null)

export function speechStore(): SpeechModelStore {
  store ??= new SpeechModelStore(path.join(app.getPath('userData'), SPEECH_DIR), {
    pc: () => ({ totalMemBytes: os.totalmem(), build: currentBuild() }),
    baseUrl: modelBaseUrl(),
    freeBytes,
    onChange: () => notifySpeechChanged()
  })
  return store
}

/** The helper choice (the first call runs the CPU probe). */
export async function engineChoice(): Promise<HelperChoice> {
  choice = await selectHelper()
  return choice
}

export async function engineInfo(): Promise<SpeechEngineInfo> {
  const c = await engineChoice()
  const threads = speechThreads(cores())
  return 'build' in c ? { available: true, build: c.build, threads } : { available: false, build: null, threads, reason: c.error, detail: c.detail }
}

export async function speechState(): Promise<SpeechState> {
  const s = speechStore()
  const [engine, detector, models, used, free] = await Promise.all([engineInfo(), detectorInfo(), s.views(), s.used(), freeBytes(s.dir)])
  return { engine, detector, models, defaultModel: s.defaultModel(), disk: { free, used }, memory: { total: os.totalmem(), free: os.freemem() }, cores: cores() }
}

/** Something in the state changed (speechIpc throttles what it sends). */
export function notifySpeechChanged(): void {
  for (const l of listeners) l()
}

export function onSpeechChanged(listener: () => void): () => void {
  listeners.add(listener)
  return () => listeners.delete(listener)
}
