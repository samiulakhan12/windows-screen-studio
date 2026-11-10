/**
 * CMX 3600 EDLs (docs/design/output-and-languages.md §8.5): the finished video for editors that read
 * EDL, and Resolve's chapter markers. Pure. Lines end in CRLF.
 *
 * - Written for "This export" only: one AA/V event with reel AX, record and source timecodes at the
 *   timeline's rate (a 120 fps export's source timecode at 60, exactly half its frames), and the
 *   comments Resolve and Premiere link media with. An EDL cannot name the stems, so its event takes
 *   the video with its own sound.
 * - `TITLE:` and marker names are printable ASCII (asciiName); a chapter with no ASCII letter is
 *   "Chapter {n}" here only, while FCPXML and xmeml keep it whole.
 */
import { asciiName } from './fileUrl'
import type { TimelineMedia, TimelinePlan } from './timelinePlan'

/** Most events an EDL holds. */
export const EDL_EVENT_LIMIT = 999

const CRLF = '\r\n'
/** CMX 3600 titles are at most 70 characters. */
const TITLE_MAX = 70

/** HH:MM:SS:FF of `frames` at a whole `fps`, non-drop frame. */
function timecode(frames: number, fps: number): string {
  const two = (v: number): string => String(v).padStart(2, '0')
  const ff = frames % fps
  const s = Math.floor(frames / fps)
  return `${two(Math.floor(s / 3600))}:${two(Math.floor(s / 60) % 60)}:${two(s % 60)}:${two(ff)}`
}

/** A file name or path for a comment line: everything but line breaks and other control characters kept. */
const commentText = (s: string): string => s.replace(/[\u0000-\u001f\u007f-\u009f\u2028\u2029]/g, '')
const baseName = (path: string): string => path.split(/[\\/]/).pop() ?? path
const title = (name: string, suffix = ''): string => `TITLE: ${(asciiName(name, 'Flown timeline') + suffix).slice(0, TITLE_MAX)}`

/** The event line: number, reel, track, a cut, then source in and out, record in and out. */
const eventLine = (n: number, reel: string, track: string, tc: readonly string[]): string => `${String(n).padStart(3, '0')}  ${reel.padEnd(8)} ${track.padEnd(5)} C        ${tc.join(' ')}`

/**
 * The EDL of `plan` (This export only): the first video track's events, one AA/V event each, the
 * file's name and path as comments. Refuses a plan of more than EDL_EVENT_LIMIT events.
 */
export function edl(plan: TimelinePlan, paths: Partial<Record<TimelineMedia, string>>): string {
  const fps = plan.fps
  const events = plan.tracks.find((t) => t.kind === 'video')?.events ?? []
  if (events.length > EDL_EVENT_LIMIT) throw new Error(`An EDL holds at most ${EDL_EVENT_LIMIT} events`)
  const lines = [title(plan.name), 'FCM: NON-DROP FRAME', '']
  events.forEach((e, i) => {
    const path = paths[e.media]
    const source = plan.media[e.media]
    if (!path || !source) throw new Error(`No file for ${e.media}`)
    // Source frames at the timeline's rate: a 120 fps video's frames are halved, a normal-speed event keeps its length.
    const srcIn = Math.round((e.srcIn * fps) / source.fps)
    const srcOut = e.speed === 1 ? srcIn + (e.recOut - e.recIn) : Math.round((e.srcOut * fps) / source.fps)
    lines.push(eventLine(i + 1, 'AX', 'AA/V', [timecode(srcIn, fps), timecode(srcOut, fps), timecode(e.recIn, fps), timecode(e.recOut, fps)]))
    if (e.speed !== 1) lines.push(`M2   ${'AX'.padEnd(8)} ${(fps * e.speed).toFixed(1).padStart(5, '0')}${' '.repeat(16)}${timecode(srcIn, fps)}`)
    lines.push(`* FROM CLIP NAME: ${commentText(baseName(path))}`, `* SOURCE FILE: ${commentText(path)}`, '')
  })
  return lines.join(CRLF)
}

/**
 * Resolve's markers EDL (Timelines › Import › Timeline Markers from EDL): one one-frame event per
 * chapter with its blue marker line, or null when the video has no chapters. Never written for other
 * editors, which would read it as a sequence of one-frame events.
 */
export function markerEdl(plan: TimelinePlan): string | null {
  const chapters = plan.markers.filter((m) => m.chapter)
  if (!chapters.length) return null
  const fps = plan.fps
  const lines = [title(plan.name, ' markers'), 'FCM: NON-DROP FRAME', '']
  chapters.forEach((m, i) => {
    const tc = [timecode(m.frame, fps), timecode(m.frame + 1, fps)]
    const name = asciiName(m.name, `Chapter ${i + 1}`).replace(/\|/g, '/')
    lines.push(eventLine(i + 1, '001', 'V', [...tc, ...tc]), ` |C:ResolveColorBlue |M:${name} |D:1`)
  })
  lines.push('')
  return lines.join(CRLF)
}
