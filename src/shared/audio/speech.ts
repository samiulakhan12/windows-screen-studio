/**
 * When the person talks, for the camera director (docs/design/camera-director.md, step 4): from
 * the level envelope of the microphone stem (or the mixed track when the recording kept no stems),
 * with keyboard and mouse noise removed, sentence pauses joined and blips dropped; optionally
 * refined by the transcript's word timings. Source seconds throughout. Pure.
 */
import type { CursorTrack, Project, Transcript } from '../types'
import { detectActivity, mergeRanges, type Range } from './activity'
import type { AudioLevels } from './loudness'
import { stemsOf } from './settings'

/**
 * Speech from levels: sound found by detectActivity (ACTIVITY unchanged); a range at least
 * `noiseShare` inside recorded input (typing bursts padded by `typingPad`, clicks by `clickPad`,
 * keys by `keyPad`) is keyboard or mouse noise and dropped; ranges closer than `join` s are one;
 * shorter than `minUtterance` s are dropped. Transcript words closer than `transcriptGap` s are
 * one range; sound with no word within `transcriptPad` s is not speech. Less than `minTotal` s of
 * speech in all is no talking.
 */
export const SPEECH = {
  noiseShare: 0.8,
  typingPad: 0.3,
  clickPad: 0.15,
  keyPad: 0.15,
  join: 1.0,
  minUtterance: 0.6,
  transcriptGap: 0.3,
  transcriptPad: 0.5,
  minTotal: 2.0
} as const

/** Where the speech ranges came from: the microphone stem, the mixed track, or the transcript alone. */
export type SpeechSource = 'mic' | 'mix' | 'transcript'

/** When the person talks, as the director uses it. */
export interface DirectorSpeech {
  /** Source seconds, sorted, separate. */
  ranges: Range[]
  source: SpeechSource
  /** True when the transcript's words removed sound of the mixed track that was not speech. */
  refined: boolean
  /**
   * What found the speech in the levels: 'speech' the bundled speech detector, 'level' the sound
   * level (today's rule). Absent when the speech came from the transcript alone.
   */
  detector?: 'speech' | 'level'
}

/**
 * The recorded sound the director listens to: the microphone stem when the recording kept one
 * (stemsOf); none when it kept stems without one (stems are a complete set, so no microphone was
 * recorded and the mixed track is PC sound only); else, without stems, the mixed track when it has
 * sound, else none. The edit's mute and volume are ignored on purpose: a muted microphone still
 * tells when the person talks.
 */
export function speechLevelSource(project: Pick<Project, 'hasAudio' | 'audioStems'>): 'mic' | 'mix' | null {
  const stems = stemsOf(project)
  if (stems.includes('mic')) return 'mic'
  if (stems.length > 0) return null
  return project.hasAudio ? 'mix' : null
}

/**
 * Speech ranges (source seconds) from a level envelope. With `levels.speech` (the speech
 * detector ran): those ranges joined across SPEECH.join and at least SPEECH.minUtterance long.
 * Otherwise: activity, minus keyboard and mouse noise
 * (`track`'s typing bursts, clicks and keys; none when `track` is null or not valid), joined
 * and filtered (SPEECH).
 */
export function speechFromLevels(levels: AudioLevels, track: CursorTrack | null): Range[] {
  // The speech detector heard the voice itself: typing under it is still talking, so no input
  // noise is taken out, and no trust guard (a microphone with typing and no voice means no talking).
  if (levels.speech) return mergeRanges(levels.speech, SPEECH.join).filter((r) => r.end - r.start >= SPEECH.minUtterance)
  const noise = track?.valid ? inputNoise(track) : []
  const heard = detectActivity(levels).filter((r) => covered(r, noise) < SPEECH.noiseShare * (r.end - r.start))
  return mergeRanges(heard, SPEECH.join).filter((r) => r.end - r.start >= SPEECH.minUtterance)
}

/**
 * Speech ranges (source seconds) from a transcript: its words (a caption without word timings
 * counts whole), joined across SPEECH.transcriptGap; null without a transcript or captions.
 */
export function transcriptSpeech(transcript: Pick<Transcript, 'segments'> | undefined): Range[] | null {
  const segments = transcript?.segments ?? []
  const said: Range[] = []
  for (const seg of segments) {
    const words = (seg.words ?? []).filter((w) => timed(w.start, w.end))
    if (words.length > 0) for (const w of words) said.push({ start: w.start, end: w.end })
    else if (timed(seg.start, seg.end)) said.push({ start: seg.start, end: seg.end })
  }
  return said.length > 0 ? mergeRanges(said, SPEECH.transcriptGap) : null
}

/**
 * The speech the director uses. With levels of the mixed track and a transcript: the sound near
 * words only (levels within SPEECH.transcriptPad of a word), `refined`. With the microphone
 * stem the levels are used as they are (a clean source; a transcript edited by hand could only
 * remove real speech). Without levels: the transcript alone, joined across SPEECH.join. Null
 * when neither is known.
 */
export function refineSpeech(
  levels: { source: 'mic' | 'mix'; ranges: readonly Range[]; detector?: 'speech' | 'level' } | null,
  transcript: Pick<Transcript, 'segments'> | undefined
): DirectorSpeech | null {
  const words = transcriptSpeech(transcript)
  if (!levels) return words ? { ranges: mergeRanges(words, SPEECH.join), source: 'transcript', refined: false } : null
  const ranges = mergeRanges(levels.ranges)
  const detector = levels.detector ? { detector: levels.detector } : {}
  if (levels.source === 'mic' || !words) return { ranges, source: levels.source, refined: false, ...detector }
  const near = mergeRanges(words.map((w) => ({ start: w.start - SPEECH.transcriptPad, end: w.end + SPEECH.transcriptPad })))
  return { ranges: intersect(ranges, near), source: 'mix', refined: true, ...detector }
}

/** Times (source seconds, sorted, separate) when typing, clicking or a shortcut makes noise. */
function inputNoise(track: CursorTrack): Range[] {
  const noise: Range[] = []
  for (const b of track.typing ?? []) if (timed(b.t, b.end, true)) noise.push({ start: b.t - SPEECH.typingPad, end: b.end + SPEECH.typingPad })
  for (const c of track.clicks) if (Number.isFinite(c.t)) noise.push({ start: c.t - SPEECH.clickPad, end: c.t + SPEECH.clickPad })
  for (const k of track.keys ?? []) if (Number.isFinite(k.t)) noise.push({ start: k.t - SPEECH.keyPad, end: k.t + SPEECH.keyPad })
  return mergeRanges(noise)
}

/** Seconds of `r` inside sorted, separate `ranges`. */
function covered(r: Range, ranges: readonly Range[]): number {
  let sum = 0
  for (const x of ranges) {
    if (x.start >= r.end) break
    sum += Math.max(0, Math.min(r.end, x.end) - Math.max(r.start, x.start))
  }
  return sum
}

/** The parts of sorted, separate `a` inside sorted, separate `b`. */
function intersect(a: readonly Range[], b: readonly Range[]): Range[] {
  const out: Range[] = []
  let j = 0
  for (const r of a) {
    while (j < b.length && b[j].end <= r.start) j++
    for (let k = j; k < b.length && b[k].start < r.end; k++) {
      const s = Math.max(r.start, b[k].start)
      const e = Math.min(r.end, b[k].end)
      if (e > s) out.push({ start: s, end: e })
    }
  }
  return out
}

/** A finite time span (one that may be empty when `instant`). */
function timed(start: number, end: number, instant = false): boolean {
  return Number.isFinite(start) && Number.isFinite(end) && (instant ? end >= start : end > start)
}
