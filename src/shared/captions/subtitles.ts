/**
 * Subtitle files of the captions, in the exported video's time: SRT, WebVTT and plain text.
 * Captions live in source time; here they go through the clips (as the export does): captions in
 * a cut are dropped, a caption across a cut keeps only what shows (and the words that were
 * spoken there, as the Transcript tab shows them), and each piece is scaled by its clip's speed. Pure.
 */
import { editToVideo, NO_FREEZES, type FreezePlan } from '../engine/freeze'
import { captionsWords, cutFlags, MIN_CUE } from '../editor/transcript'
import type { CaptionSegment, Clip } from '../types'

export type SubtitleFormat = 'srt' | 'vtt' | 'txt'

export const SUBTITLE_FORMATS: { value: SubtitleFormat; label: string; title: string }[] = [
  { value: 'srt', label: 'SRT', title: 'SubRip subtitles: YouTube, Vimeo, most video players and editors' },
  { value: 'vtt', label: 'VTT', title: 'WebVTT subtitles: web video players' },
  { value: 'txt', label: 'Text', title: 'The transcript as plain text' }
]

/** A caption in output time (seconds of the exported video). */
export interface Cue {
  start: number
  end: number
  text: string
  /** Who speaks (docs/design/transcription.md §8): a WebVTT voice tag, or "Name: " in SRT and text when asked. */
  speaker?: string
}

/** How the subtitle files are written. */
export interface SubtitleOptions {
  /** SRT and text: each caption starts with its speaker's name ("Priya: Hello"). WebVTT always names the speaker. */
  speakerNames?: boolean
}

/** Output time of source time `s` inside clip `i` that starts at output time `at`. */
const outOf = (c: Clip, at: number, s: number): number => at + (s - c.start) / c.speed

/**
 * The captions as they play in the exported video: each one's kept part from its first to its
 * last shown moment (the clips around a cut play back to back, so it stays one cue), scaled by
 * the speed. Its words are the Transcript tab's (captionsWords), and the words the tab strikes
 * through are left out: cutFlags, one rule for both (docs/design/edit-by-text.md §4.2: a heard or
 * deleted word by its middle, any other guess only when surely cut, every word of a caption kept
 * for less than MIN_CUE, the shortest cue kept).
 * Empty captions (one emptied and brought back by Undo) are left out.
 */
export function outputCues(segments: readonly CaptionSegment[], clips: readonly Clip[]): Cue[] {
  const cues: Cue[] = []
  // Output start of every clip.
  const starts: number[] = []
  let acc = 0
  for (const c of clips) {
    starts.push(acc)
    acc += (c.end - c.start) / c.speed
  }
  const words = captionsWords(segments)
  const cut = cutFlags(words, clips)
  let at = 0
  for (const seg of segments) {
    // The caption's words are words[from..at) (as many as alignCaptionWords gives it).
    const from = at
    at += seg.text.split(' ').filter(Boolean).length
    if (!seg.text.trim()) continue
    let first: number | null = null
    let last: number | null = null
    for (let i = 0; i < clips.length; i++) {
      const c = clips[i]
      const a = Math.max(seg.start, c.start)
      const b = Math.min(seg.end, c.end)
      if (b - a <= 1e-9) continue
      first ??= outOf(c, starts[i], a)
      last = outOf(c, starts[i], b)
    }
    if (first === null || last === null || last - first < MIN_CUE) continue
    const text = words
      .slice(from, at)
      .filter((_, k) => !cut[from + k])
      .map((w) => w.text)
      .join(' ')
    if (!text) continue
    cues.push({ start: first, end: last, text, ...(seg.speaker ? { speaker: seg.speaker } : {}) })
  }
  // Rounded later to milliseconds: never overlapping.
  for (let i = 1; i < cues.length; i++) if (cues[i].start < cues[i - 1].end) cues[i - 1].end = cues[i].start
  return cues.filter((c) => c.end - c.start >= MIN_CUE - 1e-9)
}

/** "HH:MM:SS,mmm" (SRT) or "HH:MM:SS.mmm" (VTT) of whole milliseconds. */
export function formatTimestamp(ms: number, sep: ',' | '.'): string {
  const v = Math.max(0, Math.round(ms))
  const h = Math.floor(v / 3600000)
  const m = Math.floor((v % 3600000) / 60000)
  const s = Math.floor((v % 60000) / 1000)
  const pad = (n: number, k = 2): string => String(n).padStart(k, '0')
  return `${pad(h)}:${pad(m)}:${pad(s)}${sep}${pad(v % 1000, 3)}`
}

/** Longest subtitle line, in characters (the usual guideline is 42). */
export const SUBTITLE_LINE = 42

/** `text` broken into lines of at most SUBTITLE_LINE characters where it can be (words are never split). */
export function subtitleLines(text: string, max = SUBTITLE_LINE): string[] {
  const out: string[] = []
  let line = ''
  for (const word of text.split(/\s+/).filter(Boolean)) {
    if (line && line.length + 1 + word.length > max) {
      out.push(line)
      line = word
    } else line = line ? `${line} ${word}` : word
  }
  if (line) out.push(line)
  return out
}

/** Cues with times in whole milliseconds, each at least 1 ms long and never before the one before. */
function msCues(cues: readonly Cue[]): { start: number; end: number; text: string; speaker?: string }[] {
  const out: { start: number; end: number; text: string; speaker?: string }[] = []
  for (const c of cues) {
    const prev = out.length ? out[out.length - 1].end : 0
    const start = Math.max(prev, Math.round(c.start * 1000))
    const end = Math.round(c.end * 1000)
    if (end > start) out.push({ start, end, text: c.text, ...(c.speaker ? { speaker: c.speaker } : {}) })
  }
  return out
}

/** A cue's text with its speaker's name first when `names` is on ("Priya: Hello"). */
const named = (c: Pick<Cue, 'text' | 'speaker'>, names: boolean | undefined): string => (names && c.speaker ? `${c.speaker}: ${c.text}` : c.text)

/** "-->" would end a cue's timing line early in either format. */
const safeText = (s: string): string => s.replace(/-->/g, '->')

export function toSrt(cues: readonly Cue[], options: SubtitleOptions = {}): string {
  return msCues(cues)
    .map((c, i) => `${i + 1}\n${formatTimestamp(c.start, ',')} --> ${formatTimestamp(c.end, ',')}\n${subtitleLines(safeText(named(c, options.speakerNames))).join('\n')}\n`)
    .join('\n')
}

const escapeVtt = (s: string): string => safeText(s).replace(/&/g, '&amp;').replace(/</g, '&lt;').replace(/>/g, '&gt;')

export function toVtt(cues: readonly Cue[]): string {
  // A speaker is a voice tag on the cue: <v Priya>Hello (the name escaped like the text).
  const body = msCues(cues).map((c) => `${formatTimestamp(c.start, '.')} --> ${formatTimestamp(c.end, '.')}\n${c.speaker ? `<v ${escapeVtt(c.speaker)}>` : ''}${subtitleLines(escapeVtt(c.text)).join('\n')}\n`)
  return ['WEBVTT\n', ...body].join('\n')
}

/** The transcript as plain text: one caption per line. */
export function toPlainText(cues: readonly Cue[], options: SubtitleOptions = {}): string {
  return cues.map((c) => named(c, options.speakerNames)).join('\n') + (cues.length ? '\n' : '')
}

/**
 * The subtitle file of `segments` in the exported video's time, as `format`: past the pause freezes
 * of `plan` (a caption across one stretches over it, one starting exactly at it shows through it).
 */
export function subtitleFile(segments: readonly CaptionSegment[], clips: readonly Clip[], format: SubtitleFormat, plan: FreezePlan = NO_FREEZES, options: SubtitleOptions = {}): string {
  const edited = outputCues(segments, clips)
  const cues = plan.holds.length ? edited.map((c) => ({ ...c, start: editToVideo(plan, c.start), end: editToVideo(plan, c.end) })) : edited
  return format === 'srt' ? toSrt(cues, options) : format === 'vtt' ? toVtt(cues) : toPlainText(cues, options)
}

/** Largest subtitle file accepted, in characters (5000 captions are well under 2 MB). */
export const MAX_SUBTITLE_CHARS = 8 * 1024 * 1024

/**
 * Whether `content` can be a subtitle file of `format` written by subtitleFile: a string of
 * bounded size without NUL characters, a VTT starting with its header, an SRT made of numbered
 * cues. Checked again in the main process before anything is written.
 */
export function validSubtitle(format: unknown, content: unknown): format is SubtitleFormat {
  if (format !== 'srt' && format !== 'vtt' && format !== 'txt') return false
  if (typeof content !== 'string' || content.length > MAX_SUBTITLE_CHARS || content.includes('\u0000')) return false
  if (format === 'vtt') return content.startsWith('WEBVTT\n')
  if (format === 'srt') return content === '' || /^1\n\d\d:\d\d:\d\d,\d\d\d --> \d\d:\d\d:\d\d,\d\d\d\n/.test(content)
  return true
}
