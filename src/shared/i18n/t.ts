/**
 * The message runtime every process shares (docs/design/output-and-languages.md §9.1). English is
 * registered by each process's entry (the renderer's main.tsx and the vitest setup import
 * messages/en/index.ts, main imports messages/en/main.ts), never by this module, so each process
 * carries only the namespaces it uses. The language is set once, at start (setCatalogue), and
 * changes only with a restart, so t() is a plain function.
 *
 * - A key the language's catalogue lacks (not translated, or left out as stale by the build) formats
 *   the English message: English for that string only.
 * - Each message is parsed once, on first use, and cached per language and key.
 * - English adds nothing: no isolation characters, no Latin-digit rewriting (§13.3, §0 decision 12).
 * - t() before any messages are registered throws, so text made at module scope cannot pass quietly.
 */
import type { UiLanguage } from '../api/ui'
import { formatIcu, parseIcu, selectorsOf, type IcuNode, type TagFn } from './icu'
import { isolate } from './isolate'
import type { MessageKey } from './keys'

export type { MessageKey } from './keys'
export type MessageValues = Record<string, string | number>
export type RichTag = 'kbd' | 'b' | 'em' | 'link'

/** The catalogue a process formats with (set at start; English until then). */
export interface Catalogue {
  language: UiLanguage
  messages: Readonly<Record<string, string>>
  /** Keys whose numbers stay Latin (meta `digits: 'latn'`, §9.3). */
  latn?: readonly string[]
  /** Placeholders of each key that hold the user's own text (meta `user`, §13.3), isolated outside English. */
  user?: Readonly<Record<string, readonly string[]>>
  formatLocale: string
  dir: 'ltr' | 'rtl'
}

const registered = new Map<UiLanguage, Record<string, string>>()
let catalogue: Catalogue = { language: 'en', messages: {}, formatLocale: 'en-US', dir: 'ltr' }
let latn: ReadonlySet<string> = new Set()
const parsed = new Map<string, IcuNode[]>()

/** Registers messages for a language; the process's entry registers English (§9.1), never t.ts itself. */
export function registerMessages(language: UiLanguage, messages: Readonly<Record<string, string>>): void {
  const into = registered.get(language) ?? {}
  Object.assign(into, messages)
  registered.set(language, into)
  for (const key of Object.keys(messages)) parsed.delete(`${language}\u0000${key}`)
}

/** Set once per process before any text is made (main at start, the renderer before its first render). */
export function setCatalogue(c: Catalogue): void {
  catalogue = { ...c, messages: { ...c.messages } }
  latn = new Set(c.latn ?? [])
  for (const key of [...parsed.keys()]) if (!key.startsWith('en\u0000')) parsed.delete(key)
}

export const uiLanguage = (): UiLanguage => catalogue.language
export const uiDir = (): 'ltr' | 'rtl' => catalogue.dir
/** The format locale fmt uses outside English (§9.4 step 2). */
export const formatLocale = (): string => catalogue.formatLocale

/** The message of `key` in the UI language, else English, parsed once; with the language it is in. */
function messageOf(key: string): { language: UiLanguage; nodes: IcuNode[] } {
  if (!registered.has('en')) throw new Error(`t('${key}') ran before any messages were registered: text is made where it is shown, never when a module loads`)
  const own = catalogue.language !== 'en' ? (catalogue.messages[key] ?? registered.get(catalogue.language)?.[key]) : undefined
  const language: UiLanguage = own !== undefined ? catalogue.language : 'en'
  const source = own ?? registered.get('en')![key]
  if (source === undefined) throw new Error(`Unknown message key "${key}"`)
  const cacheKey = `${language}\u0000${key}`
  let nodes = parsed.get(cacheKey)
  if (!nodes) {
    nodes = parseIcu(source)
    parsed.set(cacheKey, nodes)
  }
  return { language, nodes }
}

const NATIVE_DIGITS = /[०-९০-৯٠-٩۰-۹]/g
const DIGIT_BASES = [0x0966, 0x09e6, 0x0660, 0x06f0]
const toLatin = (s: string): string =>
  s.replace(NATIVE_DIGITS, (d) => {
    const c = d.charCodeAt(0)
    const base = DIGIT_BASES.find((b) => c >= b && c <= b + 9)!
    return String(c - base)
  })

/** The values as a translated message shows them: Latin digits in technical lines, the user's text isolated. English: as given. */
function shownValues<T>(key: string, values: Readonly<Record<string, string | number | T>>): Record<string, string | number | T> {
  if (catalogue.language === 'en') return { ...values }
  const out: Record<string, string | number | T> = { ...values }
  const digitsLatin = latn.has(key)
  const user = catalogue.user?.[key] ?? []
  for (const [name, v] of Object.entries(out)) {
    if (typeof v !== 'string') continue
    let s = digitsLatin ? toLatin(v) : v
    if (user.includes(name)) s = isolate(s)
    out[name] = s
  }
  return out
}

/** The message `key` in the UI language with `values`; English when the language has no approved text for it. Rich tags keep their content only. */
export function t(key: MessageKey, values: MessageValues = {}): string {
  const { language, nodes } = messageOf(key)
  return formatIcu<string>(nodes, shownValues(key, values), { language, formatLocale: language === 'en' ? 'en-US' : catalogue.formatLocale }).join('')
}

/** The same, with rich tags (<kbd>, <b>, <em>, <link>) mapped to the caller's nodes. */
export function tParts<T>(key: MessageKey, values: MessageValues, tags: Partial<Record<RichTag, (chunks: (string | T)[]) => T>>): (string | T)[] {
  return tNodes<T>(key, values, tags)
}

/**
 * tParts with values that may themselves be the caller's nodes (T.tsx wraps the user's text in
 * <bdi> that way outside English). For the renderer's <T> only.
 */
export function tNodes<T>(key: MessageKey, values: Readonly<Record<string, string | number | T>>, tags: Partial<Record<RichTag, TagFn<T>>>): (string | T)[] {
  const { language, nodes } = messageOf(key)
  return formatIcu<T>(nodes, shownValues(key, values), { language, formatLocale: language === 'en' ? 'en-US' : catalogue.formatLocale }, tags)
}

/** The names `key` picks a branch by (plural and select) in the UI language: richText leaves their values plain. */
export function selectorNames(key: MessageKey): ReadonlySet<string> {
  return selectorsOf(messageOf(key).nodes)
}

/** The placeholders of `key` that hold the user's own text, outside English (for <T>'s <bdi>). */
export function userPlaceholders(key: MessageKey): readonly string[] {
  return catalogue.language === 'en' ? [] : (catalogue.user?.[key] ?? [])
}

/** Forgets every registered message and the catalogue (tests only). */
export function resetMessagesForTests(): void {
  registered.clear()
  parsed.clear()
  catalogue = { language: 'en', messages: {}, formatLocale: 'en-US', dir: 'ltr' }
  latn = new Set()
}
