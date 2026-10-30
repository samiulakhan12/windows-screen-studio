/**
 * Speaker labels on captions (NW-09, docs/design/transcription.md §6): a name on each caption
 * ("You", "Speaker 2", "Priya"), renamed everywhere at once, and "You" / "Others" told apart from
 * the levels of a recording's microphone and computer-sound tracks with no AI. Pure.
 */
import { activityThreshold } from '../audio/activity'
import { powerDb, type AudioLevels } from '../audio/loudness'
import type { CaptionSegment } from '../types'

/** Longest speaker name, in characters. */
export const SPEAKER_NAME_MAX = 32
/** The labels the sound tracks give. */
export const STEM_SPEAKERS = { mic: 'You', system: 'Others' } as const
/** Fewest windows (50 ms each) with sound for a caption to be labelled from the tracks. */
const MIN_WINDOWS = 3

/** A speaker name as stored and shown: one line, single spaces, trimmed, at most SPEAKER_NAME_MAX characters; '' when none. */
export function cleanSpeakerName(raw: unknown): string {
  if (typeof raw !== 'string') return ''
  return [...raw.replace(/[\u0000-\u001f\u007f\u2028\u2029]+/g, ' ').replace(/\s+/g, ' ').trim()].slice(0, SPEAKER_NAME_MAX).join('').trim()
}

/** The speakers of `segments` in order of first appearance, with how many captions each has. */
export function speakersOf(segments: readonly CaptionSegment[]): { name: string; count: number }[] {
  const counts = new Map<string, number>()
  for (const s of segments) if (s.speaker) counts.set(s.speaker, (counts.get(s.speaker) ?? 0) + 1)
  return [...counts].map(([name, count]) => ({ name, count }))
}

/** `seg` with `name` as its speaker ('' removes it); the same object when nothing changes. */
function withSpeaker(seg: CaptionSegment, name: string): CaptionSegment {
  if ((seg.speaker ?? '') === name) return seg
  if (!name) {
    const { speaker: _gone, ...rest } = seg
    return rest
  }
  return { ...seg, speaker: name }
}

/**
 * Every caption of speaker `from` renamed to `to` (cleaned; '' removes the label). Null when
 * nothing changes. A name already used by another speaker merges the two.
 */
export function renameSpeaker(segments: readonly CaptionSegment[], from: string, to: string): CaptionSegment[] | null {
  const name = cleanSpeakerName(to)
  if (!from || name === from || !segments.some((s) => s.speaker === from)) return null
  return segments.map((s) => (s.speaker === from ? withSpeaker(s, name) : s))
}

/** Caption `id` with speaker `name` ('' removes it); null when nothing changes. */
export function setSpeaker(segments: readonly CaptionSegment[], id: string, name: string): CaptionSegment[] | null {
  const clean = cleanSpeakerName(name)
  const i = segments.findIndex((s) => s.id === id)
  if (i < 0 || (segments[i].speaker ?? '') === clean) return null
  return segments.map((s, k) => (k === i ? withSpeaker(s, clean) : s))
}

/** Every label removed; null when there is none. */
export function clearSpeakers(segments: readonly CaptionSegment[]): CaptionSegment[] | null {
  if (!segments.some((s) => s.speaker)) return null
  return segments.map((s) => withSpeaker(s, ''))
}

/** The first "Speaker N" not used yet. */
export function nextSpeakerName(segments: readonly CaptionSegment[]): string {
  const used = new Set(segments.map((s) => s.speaker).filter(Boolean))
  let n = 1
  while (used.has(`Speaker ${n}`)) n++
  return `Speaker ${n}`
}

/** Labels removed when fewer than two speakers are left (one voice needs no label). */
export function dropLoneSpeaker<T extends { speaker?: string }>(segments: readonly T[]): T[] {
  const names = new Set(segments.map((s) => s.speaker).filter(Boolean))
  if (names.size >= 2) return [...segments]
  return segments.map((s) => {
    if (!s.speaker) return s
    const { speaker: _gone, ...rest } = s
    return rest as T
  })
}

/** Windows of `levels` above its activity threshold, as dB above it (-Infinity below). */
function above(levels: AudioLevels): (i: number) => number {
  const threshold = activityThreshold(levels)
  return (i) => {
    const p = levels.power[i]
    if (p === undefined) return -Infinity
    const over = powerDb(p) - threshold
    return over >= 0 ? over : -Infinity
  }
}

/** Whether source time `t` is inside one of the speech ranges (sorted). */
function inSpeech(speech: readonly { start: number; end: number }[], t: number): boolean {
  let lo = 0
  let hi = speech.length - 1
  while (lo <= hi) {
    const mid = (lo + hi) >> 1
    if (speech[mid].end <= t) lo = mid + 1
    else if (speech[mid].start > t) hi = mid - 1
    else return true
  }
  return false
}

/**
 * Captions labelled "You" (the microphone) or "Others" (the computer sound) from the two tracks'
 * levels over each caption's time (docs/design/transcription.md §6.1): a window counts for the
 * track above its own activity threshold (the microphone also inside its detected speech), the
 * one further above it when both are; a caption with at least MIN_WINDOWS such windows goes to
 * the track with more of them (the microphone on a tie); one without keeps no label. Every other
 * label is replaced. Also how many captions each got.
 */
export function stemSpeakers(segments: readonly CaptionSegment[], mic: AudioLevels, system: AudioLevels): { segments: CaptionSegment[]; you: number; others: number } {
  const micOver = above(mic)
  const sysOver = above(system)
  const speech = mic.speech ? [...mic.speech].sort((a, b) => a.start - b.start) : null
  const window = mic.window
  let you = 0
  let others = 0
  const out = segments.map((s) => {
    let m = 0
    let y = 0
    const from = Math.max(0, Math.floor(s.start / window))
    const to = Math.ceil(s.end / window)
    for (let i = from; i < to; i++) {
      let a = micOver(i)
      if (speech && a > -Infinity && !inSpeech(speech, (i + 0.5) * window)) a = -Infinity
      const b = sysOver(Math.floor(((i + 0.5) * window) / system.window))
      if (a === -Infinity && b === -Infinity) continue
      if (a >= b) m++
      else y++
    }
    if (m + y < MIN_WINDOWS) return withSpeaker(s, '')
    const name = m >= y ? STEM_SPEAKERS.mic : STEM_SPEAKERS.system
    if (name === STEM_SPEAKERS.mic) you++
    else others++
    return withSpeaker(s, name)
  })
  return { segments: out, you, others }
}

/**
 * The caption as drawn with its speaker's name first ("Priya: Hello"), for the burned-in captions
 * with Show speaker names on: the name is one more word, timed at the caption's start, so karaoke
 * never lights it. The caption itself without a speaker.
 */
export function speakerCaption(seg: CaptionSegment): CaptionSegment {
  if (!seg.speaker || !seg.text.trim()) return seg
  const name = `${seg.speaker}:`
  const words = seg.text.split(/\s+/).filter(Boolean)
  const timed = seg.words && seg.words.length === words.length ? [{ text: name, start: seg.start, end: seg.start }, ...seg.words] : undefined
  const { words: _old, ...rest } = seg
  return { ...rest, text: `${name} ${seg.text}`, ...(timed ? { words: timed } : {}) }
}

/** What the Speakers section and the options say (docs/design/transcription.md §7). */
export const SPEAKER_COPY = {
  title: 'Speakers',
  labelStems: 'Label You and Others',
  labelStemsTitle: 'Who speaks in each caption, from the microphone and computer sound tracks',
  replaceQuestion: 'Replace the speaker labels with You and Others from the sound tracks?',
  remove: 'Remove labels',
  none: 'Speaker labels come from Gemini, or from recordings that kept the microphone and the computer sound apart.',
  mixedHint: 'For calls, transcribe the Mixed sound so the other people’s words are captioned too.',
  nameLabel: (name: string): string => `Name of ${name}`,
  count: (n: number): string => `${n} ${n === 1 ? 'caption' : 'captions'}`,
  labelled: (you: number, others: number): string => `Labelled ${you + others} ${you + others === 1 ? 'caption' : 'captions'}: ${you} You, ${others} Others.`,
  nothingHeard: 'No caption had enough sound on either track to tell who speaks.',
  levelsFailed: 'The sound tracks could not be measured, so no labels were added.',
  renamed: (from: string, to: string): string => (to ? `Renamed ${from} to ${to} (Undo brings the old name back)` : `Removed the label ${from}`),
  removed: 'Speaker labels removed (Undo brings them back)',
  noSpeaker: 'No speaker',
  newSpeaker: (name: string): string => `New speaker (${name})`,
  selectLabel: (at: string): string => `Speaker of the caption at ${at}`,
  showOnVideo: 'Show speaker names',
  showOnVideoTitle: 'Put the speaker’s name before each caption on the video',
  inFiles: 'Speaker names in SRT and text',
  inFilesTitle: 'Start each caption with the speaker’s name, like “Priya: Hello”. WebVTT files always name the speaker.'
} as const
