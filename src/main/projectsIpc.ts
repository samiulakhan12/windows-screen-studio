import { dialog, ipcMain, shell } from 'electron'
import { promises as fs } from 'node:fs'
import path from 'node:path'
import type { LoadedProject } from '../shared/api/projects'
import type { Project } from '../shared/types'
import { mediaUrl } from './mediaProtocol'
import * as projects from './projects'
import { getMainWindow } from './windows'

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

  ipcMain.handle('projects:save', (_e, project: Project) => projects.writeProject(project))
  ipcMain.handle('projects:delete', (_e, id: string) => projects.deleteProject(id))
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
    const dir = projects.projectDir(id)
    for (const old of ['background.png', 'background.jpg', 'background.webp']) {
      await fs.rm(path.join(dir, old), { force: true })
    }
    await fs.copyFile(src, path.join(dir, name))
    return { url: mediaUrl(id, name), path: name }
  })
}
