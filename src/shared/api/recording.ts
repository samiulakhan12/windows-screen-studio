import type { CaptureSource, NormRect, RecordingStatus } from '../types'
import type { HotkeyAction, HotkeyCheck } from '../recording/hotkeys'
import type { AppSettings, RecordingSettingsPatch } from '../recording/settings'

/** The media files a recording streams to disk while it runs. */
export type TrackKind = 'screen' | 'webcam' | 'audio'

export interface RecordingRequest {
  sourceId: string
  /** Part of the display to keep (normalised to the display); screens only. */
  region: NormRect | null
  systemAudio: boolean
  /**
   * Record keyboard activity: shortcut-style keystrokes for the keystroke overlay and when
   * typing happened (for auto zoom). Which keys were typed is never recorded.
   */
  captureKeys: boolean
}

export interface CapturePlan {
  /** Identifies this recording in every later call; stale tokens are rejected. */
  token: string
  /** 'native': the main process records the video (no OS cursor) and the renderer records audio only. */
  method: 'native' | 'chromium'
  /** False when another app already owns the stop shortcut. */
  stopShortcut: boolean
  /** Screen capture frame rate (from the app settings). */
  fps: 30 | 60
  /** Hotkeys that could not be registered (another app owns them), as messages to show. */
  hotkeyProblems?: string[]
  /** Something the user should know about this recording (e.g. a window recorded without cursor effects). */
  notice?: string
}

/** What window recordings get on this PC (the hint on Home). */
export interface WindowCaptureSupport {
  /** Cursor data for windows: auto zoom, click highlights, follow-cursor zooms. */
  effects: boolean
  /** The window is recorded without the Windows cursor, so the smooth cursor replaces it. */
  smoothCursor: boolean
}

export interface RecordingStartInfo {
  /** 'chromium' here after a native start failed means the renderer fell back. */
  method: 'native' | 'chromium'
  /** Epoch ms of the screen video's timeline start. */
  startedAt: number
  /** Encoded screen video size in physical pixels. */
  width: number
  height: number
  hasAudio: boolean
  hasWebcam: boolean
  webcamFps: number
}

export type NativeStartResult =
  | { ok: true; startedAt: number; width: number; height: number }
  /** `notice`: what the fallback to Chromium capture costs (e.g. a window loses its cursor effects). */
  | { ok: false; message: string; notice?: string }

/** Metadata sent on stop; the media itself has already been streamed to disk. */
export interface SaveRecordingPayload {
  /** Epoch ms of the screen timeline start, refined after the first frames arrived. */
  startedAt: number
  /** Active (non-paused) duration in seconds as measured by the recorder. */
  duration: number
  /** Webcam timeline start minus screen timeline start, in seconds. */
  webcamOffset: number
  /** Audio timeline start minus video timeline start (native capture only), in seconds. */
  audioOffset: number
}

export interface ProcessingProgress {
  /** Set once on the last event of a run (finished, failed or postponed). */
  done?: boolean
  message: string
  /** 0..1, or null while the amount of work is unknown. */
  progress: number | null
}

export interface UnfinishedRecording {
  id: string
  createdAt: string
  /** 'interrupted': the app or recorder stopped mid-recording; 'failed': processing failed. */
  status: 'interrupted' | 'failed'
  error: string | null
  dir: string
  /** Size of the raw media on disk, in bytes. */
  bytes: number
}

/** A display area picked in the region overlay. */
export interface RegionSelection {
  region: NormRect
  /** Approximate recorded size in physical pixels. */
  width: number
  height: number
}

export interface ToolbarStatus extends RecordingStatus {
  /** Countdown over, waiting for the capture to start (the native helper can take seconds). */
  starting?: boolean
  /** False when the stop shortcut could not be registered. */
  stopShortcut?: boolean
  /** Paused by auto-pause (no input for a while); the next input resumes. */
  idle?: boolean
  /** Labels of the hotkeys that work during this recording ("Ctrl + Shift + 2"). */
  hotkeys?: Partial<Record<HotkeyAction, string>>
  /** Hotkeys that could not be registered, as messages. */
  hotkeyProblems?: string[]
  /** "Zoom here" marks made so far (the toolbar acknowledges each one). */
  marks?: number
}

export type RecorderCommand = 'stop' | 'pause' | 'resume' | 'cancel'

/** A recorder status sent to the main process (and shown on the toolbar). */
export type RecorderStatusUpdate = RecordingStatus & Pick<ToolbarStatus, 'starting'>

export interface RecordingApi {
  /** Screens and/or windows with small JPEG thumbnails (both kinds when `kinds` is omitted). */
  getSources(kinds?: CaptureSource['kind'][]): Promise<CaptureSource[]>
  /** What window recordings get on this PC (checked once). */
  getWindowCaptureSupport(): Promise<WindowCaptureSupport>
  prepareCapture(request: RecordingRequest): Promise<CapturePlan>
  /** Appends one MediaRecorder chunk; callers must await each call per kind to keep order. */
  appendRecordingChunk(token: string, kind: TrackKind, data: Uint8Array): Promise<void>
  startNativeVideo(token: string): Promise<NativeStartResult>
  recordingStarted(token: string, info: RecordingStartInfo): Promise<void>
  setRecordingStatus(token: string, status: RecorderStatusUpdate): Promise<void>
  saveRecording(token: string, payload: SaveRecordingPayload): Promise<string>
  cancelRecording(token: string): Promise<void>
  sendRecorderCommand(command: RecorderCommand): Promise<void>
  getRecordingStatus(): Promise<ToolbarStatus>
  pickRegion(sourceId: string): Promise<RegionSelection | null>
  /** Sent by the region overlay window. */
  finishRegion(region: NormRect | null): void
  listUnfinishedRecordings(): Promise<UnfinishedRecording[]>
  recoverRecording(id: string): Promise<string>
  /** Stops the conversion in progress; the recording stays under Unfinished recordings. */
  finishProcessingLater(): Promise<void>
  openPrivacySettings(kind: 'microphone' | 'camera'): Promise<void>
  /** App-wide settings (recording options chosen on Home). */
  getAppSettings(): Promise<AppSettings>
  /** Saves a change to the recording options and returns the validated settings. */
  updateRecordingSettings(patch: RecordingSettingsPatch): Promise<AppSettings>
  /**
   * Whether `accelerator` can be the hotkey for `action`: valid, not used by another of the
   * app's hotkeys, and (when no recording runs) not already taken by another app.
   */
  checkHotkey(action: HotkeyAction, accelerator: string): Promise<HotkeyCheck>
  onRecorderCommand(cb: (command: RecorderCommand) => void): () => void
  /** Problems the main process noticed during a recording (e.g. the recorded screen went away). */
  onRecorderWarning(cb: (message: string) => void): () => void
  onRecordingStatus(cb: (status: ToolbarStatus) => void): () => void
  onProcessing(cb: (progress: ProcessingProgress) => void): () => void
}
