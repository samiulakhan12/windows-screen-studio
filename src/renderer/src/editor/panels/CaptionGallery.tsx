/**
 * The style gallery (docs/design/captions-studio.md §2.5): filters, two rows and Show all, Play
 * and Delete beside the grid, hover preview after 300 ms; a radio group with a roving tabindex.
 *
 * CONTRACT (part P3): the signature is frozen; the body is to be written.
 */
import type { SavedLook } from '../../../../shared/captions/studioPresets'
import type { CaptionSettings, CaptionStudio } from '../../../../shared/types'

/** The body of a frozen signature part P3 writes. */
function notImplemented(name: string, ...args: unknown[]): never {
  void args
  throw new Error(`${name}: not implemented (Captions Studio part P3)`)
}

export function CaptionGallery(props: {
  value: CaptionSettings
  frame: { w: number; h: number }
  saved: readonly SavedLook[]
  brand: CaptionStudio | null
  suggested: string
  onPick(tile: string): void
  onPreview(tile: string | null): void
}): JSX.Element {
  return notImplemented('CaptionGallery', props)
}
