/**
 * Make my captions great (docs/design/captions-studio.md §11.8): options, the planner (tidy,
 * style, emphasis, emoji, graphics; one update), its notice and the button's hint.
 *
 * CONTRACT (part P4): signatures are frozen; bodies are to be written. DEFAULT_GREAT_OPTIONS
 * holds the design's defaults.
 */
import type { MarksAnswer } from '../api/ai'
import type { CaptionStudio, Project } from '../types'
import type { CleanupChoices, WordListEntry } from './cleanup'

/** The body of a frozen signature part P4 writes. */
function notImplemented(name: string, ...args: unknown[]): never {
  void args
  throw new Error(`${name}: not implemented (Captions Studio part P4)`)
}

/** A choice that can be resolved per project ('auto', §2.8). */
export type Auto = boolean | 'auto'

export interface GreatOptions {
  style: boolean
  emphasis: boolean
  /** 'auto': on in camera-led tall and square frames (§11.6). */
  emoji: Auto
  keywords: Auto
  /** 'auto': on in tall and square frames. */
  counters: Auto
  lists: Auto
  speakers: boolean
  /** 'auto': on in wide frames when the project has chapters. */
  chapters: Auto
  /** Needs a provider. */
  quotes: boolean
  tidy: boolean
  /** Sound given to the pop-ups this run makes. */
  sound: 'none' | 'pop' | 'ding'
  /** AI provider id, or null: on this PC only. */
  provider: string | null
}

/** The options with every 'auto' resolved for one project. */
export type ResolvedGreatOptions = Omit<GreatOptions, 'emoji' | 'keywords' | 'counters' | 'lists' | 'chapters'> & {
  emoji: boolean
  keywords: boolean
  counters: boolean
  lists: boolean
  chapters: boolean
}

/** What a run changed, for its notice (§2.8). */
export interface GreatSummary {
  /** The look's name when the style step changed it; null when it did not. */
  style: string | null
  emphasised: number
  emoji: number
  counters: number
  lists: number
  keywords: number
  lowerThirds: number
  chapters: number
  quotes: number
  /** Captions the tidy step changed. */
  tidied: number
  bleeped: number
  /** The AI provider could not be reached, so the picks were made on this PC. */
  providerFailed?: true
}

export const DEFAULT_GREAT_OPTIONS: Readonly<GreatOptions> = Object.freeze({
  style: true,
  emphasis: true,
  emoji: 'auto',
  keywords: 'auto',
  counters: 'auto',
  lists: 'auto',
  speakers: true,
  chapters: 'auto',
  quotes: false,
  tidy: true,
  sound: 'none',
  provider: null
})

/** Stored options with the defaults for anything missing or unknown. */
export function readGreatOptions(raw: unknown): GreatOptions {
  return notImplemented('readGreatOptions', raw)
}

/** The options resolved for this project and frame (§2.8, §11.6). */
export function resolveGreatOptions(o: GreatOptions, project: Project, frame: { w: number; h: number }): ResolvedGreatOptions {
  return notImplemented('resolveGreatOptions', o, project, frame)
}

/** The planner (§11.8): the input project itself when nothing changes. */
export function planCaptionsGreat(
  input: { project: Project; frame: { w: number; h: number }; brand?: CaptionStudio | null; cleanup: CleanupChoices; words: readonly WordListEntry[]; marks?: MarksAnswer; by: 'great' | 'polish' },
  options: GreatOptions
): { project: Project; summary: GreatSummary } {
  return notImplemented('planCaptionsGreat', input, options)
}

/** "Captions: Bold Pop, 38 words emphasised, 3 emoji, 1 counter, 1 list. Review (Shift+R) · Undo". */
export function greatNotice(s: GreatSummary): string {
  return notImplemented('greatNotice', s)
}

/** The hint under the button, from the resolved options (§2.4). */
export function greatHint(o: ResolvedGreatOptions): string {
  return notImplemented('greatHint', o)
}
