import type { UpdaterEvent } from '../../shared/updates/updates'

/**
 * What UpdateService needs from an updater (docs/design/auto-update.md §2): electron-updater in a
 * packaged Windows build (electronUpdaterPort.ts), a scripted fake in development and the e2e tests
 * (fakeUpdaterPort.ts). Every outcome arrives as an event; the promises only say a step was asked.
 */
export interface UpdaterPort {
  /** Looks for a newer release: 'checking', then 'available', 'none' or 'error'. */
  check(): Promise<void>
  /** Downloads the release found: 'progress' events, then 'downloaded' or 'error'. */
  download(): Promise<void>
  /** Quits Flown, installs the downloaded release silently and opens Flown again. */
  install(): void
  /** Whether a downloaded release installs when Flown quits (off once its release is pulled). */
  setInstallOnQuit(on: boolean): void
  on(listener: (e: UpdaterEvent) => void): () => void
}
