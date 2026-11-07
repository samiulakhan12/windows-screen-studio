/**
 * When the library's sound effects sound (docs/design/editing-polish.md §10.6): on zooms, title
 * cards, texts and shapes by the project's rules, items' own sounds, and Captions Studio's pop-ups
 * with a library sound; video seconds, for the export job and the preview alike. Pure.
 *
 * Contracts step: the exported signatures of part P5 (§17.5). The exporter calls sfxJob for every
 * export and leaves an empty list out of the job; the stub returns none. Part P5 writes the bodies.
 */
import type { Graphic, Project } from '../types'

export const SFX_VOLUME = 0.35
export const MAX_SFX = 16
/** A rule's sound plays at most once every this many seconds of video. */
export const RULE_GAP = 3.0

/** Each library effect that sounds once, with its times (video seconds) and gain. */
export function sfxJob(project: Project, startOf?: (g: Graphic) => number): { id: string; times: number[]; gain: number }[] {
  void project
  void startOf
  return []
}

/** How many times each rule's sound plays ("Plays 24 times"). */
export function sfxCounts(project: Project, startOf?: (g: Graphic) => number): Readonly<Record<'zoomIn' | 'zoomOut' | 'titles' | 'callouts', number>> {
  void project
  void startOf
  return { zoomIn: 0, zoomOut: 0, titles: 0, callouts: 0 }
}
