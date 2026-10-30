/**
 * userData/updates.json (NW-15, docs/design/auto-update.md §1.6): "Update Flown automatically" and
 * when the last check ended. A missing or unreadable file means the defaults; every change is
 * written atomically.
 */
import fs from 'node:fs'
import { writeFileAtomicSync } from '../atomicWrite'

export const UPDATES_FILE = 'updates.json'

export interface UpdatePrefs {
  auto: boolean
  lastCheck: string | null
}

export const DEFAULT_UPDATE_PREFS: UpdatePrefs = { auto: true, lastCheck: null }

/** The prefs read from `raw` (anything): unknown or bad values fall back to the defaults. */
export function sanitizeUpdatePrefs(raw: unknown): UpdatePrefs {
  const r = raw && typeof raw === 'object' ? (raw as Record<string, unknown>) : {}
  const lastCheck = typeof r.lastCheck === 'string' && r.lastCheck.length <= 40 && Number.isFinite(Date.parse(r.lastCheck)) ? r.lastCheck : null
  return { auto: typeof r.auto === 'boolean' ? r.auto : DEFAULT_UPDATE_PREFS.auto, lastCheck }
}

export class UpdatePrefsStore {
  private value: UpdatePrefs | null = null

  constructor(readonly file: string) {}

  get(): UpdatePrefs {
    if (this.value) return { ...this.value }
    let raw: unknown = null
    try {
      raw = JSON.parse(fs.readFileSync(this.file, 'utf8'))
    } catch (err) {
      if ((err as NodeJS.ErrnoException).code !== 'ENOENT') console.warn('Ignoring unreadable update settings:', err)
    }
    this.value = sanitizeUpdatePrefs(raw)
    return { ...this.value }
  }

  set(patch: Partial<UpdatePrefs>): UpdatePrefs {
    const next = sanitizeUpdatePrefs({ ...this.get(), ...patch })
    this.value = next
    try {
      writeFileAtomicSync(this.file, `${JSON.stringify({ version: 1, ...next }, null, 2)}\n`)
    } catch (err) {
      // Kept in memory for this run; the next change tries again.
      console.warn('Could not save the update settings:', err)
    }
    return { ...next }
  }
}
