import type { StemKind } from '../audio/settings'
import type { SaveMeta, SyncSaveResult } from '../editor/autosave'
import type { StyleDefaults } from '../editor/styleDefaults'
import type { CursorTrack, NormRect, Project, ProjectSummary } from '../types'

export interface LoadedProject {
  project: Project
  cursor: CursorTrack
  dir: string
  screenUrl: string
  webcamUrl: string | null
  backgroundUrl: string | null
  /**
   * Stems the recording kept whose file is missing from its folder (project.audioStems stays
   * as recorded). The editor then opens it without its stems: see openedWithoutStems.
   */
  missingStems: StemKind[]
}

export interface ProjectsApi {
  listProjects(): Promise<ProjectSummary[]>
  loadProject(id: string): Promise<LoadedProject>
  /** `meta` lets main drop a save that arrives after a newer one from the same editor session. */
  saveProject(project: Project, meta?: SaveMeta): Promise<void>
  /** Blocking save for when the window is closing (beforeunload). Never throws. */
  saveProjectSync(project: Project, meta?: SaveMeta): SyncSaveResult
  deleteProject(id: string): Promise<void>
  revealProject(id: string): Promise<void>
  pickBackgroundImage(projectId: string): Promise<{ url: string; path: string } | null>
  /**
   * Lets the user pick an image for a custom cursor and copies it into the project folder
   * (cursor.<ext>); null when cancelled. Rejects with a readable message for an unsupported
   * or oversized file.
   */
  pickCursorImage(projectId: string): Promise<{ url: string; path: string } | null>
  /** Lets the user pick a file and copies it into the project as its `kind` asset. */
  pickAsset(projectId: string, kind: AssetKind): Promise<PickedAsset | null>
  /**
   * Stores the bytes of a file dropped on or pasted into the editor as a `kind` asset ('overlay'
   * or 'font'); `name` gives its extension and the name shown. Rejects with a readable message.
   */
  importAssetData(projectId: string, kind: AssetKind, name: string, bytes: Uint8Array): Promise<PickedAsset>
  /** studio-media URL of a project asset file, or null when it is missing. */
  assetUrl(projectId: string, file: string): Promise<string | null>
  /**
   * Stretches (source seconds) of at least `minSeconds` where the recorded picture does not change,
   * inside `crop` (the editor's crop, cropOf) when one is given: the part cropped away does not count.
   */
  detectStill(projectId: string, minSeconds: number, crop?: NormRect | null): Promise<StillRange[]>
  /** Stops the analyses reading the project's files (still detection, sound levels): its editor closed. */
  stopAnalysis(projectId: string): Promise<void>
  /** URL of a background image stored in the project folder, or null if it is missing. */
  backgroundUrl(projectId: string, path: string): Promise<string | null>
  /** The look new recordings start with, or null when the built-in look is used. */
  getStyleDefaults(): Promise<StyleDefaults | null>
  /**
   * Saves `look` (usually a project's style, cursor, camera and effects) as the look of new
   * recordings and returns what was stored: image backgrounds and cursor/camera visibility are left out.
   */
  saveStyleDefaults(look: StyleDefaults): Promise<StyleDefaults | null>
  /** Forgets the saved look, so new recordings use the built-in one again. */
  resetStyleDefaults(): Promise<void>
}

/** Kinds of user files a project can hold (copied in as `<kind>-<n>.<ext>`). */
export type AssetKind = 'watermark' | 'music' | 'overlay' | 'font'

/** A file copied into a project: its studio-media URL, its project-relative path and the name it had. */
export interface PickedAsset {
  url: string
  path: string
  name?: string
}

/** A stretch of the recording (source seconds) where the picture stays the same. */
export interface StillRange {
  start: number
  end: number
}
