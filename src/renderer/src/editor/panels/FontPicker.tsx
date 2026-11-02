import { useEffect, useState } from 'react'
import type { AssetState } from '../../../../shared/api/assets'
import { catalogFamily, catalogFont, catalogId, CATALOG_FONTS, CATALOG_PREFIX, type CatalogFont, type FontCoverage } from '../../../../shared/captions/fontCatalog'
import { partnerFor } from '../../../../shared/captions/fontStack'
import { DEFAULT_FONT_LABEL, fontNameFromFile, fontOf, MAX_PROJECT_FONTS, newFontId } from '../../../../shared/render/fonts'
import type { Project, ProjectFont } from '../../../../shared/types'
import { fontState, loadCatalogFont, preloadProjectFont } from '../../render/fontLoader'
import { onStyleAssetsChanged } from '../../render/watermarkLayer'
import { useEditor } from '../context'
import { EditorIcon } from '../EditorIcon'
import { ipcMessage } from '../overlayItems'
import './fontPicker.css'

/** The brand kit's colours first, then `presets` (no repeats): the colour pickers of a title card. */
export function withBrandColors(project: Pick<Project, 'brand'>, presets: readonly string[]): string[] {
  const out = [...(project.brand?.colors ?? [])]
  for (const c of presets) if (!out.includes(c.toLowerCase())) out.push(c)
  return out
}

/** The name a font shows in the menus, saying when it is missing and what draws instead. */
export function fontLabel(font: ProjectFont, state: ReturnType<typeof fontState>): string {
  return state === 'missing' ? `${font.name} (missing: drawn with ${DEFAULT_FONT_LABEL})` : font.name
}

/* ---------- Captions Studio's font catalogue (docs/design/captions-studio.md §2.6, §6) ---------- */

/** How the menu names the letters a catalogue font has ("Latin · Cyrillic · Vietnamese"). */
const COVERAGE_WORDS: Partial<Record<FontCoverage, string>> = {
  latin: 'Latin',
  cyrillic: 'Cyrillic',
  greek: 'Greek',
  vietnamese: 'Vietnamese',
  bengali: 'Bengali',
  devanagari: 'Devanagari',
  arabic: 'Arabic',
  hebrew: 'Hebrew',
  thai: 'Thai',
  'han-sc': 'Chinese (Simplified)',
  'han-tc': 'Chinese (Traditional)',
  japanese: 'Japanese',
  korean: 'Korean'
}

/**
 * The letters a caption language needs, its name, and the script font that draws them when the
 * chosen one cannot (§6.6). Cyrillic and Vietnamese have none: the chosen font's own partner draws them.
 */
const LANGUAGE_LETTERS: Readonly<Record<string, { coverage: FontCoverage; name: string; partner?: string }>> = {
  bn: { coverage: 'bengali', name: 'Bengali', partner: 'noto-sans-bengali' },
  hi: { coverage: 'devanagari', name: 'Hindi', partner: 'noto-sans-devanagari' },
  mr: { coverage: 'devanagari', name: 'Marathi', partner: 'noto-sans-devanagari' },
  ar: { coverage: 'arabic', name: 'Arabic', partner: 'noto-sans-arabic' },
  ur: { coverage: 'arabic', name: 'Urdu', partner: 'noto-sans-arabic' },
  he: { coverage: 'hebrew', name: 'Hebrew', partner: 'noto-sans-hebrew' },
  th: { coverage: 'thai', name: 'Thai', partner: 'noto-sans-thai' },
  ru: { coverage: 'cyrillic', name: 'Russian' },
  uk: { coverage: 'cyrillic', name: 'Ukrainian' },
  vi: { coverage: 'vietnamese', name: 'Vietnamese' }
}

/** "Latin · Cyrillic · Vietnamese", and "One weight" for a single static weight. */
export function fontBadges(font: CatalogFont): { coverage: string; oneWeight: boolean } {
  const words = font.coverage.map((c) => COVERAGE_WORDS[c]).filter((w): w is string => !!w)
  return { coverage: words.join(' · '), oneWeight: Array.isArray(font.weights) && font.weights.length === 1 }
}

/**
 * "Doesn't have Bengali letters: Flown uses Hind Siliguri for them", or null when the font has the
 * language's letters. `bangla` is the look's Bangla font (§0.2), which draws the Bangla the font lacks.
 */
export function coverageNote(font: CatalogFont, language: string | undefined, bangla?: string): string | null {
  const need = language ? LANGUAGE_LETTERS[language.split('-')[0].toLowerCase()] : undefined
  if (!need || font.coverage.includes(need.coverage)) return null
  // The font the captions draw those letters with (Anton → Oswald for Russian), as partnerFor picks it.
  const own = need.coverage === 'bengali' ? catalogId(bangla) : null
  const partnerId = own ?? need.partner ?? catalogId(partnerFor(`${CATALOG_PREFIX}${font.id}`, [need.coverage]))
  const partner = (partnerId && catalogFont(partnerId)?.family) ?? 'another font'
  return `Doesn't have ${need.name} letters: Flown uses ${partner} for them`
}

/** "9.6 MB" (one decimal). */
export const megabytes = (bytes: number): string => `${(bytes / 1e6).toFixed(1)} MB`

/** The catalogue fonts the menu offers: bundled caption, script and Bangla fonts (not the emoji face), and the downloads. */
const MENU_FONTS = CATALOG_FONTS.filter((f) => f.group !== 'emoji')

/** Font downloads under way from a Font menu, by catalogue id: a menu shown again while one runs follows it to its end. */
const downloads = new Map<string, Promise<AssetState['state']>>()

/** Downloads catalogue font `id` (one download per id), then loads it. */
function downloadFont(id: string): Promise<AssetState['state']> {
  let run = downloads.get(id)
  if (!run) {
    run = window.api
      .downloadAsset(id)
      .then(async (done) => {
        // The preview asked for the font before it was on this PC and keeps it missing: load it now,
        // so the preview, the export dialog and the gallery draw with it (fontGeneration changes).
        if (done.state === 'ready') await loadCatalogFont(id)
        return done.state
      })
      .finally(() => downloads.delete(id))
    downloads.set(id, run)
  }
  return run
}

/** Download (with its size), progress and Cancel for a catalogue font that is not on this PC (§2.6, §6.4). */
function CatalogDownload({ font }: { font: CatalogFont }): JSX.Element | null {
  const [state, setState] = useState<AssetState['state'] | null>(null)
  const [progress, setProgress] = useState<{ received: number; total: number; retryAt?: number } | null>(null)
  const [error, setError] = useState<string | null>(null)
  useEffect(() => {
    let live = true
    const run = downloads.get(font.id)
    if (run) {
      // Shown again (another panel and back) while its download runs: follow it to its end.
      setState('downloading')
      run.then(
        (done) => live && setState(done),
        (err: unknown) => {
          if (!live) return
          setState('missing')
          setError(ipcMessage(err))
        }
      )
    } else {
      window.api.listAssets().then(
        (list) => live && setState(list.find((a) => a.id === font.id)?.state ?? 'missing'),
        () => live && setState('missing')
      )
    }
    const off = window.api.onAssetProgress((p) => {
      if (p.id === font.id) setProgress({ received: p.received, total: p.total, ...(p.retryAt ? { retryAt: p.retryAt } : {}) })
    })
    return () => {
      live = false
      off()
    }
  }, [font.id])
  if (state === null || state === 'ready') return null
  const download = async (): Promise<void> => {
    setError(null)
    setState('downloading')
    setProgress(null)
    try {
      setState(await downloadFont(font.id))
    } catch (err) {
      setState('missing')
      setError(ipcMessage(err))
    }
  }
  const size = megabytes(font.files.reduce((n, f) => n + f.bytes, 0))
  return (
    <div className="font-download" data-testid="font-download">
      {state === 'downloading' ? (
        <>
          <span className="hint" role="status">
            {progress?.retryAt
              ? `The download server is busy. Trying again at ${new Date(progress.retryAt).toLocaleTimeString()}.`
              : `Downloading ${font.family}: ${megabytes(progress?.received ?? 0)} of ${size}`}
          </span>
          <button type="button" className="btn" onClick={() => void window.api.cancelAssetDownload(font.id)}>
            Cancel
          </button>
        </>
      ) : (
        <>
          <span className="hint">{font.family} is not on this PC yet{font.download ? `: until it is, captions use ${font.download.until}` : ''}.</span>
          <button type="button" className="btn" onClick={() => void download()}>
            Download ({size})
          </button>
        </>
      )}
      {error && (
        <p className="callout" role="alert">
          <EditorIcon name="alert" size={16} />
          <span>{error}</span>
        </p>
      )}
    </div>
  )
}

/**
 * The Font menu of a text, a title card or the captions (docs/design/brand-kit.md §5): the default
 * font and the project's fonts, and beside it "Add font…", which copies a TTF, OTF or WOFF2 file
 * into the project and uses it. A button, not an entry of the menu: Windows changes a closed menu
 * on the arrow keys, which would open the file dialog while the user only looks through the fonts.
 * `apply` returns the project with font `id` (undefined: the default) set where this menu sets it,
 * so adding a font and using it is one undo step.
 *
 * With `catalogue` (captions, graphics and title cards, Captions Studio §2.6) the menu also has
 * the caption fonts (bundled), the brand fonts and the fonts to download, each named in its own
 * font; under it the chosen catalogue font's letters, "One weight", a note when it lacks the
 * caption `language`'s letters, and Download with progress for a font not on this PC. Text items
 * (TextPanel) do not pass it: their reader and drawer do not take `cat:` fonts.
 */
export function FontPicker({
  project,
  value,
  apply,
  label = 'Font',
  catalogue = false,
  language,
  bangla,
  testId = 'font-picker',
  defaultLabel
}: {
  project: Project
  value: string | undefined
  apply: (p: Project, id: string | undefined) => Project
  label?: string
  catalogue?: boolean
  /** The captions' language, for the coverage note. */
  language?: string
  /** The look's Bangla font (§0.2), which the coverage note names for Bangla. */
  bangla?: string
  testId?: string
  /** The first entry's name (default: "Default (Segoe UI)"). */
  defaultLabel?: string
}): JSX.Element {
  const { store } = useEditor()
  const [busy, setBusy] = useState(false)
  const [error, setError] = useState<string | null>(null)
  const [, setVersion] = useState(0)
  useEffect(() => onStyleAssetsChanged(() => setVersion((n) => n + 1)), [])
  const fonts = project.fonts ?? []
  const current = fontOf(fonts, value)
  const state = current ? fontState(project, current.id) : null
  const catId = catalogue ? catalogId(value) : null
  const cat = catId ? catalogFont(catId) : undefined
  const badges = cat ? fontBadges(cat) : null
  const note = cat ? coverageNote(cat, language, bangla) : null

  const addFont = async (): Promise<void> => {
    if (busy) return
    setBusy(true)
    setError(null)
    try {
      if (fonts.length >= MAX_PROJECT_FONTS) throw new Error(`This video already has ${MAX_PROJECT_FONTS} fonts.`)
      const picked = await window.api.pickAsset(project.id, 'font')
      if (!picked) return
      // The same file (stored once) is the same font.
      const same = (store.state.fonts ?? []).find((f) => f.file === picked.path)
      const font: ProjectFont = same ?? { id: newFontId(), name: fontNameFromFile(picked.name ?? picked.path), file: picked.path }
      await preloadProjectFont(project.id, font, picked.url)
      store.update((p) => apply(same ? p : { ...p, fonts: [...(p.fonts ?? []), font] }, font.id))
    } catch (err) {
      setError(ipcMessage(err))
    } finally {
      setBusy(false)
    }
  }

  return (
    <div className="font-picker">
      <div className="font-picker-row">
        <label className="field">
          <span>{label}</span>
          <select value={cat ? `${CATALOG_PREFIX}${cat.id}` : current ? current.id : ''} disabled={busy} data-testid={testId} onChange={(e) => store.update((p) => apply(p, e.target.value || undefined))}>
            <option value="">{defaultLabel ?? `Default (${DEFAULT_FONT_LABEL})`}</option>
            {catalogue ? (
              <>
                <optgroup label="Caption fonts">
                  {MENU_FONTS.filter((f) => f.bundled).map((f) => (
                    <option key={f.id} value={`${CATALOG_PREFIX}${f.id}`} style={{ fontFamily: `"${catalogFamily(f.id)}"` }}>
                      {f.family}
                    </option>
                  ))}
                </optgroup>
                {fonts.length > 0 && (
                  <optgroup label="Your brand fonts">
                    {fonts.map((f) => (
                      <option key={f.id} value={f.id}>
                        {fontLabel(f, fontState(project, f.id))}
                      </option>
                    ))}
                  </optgroup>
                )}
                <optgroup label="Download">
                  {MENU_FONTS.filter((f) => !f.bundled).map((f) => (
                    <option key={f.id} value={`${CATALOG_PREFIX}${f.id}`}>
                      {`${f.family} (${megabytes(f.files.reduce((n, x) => n + x.bytes, 0))})`}
                    </option>
                  ))}
                </optgroup>
              </>
            ) : (
              fonts.map((f) => (
                <option key={f.id} value={f.id}>
                  {fontLabel(f, fontState(project, f.id))}
                </option>
              ))
            )}
          </select>
        </label>
        {/* Not disabled while adding: the button keeps keyboard focus through the file dialog. */}
        <button type="button" className="btn" data-testid="font-add" title="Add a TTF, OTF or WOFF2 font file" onClick={() => void addFont()}>
          Add font…
        </button>
      </div>
      {busy && <span className="hint">Adding the font…</span>}
      {cat && badges && (
        <p className="font-badges hint" data-testid={`${testId}-badges`}>
          <span>{badges.coverage}</span>
          {badges.oneWeight && <span className="font-badge">One weight</span>}
        </p>
      )}
      {note && (
        <p className="hint" data-testid={`${testId}-coverage`}>
          {note}
        </p>
      )}
      {/* Keyed: another font gets its own row, never the state of one still downloading. */}
      {cat && !cat.bundled && <CatalogDownload key={cat.id} font={cat} />}
      {state === 'missing' && current && (
        <p className="callout" role="status" data-testid="font-missing">
          <EditorIcon name="alert" size={16} />
          <span>
            {current.name} could not be loaded, so this text is drawn with {DEFAULT_FONT_LABEL}. Add the font again to use it.
          </span>
        </p>
      )}
      {error && (
        <p className="callout" role="alert" data-testid="font-error">
          <EditorIcon name="alert" size={16} />
          <span>{error}</span>
        </p>
      )}
    </div>
  )
}
