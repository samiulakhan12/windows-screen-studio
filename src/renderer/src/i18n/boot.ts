/**
 * The renderer's UI language at start (docs/design/output-and-languages.md §9.4 step 4): one ui:info
 * call, then for a non-English language its catalogue chunk and UI font, setCatalogue, the canvases'
 * language and `<html lang dir>`, bounded at 1.5 s and English on any failure (the reason goes to
 * the log), never a blank window. English loads nothing and changes nothing on the page.
 *
 * - The recording bar (Toolbar.*, the other account's) stays English and asks nothing (§9.5).
 * - The built catalogues (`src/shared/i18n/built/<lang>.json`) are separate chunks, loaded only for
 *   the UI language; none exists until a language ships. An unpackaged test build may hand the
 *   catalogue over with ui:info instead (SSW_I18N_CATALOGUE_DIR).
 * - After a relaunch from the editor, its project opens again once (reopenAfterRelaunch); the
 *   project the editor has open is what Restart now asks to reopen (editorProjectToReopen).
 */
import type { UiInfo, UiLanguage } from '../../../shared/api/ui'
import { languageOf, readBuiltCatalogue, type BuiltCatalogue } from '../../../shared/i18n/locale'
import { setCatalogue } from '../../../shared/i18n/t'
import type { Project } from '../../../shared/types'
import { pinCanvasLanguage } from './canvasLang'
import { loadUiFont } from './uiFonts'

const ENGLISH: UiInfo = { language: 'en', formatLocale: 'en-US', dir: 'ltr', digits: 'western', system: 'en', offer: null, shipped: [], preview: [], prefs: {}, reopen: null }

/** How long the first render waits for the language before it shows English. */
export const BOOT_LIMIT_MS = 1500

/**
 * The renderer's built catalogues, by path, each loaded only when asked (one chunk per language).
 * Main's catalogues and the shipped list are main's. Tests replace entries here.
 */
export const BUILT_CATALOGUES: Record<string, () => Promise<unknown>> = {
  ...import.meta.glob<unknown>(['../../../shared/i18n/built/*.json', '!../../../shared/i18n/built/*.main.json', '!../../../shared/i18n/built/shipped.json'], { import: 'default' })
}

let booted: UiInfo = ENGLISH

/** `info` as an English UI: what failed to load is not shown, the rest (what ships, the preference) stays. */
const asEnglish = (info: UiInfo): UiInfo => ({ ...info, language: 'en', formatLocale: 'en-US', dir: 'ltr', digits: 'western' })

/** Without the catalogue ui:info may carry (it is not kept). */
const withoutCatalogue = (info: UiInfo): UiInfo => {
  const { catalogue: _, ...rest } = info
  return rest
}

/** The catalogue of a non-English UI: from ui:info in a test build, else the built chunk. */
async function catalogueOf(info: UiInfo): Promise<BuiltCatalogue> {
  if (info.catalogue) {
    const c = readBuiltCatalogue(info.catalogue)
    if (c) return c
    throw new Error('the catalogue handed over is not one')
  }
  const load = Object.entries(BUILT_CATALOGUES).find(([file]) => file.endsWith(`/built/${info.language}.json`))?.[1]
  if (!load) throw new Error(`no catalogue for ${info.language}`)
  const c = readBuiltCatalogue(await load())
  if (!c) throw new Error(`the catalogue for ${info.language} is not one`)
  return c
}

/** Rejects after `ms`. */
function deadline(ms: number): { late: Promise<never>; clear: () => void } {
  let timer: ReturnType<typeof setTimeout> | undefined
  const late = new Promise<never>((_, reject) => {
    timer = setTimeout(() => reject(new Error(`it took longer than ${ms} ms`)), ms)
  })
  late.catch(() => undefined)
  return { late, clear: () => clearTimeout(timer) }
}

const reason = (err: unknown): string => (err instanceof Error ? err.message : String(err))

/** Sets the UI language of view `view` before its first render, and gives what it set. */
export async function bootLanguage(view: 'main' | 'notes' | 'region' | 'toolbar'): Promise<UiInfo> {
  booted = ENGLISH
  // The recording bar is the other account's and stays English until it is translated (§9.5).
  if (view === 'toolbar') return booted
  const limit = deadline(BOOT_LIMIT_MS)
  try {
    let sent: UiInfo
    try {
      sent = await Promise.race([window.api.uiInfo(), limit.late])
    } catch (err) {
      console.warn(`The UI language could not be read, so Flown shows English: ${reason(err)}`)
      return booted
    }
    const info = withoutCatalogue(sent)
    if (info.language === 'en') {
      booted = info
      return booted
    }
    let catalogue: BuiltCatalogue
    try {
      ;[catalogue] = await Promise.race([Promise.all([catalogueOf(sent), loadUiFont(info.language)]), limit.late])
    } catch (err) {
      console.warn(`The ${info.language} catalogue could not be loaded, so Flown shows English: ${reason(err)}`)
      booted = asEnglish(info)
      return booted
    }
    // All at once, after everything arrived in time: nothing changes the page while it waits.
    setCatalogue({ language: info.language, messages: catalogue.messages, latn: catalogue.latn, user: catalogue.user, formatLocale: info.formatLocale, dir: info.dir })
    pinCanvasLanguage()
    document.documentElement.lang = info.language
    document.documentElement.dir = info.dir
    booted = info
    return booted
  } finally {
    limit.clear()
  }
}

/** The UiInfo the view booted with (the Language section, the offer and the palette read it). */
export function currentUiInfo(): UiInfo {
  return booted
}

/** Opens the project a relaunch from the editor asked to reopen, once, when it still exists (§9.4 step 6). */
export function reopenAfterRelaunch(open: (projectId: string) => void): void {
  const id = booted.reopen
  if (!id) return
  booted = { ...booted, reopen: null }
  void window.api.listProjects().then(
    (projects) => {
      if (projects.some((p) => p.id === id)) open(id)
    },
    () => undefined
  )
}

/**
 * Whether Settings shows the Language section (and the palette Language…): once a language other
 * than English ships, and always under `npm run dev` (§2.5). An English install sees no change.
 */
export function showLanguageSection(info: UiInfo): boolean {
  return info.shipped.some((l) => l !== 'en') || import.meta.env.MODE === 'development'
}

/* ---------- the open project ---------- */

/** The project the editor has open (its languages noted), until Home shows again. */
let editorProject: string | null = null
/** Home is on screen (its offer slot is mounted): no project is open. */
let homeShown = false
/** Languages noted this session, so each is sent once. */
const noted = new Set<UiLanguage>()

/** The languages of a project's transcript and caption tracks, by language subtag. */
function projectLanguages(project: Project): string[] {
  const out = new Set<string>()
  if (project.transcript?.language && project.transcript.segments?.length) out.add(languageOf(project.transcript.language))
  for (const track of project.captionTracks ?? []) if (track.language) out.add(languageOf(track.language))
  return [...out]
}

/** Records, once, a shipped language the project's captions or transcript are in (§2.7); and that the editor has it open. */
export function noteProjectLanguages(project: Project): void {
  editorProject = project.id
  const seen = booted.prefs.seen ?? []
  for (const language of projectLanguages(project)) {
    const l = booted.shipped.find((s) => s === language)
    if (!l || l === 'en' || seen.includes(l) || noted.has(l)) continue
    noted.add(l)
    void window.api.noteLanguageSeen(l).catch(() => undefined)
  }
}

/** Home's offer slot mounted (true) or went (false): while Home shows, no project is open. */
export function noteHomeShown(shown: boolean): void {
  homeShown = shown
  if (shown) editorProject = null
}

/** The project Restart now reopens after the restart: the editor's, or none from Home. */
export function editorProjectToReopen(): string | null {
  return homeShown ? null : editorProject
}

/** Forgets what this module learnt (tests only). */
export function resetBootForTests(): void {
  booted = ENGLISH
  editorProject = null
  homeShown = false
  noted.clear()
}
