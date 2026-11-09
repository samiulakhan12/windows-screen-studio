import fs from 'node:fs'
import http from 'node:http'
import os from 'node:os'
import path from 'node:path'
import type { AddressInfo } from 'node:net'
import { afterAll, beforeAll, describe, expect, it, vi } from 'vitest'
import type { AiProviderInfo } from '../src/shared/api/ai'

/*
 * No redirects (docs/design/smart-tools.md §16.3, §22 test 85): a service that answers with a 302 to
 * another origin fails ("unexpected redirect") and the other origin receives nothing, for text
 * requests and model lists alike; a request whose URL's origin is not the stored one is refused before
 * anything is sent. And Save and check through testAiProvider sends only the fixed probe (test 98).
 */

const h = vi.hoisted(() => ({ userData: '', handlers: new Map<string, (...args: unknown[]) => unknown>() }))
vi.mock('electron', () => ({
  app: { isPackaged: false, getPath: () => h.userData, on: () => undefined },
  ipcMain: { handle: (channel: string, fn: (...args: unknown[]) => unknown) => h.handlers.set(channel, fn) },
  safeStorage: { isEncryptionAvailable: () => true, encryptString: (s: string) => Buffer.from(`x${s}`), decryptString: (b: Buffer) => b.toString().slice(1), getSelectedStorageBackend: () => 'dpapi' },
  net: { fetch: () => Promise.reject(new Error('no net')) }
}))
vi.mock('../src/main/ai/transcribe', () => ({ stopAllTranscriptions: () => undefined, stopTranscription: () => undefined, sweepTranscribeTemp: async () => undefined, transcribeProject: async () => undefined }))

const { compatibleClient, noRedirectFetch, OTHER_ORIGIN_MESSAGE } = await import('../src/main/ai/compatible')

interface Seen {
  method: string
  url: string
  body: string
}
function serve(handler: (req: http.IncomingMessage, res: http.ServerResponse, seen: Seen[]) => void): { seen: Seen[]; origin: () => string; start(): Promise<void>; stop(): Promise<void> } {
  const seen: Seen[] = []
  const srv = http.createServer((req, res) => {
    let body = ''
    req.on('data', (c) => (body += c))
    req.on('end', () => {
      seen.push({ method: req.method ?? '', url: req.url ?? '', body })
      handler(req, res, seen)
    })
  })
  return {
    seen,
    origin: () => `http://127.0.0.1:${(srv.address() as AddressInfo).port}`,
    start: () => new Promise((r) => srv.listen(0, '127.0.0.1', () => r())),
    stop: () => new Promise((r) => srv.close(() => r()))
  }
}

const other = serve((_req, res) => {
  res.writeHead(200, { 'content-type': 'application/json' })
  res.end(JSON.stringify({ choices: [{ message: { content: '{"title":"stolen"}' }, finish_reason: 'stop' }], data: [{ id: 'stolen' }] }))
})
const redirecting = serve((req, res) => {
  res.writeHead(302, { location: `${other.origin()}${req.url}` })
  res.end()
})
const probeServer = serve((_req, res) => {
  res.writeHead(200, { 'content-type': 'application/json' })
  res.end(JSON.stringify({ id: 'c', object: 'chat.completion', created: 1, model: 'm', choices: [{ index: 0, message: { role: 'assistant', content: '{"ok":true}' }, finish_reason: 'stop' }] }))
})

beforeAll(async () => {
  h.userData = fs.mkdtempSync(path.join(os.tmpdir(), 'redirects-'))
  await Promise.all([other.start(), redirecting.start(), probeServer.start()])
})
afterAll(async () => {
  await Promise.all([other.stop(), redirecting.stop(), probeServer.stop()])
  fs.rmSync(h.userData, { recursive: true, force: true })
})

const info = (origin: string): AiProviderInfo => ({
  id: 'svc1',
  kind: 'openai',
  label: 'Local',
  model: 'm',
  maskedKey: '',
  createdAt: '',
  service: { preset: 'other', baseUrl: `${origin}/v1`, host: new URL(origin).host, loopback: true, json: 'schema' }
})
const PROMPT = { name: 'title', system: 's', user: 'u', schema: { type: 'object', properties: { title: { type: 'string' } }, required: ['title'], additionalProperties: false } }

describe('no redirects (test 85)', () => {
  it('a 302 to another origin fails as an unexpected redirect and the other origin receives nothing', async () => {
    const client = compatibleClient(info(redirecting.origin()), 'sk-redirect-0123456789', { setJsonMode: () => undefined })
    await expect(client.json(PROMPT, { signal: AbortSignal.timeout(10_000), effort: 'low' })).rejects.toThrow(/unexpected redirect/)
    await expect(client.models!(AbortSignal.timeout(10_000))).rejects.toThrow(/unexpected redirect/)
    // Refused at once, not tried again: one request each.
    expect(redirecting.seen.map((s) => s.method)).toEqual(['POST', 'GET'])
    expect(other.seen).toHaveLength(0)
  })

  it('a request whose origin is not the stored one is refused before sending', async () => {
    const send = noRedirectFetch(redirecting.origin())
    await expect(send(`${other.origin()}/v1/models`)).rejects.toThrow(OTHER_ORIGIN_MESSAGE)
    await expect(send(`${redirecting.origin().replace('http:', 'https:')}/v1/models`)).rejects.toThrow(OTHER_ORIGIN_MESSAGE)
    expect(other.seen).toHaveLength(0)
    // The stored origin itself goes through, with redirect: 'error'.
    const seen: RequestInit[] = []
    const spy = noRedirectFetch('https://api.groq.com', (async (_u: unknown, init?: RequestInit) => {
      seen.push(init ?? {})
      return new Response('{}')
    }) as typeof fetch)
    await spy('https://api.groq.com/openai/v1/models', { method: 'GET' })
    expect(seen[0].redirect).toBe('error')
  })
})

describe('testAiProvider sends only the fixed probe (test 98)', () => {
  it('through the IPC handler, with a saved service', async () => {
    const { ServiceStore } = await import('../src/main/ai/serviceStore')
    const box = { isEncryptionAvailable: () => true, encryptString: (s: string) => Buffer.from(`x${s}`), decryptString: (b: Buffer) => b.toString().slice(1) }
    const saved = new ServiceStore(path.join(h.userData, 'ai-services.json'), box).save({ kind: 'openai', label: 'Local', model: 'm', apiKey: 'sk-local-0123456789', service: { preset: 'other', baseUrl: `${probeServer.origin()}/v1` } })
    const { registerAiIpc } = await import('../src/main/aiIpc')
    registerAiIpc()
    // The app's page as the dev server serves it.
    vi.stubEnv('ELECTRON_RENDERER_URL', 'http://localhost:5173')
    const result = (await h.handlers.get('ai:testProvider')!({ senderFrame: { url: 'http://localhost:5173/#/' } }, saved.id)) as { ok: boolean; message: string }
    expect(result).toEqual({ ok: true, message: 'Works.\nAnswers in JSON with a schema.' })
    expect(probeServer.seen).toHaveLength(1)
    const body = JSON.parse(probeServer.seen[0].body) as { messages: { content: string }[] }
    expect(body.messages.map((m) => m.content)).toEqual(['Answer with this JSON object and nothing else: {"ok": true}', 'Check.'])
    vi.unstubAllEnvs()
  })
})
