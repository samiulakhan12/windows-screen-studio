/**
 * Search every recording (F-18, docs/design/search.md): the index service on the real disk, its IPC
 * for Home, and the editor's save hook. Only the main window's own page may query (§6).
 */
import { app, ipcMain, type IpcMainInvokeEvent } from 'electron'
import { mkdirSync, promises as fs } from 'node:fs'
import path from 'node:path'
import { SEARCH_CHANNELS } from '../../shared/api/search'
import type { SearchStatus } from '../../shared/search/types'
import { writeFileAtomicSync } from '../atomicWrite'
import { legacyProjectRoots, projectDir, projectsRoot } from '../projects'
import { isAppUrl } from '../security'
import { getMainWindow } from '../windows'
import { SearchService, type SearchDisk } from './searchService'

/** How long after start-up the index is loaded (§4): the window and the library come first. */
export const START_DELAY_MS = 4000
/** Status messages to Home, at most this often while building. */
const STATUS_EVERY_MS = 500

export const nodeSearchDisk: SearchDisk = {
  async listDirs(dir) {
    try {
      return (await fs.readdir(dir, { withFileTypes: true })).filter((e) => e.isDirectory()).map((e) => e.name)
    } catch {
      return []
    }
  },
  async stat(file) {
    try {
      const st = await fs.stat(file)
      return st.isFile() ? { mtimeMs: st.mtimeMs, size: st.size } : null
    } catch {
      return null
    }
  },
  async readText(file, max) {
    let handle: Awaited<ReturnType<typeof fs.open>>
    try {
      handle = await fs.open(file, 'r')
    } catch {
      return null
    }
    try {
      const st = await handle.stat()
      if (!st.isFile() || st.size > max) return null
      return await handle.readFile('utf8')
    } finally {
      await handle.close().catch(() => undefined)
    }
  },
  writeText(file, text) {
    mkdirSync(path.dirname(file), { recursive: true })
    writeFileAtomicSync(file, text, { attempts: 4 })
  }
}

let service: SearchService | null = null
let startTimer: ReturnType<typeof setTimeout> | null = null

/** Whether a message comes from the main window's own page (the rule of projectsIpc.ts fromMainWindow). */
function fromMainWindow(e: IpcMainInvokeEvent): boolean {
  const main = getMainWindow()
  if (!main || main.isDestroyed() || main.webContents.isDestroyed()) return false
  return e.sender.id === main.webContents.id && isAppUrl(e.senderFrame?.url ?? '')
}

/** Sends the status to Home, throttled; the last one always goes. */
function statusSender(): (s: SearchStatus) => void {
  let last = 0
  let pending: SearchStatus | null = null
  let timer: ReturnType<typeof setTimeout> | null = null
  const send = (s: SearchStatus): void => {
    last = Date.now()
    const main = getMainWindow()
    if (main && !main.isDestroyed() && !main.webContents.isDestroyed()) main.webContents.send(SEARCH_CHANNELS.status, s)
  }
  return (s) => {
    pending = s
    const wait = STATUS_EVERY_MS - (Date.now() - last)
    if (s.state !== 'building' || wait <= 0) {
      if (timer) clearTimeout(timer)
      timer = null
      pending = null
      return send(s)
    }
    timer ??= setTimeout(() => {
      timer = null
      if (pending) send(pending)
      pending = null
    }, wait)
  }
}

export function registerSearchIpc(): void {
  service = new SearchService({
    disk: nodeSearchDisk,
    roots: () => [projectsRoot(), ...legacyProjectRoots()],
    indexFile: path.join(app.getPath('userData'), 'search', 'index.json'),
    onStatus: statusSender()
  })
  const s = service
  startTimer = setTimeout(() => {
    startTimer = null
    void s.start().catch((err: unknown) => console.warn(`Could not build the search index (${err instanceof Error ? err.name : 'error'})`))
  }, START_DELAY_MS)

  ipcMain.handle(SEARCH_CHANNELS.query, (e, query: unknown) => {
    if (!fromMainWindow(e)) throw new Error('Not allowed')
    if (typeof query !== 'string') throw new Error('Not a search')
    return s.query(query)
  })
  ipcMain.handle(SEARCH_CHANNELS.refresh, async (e) => {
    if (!fromMainWindow(e)) throw new Error('Not allowed')
    void s.start()
    await s.reconcile()
    return s.getStatus()
  })
}

/** The editor saved a project (projectsIpc.ts saveProjectNow): the index takes it in a moment. Never throws. */
export function noteProjectSaved(project: { id: string }): void {
  try {
    service?.noteSaved(project, path.join(projectDir(project.id), 'project.json'))
  } catch {
    // An id projectDir refuses was refused by the save before this.
  }
}

/** Quitting: writes what is pending. */
export function disposeSearch(): void {
  if (startTimer) clearTimeout(startTimer)
  startTimer = null
  service?.dispose()
}
