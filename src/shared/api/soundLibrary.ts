/**
 * The music and sound-effects library (docs/design/editing-polish.md §10.3, §14) between the editor
 * and the main process. The renderer names catalogue ids and project ids, never paths: main lists
 * what is bundled and downloaded, downloads a bed from the pinned source (SHA-256 checked, size
 * capped), and copies a bed into a project as music-<n>.ogg. Every channel accepts the app's own
 * page only (fromApp), and main checks every argument against the catalogue.
 */

/** Where one library bed is on this PC. */
export interface SoundLibraryState {
  /** A MUSIC_BEDS id. */
  id: string;
  /** 'bundled': in the installer; 'downloaded': in userData/sound-library/ and checked; 'missing': neither; 'downloading': under way. */
  state: "bundled" | "downloaded" | "missing" | "downloading";
  /** The prepared file's pinned size. */
  bytes: number;
  /** 0..1 while downloading. */
  progress?: number;
}

export const SOUND_LIBRARY_CHANNELS = {
  /** invoke () → SoundLibraryState[]: every bed of the catalogue */
  list: "soundLibrary:list",
  /** invoke (id) → SoundLibraryState: downloads a bed from the pinned source; progress arrives on `progress` */
  download: "soundLibrary:download",
  /** invoke (id) → void: stops that bed's download (its .part file is deleted) */
  cancel: "soundLibrary:cancel",
  /** invoke () → void: deletes every downloaded bed (Settings › Downloads › More music › Remove) */
  remove: "soundLibrary:remove",
  /** invoke (projectId, id) → { file }: the bed copied into the project as music-<n>.ogg, its hash checked again */
  useBed: "soundLibrary:useBed",
  /** main → renderer: SoundLibraryState of a bed whose download moved on */
  progress: "soundLibrary:progress",
} as const;

export interface SoundLibraryApi {
  soundLibraryList(): Promise<SoundLibraryState[]>;
  soundLibraryDownload(id: string): Promise<SoundLibraryState>;
  soundLibraryCancel(id: string): Promise<void>;
  soundLibraryRemove(): Promise<void>;
  soundLibraryUseBed(projectId: string, id: string): Promise<{ file: string }>;
  /** Listens for download progress; returns the function that stops listening. */
  onSoundLibraryProgress(
    listener: (state: SoundLibraryState) => void,
  ): () => void;
}
