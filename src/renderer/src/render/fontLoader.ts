/**
 * Loads a project's fonts (docs/design/brand-kit.md §4.3) without widening the content security
 * policy: the bytes are fetched from studio-media:// (allowed by connect-src) and registered with
 * `new FontFace(family, bytes)`, which does no font fetch of its own. Chromium's font sanitiser
 * checks each face; one that fails stays "missing" and its text draws with the default font.
 *
 * Text layers cache measured widths and drawn sprites: they put fontGeneration() in their keys,
 * so everything measured while a font was still loading is measured again once it is ready.
 */
import { assetFontFile } from '../../../shared/api/assets'
import { burnedSegments } from '../../../shared/captions/captionTracks'
import { catalogFamily, catalogFont, catalogId, type CatalogFile, type CatalogFont } from '../../../shared/captions/fontCatalog'
import { STUDIO_BASE } from '../../../shared/captions/studioPresets'
import { fontFamily, fontOf, fontStack } from '../../../shared/render/fonts'
import { MEDIA_SCHEME, mediaUrl } from '../../../shared/mediaUrl'
import type { Graphic, Project, ProjectFont, TitleCard } from '../../../shared/types'
import { BUNDLED_FONT_URLS } from './catalogFonts'
import { notifyStyleAssetsChanged } from './watermarkLayer'

export type FontState = 'loading' | 'ready' | 'missing'

interface Entry {
  state: FontState
  face: FontFace | null
  done: Promise<void>
}

const entries = new Map<string, Entry>()
let generation = 0
let currentProject: string | null = null

const keyOf = (projectId: string, font: ProjectFont): string => `${projectId}/${font.id}/${font.file}`

/** Increments whenever a font finishes loading or fails: a part of every text cache key. */
export const fontGeneration = (): number => generation

function changed(): void {
  generation++
  notifyStyleAssetsChanged()
}

/** Forgets the fonts of other projects (one editor is open at a time). */
function switchProject(projectId: string): void {
  if (currentProject === projectId) return
  currentProject = projectId
  for (const [key, e] of entries) {
    if (key.startsWith(`${projectId}/`)) continue
    if (e.face && typeof document !== 'undefined') document.fonts.delete(e.face)
    entries.delete(key)
  }
}

async function loadFace(url: string, family: string): Promise<FontFace> {
  const res = await fetch(url)
  if (!res.ok) throw new Error(`The font file is missing (${res.status})`)
  const face = new FontFace(family, await res.arrayBuffer())
  await face.load()
  return face
}

function load(projectId: string, font: ProjectFont, url: string): Entry {
  const key = keyOf(projectId, font)
  const entry: Entry = { state: 'loading', face: null, done: Promise.resolve() }
  entries.set(key, entry)
  entry.done = loadFace(url, fontFamily(font.id)).then(
    (face) => {
      if (entries.get(key) !== entry) return
      document.fonts.add(face)
      entry.face = face
      entry.state = 'ready'
      changed()
    },
    (err: unknown) => {
      if (entries.get(key) !== entry) return
      entry.state = 'missing'
      console.warn(`Font ${font.name} (${font.file}) could not be loaded; its text uses the default font:`, err)
      changed()
    }
  )
  return entry
}

function entryOf(projectId: string, font: ProjectFont, url?: string): Entry | null {
  if (typeof FontFace === 'undefined' || typeof document === 'undefined') return null
  switchProject(projectId)
  return entries.get(keyOf(projectId, font)) ?? load(projectId, font, url ?? mediaUrl(projectId, font.file))
}

/**
 * The font stack text with font `id` draws with (shared fontStack), starting to load the font
 * the first time it is asked for: the preview draws with the default font until it is ready,
 * then repaints. The export waits for it first (prepareProjectFonts).
 */
export function projectFontStack(project: Pick<Project, 'id' | 'fonts'>, id: unknown, fallback: string): string {
  const font = fontOf(project.fonts, id)
  if (font) entryOf(project.id, font)
  return fontStack(project.fonts, id, fallback)
}

/** Starts loading every font of the project (cached: a second call costs nothing). */
export function ensureProjectFonts(project: Pick<Project, 'id' | 'fonts'>): void {
  for (const f of project.fonts ?? []) entryOf(project.id, f)
}

/** Whether font `id` of the project draws: loading, ready, or missing (drawn with the default font). Null for no font. */
export function fontState(project: Pick<Project, 'id' | 'fonts'>, id: unknown): FontState | null {
  const font = fontOf(project.fonts, id)
  if (!font) return null
  return entryOf(project.id, font)?.state ?? 'missing'
}

/**
 * Loads a font newly copied into the project before the project uses it. Rejects when it
 * cannot be read (the project is then left unchanged). A font that failed before is read again:
 * its file may be back under the same name.
 */
export async function preloadProjectFont(projectId: string, font: ProjectFont, url?: string): Promise<void> {
  if (entries.get(keyOf(projectId, font))?.state === 'missing') entries.delete(keyOf(projectId, font))
  const entry = entryOf(projectId, font, url)
  if (!entry) return
  await entry.done
  if (entry.state !== 'ready') throw new Error('This font could not be read.')
}

/**
 * Ids of the fonts text uses: annotations, title cards and captions; and the brand fonts of a
 * Captions Studio look (text and emphasis) and of graphics (captions-studio.md §6.8).
 */
export function usedFontIds(project: Pick<Project, 'annotations' | 'titles' | 'captions' | 'fonts' | 'graphics'>): string[] {
  const ids = new Set<string>()
  for (const a of project.annotations) if (a.font) ids.add(a.font)
  for (const c of project.titles ?? []) if (c.font) ids.add(c.font)
  if (project.captions?.font) ids.add(project.captions.font)
  for (const id of studioBrandIds(project)) ids.add(id)
  return [...ids].filter((id) => !!fontOf(project.fonts, id))
}

/** Waits for every font text uses (export: before the first frame). Never rejects. */
export async function prepareProjectFonts(project: Project): Promise<void> {
  const waits: Promise<void>[] = []
  for (const id of usedFontIds(project)) {
    const e = entryOf(project.id, fontOf(project.fonts, id)!)
    if (e) waits.push(e.done)
  }
  await Promise.all(waits)
}

/** Fonts text uses that could not be loaded (drawn with the default font): for the export dialog. */
export function missingFonts(project: Project): ProjectFont[] {
  return usedFontIds(project)
    .map((id) => fontOf(project.fonts, id)!)
    .filter((f) => entries.get(keyOf(project.id, f))?.state === 'missing')
}


/* ---------- Captions Studio's catalogue fonts (docs/design/captions-studio.md §6.5–6.8) ---------- */

/**
 * Catalogue fonts are app assets, not project files: one entry per id for the whole session
 * (bundled files load in a few ms each; a downloaded one when it is on disk). They are registered
 * as FlownCat-<id>, with the descriptors of the catalogue, so a system font of the same name never
 * takes their place and a weight is never faked.
 */
const catalogEntries = new Map<string, Entry>()

/** The family a brand font is registered under a second time for Studio looks and graphics (§6.7). */
export const studioBrandFamily = (id: string): string => `FlownFontW-${id}`

/** Where a downloaded catalogue font is read from: studio-media://assets/<file> (never url(), §6.5). */
const assetUrl = (id: string): string => `${MEDIA_SCHEME}://assets/${encodeURIComponent(assetFontFile(id))}`

/** The FontFace descriptors of one file of `font` (§6.5): a static file its weight, a variable font its ranges. */
export function catalogDescriptors(font: CatalogFont, file: CatalogFile): FontFaceDescriptors {
  const d: FontFaceDescriptors = {}
  const w = font.weights
  if (file.weight) d.weight = String(file.weight)
  else if (Array.isArray(w)) d.weight = String(w[0] ?? 400)
  else {
    const range = w as { min: number; max: number }
    d.weight = range.min === range.max ? String(range.min) : `${range.min} ${range.max}`
  }
  if (font.stretch) d.stretch = `${font.stretch.min}% ${font.stretch.max}%`
  return d
}

/** One FontFace per file of `font` (Poppins: three under one family). */
async function catalogFaces(font: CatalogFont): Promise<FontFace[]> {
  const family = catalogFamily(font.id)
  const faces: FontFace[] = []
  for (const file of font.files) {
    let face: FontFace
    if (font.bundled) {
      // Same origin (a Vite asset): the CSP's default-src 'self' covers the font fetch.
      const url = file.woff2 ? BUNDLED_FONT_URLS[file.woff2.file] : undefined
      if (!url) throw new Error(`The bundled font file ${file.woff2?.file ?? font.id} is missing from this build`)
      face = new FontFace(family, `url("${url}")`, catalogDescriptors(font, file))
    } else {
      // A download: its bytes, read through studio-media://assets/ (checked by SHA-256 when it was saved).
      const res = await fetch(assetUrl(font.id))
      if (!res.ok) throw new Error(`not downloaded (${res.status})`)
      face = new FontFace(family, await res.arrayBuffer(), catalogDescriptors(font, file))
    }
    await face.load()
    faces.push(face)
  }
  return faces
}

function loadCatalogEntry(font: CatalogFont): Entry {
  const entry: Entry = { state: 'loading', face: null, done: Promise.resolve() }
  catalogEntries.set(font.id, entry)
  entry.done = catalogFaces(font).then(
    (faces) => {
      if (catalogEntries.get(font.id) !== entry) return
      for (const f of faces) document.fonts.add(f)
      entry.face = faces[0] ?? null
      entry.state = 'ready'
      changed()
    },
    (err: unknown) => {
      if (catalogEntries.get(font.id) !== entry) return
      entry.state = 'missing'
      // A download not made yet is expected; a bundled file that fails is not.
      if (font.bundled) console.warn(`Caption font ${font.family} could not be loaded; its text uses the next font:`, err)
      changed()
    }
  )
  return entry
}

/** The catalogue entry of `id`, loading it the first time (no retry of a font that is missing). */
function catalogEntry(id: string): Entry | null {
  if (typeof FontFace === 'undefined' || typeof document === 'undefined') return null
  const font = catalogFont(id)
  if (!font) return null
  return catalogEntries.get(id) ?? loadCatalogEntry(font)
}

/**
 * Starts loading catalogue font `id` the first time it is asked for, as the preview does (no retry
 * of a font that is missing: drawing again must not fetch it again and bump fontGeneration, which
 * would draw again, for ever). The gallery's thumbnails use it.
 */
export function ensureCatalogFont(id: string): void {
  catalogEntry(id)
}

/**
 * Registers catalogue font `id` as FlownCat-<id> (a bundled file, or a download's bytes) and
 * resolves when it is ready or missing; never rejects. A font that was missing is tried again
 * (a download may have finished since): the export, and the Font menu once a download is done.
 */
export function loadCatalogFont(id: string): Promise<void> {
  if (catalogEntries.get(id)?.state === 'missing') catalogEntries.delete(id)
  return catalogEntry(id)?.done ?? Promise.resolve()
}

/** Whether catalogue font `id` is registered and drawable (a download: on disk and loaded). */
export function catalogFontReady(id: string): boolean {
  return catalogEntries.get(id)?.state === 'ready'
}

/* ---------- which catalogue fonts a project draws with (§6.8) ---------- */

/** The bundled script font of each script (§6.6, step 1), by the Unicode script of a letter. */
const SCRIPT_FONTS: readonly [RegExp, string][] = [
  [/\p{Script=Bengali}/u, 'noto-sans-bengali'],
  [/\p{Script=Devanagari}/u, 'noto-sans-devanagari'],
  [/\p{Script=Arabic}/u, 'noto-sans-arabic'],
  [/\p{Script=Hebrew}/u, 'noto-sans-hebrew'],
  [/\p{Script=Thai}/u, 'noto-sans-thai']
]
const BENGALI = /\p{Script=Bengali}/u
const DEVANAGARI = /\p{Script=Devanagari}/u
const HAN = /\p{Script=Han}/u
const KANA = /[\p{Script=Hiragana}\p{Script=Katakana}]/u
const HANGUL = /\p{Script=Hangul}/u
/** Letters a Latin-1 font may lack: Latin Extended, Vietnamese, Greek and Cyrillic (§6.6, step 2). */
const BEYOND_LATIN1 = /[Ā-ɏḀ-ỿͰ-ϿЀ-ӿ]/u
const PARTNER_LANGUAGES = new Set(['vi', 'ru', 'uk', 'pl', 'tr'])

/** The downloadable CJK font of a language (§6.4), else of the script found. */
function cjkFont(language: string | undefined, text: string): string | null {
  const lang = language ?? ''
  for (const id of ['noto-sans-tc', 'noto-sans-sc', 'noto-sans-jp', 'noto-sans-kr']) {
    if (catalogFont(id)?.download?.languages.some((l) => l === lang || (l.length > 2 && lang.startsWith(l)))) return HAN.test(text) || KANA.test(text) || HANGUL.test(text) ? id : null
  }
  if (KANA.test(text)) return 'noto-sans-jp'
  if (HANGUL.test(text)) return 'noto-sans-kr'
  if (HAN.test(text)) return lang.startsWith('zh-Hant') || lang === 'zh-TW' || lang === 'zh-HK' ? 'noto-sans-tc' : 'noto-sans-sc'
  return null
}

/** The texts a graphic draws (keyword, list title and items, counter label, prefix and suffix). */
function graphicTexts(g: Graphic): string[] {
  if (g.kind === 'keyword') return [g.text]
  if (g.kind === 'list') return [g.title ?? '', ...g.items.map((i) => i.text)]
  if (g.kind === 'counter') return [g.prefix, g.suffix, g.label ?? '']
  return []
}

/** The brand font ids (ProjectFont ids) of the Studio look and the graphics (FlownFontW-, §6.7). */
function studioBrandIds(project: Pick<Project, 'captions' | 'graphics' | 'fonts'>): string[] {
  const ids = new Set<string>()
  const studio = project.captions?.studio
  const add = (font: string | undefined): void => {
    if (font && fontOf(project.fonts, font)) ids.add(font)
  }
  if (studio) {
    add(studio.text.font)
    add(studio.emphasis.font)
  }
  for (const g of project.graphics ?? []) add(g.font)
  return [...ids]
}

/** Title cards drawn with catalogue fonts: those given a `cat:` font, and quote cards (§10.1). */
const QUOTE_FONT = 'instrument-serif-italic'
const titleCatalogId = (c: TitleCard): string | null => catalogId(c.font) ?? (c.style === 'quote' ? QUOTE_FONT : null)

const fontsFor = new WeakMap<Project, string[]>()

/**
 * The catalogue fonts the project draws with (§6.8): the Studio look's text, emphasis and Bangla
 * fonts; every graphic's font (a graphic without one takes the look's); the catalogue fonts of
 * title cards (a quote card's Instrument Serif Italic); the script fonts of the scripts in the
 * burned-in captions (with a Studio look), the graphics and those title cards; the partners of the
 * look's fonts when the language needs letters they lack; the downloadable CJK font of the language;
 * and the colour emoji face whenever the project has a Studio look or any graphic (never found by
 * scanning for emoji: keycaps and FE0F sequences have no script).
 */
export function catalogFontsFor(project: Project): string[] {
  const hit = fontsFor.get(project)
  if (hit) return hit
  const ids = new Set<string>()
  const add = (font: string | undefined): void => {
    const id = catalogId(font)
    if (id) ids.add(id)
  }
  const studio = project.captions?.studio
  const language = project.captions?.track ?? project.transcript?.language
  const texts: string[] = []
  if (studio) {
    add(studio.text.font)
    add(studio.emphasis.font)
    for (const seg of burnedSegments(project)) texts.push(seg.text)
  }
  const graphics = project.graphics ?? []
  for (const g of graphics) {
    // A graphic without a font takes the look's (Subtitle's on a legacy look).
    add(g.font ?? studio?.text.font ?? STUDIO_BASE.text.font)
    texts.push(...graphicTexts(g))
  }
  for (const c of project.titles ?? []) {
    const id = titleCatalogId(c)
    if (!id) continue
    ids.add(id)
    texts.push(c.title, c.subtitle ?? '')
  }
  const text = texts.join('\n')
  for (const [re, id] of SCRIPT_FONTS) if (re.test(text)) ids.add(id)
  if (studio && BENGALI.test(text)) {
    // The look's Bangla font (§0.2), or Baloo Da 2 for heavy looks without one (§6.6).
    const bn = studio.text.scripts?.bengali
    if (bn) add(bn.font)
    else if (studio.text.weight >= 700) ids.add('baloo-da-2')
  }
  if (DEVANAGARI.test(text) && (language === 'hi' || language === 'mr')) ids.add('poppins')
  const cjk = cjkFont(language, text)
  if (cjk) ids.add(cjk)
  if (studio && (BEYOND_LATIN1.test(text) || PARTNER_LANGUAGES.has((language ?? '').slice(0, 2)))) {
    for (const f of [studio.text.font, studio.emphasis.font]) {
      const partner = catalogFont(catalogId(f) ?? '')?.partner
      if (partner) ids.add(partner)
    }
  }
  if (studio || graphics.length) ids.add('noto-color-emoji')
  const out = [...ids].filter((id) => !!catalogFont(id)).sort()
  fontsFor.set(project, out)
  return out
}

/* ---------- brand fonts again, for Studio looks (§6.7) ---------- */

const studioKeyOf = (projectId: string, font: ProjectFont): string => `${projectId}/studio/${font.id}/${font.file}`

/** A brand font registered a second time as FlownFontW-<id> with the font's own weights, so a variable font draws its heavier weights. */
async function loadStudioFace(url: string, family: string): Promise<FontFace> {
  const res = await fetch(url)
  if (!res.ok) throw new Error(`The font file is missing (${res.status})`)
  const bytes = await res.arrayBuffer()
  let face: FontFace
  try {
    face = new FontFace(family, bytes, { weight: 'auto' })
  } catch {
    // 'auto' (the font's own range) is newer CSS: a range covering every weight is the same for a static file.
    face = new FontFace(family, bytes, { weight: '1 1000' })
  }
  await face.load()
  return face
}

function studioEntryOf(projectId: string, font: ProjectFont): Entry | null {
  if (typeof FontFace === 'undefined' || typeof document === 'undefined') return null
  switchProject(projectId)
  const key = studioKeyOf(projectId, font)
  const hit = entries.get(key)
  if (hit) return hit
  const entry: Entry = { state: 'loading', face: null, done: Promise.resolve() }
  entries.set(key, entry)
  entry.done = loadStudioFace(mediaUrl(projectId, font.file), studioBrandFamily(font.id)).then(
    (face) => {
      if (entries.get(key) !== entry) return
      document.fonts.add(face)
      entry.face = face
      entry.state = 'ready'
      changed()
    },
    (err: unknown) => {
      if (entries.get(key) !== entry) return
      entry.state = 'missing'
      console.warn(`Font ${font.name} (${font.file}) could not be loaded for captions; their text uses the next font:`, err)
      changed()
    }
  )
  return entry
}

const started = new WeakSet<Project>()

/**
 * Starts loading what the project's captions, graphics and title cards draw with (cached per
 * project object, so drawing a frame costs nothing): the preview draws with the next font of the
 * stack until a face is ready, then repaints (fontGeneration changes).
 */
export function ensureCaptionFonts(project: Project): void {
  if (started.has(project)) return
  started.add(project)
  for (const id of catalogFontsFor(project)) catalogEntry(id)
  for (const id of studioBrandIds(project)) {
    const font = fontOf(project.fonts, id)
    if (font) studioEntryOf(project.id, font)
  }
}

/**
 * Waits for the catalogue faces and the FlownFontW- faces the project needs (the export, before
 * its first frame, beside prepareProjectFonts). Never rejects: a face that cannot load is drawn
 * with the next font of its stack and named by missingCatalogFonts or missingFonts.
 */
export async function prepareCaptionFonts(project: Project): Promise<void> {
  try {
    const waits: Promise<void>[] = catalogFontsFor(project).map((id) => loadCatalogFont(id))
    for (const id of studioBrandIds(project)) {
      const font = fontOf(project.fonts, id)
      const e = font ? studioEntryOf(project.id, font) : null
      if (e) waits.push(e.done)
    }
    await Promise.all(waits)
  } catch (err) {
    console.warn('Caption fonts could not be prepared; their text uses the next font:', err)
  }
}

/** Catalogue fonts the project needs that are not there (a download not made, or a file that failed): the export dialog's missing-font note. */
export function missingCatalogFonts(project: Project): CatalogFont[] {
  return catalogFontsFor(project)
    .filter((id) => catalogEntries.get(id)?.state === 'missing')
    .map((id) => catalogFont(id)!)
}
