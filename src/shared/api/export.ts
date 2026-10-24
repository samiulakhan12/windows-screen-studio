import type { Clip, ExportFormat, ExportSettings } from '../types'

/** H.264 encoders ffmpeg may use; GPU ones are only used after a successful probe. */
export type H264Encoder = 'h264_nvenc' | 'h264_qsv' | 'h264_amf' | 'h264_mf' | 'libx264'

/** Encoders ffmpeg may encode raw frames with (libvpx-vp9 for WebM). */
export type FfmpegVideoEncoder = H264Encoder | 'libvpx-vp9'

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
  | { kind: 'raw'; encoder: FfmpegVideoEncoder; pixelFormat: RawPixelFormat }
  /** An H.264 Annex B stream encoded in the renderer (WebCodecs); ffmpeg only muxes it. */
  | { kind: 'h264'; color: ColorTags }
  /** A VP9 stream encoded in the renderer (WebCodecs), framed as IVF; ffmpeg only muxes it. */
  | { kind: 'vp9'; color: ColorTags }
  /** No video (audio-only formats): nothing is sent, ffmpeg runs on its own. */
  | { kind: 'none' }

/** Click sounds to mix into the soundtrack (see shared/render/clickSound). */
export interface ClickSounds {
  /** Output seconds (after cuts and speed changes). */
  times: number[]
  /** Linear gain 0..1. */
  volume: number
}

export interface ExportJob {
  width: number
  height: number
  fps: number
  /** Exact number of video frames; also fixes the audio length (frames / fps). */
  frames: number
  format: ExportFormat
  quality: ExportSettings['quality']
  video: VideoInput
  /** Kept clips (source seconds) and gain for the soundtrack; omitted for silent exports. */
  audio?: { clips: Clip[]; volume: number }
  /** Click sounds mixed into the soundtrack (also when the recording has no audio). */
  clicks?: ClickSounds
  /**
   * Size target: average bit rates (bit/s) to encode at instead of a quality level.
   * The software encoders then run two passes over an intermediate file.
   */
  bitrate?: { video: number; audio: number }
  /** GIF only: largest file in bytes; frame rate, size and colours are reduced until it fits. */
  maxBytes?: number
  outputPath: string
}

export interface ExportCapabilities {
  /** GPU H.264 encoders that passed a test encode, best first. */
  hardwareEncoders: H264Encoder[]
  /** Whether Chromium draws 2D canvases on the GPU here (false: GPU blocklisted or unavailable). */
  gpuCanvas: boolean
  /** Test hooks set through the environment (e2e only). */
  overrides: { decoder?: 'element' | 'webcodecs'; videoEncoder?: 'webcodecs-software' | 'ffmpeg' }
}

export interface ExportFinish {
  /** Size of the finished file. */
  bytes: number
  /** What the main process changed to meet a GIF size limit (e.g. "12 fps, 600 px wide"). */
  reduced?: string
  /** Set when a GIF could not be made small enough even at the smallest settings. */
  overLimit?: boolean
}

export type ClipboardResult = { ok: true } | { ok: false; message: string }

export interface ExportApi {
  /** Save dialog for one export (or a PNG thumbnail); the chosen path is the only one export:start accepts. */
  chooseExportPath(defaultName: string, format: ExportFormat | 'png'): Promise<string | null>
  /** Folder dialog for a batch export; files may then be written into this folder only. */
  chooseExportFolder(): Promise<string | null>
  /**
   * A free path for `fileName` in the folder chosen with chooseExportFolder (an existing
   * file is never replaced: " (2)" is added). export:start accepts it once.
   */
  exportBatchPath(folder: string, fileName: string): Promise<string>
  exportCapabilities(): Promise<ExportCapabilities>
  exportStart(projectId: string, job: ExportJob): Promise<void>
  /** Raw RGBA frame or a batch of encoded bytes, depending on the job's video input. */
  exportFrame(data: Uint8Array): Promise<void>
  /** Finishes encoding and moves the file into place (resolves with its size); rejects if cancelled. */
  exportFinish(): Promise<ExportFinish>
  /** Stops any export (also during finishing) and deletes its partial file. */
  exportCancel(): Promise<void>
  /** Writes a PNG to the path chosen with chooseExportPath(name, 'png'), safely (temp file + rename). */
  saveThumbnail(path: string, png: Uint8Array): Promise<{ bytes: number }>
  /** Puts an exported file on the system clipboard (as a file, for pasting into apps). */
  copyFileToClipboard(path: string): Promise<ClipboardResult>
  showItemInFolder(path: string): Promise<void>
}
