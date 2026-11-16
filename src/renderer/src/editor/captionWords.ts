/**
 * The captions' words that main-process modules also carry (docs/design/output-and-languages.md §9.1,
 * test 86): src/shared/captions/* and src/shared/speech/catalog.ts are in main's import graph, which
 * may hold only the common, errors and main messages, so they keep their English as data (for the
 * exported files, the AI requests and main) and the renderer shows the same words in the UI language
 * through here. In English each function gives exactly the text the panels showed before.
 */
import { STEM_SPEAKERS } from '../../../shared/captions/speakers'
import { SUBTITLE_FORMATS, type SubtitleFormat } from '../../../shared/captions/subtitles'
import { fmt } from '../../../shared/i18n/fmt'
import { formatLocale, t, uiLanguage, type MessageKey } from '../../../shared/i18n/t'

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
