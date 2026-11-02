/**
 * Translated caption tracks (docs/design/captions-studio.md §11.9): out-of-date checks, adding
 * and removing tracks, the burned-in captions and one caption's position. Pure.
 *
 * burnedSegments and placeOf return their input without the new fields: the legacy drawing's
 * guarded calls (§14.2) then draw old projects exactly as before.
 */
import { spokenLanguage, UNKNOWN_SPOKEN, UNKNOWN_SPOKEN_NAME } from '../render/exportBundle'
import type { CaptionSegment, CaptionSettings, CaptionTrack, Project } from '../types'
import { CAPTION_MAX_CHARS, cleanCaptionText } from './captionData'
import { maskedSegments } from './cleanup'
import { captionsOf } from './settings'
import { applyTextResult } from './edit'
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

/** The 25 caption languages (the Captions tab's spoken languages) with their English names: Languages › Add a language offers them (§2.10). */
export const TRACK_LANGUAGES: readonly { code: string; name: string }[] = [
  { code: 'en', name: 'English' },
  { code: 'bn', name: 'Bengali' },
  { code: 'hi', name: 'Hindi' },
  { code: 'es', name: 'Spanish' },
  { code: 'fr', name: 'French' },
  { code: 'de', name: 'German' },
  { code: 'pt', name: 'Portuguese' },
  { code: 'it', name: 'Italian' },
  { code: 'nl', name: 'Dutch' },
  { code: 'ru', name: 'Russian' },
  { code: 'uk', name: 'Ukrainian' },
  { code: 'pl', name: 'Polish' },
  { code: 'tr', name: 'Turkish' },
  { code: 'ar', name: 'Arabic' },
  { code: 'ur', name: 'Urdu' },
  { code: 'ta', name: 'Tamil' },
  { code: 'te', name: 'Telugu' },
  { code: 'mr', name: 'Marathi' },
  { code: 'zh', name: 'Chinese' },
  { code: 'ja', name: 'Japanese' },
  { code: 'ko', name: 'Korean' },
  { code: 'id', name: 'Indonesian' },
  { code: 'vi', name: 'Vietnamese' },
  { code: 'th', name: 'Thai' },
  { code: 'sv', name: 'Swedish' }
]

/** "Bengali" for 'bn' or 'bn-BD'; the code itself for a language outside the list. */
export function languageName(code: string | undefined): string {
  if (!code) return 'the spoken language'
  const base = code.toLowerCase().split(/[-_]/)[0]
  return TRACK_LANGUAGES.find((l) => l.code === base)?.name ?? code
}

/** The languages a new track may have: the caption languages without the spoken one and those with a track. */
export function languagesToAdd(project: Project): { code: string; name: string }[] {
  const spoken = (project.transcript?.language ?? '').toLowerCase().split(/[-_]/)[0]
  const have = new Set((project.captionTracks ?? []).map((t) => t.language.toLowerCase().split(/[-_]/)[0]))
  return TRACK_LANGUAGES.filter((l) => l.code !== spoken && !have.has(l.code))
}

/** The spoken captions a translation into `language` sends: those out of date or missing (every caption for a new track). */
export function captionsToTranslate(project: Project, language: string): CaptionSegment[] {
  const ids = new Set(outOfDate(project, language))
  return (project.transcript?.segments ?? []).filter((s) => ids.has(s.id))
}

/**
 * The project with a translation written into the track in `language` (§11.9: the AI provider's
 * 'translate' answer writes a track instead of replacing the captions; one undo step), or null
 * when the answer cannot be used: checked by applyTextResult against the captions sent (the same
 * ids and times, none left out), and never in the spoken language. A caption whose text changed
 * since it was sent keeps what its track had (it stays out of date); the others get the new text
 * with a hash of the text it was made from. The track's other captions are kept; captions that
 * are gone leave the track.
 */
export function withTranslation(
  project: Project,
  t: { language: string; by: CaptionTrack['by']; model: string; createdAt: string; sent: readonly CaptionSegment[]; answer: unknown }
): Project | null {
  const spoken = project.transcript?.language
  if (!project.transcript || (spoken && sameLanguage(spoken, t.language))) return null
  const checked = applyTextResult(t.sent, t.answer)
  if (!checked) return null
  const now = new Map(project.transcript.segments.map((s) => [s.id, s]))
  const fresh = new Map<string, CaptionTrack['segments'][number]>()
  checked.forEach((s, i) => {
    const sent = t.sent[i]
    const text = cleanCaptionText(s.text).slice(0, CAPTION_MAX_CHARS)
    if (now.get(sent.id)?.text === sent.text && text && cleanCaptionText(sent.text)) fresh.set(sent.id, { id: sent.id, text, src: textHash(sent.text) })
  })
  const kept = new Map((trackOf(project, t.language)?.segments ?? []).map((s) => [s.id, s]))
  const segments = project.transcript.segments.flatMap((s) => {
    const seg = fresh.get(s.id) ?? kept.get(s.id)
    return seg ? [seg] : []
  })
  const next = withTrack(project, { language: t.language, by: t.by, model: t.model.slice(0, 200), createdAt: t.createdAt, segments })
  return next === project ? null : next
}

/** The project with `language`'s track drawn on the video, or the spoken captions (null); one undo step. */
export function withShownTrack(project: Project, language: string | null): Project {
  const want = (language && trackOf(project, language)?.language) || null
  if ((project.captions?.track ?? null) === want) return project
  const { track: _track, ...rest } = captionsOf(project)
  void _track
  return { ...project, captions: want ? { ...rest, track: want } : rest }
}

const PROVIDER_NAMES: Record<Exclude<CaptionTrack['by'], 'local'>, string> = { openai: 'OpenAI', gemini: 'Gemini', anthropic: 'Claude' }
const plural = (n: number, one: string, many = `${one}s`): string => `${n} ${n === 1 ? one : many}`

/** "3 captions are not translated: they show in English" (the Languages row, §2.10). */
function untranslated(missing: number, spoken: string | undefined): string {
  return `${plural(missing, 'caption')} ${missing === 1 ? 'is' : 'are'} not translated: ${missing === 1 ? 'it shows' : 'they show'} in ${spoken ? languageName(spoken) : 'the spoken language'}`
}

/** One row of the Languages section (§2.10): the spoken captions first (`language` null), then each track. */
export interface TrackRow {
  language: string | null
  /** "English · spoken", "Bengali · translated with Gemini". */
  label: string
  /** Translated captions whose spoken text changed since. */
  changed: number
  /** Spoken captions with no translation (added or split since). */
  missing: number
  /** Drawn on the video. */
  shown: boolean
  /** "3 captions changed since", "3 captions are not translated: they show in English", the bleep note. */
  notes: string[]
}

export function trackRows(project: Project): TrackRow[] {
  const spoken = project.transcript?.language
  const shown = shownTrack(project)?.language ?? null
  const rows: TrackRow[] = [{ language: null, label: spoken ? `${languageName(spoken)} · spoken` : 'Spoken captions', changed: 0, missing: 0, shown: shown === null, notes: [] }]
  for (const t of project.captionTracks ?? []) {
    const missing = missingTranslations(project, t.language)
    const changed = outOfDate(project, t.language).length - missing
    const notes: string[] = []
    if (changed) notes.push(`${plural(changed, 'caption')} changed since`)
    if (missing) notes.push(untranslated(missing, spoken))
    if (project.bleeps?.length) notes.push('Bleeped words are not masked in translations')
    rows.push({ language: t.language, label: `${languageName(t.language)} · translated ${t.by === 'local' ? 'on this PC' : `with ${PROVIDER_NAMES[t.by]}`}`, changed, missing, shown: shown === t.language, notes })
  }
  return rows
}

/** The export's note when the burned-in track lacks captions (§2.13): "3 captions are not translated into Bengali: they show in English."; null otherwise. */
export function burnedTrackNote(project: Project): string | null {
  const track = shownTrack(project)
  if (!track || project.captions?.show === false) return null
  const missing = missingTranslations(project, track.language)
  if (!missing) return null
  const spoken = project.transcript?.language
  return `${plural(missing, 'caption')} ${missing === 1 ? 'is' : 'are'} not translated into ${languageName(track.language)}: ${missing === 1 ? 'it shows' : 'they show'} in ${spoken ? languageName(spoken) : 'the spoken language'}.`
}

/**
 * The subtitle languages an export can write (§2.13): the spoken language first (as the export
 * names it: 'und', "Spoken language", when the transcript does not say), then each track's.
 */
export function exportLanguages(project: Project): { code: string; name: string; spoken: boolean }[] {
  const spoken = spokenLanguage(project)
  return [
    { code: spoken, name: spoken === UNKNOWN_SPOKEN ? UNKNOWN_SPOKEN_NAME : languageName(spoken), spoken: true },
    ...(project.captionTracks ?? []).map((t) => ({ code: t.language, name: languageName(t.language), spoken: false }))
  ]
}

/** The languages ticked by default (§2.13): the spoken language, and the burned-in track's when one is shown on the video. */
export function defaultExportLanguages(project: Project): string[] {
  const spoken = spokenLanguage(project)
  const track = project.captions?.show !== false ? shownTrack(project) : undefined
  return track ? [spoken, track.language] : [spoken]
}

/** The ticked subtitle languages (§2.13): the export dialog's choice when it made one, else the defaults; only languages the project has, never none. */
export function tickedExportLanguages(project: Project, chosen: readonly string[] | undefined): string[] {
  const have = exportLanguages(project).map((l) => l.code)
  const picked = (chosen ?? defaultExportLanguages(project)).filter((l) => have.includes(l))
  return picked.length ? have.filter((l) => picked.includes(l)) : have.slice(0, 1)
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

const banglaCache = new WeakMap<readonly CaptionSegment[], boolean>()

/** Most letters of the first 50 captions are Bengali (§0.2, §8.1: a transcript that names no language). Memoised. */
export function mostlyBangla(segments: readonly CaptionSegment[]): boolean {
  let out = banglaCache.get(segments)
  if (out === undefined) {
    let letters = 0
    let bengali = 0
    for (const s of segments.slice(0, 50)) {
      for (const ch of s.text) {
        if (!/\p{L}/u.test(ch)) continue
        letters++
        if (/\p{Script=Bengali}/u.test(ch)) bengali++
      }
    }
    banglaCache.set(segments, (out = letters > 0 && bengali / letters > 0.5))
  }
  return out
}

/** The transcript's language, else Bangla when it names none and is mostly Bangla (§0.2, §8.1). */
export function transcriptLanguage(transcript: Project['transcript']): string | undefined {
  return transcript?.language || (transcript && mostlyBangla(transcript.segments) ? 'bn' : undefined)
}

/**
 * The language of the captions on the video: the shown track's, else the transcript's
 * (transcriptLanguage). The Digits choice, Case and letter spacing follow it, in the controls and
 * the drawing alike (§0.2).
 */
export function captionLanguage(project: Pick<Project, 'captions' | 'transcript'>): string | undefined {
  return project.captions?.track || transcriptLanguage(project.transcript)
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
