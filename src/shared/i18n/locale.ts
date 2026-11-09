/**
 * The UI language and its format locale (docs/design/output-and-languages.md §9.4, §11, §18.5).
 * Pure. `readUiPrefs` is the contracts' (§21.0), frozen with test 5; the rest is part P6's.
 */
import { UI_LANGUAGES, type UiInfo, type UiLanguage, type UiPrefs } from '../api/ui'

/** Most languages `offered` or `seen` may list. */
const MAX_LISTED = 8

const isLanguage = (v: unknown): v is UiLanguage => UI_LANGUAGES.includes(v as UiLanguage)

/** A list of UI languages, each once, or undefined when the value is not one (at most 8 entries, every one a UiLanguage). */
function languageList(v: unknown): UiLanguage[] | undefined {
  if (!Array.isArray(v) || v.length > MAX_LISTED || !v.every(isLanguage)) return undefined
  return [...new Set(v)]
}

/**
 * The `ui` preference as Flown reads it (§18.5), or null when it is not an object: `language` is
 * 'system' or a UiLanguage, `digits` 'native' or 'western', `offered` and `seen` lists of at most 8
 * UiLanguages; anything else is left out.
 */
export function readUiPrefs(raw: unknown): UiPrefs | null {
  if (!raw || typeof raw !== 'object' || Array.isArray(raw)) return null
  const r = raw as Record<string, unknown>
  const out: UiPrefs = {}
  if (r.language === 'system' || isLanguage(r.language)) out.language = r.language
  if (r.digits === 'native' || r.digits === 'western') out.digits = r.digits
  const offered = languageList(r.offered)
  if (offered) out.offered = offered
  const seen = languageList(r.seen)
  if (seen) out.seen = seen
  return out
}

/** Each UI language by its own name and its English name (the picker, §2.5). */
export const LANGUAGE_NAMES: Readonly<Record<UiLanguage, { own: string; english: string }>> = {
  en: { own: 'English', english: 'English' },
  bn: { own: 'বাংলা', english: 'Bangla' },
  es: { own: 'Español', english: 'Spanish' },
  hi: { own: 'हिन्दी', english: 'Hindi' }
}

/* ---------- Part P6 (§21.6): the contracts' stubs give English ---------- */

/** The language subtag of a BCP 47 tag ('bn-IN' and 'bn-BD' are 'bn'). Part P6. */
export function languageOf(tag: string): string {
  return tag.split(/[-_]/)[0]!.toLowerCase()
}

/** The Intl locale a UI language formats with (§9.4 step 2). Part P6; the stub gives English's. */
export function formatLocaleOf(language: UiLanguage, systemLocale: string, digits: 'native' | 'western' | undefined): string {
  void language
  void systemLocale
  void digits
  return 'en-US'
}

/** The writing direction of a language. Part P6; no right-to-left language ships in this wave. */
export function dirOf(language: string): 'ltr' | 'rtl' {
  void language
  return 'ltr'
}

/** The UI language at start, from the preference, Windows' languages and what ships (§9.4, §2.7). Part P6; the stub gives English. */
export function resolveUiLanguage(
  prefs: UiPrefs | null,
  preferred: readonly string[],
  systemLocale: string,
  shipped: readonly { language: UiLanguage; preview: boolean }[],
  known: readonly UiLanguage[]
): UiInfo {
  void preferred
  void systemLocale
  void shipped
  void known
  return { language: 'en', formatLocale: 'en-US', dir: 'ltr', digits: 'western', system: 'en', offer: null, shipped: [], preview: [], prefs: prefs ?? {}, reopen: null }
}
