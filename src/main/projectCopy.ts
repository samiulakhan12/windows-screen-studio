/**
 * Duplicate, Make a vertical version and Make a square version in the main process (X-04,
 * docs/design/vertical-video.md §4.7): a new project folder with the renderer's copy of the
 * project, written last, and the source's recording files, hard-linked where that is safe and
 * copied otherwise. The source folder is never written. A `.copying` marker keeps a half-made
 * copy out of the library until it is finished or cleaned up.
 *
 * CONTRACT: media files may be hard-linked between projects; code outside src/main/recording/
 * must never open LINKED_MEDIA for writing: write a temporary file and rename it.
 *
 * CONTRACT (part P4): signatures and constants are frozen; bodies are to be written.
 */
import type { DuplicateProgress, DuplicateResult } from '../shared/api/projects'

/** The recording's media, never rewritten once the project exists: linked when allowed. */
export const LINKED_MEDIA = ['screen.mp4', 'webcam.mp4', 'mic.m4a', 'system.m4a'] as const
/** Written first into a copy being made, removed when it is finished. */
export const COPYING_MARK = '.copying'

/** How a file of the source folder goes into the copy: linked (LINKED_MEDIA), copied, or left out (null). */
export function copiedFile(name: string): 'link' | 'copy' | null {
  return notImplemented(name)
}

/** Whether media may be hard-linked under the projects root `root`: not inside a OneDrive folder (env OneDrive, OneDriveConsumer, OneDriveCommercial). */
export function linkAllowed(root: string, env?: NodeJS.ProcessEnv): boolean {
  return notImplemented(root, env)
}

/**
 * Makes the copy: a new folder holding `raw` (the renderer's projectCopy, still carrying
 * `sourceId`, checked with migrateProject) and the source's files. Rejects with a readable
 * message (or an AbortError when `signal` aborts), leaving no folder behind.
 */
export async function duplicateProject(
  sourceId: string,
  raw: unknown,
  opts?: { signal?: AbortSignal; onProgress?: (p: DuplicateProgress) => void; now?: Date }
): Promise<DuplicateResult> {
  return notImplemented(sourceId, raw, opts)
}

/** Removes copies a crash left half made (marked, more than an hour old, without project.json or raw files); how many. */
export async function removeStaleCopies(now?: number): Promise<number> {
  return notImplemented(now)
}

/** Placeholder of the contract; the implementation replaces every call. */
function notImplemented(...args: unknown[]): never {
  void args
  throw new Error('not implemented')
}
