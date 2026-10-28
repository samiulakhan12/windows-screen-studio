/**
 * userData/storage.json (F-26): the clean-up rules the user set, when the editor last opened each
 * recording, and when the automatic cache clean-up last ran. A missing or unreadable file means the
 * defaults; every change is written atomically.
 */
import fs from 'node:fs'
import path from 'node:path'
import { DEFAULT_RULES, sanitizeRules, type StorageRules } from '../shared/storage/rules'
import { writeFileAtomicSync } from './atomicWrite'

export const STORAGE_FILE = 'storage.json'
/** Most recordings whose last opening is remembered (the oldest are dropped). */
export const MAX_USED = 5000

const ID_RE = /^[a-zA-Z0-9_-]+$/

interface StoredFile {
  version: 1
  rules: StorageRules
  used: Record<string, string>
  lastAutoClean: string | null
}

export class StorageStore {
  private value: StoredFile | null = null

  constructor(readonly file: string) {}

  private load(): StoredFile {
    if (this.value) return this.value
    let raw: Partial<StoredFile> = {}
    try {
      raw = JSON.parse(fs.readFileSync(this.file, 'utf8')) as Partial<StoredFile>
    } catch (err) {
      if ((err as NodeJS.ErrnoException).code !== 'ENOENT') console.warn('Ignoring unreadable storage settings:', err)
    }
    const used: Record<string, string> = {}
    if (raw.used && typeof raw.used === 'object') {
      for (const [id, t] of Object.entries(raw.used)) if (ID_RE.test(id) && typeof t === 'string' && Number.isFinite(Date.parse(t))) used[id] = t
    }
    this.value = {
      version: 1,
      rules: raw.rules ? sanitizeRules(raw.rules) : { ...DEFAULT_RULES },
      used,
      lastAutoClean: typeof raw.lastAutoClean === 'string' && Number.isFinite(Date.parse(raw.lastAutoClean)) ? raw.lastAutoClean : null
    }
    return this.value
  }

  private save(): void {
    try {
      fs.mkdirSync(path.dirname(this.file), { recursive: true })
      writeFileAtomicSync(this.file, JSON.stringify(this.load(), null, 2), { attempts: 4 })
    } catch (err) {
      console.warn('Could not save the storage settings:', err)
    }
  }

  get rules(): StorageRules {
    return { ...this.load().rules }
  }

  setRules(raw: unknown): StorageRules {
    this.load().rules = sanitizeRules(raw)
    this.save()
    return this.rules
  }

  get used(): Readonly<Record<string, string>> {
    return { ...this.load().used }
  }

  /** Notes that recording `id` was opened now. */
  noteUsed(id: string, now = new Date()): void {
    if (!ID_RE.test(id)) return
    const v = this.load()
    delete v.used[id]
    v.used[id] = now.toISOString()
    const ids = Object.keys(v.used)
    if (ids.length > MAX_USED) {
      const keep = ids.sort((a, b) => Date.parse(v.used[b]) - Date.parse(v.used[a])).slice(0, MAX_USED)
      v.used = Object.fromEntries(keep.map((k) => [k, v.used[k]]))
    }
    this.save()
  }

  get lastAutoClean(): number | null {
    const t = this.load().lastAutoClean
    return t ? Date.parse(t) : null
  }

  setLastAutoClean(now = new Date()): void {
    this.load().lastAutoClean = now.toISOString()
    this.save()
  }
}
