/**
 * The phone regions Find can add (docs/design/auto-blur.md §2.5): every region the vendored phone
 * metadata knows (two capital letters), and the ones always on for this PC and UI language. Pure.
 */
import { LANGUAGE_REGION } from './detect/tables'
import metadata from './vendor/libphonenumber/metadata.max.json.js'

let all: readonly string[] | null = null

/** Every region of the phone metadata, as ISO 3166-1 alpha-2 codes, sorted by code. */
export function phoneRegionCodes(): readonly string[] {
  all ??= Object.freeze(Object.keys(metadata.countries).filter((r) => /^[A-Z]{2}$/.test(r)).sort())
  return all
}

/** The regions always on (§2.5): the PC's (from Windows' format locale) and the UI language's, each once, when the metadata knows them. */
export function alwaysOnRegions(pcRegion: string | null, uiLanguage: string): string[] {
  const known = new Set(phoneRegionCodes())
  const out: string[] = []
  for (const r of [pcRegion, LANGUAGE_REGION[uiLanguage.toLowerCase().split(/[-_]/)[0]]]) if (r && known.has(r) && !out.includes(r)) out.push(r)
  return out
}

/** A region's name in `locale` (Intl's region names), or its code when the runtime has none. */
export function regionName(code: string, locale: string): string {
  try {
    return new Intl.DisplayNames([locale], { type: 'region' }).of(code) ?? code
  } catch {
    return code
  }
}
