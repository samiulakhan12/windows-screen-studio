/**
 * Translated caption tracks (docs/design/captions-studio.md §11.9): out-of-date checks, adding
 * and removing tracks, the burned-in captions and one caption's position. Pure.
 *
 * burnedSegments and placeOf return their input without the new fields: the legacy drawing's
 * guarded calls (§14.2) then draw old projects exactly as before.
 */
import type { CaptionSegment, CaptionSettings, CaptionTrack, Project } from '../types'
import { maskedSegments } from './cleanup'
import { MAX_TRACKS } from './studioData'

/** FNV-1a, 32 bits, as 8 hex digits. */
function fnv1a(text: string): string {
  let h = 0x811c9dc5
  for (let i = 0; i < text.length; i++) {
    h ^= text.charCodeAt(i)
    h = Math.imul(h, 0x01000193)
  }
  return (h >>> 0).toString(16).padStart(8, '0')
}

/** FNV-1a (32 bits, hex) of a spoken caption's text: CaptionTrack segments' `src`. */
export function textHash(text: string): string {
  return fnv1a(text)
}

const sameLanguage = (a: string, b: string): boolean => a.toLowerCase() === b.toLowerCase()

/** The track in `language`, or undefined. */
export function trackOf(project: Pick<Project, 'captionTracks'>, language: string): CaptionTrack | undefined {
  return project.captionTracks?.find((t) => sameLanguage(t.language, language))
}

/** Ids of the captions whose translation into `language` is out of date or missing. */
export function outOfDate(project: Project, language: string): string[] {
  const segments = project.transcript?.segments ?? []
  const track = trackOf(project, language)
  const have = new Map((track?.segments ?? []).map((s) => [s.id, s.src]))
  return segments.filter((s) => s.text.trim() && have.get(s.id) !== textHash(s.text)).map((s) => s.id)
}

/** How many spoken captions have no translation into `language`. */
export function missingTranslations(project: Project, language: string): number {
  const track = trackOf(project, language)
  const have = new Set((track?.segments ?? []).map((s) => s.id))
  return (project.transcript?.segments ?? []).filter((s) => s.text.trim() && !have.has(s.id)).length
}

/** The project with `track` added, or replacing the track in its language (one undo step). */
export function withTrack(project: Project, track: CaptionTrack): Project {
  const tracks = project.captionTracks ?? []
  const at = tracks.findIndex((t) => sameLanguage(t.language, track.language))
  if (at < 0 && tracks.length >= MAX_TRACKS) return project
  const next = at >= 0 ? tracks.map((t, i) => (i === at ? track : t)) : [...tracks, track]
  return { ...project, captionTracks: next }
}

/** The project without its track in `language`; the captions go back to the spoken text when it was shown. */
export function withoutTrack(project: Project, language: string): Project {
  const tracks = project.captionTracks ?? []
  if (!tracks.some((t) => sameLanguage(t.language, language))) return project
  const rest = tracks.filter((t) => !sameLanguage(t.language, language))
  const { captionTracks: _gone, ...base } = project
  void _gone
  const next: Project = rest.length ? { ...base, captionTracks: rest } : base
  const shown = project.captions?.track
  if (shown && sameLanguage(shown, language)) {
    const { track: _track, ...captions } = project.captions!
    void _track
    return { ...next, captions }
  }
  return next
}

/** The track `captions.track` names, when it exists. */
function shownTrack(project: Project): CaptionTrack | undefined {
  const language = project.captions?.track
  return language ? trackOf(project, language) : undefined
}

interface Burned {
  tracks: Project['captionTracks']
  bleeps: Project['bleeps']
  track: string | undefined
  out: readonly CaptionSegment[]
}
const burnedCache = new WeakMap<readonly CaptionSegment[], Burned>()

/**
 * The captions drawn on the video: the burned-in track's text and the bleep masks; without a track
 * and bleeps, project.transcript.segments itself (the same array and objects). Memoised.
 *
 * A translated caption has no word times (§9.1 rule 7: no spoken mark or word motion while a track
 * is shown); a caption the track has no text for keeps its spoken text and words. Bleep masks
 * apply to the spoken text only: the masked word is not known in a translation (§11.9).
 */
export function burnedSegments(project: Project): readonly CaptionSegment[] {
  const segments = project.transcript?.segments ?? []
  if (!project.captions?.track && !project.bleeps?.length) return segments
  const cached = burnedCache.get(segments)
  if (cached && cached.tracks === project.captionTracks && cached.bleeps === project.bleeps && cached.track === project.captions?.track) return cached.out
  const masked = maskedSegments(segments, project.bleeps)
  const track = shownTrack(project)
  let out = masked
  if (track) {
    const text = new Map(track.segments.map((s) => [s.id, s.text]))
    out = masked.map((seg) => {
      const t = text.get(seg.id)
      if (t === undefined) return seg
      const { words: _words, ...rest } = seg
      void _words
      return { ...rest, text: t }
    })
  }
  burnedCache.set(segments, { tracks: project.captionTracks, bleeps: project.bleeps, track: project.captions?.track, out })
  return out
}

/** One caption's position (captionPlaces) for the legacy placement; `position` itself without one. */
export function placeOf(project: Project, caption: string, position: CaptionSettings['position']): CaptionSettings['position'] {
  if (!project.captionPlaces?.length) return position
  return project.captionPlaces.find((p) => p.caption === caption)?.position ?? position
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

/** The ISO 639-2 code of a BCP-47 language ("pt-BR" → "por"), or 'und'. */
export function iso6392(language: string | undefined): string {
  return ISO_639_2[(language ?? '').toLowerCase().split(/[-_]/)[0]] ?? 'und'
}
