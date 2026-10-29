import type { JobOutcome } from '../jobs/longJobs'

/** What the page reports about an export it drives (docs/design/hands-off.md §2.1). */
export interface JobUpdate {
  /** Share done 0..1, or null when unknown (finalizing). */
  fraction: number | null
  paused: boolean
  /** Pause can be offered now (rendering frames). */
  pausable: boolean
}

/** A command from the taskbar or the power events for the page's job. */
export interface JobCommand {
  id: string
  action: 'pause' | 'resume' | 'stop'
  /** Set on pause/resume caused by the PC going to sleep and waking up. */
  sleep?: boolean
}

export interface JobsApi {
  /** Registers an export the page drives; resolves with its id. */
  jobBegin(kind: 'export', options: { pausable: boolean }): Promise<string>
  /** Progress of a job begun with jobBegin (one-way; unknown ids are ignored). */
  jobUpdate(id: string, update: JobUpdate): void
  /** Ends a job: notifies when the window is in the background. `files` must be files exported in this session. */
  jobEnd(id: string, outcome: JobOutcome): Promise<void>
  /** Taskbar buttons and sleep: pause, resume or stop the page's job. */
  onJobCommand(listener: (command: JobCommand) => void): () => void
}
