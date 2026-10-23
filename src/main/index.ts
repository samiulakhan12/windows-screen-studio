import { app, BrowserWindow } from 'electron'
import { disposeExport, registerExportIpc } from './exportIpc'
import { handleMediaProtocol, registerMediaScheme } from './mediaProtocol'
import { registerProjectsIpc } from './projectsIpc'
import { closeRecordingWindows, disposeRecording, registerRecordingIpc } from './recordingIpc'
import { createMainWindow } from './windows'

registerMediaScheme()

app.whenReady().then(() => {
  app.setAppUserModelId('com.samiulakhan12.screenstudio')
  handleMediaProtocol()
  registerRecordingIpc()
  registerProjectsIpc()
  registerExportIpc()
  createMainWindow(closeRecordingWindows)
  app.on('activate', () => {
    if (BrowserWindow.getAllWindows().length === 0) createMainWindow(closeRecordingWindows)
  })
})

app.on('will-quit', () => {
  disposeRecording()
  disposeExport()
})

app.on('window-all-closed', () => {
  if (process.platform !== 'darwin') app.quit()
})
