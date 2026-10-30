/**
 * The user's AI providers and their API keys, in userData/ai-providers.json. Keys are encrypted
 * with Electron's safeStorage (DPAPI on Windows, tied to the Windows user) before they touch the
 * disk; when it is unavailable no key is stored at all. Keys never leave the main process: the
 * renderer gets AiProviderInfo, with only the last characters of the key. Nothing here logs a key.
 *
 * Writes are atomic (writeFileAtomicSync). The file is checked entry by entry when read: an
 * entry that is malformed is dropped with a warning, a missing or unreadable file means none.
 */
import fs from 'node:fs'
import path from 'node:path'
import { AI_LIMITS, AI_PROVIDER_KINDS, type AiProviderInfo, type AiProviderInput } from '../../shared/api/ai'
import type { AiProviderKind } from '../../shared/types'
import { writeFileAtomicSync } from '../atomicWrite'

const FILE_VERSION = 1

/** What safeStorage offers (injectable for tests). */
export interface SecretBox {
  isEncryptionAvailable(): boolean
  encryptString(plain: string): Buffer
  decryptString(encrypted: Buffer): string
  /** Why encryption should not be trusted on this system even though it is "available", if so. */
  weakness?(): string | null
}

interface StoredProvider {
  id: string
  kind: AiProviderKind
  label: string
  model: string
  transcriptionModel?: string
  createdAt: string
  /** The encrypted key, base64. */
  key: string
}

const ID_RE = /^ai[a-z0-9]{1,30}$/
const MODEL_RE = /^[A-Za-z0-9][A-Za-z0-9._:/@-]*$/
/** Printable ASCII without spaces: every provider's keys look like that. */
const KEY_RE = /^[\x21-\x7e]+$/

const KINDS = Object.keys(AI_PROVIDER_KINDS) as AiProviderKind[]
const isKind = (v: unknown): v is AiProviderKind => typeof v === 'string' && (KINDS as string[]).includes(v)
const isObject = (v: unknown): v is Record<string, unknown> => typeof v === 'object' && v !== null && !Array.isArray(v)

let idCounter = 0
const newId = (): string => `ai${Date.now().toString(36)}${(idCounter++).toString(36)}`

/** A model name from the form: trimmed, `fallback` when empty; throws when it cannot be a model id. */
function modelName(v: unknown, fallback: string, what: string): string {
  if (v === undefined || v === null || (typeof v === 'string' && !v.trim())) return fallback
  if (typeof v !== 'string') throw new Error(`The ${what} must be text.`)
  const s = v.trim()
  if (s.length > AI_LIMITS.modelLength || !MODEL_RE.test(s)) throw new Error(`“${s.slice(0, 40)}” is not a model name (letters, digits and . _ - : / @ only).`)
  return s
}

/** An AiProviderInput from the renderer, checked field by field; throws a message to show. */
/** Each kind's suggested models: the bundled ones, or the refreshed list's (modelList.ts). */
export type ModelDefaultsOf = (kind: AiProviderKind) => { model: string; transcriptionModel?: string }
const builtinDefaults: ModelDefaultsOf = (kind) => ({ model: AI_PROVIDER_KINDS[kind].defaultModel, transcriptionModel: AI_PROVIDER_KINDS[kind].defaultTranscriptionModel })

export function validateProviderInput(input: unknown, defaults: ModelDefaultsOf = builtinDefaults): AiProviderInput {
  if (!isObject(input)) throw new Error('Invalid provider.')
  if (!isKind(input.kind)) throw new Error('Choose OpenAI, Google Gemini or Anthropic Claude.')
  if (input.id !== undefined && (typeof input.id !== 'string' || !ID_RE.test(input.id))) throw new Error('Invalid provider.')
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
  const info = AI_PROVIDER_KINDS[input.kind]
  const suggested = defaults(input.kind)
  return {
    ...(input.id !== undefined ? { id: input.id as string } : {}),
    kind: input.kind,
    label,
    ...(apiKey ? { apiKey } : {}),
    model: modelName(input.model, suggested.model, 'model'),
    ...(info.canTranscribe ? { transcriptionModel: modelName(input.transcriptionModel, suggested.transcriptionModel ?? '', 'transcription model') } : {})
  }
}

/** A stored entry, or null when malformed. */
function readEntry(raw: unknown): StoredProvider | null {
  if (!isObject(raw)) return null
  const { id, kind, label, model, transcriptionModel, createdAt, key } = raw
  if (typeof id !== 'string' || !ID_RE.test(id) || !isKind(kind)) return null
  if (typeof label !== 'string' || !label.trim() || label.length > AI_LIMITS.labelLength) return null
  if (typeof model !== 'string' || !MODEL_RE.test(model) || model.length > AI_LIMITS.modelLength) return null
  if (transcriptionModel !== undefined && (typeof transcriptionModel !== 'string' || !MODEL_RE.test(transcriptionModel))) return null
  if (typeof createdAt !== 'string' || typeof key !== 'string' || !/^[A-Za-z0-9+/]+=*$/.test(key)) return null
  return { id, kind, label, model, ...(transcriptionModel ? { transcriptionModel } : {}), createdAt, key }
}

export class AiProviderStore {
  private entries: StoredProvider[] | null = null

  constructor(
    readonly file: string,
    private readonly box: SecretBox,
    private readonly defaults: ModelDefaultsOf = builtinDefaults
  ) {}

  private load(): StoredProvider[] {
    if (this.entries) return this.entries
    let raw: unknown = null
    try {
      raw = JSON.parse(fs.readFileSync(this.file, 'utf8'))
    } catch (err) {
      if ((err as NodeJS.ErrnoException).code !== 'ENOENT') console.warn('Ignoring an unreadable AI providers file')
    }
    const list = isObject(raw) && Array.isArray(raw.providers) ? raw.providers : []
    const entries: StoredProvider[] = []
    for (const item of list) {
      const entry = readEntry(item)
      if (entry && !entries.some((e) => e.id === entry.id)) entries.push(entry)
      else console.warn('Ignoring a malformed AI provider entry')
    }
    this.entries = entries.slice(0, AI_LIMITS.maxProviders)
    return this.entries
  }

  private write(entries: StoredProvider[]): void {
    fs.mkdirSync(path.dirname(this.file), { recursive: true })
    writeFileAtomicSync(this.file, JSON.stringify({ version: FILE_VERSION, providers: entries }, null, 2))
    this.entries = entries
  }

  private decrypt(entry: StoredProvider): string | null {
    try {
      if (!this.box.isEncryptionAvailable()) return null
      return this.box.decryptString(Buffer.from(entry.key, 'base64'))
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
    return this.box.encryptString(apiKey).toString('base64')
  }

  private info(entry: StoredProvider): AiProviderInfo {
    const key = this.decrypt(entry)
    const canTranscribe = AI_PROVIDER_KINDS[entry.kind].canTranscribe
    return {
      id: entry.id,
      kind: entry.kind,
      label: entry.label,
      model: entry.model,
      ...(canTranscribe && entry.transcriptionModel ? { transcriptionModel: entry.transcriptionModel } : {}),
      maskedKey: key ? `…${key.slice(-4)}` : 'unreadable',
      createdAt: entry.createdAt,
      canTranscribe
    }
  }

  list(): AiProviderInfo[] {
    return this.load().map((e) => this.info(e))
  }

  /** Adds or updates a provider from the renderer's input; returns what the renderer may see. */
  save(raw: unknown, now = new Date()): AiProviderInfo {
    const input = validateProviderInput(raw, this.defaults)
    const entries = this.load()
    const existing = input.id !== undefined ? entries.find((e) => e.id === input.id) : undefined
    if (input.id !== undefined && !existing) throw new Error('This provider no longer exists.')
    if (!existing && !input.apiKey) throw new Error('Enter the API key.')
    if (existing && existing.kind !== input.kind && !input.apiKey) throw new Error('Enter the API key for the new kind of provider.')
    if (!existing && entries.length >= AI_LIMITS.maxProviders) throw new Error(`At most ${AI_LIMITS.maxProviders} providers can be added.`)
    const entry: StoredProvider = {
      id: existing?.id ?? newId(),
      kind: input.kind,
      label: input.label,
      model: input.model!,
      ...(input.transcriptionModel ? { transcriptionModel: input.transcriptionModel } : {}),
      createdAt: existing?.createdAt ?? now.toISOString(),
      key: input.apiKey ? this.encrypt(input.apiKey) : existing!.key
    }
    this.write(existing ? entries.map((e) => (e.id === entry.id ? entry : e)) : [...entries, entry])
    return this.info(entry)
  }

  remove(id: unknown): void {
    const entries = this.load()
    if (typeof id !== 'string' || !entries.some((e) => e.id === id)) return
    this.write(entries.filter((e) => e.id !== id))
  }

  /** A provider with its key, for a request; throws a message to show when it is gone or its key cannot be read. */
  get(id: unknown): { info: AiProviderInfo; apiKey: string } {
    const entry = typeof id === 'string' ? this.load().find((e) => e.id === id) : undefined
    if (!entry) throw new Error('This AI provider no longer exists. Choose another one in Settings → AI providers.')
    const apiKey = this.decrypt(entry)
    if (!apiKey) throw new Error(`The API key of “${entry.label}” can no longer be read on this PC (it was saved by another Windows user or PC). Edit the provider and enter the key again.`)
    return { info: this.info(entry), apiKey }
  }
}
