/**
 * `.flownpreset` files (docs/design/output-and-languages.md §4.5, §18.2): main writes them itself from
 * presets (never text from the renderer) and reads them through readPresetFile, at most 64 KB.
 *
 * Part P5 writes the dialogs; the contracts' stub registers both channels and opens nothing.
 */
import { ipcMain } from 'electron'
import { isAppUrl } from './security'

/** `export:savePresetFile` and `export:openPresetFile`, for the app's own page only. Part P5. */
export function registerPresetFileIpc(): void {
  ipcMain.handle('export:savePresetFile', (e) => {
    if (!isAppUrl(e.senderFrame?.url ?? '')) throw new Error('Not allowed')
    return null
  })
  ipcMain.handle('export:openPresetFile', (e) => {
    if (!isAppUrl(e.senderFrame?.url ?? '')) throw new Error('Not allowed')
    return null
  })
}
