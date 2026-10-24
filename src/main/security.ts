/**
 * Guards for every window: only the app's own page may load in one (a page that loads keeps
 * the preload, so it would get window.api), no page opens new windows unless its window allows
 * it (windows.ts sends https links to the browser), and only the app's page gets the camera,
 * microphone, screen capture and clipboard.
 */
import { app, session, type Event, type WebContents } from 'electron'
import path from 'node:path'
import { fileURLToPath } from 'node:url'

export interface AppPage {
  /** The dev server (npm run dev), whose whole origin is the app; null when running the build. */
  devUrl: string | null
  /** The built renderer page, out/renderer/index.html. */
  indexFile: string
}

/** Where this run loads the renderer from (as loadRoute in windows.ts does). */
export function appPage(): AppPage {
  const dev = process.env['ELECTRON_RENDERER_URL']
  return { devUrl: !app.isPackaged && dev ? dev : null, indexFile: path.join(__dirname, '../renderer/index.html') }
}

/** Whether `url` is the app's page, at any hash route. */
export function isAppUrl(url: string, page: AppPage = appPage()): boolean {
  try {
    const u = new URL(url)
    if (page.devUrl) return u.origin === new URL(page.devUrl).origin
    if (u.protocol !== 'file:' || u.host) return false
    const file = fileURLToPath(u)
    return process.platform === 'win32' ? file.toLowerCase() === page.indexFile.toLowerCase() : file === page.indexFile
  } catch {
    return false
  }
}

/**
 * What the app's page asks for: camera and microphone ('media': recording and the camera preview
 * on Home), screen capture, and clipboard writes (Copy chapters).
 */
const PERMISSIONS: ReadonlySet<string> = new Set(['media', 'display-capture', 'clipboard-sanitized-write'])

export function permissionAllowed(permission: string, url: string, page?: AppPage): boolean {
  return PERMISSIONS.has(permission) && isAppUrl(url, page)
}

/** Blocks navigation away from the app's page (a dropped file, a link) and new windows. */
export function guardWebContents(wc: WebContents): void {
  const block = (e: Event, url: string): void => {
    if (isAppUrl(url)) return
    e.preventDefault()
    console.warn(`Blocked navigation to ${url}`)
  }
  wc.on('will-navigate', block)
  wc.on('will-redirect', block)
  wc.setWindowOpenHandler(() => ({ action: 'deny' }))
}

/** Call before the first window is created. */
export function registerSecurity(): void {
  app.on('web-contents-created', (_e, wc) => guardWebContents(wc))
  session.defaultSession.setPermissionRequestHandler((wc, permission, callback, details) => {
    callback(permissionAllowed(permission, details.requestingUrl || wc.getURL()))
  })
  // Checks (device labels, the clipboard) answer the same way for the app's page as before; other pages get nothing.
  session.defaultSession.setPermissionCheckHandler((wc) => !!wc && isAppUrl(wc.getURL()))
}
