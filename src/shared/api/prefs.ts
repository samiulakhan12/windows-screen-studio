/**
 * Editor preferences kept in userData/editor-prefs.json, by key. Captions Studio
 * (docs/design/captions-studio.md §4.6): saved caption looks, Make my captions great's options,
 * the Clean up choices and the word list.
 */
export type PrefKey =
  | 'stylePresets'
  | 'shortcuts'
  | 'polish'
  | 'captionPresets'
  | 'captionsGreat'
  | 'captionCleanup'
  | 'captionWordList'
  /** Smart tools (docs/design/smart-tools.md §4.7): the user's own prices, when to ask before a run, and the Guide, Find chapters and Short clips choices. */
  | 'aiPrices'
  | 'aiConfirm'
  | 'guide'
  | 'findChapters'
  | 'shortClips'
  /** Output and languages (docs/design/output-and-languages.md §4.4): the user's export presets and the UI language. */
  | 'exportPresets'
  | 'ui'
  /** Auto-blur (docs/design/auto-blur.md §4.5): Find's defaults, the names and never-hide lists, the colour of new covers, Show where covers are. */
  | 'privacy'

export interface PrefsApi {
  /** The stored value of `key`, or null when nothing was saved. */
  getPref(key: PrefKey): Promise<unknown>
  /** Stores `value` (any JSON) under `key`; null removes it. */
  setPref(key: PrefKey, value: unknown): Promise<void>
}

export const PREF_KEYS: readonly PrefKey[] = ['stylePresets', 'shortcuts', 'polish', 'captionPresets', 'captionsGreat', 'captionCleanup', 'captionWordList', 'aiPrices', 'aiConfirm', 'guide', 'findChapters', 'shortClips', 'exportPresets', 'ui', 'privacy']
