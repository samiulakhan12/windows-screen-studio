/**
 * Editor preferences (named style presets, custom shortcuts) as one JSON file in userData.
 * Each key holds whatever JSON its renderer module stores; that module validates what it reads
 * back. The Captions Studio keys (saved looks, Make my captions great's options, the Clean up
 * choices and the word list) are also read here with their readers (sanitizeCaptionPref) before
 * they are stored and when they are returned, and smart tools' keys (the user's prices, when to ask
 * before a run, the Guide, Find chapters and Short clips choices) with sanitizeSmartPref, which turns
 * anything malformed into the default (docs/design/smart-tools.md §4.7). Wave 12's keys are read the
 * same way: the user's export presets with readUserPresets and the UI language with readUiPrefs
 * (output-and-languages §4.4); main reads and writes `ui` itself through readPrefSync and
 * writePrefSync, on the same cache, so a later prefs:set never puts back a stale value. Writes are
 * atomic, so a crash never leaves a truncated file.
 */
import { app, ipcMain } from 'electron'
import fs from 'node:fs'
import path from 'node:path'
import { PREF_KEYS, type PrefKey } from '../shared/api/prefs'
import { sanitizeCaptionPref } from '../shared/captions/captionPrefs'
import { sanitizeSmartPref } from '../shared/smart/smartPrefs'
import { readUiPrefs } from '../shared/i18n/locale'
import { readUserPresets } from '../shared/render/userPresets'
import { writeFileAtomicSync } from './atomicWrite'

/** Wave 12's keys (output-and-languages §4.4): anything malformed reads as absent. Other keys pass through. */
function sanitizeOutputPref(key: PrefKey, value: unknown): unknown {
  if (value === null || value === undefined) return value
  if (key === 'exportPresets') return readUserPresets(value)
  if (key === 'ui') return readUiPrefs(value)
  return value
}

/** A stored or sent value of `key`, read by its sanitiser. */
const sanitize = (key: PrefKey, value: unknown): unknown => sanitizeOutputPref(key, sanitizeSmartPref(key, sanitizeCaptionPref(key, value)))

/** Largest value one key may hold (serialised), so a runaway renderer cannot fill the disk. */
const MAX_VALUE_BYTES = 2 * 1024 * 1024

let cache: Record<string, unknown> | null = null

const prefsFile = (): string => path.join(app.getPath('userData'), 'editor-prefs.json')

function load(): Record<string, unknown> {
  if (cache) return cache
  try {
    const raw = JSON.parse(fs.readFileSync(prefsFile(), 'utf8')) as unknown
    cache = raw && typeof raw === 'object' && !Array.isArray(raw) ? (raw as Record<string, unknown>) : {}
  } catch (err) {
    if ((err as NodeJS.ErrnoException).code !== 'ENOENT') console.warn('Ignoring unreadable editor preferences:', err)
    cache = {}
  }
  return cache
}

const isKey = (key: unknown): key is PrefKey => typeof key === 'string' && (PREF_KEYS as readonly string[]).includes(key)

/** The stored value of `key` read by its sanitiser, or null (main's own reads, such as `ui` at start). */
export function readPrefSync(key: PrefKey): unknown {
  return sanitize(key, load()[key] ?? null) ?? null
}

/** Stores `value` under `key` (null removes it) on the cache prefs:set uses, atomically. */
export function writePrefSync(key: PrefKey, raw: unknown): void {
  const value = sanitize(key, raw)
  const json = JSON.stringify(value ?? null)
  if (json.length > MAX_VALUE_BYTES) throw new Error('This preference is too large to save')
  const next = { ...load() }
  if (value === null || value === undefined) delete next[key]
  else next[key] = JSON.parse(json) as unknown
  writeFileAtomicSync(prefsFile(), JSON.stringify(next, null, 2))
  cache = next
}

export function registerPrefsIpc(): void {
  ipcMain.handle('prefs:get', (_e, key: unknown) => (isKey(key) ? sanitize(key, load()[key] ?? null) : null))
  ipcMain.handle('prefs:set', (_e, key: unknown, raw: unknown) => {
    if (!isKey(key)) throw new Error('Unknown preference')
    writePrefSync(key, raw)
  })
}
