/**
 * Share without a server (F-22, docs/design/share.md): the IPC for Settings › Share, the export
 * dialog's "After export" and its done view, and the "Export finished" notification's buttons.
 * Only the app's own page may call these handlers; it sends ids, never paths or URLs to act on
 * (except a webhook URL typed in Settings, checked and encrypted at once).
 */
import { app, dialog, ipcMain, Notification, net, safeStorage, shell, type IpcMainInvokeEvent } from 'electron'
import { promises as fs } from 'node:fs'
import path from 'node:path'
import type { ShareFolderInfo, ShareRunView, ShareTargets } from '../../shared/api/share'
import { folderId, type CloudCandidate } from '../../shared/share/cloudFolders'
import { TEST_MESSAGE } from '../../shared/share/webhooks'
import type { SecretBox } from '../ai/keyStore'
import { isExportedFile } from '../exportIpc'
import { setNotificationExtras } from '../longJobs'
import { isAppUrl } from '../security'
import { getMainWindow, windowIconPath } from '../windows'
import { detectCloudFolders, fakeProbe, realProbe, type CloudProbe } from './cloudDetect'
import { copyIntoFolder, removePartialCopies } from './copyToFolder'
import { ShareService } from './shareService'
import { ShareStore } from './shareStore'
import { postToWebhook, type FetchLike } from './webhookPost'

/** Test hooks, read only by an unpackaged app (as ai/endpoints.ts). */
const testEnv = (name: string): string | undefined => (app.isPackaged ? undefined : process.env[name] || undefined)

/** safeStorage, as for AI keys (aiIpc.ts): a packaged app on Linux without a keyring refuses. */
const secretBox: SecretBox = {
  isEncryptionAvailable: () => safeStorage.isEncryptionAvailable(),
  encryptString: (plain) => safeStorage.encryptString(plain),
  decryptString: (encrypted) => safeStorage.decryptString(encrypted),
  weakness: () => (process.platform === 'linux' && app.isPackaged && safeStorage.getSelectedStorageBackend() === 'basic_text' ? 'no system keyring is available' : null)
}

let store: ShareStore | null = null
const shareStore = (): ShareStore => (store ??= new ShareStore(path.join(app.getPath('userData'), 'share.json'), secretBox))

/** Found folders are looked for again after this long, or when asked. */
const DETECT_TTL_MS = 60_000
let found: { at: number; list: Promise<CloudCandidate[]> } | null = null

const probe = (): CloudProbe => {
  const fake = testEnv('SSW_SHARE_FAKE_CLOUD')
  return fake ? fakeProbe(fake) : realProbe()
}

function foundFolders(refresh = false): Promise<CloudCandidate[]> {
  if (!found || refresh || Date.now() - found.at > DETECT_TTL_MS) found = { at: Date.now(), list: detectCloudFolders(probe()).catch(() => []) }
  return found.list
}

/** The folders found (that exist) and added, each once. */
async function folderInfos(refresh = false): Promise<ShareFolderInfo[]> {
  const s = shareStore()
  const out: ShareFolderInfo[] = []
  for (const c of await foundFolders(refresh)) {
    const id = folderId(c.path)
    if (!out.some((f) => f.id === id)) out.push({ id, service: c.service, label: c.label, path: c.path, source: c.source, on: !s.isOff(id) })
  }
  for (const f of s.folders()) {
    if (!out.some((x) => x.id === f.id)) out.push({ id: f.id, service: 'folder', label: f.label, path: f.path, source: 'picked', on: !s.isOff(f.id) })
  }
  return out
}

async function targets(refresh = false): Promise<ShareTargets> {
  return { folders: await folderInfos(refresh), hooks: shareStore().hooks() }
}

const fetchPost: FetchLike = (url, init) => net.fetch(url, init)

const send = (run: ShareRunView): void => {
  const win = getMainWindow()
  if (win && !win.isDestroyed()) win.webContents.send('share:update', run)
}

/** Notifications must stay referenced until they close, or their buttons stop working. */
const shown = new Set<Notification>()
function notify(n: { title: string; body: string; show?: string }): void {
  if (!Notification.isSupported()) return
  const note = new Notification({ title: n.title, body: n.body, icon: windowIconPath(), actions: n.show ? [{ type: 'button', text: 'Show in folder' }] : [] })
  note.on('action', () => n.show && shell.showItemInFolder(n.show))
  note.on('click', () => {
    const win = getMainWindow()
    if (!win || win.isDestroyed()) return
    if (win.isMinimized()) win.restore()
    win.show()
    win.focus()
  })
  note.on('close', () => shown.delete(note))
  shown.add(note)
  note.show()
}

const post = (hook: { service: Parameters<typeof postToWebhook>[0]; url: string }, lines: string[], signal: AbortSignal): Promise<void> =>
  postToWebhook(hook.service, hook.url, lines, signal, { fetch: fetchPost, origin: testEnv('SSW_SHARE_WEBHOOK_ORIGIN') })

let service: ShareService | null = null
const shares = (): ShareService =>
  (service ??= new ShareService({
    folders: () => folderInfos(),
    hook: (id) => shareStore().hook(id),
    hookIds: () => shareStore().hooks().filter((h) => h.readable).map((h) => h.id),
    isExported: isExportedFile,
    copy: (file, folder, signal, onProgress) => copyIntoFolder(file, folder.path, folder.label, { signal, onProgress }),
    post,
    send,
    isFocused: () => {
      const win = getMainWindow()
      return !!win && !win.isDestroyed() && win.isFocused()
    },
    notify
  }))

/** Only the app's own page may use the user's webhooks and folders. */
function fromApp(e: IpcMainInvokeEvent): void {
  if (!isAppUrl(e.senderFrame?.url ?? '')) throw new Error('Not allowed')
}

const handle = (channel: string, fn: (...args: unknown[]) => unknown): void => {
  ipcMain.handle(channel, (e, ...args: unknown[]) => {
    fromApp(e)
    return fn(...args)
  })
}

export function registerShareIpc(): void {
  handle('share:targets', (refresh) => targets(refresh === true))
  handle('share:setFolder', async (id, on) => {
    if (typeof id !== 'string') throw new Error('Invalid folder')
    const s = shareStore()
    if (on === null) s.removeFolder(id)
    else if (typeof on === 'boolean') {
      if (!(await folderInfos()).some((f) => f.id === id)) throw new Error('This folder is not there any more.')
      s.setOff(id, !on)
    }
    return targets()
  })
  handle('share:pickFolder', async () => {
    const win = getMainWindow()
    if (!win) return null
    const result = await dialog.showOpenDialog(win, { title: 'Add a folder to share to', buttonLabel: 'Add folder', properties: ['openDirectory', 'createDirectory'] })
    const dir = result.canceled ? undefined : result.filePaths[0]
    if (!dir || !path.isAbsolute(dir)) return null
    const st = await fs.stat(dir).catch(() => null)
    if (!st?.isDirectory()) throw new Error('Choose a folder.')
    const known = (await folderInfos()).find((f) => f.id === folderId(dir))
    if (known) shareStore().setOff(known.id, false)
    else shareStore().addFolder(dir, path.basename(dir) || dir)
    return targets()
  })
  handle('share:addHook', (label, url) => {
    shareStore().addHook(label, url)
    return targets()
  })
  handle('share:removeHook', (id) => {
    shareStore().removeHook(id)
    return targets()
  })
  handle('share:testHook', async (id) => {
    try {
      const hook = shareStore().hook(id)
      await post(hook, TEST_MESSAGE, new AbortController().signal)
      return { ok: true, message: `Posted a test message to ${hook.label}.` }
    } catch (err) {
      return { ok: false, message: err instanceof Error ? err.message : String(err) }
    }
  })
  handle('share:offer', (file, meta, auto) => shares().offer(file, meta, auto))
  handle('share:start', (file, ids, meta) => shares().start(file, ids, meta))
  handle('share:cancel', (id) => shares().cancel(id))
  handle('share:runs', (file) => shares().runsFor(file))
  setNotificationExtras((file) => shares().extras(file))
}

export function disposeShare(): void {
  service?.dispose()
  removePartialCopies()
}
