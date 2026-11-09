import fs from 'node:fs'
import os from 'node:os'
import path from 'node:path'
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'
import { AiProviderStore, type SecretBox } from '../src/main/ai/keyStore'
import { SERVICE_MESSAGES, ServiceStore, validateServiceInput } from '../src/main/ai/serviceStore'
import { clearSecrets, secretValues } from '../src/main/ai/secrets'

/*
 * Services' own store (docs/design/smart-tools.md §10.1, §22 tests 82 and 83): ai-services.json beside
 * ai-providers.json, keys encrypted and bound to their origin, an empty key only on this PC, at most
 * 20 together with the providers, malformed entries dropped, the JSON mode kept; keyForDraft gives
 * the stored key only at the same origin. Listing merges providers then services, and an older
 * ai-providers.json loads and saves exactly as before.
 */

const box: SecretBox = {
  isEncryptionAvailable: () => true,
  encryptString: (plain) => Buffer.from(`enc:${plain}`),
  decryptString: (enc) => {
    const s = enc.toString()
    if (!s.startsWith('enc:')) throw new Error('bad')
    return s.slice(4)
  }
}
const GROQ_KEY = 'gsk_test_0123456789abcdef'
const groq = (extra: Record<string, unknown> = {}): Record<string, unknown> => ({
  kind: 'openai',
  label: 'Groq',
  apiKey: GROQ_KEY,
  model: 'openai/gpt-oss-20b',
  service: { preset: 'groq', baseUrl: 'https://api.groq.com/openai/v1' },
  ...extra
})

let dir: string
let file: string
beforeEach(() => {
  dir = fs.mkdtempSync(path.join(os.tmpdir(), 'svc-'))
  file = path.join(dir, 'ai-services.json')
  clearSecrets()
})
afterEach(() => fs.rmSync(dir, { recursive: true, force: true }))

const read = (): { version: number; services: Record<string, unknown>[] } => JSON.parse(fs.readFileSync(file, 'utf8'))

describe('ServiceStore (test 82)', () => {
  it('keeps services in its own file, keys encrypted, ids svc…; the renderer sees no key', () => {
    const store = new ServiceStore(file, box)
    const info = store.save(groq(), new Date('2026-11-09T10:00:00Z'))
    expect(info.id).toMatch(/^svc[a-z0-9]+$/)
    expect(info).toMatchObject({ kind: 'openai', label: 'Groq', model: 'openai/gpt-oss-20b', maskedKey: '…cdef', canTranscribe: false })
    expect(info.service).toEqual({ preset: 'groq', baseUrl: 'https://api.groq.com/openai/v1', host: 'api.groq.com', loopback: false, json: 'text' })
    expect(JSON.stringify(info)).not.toContain(GROQ_KEY)
    const raw = read()
    expect(raw.version).toBe(1)
    expect(raw.services[0]).toMatchObject({ id: info.id, preset: 'groq', origin: 'https://api.groq.com', key: Buffer.from(`enc:${GROQ_KEY}`).toString('base64') })
    expect(fs.readFileSync(file, 'utf8')).not.toContain(GROQ_KEY)
    expect(fs.existsSync(path.join(dir, 'ai-providers.json'))).toBe(false)
    expect(new ServiceStore(file, box).get(info.id)).toEqual({ info, apiKey: GROQ_KEY })
    expect(secretValues()).toContain(GROQ_KEY)
  })

  it('allows an empty key only for a service on this PC', () => {
    const store = new ServiceStore(file, box)
    expect(() => store.save(groq({ apiKey: '' }))).toThrow(SERVICE_MESSAGES.key)
    const ollama = store.save({ kind: 'openai', label: 'Ollama', model: 'llama3.2:3b', service: { preset: 'ollama', baseUrl: 'http://localhost:11434/v1' } })
    expect(ollama.maskedKey).toBe('none')
    expect(ollama.service).toMatchObject({ loopback: true, host: 'localhost:11434' })
    expect(store.get(ollama.id).apiKey).toBeNull()
    expect(read().services[0]).not.toHaveProperty('key')
  })

  it('a new origin needs the key again; the same origin keeps it', () => {
    const store = new ServiceStore(file, box)
    const saved = store.save(groq())
    expect(() => store.save(groq({ id: saved.id, apiKey: undefined, service: { preset: 'other', baseUrl: 'https://groq.example.com/openai/v1' } }))).toThrow(SERVICE_MESSAGES.newAddress)
    // Moving it to this PC without a key drops the key: none goes to the new address.
    const moved = store.save(groq({ id: saved.id, apiKey: undefined, service: { preset: 'other', baseUrl: 'http://127.0.0.1:8080/v1' } }))
    expect(moved.maskedKey).toBe('none')
    expect(store.get(saved.id).apiKey).toBeNull()
    const back = store.save(groq({ id: saved.id }))
    const renamed = store.save(groq({ id: saved.id, apiKey: undefined, label: 'Groq 2', service: { preset: 'groq', baseUrl: 'https://api.groq.com/openai/v1/' } }))
    expect(renamed).toMatchObject({ label: 'Groq 2', maskedKey: back.maskedKey })
    expect(store.get(saved.id).apiKey).toBe(GROQ_KEY)
  })

  it('refuses an address that is not https off this PC, and a bad model or preset', () => {
    const store = new ServiceStore(file, box)
    expect(() => store.save(groq({ service: { preset: 'other', baseUrl: 'http://192.168.1.5:11434/v1' } }))).toThrow(/https:\/\//)
    expect(() => store.save(groq({ service: { preset: 'other', baseUrl: 'https://u:p@example.com/v1' } }))).toThrow(/name and password/)
    expect(() => store.save(groq({ model: '' }))).toThrow(SERVICE_MESSAGES.model)
    expect(() => store.save(groq({ model: 'bad model' }))).toThrow(/not a model name/)
    expect(() => store.save(groq({ service: { preset: 'evil', baseUrl: 'https://api.groq.com/openai/v1' } }))).toThrow(/Choose a service/)
    expect(() => store.save(groq({ kind: 'gemini' }))).toThrow(/Invalid provider/)
    expect(() => store.save(groq({ id: 'ai123' }))).toThrow(/Invalid provider/)
  })

  it('OpenRouter keeps no prompts unless unticked; other presets never send it', () => {
    expect(validateServiceInput(groq({ service: { preset: 'openrouter', baseUrl: 'https://openrouter.ai/api/v1' } })).service.keepNoData).toBe(true)
    expect(validateServiceInput(groq({ service: { preset: 'openrouter', baseUrl: 'https://openrouter.ai/api/v1', keepNoData: false } })).service).not.toHaveProperty('keepNoData')
    expect(validateServiceInput(groq({ service: { preset: 'groq', baseUrl: 'https://api.groq.com/openai/v1', keepNoData: true } })).service).not.toHaveProperty('keepNoData')
  })

  it('holds at most 20 together with the providers', () => {
    fs.writeFileSync(path.join(dir, 'ai-providers.json'), JSON.stringify({ version: 1, providers: Array.from({ length: 18 }, (_, i) => ({ id: `ai${i}` })) }))
    const store = new ServiceStore(file, box)
    store.save(groq())
    store.save(groq())
    expect(() => store.save(groq())).toThrow(SERVICE_MESSAGES.full)
    expect(new ServiceStore(file, box, () => 0).list()).toHaveLength(2)
  })

  it('drops a malformed entry with a warning and keeps the rest', () => {
    const store = new ServiceStore(file, box)
    const good = store.save(groq())
    const raw = read()
    const bad = [
      { ...raw.services[0], id: 'svcx1', origin: 'https://evil.example' },
      { ...raw.services[0], id: 'svcx2', baseUrl: 'http://api.groq.com/openai/v1', origin: 'http://api.groq.com' },
      { ...raw.services[0], id: 'svcx3', key: undefined },
      { ...raw.services[0], id: 'ai1' },
      { ...raw.services[0], id: 'svcx4', json: 'xml' },
      'nonsense'
    ]
    fs.writeFileSync(file, JSON.stringify({ version: 1, services: [...raw.services, ...bad] }))
    const warn = vi.spyOn(console, 'warn').mockImplementation(() => undefined)
    expect(new ServiceStore(file, box).list().map((s) => s.id)).toEqual([good.id])
    expect(warn).toHaveBeenCalledWith('Ignoring a malformed AI service entry')
    warn.mockRestore()
  })

  it('setJsonMode is saved; a new address or model is checked again', () => {
    const store = new ServiceStore(file, box)
    const s = store.save(groq())
    store.setJsonMode(s.id, 'schema')
    expect(new ServiceStore(file, box).get(s.id).info.service!.json).toBe('schema')
    store.setJsonMode(s.id, 'nonsense' as 'text')
    expect(new ServiceStore(file, box).get(s.id).info.service!.json).toBe('schema')
    expect(store.save(groq({ id: s.id, apiKey: undefined })).service!.json).toBe('schema')
    expect(store.save(groq({ id: s.id, apiKey: undefined, model: 'llama-4-scout' })).service!.json).toBe('text')
  })

  it('keyForDraft gives the stored key only for the same origin', () => {
    const store = new ServiceStore(file, box)
    const s = store.save(groq())
    expect(store.keyForDraft({ ...groq({ id: s.id, apiKey: undefined }) } as never)).toBe(GROQ_KEY)
    expect(() => store.keyForDraft({ ...groq({ id: s.id, apiKey: undefined, service: { preset: 'groq', baseUrl: 'https://api.groq.com.evil.example/openai/v1' } }) } as never)).toThrow(SERVICE_MESSAGES.newAddress)
    expect(() => store.keyForDraft({ ...groq({ id: s.id, apiKey: undefined, service: { preset: 'groq', baseUrl: 'https://api.groq.com:8443/openai/v1' } }) } as never)).toThrow(SERVICE_MESSAGES.newAddress)
    expect(store.keyForDraft({ ...groq({ id: s.id, apiKey: 'own_key_123456789' }) } as never)).toBe('own_key_123456789')
    expect(() => store.keyForDraft({ ...groq({ apiKey: undefined }) } as never)).toThrow(SERVICE_MESSAGES.key)
    expect(store.keyForDraft({ ...groq({ id: s.id, apiKey: undefined, service: { preset: 'ollama', baseUrl: 'http://localhost:11434/v1' } }) } as never)).toBeNull()
  })
})

describe('providers and services listed together (test 83)', () => {
  it('an older ai-providers.json loads and saves unchanged; services never touch it', () => {
    const providersFile = path.join(dir, 'ai-providers.json')
    const old = {
      version: 1,
      providers: [{ id: 'ai1', kind: 'openai', label: 'My OpenAI', model: 'gpt-6.1-sol', createdAt: '2026-01-01T00:00:00.000Z', key: Buffer.from('enc:sk-old-key-0123456789').toString('base64') }]
    }
    const text = JSON.stringify(old, null, 2)
    fs.writeFileSync(providersFile, text)
    const providers = new AiProviderStore(providersFile, box)
    const services = new ServiceStore(file, box)
    services.save(groq())
    const merged = [...providers.list(), ...services.list()]
    expect(merged.map((p) => p.kind)).toEqual(['openai', 'openai'])
    expect(merged[0]).not.toHaveProperty('service')
    expect(merged[1].service?.host).toBe('api.groq.com')
    expect(fs.readFileSync(providersFile, 'utf8')).toBe(text)
    // Saving the old provider again writes what an older Flown wrote.
    providers.save({ id: 'ai1', kind: 'openai', label: 'My OpenAI', model: 'gpt-6.1-sol' }, new Date())
    expect(JSON.parse(fs.readFileSync(providersFile, 'utf8'))).toEqual(old)
  })
})
