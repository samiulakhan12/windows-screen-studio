/**
 * Saved caption looks (prefs `captionPresets`, docs/design/captions-studio.md §5.7): shared by
 * every project; saving or deleting one is not a project change.
 *
 * CONTRACT (part P3): the signature is frozen; the body is to be written.
 */
import type { SavedLook } from '../../../shared/captions/studioPresets'
import type { CaptionStudio } from '../../../shared/types'

/** The body of a frozen signature part P3 writes. */
function notImplemented(name: string, ...args: unknown[]): never {
  void args
  throw new Error(`${name}: not implemented (Captions Studio part P3)`)
}

export function useSavedLooks(): { looks: readonly SavedLook[]; save(name: string, look: CaptionStudio): Promise<void>; remove(id: string): Promise<void> } {
  return notImplemented('useSavedLooks')
}
