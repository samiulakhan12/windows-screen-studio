import type { CaptureSource, NormRect, RecordingStatus } from '../types'

/** The media files a recording streams to disk while it runs. */
export type TrackKind = 'screen' | 'webcam' | 'audio'

export interface RecordingRequest {
  sourceId: string
  /** Part of the display to keep (normalised to the display); screens only. */
  region: NormRect | null
  systemAudio: boolean
  /** Record shortcut-style keystrokes (never plain typing) for the keystroke overlay. */
  captureKeys: boolean
}

export interface CapturePlan {
  /** Identifies this recording in every later call; stale tokens are rejected. */
  token: string
  /** 'native': the main process records the video (no OS cursor) and the renderer records audio only. */
  method: 'native' | 'chromium'
  /** False when another app already owns the stop shortcut. */
  stopShortcut: boolean
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
  | { ok: false; message: string }

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
  /** False when the stop shortcut could not be registered. */
  stopShortcut?: boolean
}

export type RecorderCommand = 'stop' | 'pause' | 'resume' | 'cancel'

export interface RecordingApi {
  getSources(): Promise<CaptureSource[]>
  prepareCapture(request: RecordingRequest): Promise<CapturePlan>
  /** Appends one MediaRecorder chunk; callers must await each call per kind to keep order. */
  appendRecordingChunk(token: string, kind: TrackKind, data: Uint8Array): Promise<void>
  startNativeVideo(token: string): Promise<NativeStartResult>
  recordingStarted(token: string, info: RecordingStartInfo): Promise<void>
  setRecordingStatus(token: string, status: RecordingStatus): Promise<void>
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
  onRecorderCommand(cb: (command: RecorderCommand) => void): () => void
  onRecordingStatus(cb: (status: ToolbarStatus) => void): () => void
  onProcessing(cb: (progress: ProcessingProgress) => void): () => void
}
