/**
 * Saving the captions as a subtitle file (SRT, WebVTT or plain text): the renderer makes the
 * file's text (shared/captions/subtitles.ts), the user picks where it goes in a save dialog here,
 * and only then is it written. The content is checked again, and only the path the dialog
 * returned (with the format's extension) is written to.
 */
import { app, dialog, ipcMain } from 'electron'
import path from 'node:path'
import { validSubtitle, type SubtitleFormat } from '../shared/captions/subtitles'
import { writeFileAtomicSync } from './atomicWrite'
import { getMainWindow } from './windows'

const FILTERS: Record<SubtitleFormat, Electron.FileFilter> = {
  srt: { name: 'SRT subtitles', extensions: ['srt'] },
  vtt: { name: 'WebVTT subtitles', extensions: ['vtt'] },
  txt: { name: 'Plain text', extensions: ['txt'] }
}

/** A file name the dialog can suggest: no folders, no characters Windows refuses, not too long. */
export function subtitleFileName(name: unknown): string {
  const base = typeof name === 'string' ? name.replace(/[\\/:*?"<>|\u0000-\u001f]+/g, ' ').replace(/\s+/g, ' ').trim().replace(/^\.+/, '') : ''
  return (base || 'Captions').slice(0, 120)
}

/** The chosen path with the format's extension (added when the user typed another one or none). */
export function withExtension(file: string, format: SubtitleFormat): string {
  return path.extname(file).toLowerCase() === `.${format}` ? file : `${file}.${format}`
}

export function registerCaptionsIpc(): void {
  ipcMain.handle('captions:save', async (_e, defaultName: unknown, format: unknown, content: unknown) => {
    if (!validSubtitle(format, content)) throw new Error('These captions cannot be saved as a subtitle file')
    const main = getMainWindow()
    if (!main) return null
    const filter = FILTERS[format]
    const result = await dialog.showSaveDialog(main, {
      title: 'Export captions',
      defaultPath: path.join(app.getPath('videos'), `${subtitleFileName(defaultName)}.${filter.extensions[0]}`),
      filters: [filter]
    })
    if (result.canceled || !result.filePath) return null
    if (!path.isAbsolute(result.filePath)) throw new Error('Choose a folder on this computer for the captions')
    const file = withExtension(result.filePath, format)
    // A byte order mark helps older Windows players read accents and non-Latin scripts in SRT files.
    writeFileAtomicSync(file, (format === 'srt' ? '﻿' : '') + (content as string))
    return file
  })
}
