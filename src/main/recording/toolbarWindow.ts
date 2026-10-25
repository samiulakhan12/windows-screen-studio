import { BrowserWindow, screen, type Display, type Rectangle } from 'electron'
import type { ToolbarStatus } from '../../shared/api/recording'
import { loadRoute, preloadPath } from '../windows'
import { toolbarPosition } from './placement'
import type { Rect } from './trackMath'

const SIZE = { width: 580, height: 64 }

let toolbar: BrowserWindow | null = null
/** Every place the toolbar occupied during this recording (clicks there are not content). */
const occupied: Rectangle[] = []

function create(): BrowserWindow {
  const win = new BrowserWindow({
    ...SIZE,
    frame: false,
    transparent: true,
    resizable: false,
    alwaysOnTop: true,
    skipTaskbar: true,
    // Clicking Pause must not pull keyboard focus away from the app being recorded.
    focusable: false,
    show: false,
    hasShadow: false,
    webPreferences: { preload: preloadPath, sandbox: true, contextIsolation: true, nodeIntegration: false }
  })
  win.setAlwaysOnTop(true, 'screen-saver')
  // Keep the control bar out of the recording (Windows 10 2004+ / macOS).
  win.setContentProtection(true)
  win.on('moved', () => occupied.push(win.getBounds()))
  win.on('closed', () => {
    toolbar = null
  })
  // A crashed toolbar would remove the only on-screen stop control.
  win.webContents.on('render-process-gone', () => {
    if (!win.isDestroyed()) loadRoute(win, '/toolbar')
  })
  loadRoute(win, '/toolbar')
  return win
}

/**
 * Creates (hidden) and positions the toolbar before the countdown, so its page has
 * loaded by the time the first status arrives.
 */
export function prepareToolbar(display: Display | null, avoid: Rect | null): void {
  if (!toolbar) toolbar = create()
  const target = display ?? screen.getPrimaryDisplay()
  const { x, y } = toolbarPosition(target.workArea, SIZE, avoid)
  toolbar.setBounds({ x, y, ...SIZE })
  occupied.length = 0
  occupied.push(toolbar.getBounds())
}

export function showToolbar(): void {
  if (toolbar && !toolbar.isVisible()) toolbar.showInactive()
}

export function hideToolbar(): void {
  toolbar?.hide()
}

export function sendToolbarStatus(status: ToolbarStatus): void {
  const wc = toolbar?.webContents
  if (wc && !wc.isDestroyed() && !wc.isCrashed()) wc.send('recording:status', status)
}

/** The microphone's level for the meter (only while the bar is shown). */
export function sendToolbarLevel(level: number): void {
  const wc = toolbar?.webContents
  if (wc && !wc.isDestroyed() && !wc.isCrashed() && toolbar!.isVisible()) wc.send('recording:level', level)
}

export function toolbarAreas(): readonly Rectangle[] {
  return occupied
}

export function isToolbarVisible(): boolean {
  return !!toolbar && toolbar.isVisible()
}

export function closeToolbar(): void {
  toolbar?.close()
}
