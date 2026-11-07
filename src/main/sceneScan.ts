/**
 * Reading the screen once per recording (docs/design/smart-tools.md §7.2): how much of the picture
 * changes at each sample and where it stays still, cached in .cache/scenes.json. Part P2 writes this
 * file; the contracts' stub registers the channel (the app's own page only) and refuses the scan.
 */
import { ipcMain, type IpcMainInvokeEvent } from 'electron'
import { SMART_PROJECT_CHANNELS, type SceneScan } from '../shared/api/projects'
import type { NormRect } from '../shared/types'
import { isAppUrl } from './security'

export function sceneScanArgs(file: string, fps: number | undefined, crop: NormRect | null): string[] {
  void file
  void fps
  void crop
  return []
}

export function parseSceneLog(log: string, duration: number, step: number): SceneScan {
  void log
  void duration
  return { step, t: [], changed: [], stills: [] }
}

export async function detectScenes(id: unknown, crop: unknown, onProgress?: (fraction: number) => void): Promise<SceneScan> {
  void id
  void crop
  void onProgress
  throw new Error('Reading the screen is not part of this build.')
}

/** Stops project `id`'s scene scan and waits until ffmpeg has let go of the video. */
export const stopSceneScan = (id: string): Promise<void> => {
  void id
  return Promise.resolve()
}

/** Only the app's own page. */
function fromApp(e: IpcMainInvokeEvent): void {
  if (!isAppUrl(e.senderFrame?.url ?? '')) throw new Error('Not allowed')
}

export function registerSceneIpc(): void {
  ipcMain.handle(SMART_PROJECT_CHANNELS.detectScenes, (e, id: unknown, crop: unknown) => {
    fromApp(e)
    return detectScenes(id, crop)
  })
}
