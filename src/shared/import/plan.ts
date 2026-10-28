/**
 * The rules of importing a video (docs/design/import-video.md §5): what is accepted, the editing
 * copy's size and frame rate, the disk space it needs, and the sentences the user reads. Pure.
 */
import type { ImportedSource } from '../types'
import type { ProbeInfo, ProbeStream } from './probe'

export const IMPORT_LIMITS = {
  minBytes: 1024,
  maxBytes: 64 * 1024 ** 3,
  minSeconds: 0.5,
  maxSeconds: 4 * 3600,
  minSide: 16,
  maxSide: 16384,
  maxAspect: 10,
  /** The editing copy fits inside this in either orientation. */
  fitLong: 3840,
  fitShort: 2160,
  /** Frame rates above this become 60 fps, the rest 30 fps. */
  fps60Above: 31,
  /** Margin added to the space estimate (sound, the index, the file system). */
  spaceMarginBytes: 512 * 1024 ** 2,
  spaceFactor: 1.25
} as const

/** File extensions the picker offers and drops accept. */
export const IMPORT_EXTENSIONS = ['mp4', 'm4v', 'mov', 'mkv', 'webm'] as const

/** What the user reads (§5.3, §5.4). */
export const IMPORT_COPY = {
  extension: 'Flown can import MP4, MOV, MKV and WebM videos.',
  cannotOpen: 'That file could not be opened.',
  empty: 'This file is empty.',
  tooLarge: 'This file is too large to import (64 GB at most).',
  notVideo: (ext: string) => `This file is not a video Flown can read, even though its name ends in .${ext}.`,
  unreadable: 'This file could not be read as a video (it may be damaged).',
  soundOnly: 'This file has sound but no picture. To use it as music, open a project and add it in the Audio tab.',
  noVideo: 'This file has no video in it.',
  drm: 'This video is copy-protected (DRM), so it cannot be edited.',
  codec: (codec: string) => `Flown cannot read this video's format (${codec}). Convert it to MP4 (H.264) and try again.`,
  tooShort: 'This video is too short to edit (less than half a second).',
  tooLong: 'This video is longer than 4 hours. Trim it or split it into parts first.',
  size: (w: number, h: number) => `This video's picture size (${w} × ${h}) is not supported.`,
  narrow: (w: number, h: number) => `This video's picture is too narrow to edit (${w} × ${h}).`,
  space: (needed: number, free: number) => `There is not enough free space for this video: it needs about ${gb(needed)} and ${gb(free)} is free.`,
  busy: 'Another video is being imported. Wait for it to finish.',
  several: 'Drop one video at a time.',
  diskFull: 'Your disk is full. Free some space and try again.',
  failed: (detail: string) => `The video could not be converted${detail ? ` (${detail})` : ''}.`,
  noteTracks: (n: number) => `This video has ${n} sound tracks; Flown uses the first one.`,
  noteNoSound: 'The sound in this video could not be read, so it was imported without sound.',
  noteHdr: 'This is an HDR video; its colours were converted for normal screens.',
  noteHdrPale: 'This is an HDR video, so its colours may look paler in Flown.',
  noteScaled: (w: number, h: number) => `This video was larger than 4K, so the editing copy is ${w} × ${h}.`,
  noteCapped: 'Only the first 4 hours were imported.'
} as const

/** "5.7 GB", "640 MB". */
export function gb(bytes: number): string {
  const g = bytes / 1024 ** 3
  return g >= 1 ? `${g.toFixed(1)} GB` : `${Math.max(1, Math.round(bytes / 1024 ** 2))} MB`
}

export const extensionOf = (fileName: string): string => /\.([^./\\]+)$/.exec(fileName)?.[1]?.toLowerCase() ?? ''

export const importableExtension = (fileName: string): boolean => (IMPORT_EXTENSIONS as readonly string[]).includes(extensionOf(fileName))

/**
 * The container the first bytes of a file show: an ISO/QuickTime file (a box type at offset 4)
 * or Matroska/WebM (the EBML magic); null for anything else. Either is accepted whatever the
 * extension says (a WebM named .mp4 is common), since ffmpeg reads the content.
 */
export function sniffContainer(head: Uint8Array): 'mp4' | 'matroska' | null {
  if (head.length >= 4 && head[0] === 0x1a && head[1] === 0x45 && head[2] === 0xdf && head[3] === 0xa3) return 'matroska'
  if (head.length < 8) return null
  const box = String.fromCharCode(head[4], head[5], head[6], head[7])
  return ['ftyp', 'moov', 'mdat', 'wide', 'free', 'skip', 'pnot', 'uuid'].includes(box) ? 'mp4' : null
}

/**
 * Whether these bytes (the start and end of an MP4/MOV file, where its index is) hold a protected
 * track: a `sinf` box whose first child is `frma`, which only DRM-protected sample entries have
 * (ffmpeg shows such tracks with their original codec and fails to decode them).
 */
export function hasProtectedTrack(bytes: Uint8Array): boolean {
  for (let i = 0; i + 16 <= bytes.length; i++) {
    if (bytes[i] !== 0x73 || bytes[i + 1] !== 0x69 || bytes[i + 2] !== 0x6e || bytes[i + 3] !== 0x66) continue // 'sinf'
    if (bytes[i + 8] === 0x66 && bytes[i + 9] === 0x72 && bytes[i + 10] === 0x6d && bytes[i + 11] === 0x61) return true // 'frma'
  }
  return false
}

/** Size checks of the file itself, before ffmpeg reads it; null when it is fine. */
export function checkFileSize(bytes: number): string | null {
  if (!(bytes >= IMPORT_LIMITS.minBytes)) return IMPORT_COPY.empty
  if (bytes > IMPORT_LIMITS.maxBytes) return IMPORT_COPY.tooLarge
  return null
}

/** The project's name: the file name without its extension, cleaned (§4.4). */
export function importName(fileName: string): string {
  const base = fileName.replace(/^.*[\\/]/, '').replace(/\.[^.]*$/, '')
  // eslint-disable-next-line no-control-regex
  const clean = base.replace(/[\u0000-\u001f\u007f-\u009f]/g, ' ').replace(/\s+/g, ' ').trim()
  return clean ? [...clean].slice(0, 120).join('').trim() : 'Imported video'
}

const even = (v: number): number => 2 * Math.floor(v / 2)

/** The picture as it is shown: rotated and with square pixels. */
export function displaySize(stream: Pick<ProbeStream, 'width' | 'height' | 'sar' | 'rotation'>): { width: number; height: number } {
  const w = stream.width ?? 0
  const h = stream.height ?? 0
  const width = stream.sar && Math.abs(stream.sar - 1) > 1e-3 ? Math.round(w * stream.sar) : w
  return stream.rotation === 90 || stream.rotation === 270 ? { width: h, height: width } : { width, height: h }
}

/** The editing copy's size: the display size fitted inside 3840 × 2160 (either way), even (§2.4). */
export function proxySizeFor(display: { width: number; height: number }): { width: number; height: number } {
  const long = Math.max(display.width, display.height)
  const short = Math.min(display.width, display.height)
  const scale = Math.min(1, IMPORT_LIMITS.fitLong / long, IMPORT_LIMITS.fitShort / short)
  return {
    width: Math.max(IMPORT_LIMITS.minSide, even(display.width * scale)),
    height: Math.max(IMPORT_LIMITS.minSide, even(display.height * scale))
  }
}

/** The editing copy's frame rate (§2.3). */
export const proxyFpsFor = (fps: number | null): 30 | 60 => (fps !== null && fps > IMPORT_LIMITS.fps60Above ? 60 : 30)

/** Bits per second the editing copy is estimated at (proxyArgs' own bitrate rule). */
export const proxyBitrate = (width: number, height: number, fps: number): number => Math.min(40e6, Math.max(4e6, width * height * fps * 0.15))

/** Bytes of free space the import needs (§5.2). */
export function spaceNeeded(plan: Pick<ImportPlan, 'size' | 'fps' | 'duration'>, fileBytes: number): number {
  const body = plan.duration === null ? 2 * fileBytes : (proxyBitrate(plan.size.width, plan.size.height, plan.fps) / 8) * plan.duration * IMPORT_LIMITS.spaceFactor
  return Math.ceil(body + IMPORT_LIMITS.spaceMarginBytes)
}

export interface ImportPlan {
  /** Absolute index of the video stream used. */
  videoStream: number
  /** Absolute index of the sound used, or null for none. */
  audioStream: number | null
  /** Sound streams in the file. */
  audioTracks: number
  fps: 30 | 60
  /** The editing copy's size. */
  size: { width: number; height: number }
  /** Seconds, or null when the file does not say. */
  duration: number | null
  /** Filters before proxyArgs' scaling: deinterlace, tone-map. */
  preFilters: string[]
  hdr: boolean
  toneMapped: boolean
  notes: string[]
  /** What Project.source records (without the file's name, size and the time). */
  source: Omit<ImportedSource, 'fileName' | 'bytes' | 'importedAt'>
}

export type PlanResult = { ok: true; plan: ImportPlan } | { ok: false; error: string }

/** HDR to SDR BT.709 with zscale and tonemap (§2.5). */
export const TONE_MAP_FILTERS = ['zscale=t=linear:npl=100', 'format=gbrpf32le', 'zscale=p=bt709', 'tonemap=tonemap=hable:desat=0', 'zscale=t=bt709:m=bt709:r=tv', 'format=yuv420p']

/**
 * What to import from a probed file, or why it cannot be. `toneMap`: the bundled ffmpeg has the
 * zscale and tonemap filters.
 */
export function planImport(probe: ProbeInfo, ctx: { toneMap: boolean }): PlanResult {
  if (!probe.opened) return { ok: false, error: IMPORT_COPY.unreadable }
  if (probe.encrypted) return { ok: false, error: IMPORT_COPY.drm }
  const video = probe.streams.find((s) => s.type === 'video' && !s.attachedPic)
  const audios = probe.streams.filter((s) => s.type === 'audio')
  if (!video) return { ok: false, error: audios.length > 0 ? IMPORT_COPY.soundOnly : IMPORT_COPY.noVideo }
  if (video.codec === 'none') return { ok: false, error: IMPORT_COPY.codec(video.tag ?? 'unknown') }
  const w = video.width ?? 0
  const h = video.height ?? 0
  const L = IMPORT_LIMITS
  if (w < L.minSide || h < L.minSide || w > L.maxSide || h > L.maxSide) return { ok: false, error: IMPORT_COPY.size(w, h) }
  if (Math.max(w, h) / Math.min(w, h) > L.maxAspect) return { ok: false, error: IMPORT_COPY.narrow(w, h) }
  const duration = probe.duration
  if (duration !== null && duration < L.minSeconds) return { ok: false, error: IMPORT_COPY.tooShort }
  if (duration !== null && duration > L.maxSeconds) return { ok: false, error: IMPORT_COPY.tooLong }

  const display = displaySize(video)
  const size = proxySizeFor(display)
  const notes: string[] = []
  if (audios.length > 1) notes.push(IMPORT_COPY.noteTracks(audios.length))
  if (size.width < even(display.width) || size.height < even(display.height)) notes.push(IMPORT_COPY.noteScaled(size.width, size.height))
  const hdr = video.transfer !== null
  const preFilters: string[] = []
  if (video.interlaced) preFilters.push('yadif')
  // Square pixels first: proxyArgs' fit scales the stored pixels and ignores their aspect.
  // (after ffmpeg's autorotate, so the expression reads the upright frame and its aspect).
  if (video.sar && Math.abs(video.sar - 1) > 1e-3) preFilters.push('scale=w=trunc(iw*sar/2)*2:h=ih', 'setsar=1')
  if (hdr) {
    if (ctx.toneMap) preFilters.push(...TONE_MAP_FILTERS)
    notes.push(ctx.toneMap ? IMPORT_COPY.noteHdr : IMPORT_COPY.noteHdrPale)
  }
  const fps = proxyFpsFor(video.fps)
  const audio = audios[0] ?? null
  return {
    ok: true,
    plan: {
      videoStream: video.index,
      audioStream: audio ? audio.index : null,
      audioTracks: audios.length,
      fps,
      size,
      duration,
      preFilters,
      hdr,
      toneMapped: hdr && ctx.toneMap,
      notes,
      source: {
        kind: 'import',
        container: probe.container ?? 'unknown',
        videoCodec: video.codec,
        audioCodec: audio ? audio.codec : null,
        width: w,
        height: h,
        rotation: video.rotation,
        fps: video.fps,
        ...(hdr ? { hdr: ctx.toneMap } : {})
      }
    }
  }
}

/**
 * Seconds the editing copy is cut at: 4 hours when the file does not say how long it is, else
 * its stated length and 2 s more (at most 4 hours). The copy follows the packets' timestamps,
 * which a header can understate by any amount, and a constant rate fills every gap with frames.
 */
export const importCap = (duration: number | null): number =>
  duration === null ? IMPORT_LIMITS.maxSeconds : Math.min(IMPORT_LIMITS.maxSeconds, Math.ceil(duration) + 2)

/** Whether the 4-hour cap cut the copy: it reached the cap, and the file has more than it said. */
export const hitTimeCap = (duration: number | null, measured: number): boolean =>
  measured >= IMPORT_LIMITS.maxSeconds - 1 && (duration === null || measured > duration + 1)

/**
 * proxyArgs' arguments turned into the import's: the chosen streams mapped by index (never
 * `0:v:0`, which can be cover art), the plan's filters first, and the length cap (importCap).
 * Throws when proxyArgs' shape changed, so a test catches it.
 */
export function importArgs(base: readonly string[], plan: Pick<ImportPlan, 'videoStream' | 'audioStream' | 'preFilters' | 'duration'>): string[] {
  const args = [...base]
  const at = (flag: string, value: string): number => {
    for (let i = 0; i < args.length - 1; i++) if (args[i] === flag && args[i + 1] === value) return i
    return -1
  }
  const video = at('-map', '0:v:0')
  if (video < 0) throw new Error('proxyArgs no longer maps 0:v:0')
  args[video + 1] = `0:${plan.videoStream}`
  const audio = at('-map', '0:a:0?')
  if (plan.audioStream !== null) {
    if (audio < 0) throw new Error('proxyArgs no longer maps 0:a:0?')
    args[audio + 1] = `0:${plan.audioStream}`
  } else if (audio >= 0) {
    args.splice(audio, 2)
  }
  if (plan.preFilters.length > 0) {
    const vf = args.indexOf('-vf')
    if (vf < 0) throw new Error('proxyArgs no longer sets -vf')
    args[vf + 1] = [...plan.preFilters, args[vf + 1]].join(',')
  }
  args.splice(args.length - 1, 0, '-t', String(importCap(plan.duration)))
  return args
}

/** "About 3 min left" from the time spent and the share done; null while too early to tell (§4.5). */
export function etaText(elapsedSeconds: number, progress: number | null): string | null {
  if (progress === null || !(progress >= 0.03) || progress >= 1 || !(elapsedSeconds >= 5)) return null
  const left = (elapsedSeconds * (1 - progress)) / progress
  if (left < 60) return 'Less than a minute left'
  return `About ${Math.round(left / 60)} min left`
}
