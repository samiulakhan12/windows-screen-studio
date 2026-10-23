import { app, dialog, ipcMain, shell, type WebContents } from 'electron'
import { constants as fsConstants, promises as fs } from 'node:fs'
import path from 'node:path'
import type { ExportCapabilities, ExportJob } from '../shared/api/export'
import type { ExportFormat } from '../shared/types'
import { exportArgs, gifCaptureArgs, gifEncodeArgs, gifPaletteArgs } from './exportArgs'
import { copyFileToClipboard } from './exportClipboard'
import { LeftoverLog, removeSyncWithRetries, removeWithRetries, settledWithin, sweepTempDir } from './exportCleanup'
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
  /** Stops watching the renderer that started the export. */
  unwatch: () => void
}

let active: ActiveExport | null = null
let approvedExportPath: string | null = null
/** Files exported in this session (the only ones the clipboard action accepts). */
const exportedFiles = new Set<string>()
/** Deletions waiting for a cancelled export's encoder to exit. */
const cleanups = new Set<Promise<void>>()
let log: LeftoverLog | null = null

const CANCELLED = 'The export was cancelled.'
/** Longest wait for a killed ffmpeg to exit before deleting its files anyway. */
const EXIT_WAIT_MS = 5000
/** Longest a quit waits for a cancelled export's clean-up. */
const QUIT_WAIT_MS = 4000

const tempFiles = (job: Pick<ActiveExport, 'tempPath' | 'gif'>): string[] => [job.tempPath, job.gif?.intermediate, job.gif?.palette].filter((f): f is string => !!f)

/** Deletes `files` (retrying while Windows still reports them in use) and forgets the ones that are gone. */
async function removeFiles(files: string[]): Promise<void> {
  const gone = await Promise.all(files.map((f) => removeWithRetries(f)))
  log?.remove(files.filter((_, i) => gone[i]))
}

/**
 * Stops the export's ffmpeg processes and deletes its files once they have exited:
 * on Windows a file still open in ffmpeg cannot be deleted (killing a process does
 * not wait for it to close its handles). Resolves when the files are gone.
 */
function cancelActive(): Promise<void> {
  const job = active
  active = null
  if (!job) return Promise.resolve()
  job.cancelled = true
  job.unwatch()
  job.encoder.kill()
  job.pass2?.kill()
  const pass2 = job.pass2
  const cleanup = settledWithin([job.encoder.done, pass2?.done], EXIT_WAIT_MS)
    .then(() => removeFiles(tempFiles(job)))
    .finally(() => cleanups.delete(cleanup))
  cleanups.add(cleanup)
  return cleanup
}

/** Resolves when no cancelled export is still being cleaned up. */
async function cleanupsDone(): Promise<void> {
  while (cleanups.size) await Promise.allSettled([...cleanups])
}

/**
 * Called when the renderer that started the export crashed, navigated away or was
 * closed: nobody will send frames or finish it, so ffmpeg would wait on its input
 * forever with the partial file open. Returns whether an export was stopped.
 */
export function abortExportOnRendererGone(): boolean {
  const had = !!active
  void cancelActive()
  approvedExportPath = null
  return had
}

/** Cancels the export if `owner`'s page goes away while it runs. */
function watchOwner(owner: WebContents, isCurrent: () => boolean): () => void {
  const gone = (): void => {
    if (isCurrent()) abortExportOnRendererGone()
  }
  owner.once('render-process-gone', gone)
  owner.once('destroyed', gone)
  // A reload or a navigation (in-page route changes are 'did-navigate-in-page').
  owner.once('did-navigate', gone)
  return () => {
    owner.removeListener('render-process-gone', gone)
    owner.removeListener('destroyed', gone)
    owner.removeListener('did-navigate', gone)
  }
}

export function registerExportIpc(): void {
  log = new LeftoverLog(path.join(app.getPath('userData'), 'export-leftovers.json'))
  // Whatever an earlier run left behind (it crashed, was killed, or a file stayed locked).
  void log.sweep().catch(() => undefined)
  void sweepTempDir(app.getPath('temp')).catch(() => undefined)

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
      gpuCanvas: String(app.getGPUFeatureStatus()['2d_canvas']).startsWith('enabled'),
      overrides: {
        decoder: decoder === 'element' || decoder === 'webcodecs' ? decoder : undefined,
        videoEncoder: videoEncoder === 'webcodecs-software' || videoEncoder === 'ffmpeg' ? videoEncoder : undefined
      }
    }
  })

  ipcMain.handle('export:start', async (e, projectId: string, job: ExportJob) => {
    if (!approvedExportPath || job.outputPath !== approvedExportPath) {
      throw new Error('Export path was not chosen through the save dialog')
    }
    validateJob(job)
    void cancelActive()
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
    // Logged before ffmpeg creates them, so a crash from here on is cleaned up at the next start.
    log?.add(tempFiles({ tempPath, gif }))
    const started: ActiveExport = { encoder: new FrameEncoder(args), tempPath, finalPath, gif, pass2: null, cancelled: false, unwatch: () => undefined }
    started.unwatch = watchOwner(e.sender, () => active === started)
    active = started
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
      log?.remove([job.tempPath])
      exportedFiles.add(job.finalPath)
      approvedExportPath = null
      return { bytes: (await fs.stat(job.finalPath)).size }
    } catch (e) {
      // Every ffmpeg of this job has exited by now (each was awaited), so the files can go.
      await removeFiles([job.tempPath])
      throw job.cancelled ? new Error(CANCELLED) : toIpcError(e)
    } finally {
      if (job.gif) await removeFiles([job.gif.intermediate, job.gif.palette])
      if (active === job) {
        active = null
        job.unwatch()
      }
    }
  })

  // Resolves once the export's files are deleted, so the renderer never sees them linger.
  ipcMain.handle('export:cancel', async () => {
    await cancelActive()
    await cleanupsDone()
  })

  ipcMain.handle('export:copyToClipboard', (_e, file: string) => {
    if (!exportedFiles.has(file)) return { ok: false, message: 'Only files exported in this session can be copied.' }
    return copyFileToClipboard(file)
  })

  ipcMain.handle('shell:showItem', (_e, file: string) => shell.showItemInFolder(file))

  // Quitting during an export: stop it and wait (briefly) until its files are deleted.
  let quitting = false
  app.on('before-quit', (e) => {
    if (quitting || (!active && cleanups.size === 0)) return
    quitting = true
    e.preventDefault()
    void cancelActive()
    void settledWithin([cleanupsDone()], QUIT_WAIT_MS).then(() => app.quit())
  })
}

/**
 * On will-quit: a last, synchronous stop of an export still running (normally
 * before-quit has already cleaned up). What cannot be deleted in time stays in the
 * log and is removed at the next start.
 */
export function disposeExport(): void {
  const job = active
  active = null
  if (!job) return
  job.cancelled = true
  job.unwatch()
  job.encoder.kill()
  job.pass2?.kill()
  const files = tempFiles(job)
  log?.remove(files.filter((f) => removeSyncWithRetries(f)))
}
