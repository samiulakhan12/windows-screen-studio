/**
 * The UI language in main (docs/design/output-and-languages.md §9.4): chosen once at start from the
 * `ui` preference, Windows' languages and what ships; the `ui:*` channels; relaunching to switch
 * unless work would be lost; confirmations in the UI language.
 *
 * Part P6 writes it. The contracts' stub keeps Flown in English: no language ships, nothing is
 * offered, a relaunch is refused, and a confirmation is a plain message box with the caller's buttons.
 */
import { BrowserWindow, dialog, ipcMain, type IpcMainInvokeEvent } from 'electron'
import type { RelaunchResult, UiInfo, UiLanguage } from '../shared/api/ui'
import { readUiPrefs, resolveUiLanguage } from '../shared/i18n/locale'
import { readPrefSync, writePrefSync } from './prefsIpc'
import { isAppUrl } from './security'

let info: UiInfo | null = null

/** Chooses the UI language before any window opens and before any module makes text (§9.4 step 1). Part P6. */
export function initUiLanguage(): UiInfo {
  info = resolveUiLanguage(readUiPrefs(readPrefSync('ui')), [], 'en-US', [], knownLanguages())
  return info
}

/** What would be lost by a relaunch now, as a sentence, or null (§9.4 step 6). Part P6. */
export function relaunchBlocker(): string | null {
  return null
}

/** Relaunches Flown, reopening `reopenProjectId` after the restart, unless something is busy. Part P6; the stub refuses. */
export function relaunchApp(reopenProjectId?: string): RelaunchResult {
  void reopenProjectId
  return { ok: false, reason: 'Restarting to change the language is not available yet.' }
}

/** Languages Flown knows offline that the user works in: speech models made for one, and `UiPrefs.seen` (§2.7). Part P6. */
export function knownLanguages(): UiLanguage[] {
  return []
}

const fromApp = (e: IpcMainInvokeEvent): boolean => isAppUrl(e.senderFrame?.url ?? '')

/** Longest confirmation question and button label accepted (§18.5). */
const CONFIRM_LIMITS = { message: 2000, label: 60 }

/** The `ui:*` channels, for the app's own page only. */
export function registerUiIpc(): void {
  ipcMain.handle('ui:info', (e) => {
    if (!fromApp(e)) throw new Error('Not allowed')
    const now = info ?? initUiLanguage()
    return { ...now, prefs: readUiPrefs(readPrefSync('ui')) ?? {} }
  })
  ipcMain.handle('ui:setPrefs', (e, raw: unknown) => {
    if (!fromApp(e)) throw new Error('Not allowed')
    const prefs = readUiPrefs(raw)
    if (!prefs) throw new Error('Invalid language settings')
    writePrefSync('ui', Object.keys(prefs).length ? prefs : null)
  })
  ipcMain.handle('ui:relaunch', (e, reopenProjectId: unknown) => {
    if (!fromApp(e)) throw new Error('Not allowed')
    return relaunchApp(typeof reopenProjectId === 'string' ? reopenProjectId : undefined)
  })
  ipcMain.handle('ui:noteSeen', (e, language: unknown) => {
    if (!fromApp(e)) throw new Error('Not allowed')
    void language
  })
  ipcMain.handle('ui:confirm', async (e, request: unknown) => {
    if (!fromApp(e)) throw new Error('Not allowed')
    const r = (request && typeof request === 'object' ? request : {}) as Record<string, unknown>
    const ok = (v: unknown, max: number): v is string => typeof v === 'string' && v.length > 0 && v.length <= max
    if (!ok(r.message, CONFIRM_LIMITS.message) || !ok(r.action, CONFIRM_LIMITS.label) || !ok(r.cancel, CONFIRM_LIMITS.label)) throw new Error('Invalid confirmation')
    const owner = BrowserWindow.fromWebContents(e.sender)
    const options = { type: 'question' as const, message: r.message, buttons: [r.action, r.cancel], defaultId: 0, cancelId: 1, noLink: true }
    const { response } = owner ? await dialog.showMessageBox(owner, options) : await dialog.showMessageBox(options)
    return response === 0
  })
}
