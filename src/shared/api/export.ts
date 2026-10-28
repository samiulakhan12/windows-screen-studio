import type { AudioLevels } from '../audio/loudness'
import type { AudioSource, StemKind } from '../audio/settings'
import type { Range } from '../audio/activity'
import type { OutputChapter } from '../render/chapters'
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

/** Byte order of 32-bit canvas frames (ffmpeg pixel format names). */
export type Rgb32Format = 'rgba' | 'bgra' | 'rgb0' | 'bgr0'

/**
 * Pixel format of raw frames: 32-bit as read back from the canvas (GIFs, whose palette wants
 * RGB), or planar 4:2:0 YUV converted in the renderer (rgbToI420), 2.7x less to send.
 */
export type RawPixelFormat = Rgb32Format | 'yuv420p'

/** How video reaches ffmpeg. */
export type VideoInput =
  /** Raw frames, encoded by ffmpeg with `encoder`. */
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

/** A pause freeze in the export's sound: `length` seconds of silence before source second `at`. */
export interface SoundHold {
  at: number
  length: number
}

/** The recording's sound in an export. */
export interface RecordingSound {
  /** Kept clips (source seconds): cut and re-timed like the video. */
  clips: Clip[]
  /** Master gain 0..2, after the sources are mixed (and normalised). */
  volume: number
  /**
   * Mix the separately recorded microphone / system sound files (mic.m4a, system.m4a) with
   * these gains instead of the screen proxy's mixed track. A source left out is silent.
   */
  stems?: Partial<Record<StemKind, number>>
  /** Background noise reduction 0..1: on the microphone stem, or on the mixed track without stems. */
  noiseReduction?: number
  /** Loudness normalisation to about -16 LUFS (EBU R128). */
  normalize?: boolean
  /** Pause freezes, sorted by `at` (absent or empty: none). */
  holds?: SoundHold[]
  /** Seconds of fade out before and fade in after every cut (NW-06); absent: none (earlier jobs). */
  cutFade?: number
}

/** Background music in an export: plays on the output timeline from its start, ignoring cuts. */
export interface MusicSound {
  /** Project file (music.<ext>). */
  file: string
  /** Linear gain 0..2. */
  volume: number
  loop: boolean
  /** Fade lengths in seconds. */
  fadeIn: number
  fadeOut: number
  /** Length of the music file (seconds) when known: a non-looping track fades out where it ends. */
  duration: number | null
  /** Lowered by `depth` (0..1) during `ranges` (output seconds, where the recording has sound). */
  duck?: { depth: number; attack: number; release: number; ranges: Range[] }
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
  /** The recording's sound; omitted when it is silent. */
  audio?: RecordingSound
  /** Click sounds mixed into the soundtrack (also when the recording has no audio). */
  clicks?: ClickSounds
  /** Background music mixed into the soundtrack. */
  music?: MusicSound
  /** Fades of the whole soundtrack at the start and end, seconds. */
  fadeIn?: number
  fadeOut?: number
  /**
   * Size target: average bit rates (bit/s) to encode at instead of a quality level.
   * The software encoders then run two passes over an intermediate file.
   */
  bitrate?: { video: number; audio: number }
  /** GIF only: largest file in bytes; frame rate, size and colours are reduced until it fits. */
  maxBytes?: number
  /** Chapter markers written into the file (not GIF): output seconds, in order (see shared/render/chapters). */
  chapters?: OutputChapter[]
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
  /**
   * Sound levels of a project's recorded sources (the screen proxy's track and/or the stems),
   * for ducking music and the preview's loudness. A source without sound gets an empty envelope.
   */
  analyzeAudio(projectId: string, sources: AudioSource[]): Promise<Partial<Record<AudioSource, AudioLevels>>>
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
