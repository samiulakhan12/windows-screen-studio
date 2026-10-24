import { BrowserWindow, ipcMain, type Display, type IpcMainEvent } from 'electron'
import type { NormRect } from '../../shared/types'
import { getMainWindow, loadRoute, preloadPath } from '../windows'
import { sanitizeRegion } from './placement'

/** The picked area, or none: cancelled, or (`rejected`) a selection that failed validation. */
export type RegionPick = { region: NormRect } | { region: null; rejected: boolean }

let open: Promise<RegionPick> | null = null

/**
 * Shows a transparent full-screen overlay on `display` where the user drags the
 * area to record. Resolves with the area normalised to the display.
 */
export function pickRegionOnDisplay(display: Display): Promise<RegionPick> {
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
    webPreferences: { preload: preloadPath, sandbox: true, contextIsolation: true, nodeIntegration: false }
  })
  win.setAlwaysOnTop(true, 'screen-saver')
  win.setBounds(display.bounds)
  loadRoute(win, '/region')
  win.once('ready-to-show', () => {
    win.show()
    win.focus()
  })

  open = new Promise<RegionPick>((resolve) => {
    let done = false
    const finish = (pick: RegionPick): void => {
      if (done) return
      done = true
      open = null
      ipcMain.removeListener('region:done', onDone)
      if (!win.isDestroyed()) win.close()
      if (restoreMain && main && !main.isDestroyed()) {
        main.show()
        main.focus()
      }
      resolve(pick)
    }
    const onDone = (e: IpcMainEvent, value: unknown): void => {
      if (e.sender !== win.webContents) return
      if (value === null || value === undefined) {
        finish({ region: null, rejected: false })
        return
      }
      // Same minimum-size rule as the picker (shared/recording/regionGeometry).
      const region = sanitizeRegion(value, display.bounds)
      finish(region ? { region } : { region: null, rejected: true })
    }
    ipcMain.on('region:done', onDone)
    win.on('closed', () => finish({ region: null, rejected: false }))
    win.webContents.on('render-process-gone', () => finish({ region: null, rejected: false }))
  })
  return open
}
