/**
 * The real updater (docs/design/auto-update.md §1.2-§1.5): electron-updater's NSIS updater, fed by
 * this repository's GitHub releases (app-update.yml, written by electron-builder from `publish`).
 * Used only in a packaged Windows build; loaded on demand so development and the tests never load it.
 */
import type { UpdaterEvent } from '../../shared/updates/updates'
import type { UpdaterPort } from './updaterPort'

export async function electronUpdaterPort(): Promise<UpdaterPort> {
  const { autoUpdater } = await import('electron-updater')
  // Flown asks for the download itself (only when "Update Flown automatically" is on, §1.5).
  autoUpdater.autoDownload = false
  autoUpdater.autoInstallOnAppQuit = true
  autoUpdater.allowPrerelease = false
  autoUpdater.allowDowngrade = false
  autoUpdater.fullChangelog = false
  // console reaches the app log (appLog.ts), which leaves the user's folders out.
  autoUpdater.logger = { info: (m) => console.info('[updates]', m), warn: (m) => console.warn('[updates]', m), error: (m) => console.error('[updates]', m), debug: () => undefined }

  const listeners = new Set<(e: UpdaterEvent) => void>()
  const emit = (e: UpdaterEvent): void => {
    for (const l of listeners) l(e)
  }
  let stage: 'check' | 'download' = 'check'
  autoUpdater.on('checking-for-update', () => emit({ type: 'checking' }))
  autoUpdater.on('update-available', (info) => emit({ type: 'available', version: info.version, notes: info.releaseNotes }))
  autoUpdater.on('update-not-available', () => emit({ type: 'none' }))
  autoUpdater.on('download-progress', (p) => emit({ type: 'progress', percent: p.percent }))
  autoUpdater.on('update-downloaded', (info) => emit({ type: 'downloaded', version: info.version, notes: info.releaseNotes }))
  autoUpdater.on('error', (err) => emit({ type: 'error', stage, message: err instanceof Error ? err.message : String(err) }))

  return {
    async check() {
      stage = 'check'
      // A failure was reported as an 'error' event already.
      await autoUpdater.checkForUpdates().catch(() => undefined)
    },
    async download() {
      stage = 'download'
      await autoUpdater.downloadUpdate().catch(() => undefined)
    },
    install() {
      // Silent (the installer shows no pages), and Flown opens again afterwards.
      autoUpdater.quitAndInstall(true, true)
    },
    setInstallOnQuit(on) {
      autoUpdater.autoInstallOnAppQuit = on
    },
    on(listener) {
      listeners.add(listener)
      return () => listeners.delete(listener)
    }
  }
}
