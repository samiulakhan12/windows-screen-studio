import { app, BrowserWindow } from 'electron'
import { disposeExport, registerExportIpc } from './exportIpc'
import { handleMediaProtocol, registerMediaScheme } from './mediaProtocol'
import { registerProjectsIpc } from './projectsIpc'
import { attachRecorderWindow, closeRecordingWindows, disposeRecording, focusApp, registerRecordingIpc } from './recordingIpc'
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
    handleMediaProtocol()
    registerRecordingIpc()
    registerProjectsIpc()
    registerExportIpc()
    openMainWindow()
    app.on('activate', () => {
      if (BrowserWindow.getAllWindows().length === 0) openMainWindow()
    })
  })

  app.on('will-quit', () => {
    disposeRecording()
    disposeExport()
  })

  app.on('window-all-closed', () => {
    if (process.platform !== 'darwin') app.quit()
  })
}
