/**
 * Making a copy from the editor (X-04, NW-05, docs/design/vertical-video.md §2.3, §4.8): pause,
 * flush the save (asking before copying when it failed), build the copy with projectCopy
 * (measuring text as the compositor does), call the API with progress, and say what was made.
 *
 * CONTRACT (part P4): the signature is frozen; the body is to be written.
 */
import type { DuplicateProgress } from '../../../shared/api/projects'
import type { CopyKind } from '../../../shared/editor/duplicate'
import type { Project } from '../../../shared/types'

/** The new project's id and the notice to show there, or null when cancelled or not confirmed. Rejects with the message to show. */
export async function runDuplicate(
  kind: CopyKind,
  deps: { project: Project; flush(): Promise<boolean>; confirm(msg: string): boolean; onProgress(p: DuplicateProgress | null): void; signal: AbortSignal }
): Promise<{ id: string; notice: string } | null> {
  void kind
  void deps
  throw new Error('not implemented')
}
