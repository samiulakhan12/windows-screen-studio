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

/* ---------- Part P6 (§21.6) ---------- */

/** The language subtag of a BCP 47 tag ('bn-IN' and 'bn-BD' are 'bn'). */
export function languageOf(tag: string): string {
  return tag.split(/[-_]/)[0]!.toLowerCase()
}

const isUiLanguage = (v: string): v is UiLanguage => (UI_LANGUAGES as readonly string[]).includes(v)

/**
 * Digits each language has besides Western ones, as a Unicode numbering system: Bangla's are its
 * default, Hindi's a choice (CLDR's default for hi is Latin, §11.3). Spanish and English have none.
 */
export const NATIVE_NUMBERING: Readonly<Partial<Record<UiLanguage, 'beng' | 'deva'>>> = { bn: 'beng', hi: 'deva' }

/** The digits a language writes when the user has not chosen (the locale's own, §4.4). */
export const defaultDigits = (language: UiLanguage): 'native' | 'western' => (language === 'bn' ? 'native' : 'western')

/** The name of each language's own digits and the digits themselves, the same in every UI language (Settings › Language, §2.5). */
export const DIGIT_NAMES: Readonly<Partial<Record<UiLanguage, { own: string; digits: string }>>> = {
  bn: { own: 'বাংলা', digits: '০১২৩' },
  hi: { own: 'देवनागरी', digits: '०१२३' }
}

/**
 * Words a shipped language shows in itself whatever the UI language, because the person reading them
 * may not have chosen it yet: its name as a preview in the picker (§0 decision 11) and the offer on
 * Home (§2.7), exactly as the design gives them. A language without its words here shows the English
 * half only.
 */
export const OWN_WORDS: Readonly<Partial<Record<UiLanguage, { preview: string; available: string; use: string; notNow: string; nextStart: string }>>> = {
  bn: {
    preview: 'বাংলা (প্রিভিউ)',
    available: 'Flown এখন বাংলায় পাওয়া যায়।',
    use: 'বাংলা ব্যবহার করুন',
    notNow: 'এখন না',
    nextStart: 'পরের বার চালু হলে Flown বাংলায় খুলবে।'
  }
}

/** Language and region of a system locale such as 'bn-BD' or 'es-419', or null when it is not a usable tag. */
function languageAndRegion(tag: string): { language: string; region?: string } | null {
  try {
    const l = new Intl.Locale(tag.replace(/_/g, '-'))
    return { language: l.language.toLowerCase(), region: l.region }
  } catch {
    return null
  }
}

/**
 * The Intl locale a UI language formats with (§9.4 step 2). English keeps each call site's own
 * profile (§11.2), so it is 'en-US'. Another language takes the system locale's region when the
 * system locale is the same language ('bn-BD', 'bn-IN', 'es-MX'), else the bare language; a digits
 * choice is always written as a `-u-nu-` tag, because Intl.DurationFormat obeys the tag and ignores
 * the `numberingSystem` option (measured in Electron 44). Without a choice the locale's own digits
 * apply and no tag is added.
 */
export function formatLocaleOf(language: UiLanguage, systemLocale: string, digits: 'native' | 'western' | undefined): string {
  if (language === 'en') return 'en-US'
  const system = languageAndRegion(systemLocale)
  const base = system && system.language === language && system.region ? `${language}-${system.region}` : language
  const native = NATIVE_NUMBERING[language]
  if (!native || !digits) return base
  return `${base}-u-nu-${digits === 'native' ? native : 'latn'}`
}

/** Right-to-left languages, for runtimes without Intl.Locale's text info. */
const RTL = new Set(['ar', 'he', 'iw', 'fa', 'ur', 'ps', 'sd', 'ug', 'yi', 'dv', 'ckb'])

/** The writing direction of a language (`new Intl.Locale(lang).getTextInfo().direction`, §13.2). */
export function dirOf(language: string): 'ltr' | 'rtl' {
  try {
    const locale = new Intl.Locale(language) as Intl.Locale & { getTextInfo?: () => { direction?: string }; textInfo?: { direction?: string } }
    const info = typeof locale.getTextInfo === 'function' ? locale.getTextInfo() : locale.textInfo
    if (info?.direction === 'rtl' || info?.direction === 'ltr') return info.direction
  } catch {
    // Not a tag Intl reads: by the list below.
  }
  return RTL.has(languageOf(language)) ? 'rtl' : 'ltr'
}

/** A shipped list as `shipped.json` holds it (§9.2): each UiLanguage other than English once, with its preview flag; anything else dropped. */
export function readShipped(raw: unknown): { language: UiLanguage; preview: boolean }[] {
  if (!Array.isArray(raw)) return []
  const out: { language: UiLanguage; preview: boolean }[] = []
  for (const item of raw.slice(0, UI_LANGUAGES.length * 2)) {
    if (!item || typeof item !== 'object') continue
    const { language, preview } = item as Record<string, unknown>
    if (typeof language !== 'string' || !isUiLanguage(language) || language === 'en' || out.some((s) => s.language === language)) continue
    out.push({ language, preview: preview === true })
  }
  return out
}

/**
 * The UI language at start (§9.4 step 1, §2.7). `preferred` is Windows' list
 * (app.getPreferredSystemLanguages), `systemLocale` app.getSystemLocale(), `shipped` the languages
 * of `shipped.json` that have a built catalogue, `known` the languages Flown knows offline that the
 * user works in (a speech model made for one; `prefs.seen` counts too).
 *
 * - `language` absent or 'en': English, on existing and new installs alike (§0 decision 8).
 * - 'system': the first of Windows' languages, reduced to its language; English when it has not shipped.
 * - a shipped language: that language; one that has not shipped (no built catalogue): English.
 * - `offer`: only while `language` is absent, a shipped language not yet in `offered` that Windows
 *   lists (any of its languages) or that Flown knows offline; Windows' order first.
 */
export function resolveUiLanguage(
  prefs: UiPrefs | null,
  preferred: readonly string[],
  systemLocale: string,
  shipped: readonly { language: UiLanguage; preview: boolean }[],
  known: readonly UiLanguage[]
): UiInfo {
  const p = prefs ?? {}
  const ships = readShipped(shipped)
  const shippedLanguages = ships.map((s) => s.language)
  const isShipped = (l: string): l is UiLanguage => (shippedLanguages as string[]).includes(l)
  const first = preferred.length > 0 ? languageOf(preferred[0]!) : ''
  const system: UiLanguage = isShipped(first) ? first : 'en'
  const language: UiLanguage = p.language === undefined || p.language === 'en' ? 'en' : p.language === 'system' ? system : isShipped(p.language) ? p.language : 'en'
  const digits = language === 'en' ? 'western' : (p.digits ?? defaultDigits(language))
  let offer: UiLanguage | null = null
  if (p.language === undefined) {
    const offered = new Set(p.offered ?? [])
    const candidates = [...preferred.map(languageOf), ...known, ...(p.seen ?? [])]
    offer = (candidates.find((l) => isShipped(l) && !offered.has(l)) as UiLanguage | undefined) ?? null
  }
  // The PC's region, whatever the UI language (auto-blur §2.5): English formats as en-US, the region is still the PC's.
  const region = languageAndRegion(systemLocale)?.region
  return {
    language,
    formatLocale: formatLocaleOf(language, systemLocale, language === 'en' ? undefined : p.digits),
    ...(region && /^[A-Z]{2}$/.test(region) ? { region } : {}),
    dir: language === 'en' ? 'ltr' : dirOf(language),
    digits,
    system,
    offer,
    shipped: shippedLanguages,
    preview: ships.filter((s) => s.preview).map((s) => s.language),
    prefs: p,
    reopen: null
  }
}

/** A built catalogue (`src/shared/i18n/built/<lang>.json`, §9.2): approved messages by full key, the keys whose numbers stay Latin, and the placeholders holding the user's text. */
export interface BuiltCatalogue {
  messages: Record<string, string>
  latn: string[]
  user: Record<string, string[]>
}

/** Most messages a built catalogue may hold, and the longest message, so a damaged file cannot take the memory. */
const CATALOGUE_LIMITS = { messages: 20_000, length: 4_000 }
const KEY = /^[a-z][A-Za-z0-9]*(\.[A-Za-z0-9_-]+)+$/

/** A built catalogue as Flown reads it, or null when it is not one; malformed entries are dropped (the key then shows English). */
export function readBuiltCatalogue(raw: unknown): BuiltCatalogue | null {
  if (!raw || typeof raw !== 'object' || Array.isArray(raw)) return null
  const r = raw as Record<string, unknown>
  if (!r.messages || typeof r.messages !== 'object' || Array.isArray(r.messages)) return null
  const messages: Record<string, string> = Object.create(null) as Record<string, string>
  for (const [k, v] of Object.entries(r.messages as Record<string, unknown>).slice(0, CATALOGUE_LIMITS.messages)) {
    if (KEY.test(k) && typeof v === 'string' && v.length <= CATALOGUE_LIMITS.length) messages[k] = v
  }
  const latn = Array.isArray(r.latn) ? r.latn.filter((k): k is string => typeof k === 'string' && KEY.test(k)) : []
  const user: Record<string, string[]> = Object.create(null) as Record<string, string[]>
  if (r.user && typeof r.user === 'object' && !Array.isArray(r.user)) {
    for (const [k, v] of Object.entries(r.user as Record<string, unknown>)) {
      if (KEY.test(k) && Array.isArray(v)) user[k] = v.filter((name): name is string => typeof name === 'string' && /^[A-Za-z_][A-Za-z0-9_]*$/.test(name))
    }
  }
  return { messages: { ...messages }, latn, user: { ...user } }
}
