/**
 * What "Share without a server" keeps (F-22, docs/design/share.md §2.6), in userData/share.json:
 * the folders the user added, the found folders they turned off, and the chat webhooks. A webhook
 * URL is a secret (anyone holding it can post to the chat), so it is encrypted with safeStorage
 * exactly as AI keys are (ai/keyStore.ts): without safe encryption none is stored. The page only
 * ever sees a masked URL. Nothing here logs a path or a URL.
 */
import fs from 'node:fs'
import path from 'node:path'
import type { ShareHookInfo } from '../../shared/api/share'
import { folderId } from '../../shared/share/cloudFolders'
import { maskWebhook, parseWebhookUrl, SHARE_LIMITS, WEBHOOK_SERVICES, type WebhookService } from '../../shared/share/webhooks'
import type { SecretBox } from '../ai/keyStore'
import { writeFileAtomicSync } from '../atomicWrite'

const FILE_VERSION = 1

export interface StoredFolder {
  id: string
  path: string
  label: string
  addedAt: string
}

interface StoredHook {
  id: string
  service: WebhookService
  label: string
  /** The encrypted URL, base64. */
  url: string
  createdAt: string
}

interface ShareFile {
  folders: StoredFolder[]
  off: string[]
  hooks: StoredHook[]
}

const FOLDER_ID = /^cf[0-9a-f]{10}$/
const HOOK_ID = /^whk[a-z0-9]{1,30}$/
const isObject = (v: unknown): v is Record<string, unknown> => typeof v === 'object' && v !== null && !Array.isArray(v)
const isService = (v: unknown): v is WebhookService => typeof v === 'string' && Object.hasOwn(WEBHOOK_SERVICES, v)

let counter = 0
const newHookId = (): string => `whk${Date.now().toString(36)}${(counter++).toString(36)}`

/** A name typed by the user: one line, at most 60 characters; `fallback` when empty. */
export function cleanLabel(v: unknown, fallback: string): string {
  const s = typeof v === 'string' ? v.replace(/[\u0000-\u001f\u007f]/g, ' ').replace(/\s+/g, ' ').trim() : ''
  return (s || fallback).slice(0, SHARE_LIMITS.labelLength)
}

function readFolder(raw: unknown): StoredFolder | null {
  if (!isObject(raw)) return null
  const { id, path: p, label, addedAt } = raw
  if (typeof p !== 'string' || !path.isAbsolute(p) || p.length > 1000 || p.includes('\u0000')) return null
  if (typeof id !== 'string' || id !== folderId(p) || typeof label !== 'string' || !label.trim() || label.length > SHARE_LIMITS.labelLength) return null
  return { id, path: p, label, addedAt: typeof addedAt === 'string' ? addedAt : '' }
}

function readHook(raw: unknown): StoredHook | null {
  if (!isObject(raw)) return null
  const { id, service, label, url, createdAt } = raw
  if (typeof id !== 'string' || !HOOK_ID.test(id) || !isService(service)) return null
  if (typeof label !== 'string' || !label.trim() || label.length > SHARE_LIMITS.labelLength) return null
  if (typeof url !== 'string' || !/^[A-Za-z0-9+/]+=*$/.test(url)) return null
  return { id, service, label, url, createdAt: typeof createdAt === 'string' ? createdAt : '' }
}

export class ShareStore {
  private data: ShareFile | null = null

  constructor(
    readonly file: string,
    private readonly box: SecretBox
  ) {}

  private load(): ShareFile {
    if (this.data) return this.data
    let raw: unknown = null
    try {
      raw = JSON.parse(fs.readFileSync(this.file, 'utf8'))
    } catch (err) {
      if ((err as NodeJS.ErrnoException).code !== 'ENOENT') console.warn('Ignoring an unreadable share settings file')
    }
    const obj = isObject(raw) ? raw : {}
    const folders: StoredFolder[] = []
    for (const item of Array.isArray(obj.folders) ? obj.folders : []) {
      const f = readFolder(item)
      if (f && !folders.some((x) => x.id === f.id)) folders.push(f)
      else console.warn('Ignoring a malformed share folder entry')
    }
    const hooks: StoredHook[] = []
    for (const item of Array.isArray(obj.hooks) ? obj.hooks : []) {
      const h = readHook(item)
      if (h && !hooks.some((x) => x.id === h.id)) hooks.push(h)
      else console.warn('Ignoring a malformed share chat entry')
    }
    const off = (Array.isArray(obj.off) ? obj.off : []).filter((id): id is string => typeof id === 'string' && FOLDER_ID.test(id))
    this.data = { folders: folders.slice(0, SHARE_LIMITS.maxFolders), off: [...new Set(off)].slice(0, 100), hooks: hooks.slice(0, SHARE_LIMITS.maxHooks) }
    return this.data
  }

  private write(next: ShareFile): void {
    fs.mkdirSync(path.dirname(this.file), { recursive: true })
    writeFileAtomicSync(this.file, JSON.stringify({ version: FILE_VERSION, ...next }, null, 2))
    this.data = next
  }

  folders(): StoredFolder[] {
    return this.load().folders
  }

  isOff(id: string): boolean {
    return this.load().off.includes(id)
  }

  /** Adds a folder the user picked; one already listed is just turned on. */
  addFolder(folder: string, label: string, now = new Date()): void {
    const d = this.load()
    const id = folderId(folder)
    const off = d.off.filter((x) => x !== id)
    if (d.folders.some((f) => f.id === id)) return this.write({ ...d, off })
    if (d.folders.length >= SHARE_LIMITS.maxFolders) throw new Error(`At most ${SHARE_LIMITS.maxFolders} folders can be added.`)
    this.write({ ...d, off, folders: [...d.folders, { id, path: folder, label: cleanLabel(label, 'Folder'), addedAt: now.toISOString() }] })
  }

  removeFolder(id: string): void {
    const d = this.load()
    if (d.folders.some((f) => f.id === id)) this.write({ ...d, folders: d.folders.filter((f) => f.id !== id) })
  }

  /** Turns a folder on or off (found folders are remembered by id). */
  setOff(id: string, off: boolean): void {
    if (!FOLDER_ID.test(id)) return
    const d = this.load()
    if (off === d.off.includes(id)) return
    this.write({ ...d, off: off ? [...d.off, id] : d.off.filter((x) => x !== id) })
  }

  private decrypt(h: StoredHook): string | null {
    try {
      if (!this.box.isEncryptionAvailable()) return null
      return this.box.decryptString(Buffer.from(h.url, 'base64'))
    } catch {
      return null
    }
  }

  private encrypt(url: string): string {
    if (!this.box.isEncryptionAvailable()) {
      const what = process.platform === 'win32' ? 'Windows data protection' : process.platform === 'darwin' ? 'the Keychain' : 'the system keyring'
      throw new Error(`Webhooks cannot be stored safely on this PC: ${what} is not available, so it was not saved.`)
    }
    const weak = this.box.weakness?.()
    if (weak) throw new Error(`Webhooks cannot be stored safely on this PC (${weak}), so it was not saved.`)
    return this.box.encryptString(url).toString('base64')
  }

  hooks(): ShareHookInfo[] {
    return this.load().hooks.map((h) => {
      const url = this.decrypt(h)
      return { id: h.id, service: h.service, label: h.label, masked: url ? maskWebhook(url) : 'cannot be read', readable: !!url }
    })
  }

  /** Adds a chat; throws a message to show (a bad URL, too many, no safe storage). */
  addHook(label: unknown, rawUrl: unknown, now = new Date()): ShareHookInfo {
    const { service, url } = parseWebhookUrl(rawUrl)
    const d = this.load()
    if (d.hooks.length >= SHARE_LIMITS.maxHooks) throw new Error(`At most ${SHARE_LIMITS.maxHooks} chats can be added.`)
    if (d.hooks.some((h) => this.decrypt(h) === url)) throw new Error('This webhook is already added.')
    const hook: StoredHook = { id: newHookId(), service, label: cleanLabel(label, WEBHOOK_SERVICES[service].label), url: this.encrypt(url), createdAt: now.toISOString() }
    this.write({ ...d, hooks: [...d.hooks, hook] })
    return { id: hook.id, service, label: hook.label, masked: maskWebhook(url), readable: true }
  }

  removeHook(id: unknown): void {
    const d = this.load()
    if (typeof id === 'string' && d.hooks.some((h) => h.id === id)) this.write({ ...d, hooks: d.hooks.filter((h) => h.id !== id) })
  }

  /** A chat with its URL, for a post; throws a message to show. */
  hook(id: unknown): { service: WebhookService; label: string; url: string } {
    const h = typeof id === 'string' ? this.load().hooks.find((x) => x.id === id) : undefined
    if (!h) throw new Error('This chat is no longer set up. Add it again in Settings › Share.')
    const url = this.decrypt(h)
    if (!url) throw new Error(`The webhook of “${h.label}” can no longer be read on this PC. Remove it and paste it again in Settings › Share.`)
    return { service: h.service, label: h.label, url }
  }
}
