/**
 * Long jobs (F-12, docs/design/hands-off.md): one registry of the exports, captions and analyses
 * running now, and the one owner of what they show outside the window: the taskbar button's
 * progress, Pause / Stop on its thumbnail, "Export finished" notifications, keeping the PC awake
 * and pausing around sleep. Jobs in main register with beginJob(); exports, which the page drives,
 * register through jobs:begin / jobs:update / jobs:end and get their commands as jobs:command.
 * Everything Electron-specific goes through a TaskbarPort (longJobsPort.ts), which tests replace.
 */
import { ipcMain, type IpcMainEvent, type IpcMainInvokeEvent } from 'electron'
import { promises as fs } from 'node:fs'
import type { JobCommand, JobUpdate } from '../shared/api/jobs'
import {
  JOB_TIMING,
  leadJob,
  notificationFor,
  taskbarState,
  thumbarButtons,
  type JobKind,
  type JobOutcome,
  type JobView,
  type NotificationCopy,
  type TaskbarState,
  type ThumbAction,
  type ThumbButton
} from '../shared/jobs/longJobs'
import { isAppUrl } from './security'

export type PowerEvent = 'suspend' | 'resume' | 'lock-screen' | 'unlock-screen'

/** What the registry needs from Electron (longJobsPort.ts), replaced in tests. */
export interface TaskbarPort {
  setProgress(state: TaskbarState): void
  setButtons(buttons: ThumbButton[], onClick: (action: ThumbAction) => void): void
  /** Whether the app's window has the focus (no notification then). */
  isFocused(): boolean
  /** Flashes the taskbar button until the window is focused. */
  flash(): void
  notify(copy: NotificationCopy, handlers: { open: () => void; show: () => void }): void
  keepAwake(on: boolean): void
  onPower(listener: (event: PowerEvent) => void): void
  /** Opens / shows an exported file (shell.openPath / showItemInFolder). */
  openFile(file: string): void
  showFile(file: string): void
}

/** The page that drives a job: it gets the commands, and its going away ends the job. */
export interface JobOwner {
  id: number
  send(channel: string, ...args: unknown[]): void
  isDestroyed(): boolean
  once(event: 'destroyed' | 'render-process-gone' | 'did-navigate', listener: () => void): unknown
  removeListener(event: 'destroyed' | 'render-process-gone' | 'did-navigate', listener: () => void): unknown
}

export interface JobSpec {
  kind: JobKind
  pausable?: boolean
  stoppable?: boolean
  /** Main-side stop (captions); page jobs are stopped by a command to their owner. */
  onStop?: () => void
  owner?: JobOwner
  /** A captions job's recording name, for its notification. */
  name?: string
}

export interface JobHandle {
  readonly id: string
  update(update: Partial<JobUpdate>): void
  end(outcome: JobOutcome): Promise<void>
}

interface Job extends JobView {
  spec: JobSpec
  /** Paused by the registry because the PC went to sleep (resumed when it wakes). */
  sleepPaused: boolean
  unwatch: () => void
}

export const JOB_COMMAND_CHANNEL = 'jobs:command'

let port: TaskbarPort | null = null
let portHooked = false
const jobs = new Map<string, Job>()
let counter = 0
let failedAt: number | null = null
let lastState = ''
let lastButtons = ''
let awake = false
let refreshTimer: ReturnType<typeof setTimeout> | null = null
let resumeTimer: ReturnType<typeof setTimeout> | null = null
/** Size of a file an export wrote in this session, or null when it is not one (exportIpc.ts). */
let exportedSize: (file: string) => Promise<number | null> = async () => null

/** Sets the Electron side (or a fake in tests); the power events are hooked once. */
export function setTaskbarPort(next: TaskbarPort | null): void {
  port = next
  portHooked = false
  lastState = ''
  lastButtons = ''
  awake = false
  hookPower()
}

/** Which files an export wrote in this session (exportIpc.ts): only those are opened from a notification. */
export function setExportedFileCheck(check: (file: string) => boolean): void {
  exportedSize = async (file) => {
    if (typeof file !== 'string' || !check(file)) return null
    return fs.stat(file).then((s) => (s.isFile() ? s.size : null), () => null)
  }
}

function hookPower(): void {
  if (!port || portHooked) return
  portHooked = true
  port.onPower(onPower)
}

const views = (): JobView[] => [...jobs.values()]

/** The taskbar state, the thumbnail buttons and keep-awake from the jobs now. */
function refresh(): void {
  if (!port) return
  const now = Date.now()
  const state = taskbarState(views(), now, failedAt)
  const key = `${state.mode}:${state.value.toFixed(3)}`
  if (key !== lastState) {
    lastState = key
    port.setProgress(state)
  }
  const buttons = thumbarButtons(views(), now)
  const bkey = JSON.stringify(buttons)
  if (bkey !== lastButtons) {
    lastButtons = bkey
    port.setButtons(buttons, onThumb)
  }
  // A paused job does not keep the PC awake: a paused export may wait for hours.
  const want = views().some((j) => !j.paused)
  if (want !== awake) {
    awake = want
    port.keepAwake(want)
  }
  // Wake up again when a young job becomes visible or a failure's red runs out.
  if (refreshTimer) clearTimeout(refreshTimer)
  refreshTimer = null
  const young = views().filter((j) => now - j.startedAt < JOB_TIMING.showAfterMs)
  const waits = young.map((j) => j.startedAt + JOB_TIMING.showAfterMs - now)
  if (failedAt !== null && now - failedAt < JOB_TIMING.errorMs) waits.push(failedAt + JOB_TIMING.errorMs - now)
  if (waits.length) refreshTimer = setTimeout(refresh, Math.max(10, Math.min(...waits) + 5))
}

/** Sends `action` to `job`: its owner page, or its main-side stop. */
function command(job: Job, action: JobCommand['action'], sleep = false): void {
  if (action === 'stop' && job.spec.onStop) {
    job.spec.onStop()
    return
  }
  const owner = job.spec.owner
  if (!owner || owner.isDestroyed()) return
  const cmd: JobCommand = sleep ? { id: job.id, action, sleep } : { id: job.id, action }
  owner.send(JOB_COMMAND_CHANNEL, cmd)
}

/** A thumbnail button: it acts on the job the taskbar shows. */
function onThumb(action: ThumbAction): void {
  const lead = thumbLead()
  if (!lead) return
  if (action === 'resume') lead.sleepPaused = false
  command(lead, action)
}

function thumbLead(): Job | null {
  const lead = leadJob(views(), Date.now())
  return lead ? (jobs.get(lead.id) ?? null) : null
}

function onPower(event: PowerEvent): void {
  if (event === 'lock-screen' || event === 'unlock-screen') {
    // Jobs keep running while the screen is locked (hands-off); noted for diagnostics.
    if (jobs.size) console.info(`Screen ${event === 'lock-screen' ? 'locked' : 'unlocked'} with ${jobs.size} job(s) running`)
    return
  }
  if (event === 'suspend') {
    if (resumeTimer) clearTimeout(resumeTimer)
    resumeTimer = null
    for (const job of jobs.values()) {
      if (job.paused || !job.pausable) continue
      job.sleepPaused = true
      job.paused = true
      command(job, 'pause', true)
    }
    if (jobs.size) console.info('The PC is going to sleep: paused the jobs that can pause')
    refresh()
    return
  }
  // resume: give the GPU and disks a moment first.
  if (resumeTimer) clearTimeout(resumeTimer)
  resumeTimer = setTimeout(() => {
    resumeTimer = null
    for (const job of jobs.values()) {
      if (!job.sleepPaused) continue
      job.sleepPaused = false
      job.paused = false
      command(job, 'resume', true)
    }
    refresh()
  }, JOB_TIMING.resumeAfterSleepMs)
}

const clampFraction = (v: unknown): number | null => (typeof v === 'number' && Number.isFinite(v) ? Math.min(1, Math.max(0, v)) : null)

function applyUpdate(job: Job, u: Partial<JobUpdate>): void {
  if ('fraction' in u) job.fraction = clampFraction(u.fraction)
  if (typeof u.pausable === 'boolean') job.pausable = u.pausable
  // While paused for sleep the registry owns the state: a progress message sent before the page
  // got the pause must not mark it running (it would then never be resumed on waking).
  if (typeof u.paused === 'boolean' && !job.sleepPaused) job.paused = u.paused
}

async function endJob(job: Job, outcome: JobOutcome): Promise<void> {
  if (jobs.get(job.id) !== job) return
  jobs.delete(job.id)
  job.unwatch()
  if (outcome.kind === 'failed') failedAt = Date.now()
  else if (outcome.kind === 'done') failedAt = null
  refresh()
  if (!port) return
  const files: { path: string; bytes: number }[] = []
  if (outcome.kind === 'done' && job.kind === 'export') {
    for (const f of (outcome.files ?? []).slice(0, 500)) {
      const bytes = await exportedSize(f)
      if (bytes !== null) files.push({ path: f, bytes })
    }
  }
  if (port.isFocused()) return
  const copy = notificationFor(job.kind, outcome, files, job.spec.name)
  if (!copy) return
  port.flash()
  const first = files[0]?.path
  port.notify(copy, {
    open: () => first && port?.openFile(first),
    show: () => first && port?.showFile(first)
  })
}

/** Registers a running job; its handle reports progress and ends it. */
export function beginJob(spec: JobSpec): JobHandle {
  hookPower()
  const id = `j${(counter++).toString(36)}${Date.now().toString(36)}`
  const job: Job = {
    id,
    kind: spec.kind,
    fraction: null,
    paused: false,
    pausable: spec.pausable === true,
    stoppable: spec.stoppable ?? (spec.kind === 'export' || !!spec.onStop),
    startedAt: Date.now(),
    spec,
    sleepPaused: false,
    unwatch: () => undefined
  }
  const owner = spec.owner
  if (owner) {
    // The page that drives it went away (closed, crashed, reloaded): nobody will finish it.
    const gone = (): void => void endJob(job, { kind: 'cancelled' })
    owner.once('destroyed', gone)
    owner.once('render-process-gone', gone)
    owner.once('did-navigate', gone)
    job.unwatch = () => {
      owner.removeListener('destroyed', gone)
      owner.removeListener('render-process-gone', gone)
      owner.removeListener('did-navigate', gone)
    }
  }
  jobs.set(id, job)
  refresh()
  return {
    id,
    update: (u) => {
      if (jobs.get(id) !== job) return
      applyUpdate(job, u)
      refresh()
    },
    end: (outcome) => endJob(job, outcome)
  }
}

/** The running jobs (tests and diagnostics). */
export function jobsSnapshot(): JobView[] {
  return views().map(({ id, kind, fraction, paused, pausable, stoppable, startedAt }) => ({ id, kind, fraction, paused, pausable, stoppable, startedAt }))
}

/** Drops every job and timer (quit, tests). */
export function disposeJobs(): void {
  for (const job of jobs.values()) job.unwatch()
  jobs.clear()
  if (refreshTimer) clearTimeout(refreshTimer)
  if (resumeTimer) clearTimeout(resumeTimer)
  refreshTimer = null
  resumeTimer = null
  failedAt = null
  refresh()
}

const handles = new Map<string, { handle: JobHandle; owner: number }>()

function fromApp(e: IpcMainInvokeEvent | IpcMainEvent): boolean {
  return isAppUrl(e.senderFrame?.url ?? '')
}

function validOutcome(raw: unknown): JobOutcome {
  const o = (raw ?? {}) as { kind?: unknown; files?: unknown; message?: unknown }
  if (o.kind === 'done') {
    const r = raw as { failed?: unknown; stopped?: unknown }
    return {
      kind: 'done',
      files: Array.isArray(o.files) ? o.files.filter((f): f is string => typeof f === 'string').slice(0, 500) : [],
      ...(typeof r.failed === 'number' && Number.isInteger(r.failed) && r.failed > 0 ? { failed: Math.min(r.failed, 10_000) } : {}),
      ...(r.stopped === true ? { stopped: true } : {})
    }
  }
  if (o.kind === 'failed') return { kind: 'failed', message: typeof o.message === 'string' ? o.message.slice(0, 2000) : '' }
  return { kind: 'cancelled' }
}

export function registerJobsIpc(): void {
  ipcMain.handle('jobs:begin', (e, kind: unknown, options: unknown) => {
    if (!fromApp(e)) throw new Error('Not allowed')
    if (kind !== 'export') throw new Error('Invalid job')
    const pausable = (options as { pausable?: unknown } | null)?.pausable === true
    for (const key of handles.keys()) if (!jobs.has(key)) handles.delete(key)
    const handle = beginJob({ kind: 'export', pausable, stoppable: true, owner: e.sender })
    handles.set(handle.id, { handle, owner: e.sender.id })
    return handle.id
  })
  ipcMain.on('jobs:update', (e, id: unknown, update: unknown) => {
    if (!fromApp(e) || typeof id !== 'string') return
    const h = handles.get(id)
    if (!h || h.owner !== e.sender.id || !update || typeof update !== 'object') return
    const u = update as Record<string, unknown>
    const clean: Partial<JobUpdate> = {}
    if ('fraction' in u) clean.fraction = clampFraction(u.fraction)
    if (typeof u.paused === 'boolean') clean.paused = u.paused
    if (typeof u.pausable === 'boolean') clean.pausable = u.pausable
    h.handle.update(clean)
  })
  ipcMain.handle('jobs:end', async (e, id: unknown, outcome: unknown) => {
    if (!fromApp(e) || typeof id !== 'string') return
    const h = handles.get(id)
    if (!h || h.owner !== e.sender.id) return
    handles.delete(id)
    await h.handle.end(validOutcome(outcome))
  })
}
