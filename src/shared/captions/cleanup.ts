/**
 * Clean-up, the word list and bleeping (docs/design/captions-studio.md §11.7).
 *
 * CONTRACT (part P4): signatures are frozen; bodies are to be written.
 */
import type { AiTextResult } from '../api/ai'
import type { Bleep, CaptionSegment, Project } from '../types'

/** The body of a frozen signature part P4 writes. */
function notImplemented(name: string, ...args: unknown[]): never {
  void args
  throw new Error(`${name}: not implemented (Captions Studio part P4)`)
}

/** The Clean up section's choices (prefs `captionCleanup`, §2.9). */
export interface CleanupChoices {
  caps: boolean
  punct: boolean
  digits: 'above-ten' | 'all' | 'off'
  bleep: 'off' | 'standard' | 'strict'
  bleepSound: 'tone' | 'silence'
  ai: boolean
}

/** A word-list entry (prefs `captionWordList`): the term as written and the forms it is heard as. */
export interface WordListEntry {
  term: string
  heard: string[]
}

/** The AI fix's answer (today's `cleanup` text task). */
export type TextResult = Extract<AiTextResult, { task: 'cleanup' | 'translate' }>

/**
 * A stretch of the recording's sound at `gain` (source seconds), as the sound finder's SoundGain.
 * TODO(phase B): use SoundGain from src/shared/api/export.ts once the sound finder (F-17) has
 * merged; soundGains then joins these with its own (§11.7, §14.2).
 */
export interface SoundGain {
  start: number
  end: number
  gain: number
}

/** Stored choices with defaults for anything missing or unknown (caps, punct on; digits above ten; no bleeping; tone; no AI). */
export function readCleanupChoices(raw: unknown): CleanupChoices {
  return notImplemented('readCleanupChoices', raw)
}

/** The captions tidied with `opts` (rules 1–6), with `captionAuto.text` records and bleeps: one update. */
export function tidyCaptions(project: Project, opts: CleanupChoices & { words: readonly WordListEntry[]; ai?: TextResult }): { project: Project; changed: number; bleeped: number } {
  return notImplemented('tidyCaptions', project, opts)
}

/** A bleeped word as shown: "f***" (first letter and asterisks), "****" in scripts without case. */
export function maskWord(word: string): string {
  return notImplemented('maskWord', word)
}

/** A gain of 0 over each bleep, for the sound finder's one muting path. */
export function bleepGains(project: Project): SoundGain[] {
  return notImplemented('bleepGains', project)
}

/** The captions with bleeped words masked by time; the same array without bleeps. */
export function maskedSegments(segments: readonly CaptionSegment[], bleeps: readonly Bleep[] | undefined): readonly CaptionSegment[] {
  if (!bleeps?.length) return segments
  return notImplemented('maskedSegments', segments, bleeps)
}
