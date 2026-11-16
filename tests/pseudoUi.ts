/**
 * A UI language for tests that is not English: the pseudo-locales of `npm run i18n:pseudo`
 * (docs/design/output-and-languages.md §16.3) set as the catalogue, as main and the renderer set a
 * shipped language's; and a rejection as Electron hands it from main to the renderer.
 */
import { setCatalogue } from '../src/shared/i18n/t'

const files = require('../scripts/i18n/lib/files.cjs') as { readEnglish(): { messages: Record<string, string>; meta: Record<string, object> } }
const pseudo = require('../scripts/i18n/lib/pseudo.cjs') as {
  pseudoCatalogue(locale: string, english: Record<string, string>, meta: Record<string, object>): { dir: 'ltr' | 'rtl'; messages: Record<string, string>; latn: string[]; user: Record<string, string[]> }
}

/** English, as every process starts. */
export const uiEnglish = (): void => setCatalogue({ language: 'en', messages: {}, formatLocale: 'en-US', dir: 'ltr' })

/** A pseudo-locale's catalogue standing in for a translated UI (en-XA as Spanish, bn-XA as Bangla). */
export function uiPseudo(locale: 'en-XA' | 'bn-XA' = 'en-XA'): void {
  const { messages, meta } = files.readEnglish()
  const c = pseudo.pseudoCatalogue(locale, messages, meta)
  setCatalogue({ language: locale === 'bn-XA' ? 'bn' : 'es', messages: c.messages, latn: c.latn, user: c.user, formatLocale: locale === 'bn-XA' ? 'bn-BD' : 'en-US', dir: c.dir })
}

/** `err` as the renderer receives a rejected invoke of `channel`: Electron passes "<name>: <message>" (Error.prototype.toString). */
export const ipcRejection = (channel: string, err: unknown): Error => new Error(`Error invoking remote method '${channel}': ${String(err)}`)
