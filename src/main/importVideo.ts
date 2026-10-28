/**
 * Importing a video made with another app as a new project (NW-07, docs/design/import-video.md):
 * the file is checked, probed with the bundled ffmpeg, test-decoded and turned into the same
 * editing copy (screen.mp4) a recording gets; the project has no cursor, click or key data. The
 * user's file is only read. A cancelled or failed import removes its folder; one interrupted by a
 * crash is removed at the next start (import.json without project.json).
 */
import { BrowserWindow, dialog, ipcMain, type IpcMainInvokeEvent, type WebContents } from 'electron'
import { spawn, type ChildProcess } from 'node:child_process'
import { promises as fs } from 'node:fs'
import path from 'node:path'
import type { ImportProgress, ImportResult } from '../shared/api/import'
import { createProject } from '../shared/engine/project'
import { zoomSettingsOf } from '../shared/engine/zoom'
import { checkFileSize, extensionOf, hasProtectedTrack, hitTimeCap, importableExtension, importArgs, importName, IMPORT_COPY, IMPORT_EXTENSIONS, IMPORT_LIMITS, planImport, sniffContainer, spaceNeeded, type ImportPlan } from '../shared/import/plan'
import { parseProbe, type ProbeInfo } from '../shared/import/probe'
import type { CursorTrack, Project } from '../shared/types'
import { ffmpegPath } from './ffmpeg'
import { detectH264Encoders, type H264Encoder } from './hwEncoders'
import * as projects from './projects'
import { proxyArgs } from './proxyArgs'
import { encodeWithFallback } from './recording/finalize'
import { FfmpegError, isCancelled } from './recording/proxyRunner'
import { isAppUrl } from './security'
import { applyStyleDefaults, loadStyleDefaults } from './styleDefaults'

/** Marks a folder whose import has not finished (§4.6). */
export const IMPORT_MARKER = 'import.json'
/** The editing copy while it is written; renamed to screen.mp4 when ffmpeg succeeded. */
const PART = 'screen.part.mp4'
const ID_RE = /^[a-zA-Z0-9_-]+$/
const PROBE_TIMEOUT_MS = 30_000
const DECODE_TIMEOUT_MS = 60_000
const LOG_CAP = 256 * 1024

/** The cursor track of an imported video: nothing recorded (the editor's "no cursor data"). */
export const EMPTY_TRACK: CursorTrack = { samples: [], clicks: [], keys: [], shapes: [], scale: 1, valid: false }

/** What the import needs from the machine; tests replace parts of it. */
export interface ImportDeps {
  /** Free bytes on the drive holding `dir`. */
  freeBytes(dir: string): Promise<number>
  /** The bundled ffmpeg has the zscale and tonemap filters. */
  toneMap(): Promise<boolean>
  /** H.264 encoders to try in order. */
  encoders(): Promise<H264Encoder[]>
  /** Whether the bundled ffmpeg decodes these streams (decodeTest). */
  decodes(file: string, video: number, audio: number | null, signal?: AbortSignal): Promise<boolean>
}

let toneMapCache: Promise<boolean> | null = null

export const defaultDeps: ImportDeps = {
  freeBytes: async (dir) => {
    const s = await fs.statfs(dir)
    return Number(s.bavail) * Number(s.bsize)
  },
  toneMap: () => {
    toneMapCache ??= runCapture(['-hide_banner', '-nostdin', '-filters'], { timeoutMs: 10_000 }).then(
      (r) => /\bzscale\b/.test(r.log) && /\btonemap\b/.test(r.log),
      () => false
    )
    return toneMapCache
  },
  encoders: async () => [...new Set<H264Encoder>([(await detectH264Encoders())[0], 'libx264'])],
  decodes: (file, video, audio, signal) => decodeTest(file, video, audio, signal)
}

/** The import was stopped on purpose. */
class Cancelled extends Error {}

/** A refusal or failure with the sentence the user reads. */
class ImportRefused extends Error {}

/** Probe and decode-test processes still running (the encode is killAllFfmpeg's). */
const probes = new Set<ChildProcess>()

/** Runs ffmpeg and returns its exit code and output (stdout and stderr, capped), killed after `timeoutMs`. */
export function runCapture(args: string[], opts: { timeoutMs: number; signal?: AbortSignal }): Promise<{ code: number | null; log: string; timedOut: boolean }> {
  return new Promise((resolve, reject) => {
    if (opts.signal?.aborted) {
      reject(new Cancelled())
      return
    }
    const proc = spawn(ffmpegPath(), args, { windowsHide: true, stdio: ['ignore', 'pipe', 'pipe'] })
    probes.add(proc)
    let log = ''
    let timedOut = false
    const add = (d: Buffer): void => {
      if (log.length < LOG_CAP) log += d.toString().slice(0, LOG_CAP - log.length)
    }
    proc.stdout.on('data', add)
    proc.stderr.on('data', add)
    const timer = setTimeout(() => {
      timedOut = true
      proc.kill('SIGKILL')
    }, opts.timeoutMs)
    const onAbort = (): void => {
      proc.kill('SIGKILL')
    }
    opts.signal?.addEventListener('abort', onAbort, { once: true })
    const done = (): void => {
      probes.delete(proc)
      clearTimeout(timer)
      opts.signal?.removeEventListener('abort', onAbort)
    }
    proc.on('error', (err) => {
      done()
      reject(err)
    })
    proc.on('close', (code) => {
      done()
      if (opts.signal?.aborted) reject(new Cancelled())
      else resolve({ code, log, timedOut })
    })
  })
}

/** The checks made before ffmpeg reads the file (§7). */
export async function checkImportFile(file: unknown): Promise<{ ok: true; bytes: number; fileName: string } | { ok: false; error: string }> {
  if (typeof file !== 'string' || file.length === 0 || file.length > 4096 || file.includes('\0') || /[\r\n]/.test(file) || !path.isAbsolute(file)) return { ok: false, error: IMPORT_COPY.cannotOpen }
  const fileName = path.basename(file)
  if (!importableExtension(fileName)) return { ok: false, error: IMPORT_COPY.extension }
  let stat
  try {
    stat = await fs.stat(file)
  } catch {
    return { ok: false, error: IMPORT_COPY.cannotOpen }
  }
  if (!stat.isFile()) return { ok: false, error: IMPORT_COPY.cannotOpen }
  const size = checkFileSize(stat.size)
  if (size) return { ok: false, error: size }
  let head: Buffer
  try {
    const handle = await fs.open(file, 'r')
    try {
      const buffer = Buffer.alloc(64)
      const { bytesRead } = await handle.read(buffer, 0, buffer.length, 0)
      head = buffer.subarray(0, bytesRead)
    } finally {
      await handle.close()
    }
  } catch {
    return { ok: false, error: IMPORT_COPY.cannotOpen }
  }
  if (!sniffContainer(head)) return { ok: false, error: IMPORT_COPY.notVideo(extensionOf(fileName)) }
  return { ok: true, bytes: stat.size, fileName }
}

const SCAN_BYTES = 8 * 1024 * 1024

/** Whether the first or last 8 MB of an MP4/MOV file (where its index is) show a DRM-protected track. */
export async function scanProtection(file: string, bytes: number): Promise<boolean> {
  const handle = await fs.open(file, 'r')
  try {
    const read = async (from: number, length: number): Promise<Buffer> => {
      const buffer = Buffer.alloc(length)
      const { bytesRead } = await handle.read(buffer, 0, length, from)
      return buffer.subarray(0, bytesRead)
    }
    if (hasProtectedTrack(await read(0, Math.min(bytes, SCAN_BYTES)))) return true
    return bytes > SCAN_BYTES && hasProtectedTrack(await read(Math.max(SCAN_BYTES - 16, bytes - SCAN_BYTES), Math.min(bytes, SCAN_BYTES)))
  } finally {
    await handle.close()
  }
}

/** What ffmpeg says about the file (§4.1 step 2). */
export async function probeFile(file: string, signal?: AbortSignal): Promise<ProbeInfo> {
  const r = await runCapture(['-hide_banner', '-nostdin', '-i', file], { timeoutMs: PROBE_TIMEOUT_MS, signal })
  return r.timedOut ? { opened: false, container: null, duration: null, streams: [], encrypted: false } : parseProbe(r.log)
}

/** Decodes the first frame (and the sound up to it): whether the bundled ffmpeg can read them. */
export async function decodeTest(file: string, video: number, audio: number | null, signal?: AbortSignal): Promise<boolean> {
  // No -xerror: a file that starts mid-GOP logs decode errors before its first good frame. No
  // time limit: the picture of a stream-copy trim can start seconds after its sound.
  const args = ['-hide_banner', '-nostdin', '-v', 'error', '-i', file, '-map', `0:${video}`, ...(audio !== null ? ['-map', `0:${audio}`] : []), '-frames:v', '1', '-progress', 'pipe:1', '-nostats', '-f', 'null', '-']
  const r = await runCapture(args, { timeoutMs: DECODE_TIMEOUT_MS, signal })
  const frames = Math.max(0, ...[...r.log.matchAll(/^frame=\s*(\d+)/gm)].map((m) => Number(m[1])))
  return r.code === 0 && !r.timedOut && frames >= 1
}

/** Removes folders of imports that never finished: import.json and no project.json (§4.6). */
export async function sweepAbandonedImports(skip?: string): Promise<string[]> {
  const root = projects.projectsRoot()
  const removed: string[] = []
  let entries
  try {
    entries = await fs.readdir(root, { withFileTypes: true })
  } catch {
    return removed
  }
  for (const e of entries) {
    // Dirent: a link to a folder is not a directory here, so links are never followed.
    if (!e.isDirectory() || !ID_RE.test(e.name) || e.name === skip) continue
    const dir = path.join(root, e.name)
    if (!(await projects.exists(path.join(dir, IMPORT_MARKER)))) continue
    if (await projects.exists(path.join(dir, 'project.json'))) {
      await fs.rm(path.join(dir, IMPORT_MARKER), { force: true }).catch(() => undefined)
      continue
    }
    await fs.rm(dir, { recursive: true, force: true, maxRetries: 3 }).then(
      () => removed.push(e.name),
      (err) => console.warn('Could not remove an unfinished import:', dir, err)
    )
  }
  return removed
}

export interface ImportOptions {
  signal?: AbortSignal
  onProgress?: (p: ImportProgress) => void
  deps?: Partial<ImportDeps>
  now?: () => Date
}

/** The user's sentence for an encoder failure. */
function encodeError(err: unknown): string {
  const e = err as NodeJS.ErrnoException
  const text = `${e?.message ?? ''}`
  if (e?.code === 'ENOSPC' || /No space left/i.test(text)) return IMPORT_COPY.diskFull
  return IMPORT_COPY.failed(err instanceof FfmpegError ? text : '')
}

/** The project of an imported video (§4.1 step 8). */
export function importedProject(init: { id: string; fileName: string; bytes: number; plan: ImportPlan; duration: number; hasAudio: boolean; now: Date }, look: (p: Project) => Project = (p) => p): Project {
  const { plan } = init
  const base = createProject({
    id: init.id,
    name: importName(init.fileName),
    duration: init.duration,
    width: plan.size.width,
    height: plan.size.height,
    hasWebcam: false,
    hasAudio: init.hasAudio,
    webcamOffset: 0,
    zooms: [],
    cursorValid: false,
    capture: { method: 'chromium', cursorInVideo: true, region: null, target: 'screen', fps: plan.fps }
  })
  base.createdAt = init.now.toISOString()
  const styled = look(base)
  const zs = zoomSettingsOf(styled)
  return {
    ...styled,
    // Nothing to zoom on automatically: auto zoom reads as off, not as "on but disabled".
    autoZoom: false,
    zoomSettings: { ...zs, auto: { ...zs.auto, enabled: false } },
    zooms: [],
    source: { ...plan.source, fileName: init.fileName.slice(0, 260), bytes: init.bytes, importedAt: init.now.toISOString() }
  }
}

/**
 * Imports the video at `file` as a new project. Never throws: a refusal, a failure or a cancel is
 * a result, and leaves no folder behind.
 */
export async function importVideo(file: unknown, options: ImportOptions = {}): Promise<ImportResult> {
  const deps = { ...defaultDeps, ...options.deps }
  const signal = options.signal
  const now = options.now ?? (() => new Date())
  const fileName = typeof file === 'string' ? path.basename(file) : null
  const report = (stage: ImportProgress['stage'], progress: number | null): void => options.onProgress?.({ fileName: fileName ?? '', stage, progress })
  const stop = (): void => {
    if (signal?.aborted) throw new Cancelled()
  }
  let dir: string | null = null
  try {
    report('checking', null)
    const checked = await checkImportFile(file)
    if (!checked.ok) throw new ImportRefused(checked.error)
    const input = file as string
    stop()
    const probe = await probeFile(input, signal)
    if (probe.opened && /mp4|mov/.test(probe.container ?? '') && (await scanProtection(input, checked.bytes).catch(() => false))) throw new ImportRefused(IMPORT_COPY.drm)
    const planned = planImport(probe, { toneMap: probe.streams.some((s) => s.transfer !== null) ? await deps.toneMap() : false })
    if (!planned.ok) throw new ImportRefused(planned.error)
    const plan = planned.plan
    stop()
    if (!(await deps.decodes(input, plan.videoStream, plan.audioStream, signal))) {
      if (plan.audioStream === null || !(await deps.decodes(input, plan.videoStream, null, signal))) {
        const video = probe.streams.find((s) => s.index === plan.videoStream)
        throw new ImportRefused(IMPORT_COPY.codec(video?.codec ?? 'unknown'))
      }
      // The picture reads but the sound does not: imported without sound.
      plan.audioStream = null
      plan.source = { ...plan.source, audioCodec: null }
      plan.notes = [...plan.notes, IMPORT_COPY.noteNoSound]
    }
    stop()
    await fs.mkdir(projects.projectsRoot(), { recursive: true })
    await sweepAbandonedImports()
    const needed = spaceNeeded(plan, checked.bytes)
    const free = await deps.freeBytes(projects.projectsRoot()).catch(() => Number.POSITIVE_INFINITY)
    if (free < needed) throw new ImportRefused(IMPORT_COPY.space(needed, free))
    stop()

    const created = await projects.createProjectDir(now())
    dir = created.dir
    await fs.writeFile(path.join(dir, IMPORT_MARKER), JSON.stringify({ version: 1, startedAt: now().toISOString(), fileName: checked.fileName }))
    const part = path.join(dir, PART)
    const expected = plan.duration !== null ? plan.duration * plan.fps : null
    report('converting', expected ? 0 : null)
    let last = 0
    const run = await encodeWithFallback(
      await deps.encoders(),
      (encoder) => importArgs(proxyArgs(input, part, plan.audioStream !== null, { fps: plan.fps, size: plan.size, progress: true, encoder }), plan),
      part,
      (frames) => {
        const t = Date.now()
        if (expected && t - last >= 100) {
          last = t
          report('converting', Math.min(1, frames / expected))
        }
      },
      signal
    ).catch((err: unknown) => {
      if (isCancelled(err) || signal?.aborted) throw new Cancelled()
      throw new ImportRefused(encodeError(err))
    })
    stop()
    report('finishing', 1)
    const duration = run.frames ? run.frames / plan.fps : 0
    if (!(duration > 0)) throw new ImportRefused(IMPORT_COPY.unreadable)
    // A file that did not say how long it is (live WebM) is measured here.
    if (duration < IMPORT_LIMITS.minSeconds) throw new ImportRefused(IMPORT_COPY.tooShort)
    const notes = [...plan.notes]
    if (hitTimeCap(plan.duration, duration)) notes.push(IMPORT_COPY.noteCapped)
    await fs.rename(part, path.join(dir, 'screen.mp4'))

    let defaults: Awaited<ReturnType<typeof loadStyleDefaults>> = null
    try {
      defaults = await loadStyleDefaults()
    } catch (err) {
      console.warn('Could not read the saved default style:', err)
    }
    const look = (p: Project): Project => {
      try {
        return applyStyleDefaults(p, defaults)
      } catch (err) {
        console.warn('Could not apply the saved default style:', err)
        return p
      }
    }
    const project = importedProject({ id: created.id, fileName: checked.fileName, bytes: checked.bytes, plan, duration, hasAudio: plan.audioStream !== null && run.inputHasAudio, now: now() }, look)
    stop()
    await projects.writeCursor(created.id, EMPTY_TRACK)
    await projects.writeProject(project)
    await fs.rm(path.join(dir, IMPORT_MARKER), { force: true }).catch(() => undefined)
    return { ok: true, projectId: created.id, fileName: checked.fileName, notes }
  } catch (err) {
    if (dir) await fs.rm(dir, { recursive: true, force: true, maxRetries: 3 }).catch((e) => console.warn('Could not remove the unfinished import', dir, e))
    if (err instanceof Cancelled || signal?.aborted) return { ok: false, cancelled: true, fileName }
    if (err instanceof ImportRefused) return { ok: false, fileName, error: err.message }
    console.error('Import failed:', err)
    if ((err as NodeJS.ErrnoException)?.code === 'ENOSPC') return { ok: false, fileName, error: IMPORT_COPY.diskFull }
    return { ok: false, fileName, error: IMPORT_COPY.failed(err instanceof Error ? err.message.slice(0, 160) : '') }
  }
}

/* ---------- IPC ---------- */

let active: AbortController | null = null

const guard = (e: IpcMainInvokeEvent): void => {
  if (!isAppUrl(e.senderFrame?.url ?? '')) throw new Error('Not allowed')
}

/** Runs one import for `sender`, sending it progress; refuses a second one while one runs. */
async function runFor(sender: WebContents, file: unknown): Promise<ImportResult> {
  if (active) return { ok: false, fileName: typeof file === 'string' ? path.basename(file) : null, error: IMPORT_COPY.busy }
  const controller = new AbortController()
  active = controller
  // The page that asked is gone (reloaded, closed): nobody can see or cancel the import, so stop it.
  const stop = (): void => controller.abort()
  const onNavigate = (e: Electron.Event<Electron.WebContentsDidStartNavigationEventParams>): void => {
    if (e.isMainFrame && !e.isSameDocument) stop()
  }
  sender.on('did-start-navigation', onNavigate)
  sender.once('destroyed', stop)
  try {
    return await importVideo(file, {
      signal: controller.signal,
      onProgress: (p) => {
        if (!sender.isDestroyed()) sender.send('import:progress', p)
      }
    })
  } finally {
    active = null
    if (!sender.isDestroyed()) {
      sender.off('did-start-navigation', onNavigate)
      sender.off('destroyed', stop)
    }
  }
}

/** Stops a running import and its ffmpeg processes (the app is quitting); its folder is swept at the next start. */
export function disposeImport(): void {
  active?.abort()
  for (const proc of probes) proc.kill('SIGKILL')
  probes.clear()
}

export function registerImportIpc(): void {
  // Folders left by an import the app could not finish (it was closed or crashed).
  void sweepAbandonedImports().then((ids) => ids.length && console.log(`Removed ${ids.length} unfinished import(s)`))

  ipcMain.handle('import:pick', async (e): Promise<ImportResult | null> => {
    guard(e)
    if (active) return { ok: false, fileName: null, error: IMPORT_COPY.busy }
    const win = BrowserWindow.fromWebContents(e.sender)
    const options: Electron.OpenDialogOptions = {
      title: 'Import a video',
      properties: ['openFile'],
      filters: [
        { name: 'Videos', extensions: [...IMPORT_EXTENSIONS] },
        { name: 'All files', extensions: ['*'] }
      ]
    }
    const picked = win ? await dialog.showOpenDialog(win, options) : await dialog.showOpenDialog(options)
    if (picked.canceled || !picked.filePaths[0]) return null
    return runFor(e.sender, picked.filePaths[0])
  })

  ipcMain.handle('import:file', (e, file: unknown) => {
    guard(e)
    return runFor(e.sender, file)
  })

  ipcMain.handle('import:cancel', (e) => {
    guard(e)
    active?.abort()
  })
}
