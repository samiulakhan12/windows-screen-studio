/**
 * Your presets in the export dialog (docs/design/output-and-languages.md §2.2): the cards, their More
 * menus, renaming, deleting, saving to and importing from files, and the Save as preset field.
 * Part P5 writes them; the stubs render nothing.
 */
import type { BundleOptions } from '../../../shared/render/exportBundle'
import type { ExportOptions } from '../../../shared/render/exportPresets'
import type { UserExportPreset, UserPresetStore } from '../../../shared/render/userPresets'

export function UserPresets(props: {
  store: UserPresetStore
  selected: string | null
  options: ExportOptions
  bundle: Omit<BundleOptions, 'languages'>
  onPick: (p: UserExportPreset) => void
  onStore: (s: UserPresetStore) => void
  batch?: { checked: readonly string[]; onToggle: (id: string) => void }
}): JSX.Element {
  void props
  return <></>
}

export function SavePresetField(props: { suggestion: string; taken: readonly string[]; onSave: (name: string) => void; onCancel: () => void }): JSX.Element {
  void props
  return <></>
}
