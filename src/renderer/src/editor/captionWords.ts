/**
 * The captions' words that main-process modules also carry (docs/design/output-and-languages.md §9.1,
 * test 86): src/shared/captions/* and src/shared/speech/catalog.ts are in main's import graph, which
 * may hold only the common, errors and main messages, so they keep their English as data (for the
 * exported files, the AI requests and main) and the renderer shows the same words in the UI language
 * through here. In English each function gives exactly the text the panels showed before.
 */
import { languageName, type TrackRow } from '../../../shared/captions/captionTracks'
import { STEM_SPEAKERS } from '../../../shared/captions/speakers'
import { SUBTITLE_FORMATS, type SubtitleFormat } from '../../../shared/captions/subtitles'
import { fmt } from '../../../shared/i18n/fmt'
import { formatLocale, t, uiLanguage, type MessageKey } from '../../../shared/i18n/t'
import type { CaptionTrack, Project } from '../../../shared/types'

/**
 * A caption language's name in the UI language. `english` is the name the panels showed in English
 * (the tables' "Bengali", or the code for a language outside them), returned as it is in English and
 * whenever the UI language's own name for `code` is not known.
 */
export function captionLanguageName(code: string, english: string): string {
  if (uiLanguage() === 'en' || !code) return english
  try {
    const name = new Intl.DisplayNames([formatLocale()], { type: 'language' }).of(code)
    if (name && name !== code) return name
  } catch {
    // No display names here, or a code Intl does not take: the English name.
  }
  return english
}

const FORMAT_KEYS: Readonly<Record<SubtitleFormat, { label?: MessageKey; title: MessageKey }>> = {
  srt: { title: 'captions.export.format.srt' },
  vtt: { title: 'captions.export.format.vtt' },
  txt: { label: 'captions.export.format.txtLabel', title: 'captions.export.format.txt' }
}

/** The subtitle formats of the Export captions section (subtitles.ts SUBTITLE_FORMATS): SRT and VTT keep their names. */
export function subtitleFormats(): { value: SubtitleFormat; label: string; title: string }[] {
  return SUBTITLE_FORMATS.map((f) => {
    const keys = FORMAT_KEYS[f.value]
    return { value: f.value, label: keys.label ? t(keys.label) : f.label, title: t(keys.title) }
  })
}

/** The stem speakers' names inside the speaker sentences: data written into the captions, the same in every UI language. */
const STEMS = (): { youName: string; othersName: string } => ({ youName: STEM_SPEAKERS.mic, othersName: STEM_SPEAKERS.system })

/** What the Speakers section and the speaker options say (speakers.ts keeps the data: names, labels, files). */
export const speakerCopy = {
  get title(): string {
    return t('captions.speakers.title')
  },
  get labelStems(): string {
    return t('captions.speakers.labelStems', STEMS())
  },
  get labelStemsTitle(): string {
    return t('captions.speakers.labelStemsTitle')
  },
  get replaceQuestion(): string {
    return t('captions.speakers.replaceQuestion', STEMS())
  },
  get remove(): string {
    return t('captions.speakers.remove')
  },
  get none(): string {
    return t('captions.speakers.none')
  },
  get mixedHint(): string {
    return t('captions.speakers.mixedHint')
  },
  nameLabel: (name: string): string => t('captions.speakers.nameLabel', { name }),
  count: (n: number): string => t('captions.speakers.count', { count: n, n: fmt.count(n) }),
  labelled: (you: number, others: number): string =>
    t('captions.speakers.labelled', { count: you + others, n: fmt.count(you + others), you: fmt.count(you), others: fmt.count(others), ...STEMS() }),
  get nothingHeard(): string {
    return t('captions.speakers.nothingHeard')
  },
  get levelsFailed(): string {
    return t('captions.speakers.levelsFailed')
  },
  renamed: (from: string, to: string): string => (to ? t('captions.speakers.renamed', { from, to }) : t('captions.speakers.unlabelled', { from })),
  get removed(): string {
    return t('captions.speakers.removed')
  },
  get noSpeaker(): string {
    return t('captions.speakers.noSpeaker')
  },
  newSpeaker: (name: string): string => t('captions.speakers.newSpeaker', { name }),
  selectLabel: (at: string): string => t('captions.speakers.selectLabel', { time: at }),
  get showOnVideo(): string {
    return t('captions.speakers.showOnVideo')
  },
  get showOnVideoTitle(): string {
    return t('captions.speakers.showOnVideoTitle')
  },
  get inFiles(): string {
    return t('captions.speakers.inFiles')
  },
  get inFilesTitle(): string {
    return t('captions.speakers.inFilesTitle')
  }
}

const PROVIDER_NAMES: Readonly<Record<Exclude<CaptionTrack['by'], 'local'>, string>> = { openai: 'OpenAI', gemini: 'Gemini', anthropic: 'Claude' }

/**
 * A Languages row's name and notes (captionTracks.ts trackRows) in the UI language. English shows
 * trackRows' own words, as before; another language says the same from the row's numbers, its
 * track and the project.
 */
export function trackRowWords(row: TrackRow, project: Project): { label: string; notes: string[] } {
  if (uiLanguage() === 'en') return { label: row.label, notes: row.notes }
  const spokenCode = project.transcript?.language
  const spoken = spokenCode ? captionLanguageName(spokenCode, languageName(spokenCode)) : t('captions.languages.theSpoken')
  if (row.language === null) return { label: spokenCode ? t('captions.languages.spokenRow', { language: spoken }) : t('captions.languages.spokenCaptions'), notes: [] }
  const track = project.captionTracks?.find((x) => x.language === row.language)
  const language = captionLanguageName(row.language, languageName(row.language))
  const notes: string[] = []
  if (row.changed) notes.push(t('captions.languages.changedSince', { count: row.changed, n: fmt.count(row.changed) }))
  if (row.missing) notes.push(t('captions.languages.untranslated', { count: row.missing, n: fmt.count(row.missing), spoken }))
  if (project.bleeps?.length) notes.push(t('captions.languages.bleepsNote'))
  const label = !track
    ? t('captions.languages.translatedRow', { language })
    : track.by === 'local'
      ? t('captions.languages.translatedHere', { language })
      : t('captions.languages.translatedWith', { language, via: track.by === 'openai' && track.host ? track.host : PROVIDER_NAMES[track.by] })
  return { label, notes }
}

/**
 * A sentence's first word as it reads inside another sentence: in English its first letter lower
 * case, as the panels wrote it ("…, short clips: big capitals…"); other languages leave it as it is.
 */
export const inSentence = (text: string): string => (uiLanguage() === 'en' ? `${text.charAt(0).toLowerCase()}${text.slice(1)}` : text)
