/** Editor preferences kept in userData/editor-prefs.json, by key. */
export type PrefKey = 'stylePresets' | 'shortcuts'

export interface PrefsApi {
  /** The stored value of `key`, or null when nothing was saved. */
  getPref(key: PrefKey): Promise<unknown>
  /** Stores `value` (any JSON) under `key`; null removes it. */
  setPref(key: PrefKey, value: unknown): Promise<void>
}

export const PREF_KEYS: readonly PrefKey[] = ['stylePresets', 'shortcuts']
