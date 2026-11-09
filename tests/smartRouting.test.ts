/**
 * Smart tools in the main process (docs/design/smart-tools.md §20.0, §22.1 tests 7, 8 and 104): AI on
 * this PC is reached without a key lookup, a service through compatibleClient, the names task thinks
 * little, usage is summed only when reported, ai-providers.json is never written by listing, and the
 * test hooks are read only when the app is not packaged.
 */
import fs from 'node:fs'
import os from 'node:os'
import path from 'node:path'
import { describe, expect, it, vi } from 'vitest'

const h = vi.hoisted(() => ({
  packaged: false,
  userData: '',
  handlers: new Map<string, (...args: unknown[]) => unknown>(),
  local: [] as { requestId?: string }[],
  compatible: [] as string[],
  lookups: [] as unknown[],
  usage: null as null | { input: number; output: number }[]
}))

vi.mock('electron', () => ({
  app: { getPath: () => h.userData, get isPackaged() { return h.packaged }, on: () => undefined, getAppPath: () => '/nonexistent' },
  ipcMain: { handle: (channel: string, fn: (...args: unknown[]) => unknown) => h.handlers.set(channel, fn) },
  safeStorage: { isEncryptionAvailable: () => true, encryptString: (s: string) => Buffer.from(s), decryptString: (b: Buffer) => b.toString(), getSelectedStorageBackend: () => 'dpapi' }
}))
vi.mock('../src/main/ai/transcribe', () => ({ stopAllTranscriptions: () => undefined, stopTranscription: () => undefined, sweepTranscribeTemp: async () => undefined, transcribeProject: async () => undefined }))

/** A client answering every names prompt with a name per item, reporting `usage` when given. */
function namer(record: (p: { name: string }) => void) {
  return {
    test: async () => 'ok',
    json: async (prompt: { name: string; user: string }, opts: { onUsage?: (u: { input: number; output: number }) => void }) => {
      record(prompt)
      for (const u of h.usage ?? []) opts.onUsage?.(u)
      const items = (JSON.parse(prompt.user.slice(prompt.user.indexOf('\n') + 1)) as { items: { id: string }[] }).items
      return { names: items.map((i) => ({ id: i.id, name: `Name ${i.id}` })) }
    }
  }
}
vi.mock('../src/main/localAi/localTextClient', async () => {
  const { DEFAULT_TEXT_LIMITS } = await import('../src/shared/captions/transcriptText')
  return {
    localTextClient: async (ctx: { requestId?: string }) => {
      h.local.push({ requestId: ctx.requestId })
      return { ...namer(() => undefined), limits: () => DEFAULT_TEXT_LIMITS }
    }
  }
})
vi.mock('../src/main/ai/compatible', () => ({
  compatibleClient: (info: { id: string }) => {
    h.compatible.push(info.id)
    return namer(() => undefined)
  }
}))
vi.mock('../src/main/ai/serviceStore', () => ({
  ServiceStore: class {
    list() {
      return [{ id: 'svc1', kind: 'openai', label: 'Groq', model: 'm', maskedKey: '…', createdAt: '', service: { preset: 'groq', baseUrl: 'https://api.groq.com/openai/v1', host: 'api.groq.com', loopback: false, json: 'schema' } }]
    }
    get(id: unknown) {
      h.lookups.push(id)
      if (id !== 'svc1') throw new Error('This provider no longer exists.')
      return { info: this.list()[0], apiKey: 'gsk_secret' }
    }
    setJsonMode() {}
  }
}))

h.userData = fs.mkdtempSync(path.join(os.tmpdir(), 'w11-routing-'))
const { aiText, effortOf, listAiProviders, registerAiIpc, NOT_ON_THIS_PC_MESSAGE } = await import('../src/main/aiIpc')

const sender = { send: () => undefined, isDestroyed: () => false, once: () => undefined, removeListener: () => undefined } as never
const request = { task: 'names', segments: [], names: { kind: 'chapter', items: [{ id: 'c1', text: 'Now we set up billing' }] } }

describe('routing (test 8)', () => {
  registerAiIpc()

  it("aiText('local', …) reaches localTextClient without a key lookup", async () => {
    h.lookups.length = 0
    const result = await aiText('local', request, 'run-1', sender)
    expect(h.local).toEqual([{ requestId: 'run-1' }])
    expect(h.lookups).toEqual([])
    expect(result).toEqual({ task: 'names', names: [{ id: 'c1', name: 'Name c1' }] })
  })

  it("'chapters' and 'marks' never run on this PC", async () => {
    await expect(aiText('local', { task: 'chapters', segments: [{ id: 'a', start: 0, end: 1, text: 'hi' }] }, undefined, sender)).rejects.toThrow(NOT_ON_THIS_PC_MESSAGE)
    await expect(aiText('local', { task: 'marks', segments: [{ id: 'a', start: 0, end: 1, text: 'hi' }] }, undefined, sender)).rejects.toThrow(NOT_ON_THIS_PC_MESSAGE)
  })

  it("aiText('svc…', …) reaches compatibleClient through the service store", async () => {
    await aiText('svc1', request)
    expect(h.compatible).toEqual(['svc1'])
    expect(h.lookups).toEqual(['svc1'])
  })

  it('the names task thinks little; usage is summed into the result only when reported', async () => {
    expect(effortOf('names')).toBe('low')
    h.usage = null
    expect(await aiText('svc1', request)).not.toHaveProperty('usage')
    h.usage = [
      { input: 100, output: 20 },
      { input: 50, output: 5 }
    ]
    expect((await aiText('svc1', request)).usage).toEqual({ input: 150, output: 25 })
    h.usage = null
  })

  it('a prompt with pictures is refused by a client that cannot send them', async () => {
    const pic = new Uint8Array([0xff, 0xd8, 0xff, 0])
    await expect(aiText('svc1', { task: 'names', segments: [], names: { kind: 'step', items: [{ id: 'a', text: 'x', image: pic }] } })).rejects.toThrow(/does not read pictures/)
  })
})

describe('the key store is untouched (test 7)', () => {
  it('listing providers and services never writes ai-providers.json, and lists services after providers', () => {
    const file = path.join(h.userData, 'ai-providers.json')
    const before = fs.existsSync(file) ? fs.readFileSync(file) : null
    const list = listAiProviders()
    expect(list.map((p) => p.id)).toEqual(['svc1'])
    expect(fs.existsSync(file) ? fs.readFileSync(file) : null).toEqual(before)
    const listed = h.handlers.get('ai:listProviders')
    expect(listed).toBeDefined()
  })
})

describe('the test hooks (test 104)', () => {
  it('are read only when the app is not packaged', async () => {
    const { priceListUrl } = await import('../src/main/ai/priceList')
    const { llmHelperPath } = await import('../src/main/localAi/engine')
    const { testCatalog } = await import('../src/main/localAi/models')
    const { PRICE_LIST_URL } = await import('../src/shared/ai/prices')
    const helper = path.join(h.userData, 'fake-llm.cjs')
    const catalog = path.join(h.userData, 'catalog.json')
    fs.writeFileSync(helper, '')
    // A test catalogue entry is pinned like a real one (part P4's readTestCatalog): bytes and SHA-256.
    fs.writeFileSync(catalog, JSON.stringify([{ id: 'qwen3.5-2b', file: 'tiny.gguf', bytes: 1000, sha256: 'a'.repeat(64) }]))
    process.env.SSW_LLM_HELPER = helper
    process.env.SSW_TEXT_MODEL_TEST_CATALOG = catalog
    process.env.SSW_PRICE_LIST_URL = 'http://127.0.0.1:9/prices.json'
    try {
      h.packaged = false
      expect(llmHelperPath()).toBe(helper)
      expect(testCatalog()?.map((m) => ({ id: m.id, file: m.file }))).toEqual([{ id: 'qwen3.5-2b', file: 'tiny.gguf' }])
      expect(priceListUrl()).toBe('http://127.0.0.1:9/prices.json')
      h.packaged = true
      ;(process as { resourcesPath?: string }).resourcesPath = h.userData
      expect(llmHelperPath()).toBeNull()
      expect(testCatalog()).toBeNull()
      expect(priceListUrl()).toBe(PRICE_LIST_URL)
    } finally {
      h.packaged = false
      delete process.env.SSW_LLM_HELPER
      delete process.env.SSW_TEXT_MODEL_TEST_CATALOG
      delete process.env.SSW_PRICE_LIST_URL
    }
  })
})
