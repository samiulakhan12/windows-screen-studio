/**
 * ai:saveProvider with `replaces` (docs/design/smart-tools.md §10.1): a provider edited into a
 * service, or a service into a provider, takes the place of the one it was. That one is not counted
 * toward the cap of 20 and goes once the new one is saved; an id of the same store, or one that does
 * not exist, changes nothing and the cap holds. A new provider counts the services too, as a new
 * service counts the providers.
 */
import fs from 'node:fs'
import os from 'node:os'
import path from 'node:path'
import { pathToFileURL } from 'node:url'
import { beforeEach, describe, expect, it, vi } from 'vitest'
import type { AiProviderInfo } from '../src/shared/api/ai'

const h = vi.hoisted(() => ({ userData: '', handlers: new Map<string, (...args: unknown[]) => unknown>() }))

vi.mock('electron', () => ({
  app: { getPath: () => h.userData, isPackaged: false, on: () => undefined, getAppPath: () => '/nonexistent' },
  session: {},
  ipcMain: { handle: (channel: string, fn: (...args: unknown[]) => unknown) => h.handlers.set(channel, fn) },
  safeStorage: { isEncryptionAvailable: () => true, encryptString: (s: string) => Buffer.from(s), decryptString: (b: Buffer) => b.toString(), getSelectedStorageBackend: () => 'dpapi' }
}))
vi.mock('../src/main/ai/transcribe', () => ({ stopAllTranscriptions: () => undefined, stopTranscription: () => undefined, sweepTranscribeTemp: async () => undefined, transcribeProject: async () => undefined }))

h.userData = fs.mkdtempSync(path.join(os.tmpdir(), 'w11-replaces-'))
const { registerAiIpc } = await import('../src/main/aiIpc')
registerAiIpc()

const appEvent = { senderFrame: { url: pathToFileURL(path.join(__dirname, '../src/renderer/index.html')).href }, sender: { send: () => undefined, isDestroyed: () => false } }
const call = <T>(channel: string, ...args: unknown[]): T => h.handlers.get(channel)!(appEvent, ...args) as T
const KEY = 'gsk_0123456789abcdef0123456789'
const provider = (label: string, extra: Record<string, unknown> = {}): Record<string, unknown> => ({ kind: 'openai', label, apiKey: 'sk-0123456789abcdef0123456789', model: 'gpt-6.1-sol', ...extra })
const service = (label: string, extra: Record<string, unknown> = {}): Record<string, unknown> => ({ kind: 'openai', label, apiKey: KEY, model: 'llama-4-scout', service: { preset: 'groq', baseUrl: 'https://api.groq.com/openai/v1' }, ...extra })
const list = (): AiProviderInfo[] => call<AiProviderInfo[]>('ai:listProviders')
const FULL = 'At most 20 providers can be added.'

let providers: AiProviderInfo[] = []
let services: AiProviderInfo[] = []
beforeEach(() => {
  // 15 providers and 5 services: the cap of 20.
  for (let left = list(); left.length; left = list()) for (const p of left) call('ai:removeProvider', p.id)
  providers = Array.from({ length: 15 }, (_, i) => call<AiProviderInfo>('ai:saveProvider', provider(`P${i}`)))
  services = Array.from({ length: 5 }, (_, i) => call<AiProviderInfo>('ai:saveProvider', service(`S${i}`)))
  expect(list()).toHaveLength(20)
})

describe('an edit into the other store at the cap', () => {
  it('a provider made a service takes its place: saved, and the provider gone', () => {
    const saved = call<AiProviderInfo>('ai:saveProvider', service('P0'), providers[0].id)
    expect(saved.service?.preset).toBe('groq')
    const ids = list().map((p) => p.id)
    expect(ids).toHaveLength(20)
    expect(ids).toContain(saved.id)
    expect(ids).not.toContain(providers[0].id)
  })

  it('a service made a provider takes its place: saved, and the service gone', () => {
    // A service of 20 still at the cap: a provider is counted with the services.
    const saved = call<AiProviderInfo>('ai:saveProvider', provider('S0'), services[0].id)
    expect(saved.service).toBeUndefined()
    const ids = list().map((p) => p.id)
    expect(ids).toHaveLength(20)
    expect(ids).toContain(saved.id)
    expect(ids).not.toContain(services[0].id)
  })

  it('a new provider counts the services: refused at 20, so no service is pushed out of the list', () => {
    expect(() => call('ai:saveProvider', provider('New'))).toThrow(FULL)
    expect(() => call('ai:saveProvider', provider('New'), providers[0].id)).toThrow(FULL)
    expect(() => call('ai:saveProvider', provider('New'), 'svc-not-there')).toThrow(FULL)
    expect(list().map((p) => p.id)).toEqual([...providers, ...services].map((p) => p.id))
    // A provider edited in place is not a new one: saved at the cap.
    call('ai:saveProvider', provider('P1 again', { id: providers[1].id, apiKey: undefined }))
    expect(list().find((p) => p.id === providers[1].id)?.label).toBe('P1 again')
    // With one service gone there is room again.
    call('ai:removeProvider', services[4].id)
    const added = call<AiProviderInfo>('ai:saveProvider', provider('New'))
    expect(list().map((p) => p.id)).toContain(added.id)
    expect(list()).toHaveLength(20)
  })

  it('without it, or naming one of the same store or none, the cap holds and nothing is removed', () => {
    expect(() => call('ai:saveProvider', service('New'))).toThrow(FULL)
    expect(() => call('ai:saveProvider', service('New'), services[0].id)).toThrow(FULL)
    expect(() => call('ai:saveProvider', service('New'), 'ai-not-there')).toThrow(FULL)
    expect(list()).toHaveLength(20)
    // An edit in place of the same store never removes the id it is sent with.
    call('ai:saveProvider', service('S1 again', { id: services[1].id, apiKey: undefined }), services[2].id)
    expect(list().map((p) => p.id)).toContain(services[2].id)
    expect(list().find((p) => p.id === services[1].id)?.label).toBe('S1 again')
  })
})
