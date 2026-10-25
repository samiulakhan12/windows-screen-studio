import { app, BrowserWindow, shell, type BrowserWindowConstructorOptions } from 'electron'
import { existsSync } from 'node:fs'
import path from 'node:path'
import { APP_NAME } from '../shared/brand'

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

/** A window the main window's page may open itself (window.open with its name). */
export interface PagePopup {
  /** Its window options, or null to refuse it now. */
  options(): BrowserWindowConstructorOptions | null
  created(win: BrowserWindow): void
}

const popups = new Map<string, PagePopup>()

/**
 * Lets the main window's page open `name` with window.open('about:blank', name): a window of its
 * own process that it fills itself (the live camera bubble shows the page's camera stream that
 * way). Every other window.open stays refused; the popup gets the usual guards (security.ts).
 */
export function allowPopup(name: string, popup: PagePopup): void {
  popups.set(name, popup)
}

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
    // Mirrors the renderer's design tokens (styles.css): --surface-0 behind the page, and the
    // .titlebar background (--surface-1) and height (44 px less its 1 px bottom hairline).
    backgroundColor: '#0e0e11',
    title: APP_NAME,
    icon: windowIconPath(),
    titleBarStyle: 'hidden',
    titleBarOverlay: { color: '#141418', symbolColor: '#e5e7eb', height: 43 },
    webPreferences: {
      preload: preloadPath,
      sandbox: true,
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
  win.webContents.setWindowOpenHandler(({ url, frameName }) => {
    const popup = url === 'about:blank' ? popups.get(frameName) : undefined
    const options = popup?.options()
    if (options) return { action: 'allow', overrideBrowserWindowOptions: options }
    if (url.startsWith('https://')) void shell.openExternal(url)
    return { action: 'deny' }
  })
  win.webContents.on('did-create-window', (child, { frameName }) => {
    const popup = popups.get(frameName)
    if (popup) popup.created(child)
    else child.destroy()
  })
  loadRoute(win, '/')
  return win
}
