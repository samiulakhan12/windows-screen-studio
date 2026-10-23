import { app, dialog, ipcMain, shell } from 'electron'
import { constants as fsConstants, promises as fs, rmSync } from 'node:fs'
import path from 'node:path'
import type { ExportCapabilities, ExportJob } from '../shared/api/export'
import type { ExportFormat } from '../shared/types'
import { exportArgs, gifCaptureArgs, gifEncodeArgs, gifPaletteArgs } from './exportArgs'
import { copyFileToClipboard } from './exportClipboard'
import { moveIntoPlace, partialPath, tempStem, toIpcError, validateJob } from './exportJob'
import { FrameEncoder, startFfmpeg, type FfmpegRun } from './ffmpeg'
import { detectH264Encoders } from './hwEncoders'
import * as projects from './projects'
import { getMainWindow } from './windows'

interface ActiveExport {
  encoder: FrameEncoder
  /** ffmpeg writes here; renamed over `finalPath` only after a successful finish. */
  tempPath: string
  finalPath: string
  gif: { intermediate: string; palette: string } | null
  pass2: FfmpegRun | null
  cancelled: boolean
}

let active: ActiveExport | null = null
let approvedExportPath: string | null = null
/** Files exported in this session (the only ones the clipboard action accepts). */
const exportedFiles = new Set<string>()

const CANCELLED = 'The export was cancelled.'

async function removeFiles(job: ActiveExport): Promise<void> {
  const files = [job.tempPath, job.gif?.intermediate, job.gif?.palette].filter((f): f is string => !!f)
  await Promise.all(files.map((f) => fs.rm(f, { force: true }).catch(() => undefined)))
}

function removeFilesSync(job: ActiveExport): void {
  for (const f of [job.tempPath, job.gif?.intermediate, job.gif?.palette]) {
    if (!f) continue
    try {
      rmSync(f, { force: true })
    } catch {
      // Best effort while quitting.
    }
  }
}

function cancelActive(sync = false): void {
  const job = active
  active = null
  if (!job) return
  job.cancelled = true
  job.encoder.kill()
  job.pass2?.kill()
  if (sync) removeFilesSync(job)
  else void removeFiles(job)
}

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

  ipcMain.handle('export:capabilities', async (): Promise<ExportCapabilities> => {
    const encoders = await detectH264Encoders()
    const decoder = process.env.SSW_EXPORT_DECODER
    const videoEncoder = process.env.SSW_EXPORT_VIDEO_ENCODER
    return {
      hardwareEncoders: encoders.filter((e) => e !== 'libx264'),
      overrides: {
        decoder: decoder === 'element' || decoder === 'webcodecs' ? decoder : undefined,
        videoEncoder: videoEncoder === 'webcodecs-software' || videoEncoder === 'ffmpeg' ? videoEncoder : undefined
      }
    }
  })

  ipcMain.handle('export:start', async (_e, projectId: string, job: ExportJob) => {
    if (!approvedExportPath || job.outputPath !== approvedExportPath) {
      throw new Error('Export path was not chosen through the save dialog')
    }
    validateJob(job)
    cancelActive()
    const finalPath = job.outputPath
    await fs.access(path.dirname(finalPath), fsConstants.W_OK).catch(() => {
      throw new Error(`Could not write to the folder "${path.dirname(finalPath)}". Choose another folder.`)
    })
    const tempPath = partialPath(finalPath)
    let gif: ActiveExport['gif'] = null
    let args: string[]
    if (job.format === 'gif') {
      const stem = tempStem(app.getPath('temp'))
      gif = { intermediate: `${stem}.mkv`, palette: `${stem}.png` }
      args = gifCaptureArgs(job, gif.intermediate)
    } else {
      const audioInput = job.audio ? path.join(projects.projectDir(projectId), 'screen.mp4') : null
      args = exportArgs(job, { audioInput, output: tempPath })
    }
    active = { encoder: new FrameEncoder(args), tempPath, finalPath, gif, pass2: null, cancelled: false }
  })

  ipcMain.handle('export:frame', (_e, data: Uint8Array) => {
    if (!active) throw new Error(CANCELLED)
    return active.encoder.write(data).catch((e: unknown) => {
      throw toIpcError(e)
    })
  })

  ipcMain.handle('export:finish', async () => {
    const job = active
    if (!job) throw new Error(CANCELLED)
    try {
      await job.encoder.finish()
      for (const args of job.gif ? [gifPaletteArgs(job.gif.intermediate, job.gif.palette), gifEncodeArgs(job.gif.intermediate, job.gif.palette, job.tempPath)] : []) {
        if (job.cancelled) break
        job.pass2 = startFfmpeg(args)
        await job.pass2.done
      }
      if (job.cancelled) throw new Error(CANCELLED)
      await moveIntoPlace(job.tempPath, job.finalPath)
      exportedFiles.add(job.finalPath)
      approvedExportPath = null
      return { bytes: (await fs.stat(job.finalPath)).size }
    } catch (e) {
      await removeFiles(job)
      throw job.cancelled ? new Error(CANCELLED) : toIpcError(e)
    } finally {
      if (job.gif) await removeFiles({ ...job, tempPath: '' })
      if (active === job) active = null
    }
  })

  ipcMain.handle('export:cancel', () => cancelActive())

  ipcMain.handle('export:copyToClipboard', (_e, file: string) => {
    if (!exportedFiles.has(file)) return { ok: false, message: 'Only files exported in this session can be copied.' }
    return copyFileToClipboard(file)
  })

  ipcMain.handle('shell:showItem', (_e, file: string) => shell.showItemInFolder(file))
}

/** On quit: stop any export and delete its partial files before the process exits. */
export function disposeExport(): void {
  cancelActive(true)
}
