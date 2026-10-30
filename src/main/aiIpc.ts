/**
 * AI providers (OpenAI, Gemini, Claude) with the user's own API keys: key storage, transcription
 * of a recording's sound, and text tasks on its transcript. Keys stay in the main process: the
 * renderer only ever sees AiProviderInfo (with a masked key), and every request to a provider is
 * made from here (the renderer's CSP allows no network access). Every input is checked, and
 * only the app's own page may call these handlers.
 */
import { app, ipcMain, safeStorage, type IpcMainInvokeEvent } from 'electron'
import os from 'node:os'
import path from 'node:path'
import type { AiTextRequest, AiTextResult, ScriptDraftResult, TranscribeProgress } from '../shared/api/ai'
import { runTextTask, validateTextRequest } from '../shared/captions/transcriptText'
import { runScriptDraft, SCRIPT_EFFORT, validateScriptRequest } from '../shared/notes/scriptDraft'
import { AiProviderStore, type SecretBox } from './ai/keyStore'
import { clientFor } from './ai/providers'
import { stopAllTranscriptions, stopTranscription, sweepTranscribeTemp, transcribeProject } from './ai/transcribe'
import type { TextEffort } from './ai/types'
import { isAppUrl } from './security'
import { beginJob } from './longJobs'
import { modelDefaults } from './ai/modelList'

/** safeStorage (DPAPI on Windows). On Linux without a keyring it falls back to a fixed key: a packaged app refuses that. */
const secretBox: SecretBox = {
  isEncryptionAvailable: () => safeStorage.isEncryptionAvailable(),
  encryptString: (plain) => safeStorage.encryptString(plain),
  decryptString: (encrypted) => safeStorage.decryptString(encrypted),
  weakness: () =>
    process.platform === 'linux' && app.isPackaged && safeStorage.getSelectedStorageBackend() === 'basic_text' ? 'no system keyring is available' : null
}

let store: AiProviderStore | null = null
const providers = (): AiProviderStore => (store ??= new AiProviderStore(path.join(app.getPath('userData'), 'ai-providers.json'), secretBox, modelDefaults))

/** Text tasks in progress, stopped when the app quits. */
const textCalls = new Set<AbortController>()

const EFFORT: Record<AiTextRequest['task'], TextEffort> = {
  cleanup: 'medium',
  translate: 'medium',
  chapters: 'medium',
  title: 'low',
  summary: 'low',
  // The publishing copy pack (NW-13): the longer pieces think a little more than the posts.
  youtube: 'medium',
  linkedin: 'low',
  xpost: 'low',
  article: 'medium',
  releaseNotes: 'medium'
}

/** Text requests the renderer named (NW-13), so cancelAiText can stop one. */
const namedTextCalls = new Map<string, AbortController>()

/** A request id from the renderer: 1–64 of A-Z, a-z, 0-9, _ and -. Throws otherwise. */
export function readRequestId(raw: unknown): string | undefined {
  if (raw === undefined || raw === null) return undefined
  if (typeof raw !== 'string' || !/^[A-Za-z0-9_-]{1,64}$/.test(raw)) throw new Error('Invalid request id.')
  return raw
}

/**
 * Runs a text task on the transcript with provider `providerId`. With `requestId`, cancelAiText
 * stops it, and a second request with the same id stops the first.
 */
export async function aiText(providerId: unknown, raw: unknown, requestId?: unknown): Promise<AiTextResult> {
  const id = readRequestId(requestId)
  const request = validateTextRequest(raw)
  const controller = new AbortController()
  if (id) {
    namedTextCalls.get(id)?.abort()
    namedTextCalls.set(id, controller)
  }
  textCalls.add(controller)
  try {
    const { info, apiKey } = providers().get(providerId)
    const client = await clientFor(info, apiKey)
    controller.signal.throwIfAborted()
    return await runTextTask(request, (prompt) => client.json(prompt, { signal: controller.signal, effort: EFFORT[request.task] }))
  } finally {
    textCalls.delete(controller)
    if (id && namedTextCalls.get(id) === controller) namedTextCalls.delete(id)
  }
}

/** Stops text request `requestId`, if it runs. */
export function cancelAiText(requestId: unknown): void {
  const id = readRequestId(requestId)
  if (!id) return
  namedTextCalls.get(id)?.abort()
  namedTextCalls.delete(id)
}

/** The script draft in progress (one at a time: a new one, or Cancel, stops it). */
let scriptDraft: AbortController | null = null

/** Turns the presenter's notes into a script to read aloud with provider `providerId` ("Draft script"). */
export async function draftScript(providerId: unknown, raw: unknown): Promise<ScriptDraftResult> {
  const request = validateScriptRequest(raw)
  scriptDraft?.abort()
  const controller = new AbortController()
  scriptDraft = controller
  textCalls.add(controller)
  try {
    const { info, apiKey } = providers().get(providerId)
    const client = await clientFor(info, apiKey)
    controller.signal.throwIfAborted()
    return await runScriptDraft(request, (prompt) => client.json(prompt, { signal: controller.signal, effort: SCRIPT_EFFORT }))
  } finally {
    textCalls.delete(controller)
    if (scriptDraft === controller) scriptDraft = null
  }
}

/** Stops the script draft in progress, if any. */
export function cancelScriptDraft(): void {
  scriptDraft?.abort()
  scriptDraft = null
}

/** Checks provider `id`'s key with a tiny request; never throws. */
export async function testAiProvider(id: unknown): Promise<{ ok: boolean; message: string }> {
  try {
    const { info, apiKey } = providers().get(id)
    const message = await (await clientFor(info, apiKey)).test(AbortSignal.timeout(60_000))
    return { ok: true, message }
  } catch (err) {
    return { ok: false, message: err instanceof Error ? err.message : String(err) }
  }
}

/** Only the app's own page may use the user's keys. */
function fromApp(e: IpcMainInvokeEvent): void {
  if (!isAppUrl(e.senderFrame?.url ?? '')) throw new Error('Not allowed')
}

export function registerAiIpc(): void {
  ipcMain.handle('ai:listProviders', (e) => {
    fromApp(e)
    return providers().list()
  })
  ipcMain.handle('ai:saveProvider', (e, input: unknown) => {
    fromApp(e)
    return providers().save(input)
  })
  ipcMain.handle('ai:removeProvider', (e, id: unknown) => {
    fromApp(e)
    providers().remove(id)
  })
  ipcMain.handle('ai:testProvider', (e, id: unknown) => {
    fromApp(e)
    return testAiProvider(id)
  })
  ipcMain.handle('ai:transcribe', async (e, projectId: unknown, options: unknown) => {
    fromApp(e)
    const sender = e.sender
    // A long job (F-12): taskbar progress, Stop on its thumbnail (keeps the parts made), PC kept awake.
    let stopped = false
    const job = beginJob({
      kind: 'captions',
      onStop: () => {
        if (typeof projectId !== 'string') return
        stopped = true
        void stopTranscription(projectId)
      }
    })
    const progress = (p: TranscribeProgress): void => {
      job.update({ fraction: typeof p.fraction === 'number' ? p.fraction : p.total > 0 ? p.done / p.total : null })
      if (!sender.isDestroyed()) sender.send('ai:transcribeProgress', p)
    }
    // The job belongs to the page that asked: a reload, a navigation (in-page route changes are
    // 'did-navigate-in-page') or a dead page stops it as Cancel does, which keeps the parts made.
    const gone = (): void => {
      if (typeof projectId === 'string') void stopTranscription(projectId)
    }
    const events = ['did-navigate', 'destroyed', 'render-process-gone'] as const
    for (const name of events) sender.once(name as 'destroyed', gone)
    try {
      const transcript = await transcribeProject(providers(), projectId, options, progress)
      void job.end({ kind: 'done' })
      return transcript
    } catch (err) {
      const cancel = stopped || (err as { failure?: { kind?: unknown } } | null)?.failure?.kind === 'cancelled'
      void job.end(cancel ? { kind: 'cancelled' } : { kind: 'failed', message: err instanceof Error ? err.message : String(err) })
      throw err
    } finally {
      for (const name of events) sender.removeListener(name as 'destroyed', gone)
    }
  })
  ipcMain.handle('ai:cancelTranscription', (e, projectId: unknown) => {
    fromApp(e)
    return typeof projectId === 'string' ? stopTranscription(projectId) : undefined
  })
  ipcMain.handle('ai:text', async (e, providerId: unknown, request: unknown, requestId: unknown) => {
    fromApp(e)
    // A named request belongs to the page that asked: a reload, a navigation or a dead page stops it.
    const sender = e.sender
    const id = readRequestId(requestId)
    const gone = (): void => cancelAiText(id)
    const events = ['did-navigate', 'destroyed', 'render-process-gone'] as const
    if (id) for (const name of events) sender.once(name as 'destroyed', gone)
    try {
      return await aiText(providerId, request, id)
    } finally {
      if (id) for (const name of events) sender.removeListener(name as 'destroyed', gone)
    }
  })
  ipcMain.handle('ai:cancelText', (e, requestId: unknown) => {
    fromApp(e)
    cancelAiText(requestId)
  })
  ipcMain.handle('ai:draftScript', (e, providerId: unknown, request: unknown) => {
    fromApp(e)
    return draftScript(providerId, request)
  })
  ipcMain.handle('ai:cancelScriptDraft', (e) => {
    fromApp(e)
    cancelScriptDraft()
  })
  // Requests and ffmpeg must not outlive the app, nor their temporary files.
  void sweepTranscribeTemp(os.tmpdir())
  app.on('will-quit', () => {
    stopAllTranscriptions()
    for (const c of textCalls) c.abort()
  })
}
