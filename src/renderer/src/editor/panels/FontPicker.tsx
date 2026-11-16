import { useEffect, useState } from 'react'
import type { AssetState } from '../../../../shared/api/assets'
import { catalogFamily, catalogFont, catalogId, CATALOG_FONTS, CATALOG_PREFIX, type CatalogFont, type FontCoverage } from '../../../../shared/captions/fontCatalog'
import { partnerFor } from '../../../../shared/captions/fontStack'
import { DEFAULT_FONT_LABEL, fontNameFromFile, fontOf, MAX_PROJECT_FONTS, newFontId } from '../../../../shared/render/fonts'
import { fmt } from '../../../../shared/i18n/fmt'
import type { Project, ProjectFont } from '../../../../shared/types'
import { fontState, loadCatalogFont, preloadProjectFont } from '../../render/fontLoader'
import { onStyleAssetsChanged } from '../../render/watermarkLayer'
import { useEditor } from '../context'
import { EditorIcon } from '../EditorIcon'
import { ipcMessage } from '../overlayItems'
import './fontPicker.css'
import { t, type MessageKey } from '../../../../shared/i18n/t'

/** The brand kit's colours first, then `presets` (no repeats): the colour pickers of a title card. */
export function withBrandColors(project: Pick<Project, 'brand'>, presets: readonly string[]): string[] {
  const out = [...(project.brand?.colors ?? [])]
  for (const c of presets) if (!out.includes(c.toLowerCase())) out.push(c)
  return out
}

/** The name a font shows in the menus, saying when it is missing and what draws instead. */
export function fontLabel(font: ProjectFont, state: ReturnType<typeof fontState>): string {
  return state === 'missing' ? t('text.fontPicker.missingFont', { name: font.name, fallback: DEFAULT_FONT_LABEL }) : font.name
}

/* ---------- Captions Studio's font catalogue (docs/design/captions-studio.md §2.6, §6) ---------- */

/** How the menu names the letters a catalogue font has ("Latin · Cyrillic · Vietnamese"). */
const COVERAGE_WORDS: Partial<Record<FontCoverage, MessageKey>> = {
  latin: 'text.fontPicker.script.latin',
  cyrillic: 'text.fontPicker.script.cyrillic',
  greek: 'text.fontPicker.script.greek',
  vietnamese: 'text.fontPicker.script.vietnamese',
  bengali: 'text.fontPicker.script.bengali',
  devanagari: 'text.fontPicker.script.devanagari',
  arabic: 'text.fontPicker.script.arabic',
  hebrew: 'text.fontPicker.script.hebrew',
  thai: 'text.fontPicker.script.thai',
  'han-sc': 'text.fontPicker.script.hanSc',
  'han-tc': 'text.fontPicker.script.hanTc',
  japanese: 'text.fontPicker.script.japanese',
  korean: 'text.fontPicker.script.korean'
}

/**
 * The letters a caption language needs, its name, and the script font that draws them when the
 * chosen one cannot (§6.6). Cyrillic and Vietnamese have none: the chosen font's own partner draws them.
 */
const LANGUAGE_LETTERS: Readonly<Record<string, { coverage: FontCoverage; name: MessageKey; partner?: string }>> = {
  bn: { coverage: 'bengali', name: 'text.fontPicker.letters.bn', partner: 'noto-sans-bengali' },
  hi: { coverage: 'devanagari', name: 'text.fontPicker.letters.hi', partner: 'noto-sans-devanagari' },
  mr: { coverage: 'devanagari', name: 'text.fontPicker.letters.mr', partner: 'noto-sans-devanagari' },
  ar: { coverage: 'arabic', name: 'text.fontPicker.letters.ar', partner: 'noto-sans-arabic' },
  ur: { coverage: 'arabic', name: 'text.fontPicker.letters.ur', partner: 'noto-sans-arabic' },
  he: { coverage: 'hebrew', name: 'text.fontPicker.letters.he', partner: 'noto-sans-hebrew' },
  th: { coverage: 'thai', name: 'text.fontPicker.letters.th', partner: 'noto-sans-thai' },
  ru: { coverage: 'cyrillic', name: 'text.fontPicker.letters.ru' },
  uk: { coverage: 'cyrillic', name: 'text.fontPicker.letters.uk' },
  vi: { coverage: 'vietnamese', name: 'text.fontPicker.letters.vi' }
}

/** "Latin · Cyrillic · Vietnamese", and "One weight" for a single static weight. */
export function fontBadges(font: CatalogFont): { coverage: string; oneWeight: boolean } {
  const words = font.coverage.map((c) => COVERAGE_WORDS[c]).filter((k): k is MessageKey => !!k).map((k) => t(k))
  return { coverage: words.join(' · '), oneWeight: Array.isArray(font.weights) && font.weights.length === 1 }
}

/** Letters a text may hold beyond its language's: its font's partner draws them (graphicNeeds, lookFont). */
const SCRIPT_LETTERS: readonly { test: RegExp; need: { coverage: FontCoverage; name: MessageKey } }[] = [
  { test: /\p{Script=Cyrillic}/u, need: { coverage: 'cyrillic', name: 'text.fontPicker.letters.cyrillic' } },
  { test: /\p{Script=Greek}/u, need: { coverage: 'greek', name: 'text.fontPicker.letters.greek' } }
]

/**
 * "Doesn't have Bengali letters: Flown uses Hind Siliguri for them", or null when the font has the
 * language's letters. `bangla` is the look's Bangla font (§0.2), which draws the Bangla the font lacks.
 * `letters` is the text drawn (a graphic's words): its own Cyrillic or Greek letters count too.
 */
export function coverageNote(font: CatalogFont, language: string | undefined, bangla?: string, letters = ''): string | null {
  const byLanguage = language ? LANGUAGE_LETTERS[language.split('-')[0].toLowerCase()] : undefined
  const needs: { coverage: FontCoverage; name: MessageKey; partner?: string }[] = byLanguage ? [byLanguage] : []
  for (const s of SCRIPT_LETTERS) if (s.test.test(letters) && !needs.some((n) => n.coverage === s.need.coverage)) needs.push(s.need)
  const need = needs.find((n) => !font.coverage.includes(n.coverage))
  if (!need) return null
  // The font the captions draw those letters with (Anton → Oswald for Russian), as partnerFor picks it
  // for every letter no script font draws.
  const own = need.coverage === 'bengali' ? catalogId(bangla) : null
  const walk = needs.filter((n) => !n.partner).map((n) => n.coverage)
  const partnerId = own ?? need.partner ?? catalogId(partnerFor(`${CATALOG_PREFIX}${font.id}`, walk))
  const partner = (partnerId && catalogFont(partnerId)?.family) ?? t('text.fontPicker.anotherFont')
  return t('text.fontPicker.lacksLetters', { letters: t(need.name), font: partner })
}

/** "9.6 MB" (one decimal). */
export const megabytes = (bytes: number): string => t('text.fontPicker.megabytes', { n: fmt.number(bytes / 1e6, { max: 1 }) })

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
              ? t('text.fontPicker.serverBusy', { time: fmt.time(progress.retryAt, 'seconds') })
              : t('text.fontPicker.downloadingOf', { family: font.family, received: megabytes(progress?.received ?? 0), size })}
          </span>
          <button type="button" className="btn" onClick={() => void window.api.cancelAssetDownload(font.id)}>
            {t('common.action.cancel')}
          </button>
        </>
      ) : (
        <>
          <span className="hint">{font.download ? t('text.fontPicker.notHereUntil', { family: font.family, until: font.download.until }) : t('text.fontPicker.notHere', { family: font.family })}</span>
          <button type="button" className="btn" onClick={() => void download()}>
            {t('text.fontPicker.download', { size })}
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
  label = t('text.fontPicker.font'),
  catalogue = false,
  language,
  letters,
  bangla,
  testId = 'font-picker',
  defaultLabel
}: {
  project: Project
  value: string | undefined
  apply: (p: Project, id: string | undefined) => Project
  label?: string
  catalogue?: boolean
  /** The captions' language (a graphic's: its words'), for the coverage note. */
  language?: string
  /** The text drawn, when its own letters may need more than its language's (a graphic's words), for the coverage note. */
  letters?: string
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
  const note = cat ? coverageNote(cat, language, bangla, letters) : null

  const addFont = async (): Promise<void> => {
    if (busy) return
    setBusy(true)
    setError(null)
    try {
      if (fonts.length >= MAX_PROJECT_FONTS) throw new Error(t('text.fontPicker.thisVideoAlreadyHas', { n: fmt.count(MAX_PROJECT_FONTS) }))
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
            <option value="">{defaultLabel ?? t('text.fontPicker.default', { font: DEFAULT_FONT_LABEL })}</option>
            {catalogue ? (
              <>
                <optgroup label={t('text.fontPicker.captionFonts')}>
                  {MENU_FONTS.filter((f) => f.bundled).map((f) => (
                    <option key={f.id} value={`${CATALOG_PREFIX}${f.id}`} style={{ fontFamily: `"${catalogFamily(f.id)}"` }}>
                      {f.family}
                    </option>
                  ))}
                </optgroup>
                {fonts.length > 0 && (
                  <optgroup label={t('text.fontPicker.yourBrandFonts')}>
                    {fonts.map((f) => (
                      <option key={f.id} value={f.id}>
                        {fontLabel(f, fontState(project, f.id))}
                      </option>
                    ))}
                  </optgroup>
                )}
                <optgroup label={t('text.fontPicker.downloadGroup')}>
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
        <button type="button" className="btn" data-testid="font-add" title={t('text.fontPicker.addATtfOtf')} onClick={() => void addFont()}>
          {t('text.fontPicker.addFont')}
        </button>
      </div>
      {busy && <span className="hint">{t('text.fontPicker.addingTheFont')}</span>}
      {cat && badges && (
        <p className="font-badges hint" data-testid={`${testId}-badges`}>
          <span>{badges.coverage}</span>
          {badges.oneWeight && <span className="font-badge">{t('text.fontPicker.oneWeight')}</span>}
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
            {t('text.fontPicker.notLoaded', { name: current.name, fallback: DEFAULT_FONT_LABEL })}
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
