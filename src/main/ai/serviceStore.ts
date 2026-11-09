/**
 * Services reached at a base URL (docs/design/smart-tools.md §10.1): userData/ai-services.json,
 * `{ version: 1, services: [...] }`, written atomically and read entry by entry as ai-providers.json
 * is (keyStore.ts): a malformed entry is dropped with a warning. Older Flown never reads this file,
 * so it can neither drop a service nor send a service's key elsewhere.
 *
 * Each key is encrypted with safeStorage (a weak Linux keyring refused, as keyStore does) and bound
 * to the origin it was entered for: a new origin needs the key again, and a draft model list with an
 * edited address never borrows the stored key (keyForDraft). A key may be left out only for a
 * service on this PC (a loopback origin). The renderer sees AiProviderInfo with `kind: 'openai'` (the
 * API spoken) and `service`; of the key, only its last 4 characters. Nothing here logs a key; main
 * registers each key it reads or saves to be taken out of logs and error messages (secrets.ts).
 */
import fs from 'node:fs'
import path from 'node:path'
import { AI_LIMITS, type AiProviderInfo, type AiProviderInput, type ServiceInfo, type ServicePreset } from '../../shared/api/ai'
import { readBaseUrl } from '../../shared/ai/baseUrl'
import { SERVICE_PRESETS } from '../../shared/ai/presets'
import { writeFileAtomicSync } from '../atomicWrite'
import type { SecretBox } from './keyStore'
import { registerSecret } from './secrets'

const FILE_VERSION = 1

interface StoredService {
  id: string
  preset: ServicePreset
  label: string
  /** Normalised (§10.2). */
  baseUrl: string
  /** scheme://host[:port] the key is bound to. */
  origin: string
  model: string
  /** From the last check (§10.3); 'text' until checked. */
  json: ServiceInfo['json']
  /** OpenRouter: provider.data_collection 'deny' (§0 decision 5). */
  keepNoData?: true
  createdAt: string
  /** Encrypted with safeStorage, base64; absent only for a loopback origin. */
  key?: string
}

export const SERVICE_ID_RE = /^svc[a-z0-9]{1,30}$/
const MODEL_RE = /^[A-Za-z0-9][A-Za-z0-9._:/@-]*$/
/** Printable ASCII without spaces: every service's keys look like that. */
const KEY_RE = /^[\x21-\x7e]+$/
const PRESETS = Object.keys(SERVICE_PRESETS) as ServicePreset[]
const JSON_MODES: readonly ServiceInfo['json'][] = ['schema', 'object', 'text']

const isObject = (v: unknown): v is Record<string, unknown> => typeof v === 'object' && v !== null && !Array.isArray(v)
const isPreset = (v: unknown): v is ServicePreset => typeof v === 'string' && (PRESETS as string[]).includes(v)

export const SERVICE_MESSAGES = {
  gone: 'This AI provider no longer exists. Choose another one in Settings → AI providers.',
  key: 'Enter the API key.',
  newAddress: 'Enter the API key for the new address.',
  model: "Enter the model's name.",
  full: `At most ${AI_LIMITS.maxProviders} providers can be added.`
} as const

let idCounter = 0
const newId = (): string => `svc${Date.now().toString(36)}${(idCounter++).toString(36)}`

/** A model name from the form: trimmed; throws when empty or not a model id. */
function modelName(v: unknown): string {
  if (typeof v !== 'string' || !v.trim()) throw new Error(SERVICE_MESSAGES.model)
  const s = v.trim()
  if (s.length > AI_LIMITS.modelLength || !MODEL_RE.test(s)) throw new Error(`“${s.slice(0, 40)}” is not a model name (letters, digits and . _ - : / @ only).`)
  return s
}

/** A service from the renderer (AiProviderInput with `service`), checked field by field; throws a message to show. */
export function validateServiceInput(input: unknown): AiProviderInput & { service: NonNullable<AiProviderInput['service']> } {
  if (!isObject(input)) throw new Error('Invalid provider.')
  if (input.kind !== 'openai') throw new Error('Invalid provider.')
  if (input.id !== undefined && (typeof input.id !== 'string' || !SERVICE_ID_RE.test(input.id))) throw new Error('Invalid provider.')
  const service = input.service
  if (!isObject(service) || !isPreset(service.preset) || typeof service.baseUrl !== 'string') throw new Error('Choose a service.')
  const url = readBaseUrl(service.baseUrl)
  if (!url.ok) throw new Error(url.message)
  if (typeof input.label !== 'string') throw new Error('Give the provider a name.')
  const label = input.label.replace(/\s+/g, ' ').trim()
  if (!label) throw new Error('Give the provider a name.')
  if (label.length > AI_LIMITS.labelLength) throw new Error(`The name is too long (at most ${AI_LIMITS.labelLength} characters).`)
  let apiKey: string | undefined
  if (input.apiKey !== undefined && input.apiKey !== null && input.apiKey !== '') {
    if (typeof input.apiKey !== 'string') throw new Error('The API key must be text.')
    apiKey = input.apiKey.trim()
    if (apiKey.length < 8 || apiKey.length > AI_LIMITS.keyLength || !KEY_RE.test(apiKey)) throw new Error('That does not look like an API key (copy the whole key, without spaces).')
  }
  if (service.keepNoData !== undefined && typeof service.keepNoData !== 'boolean') throw new Error('Invalid provider.')
  // OpenRouter keeps no prompts unless the user unticks it (§0 decision 5); the others never send it.
  const keepNoData = service.preset === 'openrouter' && service.keepNoData !== false
  return {
    ...(input.id !== undefined ? { id: input.id as string } : {}),
    kind: 'openai',
    label,
    ...(apiKey ? { apiKey } : {}),
    model: modelName(input.model),
    service: { preset: service.preset, baseUrl: url.baseUrl, ...(keepNoData ? { keepNoData: true } : {}) }
  }
}

/** A stored entry, or null when malformed: its origin must be its base URL's, and a key may be missing only on this PC. */
function readEntry(raw: unknown): StoredService | null {
  if (!isObject(raw)) return null
  const { id, preset, label, baseUrl, origin, model, json, keepNoData, createdAt, key } = raw
  if (typeof id !== 'string' || !SERVICE_ID_RE.test(id) || !isPreset(preset)) return null
  if (typeof label !== 'string' || !label.trim() || label.length > AI_LIMITS.labelLength) return null
  if (typeof baseUrl !== 'string' || typeof origin !== 'string') return null
  const url = readBaseUrl(baseUrl)
  if (!url.ok || url.baseUrl !== baseUrl || url.origin !== origin) return null
  if (typeof model !== 'string' || !MODEL_RE.test(model) || model.length > AI_LIMITS.modelLength) return null
  if (!JSON_MODES.includes(json as ServiceInfo['json'])) return null
  if (keepNoData !== undefined && keepNoData !== true) return null
  if (typeof createdAt !== 'string') return null
  if (key !== undefined && (typeof key !== 'string' || !/^[A-Za-z0-9+/]+=*$/.test(key))) return null
  if (key === undefined && !url.loopback) return null
  return { id, preset, label, baseUrl, origin, model, json: json as ServiceInfo['json'], ...(keepNoData ? { keepNoData: true as const } : {}), createdAt, ...(key !== undefined ? { key } : {}) }
}

/** How many providers ai-providers.json lists (read only, never written): services and providers make at most 20 together. */
function providersBeside(file: string): number {
  try {
    const raw = JSON.parse(fs.readFileSync(path.join(path.dirname(file), 'ai-providers.json'), 'utf8')) as unknown
    return isObject(raw) && Array.isArray(raw.providers) ? Math.min(raw.providers.length, AI_LIMITS.maxProviders) : 0
  } catch {
    return 0
  }
}

export class ServiceStore {
  private entries: StoredService[] | null = null

  constructor(
    readonly file: string,
    private readonly box: SecretBox,
    /** How many providers there are besides the services (default: those ai-providers.json next to `file` lists). */
    private readonly providerCount: () => number = () => providersBeside(file)
  ) {}

  private load(): StoredService[] {
    if (this.entries) return this.entries
    let raw: unknown = null
    try {
      raw = JSON.parse(fs.readFileSync(this.file, 'utf8'))
    } catch (err) {
      if ((err as NodeJS.ErrnoException).code !== 'ENOENT') console.warn('Ignoring an unreadable AI services file')
    }
    const list = isObject(raw) && Array.isArray(raw.services) ? raw.services : []
    const entries: StoredService[] = []
    for (const item of list) {
      const entry = readEntry(item)
      if (entry && !entries.some((e) => e.id === entry.id)) entries.push(entry)
      else console.warn('Ignoring a malformed AI service entry')
    }
    this.entries = entries.slice(0, AI_LIMITS.maxProviders)
    return this.entries
  }

  private write(entries: StoredService[]): void {
    fs.mkdirSync(path.dirname(this.file), { recursive: true })
    writeFileAtomicSync(this.file, JSON.stringify({ version: FILE_VERSION, services: entries }, null, 2))
    this.entries = entries
  }

  private decrypt(entry: StoredService): string | null {
    if (entry.key === undefined) return null
    try {
      if (!this.box.isEncryptionAvailable()) return null
      const key = this.box.decryptString(Buffer.from(entry.key, 'base64'))
      registerSecret(key)
      return key
    } catch {
      return null
    }
  }

  private encrypt(apiKey: string): string {
    if (!this.box.isEncryptionAvailable()) {
      const what = process.platform === 'win32' ? 'Windows data protection' : process.platform === 'darwin' ? 'the Keychain' : 'the system keyring'
      throw new Error(`API keys cannot be stored safely on this PC: ${what} is not available, so the key was not saved.`)
    }
    const weak = this.box.weakness?.()
    if (weak) throw new Error(`API keys cannot be stored safely on this PC (${weak}), so the key was not saved.`)
    registerSecret(apiKey)
    return this.box.encryptString(apiKey).toString('base64')
  }

  private info(entry: StoredService): AiProviderInfo {
    const url = readBaseUrl(entry.baseUrl)
    const key = this.decrypt(entry)
    return {
      id: entry.id,
      kind: 'openai',
      label: entry.label,
      model: entry.model,
      maskedKey: entry.key === undefined ? 'none' : key ? `…${key.slice(-4)}` : 'unreadable',
      createdAt: entry.createdAt,
      canTranscribe: false,
      service: {
        preset: entry.preset,
        baseUrl: entry.baseUrl,
        host: url.ok ? url.host : '',
        loopback: url.ok && url.loopback,
        json: entry.json,
        ...(entry.keepNoData ? { keepNoData: true } : {})
      }
    }
  }

  list(): AiProviderInfo[] {
    return this.load().map((e) => this.info(e))
  }

  /** A service with its key (null for one on this PC without a key), for a request; throws a message to show. */
  get(id: unknown): { info: AiProviderInfo; apiKey: string | null } {
    const entry = typeof id === 'string' ? this.load().find((e) => e.id === id) : undefined
    if (!entry) throw new Error(SERVICE_MESSAGES.gone)
    const apiKey = this.decrypt(entry)
    if (entry.key !== undefined && !apiKey) {
      throw new Error(`The API key of “${entry.label}” can no longer be read on this PC (it was saved by another Windows user or PC). Edit the provider and enter the key again.`)
    }
    return { info: this.info(entry), apiKey }
  }

  /**
   * The key a model list for `draft` (a form not saved yet) may use (§10.4): the draft's own; else
   * the stored key of the entry `draft.id` names, only when the draft is a service at that entry's
   * origin; null for a service on this PC without a key. Anything else is refused, so an edited
   * address, typed wrong or sent by a compromised page, never receives the stored key. A service
   * saved with a key whose address moves to another one on this PC is asked for the key again
   * ("Enter the API key for the new address.", as its form says) and nothing is sent there, unless
   * its preset needs no key (Ollama, LM Studio).
   */
  keyForDraft(draft: AiProviderInput): string | null {
    const input = validateServiceInput({ ...draft, model: typeof draft?.model === 'string' && draft.model.trim() ? draft.model : 'x' })
    if (input.apiKey) return input.apiKey
    const url = readBaseUrl(input.service.baseUrl)
    if (!url.ok) throw new Error(url.message)
    const entry = input.id !== undefined ? this.load().find((e) => e.id === input.id) : undefined
    if (entry && entry.origin === url.origin && entry.key !== undefined) {
      const key = this.decrypt(entry)
      if (!key) throw new Error(SERVICE_MESSAGES.newAddress)
      return key
    }
    if (entry && entry.key !== undefined && SERVICE_PRESETS[input.service.preset].keyNeeded) throw new Error(SERVICE_MESSAGES.newAddress)
    if (url.loopback) return null
    throw new Error(entry ? SERVICE_MESSAGES.newAddress : SERVICE_MESSAGES.key)
  }

  /** Adds or updates a service from the renderer's input; returns what the renderer may see. */
  save(raw: unknown, now = new Date()): AiProviderInfo {
    const input = validateServiceInput(raw)
    const url = readBaseUrl(input.service.baseUrl)
    if (!url.ok) throw new Error(url.message)
    const entries = this.load()
    const existing = input.id !== undefined ? entries.find((e) => e.id === input.id) : undefined
    if (input.id !== undefined && !existing) throw new Error(SERVICE_MESSAGES.gone)
    if (!existing && entries.length + this.providerCount() >= AI_LIMITS.maxProviders) throw new Error(SERVICE_MESSAGES.full)
    let key: string | undefined
    if (input.apiKey) key = this.encrypt(input.apiKey)
    else if (existing && existing.origin === url.origin) key = existing.key
    // A new address never takes the old key: it needs its own, or none on this PC.
    else if (!url.loopback) throw new Error(existing ? SERVICE_MESSAGES.newAddress : SERVICE_MESSAGES.key)
    const entry: StoredService = {
      id: existing?.id ?? newId(),
      preset: input.service.preset,
      label: input.label,
      baseUrl: url.baseUrl,
      origin: url.origin,
      model: input.model!,
      // A new address or model answers in its own way: checked again by Save and check.
      json: existing && existing.origin === url.origin && existing.model === input.model ? existing.json : 'text',
      ...(input.service.keepNoData ? { keepNoData: true as const } : {}),
      createdAt: existing?.createdAt ?? now.toISOString(),
      ...(key !== undefined ? { key } : {})
    }
    this.write(existing ? entries.map((e) => (e.id === entry.id ? entry : e)) : [...entries, entry])
    return this.info(entry)
  }

  remove(id: unknown): void {
    const entries = this.load()
    if (typeof id !== 'string' || !entries.some((e) => e.id === id)) return
    this.write(entries.filter((e) => e.id !== id))
  }

  /** Keeps how service `id` answers in JSON (Save and check, or a request that dropped a level). */
  setJsonMode(id: string, json: ServiceInfo['json']): void {
    if (!JSON_MODES.includes(json)) return
    const entries = this.load()
    const entry = entries.find((e) => e.id === id)
    if (!entry || entry.json === json) return
    this.write(entries.map((e) => (e.id === id ? { ...e, json } : e)))
  }
}
