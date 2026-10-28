/**
 * Files saved next to an exported video (F-11, docs/design/hands-off.md §2.8): captions (SRT,
 * VTT), the chapter list, a thumbnail and a description. The page makes the contents; main writes
 * them, only next to a file exported in this session, at a path it builds itself from a fixed list
 * of kinds, after checking the content. An existing file is never replaced unless that export
 * replaced the video of the same name (the save dialog asked); otherwise " (2)" is added.
 */
import { ipcMain } from 'electron'
import { existsSync, promises as fs } from 'node:fs'
import path from 'node:path'
import { validSubtitle } from '../shared/captions/subtitles'
import { MAX_SIDECAR_TEXT, SIDECAR_KINDS, sidecarName, type SidecarKind } from '../shared/render/exportBundle'
import { freeBatchPath, isPng, moveIntoPlace, partialPath } from './exportJob'
import { isExportedFile, replacedExport } from './exportIpc'
import { removeWithRetries } from './exportCleanup'
import { isAppUrl } from './security'

/** Largest thumbnail accepted (as export:saveThumbnail). */
const MAX_PNG_BYTES = 200 * 1024 * 1024

export interface SidecarDeps {
  isExported: (file: string) => boolean
  replaced: (file: string) => boolean
  exists: (file: string) => boolean
}

const realDeps: SidecarDeps = { isExported: isExportedFile, replaced: replacedExport, exists: existsSync }

/**
 * Where `kind` goes for exported file `anchor`: next to it, named after it; " (2)", " (3)" ... when
 * the name is taken and the export did not replace a file of the same name.
 */
export function sidecarTarget(anchor: unknown, kind: unknown, deps: SidecarDeps = realDeps): string {
  if (typeof anchor !== 'string' || !path.isAbsolute(anchor) || !deps.isExported(anchor)) throw new Error('Only files exported in this session get extra files')
  if (!SIDECAR_KINDS.includes(kind as SidecarKind)) throw new Error('Invalid extra file')
  const name = sidecarName(path.basename(anchor), kind as SidecarKind)
  const dir = path.dirname(anchor)
  if (deps.replaced(anchor)) return path.join(dir, name)
  return freeBatchPath(dir, name, deps.exists)
}

/** The bytes to write for `kind`, or an error when the content is not what that kind holds. */
export function sidecarBytes(kind: SidecarKind, content: unknown): Uint8Array {
  if (kind === 'thumbnail') {
    if (!(content instanceof Uint8Array) || content.byteLength > MAX_PNG_BYTES || !isPng(content)) throw new Error('Invalid thumbnail image')
    return content
  }
  if (kind === 'srt' || kind === 'vtt') {
    if (!validSubtitle(kind, content)) throw new Error('These captions cannot be saved as a subtitle file')
    // A byte order mark helps older Windows players read accents and non-Latin scripts in SRT files (as captionsIpc.ts).
    return Buffer.from((kind === 'srt' ? '﻿' : '') + content, 'utf8')
  }
  if (typeof content !== 'string' || content.length > MAX_SIDECAR_TEXT || content.includes('\u0000')) throw new Error('Invalid text file')
  return Buffer.from(content, 'utf8')
}

/** Writes `kind` next to `anchor` safely (temp file + rename); resolves with the path written. */
export async function writeSidecar(anchor: unknown, kind: unknown, content: unknown, deps: SidecarDeps = realDeps): Promise<string> {
  const file = sidecarTarget(anchor, kind, deps)
  const bytes = sidecarBytes(kind as SidecarKind, content)
  const temp = partialPath(file)
  try {
    await fs.writeFile(temp, bytes)
    await moveIntoPlace(temp, file)
  } catch (e) {
    await removeWithRetries(temp)
    throw (e as NodeJS.ErrnoException).code === 'ENOSPC' ? new Error('The disk is full.') : e
  }
  return file
}

export function registerExportBundleIpc(): void {
  ipcMain.handle('exportBundle:write', (e, anchor: unknown, kind: unknown, content: unknown) => {
    if (!isAppUrl(e.senderFrame?.url ?? '')) throw new Error('Not allowed')
    return writeSidecar(anchor, kind, content)
  })
}
