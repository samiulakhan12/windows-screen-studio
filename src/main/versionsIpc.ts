/**
 * The versions IPC (E-12, docs/design/versions.md §2.5): only the main window's own page may keep,
 * list, rename, delete or read versions; the project id names its folder through projectDir
 * (which refuses anything that could leave the projects folder), and src/main/versions.ts checks
 * every version id and value.
 */
import { ipcMain, type IpcMainInvokeEvent } from 'electron'
import { promises as fs } from 'node:fs'
import path from 'node:path'
import type { ReadVersion } from '../shared/api/versions'
import { namedFiles, type VersionMeta } from '../shared/editor/versions'
import { MEDIA_FILE_RE } from './mediaProtocol'
import { projectDir } from './projects'
import { isAppUrl } from './security'
import { deleteVersion, listVersions, readVersion, renameVersion, saveVersion, type SaveVersionResult } from './versions'
import { getMainWindow } from './windows'

/** Whether a message comes from the main window's own page (the rule of projectsIpc.ts fromMainWindow). */
function fromMainWindow(e: IpcMainInvokeEvent): boolean {
  const main = getMainWindow()
  if (!main || main.isDestroyed() || main.webContents.isDestroyed()) return false
  return e.sender.id === main.webContents.id && isAppUrl(e.senderFrame?.url ?? '')
}

/** The folder of project `id`; throws for a sender or an id that is not allowed. */
function folderFor(e: IpcMainInvokeEvent, id: unknown): string {
  if (!fromMainWindow(e)) throw new Error('Not allowed')
  if (typeof id !== 'string') throw new Error('Invalid project id')
  return projectDir(id)
}

/** What the files `names` (project-relative, as a version names them) are, for those missing from `dir`. */
async function missingFiles(dir: string, names: { file: string; what: string }[]): Promise<string[]> {
  const out: string[] = []
  for (const { file, what } of names) {
    // Only names a project file can have: anything else is reported missing, never looked up.
    const there = MEDIA_FILE_RE.test(file) && (await fs.lstat(path.join(dir, file)).then((st) => st.isFile(), () => false))
    if (!there) out.push(what)
  }
  return out
}

export function registerVersionsIpc(): void {
  ipcMain.handle('versions:list', (e, id: unknown): VersionMeta[] => listVersions(folderFor(e, id)))
  ipcMain.handle('versions:save', (e, id: unknown, project: unknown, opts: unknown): SaveVersionResult => {
    const dir = folderFor(e, id)
    const o = (opts && typeof opts === 'object' ? opts : {}) as { name?: unknown; reason?: unknown; about?: unknown }
    return saveVersion(dir, id as string, project, { name: o.name, reason: o.reason, about: o.about })
  })
  ipcMain.handle('versions:rename', (e, id: unknown, versionId: unknown, name: unknown): VersionMeta => renameVersion(folderFor(e, id), versionId as string, name))
  ipcMain.handle('versions:delete', (e, id: unknown, versionId: unknown): void => deleteVersion(folderFor(e, id), versionId as string))
  ipcMain.handle('versions:read', async (e, id: unknown, versionId: unknown): Promise<ReadVersion> => {
    const dir = folderFor(e, id)
    const r = await readVersion(dir, id as string, versionId as string)
    return { ...r, missing: await missingFiles(dir, namedFiles(r.project)) }
  })
}
