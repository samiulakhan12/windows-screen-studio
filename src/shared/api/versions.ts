import type { FilmstripMeta } from '../editor/filmstrip'
import type { AutoReason, VersionMeta } from '../editor/versions'
import type { Project } from '../types'

/** A version read back to open or compare (docs/design/versions.md §2.4). */
export interface ReadVersion {
  meta: VersionMeta
  project: Project
  /** What the files it names that are gone from the project folder are ('music', 'logo'…). */
  missing: string[]
}

/** Versions of the open project's edit (E-12); only the main window's editor may call these. */
export interface VersionsApi {
  /** Every version of project `projectId`, newest first. */
  listVersions(projectId: string): Promise<VersionMeta[]>
  /**
   * Keeps `project` (the editor's state) as a version: named (`name`, empty: "Version N"), or
   * automatic before `reason` (then null when that edit is already kept). Rejects with the
   * sentence to show.
   */
  saveVersion(projectId: string, project: Project, opts: { name?: string; reason?: AutoReason; about?: string }): Promise<{ saved: VersionMeta | null; removed: string[] }>
  renameVersion(projectId: string, versionId: string, name: string): Promise<VersionMeta>
  /** Removes a version for good. */
  deleteVersion(projectId: string, versionId: string): Promise<void>
  readVersion(projectId: string, versionId: string): Promise<ReadVersion>
}

/** The filmstrip's frames (E-07, docs/design/versions.md §3.4). */
export interface FilmstripApi {
  /** The frames sheet of project `projectId` (a JPEG) and its numbers; null when it cannot be made. */
  getFilmstrip(projectId: string): Promise<{ meta: FilmstripMeta; jpeg: Uint8Array } | null>
}
