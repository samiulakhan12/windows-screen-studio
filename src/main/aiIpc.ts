/**
 * AI providers (OpenAI, Gemini, Claude) with the user's own API keys: key storage, transcription
 * of a recording's sound, and text tasks on its transcript. Keys stay in the main process: the
 * renderer only ever sees AiProviderInfo (with a masked key), and every request to a provider is
 * made from here (the renderer's CSP allows no network access). Every input is checked, and
 * only the app's own page may call these handlers.
 *
 * Smart tools (docs/design/smart-tools.md §20.0): text requests to LOCAL_TEXT_ID go to AI on this PC
 * (part P4's localTextClient) before any key lookup; ids of services (`svc…`) go to their own store
 * (part P5's ServiceStore, ai-services.json) and client; ai-providers.json is read and written
 * exactly as before. The tokens a provider reports are summed into the result.
 */
import { app, ipcMain, safeStorage, type IpcMainInvokeEvent, type WebContents } from 'electron'
import os from 'node:os'
import path from 'node:path'
import { AI_LIMITS, AI_SMART_CHANNELS, LOCAL_TEXT_ID, type AiProviderInfo, type AiTextRequest, type AiTextResult, type AiUsage, type ScriptDraftResult, type TranscribeProgress } from '../shared/api/ai'
import { DEFAULT_TEXT_LIMITS, runTextTask, validateTextRequest, type TextLimits, type TextPrompt } from '../shared/captions/transcriptText'
import { runScriptDraft, SCRIPT_EFFORT, validateScriptRequest } from '../shared/notes/scriptDraft'
import { AiProviderStore, type SecretBox } from './ai/keyStore'
import { clientFor } from './ai/providers'
import { stopAllTranscriptions, stopTranscription, sweepTranscribeTemp, transcribeProject } from './ai/transcribe'
import { NO_PICTURES_MESSAGE, type AiClient, type TextEffort } from './ai/types'
import { isAppUrl } from './security'
import { beginJob } from './longJobs'
import { modelDefaults } from './ai/modelList'
import { ServiceStore } from './ai/serviceStore'
import { listModels } from './ai/modelLists'
import { priceList } from './ai/priceList'
import { localTextClient } from './localAi/localTextClient'

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

/** Services (smart-tools.md §10.1): their own file, so an older Flown never reads or rewrites them. */
let serviceStore: ServiceStore | null = null
const services = (): ServiceStore => (serviceStore ??= new ServiceStore(path.join(app.getPath('userData'), 'ai-services.json'), secretBox))

/** A service's id (`svc…`): stored ids of the two stores never collide, nor with LOCAL_TEXT_ID. */
const isServiceId = (id: unknown): boolean => typeof id === 'string' && id.startsWith('svc')

/** Every provider, then every service (§10.1). */
export function listAiProviders(): AiProviderInfo[] {
  return [...providers().list(), ...services().list()].slice(0, AI_LIMITS.maxProviders)
}

/** The tasks AI on this PC never runs (decision 18): Find chapters chooses, the model only names. */
const NOT_ON_THIS_PC: readonly AiTextRequest['task'][] = ['chapters', 'marks']
export const NOT_ON_THIS_PC_MESSAGE = 'Not available on this PC: choose an AI service for this.'

/**
 * The client for `providerId` and the limits it runs a request with: AI on this PC (LOCAL_TEXT_ID)
 * without any key lookup, a service from its store, else a provider with its key.
 */
async function textClient(providerId: unknown, request: AiTextRequest | null, ctx: { sender?: WebContents; requestId?: string }): Promise<{ client: AiClient; limits: TextLimits }> {
  if (providerId === LOCAL_TEXT_ID) {
    if (request && NOT_ON_THIS_PC.includes(request.task)) throw new Error(NOT_ON_THIS_PC_MESSAGE)
    if (!ctx.sender) throw new Error('AI on this PC runs from the editor only.')
    const client = await localTextClient({ sender: ctx.sender, ...(ctx.requestId ? { requestId: ctx.requestId } : {}) })
    return { client, limits: request ? client.limits(request) : DEFAULT_TEXT_LIMITS }
  }
  const { info, apiKey } = isServiceId(providerId) ? services().get(providerId) : providers().get(providerId)
  return { client: await clientFor(info, apiKey, services()), limits: DEFAULT_TEXT_LIMITS }
}

/** Tokens a provider reported, summed over an action's requests; null until one is reported. */
function usageMeter(): { onUsage: (u: AiUsage) => void; usage: () => AiUsage | null } {
  let total: AiUsage | null = null
  const ok = (n: unknown): n is number => typeof n === 'number' && Number.isFinite(n) && n >= 0
  return {
    onUsage: (u) => {
      if (!u || !ok(u.input) || !ok(u.output)) return
      total = { input: (total?.input ?? 0) + u.input, output: (total?.output ?? 0) + u.output }
    },
    usage: () => total
  }
}

/** `client`'s answer to `prompt`; a prompt with pictures only to a client that sends them (§5.3.1). */
function ask(client: AiClient, prompt: TextPrompt, opts: { signal: AbortSignal; effort: TextEffort; onUsage: (u: AiUsage) => void }): Promise<unknown> {
  if (prompt.images?.length && !client.pictures) return Promise.reject(new Error(NO_PICTURES_MESSAGE))
  return client.json(prompt, opts)
}

/** Text tasks in progress, stopped when the app quits. */
const textCalls = new Set<AbortController>()

const EFFORT: Record<AiTextRequest['task'], TextEffort> = {
  cleanup: 'medium',
  translate: 'medium',
  chapters: 'medium',
  title: 'low',
  summary: 'low',
  marks: 'low',
  // The publishing copy pack (NW-13): the longer pieces think a little more than the posts.
  youtube: 'medium',
  linkedin: 'low',
  xpost: 'low',
  article: 'medium',
  releaseNotes: 'medium',
  // Smart tools' short names and notes (smart-tools.md §20.0).
  names: 'low'
}

/** How hard each text task thinks (read by the contracts' test). */
export const effortOf = (task: AiTextRequest['task']): TextEffort => EFFORT[task]

/** Text requests the renderer named (NW-13), so cancelAiText can stop one. */
const namedTextCalls = new Map<string, AbortController>()

/** A request id from the renderer: 1–64 of A-Z, a-z, 0-9, _ and -. Throws otherwise. */
export function readRequestId(raw: unknown): string | undefined {
  if (raw === undefined || raw === null) return undefined
  if (typeof raw !== 'string' || !/^[A-Za-z0-9_-]{1,64}$/.test(raw)) throw new Error('Invalid request id.')
  return raw
}

/**
 * Runs a text task on the transcript with provider `providerId` (a provider, a service, or
 * LOCAL_TEXT_ID: AI on this PC, whose progress goes to `sender`). With `requestId`, cancelAiText
 * stops it, and a second request with the same id stops the first. `usage` is added when the
 * provider reported its tokens.
 */
export async function aiText(providerId: unknown, raw: unknown, requestId?: unknown, sender?: WebContents): Promise<AiTextResult & { usage?: AiUsage }> {
  const id = readRequestId(requestId)
  const request = validateTextRequest(raw)
  const controller = new AbortController()
  if (id) {
    namedTextCalls.get(id)?.abort()
    namedTextCalls.set(id, controller)
  }
  textCalls.add(controller)
  try {
    const { client, limits } = await textClient(providerId, request, { sender, requestId: id })
    controller.signal.throwIfAborted()
    const meter = usageMeter()
    const result = await runTextTask(request, (prompt) => ask(client, prompt, { signal: controller.signal, effort: EFFORT[request.task], onUsage: meter.onUsage }), limits)
    const usage = meter.usage()
    return usage ? { ...result, usage } : result
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

/**
 * Turns the presenter's notes into a script to read aloud with provider `providerId` ("Draft
 * script"), a service or AI on this PC. Its `requestId` (smart-tools.md §20.0) is registered as
 * aiText's are, so cancelAiText stops it too.
 */
export async function draftScript(providerId: unknown, raw: unknown, sender?: WebContents): Promise<ScriptDraftResult> {
  const id = readRequestId(raw && typeof raw === 'object' ? (raw as { requestId?: unknown }).requestId : undefined)
  const request = validateScriptRequest(raw)
  scriptDraft?.abort()
  const controller = new AbortController()
  scriptDraft = controller
  if (id) {
    namedTextCalls.get(id)?.abort()
    namedTextCalls.set(id, controller)
  }
  textCalls.add(controller)
  try {
    const { client } = await textClient(providerId, null, { sender, requestId: id })
    controller.signal.throwIfAborted()
    return await runScriptDraft(request, (prompt) => ask(client, prompt, { signal: controller.signal, effort: SCRIPT_EFFORT, onUsage: () => undefined }))
  } finally {
    textCalls.delete(controller)
    if (scriptDraft === controller) scriptDraft = null
    if (id && namedTextCalls.get(id) === controller) namedTextCalls.delete(id)
  }
}

/** Stops the script draft in progress, if any. */
export function cancelScriptDraft(): void {
  scriptDraft?.abort()
  scriptDraft = null
}

/** Checks provider or service `id`'s key with a tiny request (a fixed probe, never project text); never throws. */
export async function testAiProvider(id: unknown): Promise<{ ok: boolean; message: string }> {
  try {
    const { info, apiKey } = isServiceId(id) ? services().get(id) : providers().get(id)
    const message = await (await clientFor(info, apiKey, services())).test(AbortSignal.timeout(60_000))
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
    return listAiProviders()
  })
  ipcMain.handle('ai:saveProvider', (e, input: unknown) => {
    fromApp(e)
    // A service goes to its own store (§10.1); a provider is saved exactly as before.
    const service = !!input && typeof input === 'object' && (input as { service?: unknown }).service !== undefined
    return service ? services().save(input) : providers().save(input)
  })
  ipcMain.handle('ai:removeProvider', (e, id: unknown) => {
    fromApp(e)
    if (isServiceId(id)) services().remove(id)
    else providers().remove(id)
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
      return await aiText(providerId, request, id, sender)
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
    // Its request id belongs to the page that asked, as ai:text's do.
    const sender = e.sender
    const id = readRequestId(request && typeof request === 'object' ? (request as { requestId?: unknown }).requestId : undefined)
    if (!id) return draftScript(providerId, request, sender)
    const gone = (): void => cancelAiText(id)
    const events = ['did-navigate', 'destroyed', 'render-process-gone'] as const
    for (const name of events) sender.once(name as 'destroyed', gone)
    return draftScript(providerId, request, sender).finally(() => {
      for (const name of events) sender.removeListener(name as 'destroyed', gone)
    })
  })
  ipcMain.handle('ai:cancelScriptDraft', (e) => {
    fromApp(e)
    cancelScriptDraft()
  })
  // Model lists and the price list (smart-tools.md §10.4, §11.4): part P5's.
  ipcMain.handle(AI_SMART_CHANNELS.listModels, (e, target: unknown) => {
    fromApp(e)
    return listModels(target, { providers, services })
  })
  ipcMain.handle(AI_SMART_CHANNELS.priceList, (e) => {
    fromApp(e)
    return priceList().shown
  })
  // Requests and ffmpeg must not outlive the app, nor their temporary files.
  void sweepTranscribeTemp(os.tmpdir())
  app.on('will-quit', () => {
    stopAllTranscriptions()
    for (const c of textCalls) c.abort()
  })
}
