/**
 * The renderer's UI language at start (docs/design/output-and-languages.md §9.4 step 4): one ui:info
 * call, then for a non-English language its catalogue chunk and UI font, setCatalogue, the canvases'
 * language and `<html lang dir>`, bounded at 1.5 s and English on any failure.
 *
 * Part P6 writes it. The contracts' stub gives English at once, with no IPC call and no load, so
 * English starts exactly as before.
 */
import type { UiInfo, UiLanguage } from '../../../shared/api/ui'
import type { Project } from '../../../shared/types'

const ENGLISH: UiInfo = { language: 'en', formatLocale: 'en-US', dir: 'ltr', digits: 'western', system: 'en', offer: null, shipped: [], preview: [], prefs: {}, reopen: null }

let booted: UiInfo = ENGLISH

/** Sets the UI language of view `view` before its first render. Part P6; the stub gives English at once. */
export async function bootLanguage(view: 'main' | 'notes' | 'region' | 'toolbar'): Promise<UiInfo> {
  void view
  booted = ENGLISH
  return booted
}

/** The UiInfo the view booted with (the Language section, the offer and the palette read it). */
export function currentUiInfo(): UiInfo {
  return booted
}

/** Opens the project a relaunch from the editor asked to reopen, once (§9.4 step 6). Part P6; the stub does nothing. */
export function reopenAfterRelaunch(open: (projectId: string) => void): void {
  void open
}

/** Whether Settings shows the Language section: a language other than English ships (always in development builds). Part P6; the stub says no. */
export function showLanguageSection(info: UiInfo): boolean {
  void info
  return false
}

/** Records, once, a shipped language the project's captions or transcript are in (§2.7). Part P6; the stub does nothing. */
export function noteProjectLanguages(project: Project): void {
  void project
}

/** The languages the stub knows of (none shipped). */
export const BOOT_LANGUAGES: readonly UiLanguage[] = ['en']
