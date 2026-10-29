/**
 * Settings › Storage (F-26, docs/design/hands-off.md §2.7): the scan, the rules, the plan and the
 * clean-up, which removes only what main finds again in the plan, only to the Recycle Bin. The
 * editor tells which recording it has open: that one is never cleaned. With "Do this
 * automatically", the cache rule runs at most once a day, a minute after start-up, while nothing
 * else runs.
 */
import { app, ipcMain, shell, type IpcMainEvent, type IpcMainInvokeEvent, type WebContents } from 'electron'
import path from 'node:path'
import type { StorageCleanupResult, StorageOverview } from '../shared/api/storage'
import { cleanupPlan, DAY_MS, type CleanupAction } from '../shared/storage/rules'
import { stopAnalyses } from './analysisIpc'
import { jobsSnapshot } from './longJobs'
import { projectsRoot } from './projects'
import { isAppUrl } from './security'
import { diskSpace, runCleanup, scanProjects } from './storage'
import { StorageStore, STORAGE_FILE } from './storageStore'

/** Wait after start-up before the automatic cache clean-up. */
export const AUTO_CLEAN_DELAY_MS = 60_000

let store: StorageStore | null = null
const storeOf = (): StorageStore => (store ??= new StorageStore(path.join(app.getPath('userData'), STORAGE_FILE)))

/** The recording each page has open in the editor. */
const openBy = new Map<number, string>()
/** Pages already watched for going away (each once, however often it opens recordings). */
const watched = new Set<number>()
const openIds = (): Set<string> => new Set(openBy.values())

const fromApp = (e: IpcMainInvokeEvent | IpcMainEvent): boolean => isAppUrl(e.senderFrame?.url ?? '')

function watchPage(wc: WebContents): void {
  if (watched.has(wc.id)) return
  watched.add(wc.id)
  const id = wc.id
  wc.on('did-navigate', () => openBy.delete(id))
  wc.on('render-process-gone', () => openBy.delete(id))
  wc.once('destroyed', () => {
    openBy.delete(id)
    watched.delete(id)
  })
}

const trash = (file: string): Promise<void> => shell.trashItem(file)

/** The clean-up running now: the next one waits for it. */
let cleaning: Promise<unknown> = Promise.resolve()

/**
 * Runs clean-ups one at a time (Settings', the automatic one, Settings' again after it was closed
 * and opened). Each scans again when it starts, so it skips what an earlier one already moved
 * instead of reporting it as failed.
 */
function clean(requests: { id: string; action: CleanupAction }[]): Promise<StorageCleanupResult> {
  const run = cleaning.then(() => {
    const s = storeOf()
    return runCleanup(projectsRoot(), requests, s.rules, s.used, openIds(), Date.now(), { trash, beforeRemove: stopAnalyses, isOpen: (id) => openIds().has(id) })
  })
  cleaning = run.catch(() => undefined)
  return run
}

/** The cache rule by itself, when the user asked for it and nothing else is going on. */
async function autoClean(): Promise<void> {
  const s = storeOf()
  const rules = s.rules
  const last = s.lastAutoClean
  if (!rules.autoCaches || rules.cacheDays === null || (last !== null && Date.now() - last < DAY_MS)) return
  if (jobsSnapshot().length > 0 || openBy.size > 0) return
  const plan = cleanupPlan(await scanProjects(projectsRoot(), s.used), rules, Date.now(), openIds()).filter((i) => i.action === 'caches')
  s.setLastAutoClean()
  if (!plan.length) return
  const r = await clean(plan.map((i) => ({ id: i.id, action: i.action })))
  console.info(`Automatic clean-up: moved the caches of ${r.moved.length} recording(s) to the Recycle Bin (${Math.round(r.freed / 1e6)} MB)`)
}

export function registerStorageIpc(): void {
  ipcMain.handle('storage:scan', async (e): Promise<StorageOverview> => {
    if (!fromApp(e)) throw new Error('Not allowed')
    const root = projectsRoot()
    const s = storeOf()
    const recordings = await scanProjects(root, s.used)
    const space = await diskSpace(root)
    return { root, free: space?.free ?? null, total: space?.total ?? null, bytes: recordings.reduce((n, r) => n + r.bytes, 0), recordings, rules: s.rules, now: Date.now() }
  })
  ipcMain.handle('storage:setRules', (e, rules: unknown) => {
    if (!fromApp(e)) throw new Error('Not allowed')
    return storeOf().setRules(rules)
  })
  ipcMain.handle('storage:plan', async (e) => {
    if (!fromApp(e)) throw new Error('Not allowed')
    const s = storeOf()
    return cleanupPlan(await scanProjects(projectsRoot(), s.used), s.rules, Date.now(), openIds())
  })
  ipcMain.handle('storage:clean', (e, raw: unknown) => {
    if (!fromApp(e)) throw new Error('Not allowed')
    const requests = Array.isArray(raw)
      ? raw
          .filter((r): r is { id: string; action: CleanupAction } => !!r && typeof r.id === 'string' && (r.action === 'caches' || r.action === 'remove'))
          .slice(0, 10_000)
          .map((r) => ({ id: r.id, action: r.action }))
      : []
    return clean(requests)
  })
  ipcMain.on('storage:opened', (e, id: unknown) => {
    if (!fromApp(e) || typeof id !== 'string') return
    watchPage(e.sender)
    openBy.set(e.sender.id, id)
    storeOf().noteUsed(id)
  })
  ipcMain.on('storage:closed', (e, id: unknown) => {
    if (!fromApp(e) || openBy.get(e.sender.id) !== id) return
    openBy.delete(e.sender.id)
  })
  setTimeout(() => void autoClean().catch((err) => console.warn('Automatic clean-up failed:', err)), AUTO_CLEAN_DELAY_MS)
}
