import { dialog, ipcMain, shell } from 'electron'
import { existsSync, promises as fs } from 'node:fs'
import path from 'node:path'
import { SOURCE_FILES, stemsOf } from '../shared/audio/settings'
import type { SaveMeta, SyncSaveResult } from '../shared/editor/autosave'
import type { LoadedProject } from '../shared/api/projects'
import type { Project } from '../shared/types'
import { stopAnalyses } from './analysisIpc'
import { writeFileAtomicSync } from './atomicWrite'
import { MEDIA_FILE_RE, mediaUrl } from './mediaProtocol'
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

/**
 * The project as the editor should open it: stems are only ever used as a complete set (see
 * stemsOf), so when one of their files is missing (a folder copied in part, a file deleted by
 * hand) the project opens without them. The preview, the export and the music's ducking then
 * all use the mixed sound, which has every source; the Audio panel says when a source's own
 * mute or volume can no longer apply.
 */
export async function withoutMissingStems(project: Project, dir: string, exists = projects.exists): Promise<Project> {
  const recorded = stemsOf(project)
  if (recorded.length === 0) return project
  const missing = (await Promise.all(recorded.map(async (k) => ((await exists(path.join(dir, SOURCE_FILES[k]))) ? null : SOURCE_FILES[k])))).filter(Boolean)
  if (missing.length === 0) return project
  console.warn(`${missing.join(' and ')} of this recording ${missing.length > 1 ? 'are' : 'is'} missing; it opens with its mixed sound.`)
  const { audioStems: _missing, ...rest } = project
  void _missing
  return rest
}

export function registerProjectsIpc(): void {
  ipcMain.handle('projects:list', () => projects.listProjects())

  ipcMain.handle('projects:load', async (_e, id: string): Promise<LoadedProject> => {
    const dir = projects.projectDir(id)
    const project = await withoutMissingStems(await projects.readProject(id), dir)
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

  ipcMain.handle('projects:delete', async (_e, id: string) => {
    lastSaved.delete(id)
    // An analysis still reading the recording holds its files open, and Windows refuses to delete those.
    await stopAnalyses(id)
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

  ipcMain.handle('projects:pickCursorImage', async (_e, id: string) => {
    const main = getMainWindow()
    if (!main) return null
    const result = await dialog.showOpenDialog(main, {
      title: 'Choose cursor image',
      properties: ['openFile'],
      filters: [{ name: 'Cursor images', extensions: CURSOR_IMAGE_EXTENSIONS }]
    })
    if (result.canceled || !result.filePaths[0]) return null
    return importCursorImage(id, result.filePaths[0])
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

/** Image formats a custom cursor can be (Chromium decodes all of them; .cur hot spots are not read: top-left). */
export const CURSOR_IMAGE_EXTENSIONS = ['png', 'jpg', 'jpeg', 'webp', 'svg', 'ico', 'cur']
const MAX_CURSOR_IMAGE_BYTES = 10 * 1024 * 1024

/** Whether `head` (the first bytes of a file) starts like an image of one of the cursor formats. */
export function looksLikeCursorImage(head: Buffer): boolean {
  const starts = (...bytes: number[]): boolean => bytes.every((b, i) => head[i] === b)
  if (starts(0x89, 0x50, 0x4e, 0x47)) return true // PNG
  if (starts(0xff, 0xd8, 0xff)) return true // JPEG
  if (head.subarray(0, 4).toString('latin1') === 'RIFF' && head.subarray(8, 12).toString('latin1') === 'WEBP') return true
  if (starts(0, 0, 1, 0) || starts(0, 0, 2, 0)) return true // ICO, CUR
  return /<svg[\s>]/i.test(head.toString('utf8')) // SVG (after an XML prolog or comments)
}

/**
 * Copies a picked cursor image into the project folder as cursor.<ext> and returns its URL
 * and project-relative path. Images of other formats stay, so undo can go back to them.
 * A file that is not an image is refused before anything is overwritten.
 */
export async function importCursorImage(id: string, src: string): Promise<{ url: string; path: string }> {
  const ext = path.extname(src).toLowerCase().replace('.jpeg', '.jpg')
  if (!CURSOR_IMAGE_EXTENSIONS.includes(ext.slice(1))) throw new Error('Choose a PNG, JPG, WebP, SVG, ICO or CUR image.')
  const { size } = await fs.stat(src)
  if (size > MAX_CURSOR_IMAGE_BYTES) throw new Error('This image is too large for a cursor (10 MB at most).')
  const handle = await fs.open(src, 'r')
  const head = Buffer.alloc(4096)
  try {
    const { bytesRead } = await handle.read(head, 0, head.length, 0)
    if (!looksLikeCursorImage(head.subarray(0, bytesRead))) throw new Error('This file could not be read as an image.')
  } finally {
    await handle.close()
  }
  const name = `cursor${ext}`
  if (!MEDIA_FILE_RE.test(name)) throw new Error('Unsupported cursor image')
  await fs.copyFile(src, path.join(projects.projectDir(id), name))
  return { url: mediaUrl(id, name), path: name }
}
