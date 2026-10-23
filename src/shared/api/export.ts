import type { Clip, ExportFormat, ExportSettings } from '../types'

/** H.264 encoders ffmpeg may use; GPU ones are only used after a successful probe. */
export type H264Encoder = 'h264_nvenc' | 'h264_qsv' | 'h264_amf' | 'h264_mf' | 'libx264'

/**
 * H.264 VUI colour description (ITU-T H.273 code points) of an already-encoded
 * stream. `matrix`/`fullRange` are null when the encoder did not say which it used;
 * the stream's own values are then kept.
 */
export interface ColorTags {
  primaries: number
  transfer: number
  matrix: number | null
  fullRange: boolean | null
}

/** Byte order of raw frames (ffmpeg pixel format names). */
export type RawPixelFormat = 'rgba' | 'bgra' | 'rgb0' | 'bgr0'

/** How video reaches ffmpeg. */
export type VideoInput =
  /** Raw 32-bit frames, encoded by ffmpeg with `encoder`. */
  | { kind: 'raw'; encoder: H264Encoder; pixelFormat: RawPixelFormat }
  /** An H.264 Annex B stream encoded in the renderer (WebCodecs); ffmpeg only muxes it. */
  | { kind: 'h264'; color: ColorTags }

export interface ExportJob {
  width: number
  height: number
  fps: number
  /** Exact number of video frames; also fixes the audio length. */
  frames: number
  format: ExportFormat
  quality: ExportSettings['quality']
  video: VideoInput
  /** Kept clips (source seconds) and gain for the soundtrack; omitted for silent exports. */
  audio?: { clips: Clip[]; volume: number }
  outputPath: string
}

export interface ExportCapabilities {
  /** GPU H.264 encoders that passed a test encode, best first. */
  hardwareEncoders: H264Encoder[]
  /** Test hooks set through the environment (e2e only). */
  overrides: { decoder?: 'element' | 'webcodecs'; videoEncoder?: 'webcodecs-software' | 'ffmpeg' }
}

export type ClipboardResult = { ok: true } | { ok: false; message: string }

export interface ExportApi {
  chooseExportPath(defaultName: string, format: ExportFormat): Promise<string | null>
  exportCapabilities(): Promise<ExportCapabilities>
  exportStart(projectId: string, job: ExportJob): Promise<void>
  /** Raw RGBA frame or a batch of encoded H.264 bytes, depending on the job's video input. */
  exportFrame(data: Uint8Array): Promise<void>
  /** Finishes encoding and moves the file into place (resolves with its size); rejects if cancelled. */
  exportFinish(): Promise<{ bytes: number }>
  /** Stops any export (also during finishing) and deletes its partial file. */
  exportCancel(): Promise<void>
  /** Puts an exported file on the system clipboard (as a file, for pasting into apps). */
  copyFileToClipboard(path: string): Promise<ClipboardResult>
  showItemInFolder(path: string): Promise<void>
}
