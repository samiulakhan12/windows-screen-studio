/**
 * The sound library's IPC (docs/design/editing-polish.md §14 rule 5): every channel checks its
 * sender (fromApp) and its arguments against the catalogue. The renderer names catalogue ids and
 * project ids, never paths; a download's progress goes to the window that asked for it, at most
 * four times a second.
 */
import { ipcMain, type WebContents } from 'electron'
import { SOUND_LIBRARY_CHANNELS, type SoundLibraryState } from '../../shared/api/soundLibrary'
import { soundBed } from '../../shared/audio/soundLibrary'
import { importAsset } from '../assetIpc'
import { fromApp, PROGRESS_EVERY_MS } from '../assetsIpc'
import { projectDir } from '../projects'
import { cancelBedDownload, downloadBed, LIBRARY_COPY, listLibrary, removeDownloadedBeds, useBed } from './store'

/** A bed's catalogue id from the renderer: a short lower-case name of the catalogue, never a path or a URL. */
export function bedId(v: unknown): string {
  if (typeof v !== 'string' || !/^[a-z0-9-]{1,64}$/.test(v) || !soundBed(v)) throw new Error(LIBRARY_COPY.notOffered)
  return v
}

/** Progress for one sender, throttled; the last one always arrives. */
function progressTo(sender: WebContents, id: string, bytes: number): (p: number) => void {
  let last = 0
  return (p) => {
    const now = Date.now()
    if (p < 1 && now - last < PROGRESS_EVERY_MS) return
    last = now
    const state: SoundLibraryState = { id, state: 'downloading', bytes, progress: p }
    if (!sender.isDestroyed()) sender.send(SOUND_LIBRARY_CHANNELS.progress, state)
  }
}

export function registerSoundLibraryIpc(): void {
  ipcMain.handle(SOUND_LIBRARY_CHANNELS.list, (e) => {
    fromApp(e)
    return listLibrary()
  })
  ipcMain.handle(SOUND_LIBRARY_CHANNELS.download, (e, id: unknown) => {
    fromApp(e)
    const bed = soundBed(bedId(id))!
    return downloadBed(bed.id, { signal: new AbortController().signal, onProgress: progressTo(e.sender, bed.id, bed.prepared.bytes) })
  })
  ipcMain.handle(SOUND_LIBRARY_CHANNELS.cancel, (e, id: unknown) => {
    fromApp(e)
    return cancelBedDownload(bedId(id))
  })
  ipcMain.handle(SOUND_LIBRARY_CHANNELS.remove, (e) => {
    fromApp(e)
    return removeDownloadedBeds()
  })
  ipcMain.handle(SOUND_LIBRARY_CHANNELS.useBed, (e, projectId: unknown, id: unknown) => {
    fromApp(e)
    if (typeof projectId !== 'string') throw new Error('Invalid project.')
    // projectDir refuses an id that is not one (no path parts).
    const dir = projectDir(projectId)
    const bed = bedId(id)
    // Stored as the project's next music pick by the asset store (temporary name, rename, older picks pruned).
    return useBed(dir, bed, async (src) => (await importAsset(projectId, 'music', src)).path)
  })
}
