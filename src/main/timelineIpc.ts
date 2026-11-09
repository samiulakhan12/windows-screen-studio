/**
 * Timelines for other editors (docs/design/output-and-languages.md §8.7): main checks the request
 * (the session's exported video, stems next to it, checkTimelinePlan), probes the media, copies the
 * recordings when asked, runs the writers and writes each file under a free name.
 *
 * Part P4 writes it; the contracts' stub writes nothing and says so.
 */
import { ipcMain } from 'electron'
import type { TimelineEditor, TimelineRequest, TimelineResult } from '../shared/api/export'
import type { VoiceStrength } from '../shared/types'
import type { TimelineMedia } from '../shared/interchange/timelinePlan'
import { isAppUrl } from './security'
import { t } from '../shared/i18n/t'

/** What the writer reads and runs (tests replace them). Part P4 fills it in. */
export interface TimelineDeps {
  exists?: (file: string) => boolean
}

/** Writes the timeline files of `request` (§8.7). Part P4. */
export async function writeTimeline(request: TimelineRequest, deps?: TimelineDeps): Promise<TimelineResult> {
  void request
  void deps
  return { files: [], problem: t('errors.feature.notReady') }
}

/** Copies the recordings of `projectId` into `folder` for "The original recordings" (§8.1). Part P4. */
export async function copyRecordings(projectId: string, folder: string, voice: VoiceStrength | null, deps?: TimelineDeps): Promise<Partial<Record<TimelineMedia, string>>> {
  void projectId
  void folder
  void voice
  void deps
  return {}
}

/** The timeline files next to `video` for `editors`, " (2)" when taken (§2.3). Part P4. */
export function timelinePaths(video: string, editors: readonly TimelineEditor[], withMarkers: boolean, exists: (p: string) => boolean): { path: string; for: TimelineEditor | 'resolve-markers' }[] {
  void video
  void editors
  void withMarkers
  void exists
  return []
}

/** `export:writeTimeline`, for the app's own page only. */
export function registerTimelineIpc(): void {
  ipcMain.handle('export:writeTimeline', (e, request: TimelineRequest) => {
    if (!isAppUrl(e.senderFrame?.url ?? '')) throw new Error('Not allowed')
    return writeTimeline(request)
  })
}
