/**
 * The real updater (docs/design/auto-update.md §1.2-§1.5): electron-updater's NSIS updater, fed by
 * this repository's GitHub releases (app-update.yml, written by electron-builder from `publish`).
 * Used only in a packaged Windows build; loaded on demand so development and the tests never load it.
 */
import type { App } from 'electron'
import type { UpdaterEvent } from '../../shared/updates/updates'
import type { UpdaterPort } from './updaterPort'

/** What the port needs from Electron's app: quitting, and hearing a quit start and end. */
export type QuitApp = Pick<App, 'quit' | 'on' | 'prependListener'>

/**
 * Sent in place of electron-updater's per-install id (userData/.updaterId), which it adds to every
 * request for staged roll-outs. Flown has none, and the same id on every check would let a copy's
 * check-ins be linked across networks.
 */
export const NO_STAGING_ID = '00000000-0000-4000-8000-000000000000'

export async function electronUpdaterPort(app: QuitApp): Promise<UpdaterPort> {
  const { autoUpdater } = await import('electron-updater')
  // Flown asks for the download itself (only when "Update Flown automatically" is on, §1.5).
  autoUpdater.autoDownload = false
  autoUpdater.autoInstallOnAppQuit = true
  autoUpdater.allowPrerelease = false
  autoUpdater.allowDowngrade = false
  autoUpdater.fullChangelog = false
  // Applied over the generated header, so the check sends the same value from every copy.
  autoUpdater.requestHeaders = { 'x-user-staging-id': NO_STAGING_ID }
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

  // Restart now quits as closing Flown does, so a window may still keep Flown open (a recording
  // being processed asks first). quitAndInstall would start the installer before that, and the
  // installer closes Flown by force whatever the answer; it starts here once Flown has really
  // quit. A quit that was called off leaves the next one an ordinary quit (no reopening, §1.5).
  let restartAsked = false
  let restartOnQuit = false
  app.on('before-quit', () => {
    restartOnQuit = restartAsked
    restartAsked = false
  })
  // Ahead of electron-updater's own quit handler (added by a download), which installs without reopening.
  app.prependListener('quit', (_e, exitCode) => {
    if (restartOnQuit && exitCode === 0 && autoUpdater.autoInstallOnAppQuit) autoUpdater.quitAndInstall(true, true)
  })

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
      // Then silent (the installer shows no pages), and Flown opens again afterwards.
      restartAsked = true
      app.quit()
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
