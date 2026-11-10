/**
 * How Settings › Language and the offer on Home name languages and what a choice gives
 * (docs/design/output-and-languages.md §2.5, §2.7). Text only through the `language` namespace;
 * each language's own name and own words are the same in every UI language (locale.ts).
 */
import type { UiInfo, UiLanguage, UiPrefs } from '../../../shared/api/ui'
import { defaultDigits, LANGUAGE_NAMES, OWN_WORDS } from '../../../shared/i18n/locale'
import languageEn from '../../../shared/i18n/messages/en/language.json'
import { formatLocale, t, uiLanguage } from '../../../shared/i18n/t'

/** A language's name in the UI language: its English name in English, its own name in itself, else Intl's name for it. */
export function nameInUi(language: UiLanguage): string {
  const ui = uiLanguage()
  if (ui === 'en') return LANGUAGE_NAMES[language].english
  if (language === ui) return LANGUAGE_NAMES[language].own
  try {
    const name = new Intl.DisplayNames([formatLocale()], { type: 'language' }).of(language)
    if (name && name !== language) return name
  } catch {
    // No display names here: the English name.
  }
  return LANGUAGE_NAMES[language].english
}

/**
 * A language in the picker: a preview reads "বাংলা (প্রিভিউ) · Bangla (preview)" in every UI
 * language; the UI's own language by its own name; any other by its own name and then its name in
 * the UI language ("বাংলা (Bangla)", "English (ইংরেজি)").
 */
export function optionLabel(language: UiLanguage, info: Pick<UiInfo, 'preview'>): string {
  const names = LANGUAGE_NAMES[language]
  if (info.preview.includes(language)) return t('language.option.preview', { own: OWN_WORDS[language]?.preview ?? names.own, english: names.english })
  if (language === uiLanguage()) return names.own
  return t('language.option.named', { own: names.own, english: nameInUi(language) })
}

/**
 * The heading and the select's label: in English as they are, in another language with the English
 * after them ("ভাষা · Language"), so someone who switched by mistake finds the way back. `english` is
 * null when there is nothing to add.
 */
export function withEnglish(key: 'section.title' | 'select.label'): { text: string; english: string | null } {
  const text = t(`language.${key}`)
  const english = languageEn[key]
  return { text, english: uiLanguage() === 'en' || text === english ? null : english }
}

/** The language and digits Flown starts in next time with `prefs` (a language that has not shipped gives English). */
export function nextStart(prefs: UiPrefs, info: Pick<UiInfo, 'system' | 'shipped'>): { language: UiLanguage; digits: 'native' | 'western' } {
  const chosen = prefs.language
  const language: UiLanguage = chosen === undefined || chosen === 'en' ? 'en' : chosen === 'system' ? info.system : info.shipped.includes(chosen) ? chosen : 'en'
  return { language, digits: language === 'en' ? 'western' : (prefs.digits ?? defaultDigits(language)) }
}

/** The select's value for `prefs`: Follow Windows, English, or a shipped language. */
export function choiceOf(prefs: UiPrefs, info: Pick<UiInfo, 'shipped'>): 'system' | UiLanguage {
  const chosen = prefs.language
  if (chosen === 'system') return 'system'
  return chosen !== undefined && chosen !== 'en' && info.shipped.includes(chosen) ? chosen : 'en'
}
