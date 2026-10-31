/**
 * Editor preferences kept in userData/editor-prefs.json, by key. Captions Studio
 * (docs/design/captions-studio.md §4.6): saved caption looks, Make my captions great's options,
 * the Clean up choices and the word list.
 */
export type PrefKey = 'stylePresets' | 'shortcuts' | 'polish' | 'captionPresets' | 'captionsGreat' | 'captionCleanup' | 'captionWordList'

export interface PrefsApi {
  /** The stored value of `key`, or null when nothing was saved. */
  getPref(key: PrefKey): Promise<unknown>
  /** Stores `value` (any JSON) under `key`; null removes it. */
  setPref(key: PrefKey, value: unknown): Promise<void>
}

export const PREF_KEYS: readonly PrefKey[] = ['stylePresets', 'shortcuts', 'polish', 'captionPresets', 'captionsGreat', 'captionCleanup', 'captionWordList']
