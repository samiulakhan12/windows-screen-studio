import { dialog, ipcMain, shell } from 'electron'
import { existsSync, promises as fs } from 'node:fs'
import path from 'node:path'
import { SOURCE_FILES, stemsOf, type StemKind } from '../shared/audio/settings'
import type { SaveMeta, SyncSaveResult } from '../shared/editor/autosave'
import type { LoadedProject } from '../shared/api/projects'
import type { Project } from '../shared/types'
import { stopAnalyses } from './analysisIpc'
import { imageType } from './assetIpc'
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
 * Stems the recording kept whose file is missing from its folder `dir` (a folder copied in
 * part, a file deleted by hand). Stems are only ever used as a complete set (see stemsOf), so
 * the editor then opens the project without them; project.json keeps them, so they are used
 * again once the file is back.
 */
export async function missingStems(project: Project, dir: string, exists = projects.exists): Promise<StemKind[]> {
  const recorded = stemsOf(project)
  const present = await Promise.all(recorded.map((k) => exists(path.join(dir, SOURCE_FILES[k]))))
  const missing = recorded.filter((_, i) => !present[i])
  if (missing.length > 0) console.warn(`${missing.map((k) => SOURCE_FILES[k]).join(' and ')} of this recording ${missing.length > 1 ? 'are' : 'is'} missing; it opens with its mixed sound.`)
  return missing
}

export function registerProjectsIpc(): void {
  ipcMain.handle('projects:list', () => projects.listProjects())

  ipcMain.handle('projects:load', async (_e, id: string): Promise<LoadedProject> => {
    const dir = projects.projectDir(id)
    const project = await projects.readProject(id)
    const cursor = await projects.readCursor(id)
    const hasWebcam = project.hasWebcam && (await projects.exists(path.join(dir, 'webcam.mp4')))
    const bg = project.style.background
    return {
      project,
      cursor,
      dir,
      screenUrl: mediaUrl(id, 'screen.mp4'),
      webcamUrl: hasWebcam ? mediaUrl(id, 'webcam.mp4') : null,
      backgroundUrl: bg.type === 'image' ? mediaUrl(id, bg.path) : null,
      missingStems: await missingStems(project, dir)
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
    return importBackgroundImage(id, result.filePaths[0])
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
const MAX_BACKGROUND_IMAGE_BYTES = 100 * 1024 * 1024

/** The first 4 KB of `src` (enough to tell an image's format). */
async function readHead(src: string): Promise<Buffer> {
  const handle = await fs.open(src, 'r')
  try {
    const head = Buffer.alloc(4096)
    const { bytesRead } = await handle.read(head, 0, head.length, 0)
    return head.subarray(0, bytesRead)
  } finally {
    await handle.close()
  }
}

/**
 * Copies `src` into project `id` as `name` through a temporary file and a rename, so a copy
 * that fails partway (a disconnected drive, a full disk) leaves the image in use intact.
 */
async function copyIntoProject(id: string, src: string, name: string): Promise<void> {
  const dir = projects.projectDir(id)
  const tmp = path.join(dir, `.${name}.part`)
  try {
    await fs.copyFile(src, tmp)
    await fs.rename(tmp, path.join(dir, name))
  } catch (err) {
    await fs.rm(tmp, { force: true }).catch(() => undefined)
    throw err
  }
}

/**
 * Copies a picked background image into the project folder as background.<ext> and returns its
 * URL and project-relative path. Images of the other formats are kept so undo can go back to
 * them. A file that is not a PNG, JPG or WebP image of its extension is refused before anything
 * is replaced.
 */
export async function importBackgroundImage(id: string, src: string): Promise<{ url: string; path: string }> {
  const ext = path.extname(src).slice(1).toLowerCase().replace('jpeg', 'jpg')
  const name = `background.${ext}`
  if (!BACKGROUND_RE.test(name)) throw new Error('Choose a PNG, JPG or WebP image.')
  const st = await fs.stat(src)
  if (!st.isFile()) throw new Error('Choose a PNG, JPG or WebP image.')
  if (st.size > MAX_BACKGROUND_IMAGE_BYTES) throw new Error('This image is too large for a background (100 MB at most).')
  if (imageType(await readHead(src)) !== ext) throw new Error(`This file could not be read as a .${ext} image.`)
  await copyIntoProject(id, src, name)
  return { url: mediaUrl(id, name), path: name }
}

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
  const st = await fs.stat(src)
  if (!st.isFile()) throw new Error('Choose a PNG, JPG, WebP, SVG, ICO or CUR image.')
  if (st.size > MAX_CURSOR_IMAGE_BYTES) throw new Error('This image is too large for a cursor (10 MB at most).')
  if (!looksLikeCursorImage(await readHead(src))) throw new Error('This file could not be read as an image.')
  const name = `cursor${ext}`
  if (!MEDIA_FILE_RE.test(name)) throw new Error('Unsupported cursor image')
  await copyIntoProject(id, src, name)
  return { url: mediaUrl(id, name), path: name }
}
