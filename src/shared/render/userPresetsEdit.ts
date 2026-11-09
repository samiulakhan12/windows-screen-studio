/**
 * Saving, renaming, updating, deleting and importing the user's export presets
 * (docs/design/output-and-languages.md §2.2). Pure: the dialog stores the result in the
 * `exportPresets` preference. Part P5 writes it; the contracts' stubs change nothing.
 */
import type { BundleOptions } from './exportBundle'
import type { ExportOptions } from './exportPresets'
import type { UserExportPreset, UserPresetStore } from './userPresets'

/** The store with a new preset `name` of `options` and `bundle`. Part P5. */
export function savePreset(store: UserPresetStore, name: string, options: ExportOptions, bundle: Omit<BundleOptions, 'languages'> | undefined, now: number, random: () => number): UserPresetStore {
  void name
  void options
  void bundle
  void now
  void random
  return store
}

/** The store with preset `id` renamed. Part P5. */
export function renamePreset(store: UserPresetStore, id: string, name: string): UserPresetStore {
  void id
  void name
  return store
}

/** The store with preset `id` holding `options` and `bundle`. Part P5. */
export function updatePreset(store: UserPresetStore, id: string, options: ExportOptions, bundle: Omit<BundleOptions, 'languages'> | undefined): UserPresetStore {
  void id
  void options
  void bundle
  return store
}

/** The store without preset `id`. Part P5. */
export function deletePreset(store: UserPresetStore, id: string): UserPresetStore {
  void id
  return store
}

/** The store with `incoming` added under new ids and free names, up to the limit. Part P5. */
export function importPresets(store: UserPresetStore, incoming: readonly UserExportPreset[], now: number, random: () => number): { store: UserPresetStore; added: number; skipped: number } {
  void incoming
  void now
  void random
  return { store, added: 0, skipped: 0 }
}

/** A name built from the settings: "MOV CineForm 1080p30". Part P5. */
export function suggestName(o: ExportOptions): string {
  void o
  return ''
}

/** `name`, or `name (2)`, `(3)` … when taken (compared in NFC). Part P5. */
export function uniqueName(taken: readonly string[], name: string): string {
  void taken
  return name
}
