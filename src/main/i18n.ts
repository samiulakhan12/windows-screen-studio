/**
 * The UI language in main (docs/design/output-and-languages.md §9.4): chosen once at start from the
 * `ui` preference, Windows' languages and what ships; the `ui:*` channels; relaunching to switch
 * unless work would be lost; confirmations in the UI language.
 *
 * - What ships is `src/shared/i18n/built/shipped.json`, each language with its built catalogue for
 *   main (`<lang>.main.json`, the common, errors and main namespaces), imported when main is built.
 *   A language listed without its catalogue does not ship. With nothing built, Flown is English and
 *   nothing below changes what it does.
 * - The language changes only at a restart, so main sets its catalogue once, here, before any
 *   module makes text; `ui:info` hands the renderer the same choice.
 * - A restart is refused while anything would be lost (busyReason, or a download running), and
 *   quitting saves the editor's project as it always does; `--flown-open=<id>` reopens it after.
 * - Unpackaged builds only (tests and the reviewers' pack): SSW_I18N_CATALOGUE_DIR names a folder
 *   with shipped.json and the catalogues to use instead, SSW_PREFERRED_LANGUAGES stands in for
 *   Windows' languages, and SSW_RELAUNCH_LOG records a relaunch's arguments instead of starting again.
 * - Unpackaged builds only, for development (§12.3, §16.3): FLOWN_I18N_PSEUDO=en-XA, bn-XA or ar-XB
 *   starts Flown in that pseudo-locale, from the folder `npm run i18n:pseudo` writes
 *   (scripts/i18n/pseudo/<locale>/, not committed), standing in for the UI language it is made for
 *   (PSEUDO_LOCALES); ar-XB's page is right to left. A packaged build never reads it.
 */
import { app, BrowserWindow, dialog, ipcMain, type IpcMainInvokeEvent } from 'electron'
import fs from 'node:fs'
import path from 'node:path'
import { UI_LANGUAGES, type RelaunchResult, type UiInfo, type UiLanguage, type UiPrefs } from '../shared/api/ui'
import { readBuiltCatalogue, readShipped, readUiPrefs, resolveUiLanguage, type BuiltCatalogue } from '../shared/i18n/locale'
import { setCatalogue, t } from '../shared/i18n/t'
import { SPEECH_MODELS } from '../shared/speech/catalog'
import { assetDownloading } from './assets/assetStore'
import { localModelDownloading } from './localAi/models'
import { readPrefSync, writePrefSync } from './prefsIpc'
import { isAppUrl } from './security'
import { bedDownloading } from './soundLibrary/store'
import { SPEECH_DIR } from './speech/models'
import { speechDownloading } from './speech/service'
import { busyReason } from './updates/updatesIpc'

/** The built catalogues for main and the shipped list, as the build put them in (none until a language ships). */
const BUILT_MAIN = import.meta.glob<unknown>('../shared/i18n/built/*.main.json', { eager: true, import: 'default' })
const BUILT_SHIPPED = import.meta.glob<unknown>('../shared/i18n/built/shipped.json', { eager: true, import: 'default' })

/** The command-line argument a relaunch from the editor adds: the project to open again. */
export const OPEN_ARG = '--flown-open='
/** A project id as the projects folder names them. */
const PROJECT_ID = /^[A-Za-z0-9_-]{1,128}$/
/** Largest catalogue file read from SSW_I18N_CATALOGUE_DIR. */
const CATALOGUE_FILE_LIMIT = 4 * 1024 * 1024

const isUiLanguage = (v: unknown): v is UiLanguage => typeof v === 'string' && (UI_LANGUAGES as readonly string[]).includes(v)

/**
 * The pseudo-locales (§16.3), each with the UI language it stands in for and its page's direction;
 * `npm run i18n:pseudo` writes each one's catalogues as that language (scripts/i18n/lib/pseudo.cjs,
 * PSEUDO_SLOT).
 */
export const PSEUDO_LOCALES: Readonly<Record<string, { language: UiLanguage; dir: 'ltr' | 'rtl' }>> = {
  'en-XA': { language: 'es', dir: 'ltr' },
  'bn-XA': { language: 'bn', dir: 'ltr' },
  'ar-XB': { language: 'es', dir: 'rtl' }
}

/** The pseudo-locale FLOWN_I18N_PSEUDO asks for, in an unpackaged build only; null otherwise. */
export function pseudoLocale(): string | null {
  if (app.isPackaged) return null
  const asked = process.env.FLOWN_I18N_PSEUDO
  return asked && Object.hasOwn(PSEUDO_LOCALES, asked) ? asked : null
}

/** The tests' catalogue folder, or the pseudo-locale's: an absolute path, in an unpackaged build only. */
function catalogueDir(): string | null {
  if (app.isPackaged) return null
  const pseudo = pseudoLocale()
  if (pseudo) return path.join(app.getAppPath(), 'scripts', 'i18n', 'pseudo', pseudo)
  const dir = process.env.SSW_I18N_CATALOGUE_DIR
  return dir && path.isAbsolute(dir) ? dir : null
}

function readJsonFile(file: string): unknown {
  try {
    const st = fs.statSync(file)
    if (!st.isFile() || st.size > CATALOGUE_FILE_LIMIT) return null
    return JSON.parse(fs.readFileSync(file, 'utf8')) as unknown
  } catch {
    return null
  }
}

/** The built value at `name` of a glob result ('…/built/bn.main.json' for 'bn.main.json'), or undefined. */
const builtFile = (files: Record<string, unknown>, name: string): unknown => Object.entries(files).find(([k]) => k.endsWith(`/built/${name}`))?.[1]

/** Main's catalogue of `language` (common, errors and main), or null when it has none. */
function mainCatalogue(language: UiLanguage): BuiltCatalogue | null {
  const dir = catalogueDir()
  return readBuiltCatalogue(dir ? readJsonFile(path.join(dir, `${language}.main.json`)) : builtFile(BUILT_MAIN, `${language}.main.json`))
}

/** The renderer's catalogue of `language` from the tests' folder; null in every other build (the renderer imports its own). */
function rendererCatalogue(language: UiLanguage): BuiltCatalogue | null {
  const dir = catalogueDir()
  return dir ? readBuiltCatalogue(readJsonFile(path.join(dir, `${language}.json`))) : null
}

/** The languages that ship: shipped.json's, each only with its catalogue for main (§9.2). */
function shippedLanguages(): { language: UiLanguage; preview: boolean }[] {
  const dir = catalogueDir()
  const raw = dir ? readJsonFile(path.join(dir, 'shipped.json')) : builtFile(BUILT_SHIPPED, 'shipped.json')
  return readShipped(raw).filter((s) => mainCatalogue(s.language) !== null)
}

/** Windows' languages in its order (app.getPreferredSystemLanguages); SSW_PREFERRED_LANGUAGES in an unpackaged build. */
function preferredLanguages(): string[] {
  const forced = !app.isPackaged ? process.env.SSW_PREFERRED_LANGUAGES : undefined
  if (forced !== undefined) return forced.split(',').map((s) => s.trim()).filter(Boolean)
  try {
    return typeof app.getPreferredSystemLanguages === 'function' ? app.getPreferredSystemLanguages() : []
  } catch {
    return []
  }
}

/** Windows' format locale (app.getSystemLocale), or en-US when it cannot be read. */
function systemLocale(): string {
  try {
    return (typeof app.getSystemLocale === 'function' && app.getSystemLocale()) || 'en-US'
  } catch {
    return 'en-US'
  }
}

/** The project a relaunch from the editor asked to open again (`--flown-open=<id>`), or null. */
export function reopenArgument(argv: readonly string[]): string | null {
  const arg = argv.find((a) => a.startsWith(OPEN_ARG))
  const id = arg?.slice(OPEN_ARG.length) ?? ''
  return PROJECT_ID.test(id) ? id : null
}

let info: UiInfo | null = null
/** The project to reopen, until ui:info has given it once. */
let reopenPending: string | null = null

const resolve = (prefs: UiPrefs | null): UiInfo => resolveUiLanguage(prefs, preferredLanguages(), systemLocale(), shippedLanguages(), knownLanguages())

/**
 * The language a start chooses: the preference's, or under FLOWN_I18N_PSEUDO (development only) the
 * language the pseudo-locale stands in for, with its direction. Without the folder `npm run
 * i18n:pseudo` writes, the pseudo-locale is not shipped and Flown starts in English.
 */
function chooseLanguage(prefs: UiPrefs | null): UiInfo {
  const pseudo = pseudoLocale()
  if (!pseudo) return resolve(prefs)
  const stands = PSEUDO_LOCALES[pseudo]
  const chosen = resolve({ ...prefs, language: stands.language })
  if (chosen.language !== stands.language) {
    console.warn(`FLOWN_I18N_PSEUDO=${pseudo}: run npm run i18n:pseudo first; Flown starts in English.`)
    return resolve(prefs)
  }
  // The preference itself is not changed: the pseudo-locale lasts as long as the variable.
  return { ...chosen, dir: stands.dir, prefs: prefs ?? {} }
}

/** Chooses the UI language before any window opens and before any module makes text (§9.4 step 1). */
export function initUiLanguage(): UiInfo {
  const chosen = chooseLanguage(readUiPrefs(readPrefSync('ui')))
  const catalogue = chosen.language === 'en' ? null : mainCatalogue(chosen.language)
  reopenPending = reopenArgument(process.argv)
  // A shipped language always has its catalogue (shippedLanguages); without one, English.
  info = catalogue || chosen.language === 'en' ? { ...chosen, reopen: reopenPending } : { ...chosen, language: 'en', formatLocale: 'en-US', dir: 'ltr', digits: 'western', reopen: reopenPending }
  setCatalogue(
    catalogue && info.language !== 'en'
      ? { language: info.language, messages: catalogue.messages, latn: catalogue.latn, user: catalogue.user, formatLocale: info.formatLocale, dir: info.dir }
      : { language: 'en', messages: {}, formatLocale: 'en-US', dir: 'ltr' }
  )
  return info
}

/** Languages Flown knows offline that the user works in: speech models made for one, and `UiPrefs.seen` (§2.7). */
export function knownLanguages(): UiLanguage[] {
  const out = new Set<UiLanguage>()
  let dir: string | null = null
  try {
    dir = path.join(app.getPath('userData'), SPEECH_DIR)
  } catch {
    dir = null
  }
  for (const spec of SPEECH_MODELS) {
    if (!dir || !isUiLanguage(spec.language)) continue
    try {
      const st = fs.statSync(path.join(dir, spec.file))
      if (st.isFile() && st.size > 0) out.add(spec.language)
    } catch {
      // Not installed.
    }
  }
  for (const l of readUiPrefs(readPrefSync('ui'))?.seen ?? []) out.add(l)
  return [...out]
}

/** A download that a quit would cut off: a speech model, caption fonts, music or a model for AI on this PC. */
const downloading = (): boolean => speechDownloading() || assetDownloading() || bedDownloading() || localModelDownloading()

/** What would be lost by a relaunch now, as a sentence, or null (§9.4 step 6). */
export function relaunchBlocker(): string | null {
  return busyReason() ?? (downloading() ? t('main.relaunch.download') : null)
}

/** The arguments of the relaunch: today's, without an earlier project to open, and the one to open now. */
export function relaunchArgs(argv: readonly string[], reopenProjectId?: string): string[] {
  const id = reopenProjectId !== undefined && PROJECT_ID.test(reopenProjectId) ? reopenProjectId : null
  return [...argv.slice(1).filter((a) => !a.startsWith(OPEN_ARG)), ...(id ? [`${OPEN_ARG}${id}`] : [])]
}

/**
 * Relaunches Flown, reopening `reopenProjectId` after the restart, unless something is busy: then
 * nothing quits and the reason comes back. Quitting saves the editor's project as it always does
 * (its page saves on unload).
 */
export function relaunchApp(reopenProjectId?: string): RelaunchResult {
  const reason = relaunchBlocker()
  if (reason) return { ok: false, reason }
  const args = relaunchArgs(process.argv, reopenProjectId)
  const log = !app.isPackaged ? process.env.SSW_RELAUNCH_LOG : undefined
  if (log) fs.writeFileSync(log, JSON.stringify({ args }))
  else app.relaunch({ args })
  // After the answer has gone back to the page.
  setImmediate(() => app.quit())
  return { ok: true }
}

const fromApp = (e: IpcMainInvokeEvent): boolean => isAppUrl(e.senderFrame?.url ?? '')

/** Longest confirmation question and button label accepted (§18.5). */
const CONFIRM_LIMITS = { message: 2000, label: 60 }

/** The `ui:*` channels, for the app's own page only. */
export function registerUiIpc(): void {
  ipcMain.handle('ui:info', (e): UiInfo => {
    if (!fromApp(e)) throw new Error('Not allowed')
    const now = info ?? initUiLanguage()
    const prefs = readUiPrefs(readPrefSync('ui')) ?? {}
    // The language stays the one Flown started in; the offer follows what the user answered since.
    const offer = resolve(prefs).offer
    const reopen = reopenPending
    reopenPending = null
    const catalogue = now.language === 'en' ? null : rendererCatalogue(now.language)
    return { ...now, prefs, offer, reopen, ...(catalogue ? { catalogue } : {}) }
  })
  ipcMain.handle('ui:setPrefs', (e, raw: unknown) => {
    if (!fromApp(e)) throw new Error('Not allowed')
    const prefs = readUiPrefs(raw)
    if (!prefs) throw new Error('Invalid language settings')
    writePrefSync('ui', Object.keys(prefs).length ? prefs : null)
  })
  ipcMain.handle('ui:relaunch', (e, reopenProjectId: unknown) => {
    if (!fromApp(e)) throw new Error('Not allowed')
    return relaunchApp(typeof reopenProjectId === 'string' ? reopenProjectId : undefined)
  })
  ipcMain.handle('ui:noteSeen', (e, language: unknown) => {
    if (!fromApp(e)) throw new Error('Not allowed')
    if (!isUiLanguage(language) || language === 'en') return
    const prefs = readUiPrefs(readPrefSync('ui')) ?? {}
    const seen = prefs.seen ?? []
    if (seen.includes(language) || seen.length >= 8) return
    writePrefSync('ui', { ...prefs, seen: [...seen, language] })
  })
  ipcMain.handle('ui:confirm', async (e, request: unknown) => {
    if (!fromApp(e)) throw new Error('Not allowed')
    const r = (request && typeof request === 'object' ? request : {}) as Record<string, unknown>
    const ok = (v: unknown, max: number): v is string => typeof v === 'string' && v.length > 0 && v.length <= max
    if (!ok(r.message, CONFIRM_LIMITS.message) || !ok(r.action, CONFIRM_LIMITS.label) || !ok(r.cancel, CONFIRM_LIMITS.label)) throw new Error('Invalid confirmation')
    const owner = BrowserWindow.fromWebContents(e.sender)
    const options = { type: 'question' as const, message: r.message, buttons: [r.action, r.cancel], defaultId: 0, cancelId: 1, noLink: true }
    const { response } = owner ? await dialog.showMessageBox(owner, options) : await dialog.showMessageBox(options)
    return response === 0
  })
}
