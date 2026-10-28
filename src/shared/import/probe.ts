/**
 * Reads what `ffmpeg -hide_banner -i <file>` prints about a video file (the bundled ffmpeg has no
 * ffprobe): its container, length and streams. Pure, so it is unit-tested on real logs; lines it
 * does not know are ignored (docs/design/import-video.md §2.2).
 */

export type StreamType = 'video' | 'audio' | 'subtitle' | 'data' | 'attachment'

export interface ProbeStream {
  /** Absolute stream index in the file (`0:<index>` maps it). */
  index: number
  type: StreamType
  /** ffmpeg's codec name: 'h264', 'hevc', 'vp9', 'aac', … ('none' when ffmpeg does not know it). */
  codec: string
  /** The container's codec tag ('avc1', 'encv', …), when the log shows one. */
  tag: string | null
  /** Pixel format ('yuv420p10le'), video only. */
  pixFmt: string | null
  /** Colour transfer ('smpte2084', 'arib-std-b67'), when the log shows one. */
  transfer: string | null
  /** Interlaced picture (field order 'top first', 'bottom first', …). */
  interlaced: boolean
  width: number | null
  height: number | null
  /** Sample (pixel) aspect ratio; null when not shown (square pixels). */
  sar: number | null
  /** Average frame rate (the log's `fps`), else its `tbr`. */
  fps: number | null
  /** Cover art stored as a video stream. */
  attachedPic: boolean
  /** Display-matrix rotation as ffmpeg prints it, rounded to 0, 90, 180 or 270. */
  rotation: 0 | 90 | 180 | 270
}

export interface ProbeInfo {
  /** ffmpeg could open the file and printed its streams. */
  opened: boolean
  /** Container names, e.g. 'mov,mp4,m4a,3gp,3g2,mj2' or 'matroska,webm'. */
  container: string | null
  /** Seconds; null when the file does not say ('N/A'). */
  duration: number | null
  streams: ProbeStream[]
  /** A stream is encrypted (DRM): a protected codec tag, or ffmpeg said so. */
  encrypted: boolean
}

/** Codec tags of encrypted MP4 tracks (Common Encryption, FairPlay). */
const ENCRYPTED_TAGS: ReadonlySet<string> = new Set(['encv', 'enca', 'drms', 'drmi', 'drac', 'p608'])

const finite = (v: number): number | null => (Number.isFinite(v) ? v : null)

/** "29.97", "1k", "90k" → number. */
function rate(text: string, unit: string): number | null {
  const m = new RegExp(`^(\\d+(?:\\.\\d+)?)(k?) ${unit}$`).exec(text.trim())
  if (!m) return null
  const v = Number(m[1]) * (m[2] ? 1000 : 1)
  return v > 0 ? finite(v) : null
}

/** Splits "a (b, c), d(e, f), g" at top-level commas only. */
export function splitTopLevel(text: string): string[] {
  const out: string[] = []
  let depth = 0
  let current = ''
  for (const ch of text) {
    if (ch === '(' || ch === '[') depth++
    else if ((ch === ')' || ch === ']') && depth > 0) depth--
    if (ch === ',' && depth === 0) {
      out.push(current.trim())
      current = ''
    } else current += ch
  }
  if (current.trim()) out.push(current.trim())
  return out
}

const STREAM_RE = /^\s*Stream #0:(\d+)(?:\[[^\]]*\])?(?:\([^)]*\))?: (Video|Audio|Subtitle|Data|Attachment): (.*)$/
const DURATION_RE = /^\s*Duration: (?:N\/A|(\d+):(\d{2}):(\d{2}(?:\.\d+)?))/
const INPUT_RE = /^Input #0, (.+?), from '/
const ROTATION_RE = /displaymatrix: rotation of (-?\d+(?:\.\d+)?) degrees/
const TAG_RE = /\(([^()/]{1,16}) \/ 0x[0-9A-Fa-f]+\)/

function normalRotation(degrees: number): 0 | 90 | 180 | 270 {
  const r = (((Math.round(degrees / 90) * 90) % 360) + 360) % 360
  return r as 0 | 90 | 180 | 270
}

function parseVideo(stream: ProbeStream, parts: string[]): void {
  for (const part of parts.slice(1)) {
    const pix = /^([a-z0-9_]+)\((.*)\)$/.exec(part) ?? /^([a-z0-9_]+)$/.exec(part)
    if (stream.pixFmt === null && pix && !/^\d/.test(part)) {
      stream.pixFmt = pix[1]
      const inside = pix[2] ?? ''
      for (const bit of inside.split(/[,/]/).map((b) => b.trim())) {
        if (bit === 'smpte2084' || bit === 'arib-std-b67') stream.transfer = bit
        if (/^(top first|bottom first|top coded first.*|bottom coded first.*|interlaced)$/.test(bit)) stream.interlaced = true
      }
      continue
    }
    const size = /^(\d{1,6})x(\d{1,6})(?:\s*\[SAR (\d+):(\d+) DAR \d+:\d+\])?/.exec(part)
    if (size && stream.width === null) {
      stream.width = Number(size[1])
      stream.height = Number(size[2])
      if (size[3] && size[4] && Number(size[4]) > 0) stream.sar = finite(Number(size[3]) / Number(size[4]))
      continue
    }
    const sar = /^SAR (\d+):(\d+) DAR \d+:\d+$/.exec(part)
    if (sar && Number(sar[2]) > 0) {
      stream.sar = finite(Number(sar[1]) / Number(sar[2]))
      continue
    }
    const fps = rate(part, 'fps')
    if (fps !== null) {
      stream.fps = fps
      continue
    }
    const tbr = rate(part, 'tbr')
    if (tbr !== null && stream.fps === null) stream.fps = tbr
  }
  // A SAR of 0:1 means "unknown": square pixels.
  if (stream.sar !== null && !(stream.sar > 0)) stream.sar = null
}

/** Parses ffmpeg's description of input #0 (stderr of `ffmpeg -hide_banner -i <file>`). */
export function parseProbe(log: string): ProbeInfo {
  const info: ProbeInfo = { opened: false, container: null, duration: null, streams: [], encrypted: false }
  let current: ProbeStream | null = null
  for (const line of log.split(/\r?\n/)) {
    // Only input #0 is described; an output section (none is asked for) would end it.
    if (/^(Input #[1-9]|Output #)/.test(line)) break
    const input = INPUT_RE.exec(line)
    if (input) {
      info.opened = true
      info.container = input[1]
      continue
    }
    const duration = DURATION_RE.exec(line)
    if (duration) {
      if (duration[1] !== undefined) {
        const seconds = Number(duration[1]) * 3600 + Number(duration[2]) * 60 + Number(duration[3])
        info.duration = Number.isFinite(seconds) ? seconds : null
      }
      continue
    }
    const s = STREAM_RE.exec(line)
    if (s) {
      const details = s[3]
      const parts = splitTopLevel(details)
      const tag = TAG_RE.exec(parts[0] ?? '')
      current = {
        index: Number(s[1]),
        type: s[2].toLowerCase() as StreamType,
        codec: /^([^\s,(]+)/.exec(details)?.[1] ?? 'none',
        tag: tag ? tag[1].trim() : null,
        pixFmt: null,
        transfer: null,
        interlaced: false,
        width: null,
        height: null,
        sar: null,
        fps: null,
        attachedPic: /\(attached pic\)/.test(details),
        rotation: 0
      }
      if (current.type === 'video') parseVideo(current, parts)
      if (current.tag && ENCRYPTED_TAGS.has(current.tag.toLowerCase())) info.encrypted = true
      info.streams.push(current)
      continue
    }
    const rotation = ROTATION_RE.exec(line)
    if (rotation && current) {
      current.rotation = normalRotation(Number(rotation[1]))
      continue
    }
    // Messages of ffmpeg's components ("[mov,mp4,…] … encryption …"), never metadata or the file name.
    if (/^\[[^\]]+\][^\n]*\b(encrypt\w*|decryption key|protection scheme)/i.test(line)) info.encrypted = true
  }
  return info
}
