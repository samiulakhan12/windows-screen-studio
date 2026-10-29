/** Importing a video made with another app as a new project (docs/design/import-video.md). */

/** Where an import is. `progress` is 0..1 while the editing copy is made (null: unknown). */
export interface ImportProgress {
  fileName: string
  stage: 'checking' | 'converting' | 'finishing'
  progress: number | null
}

export type ImportResult =
  | { ok: true; projectId: string; fileName: string; notes: string[] }
  | { ok: false; cancelled: true; fileName: string | null }
  | { ok: false; cancelled?: false; fileName: string | null; error: string }

export interface ImportApi {
  /** Lets the user pick a video and imports it; null when the picker was closed. Never rejects. */
  importPickedVideo(): Promise<ImportResult | null>
  /** Imports the video at `path` (a dropped file, see importPathForFile). Never rejects. */
  importVideoFile(path: string): Promise<ImportResult>
  /** Stops the running import; it then resolves as cancelled and leaves nothing behind. */
  cancelImport(): Promise<void>
  /** Progress of the running import. Returns the unsubscribe function. */
  onImportProgress(cb: (p: ImportProgress) => void): () => void
  /** The path of a dropped file ('' when it has none, e.g. a file inside a zip). */
  importPathForFile(file: File): string
}
