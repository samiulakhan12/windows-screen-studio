import { app, dialog, ipcMain, shell } from 'electron'
import path from 'node:path'
import type { ExportJob } from '../shared/api/export'
import type { ExportFormat } from '../shared/types'
import { exportArgs } from './exportArgs'
import { FrameEncoder } from './ffmpeg'
import * as projects from './projects'
import { getMainWindow } from './windows'

let encoder: FrameEncoder | null = null
let approvedExportPath: string | null = null

export function registerExportIpc(): void {
  ipcMain.handle('export:choosePath', async (_e, defaultName: string, format: ExportFormat) => {
    const main = getMainWindow()
    if (!main) return null
    const result = await dialog.showSaveDialog(main, {
      title: 'Export recording',
      defaultPath: path.join(app.getPath('videos'), `${defaultName}.${format}`),
      filters: format === 'gif' ? [{ name: 'GIF', extensions: ['gif'] }] : [{ name: 'MP4 video', extensions: ['mp4'] }]
    })
    approvedExportPath = result.canceled || !result.filePath ? null : result.filePath
    return approvedExportPath
  })

  ipcMain.handle('export:start', (_e, projectId: string, job: ExportJob) => {
    if (!approvedExportPath || job.outputPath !== approvedExportPath) {
      throw new Error('Export path was not chosen through the save dialog')
    }
    encoder?.kill()
    const audioInput = job.audio ? path.join(projects.projectDir(projectId), 'screen.mp4') : null
    encoder = new FrameEncoder(exportArgs(job, audioInput))
  })

  ipcMain.handle('export:frame', (_e, frame: Uint8Array) => {
    if (!encoder) throw new Error('No export in progress')
    return encoder.write(frame)
  })

  ipcMain.handle('export:finish', async () => {
    const current = encoder
    encoder = null
    approvedExportPath = null
    if (current) await current.finish()
  })

  ipcMain.handle('export:cancel', () => {
    encoder?.kill()
    encoder = null
  })

  ipcMain.handle('shell:showItem', (_e, file: string) => shell.showItemInFolder(file))
}

export function disposeExport(): void {
  encoder?.kill()
}
