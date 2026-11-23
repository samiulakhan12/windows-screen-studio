/**
 * The text reader's state and Find's progress for the UI (docs/design/auto-blur.md §2.6, §16.0).
 * Stubs from the contracts step with their final signatures: part P5 fills them (one shared reader
 * state for every user, the progress line, the leave question); part P1's components use them from
 * the start. Until then there is no state, no progress and leaving is never asked.
 */
import type { FindProgress, ReaderState } from '../../../shared/api/privacy'
import type { EditorServices } from '../editor/context'

/** The reader's state, shared by every user of it. Stub: null (unknown). */
export function useReaderState(): ReaderState | null {
  return null
}

/** Find's progress for `projectId` while it runs. Stub: null. */
export function useFindProgress(projectId: string): FindProgress | null {
  void projectId
  return null
}

/** The one progress line of §2.6 (polite status). Stub: nothing. */
export function FindProgressLine(props: { projectId: string; onReview?: () => void }): JSX.Element | null {
  void props
  return null
}

/** Asks before leaving the editor while Find runs, stopping it and applying what it found (§2.6). Stub: leave at once. */
export function confirmLeaveFind(services: EditorServices): Promise<boolean> {
  void services
  return Promise.resolve(true)
}
