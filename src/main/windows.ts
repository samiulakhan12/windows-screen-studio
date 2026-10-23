import { app, BrowserWindow, shell } from 'electron'
import { existsSync } from 'node:fs'
import path from 'node:path'

export const isDev = !app.isPackaged && !!process.env['ELECTRON_RENDERER_URL']
export const preloadPath = path.join(__dirname, '../preload/index.js')

/**
 * Window/taskbar icon. Packaged builds return undefined on purpose: on Windows Electron then uses
 * the exe's embedded multi-size icon (build/icon.ico, put there by electron-builder), which the
 * shell scales best for every DPI; build/ itself is not shipped. Unpackaged runs (npm run dev, e2e)
 * would show Electron's own icon, so they use the project's build/ (app.getAppPath() is the folder
 * holding package.json).
 */
export function windowIconPath(): string | undefined {
  if (app.isPackaged) return undefined
  const file = path.join(app.getAppPath(), 'build', process.platform === 'win32' ? 'icon.ico' : 'icon.png')
  return existsSync(file) ? file : undefined
}

let mainWindow: BrowserWindow | null = null

export function loadRoute(win: BrowserWindow, route: string): void {
  if (isDev) void win.loadURL(`${process.env['ELECTRON_RENDERER_URL']}#${route}`)
  else void win.loadFile(path.join(__dirname, '../renderer/index.html'), { hash: route })
}

export const getMainWindow = (): BrowserWindow | null => mainWindow

export function sendToMain(channel: string, ...args: unknown[]): void {
  mainWindow?.webContents.send(channel, ...args)
}

export function createMainWindow(onClosed: () => void): BrowserWindow {
  const win = new BrowserWindow({
    width: 1360,
    height: 860,
    minWidth: 1040,
    minHeight: 680,
    show: false,
    backgroundColor: '#0b0b10',
    title: 'Screen Studio for Windows',
    icon: windowIconPath(),
    titleBarStyle: 'hidden',
    titleBarOverlay: { color: '#0b0b10', symbolColor: '#e5e7eb', height: 40 },
    webPreferences: {
      preload: preloadPath,
      sandbox: false,
      contextIsolation: true,
      nodeIntegration: false,
      // Recording keeps running while this window is hidden.
      backgroundThrottling: false
    }
  })
  mainWindow = win
  win.once('ready-to-show', () => win.show())
  win.on('closed', () => {
    mainWindow = null
    onClosed()
  })
  win.webContents.setWindowOpenHandler(({ url }) => {
    if (url.startsWith('https://')) void shell.openExternal(url)
    return { action: 'deny' }
  })
  loadRoute(win, '/')
  return win
}
