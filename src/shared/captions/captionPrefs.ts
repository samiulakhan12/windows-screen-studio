/**
 * The Captions Studio preferences (docs/design/captions-studio.md §4.6), read the same way by the
 * main process before it stores or returns them (src/main/prefsIpc.ts) and by the renderer after
 * it reads them: saved looks (`captionPresets`), Make my captions great's options
 * (`captionsGreat`), the Clean up choices (`captionCleanup`) and the word list
 * (`captionWordList`). Anything unusable is dropped or takes its default; nothing throws.
 */
import type { PrefKey } from '../api/prefs'
import type { CaptionStudio } from '../types'
import { readCleanupChoices, type WordListEntry } from './cleanup'
import { readGreatOptions } from './great'
import { readCaptionStudio } from './studioData'
import type { SavedLook } from './studioPresets'

/** Most saved looks (§2.4: "You have 50 saved styles. Delete one first."). */
export const MAX_SAVED_LOOKS = 50
/** A saved look's name, characters. */
export const SAVED_LOOK_NAME_MAX = 40
/** A saved look's id. */
export const SAVED_LOOK_ID_RE = /^[a-z0-9]{1,16}$/
/** Most word-list entries, characters of a term or a heard form, heard forms per term. */
export const MAX_WORD_LIST = 500
export const WORD_LIST_TEXT_MAX = 40
export const MAX_HEARD_FORMS = 5

const isObject = (v: unknown): v is Record<string, unknown> => !!v && typeof v === 'object' && !Array.isArray(v)

/** One line of text: control characters removed, runs of white space made one space, trimmed and cut to `max` characters (whole code points). */
export function cleanPrefText(raw: unknown, max: number): string {
  if (typeof raw !== 'string') return ''
  // eslint-disable-next-line no-control-regex
  const one = raw.replace(/[\u0000-\u001f\u007f-\u009f]/g, ' ').replace(/\s+/g, ' ').trim()
  return Array.from(one).slice(0, max).join('').trim()
}

/** A saved look's look: read like a project's (§4.2 rule 2), named after its tile ('mine:<id>'). */
const savedLookOf = (raw: unknown, id: string): CaptionStudio | undefined => {
  const look = readCaptionStudio(raw)
  return look && { ...look, from: `mine:${id}` }
}

/** Saved looks (prefs `captionPresets`): ids `^[a-z0-9]{1,16}$`, unique; names cut to 40 characters; looks through readCaptionStudio; at most 50. */
export function readSavedLooks(raw: unknown): SavedLook[] {
  if (!Array.isArray(raw)) return []
  const out: SavedLook[] = []
  for (const entry of raw) {
    if (out.length >= MAX_SAVED_LOOKS) break
    if (!isObject(entry) || typeof entry.id !== 'string' || !SAVED_LOOK_ID_RE.test(entry.id) || out.some((s) => s.id === entry.id)) continue
    const name = cleanPrefText(entry.name, SAVED_LOOK_NAME_MAX)
    const look = savedLookOf(entry.look, entry.id)
    if (!name || !look) continue
    out.push({ id: entry.id, name, look })
  }
  return out
}

/** The word list (prefs `captionWordList`): terms of at most 40 characters, unique (ignoring case), each with at most 5 heard forms of at most 40; at most 500. */
export function readWordList(raw: unknown): WordListEntry[] {
  if (!Array.isArray(raw)) return []
  const out: WordListEntry[] = []
  const seen = new Set<string>()
  for (const entry of raw) {
    if (out.length >= MAX_WORD_LIST) break
    if (!isObject(entry)) continue
    const term = cleanPrefText(entry.term, WORD_LIST_TEXT_MAX)
    if (!term || seen.has(term.toLowerCase())) continue
    seen.add(term.toLowerCase())
    const heard: string[] = []
    for (const h of Array.isArray(entry.heard) ? entry.heard : []) {
      const form = cleanPrefText(h, WORD_LIST_TEXT_MAX)
      if (form && form.toLowerCase() !== term.toLowerCase() && !heard.some((x) => x.toLowerCase() === form.toLowerCase())) heard.push(form)
      if (heard.length >= MAX_HEARD_FORMS) break
    }
    out.push({ term, heard })
  }
  return out
}

/** The keys this module reads. */
export const CAPTION_PREF_KEYS: readonly PrefKey[] = ['captionPresets', 'captionsGreat', 'captionCleanup', 'captionWordList']

/**
 * A Captions Studio preference as it may be stored or used: `value` read by its key's reader. Other
 * keys pass through unchanged (their renderer modules read them). `null` stays `null` (nothing saved).
 */
export function sanitizeCaptionPref(key: PrefKey, value: unknown): unknown {
  if (value === null || value === undefined) return null
  switch (key) {
    case 'captionPresets':
      return readSavedLooks(value)
    case 'captionsGreat':
      return readGreatOptions(value)
    case 'captionCleanup':
      return readCleanupChoices(value)
    case 'captionWordList':
      return readWordList(value)
    default:
      return value
  }
}
