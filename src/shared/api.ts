import type { CaptureSource, CursorTrack, ExportJob, Project, ProjectSummary, RecordingStatus } from './types'

export interface SaveRecordingPayload {
  screen: Uint8Array
  webcam?: Uint8Array
  /** Epoch ms at which the screen recorder started. */
  startedAt: number
  webcamStartedAt?: number
  /** Active (non-paused) duration in seconds. */
  duration: number
  width: number
  height: number
  hasAudio: boolean
  /** The capture honoured `cursor: 'never'` (no OS cursor in the video). */
  cursorHidden: boolean
}

export interface LoadedProject {
  project: Project
  cursor: CursorTrack
  dir: string
  screenUrl: string
  webcamUrl: string | null
  backgroundUrl: string | null
}

export type RecorderCommand = 'stop' | 'pause' | 'resume' | 'cancel'

/** API exposed to renderer windows by the preload script as `window.api`. */
export interface StudioApi {
  platform: string
  getSources(): Promise<CaptureSource[]>
  prepareCapture(sourceId: string, systemAudio: boolean): Promise<void>
  recordingStarted(startedAt: number): Promise<void>
  setRecordingStatus(status: RecordingStatus): Promise<void>
  saveRecording(payload: SaveRecordingPayload): Promise<string>
  cancelRecording(): Promise<void>
  sendRecorderCommand(command: RecorderCommand): Promise<void>
  onRecorderCommand(cb: (command: RecorderCommand) => void): () => void
  onRecordingStatus(cb: (status: RecordingStatus) => void): () => void
  onProcessing(cb: (message: string) => void): () => void

  listProjects(): Promise<ProjectSummary[]>
  loadProject(id: string): Promise<LoadedProject>
  saveProject(project: Project): Promise<void>
  deleteProject(id: string): Promise<void>
  revealProject(id: string): Promise<void>
  pickBackgroundImage(projectId: string): Promise<{ url: string; path: string } | null>

  chooseExportPath(defaultName: string, format: 'mp4' | 'gif'): Promise<string | null>
  exportStart(projectId: string, job: ExportJob): Promise<void>
  exportFrame(frame: Uint8Array): Promise<void>
  exportFinish(): Promise<void>
  exportCancel(): Promise<void>
  showItemInFolder(path: string): Promise<void>
}
