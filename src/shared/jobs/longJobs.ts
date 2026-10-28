/**
 * Long jobs (F-12, docs/design/hands-off.md): what the taskbar button, its thumbnail buttons and
 * the notifications show for the jobs running now. Pure; src/main/longJobs.ts applies it.
 */

export type JobKind = 'export' | 'captions' | 'analysis'

/** What a running job looks like to the taskbar. */
export interface JobView {
  id: string
  kind: JobKind
  /** Share done 0..1, or null when it is not known (finalizing, analysis). */
  fraction: number | null
  /** Paused by the user or for sleep. */
  paused: boolean
  /** Whether Pause can be offered right now (exports while rendering). */
  pausable: boolean
  /** Whether Stop can be offered. */
  stoppable: boolean
  /** Date.now() when it began. */
  startedAt: number
}

export const JOB_TIMING = {
  /** A job younger than this is not shown on the taskbar (no flicker for quick analysis). */
  showAfterMs: 1000,
  /** How long the taskbar stays red after a failure. */
  errorMs: 4000,
  /** Wait after the PC wakes before resuming the jobs paused for sleep. */
  resumeAfterSleepMs: 3000
} as const

export type TaskbarMode = 'none' | 'normal' | 'indeterminate' | 'paused' | 'error'

export interface TaskbarState {
  mode: TaskbarMode
  /** 0..1 for normal and paused; 0 otherwise. */
  value: number
}

const ORDER: Record<JobKind, number> = { export: 0, captions: 1, analysis: 2 }

const clamp01 = (v: number): number => (Number.isFinite(v) ? Math.min(1, Math.max(0, v)) : 0)

/** The job the taskbar speaks for: exports first, then captions, then analysis; the oldest of a kind. */
export function leadJob(jobs: readonly JobView[], now: number): JobView | null {
  const shown = jobs.filter((j) => now - j.startedAt >= JOB_TIMING.showAfterMs)
  if (!shown.length) return null
  return [...shown].sort((a, b) => ORDER[a.kind] - ORDER[b.kind] || a.startedAt - b.startedAt)[0]
}

/**
 * The taskbar button's progress: the lead job's share (paused: the same share in the paused
 * colour; unknown share: indeterminate), red for a while after a failure when nothing runs.
 */
export function taskbarState(jobs: readonly JobView[], now: number, failedAt: number | null = null): TaskbarState {
  const lead = leadJob(jobs, now)
  if (lead) {
    if (lead.fraction === null) return lead.paused ? { mode: 'paused', value: 0 } : { mode: 'indeterminate', value: 0 }
    return { mode: lead.paused ? 'paused' : 'normal', value: clamp01(lead.fraction) }
  }
  if (failedAt !== null && now - failedAt < JOB_TIMING.errorMs) return { mode: 'error', value: 1 }
  return { mode: 'none', value: 0 }
}

export type ThumbAction = 'pause' | 'resume' | 'stop'

export interface ThumbButton {
  action: ThumbAction
  tooltip: string
  enabled: boolean
}

/**
 * The thumbnail toolbar of the lead job: Pause or Resume (exports; disabled while finalizing) and
 * Stop. Empty when no shown job can be paused or stopped.
 */
export function thumbarButtons(jobs: readonly JobView[], now: number): ThumbButton[] {
  const lead = leadJob(jobs, now)
  if (!lead) return []
  const out: ThumbButton[] = []
  if (lead.kind === 'export') {
    out.push(lead.paused ? { action: 'resume', tooltip: 'Resume export', enabled: true } : { action: 'pause', tooltip: 'Pause export', enabled: lead.pausable })
  }
  if (lead.stoppable) out.push({ action: 'stop', tooltip: lead.kind === 'export' ? 'Stop export' : 'Stop making captions', enabled: true })
  return out
}

/** How a job ended. Files are absolute paths of what an export wrote (checked by main). */
export type JobOutcome = { kind: 'done'; files?: string[]; label?: string } | { kind: 'cancelled' } | { kind: 'failed'; message: string }

export interface NotificationCopy {
  title: string
  body: string
  /** Buttons, in order; their actions are fixed by main. */
  actions: ('open' | 'show')[]
}

const fileName = (file: string): string => file.split(/[\\/]/).pop() ?? file
const folderName = (file: string): string => {
  const parts = file.split(/[\\/]/).filter(Boolean)
  return parts.length > 1 ? parts[parts.length - 2] : file
}

/** "24.1 MB" */
export function sizeText(bytes: number): string {
  if (bytes >= 1e9) return `${(bytes / 1e9).toFixed(2)} GB`
  if (bytes >= 1e6) return `${(bytes / 1e6).toFixed(1)} MB`
  return `${Math.max(1, Math.round(bytes / 1e3))} KB`
}

/**
 * The notification for a finished job, or null for none (cancelled, analysis, an export that wrote
 * nothing). `files` are the job's checked files with their sizes; `name` a captions job's recording.
 */
export function notificationFor(kind: JobKind, outcome: JobOutcome, files: readonly { path: string; bytes: number }[], name = ''): NotificationCopy | null {
  if (outcome.kind === 'cancelled' || kind === 'analysis') return null
  if (outcome.kind === 'failed') {
    const reason = outcome.message.split(/\n/)[0].trim().slice(0, 200)
    return { title: kind === 'export' ? 'Export failed' : 'Captions failed', body: reason || 'Something went wrong.', actions: [] }
  }
  if (kind === 'captions') return { title: 'Captions are ready', body: name || 'Your recording has captions now.', actions: [] }
  if (!files.length) return null
  if (files.length === 1) return { title: 'Export finished', body: `${fileName(files[0].path)} · ${sizeText(files[0].bytes)}`, actions: ['open', 'show'] }
  return { title: `${files.length} files exported`, body: folderName(files[0].path), actions: ['show'] }
}
