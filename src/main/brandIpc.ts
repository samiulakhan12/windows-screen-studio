/**
 * The About section's two requests. The page never names a URL: windows refuse window.open and
 * navigation (security.ts), and this handler opens only the company website, so a compromised
 * page cannot use it to launch anything else.
 */
import { app, ipcMain, shell } from 'electron'
import type { AppInfo } from '../shared/api/brand'
import { APP_NAME, COMPANY_URL } from '../shared/brand'

export function registerBrandIpc(): void {
  ipcMain.handle('brand:app-info', (): AppInfo => ({ name: APP_NAME, version: app.getVersion() }))
  ipcMain.handle('brand:open-website', () => shell.openExternal(COMPANY_URL))
}
