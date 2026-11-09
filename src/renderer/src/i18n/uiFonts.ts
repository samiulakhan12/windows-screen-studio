/**
 * The UI fonts of Bangla and Devanagari (docs/design/output-and-languages.md §12.1), registered with
 * FontFace from the caption fonts already bundled, so the build emits no new file. Part P6; the stub
 * loads nothing.
 */
import type { UiLanguage } from '../../../shared/api/ui'

/** Loads the UI font of `language` (bounded at 1 s); true when it is ready. Part P6. */
export async function loadUiFont(language: UiLanguage): Promise<boolean> {
  void language
  return false
}
