/**
 * The unwanted-sound finder (F-17, docs/design/sound-finder.md): the sound kinds it lists, the
 * YAMNet classes behind each, and the pure rules that turn YAMNet's scores per window into rows
 * (findSounds). The worker only scores windows (soundsScan.ts); everything that decides what is
 * listed lives here, so the rules can change without listening to the recording again.
 */
import { mergeRanges, type Range } from './activity'
import type { AudioLevels } from './loudness'
import { stemsOf, type AudioSource } from './settings'
import type { Project } from '../types'

/** What the finder lists. */
export type SoundKind = 'cough' | 'sneeze' | 'typing' | 'ping' | 'phone' | 'dog' | 'door' | 'music'

export interface SoundKindSpec {
  /** Indices into YAMNet's 521 classes (the label list packed in the model): the kind's score is the highest of them. */
  classes: readonly number[]
  /** Lowest score (0..1) of a window that counts. */
  threshold: number
  /** Shortest stretch (seconds) listed, after the speech guard. */
  minLength: number
  /** Whether the stretch is fitted to the sound's levels (a cough is a fraction of its windows). */
  fit: boolean
}

export const SOUND_KINDS: Readonly<Record<SoundKind, SoundKindSpec>> = {
  cough: { classes: [42, 43], threshold: 0.35, minLength: 0.1, fit: true },
  sneeze: { classes: [44], threshold: 0.35, minLength: 0.1, fit: true },
  typing: { classes: [378, 379, 380], threshold: 0.35, minLength: 0.3, fit: true },
  ping: { classes: [195, 200, 475, 476, 477], threshold: 0.35, minLength: 0.1, fit: true },
  phone: { classes: [125, 383, 384, 385, 517], threshold: 0.35, minLength: 0.2, fit: true },
  dog: { classes: [69, 70, 71, 72, 73, 74, 75], threshold: 0.35, minLength: 0.1, fit: true },
  door: { classes: [348, 349, 350, 352, 353], threshold: 0.35, minLength: 0.1, fit: true },
  music: { classes: [132], threshold: 0.5, minLength: 3, fit: false }
}

/** The kinds in the order of a window's score bytes (after the speech column). */
export const SOUND_KIND_ORDER: readonly SoundKind[] = ['cough', 'sneeze', 'typing', 'ping', 'phone', 'dog', 'door', 'music']

/** YAMNet's speech classes: Speech, Child speech, Conversation, Narration, Speech synthesizer. */
export const SPEECH_CLASSES: readonly number[] = [0, 1, 2, 3, 5]

/** The columns of a window's scores: speech first, then SOUND_KIND_ORDER. */
export const SCORE_COLUMNS: readonly string[] = ['speech', ...SOUND_KIND_ORDER]

/** The bundled model (resources/sounds/yamnet.tflite, MODEL.md): its pin, checked by a unit test. */
export const SOUND_MODEL = {
  file: 'yamnet.tflite',
  bytes: 4126810,
  sha256: '4d8b4a53282dc83ef04e3e7dbc4fbc98082e34e44ed798e16c3a0cdd4c584faf',
  classes: 521
} as const

/**
 * How the recording is listened to. YAMNet takes 0.975 s windows of 16 kHz sound; they start every
 * half window, so a sound up to half a second long lies wholly inside one of them.
 */
export const SCAN = {
  rate: 16000,
  window: 15600,
  hop: 7800,
  /** A last window is classified (padded with silence) when at least this many samples come after the last whole one. */
  minTail: 4000,
  /** Quiet: the loudest 20 ms (320 samples) of the window below this (dBFS). */
  quietDb: -50,
  quietBlock: 320,
  /** Speech: at least this share of the window inside the speech detector's ranges. */
  speechCover: 0.9,
  /** Bumped when the scores themselves would change (the cache is then ignored). */
  version: 1
} as const

/** Seconds of a window and between window starts. */
export const WINDOW_SECONDS = SCAN.window / SCAN.rate
export const HOP_SECONDS = SCAN.hop / SCAN.rate

/** The rules of findSounds (docs/design/sound-finder.md §4.3). */
export const FIND = {
  /** Windows of a kind closer than this (seconds) are one sound. */
  join: 0.5,
  /** A window's speech score from which it counts as speech when the speech detector did not run. */
  speechScore: 0.5,
  /** Speech ranges are widened by this (seconds) before they are taken out of a sound. */
  speechGuard: 0.1,
  /** Fitting: level windows within this many dB of the loudest one belong to the sound. */
  fitDb: 20,
  /** Fitting: the fitted stretch is padded by this (seconds), never beyond its windows. */
  fitPad: 0.05,
  /** Most rows listed (the strongest). */
  maxRows: 400
} as const

/** One window's scores of one source: n windows × SCORE_COLUMNS bytes (score × 255). */
export interface SourceScores {
  source: AudioSource
  /** Windows scored (each starts at i × HOP_SECONDS). */
  n: number
  scores: Uint8Array
}

/** A found sound. */
export interface SoundRow {
  /** `<kind>-<start in centiseconds>`: what a mute, duck or ignore remembers it by. */
  key: string
  kind: SoundKind
  /** Source seconds. */
  start: number
  end: number
  /** Highest window score in it, 0..1. */
  score: number
  /** Where it was heard (the first source when both). */
  source: AudioSource
}

export interface FindInput {
  sources: readonly SourceScores[]
  /** The speech detector's ranges (source seconds), or null when it did not run. */
  speech: readonly Range[] | null
  /** Each source's sound levels (for fitting), when measured. */
  levels?: Partial<Record<AudioSource, AudioLevels>>
}

export const KEY_RE = /^[a-z]{3,10}-\d{1,9}$/

export const soundKey = (kind: SoundKind, start: number): string => `${kind}-${Math.max(0, Math.round(start * 100))}`

/** The sources listened to: the stems the recording kept, else its mixed track; none without sound. */
export function scanSources(project: Pick<Project, 'hasAudio' | 'audioStems'>): AudioSource[] {
  if (!project.hasAudio) return []
  const stems = stemsOf(project)
  return stems.length > 0 ? stems : ['mix']
}

/** The source the speech detector listens to (the microphone, else the mixed track). */
export const voiceSource = (project: Pick<Project, 'hasAudio' | 'audioStems'>): AudioSource => (stemsOf(project).includes('mic') ? 'mic' : 'mix')

const r4 = (t: number): number => Math.round(t * 1e4) / 1e4

/** Windows of one source and one column at or above `threshold` (0..1), that also beat the window's speech score. */
function candidateWindows(s: SourceScores, column: number, threshold: number): number[] {
  const cols = SCORE_COLUMNS.length
  const min = Math.ceil(threshold * 255 - 1e-9)
  const out: number[] = []
  for (let i = 0; i < s.n; i++) {
    const v = s.scores[i * cols + column]
    if (v >= min && v > s.scores[i * cols]) out.push(i)
  }
  return out
}

/** The speech guard when the detector did not run: windows whose speech score reaches FIND.speechScore. */
function speechFromScores(sources: readonly SourceScores[]): Range[] {
  const cols = SCORE_COLUMNS.length
  const min = Math.ceil(FIND.speechScore * 255)
  const out: Range[] = []
  for (const s of sources) {
    for (let i = 0; i < s.n; i++) if (s.scores[i * cols] >= min) out.push({ start: i * HOP_SECONDS, end: i * HOP_SECONDS + WINDOW_SECONDS })
  }
  return mergeRanges(out)
}

/**
 * The stretch of [start, end] where the sound is: the 50 ms level windows within FIND.fitDb of the
 * loudest one in it, padded by FIND.fitPad and kept inside [start, end]. Unchanged without levels.
 */
export function fitToLevels(start: number, end: number, levels: AudioLevels | undefined): Range {
  if (!levels || levels.power.length === 0 || !(levels.window > 0)) return { start, end }
  const w = levels.window
  const a = Math.max(0, Math.floor(start / w))
  const b = Math.min(levels.power.length, Math.ceil(end / w))
  let peak = 0
  for (let i = a; i < b; i++) peak = Math.max(peak, levels.power[i])
  if (!(peak > 0)) return { start, end }
  const floor = peak / 10 ** (FIND.fitDb / 10)
  let first = -1
  let last = -1
  for (let i = a; i < b; i++) {
    if (levels.power[i] >= floor) {
      if (first < 0) first = i
      last = i
    }
  }
  return { start: Math.max(start, first * w - FIND.fitPad), end: Math.min(end, (last + 1) * w + FIND.fitPad) }
}

/** `r` with every one of the sorted, separate `cuts` taken out: the pieces left, in order. */
export function subtractRanges(r: Range, cuts: readonly Range[]): Range[] {
  const out: Range[] = []
  let from = r.start
  for (const c of cuts) {
    if (c.end <= from) continue
    if (c.start >= r.end) break
    if (c.start > from) out.push({ start: from, end: Math.min(c.start, r.end) })
    from = Math.max(from, c.end)
    if (from >= r.end) break
  }
  if (from < r.end) out.push({ start: from, end: r.end })
  return out
}

/**
 * The rows of a recording (docs/design/sound-finder.md §4.3): candidate windows per kind, joined,
 * fitted to the levels, with speech taken out, sources joined, at most FIND.maxRows (the strongest),
 * by time. Pure and linear in the windows.
 */
export function findSounds(input: FindInput): SoundRow[] {
  const speech = mergeRanges((input.speech ?? speechFromScores(input.sources)).map((r) => ({ start: r.start - FIND.speechGuard, end: r.end + FIND.speechGuard })))
  const cols = SCORE_COLUMNS.length
  const rows: SoundRow[] = []
  SOUND_KIND_ORDER.forEach((kind, k) => {
    const spec = SOUND_KINDS[kind]
    const column = k + 1
    const found: (SoundRow & { source: AudioSource })[] = []
    for (const s of input.sources) {
      const wins = candidateWindows(s, column, spec.threshold)
      // Windows that overlap or come within FIND.join of each other are one sound.
      let i = 0
      while (i < wins.length) {
        let j = i
        let best = s.scores[wins[i] * cols + column]
        while (j + 1 < wins.length && wins[j + 1] * HOP_SECONDS - (wins[j] * HOP_SECONDS + WINDOW_SECONDS) <= FIND.join + 1e-9) {
          j++
          best = Math.max(best, s.scores[wins[j] * cols + column])
        }
        const span = { start: wins[i] * HOP_SECONDS, end: wins[j] * HOP_SECONDS + WINDOW_SECONDS }
        const fitted = spec.fit ? fitToLevels(span.start, span.end, input.levels?.[s.source]) : span
        for (const piece of subtractRanges(fitted, speech)) {
          if (piece.end - piece.start >= spec.minLength - 1e-9) found.push({ key: '', kind, start: piece.start, end: piece.end, score: best / 255, source: s.source })
        }
        i = j + 1
      }
    }
    // The same kind heard on both sources is one row.
    found.sort((a, b) => a.start - b.start)
    for (const f of found) {
      const last = rows.length > 0 && rows[rows.length - 1].kind === kind ? rows[rows.length - 1] : null
      if (last && f.start <= last.end + 1e-9) {
        last.end = Math.max(last.end, f.end)
        last.score = Math.max(last.score, f.score)
      } else rows.push({ ...f })
    }
  })
  const kept = rows.length > FIND.maxRows ? [...rows].sort((a, b) => b.score - a.score || a.start - b.start).slice(0, FIND.maxRows) : rows
  return kept
    .map((r) => ({ ...r, start: r4(r.start), end: r4(r.end), score: Math.round(r.score * 1000) / 1000, key: soundKey(r.kind, r.start) }))
    .sort((a, b) => a.start - b.start || SOUND_KIND_ORDER.indexOf(a.kind) - SOUND_KIND_ORDER.indexOf(b.kind))
}
