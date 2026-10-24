import { app, dialog, ipcMain, shell, type WebContents } from 'electron'
import { constants as fsConstants, existsSync, promises as fs } from 'node:fs'
import path from 'node:path'
import type { ExportCapabilities, ExportFinish, ExportJob } from '../shared/api/export'
import type { ExportFormat } from '../shared/types'
import { analyzeAudio, stopAudioAnalysis } from './audioAnalysis'
import { describeGifFit, ffmpegPlan, gifEncodeArgs, gifPaletteArgs, nextGifFit, type FfmpegPlan, type GifFit } from './exportArgs'
import { copyFileToClipboard } from './exportClipboard'
import { LeftoverLog, removeSyncWithRetries, removeWithRetries, settledWithin, sweepTempDir } from './exportCleanup'
import { batchFileOk, freeBatchPath, isPng, moveIntoPlace, partialPath, resolveSoundInputs, tempStem, toIpcError, validateJob } from './exportJob'
import { FrameEncoder, startFfmpeg, type FfmpegRun } from './ffmpeg'
import { detectH264Encoders } from './hwEncoders'
import * as projects from './projects'
import { getMainWindow } from './windows'

interface ActiveExport {
  job: ExportJob
  encoder: FrameEncoder
  /** ffmpeg writes here; renamed over `finalPath` only after a successful finish. */
  tempPath: string
  finalPath: string
  plan: FfmpegPlan
  /** The pass running after the capture (GIF palette, second pass, ...). */
  pass: FfmpegRun | null
  cancelled: boolean
  /** Stops watching the renderer that started the export. */
  unwatch: () => void
}

let active: ActiveExport | null = null
let approvedExportPath: string | null = null
let approvedThumbnailPath: string | null = null
/** Folder chosen for a batch export, and the paths handed out in it (each accepted once). */
let approvedFolder: string | null = null
const batchPaths = new Set<string>()
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
/** Most extra passes a GIF gets to fit its size limit. */
const GIF_FIT_ATTEMPTS = 5
/** Largest thumbnail accepted (a 4K PNG is ~10-25 MB). */
const MAX_THUMBNAIL_BYTES = 200 * 1024 * 1024

const SAVE_FILTERS: Record<ExportFormat | 'png', Electron.FileFilter> = {
  mp4: { name: 'MP4 video', extensions: ['mp4'] },
  gif: { name: 'GIF', extensions: ['gif'] },
  webm: { name: 'WebM video', extensions: ['webm'] },
  mov: { name: 'QuickTime movie', extensions: ['mov'] },
  m4a: { name: 'M4A audio', extensions: ['m4a'] },
  png: { name: 'PNG image', extensions: ['png'] }
}

const tempFiles = (job: Pick<ActiveExport, 'tempPath' | 'plan'>): string[] => [job.tempPath, ...job.plan.temps]

const fileExists = (file: string): Promise<boolean> => fs.access(file).then(() => true, () => false)

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
  job.pass?.kill()
  const pass = job.pass
  const cleanup = settledWithin([job.encoder.done, pass?.done], EXIT_WAIT_MS)
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
  approvedFolder = null
  batchPaths.clear()
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

/** Runs one ffmpeg pass of `job`, stoppable by a cancel. */
async function runPass(job: ActiveExport, args: string[]): Promise<void> {
  if (job.cancelled) throw new Error(CANCELLED)
  job.pass = startFfmpeg(args)
  await job.pass.done
}

/**
 * A GIF over its size limit is made again from the stored frames with a lower frame
 * rate, a smaller size and fewer colours until it fits (or nothing is left to reduce).
 */
async function fitGif(job: ActiveExport): Promise<Pick<ExportFinish, 'reduced' | 'overLimit'>> {
  const { gif } = job.plan
  const max = job.job.maxBytes
  if (!gif || !max) return {}
  const size = { width: job.job.width, height: job.job.height, fps: job.job.fps }
  let fit: GifFit = { fps: size.fps, scale: 1, colors: 256 }
  let reduced: string | undefined
  for (let attempt = 0; ; attempt++) {
    const bytes = (await fs.stat(job.tempPath)).size
    if (bytes <= max) return { reduced }
    const next = attempt < GIF_FIT_ATTEMPTS ? nextGifFit(fit, size, bytes, max) : null
    if (!next) return { reduced, overLimit: true }
    fit = next
    await runPass(job, gifPaletteArgs(gif.intermediate, gif.palette, fit, size))
    await runPass(job, gifEncodeArgs(gif.intermediate, gif.palette, job.tempPath, fit, size))
    reduced = describeGifFit(fit, size)
  }
}

export function registerExportIpc(): void {
  log = new LeftoverLog(path.join(app.getPath('userData'), 'export-leftovers.json'))
  // Whatever an earlier run left behind (it crashed, was killed, or a file stayed locked).
  void log.sweep().catch(() => undefined)
  void sweepTempDir(app.getPath('temp')).catch(() => undefined)

  ipcMain.handle('export:choosePath', async (_e, defaultName: string, format: ExportFormat | 'png') => {
    const main = getMainWindow()
    if (!main) return null
    const filter = SAVE_FILTERS[format]
    if (!filter) throw new Error('Invalid export format')
    const result = await dialog.showSaveDialog(main, {
      title: format === 'png' ? 'Save thumbnail' : 'Export recording',
      defaultPath: path.join(app.getPath('videos'), `${defaultName}.${filter.extensions[0]}`),
      filters: [filter]
    })
    const chosen = result.canceled || !result.filePath ? null : result.filePath
    if (format === 'png') approvedThumbnailPath = chosen
    else approvedExportPath = chosen
    return chosen
  })

  ipcMain.handle('export:chooseFolder', async () => {
    const main = getMainWindow()
    if (!main) return null
    const result = await dialog.showOpenDialog(main, {
      title: 'Export to folder',
      defaultPath: app.getPath('videos'),
      buttonLabel: 'Export here',
      properties: ['openDirectory', 'createDirectory', 'promptToCreate']
    })
    approvedFolder = result.canceled || !result.filePaths[0] ? null : result.filePaths[0]
    batchPaths.clear()
    return approvedFolder
  })

  ipcMain.handle('export:batchPath', (_e, folder: string, fileName: string) => {
    if (!approvedFolder || folder !== approvedFolder) throw new Error('Export folder was not chosen through the folder dialog')
    if (!batchFileOk(fileName)) throw new Error('Invalid export file name')
    const file = freeBatchPath(approvedFolder, fileName, (f) => existsSync(f) || batchPaths.has(f))
    batchPaths.add(file)
    return file
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

  ipcMain.handle('export:analyzeAudio', (_e, projectId: string, sources: unknown) => analyzeAudio(projectId, sources))

  ipcMain.handle('export:start', async (e, projectId: string, requested: ExportJob) => {
    const approved = !!requested?.outputPath && (requested.outputPath === approvedExportPath || batchPaths.has(requested.outputPath))
    if (!approved) throw new Error('Export path was not chosen through the save dialog')
    validateJob(requested)
    void cancelActive()
    const finalPath = requested.outputPath
    await fs.access(path.dirname(finalPath), fsConstants.W_OK).catch(() => {
      throw new Error(`Could not write to the folder "${path.dirname(finalPath)}". Choose another folder.`)
    })
    const tempPath = partialPath(finalPath)
    const sound = await resolveSoundInputs(requested, projects.projectDir(projectId), fileExists)
    const { job } = sound
    const plan = ffmpegPlan(job, { audioInput: sound.audioInput, stems: sound.stems, music: sound.music, output: tempPath, tempStem: tempStem(app.getPath('temp')) })
    // Logged before ffmpeg creates them, so a crash from here on is cleaned up at the next start.
    log?.add(tempFiles({ tempPath, plan }))
    for (const s of plan.scripts) await fs.writeFile(s.path, s.content, 'utf8')
    const started: ActiveExport = { job, encoder: new FrameEncoder(plan.capture), tempPath, finalPath, plan, pass: null, cancelled: false, unwatch: () => undefined }
    started.unwatch = watchOwner(e.sender, () => active === started)
    active = started
  })

  ipcMain.handle('export:frame', (_e, data: Uint8Array) => {
    if (!active) throw new Error(CANCELLED)
    return active.encoder.write(data).catch((e: unknown) => {
      throw toIpcError(e)
    })
  })

  ipcMain.handle('export:finish', async (): Promise<ExportFinish> => {
    const job = active
    if (!job) throw new Error(CANCELLED)
    try {
      await job.encoder.finish()
      for (const args of job.plan.passes) await runPass(job, args)
      const fit = await fitGif(job)
      if (job.cancelled) throw new Error(CANCELLED)
      await moveIntoPlace(job.tempPath, job.finalPath)
      log?.remove([job.tempPath])
      exportedFiles.add(job.finalPath)
      if (!batchPaths.delete(job.finalPath)) approvedExportPath = null
      return { bytes: (await fs.stat(job.finalPath)).size, ...fit }
    } catch (e) {
      // Every ffmpeg of this job has exited by now (each was awaited), so the files can go.
      await removeFiles([job.tempPath])
      throw job.cancelled ? new Error(CANCELLED) : toIpcError(e)
    } finally {
      await removeFiles(job.plan.temps)
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

  ipcMain.handle('export:saveThumbnail', async (_e, file: string, png: Uint8Array) => {
    if (!approvedThumbnailPath || file !== approvedThumbnailPath) throw new Error('Thumbnail path was not chosen through the save dialog')
    if (!(png instanceof Uint8Array) || png.byteLength > MAX_THUMBNAIL_BYTES || !isPng(png)) throw new Error('Invalid thumbnail image')
    await fs.access(path.dirname(file), fsConstants.W_OK).catch(() => {
      throw new Error(`Could not write to the folder "${path.dirname(file)}". Choose another folder.`)
    })
    const temp = partialPath(file)
    try {
      await fs.writeFile(temp, png)
      await moveIntoPlace(temp, file)
    } catch (e) {
      await removeWithRetries(temp)
      throw toIpcError((e as NodeJS.ErrnoException).code === 'ENOSPC' ? new Error('The disk is full.') : e)
    }
    approvedThumbnailPath = null
    exportedFiles.add(file)
    return { bytes: png.byteLength }
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
  stopAudioAnalysis()
  const job = active
  active = null
  if (!job) return
  job.cancelled = true
  job.unwatch()
  job.encoder.kill()
  job.pass?.kill()
  const files = tempFiles(job)
  log?.remove(files.filter((f) => removeSyncWithRetries(f)))
}
