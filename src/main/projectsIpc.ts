import { dialog, ipcMain, shell } from 'electron'
import { existsSync, promises as fs } from 'node:fs'
import path from 'node:path'
import type { SaveMeta, SyncSaveResult } from '../shared/editor/autosave'
import type { LoadedProject } from '../shared/api/projects'
import type { Project } from '../shared/types'
import { writeFileAtomicSync } from './atomicWrite'
import { mediaUrl } from './mediaProtocol'
import * as projects from './projects'
import { loadStyleDefaults, saveStyleDefaults, type StyleDefaults } from './styleDefaults'
import { getMainWindow } from './windows'

/** Newest save written per project, so a save that arrives late cannot overwrite a newer one. */
const lastSaved = new Map<string, SaveMeta>()

/**
 * Writes project.json synchronously (see writeFileAtomicSync for why). Saves of
 * one editor session carry increasing sequence numbers; an older one arriving
 * after a newer one is dropped.
 */
export function saveProjectNow(project: Project, meta?: SaveMeta): void {
  if (!project || typeof project.id !== 'string') throw new Error('Not a project')
  const dir = projects.projectDir(project.id)
  if (meta) {
    const last = lastSaved.get(project.id)
    if (last && last.session === meta.session && meta.seq <= last.seq) return
  }
  if (!existsSync(dir)) throw new Error('The recording folder no longer exists, so changes cannot be saved.')
  writeFileAtomicSync(path.join(dir, 'project.json'), JSON.stringify(project, null, 2))
  if (meta) lastSaved.set(project.id, meta)
}

export function registerProjectsIpc(): void {
  ipcMain.handle('projects:list', () => projects.listProjects())

  ipcMain.handle('projects:load', async (_e, id: string): Promise<LoadedProject> => {
    const project = await projects.readProject(id)
    const dir = projects.projectDir(id)
    const cursor = await projects.readCursor(id)
    const hasWebcam = project.hasWebcam && (await projects.exists(path.join(dir, 'webcam.mp4')))
    const bg = project.style.background
    return {
      project,
      cursor,
      dir,
      screenUrl: mediaUrl(id, 'screen.mp4'),
      webcamUrl: hasWebcam ? mediaUrl(id, 'webcam.mp4') : null,
      backgroundUrl: bg.type === 'image' ? mediaUrl(id, bg.path) : null
    }
  })

  ipcMain.handle('projects:save', (_e, project: Project, meta?: SaveMeta) => saveProjectNow(project, meta))

  // Used while the editor window is closing, when an async invoke may never be serviced.
  ipcMain.on('projects:saveSync', (e, project: Project, meta?: SaveMeta) => {
    let result: SyncSaveResult
    try {
      saveProjectNow(project, meta)
      result = { ok: true }
    } catch (err) {
      result = { ok: false, error: err instanceof Error ? err.message : String(err) }
    }
    e.returnValue = result
  })

  ipcMain.handle('projects:delete', (_e, id: string) => {
    lastSaved.delete(id)
    return projects.deleteProject(id)
  })
  ipcMain.handle('projects:reveal', (_e, id: string) => shell.openPath(projects.projectDir(id)))

  ipcMain.handle('projects:pickBackground', async (_e, id: string) => {
    const main = getMainWindow()
    if (!main) return null
    const result = await dialog.showOpenDialog(main, {
      title: 'Choose background image',
      properties: ['openFile'],
      filters: [{ name: 'Images', extensions: ['png', 'jpg', 'jpeg', 'webp'] }]
    })
    if (result.canceled || !result.filePaths[0]) return null
    const src = result.filePaths[0]
    const ext = path.extname(src).toLowerCase().replace('.jpeg', '.jpg')
    const name = `background${ext}`
    // Images of the other formats are kept so undo can go back to them.
    await fs.copyFile(src, path.join(projects.projectDir(id), name))
    return { url: mediaUrl(id, name), path: name }
  })

  ipcMain.handle('projects:backgroundUrl', async (_e, id: string, file: string): Promise<string | null> => {
    if (typeof file !== 'string' || !BACKGROUND_RE.test(file)) return null
    return (await projects.exists(path.join(projects.projectDir(id), file))) ? mediaUrl(id, file) : null
  })

  ipcMain.handle('styleDefaults:get', () => loadStyleDefaults())
  // The renderer's value is validated field by field before it is stored; only reset removes the file.
  ipcMain.handle('styleDefaults:save', (_e, look: unknown) => saveStyleDefaults((look ?? {}) as StyleDefaults))
  ipcMain.handle('styleDefaults:reset', async () => {
    await saveStyleDefaults(null)
  })
}

const BACKGROUND_RE = /^background\.(png|jpe?g|webp)$/i
