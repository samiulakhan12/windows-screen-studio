/**
 * The captions' words that main-process modules also carry (docs/design/output-and-languages.md §9.1,
 * test 86): src/shared/captions/* and src/shared/speech/catalog.ts are in main's import graph, which
 * may hold only the common, errors and main messages, so they keep their English as data (for the
 * exported files, the AI requests and main) and the renderer shows the same words in the UI language
 * through here. In English each function gives exactly the text the panels showed before.
 */
import { SUBTITLE_FORMATS, type SubtitleFormat } from '../../../shared/captions/subtitles'
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
