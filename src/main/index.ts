import { app, BrowserWindow } from 'electron'
import path from 'node:path'
import { APP_NAME, APP_USER_MODEL_ID, LEGACY_APP_NAME } from '../shared/brand'
import { registerAiIpc } from './aiIpc'
import { registerAnalysisIpc } from './analysisIpc'
import { registerAssetIpc } from './assetIpc'
import { migrateRecordings, migrateUserData } from './brandMigration'
import { registerBrandIpc } from './brandIpc'
import { registerBrandKitIpc } from './brandKitIpc'
import { registerCaptionsIpc } from './captionsIpc'
import { disposeExport, registerExportIpc } from './exportIpc'
import { disposeImport, registerImportIpc } from './importVideo'
import { handleMediaProtocol, registerMediaScheme } from './mediaProtocol'
import { registerNotesIpc } from './notes/notesIpc'
import { registerPrefsIpc } from './prefsIpc'
import { projectsRoot, setLegacyProjectRoots } from './projects'
import { registerProjectsIpc } from './projectsIpc'
import { attachRecorderWindow, closeRecordingWindows, disposeRecording, focusApp, registerRecordingIpc } from './recordingIpc'
import { registerSecurity } from './security'
import { registerSpeechIpc } from './speech/speechIpc'
import { registerVoiceIpc } from './voice/voiceIpc'
import { createMainWindow } from './windows'
import { disposeJobs, registerJobsIpc, setTaskbarPort } from './longJobs'
import { electronTaskbarPort } from './longJobsPort'
import { registerExportBundleIpc } from './exportBundle'
import { appLog, startAppLog } from './appLog'
import { appNames, appRoots, registerDiagnosticsIpc } from './diagnostics'
import { registerStorageIpc } from './storageIpc'

// The app was called "Screen Studio for Windows" before: its userData folder moves to Flown's
// before anything reads it, and before the single-instance lock, which lives in it.
const userData = migrateUserData(path.join(app.getPath('appData'), LEGACY_APP_NAME), app.getPath('userData'))
if (userData.dir !== app.getPath('userData')) app.setPath('userData', userData.dir)
if (userData.plan === 'move') console.log(userData.error ? `Using the ${LEGACY_APP_NAME} settings in place (${userData.error})` : `Moved the ${LEGACY_APP_NAME} settings to ${APP_NAME}`)

// One instance only: a second one would fight over the input hook, the stop shortcut and the projects folder.
if (!app.requestSingleInstanceLock()) {
  app.quit()
} else {
  // The app's log (X-03): console lines, redacted, in userData/logs (docs/design/hands-off.md).
  startAppLog(path.join(app.getPath('userData'), 'logs'), appRoots(), appNames())
  console.info(`${APP_NAME} ${app.getVersion()} starting`)
  app.on('second-instance', focusApp)

  registerMediaScheme()

  const openMainWindow = (): void => attachRecorderWindow(createMainWindow(closeRecordingWindows))

  app.whenReady().then(() => {
    // After the lock, so two instances never move recordings at once; before any IPC lists them.
    const recordings = migrateRecordings(path.join(app.getPath('videos'), LEGACY_APP_NAME), projectsRoot())
    setLegacyProjectRoots(recordings.legacyRoots)
    if (recordings.moved || recordings.errors.length) {
      console.log(`Moved ${recordings.moved} item(s) of Videos\\${LEGACY_APP_NAME} to ${projectsRoot()}${recordings.errors.length ? `; kept in place: ${recordings.errors.join('; ')}` : ''}`)
    }
    app.setAppUserModelId(APP_USER_MODEL_ID) // = appId in electron-builder.config.cjs
    registerSecurity()
    registerBrandIpc()
    registerBrandKitIpc()
    handleMediaProtocol()
    registerRecordingIpc()
    // Speaker notes (teleprompter): Home, the notes window and the recording bar.
    registerNotesIpc()
    registerProjectsIpc()
    registerAssetIpc()
    registerAnalysisIpc()
    registerPrefsIpc()
    registerAiIpc()
    registerSpeechIpc()
    registerVoiceIpc()
    registerCaptionsIpc()
    registerExportIpc()
    registerImportIpc()
    // Hands-off long jobs (docs/design/hands-off.md): taskbar, notifications, keep-awake, sleep.
    setTaskbarPort(electronTaskbarPort())
    registerJobsIpc()
    registerExportBundleIpc()
    registerDiagnosticsIpc()
    registerStorageIpc()
    openMainWindow()
    app.on('activate', () => {
      if (BrowserWindow.getAllWindows().length === 0) openMainWindow()
    })
  })

  app.on('will-quit', (event) => {
    // Postponed by nativeCapture's guard (prepended) while a capture helper finalises its video;
    // the will-quit that follows runs this cleanup.
    if (event.defaultPrevented) return
    disposeRecording()
    disposeExport()
    disposeImport()
    disposeJobs()
    appLog()?.flushSync()
  })

  app.on('window-all-closed', () => {
    if (process.platform !== 'darwin') app.quit()
  })
}
