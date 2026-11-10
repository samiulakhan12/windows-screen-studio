/**
 * `.flownpreset` files (docs/design/output-and-languages.md §4.5, §18.2): main writes them itself from
 * presets (never text from the renderer) and reads them through readPresetFile, at most 64 KB.
 *
 * - Saving: the renderer hands over presets, which go through readUserPresets as the stored ones do;
 *   main serialises them with presetFileText, reads the text back through readPresetFile and refuses
 *   anything that does not read back the same or is over 64 KB. The dialog's name always ends in
 *   `.flownpreset`, and the file is written to a temporary name and renamed.
 * - Opening: at most 64 KB are read (a larger file is refused unread past the limit), as UTF-8, and
 *   only what readPresetFile accepts reaches the renderer. Nothing in a preset is a path or a URL.
 */
import { app, BrowserWindow, dialog, ipcMain } from 'electron'
import { promises as fs } from 'node:fs'
import path from 'node:path'
import type { PresetFileRead } from '../shared/api/export'
import { t } from '../shared/i18n/t'
import { safeFileName } from '../shared/render/exportPresets'
import { cleanPresetName, PRESET_FILE_LIMIT, presetFileText, readPresetFile, readUserPresets, USER_PRESET_LIMIT } from '../shared/render/userPresets'
import { isAppUrl } from './security'

/** The extension every preset file has. */
export const PRESET_FILE_EXTENSION = 'flownpreset'

/** What the two calls use of Electron and the disk (replaced in tests). */
export interface PresetFileDeps {
  showSaveDialog(options: Electron.SaveDialogOptions): Promise<{ canceled: boolean; filePath?: string }>
  showOpenDialog(options: Electron.OpenDialogOptions): Promise<{ canceled: boolean; filePaths: string[] }>
  /** The folder the dialogs start in. */
  folder(): string
}

/**
 * The text main writes for `presets` as the renderer sent them, or null when it must not be written:
 * not 1 to 50 presets, a preset the stored-preset reader drops, over 64 KB, or text that does not
 * read back through readPresetFile as the same presets. The text is made from what that reader keeps,
 * never from the renderer's own values.
 */
export function presetFileFor(presets: unknown): string | null {
  if (!Array.isArray(presets) || presets.length === 0 || presets.length > USER_PRESET_LIMIT) return null
  const store = readUserPresets({ version: 1, presets })
  if (!store || store.presets.length !== presets.length) return null
  let text: string
  try {
    text = presetFileText(store.presets)
  } catch {
    return null
  }
  if (Buffer.byteLength(text, 'utf8') > PRESET_FILE_LIMIT) return null
  const back = readPresetFile(text)
  if (!back || back.skipped > 0 || back.changed.length > 0 || back.presets.length !== store.presets.length || presetFileText(back.presets) !== text) return null
  return text
}

/** `file` with the preset extension, whatever the user typed. */
export function withPresetExtension(file: string): string {
  return path.extname(file).toLowerCase() === `.${PRESET_FILE_EXTENSION}` ? file : `${file}.${PRESET_FILE_EXTENSION}`
}

/** The save dialog's file name for `defaultName`: a clean preset name made safe for Windows. */
const defaultFileName = (defaultName: unknown): string => `${safeFileName(cleanPresetName(defaultName) ?? '', 'Presets')}.${PRESET_FILE_EXTENSION}`

/** Writes `text` to `file` through a temporary file and a rename; the temporary file never stays. */
async function writeAtomic(file: string, text: string): Promise<void> {
  const temp = `${file}.${process.pid}.tmp`
  try {
    await fs.writeFile(temp, text, { encoding: 'utf8', flag: 'wx' })
    await fs.rename(temp, file)
  } catch (err) {
    await fs.rm(temp, { force: true }).catch(() => undefined)
    throw err
  }
}

/**
 * `export:savePresetFile`: a save dialog for `{defaultName}.flownpreset`, then the presets written as
 * main makes their text. Resolves with the path, or null when the dialog was cancelled; rejects with
 * the UI-language reason when the presets cannot be written as given.
 */
export async function savePresetFile(defaultName: unknown, presets: unknown, deps: PresetFileDeps): Promise<string | null> {
  const text = presetFileFor(presets)
  if (text === null) throw new Error(t('errors.presetFile.notSaved'))
  const result = await deps.showSaveDialog({
    title: t('main.presetFile.saveTitle'),
    defaultPath: path.join(deps.folder(), defaultFileName(defaultName)),
    filters: [{ name: t('main.presetFile.filter'), extensions: [PRESET_FILE_EXTENSION] }]
  })
  if (result.canceled || !result.filePath) return null
  const file = withPresetExtension(result.filePath)
  try {
    await writeAtomic(file, text)
  } catch {
    throw new Error(t('errors.presetFile.notSaved'))
  }
  return file
}

/** The first 64 KB of `file` and whether it holds more; never reads past the limit. */
async function readHead(file: string): Promise<{ bytes: Buffer; more: boolean }> {
  const handle = await fs.open(file, 'r')
  try {
    const buffer = Buffer.alloc(PRESET_FILE_LIMIT + 1)
    let length = 0
    while (length < buffer.length) {
      const { bytesRead } = await handle.read(buffer, length, buffer.length - length, length)
      if (bytesRead === 0) break
      length += bytesRead
    }
    return { bytes: buffer.subarray(0, Math.min(length, PRESET_FILE_LIMIT)), more: length > PRESET_FILE_LIMIT }
  } finally {
    await handle.close()
  }
}

/**
 * `export:openPresetFile`: an open dialog for `.flownpreset` files, then what readPresetFile reads of
 * the chosen one. Null when the dialog was cancelled; `too-large` past 64 KB; `unreadable` for a file
 * that cannot be read, is not UTF-8, or is not a preset file.
 */
export async function openPresetFile(deps: PresetFileDeps): Promise<PresetFileRead | { refused: 'too-large' | 'unreadable' } | null> {
  const result = await deps.showOpenDialog({
    title: t('main.presetFile.openTitle'),
    defaultPath: deps.folder(),
    filters: [{ name: t('main.presetFile.filter'), extensions: [PRESET_FILE_EXTENSION] }],
    properties: ['openFile']
  })
  const file = result.canceled ? undefined : result.filePaths[0]
  if (!file) return null
  let head: { bytes: Buffer; more: boolean }
  try {
    head = await readHead(file)
  } catch {
    return { refused: 'unreadable' }
  }
  if (head.more) return { refused: 'too-large' }
  let text: string
  try {
    text = new TextDecoder('utf-8', { fatal: true, ignoreBOM: true }).decode(head.bytes)
  } catch {
    return { refused: 'unreadable' }
  }
  return readPresetFile(text) ?? { refused: 'unreadable' }
}

/** The dialogs of Electron, owned by the window that asked. */
function electronDeps(sender: Electron.WebContents): PresetFileDeps {
  const owner = BrowserWindow.fromWebContents(sender)
  return {
    showSaveDialog: (options) => (owner ? dialog.showSaveDialog(owner, options) : dialog.showSaveDialog(options)),
    showOpenDialog: (options) => (owner ? dialog.showOpenDialog(owner, options) : dialog.showOpenDialog(options)),
    folder: () => app.getPath('documents')
  }
}

/** `export:savePresetFile` and `export:openPresetFile`, for the app's own page only. */
export function registerPresetFileIpc(): void {
  ipcMain.handle('export:savePresetFile', (e, defaultName: unknown, presets: unknown) => {
    if (!isAppUrl(e.senderFrame?.url ?? '')) throw new Error('Not allowed')
    return savePresetFile(defaultName, presets, electronDeps(e.sender))
  })
  ipcMain.handle('export:openPresetFile', (e) => {
    if (!isAppUrl(e.senderFrame?.url ?? '')) throw new Error('Not allowed')
    return openPresetFile(electronDeps(e.sender))
  })
}
