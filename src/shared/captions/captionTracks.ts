/**
 * Translated caption tracks (docs/design/captions-studio.md §11.9): out-of-date checks, adding
 * and removing tracks, the burned-in captions and one caption's position.
 *
 * CONTRACT (part P4): signatures are frozen; bodies are to be written. ISO_639_2 holds the map of
 * §11.10. burnedSegments and placeOf already return their input without the new fields, as the
 * legacy drawing's guarded calls need (§14.2).
 */
import type { CaptionSegment, CaptionSettings, CaptionTrack, Project } from '../types'

/** The body of a frozen signature part P4 writes. */
function notImplemented(name: string, ...args: unknown[]): never {
  void args
  throw new Error(`${name}: not implemented (Captions Studio part P4)`)
}

/** FNV-1a (32 bits, hex) of a spoken caption's text: CaptionTrack segments' `src`. */
export function textHash(text: string): string {
  return notImplemented('textHash', text)
}

/** Ids of the captions whose translation into `language` is out of date or missing. */
export function outOfDate(project: Project, language: string): string[] {
  return notImplemented('outOfDate', project, language)
}

/** How many spoken captions have no translation into `language`. */
export function missingTranslations(project: Project, language: string): number {
  return notImplemented('missingTranslations', project, language)
}

export function withTrack(project: Project, track: CaptionTrack): Project {
  return notImplemented('withTrack', project, track)
}

export function withoutTrack(project: Project, language: string): Project {
  return notImplemented('withoutTrack', project, language)
}

/**
 * The captions drawn on the video: the burned-in track's text and the bleep masks; without a track
 * and bleeps, project.transcript.segments itself (the same array and objects). Memoised.
 */
export function burnedSegments(project: Project): readonly CaptionSegment[] {
  const segments = project.transcript?.segments ?? []
  if (!project.captions?.track && !project.bleeps?.length) return segments
  return notImplemented('burnedSegments', project)
}

/** One caption's position (captionPlaces) for the legacy placement; `position` itself without one. */
export function placeOf(project: Project, caption: string, position: CaptionSettings['position']): CaptionSettings['position'] {
  if (!project.captionPlaces?.length) return position
  return notImplemented('placeOf', project, caption, position)
}

/** ISO 639-2 codes for subtitle streams (§11.10); a language outside the map gets 'und'. */
export const ISO_639_2: Readonly<Record<string, string>> = {
  en: 'eng',
  bn: 'ben',
  hi: 'hin',
  es: 'spa',
  fr: 'fra',
  de: 'deu',
  pt: 'por',
  it: 'ita',
  nl: 'nld',
  ru: 'rus',
  uk: 'ukr',
  pl: 'pol',
  tr: 'tur',
  ar: 'ara',
  ur: 'urd',
  ta: 'tam',
  te: 'tel',
  mr: 'mar',
  zh: 'zho',
  ja: 'jpn',
  ko: 'kor',
  id: 'ind',
  vi: 'vie',
  th: 'tha',
  sv: 'swe'
}
