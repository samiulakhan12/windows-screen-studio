/**
 * Running Find chapters (docs/design/smart-tools.md §7.8), from the Text tab, the palette, and the
 * Captions tab's Suggest chapters (§7.6.1). Part P2 writes it; the contracts' stub refuses.
 */
import type { CursorTrack, Project } from '../../../shared/types'
import type { EditStore } from '../../../shared/editor/editStore'

export interface FindChapterOptions {
  density: 'fewer' | 'normal' | 'more'
  use: { screen: boolean; pauses: boolean; words: boolean }
  /** 'offline', a provider's or service's id, or 'local'. */
  names: string
  /** A provider's id: Suggest chapters with its suggestions (§7.6.1). */
  split?: string
}

/**
 * Whether Find chapters is built (part P2 sets it to true with runFindChapters' body). Until then
 * the Captions tab's Suggest chapters runs the chapters task alone, as before (§7.6.1).
 */
export const FIND_CHAPTERS_BUILT: boolean = false

export async function runFindChapters(deps: {
  store: EditStore<Project>
  recorded: CursorTrack
  options: FindChapterOptions
  signal: AbortSignal
  requestId: string
  onProgress(text: string, fraction: number | null): void
}): Promise<{ notice: string; weak: string | null } | { needsCaptions: true }> {
  void deps
  throw new Error('Find chapters is not part of this build.')
}
