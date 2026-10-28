/**
 * "Copy diagnostics" (X-03, docs/design/hands-off.md §2.6): the Windows build, displays, GPU and
 * encoders, the capture helper's probe, how the last recording was made, running jobs and recent
 * log lines. Made here, redacted once more, shown in Settings, and copied by main itself: the page
 * only names the report it was shown.
 */
import { app, clipboard, ipcMain, screen, shell } from 'electron'
import { promises as fs } from 'node:fs'
import os from 'node:os'
import { formatDiagnostics, gpuDevice, type DiagnosticsReport, type Part } from '../shared/diagnostics/report'
import { redactLine, type RedactRoots } from '../shared/diagnostics/redact'
import type { CaptureInfo } from '../shared/types'
import { appLog } from './appLog'
import { detectH264Encoders } from './hwEncoders'
import { jobsSnapshot } from './longJobs'
import { probeNativeCapture, type ProbeResult } from './nativeCapture'
import { listProjects, projectsRoot, readProject } from './projects'
import { isAppUrl } from './security'

/** Longest wait for one part of the report. */
export const PART_TIMEOUT_MS = 10_000
/** Log lines in the report. */
export const LOG_LINES = 300

export interface DiagnosticsDeps {
  app: () => DiagnosticsReport['app']
  system: () => Promise<{ os: string; build: string; arch: string; cpu: string; cores: number; memoryGB: number }>
  displays: () => Promise<{ width: number; height: number; scale: number; hz: number; primary: boolean }[]>
  gpu: () => Promise<{ devices: unknown[]; features: Record<string, string> }>
  encoders: () => Promise<string[]>
  probe: () => Promise<ProbeResult>
  /** The newest recording's capture info and date, or null when there is none. */
  lastCapture: () => Promise<{ capture: CaptureInfo; createdAt: string } | null>
  recordings: () => Promise<number>
  jobs: () => string[]
  log: (n: number) => Promise<string[]>
  roots: RedactRoots
  now?: () => Date
}

/** `run` with a time limit; a failure or a timeout becomes the part's reason. */
export async function partOf<T>(run: () => Promise<T>, timeoutMs = PART_TIMEOUT_MS): Promise<Part<T>> {
  let timer: ReturnType<typeof setTimeout> | null = null
  try {
    const value = await Promise.race([
      run(),
      new Promise<never>((_, reject) => {
        timer = setTimeout(() => reject(new Error('timed out')), timeoutMs)
      })
    ])
    return { ok: true, value }
  } catch (err) {
    return { ok: false, reason: err instanceof Error ? err.message : String(err) }
  } finally {
    if (timer) clearTimeout(timer)
  }
}

/** What a recording's capture says about how it was made. */
function captureTarget(c: CaptureInfo): string {
  return c.target ?? (c.region ? 'area' : 'screen')
}

/** The report, every part collected at once, each within its time limit. */
export async function collectDiagnostics(deps: DiagnosticsDeps, timeoutMs = PART_TIMEOUT_MS): Promise<DiagnosticsReport> {
  const [system, displays, gpu, encoders, capture, lastCapture, recordings, log] = await Promise.all([
    partOf(deps.system, timeoutMs),
    partOf(deps.displays, timeoutMs),
    partOf(async () => {
      const g = await deps.gpu()
      return { devices: g.devices.map(gpuDevice), features: g.features }
    }, timeoutMs),
    partOf(deps.encoders, timeoutMs),
    partOf(async () => {
      const p = await deps.probe()
      return { supported: p.supported, windowCapture: p.windowCapture === true, cursorToggle: p.cursorToggle, borderToggle: p.borderToggle, encoders: p.hardwareEncoders, reason: p.reason }
    }, timeoutMs),
    partOf(async () => {
      const last = await deps.lastCapture()
      return last ? { method: last.capture.method, target: captureTarget(last.capture), cursorInVideo: last.capture.cursorInVideo, recordedAt: last.createdAt } : null
    }, timeoutMs),
    partOf(deps.recordings, timeoutMs),
    partOf(() => deps.log(LOG_LINES), timeoutMs)
  ])
  return { createdAt: (deps.now?.() ?? new Date()).toISOString(), app: deps.app(), system, displays, gpu, encoders, capture, lastCapture, recordings, jobs: deps.jobs(), log }
}

/** The report's text, every line redacted once more. */
export function diagnosticsText(report: DiagnosticsReport, roots: RedactRoots): string {
  return formatDiagnostics(report)
    .split('\n')
    .map((l) => redactLine(l, roots))
    .join('\n')
}

/** The app's own folders, whose paths stay readable in the log and the report. */
export function appRoots(): RedactRoots {
  const roots: Record<string, string> = { userData: app.getPath('userData'), projects: projectsRoot(), app: app.getAppPath() }
  if (process.resourcesPath) roots.resources = process.resourcesPath
  return roots
}

function electronDeps(): DiagnosticsDeps {
  return {
    app: () => ({ name: app.getName(), version: app.getVersion(), electron: process.versions.electron ?? '', chrome: process.versions.chrome ?? '', node: process.versions.node, packaged: app.isPackaged }),
    system: async () => ({
      os: process.platform === 'win32' ? 'Windows' : os.type(),
      build: process.getSystemVersion(),
      arch: process.arch,
      cpu: os.cpus()[0]?.model?.trim() ?? 'unknown',
      cores: os.cpus().length,
      memoryGB: Math.round((os.totalmem() / 1024 ** 3) * 10) / 10
    }),
    displays: async () => {
      const primary = screen.getPrimaryDisplay().id
      return screen.getAllDisplays().map((d) => ({ width: d.size.width, height: d.size.height, scale: d.scaleFactor, hz: Math.round(d.displayFrequency), primary: d.id === primary }))
    },
    gpu: async () => {
      const info = (await app.getGPUInfo('basic')) as { gpuDevice?: unknown[] }
      const features = Object.fromEntries(Object.entries(app.getGPUFeatureStatus()).map(([k, v]) => [k, String(v)]))
      return { devices: Array.isArray(info.gpuDevice) ? info.gpuDevice : [], features }
    },
    encoders: () => detectH264Encoders(),
    probe: () => probeNativeCapture(),
    lastCapture: async () => {
      const newest = (await listProjects())[0]
      if (!newest) return null
      const p = await readProject(newest.id)
      return { capture: p.capture, createdAt: p.createdAt }
    },
    recordings: async () => (await listProjects()).length,
    jobs: () => jobsSnapshot().map((j) => `${j.kind}${j.fraction !== null ? ` ${Math.round(j.fraction * 100)}%` : ''}${j.paused ? ' (paused)' : ''}`),
    log: async (n) => (await appLog()?.recent(n)) ?? [],
    roots: appRoots()
  }
}

let last: { id: string; text: string } | null = null
let counter = 0

export function registerDiagnosticsIpc(deps: () => DiagnosticsDeps = electronDeps): void {
  const fromApp = (e: Electron.IpcMainInvokeEvent): void => {
    if (!isAppUrl(e.senderFrame?.url ?? '')) throw new Error('Not allowed')
  }
  ipcMain.handle('diagnostics:collect', async (e) => {
    fromApp(e)
    const d = deps()
    const text = diagnosticsText(await collectDiagnostics(d), d.roots)
    last = { id: `d${++counter}`, text }
    return last
  })
  // Copies the report the page was shown (by its id), never text from the page.
  ipcMain.handle('diagnostics:copy', (e, id: unknown) => {
    fromApp(e)
    if (!last || id !== last.id) return false
    clipboard.writeText(last.text)
    return true
  })
  ipcMain.handle('diagnostics:openLogs', async (e) => {
    fromApp(e)
    const dir = appLog()?.dir
    if (!dir) return
    await fs.mkdir(dir, { recursive: true })
    await shell.openPath(dir)
  })
}
