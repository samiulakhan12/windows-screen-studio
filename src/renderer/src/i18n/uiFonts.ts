/**
 * The UI fonts of Bangla and Devanagari (docs/design/output-and-languages.md §12.1), registered with
 * FontFace from the caption fonts already bundled (the same `?url` imports as catalogFonts.ts, so
 * the build emits no new file and the CSP does not change). A face is used only where its family is
 * named: scripts.css names them in --font-sans, --font-display and --font-mono under :lang(bn) and
 * :lang(hi). Loading is bounded at 1 s; after that the fallback shows and the face arrives later.
 */
import type { UiLanguage } from '../../../shared/api/ui'
import notoSansBengali from '../../../../resources/fonts/noto-sans-bengali.woff2?url'
import notoSansDevanagari from '../../../../resources/fonts/noto-sans-devanagari.woff2?url'

/** The UI face of each language whose letters Segoe UI lacks: its family name and the bundled file. */
export const UI_FONTS: Readonly<Partial<Record<UiLanguage, { family: string; file: string; url: string }>>> = {
  bn: { family: 'Flown UI Bengali', file: 'noto-sans-bengali.woff2', url: notoSansBengali },
  hi: { family: 'Flown UI Devanagari', file: 'noto-sans-devanagari.woff2', url: notoSansDevanagari }
}

/** How long the first render waits for the face. */
export const UI_FONT_WAIT_MS = 1000

const added = new Map<string, FontFace>()

/** Loads the UI font of `language` (bounded at 1 s); true when it is ready, and for a language that needs none. */
export async function loadUiFont(language: UiLanguage): Promise<boolean> {
  const font = UI_FONTS[language]
  if (!font) return true
  if (typeof FontFace === 'undefined' || typeof document === 'undefined' || !document.fonts) return false
  let face = added.get(font.family)
  if (!face) {
    // Noto Sans Bengali and Devanagari are variable fonts, weights 100 to 900.
    face = new FontFace(font.family, `url("${font.url}")`, { weight: '100 900', style: 'normal' })
    document.fonts.add(face)
    added.set(font.family, face)
  }
  let timer: ReturnType<typeof setTimeout> | undefined
  try {
    const late = new Promise<never>((_, reject) => {
      timer = setTimeout(() => reject(new Error('The UI font took too long')), UI_FONT_WAIT_MS)
    })
    await Promise.race([face.load(), late])
    return true
  } catch {
    return false
  } finally {
    clearTimeout(timer)
  }
}
