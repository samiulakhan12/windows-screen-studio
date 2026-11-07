/**
 * Smart tools' IPC channels (docs/design/smart-tools.md §20.0, §16): each new channel is registered,
 * and answers only the app's own page (projects:copyCost only the main window at it, as the other
 * projects channels); src/main/index.ts imports the TLS guard first and registers the guide, AI on
 * this PC and scene-scan channels, and sweeps the guide's print files at start.
 */
import { mkdtempSync, readFileSync, rmSync } from 'node:fs'
import { tmpdir } from 'node:os'
import path from 'node:path'
import { pathToFileURL } from 'node:url'
import { afterAll, describe, expect, it, vi } from 'vitest'

const h = vi.hoisted(() => ({ root: '', handlers: new Map<string, (...args: unknown[]) => unknown>() }))
h.root = mkdtempSync(path.join(tmpdir(), 'w11-ipc-'))

vi.mock('electron', () => ({
  app: { getPath: (name: string) => require('node:path').join(h.root, name), isPackaged: false, on: () => undefined, getAppPath: () => '/nonexistent' },
  ipcMain: { handle: (channel: string, fn: (...args: unknown[]) => unknown) => h.handlers.set(channel, fn), on: () => undefined },
  safeStorage: { isEncryptionAvailable: () => true, encryptString: (s: string) => Buffer.from(s), decryptString: (b: Buffer) => b.toString(), getSelectedStorageBackend: () => 'dpapi' },
  dialog: {},
  shell: {},
  protocol: {},
  clipboard: {},
  BrowserWindow: class {}
}))
const MAIN = { id: 1, isDestroyed: () => false, send: () => undefined, once: () => undefined, removeListener: () => undefined }
const OTHER = { id: 2, isDestroyed: () => false, send: () => undefined, once: () => undefined, removeListener: () => undefined }
vi.mock('../src/main/windows', () => ({ getMainWindow: () => ({ isDestroyed: () => false, webContents: MAIN }) }))
vi.mock('../src/main/ai/transcribe', () => ({ stopAllTranscriptions: () => undefined, stopTranscription: () => undefined, sweepTranscribeTemp: async () => undefined, transcribeProject: async () => undefined }))

const { registerGuideIpc } = await import('../src/main/guide/guideIpc')
const { registerLocalAiIpc } = await import('../src/main/localAi/localAiIpc')
const { registerSceneIpc } = await import('../src/main/sceneScan')
const { registerAiIpc } = await import('../src/main/aiIpc')
const { registerProjectsIpc } = await import('../src/main/projectsIpc')
const { GUIDE_CHANNELS } = await import('../src/shared/api/guide')
const { LOCAL_AI_CHANNELS } = await import('../src/shared/api/localAi')
const { SMART_PROJECT_CHANNELS } = await import('../src/shared/api/projects')
const { AI_SMART_CHANNELS } = await import('../src/shared/api/ai')

registerGuideIpc()
registerLocalAiIpc()
registerSceneIpc()
registerAiIpc()
registerProjectsIpc()
afterAll(() => rmSync(h.root, { recursive: true, force: true }))

/** The app's page as security.ts knows it when running from source (src/renderer/index.html). */
const APP = pathToFileURL(path.join(__dirname, '../src/renderer/index.html')).href
const event = (sender: object, url: string) => ({ sender, senderFrame: { url } })
/** What a handler gives: its value, or the message it threw or rejected with. */
async function outcome(channel: string, e: object, ...args: unknown[]): Promise<{ ok: true; value: unknown } | { ok: false; message: string }> {
  const handler = h.handlers.get(channel)
  if (!handler) throw new Error(`${channel} is not registered`)
  try {
    return { ok: true, value: await handler(e, ...args) }
  } catch (err) {
    return { ok: false, message: err instanceof Error ? err.message : String(err) }
  }
}

const APP_PAGE_CHANNELS = [
  ...Object.values(GUIDE_CHANNELS),
  LOCAL_AI_CHANNELS.state,
  LOCAL_AI_CHANNELS.download,
  LOCAL_AI_CHANNELS.cancel,
  LOCAL_AI_CHANNELS.remove,
  LOCAL_AI_CHANNELS.setUse,
  SMART_PROJECT_CHANNELS.detectScenes,
  AI_SMART_CHANNELS.listModels,
  AI_SMART_CHANNELS.priceList
]

describe("smart tools' channels answer only the app's page", () => {
  it('every new invoke channel is registered', () => {
    for (const channel of [...APP_PAGE_CHANNELS, SMART_PROJECT_CHANNELS.copyCost]) expect(h.handlers.has(channel), channel).toBe(true)
  })

  it('a page that is not the app is refused before anything runs', async () => {
    for (const channel of APP_PAGE_CHANNELS) {
      for (const url of ['https://example.com/', pathToFileURL(path.join(h.root, 'index.html')).href, '']) {
        expect(await outcome(channel, event(MAIN, url), 'x'), `${channel} from ${url || 'no frame'}`).toEqual({ ok: false, message: 'Not allowed' })
      }
    }
  })

  it("the app's page gets past the check (to the part's own answer)", async () => {
    for (const channel of APP_PAGE_CHANNELS) {
      const out = await outcome(channel, event(MAIN, APP), channel === AI_SMART_CHANNELS.listModels ? { providerId: 'none' } : 'x')
      expect(out, channel).not.toEqual({ ok: false, message: 'Not allowed' })
    }
    // The state of AI on this PC and the price list answer even before their parts.
    expect(await outcome(LOCAL_AI_CHANNELS.state, event(MAIN, APP))).toMatchObject({ ok: true, value: { models: expect.any(Array), use: 'auto' } })
    expect(await outcome(AI_SMART_CHANNELS.priceList, event(MAIN, APP))).toMatchObject({ ok: true, value: { version: 1, currency: 'USD' } })
  })

  it('projects:copyCost answers only the main window at the app page', async () => {
    expect(await outcome(SMART_PROJECT_CHANNELS.copyCost, event(OTHER, APP), 'p')).toEqual({ ok: false, message: 'Not allowed' })
    expect(await outcome(SMART_PROJECT_CHANNELS.copyCost, event(MAIN, 'https://example.com/'), 'p')).toEqual({ ok: false, message: 'Not allowed' })
    expect(await outcome(SMART_PROJECT_CHANNELS.copyCost, event(MAIN, APP), 'p')).not.toEqual({ ok: false, message: 'Not allowed' })
  })
})

describe('the main process starts them (src/main/index.ts)', () => {
  const main = readFileSync(path.join(__dirname, '../src/main/index.ts'), 'utf8')

  it('imports the TLS guard before anything else', () => {
    const firstImport = main.split('\n').find((l) => l.startsWith('import '))
    expect(firstImport).toBe("import './ai/tlsGuard'")
  })

  it('registers the guide, AI on this PC and scene-scan channels, and sweeps the print files at start', () => {
    for (const call of ['registerGuideIpc()', 'registerLocalAiIpc()', 'registerSceneIpc()', 'registerAiIpc()', 'sweepGuidePrint(path.join(app.getPath(\'userData\'), PRINT_DIR))']) expect(main, call).toContain(call)
  })
})
