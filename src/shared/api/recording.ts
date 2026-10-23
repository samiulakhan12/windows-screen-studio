import type { CaptureSource, RecordingStatus } from '../types'

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

export type RecorderCommand = 'stop' | 'pause' | 'resume' | 'cancel'

export interface RecordingApi {
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
}
