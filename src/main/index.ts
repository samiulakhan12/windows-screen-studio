import { app, BrowserWindow } from 'electron'
import { registerAiIpc } from './aiIpc'
import { registerAnalysisIpc } from './analysisIpc'
import { registerAssetIpc } from './assetIpc'
import { disposeExport, registerExportIpc } from './exportIpc'
import { handleMediaProtocol, registerMediaScheme } from './mediaProtocol'
import { registerPrefsIpc } from './prefsIpc'
import { registerProjectsIpc } from './projectsIpc'
import { attachRecorderWindow, closeRecordingWindows, disposeRecording, focusApp, registerRecordingIpc } from './recordingIpc'
import { registerSecurity } from './security'
import { createMainWindow } from './windows'

// One instance only: a second one would fight over the input hook, the stop shortcut and the projects folder.
if (!app.requestSingleInstanceLock()) {
  app.quit()
} else {
  app.on('second-instance', focusApp)

  registerMediaScheme()

  const openMainWindow = (): void => attachRecorderWindow(createMainWindow(closeRecordingWindows))

  app.whenReady().then(() => {
    app.setAppUserModelId('com.samiulakhan12.screenstudio')
    registerSecurity()
    handleMediaProtocol()
    registerRecordingIpc()
    registerProjectsIpc()
    registerAssetIpc()
    registerAnalysisIpc()
    registerPrefsIpc()
    registerAiIpc()
    registerExportIpc()
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
  })

  app.on('window-all-closed', () => {
    if (process.platform !== 'darwin') app.quit()
  })
}
