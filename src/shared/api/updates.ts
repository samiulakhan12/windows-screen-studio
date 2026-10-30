import type { UpdateState } from '../updates/updates'

/** Restart now: done (Flown quits and installs), or why it cannot run now. */
export type UpdateInstallResult = { ok: true } | { ok: false; reason: string }

/** Flown's own updates (NW-15, docs/design/auto-update.md). */
export interface UpdatesApi {
  updatesGet(): Promise<UpdateState>
  /** Looks for a newer version now (also when automatic updates are off). */
  updatesCheck(): Promise<UpdateState>
  /** Downloads the version found (automatic updates off). */
  updatesDownload(): Promise<UpdateState>
  /** Quits Flown, installs the downloaded update and opens Flown again; refused while a job runs. */
  updatesInstall(): Promise<UpdateInstallResult>
  /** "Update Flown automatically". */
  updatesSetAuto(on: boolean): Promise<UpdateState>
  /** Every change of the state; returns the unsubscribe. */
  onUpdatesChanged(listener: (state: UpdateState) => void): () => void
}
