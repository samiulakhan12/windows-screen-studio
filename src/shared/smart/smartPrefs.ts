/**
 * Smart tools' preferences (docs/design/smart-tools.md §4.7), each read by a sanitiser that turns
 * anything malformed into its default; prefsIpc runs them before a value is stored and when it is
 * returned. Pure.
 */
import type { PrefKey } from '../api/prefs'
import type { GuideFormat } from '../api/guide'

/** Ask before a run whose high end passes this amount (US$); 'always' every paid run, 'never' none. */
export type ConfirmPref = 'always' | '0.1' | '1' | '5' | 'never'
export const CONFIRM_PREFS: readonly ConfirmPref[] = ['always', '0.1', '1', '5', 'never']
export const DEFAULT_CONFIRM: ConfirmPref = '1'

/** Where names or titles come from: 'offline', 'local' (AI on this PC) or a provider's or service's id. */
export type NamesSource = string

export interface GuidePref {
  format?: GuideFormat
  page?: 'A4' | 'Letter'
  titles?: NamesSource
  notes?: NamesSource
}

export interface FindChaptersPref {
  density: 'fewer' | 'normal' | 'more'
  use: { screen: boolean; pauses: boolean; words: boolean }
  names: NamesSource
}
export const DEFAULT_FIND_CHAPTERS: Readonly<FindChaptersPref> = Object.freeze({ density: 'normal', use: Object.freeze({ screen: true, pauses: true, words: true }), names: 'offline' })

export interface ShortClipsPref {
  length: 'any' | 'short' | 'long'
  shape: 'vertical' | 'square' | 'same'
  names: NamesSource
  captions: boolean
}
export const DEFAULT_SHORT_CLIPS: Readonly<ShortClipsPref> = Object.freeze({ length: 'any', shape: 'vertical', names: 'offline', captions: true })

/** User prices: at most this many providers, US$ 0..1000 per million tokens. */
const MAX_PRICED = 40
const MAX_PRICE = 1000

type Obj = Record<string, unknown>
const isObj = (v: unknown): v is Obj => !!v && typeof v === 'object' && !Array.isArray(v)
const ID = /^[A-Za-z0-9_-]{1,64}$/
const source = (v: unknown, fallback: NamesSource): NamesSource => (typeof v === 'string' && ID.test(v) ? v : fallback)
const pick = <T extends string>(v: unknown, list: readonly T[], fallback: T): T => (list.includes(v as T) ? (v as T) : fallback)
const bool = (v: unknown, fallback: boolean): boolean => (typeof v === 'boolean' ? v : fallback)
const priceOk = (v: unknown): v is number => typeof v === 'number' && Number.isFinite(v) && v >= 0 && v <= MAX_PRICE

function readPrices(v: unknown): Record<string, { input: number; output: number }> {
  const out: Record<string, { input: number; output: number }> = {}
  if (!isObj(v)) return out
  for (const [id, p] of Object.entries(v)) {
    if (Object.keys(out).length >= MAX_PRICED) break
    if (ID.test(id) && isObj(p) && priceOk(p.input) && priceOk(p.output)) out[id] = { input: p.input, output: p.output }
  }
  return out
}

function readGuidePref(v: unknown): GuidePref {
  if (!isObj(v)) return {}
  const out: GuidePref = {}
  if (v.format === 'pdf' || v.format === 'html' || v.format === 'demo' || v.format === 'markdown') out.format = v.format
  if (v.page === 'A4' || v.page === 'Letter') out.page = v.page
  if (typeof v.titles === 'string' && ID.test(v.titles)) out.titles = v.titles
  if (typeof v.notes === 'string' && ID.test(v.notes)) out.notes = v.notes
  return out
}

function readFindChapters(v: unknown): FindChaptersPref {
  const d = DEFAULT_FIND_CHAPTERS
  if (!isObj(v)) return { ...d, use: { ...d.use } }
  const use = isObj(v.use) ? v.use : {}
  return {
    density: pick(v.density, ['fewer', 'normal', 'more'] as const, d.density),
    use: { screen: bool(use.screen, d.use.screen), pauses: bool(use.pauses, d.use.pauses), words: bool(use.words, d.use.words) },
    names: source(v.names, d.names)
  }
}

function readShortClips(v: unknown): ShortClipsPref {
  const d = DEFAULT_SHORT_CLIPS
  if (!isObj(v)) return { ...d }
  return {
    length: pick(v.length, ['any', 'short', 'long'] as const, d.length),
    shape: pick(v.shape, ['vertical', 'square', 'same'] as const, d.shape),
    names: source(v.names, d.names),
    captions: bool(v.captions, d.captions)
  }
}

/** Whether `key` is one of smart tools' preferences. */
export const isSmartPref = (key: PrefKey): boolean => key === 'aiPrices' || key === 'aiConfirm' || key === 'guide' || key === 'findChapters' || key === 'shortClips'

/**
 * `value` of smart tools' preference `key`, sanitised: null stays null (nothing stored: the
 * default); anything malformed becomes the default (aiConfirm '1', aiPrices {}, the others their
 * defaults field by field). Other keys pass through unchanged.
 */
export function sanitizeSmartPref(key: PrefKey, value: unknown): unknown {
  if (value === null || value === undefined) return null
  switch (key) {
    case 'aiPrices':
      return readPrices(value)
    case 'aiConfirm':
      return pick(value, CONFIRM_PREFS, DEFAULT_CONFIRM)
    case 'guide':
      return readGuidePref(value)
    case 'findChapters':
      return readFindChapters(value)
    case 'shortClips':
      return readShortClips(value)
    default:
      return value
  }
}
