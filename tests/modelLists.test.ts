import fs from 'node:fs'
import http from 'node:http'
import os from 'node:os'
import path from 'node:path'
import type { AddressInfo } from 'node:net'
import { afterAll, afterEach, beforeAll, describe, expect, it, vi } from 'vitest'
import { AiProviderStore, type SecretBox } from '../src/main/ai/keyStore'
import { filterModels } from '../src/shared/ai/modelFilter'
import type { ListedModel } from '../src/shared/api/ai'

/*
 * Model lists (docs/design/smart-tools.md §10.4, §22 tests 88 and 132) from mock servers for each kind:
 * OpenAI's list without speech, picture, embedding and moderation models (transcription models for
 * the transcription field), Gemini's generateContent models without "models/", Claude's ids,
 * OpenRouter's prices read from strings; at most 2,000 ids; a body over 4 MB refused; a 20 s limit.
 * A draft with an edited address and no key never gets the stored key and sends nothing.
 */

const h = vi.hoisted(() => ({ userData: '' }))
vi.mock('electron', () => ({ app: { isPackaged: false, getPath: () => h.userData }, net: { fetch: () => Promise.reject(new Error('no net')) } }))

const { listModels } = await import('../src/main/ai/modelLists')
const { ServiceStore, SERVICE_MESSAGES } = await import('../src/main/ai/serviceStore')
const { compatibleClient } = await import('../src/main/ai/compatible')

const box: SecretBox = { isEncryptionAvailable: () => true, encryptString: (s) => Buffer.from(`e${s}`), decryptString: (b) => b.toString().slice(1) }

/** What the mock answers on each route; `seen` the requests it got. */
const mock = {
  seen: [] as { url: string; auth: string }[],
  routes: new Map<string, () => { status?: number; body: string }>()
}
const srv = http.createServer((req, res) => {
  const auth = String(req.headers.authorization ?? req.headers['x-api-key'] ?? req.headers['x-goog-api-key'] ?? '')
  mock.seen.push({ url: req.url ?? '', auth })
  const route = [...mock.routes.entries()].find(([p]) => (req.url ?? '').startsWith(p))
  if (!route) {
    res.writeHead(404)
    return res.end('{}')
  }
  const r = route[1]()
  res.writeHead(r.status ?? 200, { 'content-type': 'application/json' })
  res.end(r.body)
})
let origin = ''
let stores: { providers: AiProviderStore; services: InstanceType<typeof ServiceStore> }
const deps = { providers: () => stores.providers, services: () => stores.services }

beforeAll(async () => {
  h.userData = fs.mkdtempSync(path.join(os.tmpdir(), 'models-'))
  await new Promise<void>((r) => srv.listen(0, '127.0.0.1', r))
  origin = `http://127.0.0.1:${(srv.address() as AddressInfo).port}`
  vi.stubEnv('SSW_AI_BASE_URL_OPENAI', `${origin}/v1`)
  vi.stubEnv('SSW_AI_BASE_URL_GEMINI', origin)
  vi.stubEnv('SSW_AI_BASE_URL_ANTHROPIC', origin)
  stores = { providers: new AiProviderStore(path.join(h.userData, 'ai-providers.json'), box), services: new ServiceStore(path.join(h.userData, 'ai-services.json'), box) }
})
afterAll(async () => {
  vi.unstubAllEnvs()
  await new Promise((r) => srv.close(r))
  fs.rmSync(h.userData, { recursive: true, force: true })
})
afterEach(() => {
  mock.seen = []
  mock.routes.clear()
  vi.restoreAllMocks()
})

const ids = (list: ListedModel[]): string[] => list.map((m) => m.id)
const draft = (kind: 'openai' | 'gemini' | 'anthropic', apiKey = `${kind}-draft-key-0123456789`) => ({ draft: { kind, label: kind, apiKey } })

describe('model lists from each kind (test 88)', () => {
  it("OpenAI: no speech, picture, embedding or moderation models; transcription models for that field", async () => {
    mock.routes.set('/v1/models', () => ({
      body: JSON.stringify({ object: 'list', data: ['gpt-6.1-sol', 'tts-1', 'gpt-4o-mini-tts', 'dall-e-3', 'gpt-image-1', 'text-embedding-3-small', 'omni-moderation-latest', 'whisper-1', 'gpt-transcribe', 'bad id', 'x'.repeat(101)].map((id) => ({ id })) })
    }))
    const list = await listModels(draft('openai'), deps)
    expect(ids(list)).toEqual(['gpt-6.1-sol', 'whisper-1', 'gpt-transcribe'])
    expect(filterModels('openai', ids(list), 'text')).toEqual(['gpt-6.1-sol'])
    expect(filterModels('openai', ids(list), 'transcription')).toEqual(['whisper-1', 'gpt-transcribe'])
    expect(mock.seen[0]).toEqual({ url: '/v1/models', auth: 'Bearer openai-draft-key-0123456789' })
  })

  it("Gemini: the models that write text (generateContent), without models/, page by page", async () => {
    let page = 0
    mock.routes.set('/v1beta/models', () => {
      page++
      return page === 1
        ? { body: JSON.stringify({ models: [{ name: 'models/gemini-3.8-flash', supportedGenerationMethods: ['generateContent', 'countTokens'] }, { name: 'models/text-embedding-004', supportedGenerationMethods: ['embedContent'] }], nextPageToken: 'p2' }) }
        : { body: JSON.stringify({ models: [{ name: 'models/gemini-3.8-pro', supportedGenerationMethods: ['generateContent'] }] }) }
    })
    expect(ids(await listModels(draft('gemini'), deps))).toEqual(['gemini-3.8-flash', 'gemini-3.8-pro'])
    expect(mock.seen.map((s) => s.url)).toEqual(['/v1beta/models?pageSize=1000', '/v1beta/models?pageSize=1000&pageToken=p2'])
    expect(mock.seen[0].auth).toBe('gemini-draft-key-0123456789')
  })

  it("Claude: its ids", async () => {
    mock.routes.set('/v1/models', () => ({ body: JSON.stringify({ data: [{ id: 'claude-opus-5-5', type: 'model' }, { id: 'claude-haiku-5', type: 'model' }], has_more: false }) }))
    expect(ids(await listModels(draft('anthropic'), deps))).toEqual(['claude-opus-5-5', 'claude-haiku-5'])
    expect(filterModels('anthropic', ['claude-opus-5-5'], 'transcription')).toEqual([])
  })

  it("OpenRouter: prices from its strings, 'varies' for router models, and whether a model takes a strict schema", async () => {
    const body = {
      data: [
        { id: 'openai/gpt-6.1-sol', pricing: { prompt: '0.000002', completion: '0.00001' }, supported_parameters: ['structured_outputs', 'tools'] },
        { id: 'openrouter/auto', pricing: { prompt: '-1', completion: '-1' } },
        { id: 'meta/llama-free', pricing: { prompt: '0', completion: '0' } },
        { id: 'odd/model' }
      ]
    }
    const base = (async () => new Response(JSON.stringify(body), { status: 200 })) as unknown as typeof fetch
    const info = { id: 'svc1', kind: 'openai' as const, label: 'OpenRouter', model: 'openrouter/auto', maskedKey: '', createdAt: '', service: { preset: 'openrouter' as const, baseUrl: 'https://openrouter.ai/api/v1', host: 'openrouter.ai', loopback: false, json: 'text' as const } }
    const list = await compatibleClient(info, 'sk-or-0123456789', { setJsonMode: () => undefined }, base).models!(AbortSignal.timeout(5000))
    expect(list).toEqual([
      { id: 'openai/gpt-6.1-sol', prices: { input: 2, output: 10 }, schema: true },
      { id: 'openrouter/auto', prices: 'varies' },
      { id: 'meta/llama-free', prices: { input: 0, output: 0 } },
      { id: 'odd/model', prices: 'varies' }
    ])
  })

  it('2,001 ids are cut to 2,000; a body of 4 MB + 1 is refused', async () => {
    mock.routes.set('/v1/models', () => ({ body: JSON.stringify({ data: Array.from({ length: 2001 }, (_, i) => ({ id: `model-${i}` })) }) }))
    expect(await listModels(draft('openai'), deps)).toHaveLength(2000)
    const big = JSON.stringify({ data: [{ id: 'gpt-6.1-sol' }], pad: '' })
    mock.routes.set('/v1/models', () => ({ body: big.replace('"pad":""', `"pad":"${'x'.repeat(4 * 1024 * 1024 + 1 - big.length)}"`) }))
    await expect(listModels(draft('openai'), deps)).rejects.toThrow(/too large/)
  })

  it('gives up after 20 s', async () => {
    const timeout = vi.spyOn(AbortSignal, 'timeout')
    mock.routes.set('/v1/models', () => ({ body: '{"data":[]}' }))
    await listModels(draft('openai'), deps)
    expect(timeout.mock.calls.map((c) => c[0])).toContain(20_000)
    // A signal that has run out: the list fails as a time-out.
    timeout.mockImplementation(() => {
      const c = new AbortController()
      c.abort(new DOMException('timed out', 'TimeoutError'))
      return c.signal
    })
    await expect(listModels(draft('openai'), deps)).rejects.toThrow(/took too long/)
  })

  it('refuses a malformed target and a provider that no longer exists', async () => {
    await expect(listModels(null, deps)).rejects.toThrow(/Invalid provider/)
    await expect(listModels({ providerId: 'ai404' }, deps)).rejects.toThrow(/no longer exists/)
    expect(mock.seen).toHaveLength(0)
  })
})

describe('which key a draft uses (test 132)', () => {
  it('an edited address without a key is refused and nothing is sent; the same origin uses the stored key; its own key wins', async () => {
    const stored = stores.services.save({ kind: 'openai', label: 'Groq', model: 'openai/gpt-oss-20b', apiKey: 'gsk_stored_0123456789', service: { preset: 'groq', baseUrl: 'https://api.groq.com/openai/v1' } })
    const sent: { url: string; auth: string | null }[] = []
    vi.stubGlobal('fetch', async (url: string, init?: RequestInit) => {
      sent.push({ url, auth: new Headers(init?.headers).get('authorization') })
      return new Response(JSON.stringify({ data: [{ id: 'llama-4-scout' }] }), { status: 200 })
    })
    try {
      const edited = { draft: { id: stored.id, kind: 'openai', label: 'Groq', model: 'm', service: { preset: 'groq', baseUrl: 'https://groq.attacker.example/openai/v1' } } }
      await expect(listModels(edited, deps)).rejects.toThrow(SERVICE_MESSAGES.newAddress)
      expect(sent).toHaveLength(0)
      const same = { draft: { ...edited.draft, service: { preset: 'groq', baseUrl: 'https://api.groq.com/openai/v1' } } }
      expect(ids(await listModels(same, deps))).toEqual(['llama-4-scout'])
      expect(sent).toEqual([{ url: 'https://api.groq.com/openai/v1/models', auth: 'Bearer gsk_stored_0123456789' }])
      const own = { draft: { ...edited.draft, apiKey: 'own-key-0123456789' } }
      await listModels(own, deps)
      expect(sent[1]).toEqual({ url: 'https://groq.attacker.example/openai/v1/models', auth: 'Bearer own-key-0123456789' })
      // A built-in provider's draft borrows the stored key only for the same kind.
      const openai = stores.providers.save({ kind: 'openai', label: 'OpenAI', apiKey: 'sk-stored-openai-0123456789' })
      mock.routes.set('/v1/models', () => ({ body: '{"data":[{"id":"gpt-6.1-sol"}]}' }))
      vi.unstubAllGlobals()
      await expect(listModels({ draft: { id: openai.id, kind: 'gemini', label: 'x' } }, deps)).rejects.toThrow(SERVICE_MESSAGES.newAddress)
      expect(mock.seen).toHaveLength(0)
      expect(ids(await listModels({ draft: { id: openai.id, kind: 'openai', label: 'x' } }, deps))).toEqual(['gpt-6.1-sol'])
      expect(mock.seen[0].auth).toBe('Bearer sk-stored-openai-0123456789')
    } finally {
      vi.unstubAllGlobals()
    }
  })
})
