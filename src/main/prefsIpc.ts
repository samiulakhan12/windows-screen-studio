/**
 * Editor preferences (named style presets, custom shortcuts) as one JSON file in userData.
 * Each key holds whatever JSON its renderer module stores; that module validates what it reads
 * back. Writes are atomic, so a crash never leaves a truncated file.
 */
import { app, ipcMain } from 'electron'
import fs from 'node:fs'
import path from 'node:path'
import { PREF_KEYS, type PrefKey } from '../shared/api/prefs'
import { writeFileAtomicSync } from './atomicWrite'

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

export function registerPrefsIpc(): void {
  ipcMain.handle('prefs:get', (_e, key: unknown) => (isKey(key) ? (load()[key] ?? null) : null))
  ipcMain.handle('prefs:set', (_e, key: unknown, value: unknown) => {
    if (!isKey(key)) throw new Error('Unknown preference')
    const json = JSON.stringify(value ?? null)
    if (json.length > MAX_VALUE_BYTES) throw new Error('This preference is too large to save')
    const next = { ...load() }
    if (value === null || value === undefined) delete next[key]
    else next[key] = JSON.parse(json) as unknown
    writeFileAtomicSync(prefsFile(), JSON.stringify(next, null, 2))
    cache = next
  })
}
