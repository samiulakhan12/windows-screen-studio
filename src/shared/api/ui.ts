/**
 * The UI language (docs/design/output-and-languages.md §9.4, §21.0): which language Flown shows, the
 * digits it writes numbers with, whether Home may offer a language, relaunching to switch, and
 * confirmations in the UI language. Frozen by the contracts.
 */

export type UiLanguage = 'en' | 'bn' | 'es' | 'hi'

/** The `ui` preference: absent fields mean English, the locale's own digits, nothing offered or seen yet. */
export interface UiPrefs {
  language?: 'system' | UiLanguage
  digits?: 'native' | 'western'
  offered?: UiLanguage[]
  seen?: UiLanguage[]
}

export interface UiInfo {
  language: UiLanguage
  formatLocale: string
  dir: 'ltr' | 'rtl'
  digits: 'native' | 'western'
  /** The language "Follow Windows" gives now. */
  system: UiLanguage
  /** A shipped language Home may offer once (§2.7), or null. */
  offer: UiLanguage | null
  shipped: UiLanguage[]
  /** Shipped languages shown as a preview (§0 decision 11). */
  preview: UiLanguage[]
  prefs: UiPrefs
  /** The project to open after a relaunch from the editor; given once. */
  reopen: string | null
  /**
   * The renderer's catalogue of `language`, only in an unpackaged build started with
   * SSW_I18N_CATALOGUE_DIR (the language tests and the reviewers' pack, §23.4) or with
   * FLOWN_I18N_PSEUDO (a pseudo-locale from scripts/i18n/pseudo/, §16.3); absent otherwise, when the
   * renderer loads its built catalogue itself.
   */
  catalogue?: { messages: Record<string, string>; latn: string[]; user: Record<string, string[]> }
}

export type RelaunchResult = { ok: true } | { ok: false; reason: string }

export interface UiApi {
  uiInfo(): Promise<UiInfo>
  setUiPrefs(prefs: UiPrefs): Promise<void>
  /** Relaunches unless work would be lost (§9.4); the editor saves first and its project reopens. */
  relaunch(reopenProjectId?: string): Promise<RelaunchResult>
  /** Records that the user works in `language` (a project with captions or a transcript in it was opened). */
  noteLanguageSeen(language: UiLanguage): Promise<void>
  /** A confirmation in the UI language, its buttons named by the caller (§9.6); true when the action was chosen. */
  confirm(request: { message: string; action: string; cancel: string }): Promise<boolean>
}

/** Every UI language, in the order of UiLanguage. */
export const UI_LANGUAGES: readonly UiLanguage[] = ['en', 'bn', 'es', 'hi']
