import { BrowserWindow, ipcMain, type Display, type IpcMainEvent } from 'electron'
import type { NormRect } from '../../shared/types'
import { getMainWindow, loadRoute, preloadPath } from '../windows'
import { sanitizeRegion } from './placement'

let open: Promise<NormRect | null> | null = null

/**
 * Shows a transparent full-screen overlay on `display` where the user drags the
 * area to record. Resolves with the area normalised to the display, or null.
 */
export function pickRegionOnDisplay(display: Display): Promise<NormRect | null> {
  if (open) return open
  const main = getMainWindow()
  const restoreMain = !!main && main.isVisible()
  // The app window would otherwise cover what the user wants to select.
  main?.hide()

  const win = new BrowserWindow({
    ...display.bounds,
    frame: false,
    transparent: true,
    backgroundColor: '#00000000',
    resizable: false,
    movable: false,
    minimizable: false,
    maximizable: false,
    fullscreenable: false,
    skipTaskbar: true,
    alwaysOnTop: true,
    hasShadow: false,
    enableLargerThanScreen: true,
    show: false,
    webPreferences: { preload: preloadPath, sandbox: false, contextIsolation: true, nodeIntegration: false }
  })
  win.setAlwaysOnTop(true, 'screen-saver')
  win.setBounds(display.bounds)
  loadRoute(win, '/region')
  win.once('ready-to-show', () => {
    win.show()
    win.focus()
  })

  open = new Promise<NormRect | null>((resolve) => {
    let done = false
    const finish = (region: NormRect | null): void => {
      if (done) return
      done = true
      open = null
      ipcMain.removeListener('region:done', onDone)
      if (!win.isDestroyed()) win.close()
      if (restoreMain && main && !main.isDestroyed()) {
        main.show()
        main.focus()
      }
      resolve(region)
    }
    const onDone = (e: IpcMainEvent, value: unknown): void => {
      if (e.sender === win.webContents) finish(sanitizeRegion(value))
    }
    ipcMain.on('region:done', onDone)
    win.on('closed', () => finish(null))
    win.webContents.on('render-process-gone', () => finish(null))
  })
  return open
}
