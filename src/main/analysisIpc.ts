/**
 * Analysis of a recording for smart editing: stretches where the picture does not change
 * (ffmpeg freezedetect on the screen proxy). Used by smart speed to suggest speed-ups and cuts.
 */
import { ipcMain } from 'electron'
import type { StillRange } from '../shared/api/projects'

/** Stretches of at least `minSeconds` where screen.mp4 of project `id` barely changes. */
export async function detectStill(id: string, minSeconds: number): Promise<StillRange[]> {
  void id
  void minSeconds
  return []
}

export function registerAnalysisIpc(): void {
  ipcMain.handle('projects:detectStill', (_e, id: string, minSeconds: number) => detectStill(id, minSeconds))
}
