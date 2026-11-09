import fs from 'node:fs'
import http from 'node:http'
import https from 'node:https'
import os from 'node:os'
import path from 'node:path'
import type { AddressInfo } from 'node:net'
import { Agent, fetch as undiciFetch } from 'undici'
import { afterAll, beforeAll, beforeEach, describe, expect, it, vi } from 'vitest'
import type { AiProviderInfo, ServiceInfo } from '../src/shared/api/ai'
import { AiOutputError, runTextTask } from '../src/shared/captions/transcriptText'

/*
 * A service through Chat Completions (docs/design/smart-tools.md §10.3, §22 tests 84 and 98) against
 * a local HTTPS server: a strict JSON schema first; a 400 drops to JSON mode, then to plain text
 * read from its first `{`; the level found is saved; validators still reject a wrong shape;
 * OpenRouter's data_collection 'deny' is sent with keepNoData; the tokens reported reach onUsage.
 * Save and check sends only the fixed probe, never project text.
 */

const h = vi.hoisted(() => ({ userData: '' }))
vi.mock('electron', () => ({ app: { isPackaged: false, getPath: () => h.userData }, net: { fetch: () => Promise.reject(new Error('no net')) } }))

const { compatibleClient, firstObject } = await import('../src/main/ai/compatible')

const CERT = fs.readFileSync(path.join(__dirname, 'fixtures', 'tls', 'localhost-test-cert.pem'))
const KEY = fs.readFileSync(path.join(__dirname, 'fixtures', 'tls', 'localhost-test-key.pem'))
const agent = new Agent({ connect: { ca: CERT } })
/** Node's fetch, trusting the test certificate (as a real service's certificate is trusted). */
const trusted = ((input: string | URL | Request, init?: RequestInit) => undiciFetch(input as string, { ...(init as object), dispatcher: agent } as never)) as unknown as typeof fetch

type Body = Record<string, unknown> & { response_format?: { type: string; json_schema?: { name: string; strict: boolean } }; messages: { role: string; content: string }[] }
const server = {
  bodies: [] as Body[],
  headers: [] as http.IncomingHttpHeaders[],
  /** What the server does with a chat request. */
  reply: (_b: Body): { status: number; json: unknown } => ({ status: 200, json: chat('{"ok": true}') })
}
const chat = (content: string, usage?: { prompt_tokens: number; completion_tokens: number }): unknown => ({
  id: 'c1',
  object: 'chat.completion',
  created: 1,
  model: 'm',
  choices: [{ index: 0, finish_reason: 'stop', message: { role: 'assistant', content } }],
  ...(usage ? { usage: { ...usage, total_tokens: usage.prompt_tokens + usage.completion_tokens } } : {})
})

let srv: https.Server
let base = ''
beforeAll(async () => {
  h.userData = fs.mkdtempSync(path.join(os.tmpdir(), 'compat-'))
  srv = https.createServer({ cert: CERT, key: KEY }, (req, res) => {
    let data = ''
    req.on('data', (c) => (data += c))
    req.on('end', () => {
      if (req.url === '/v1/chat/completions' && req.method === 'POST') {
        const body = JSON.parse(data) as Body
        server.bodies.push(body)
        server.headers.push(req.headers)
        const r = server.reply(body)
        res.writeHead(r.status, { 'content-type': 'application/json' })
        res.end(JSON.stringify(r.json))
        return
      }
      res.writeHead(404)
      res.end('{}')
    })
  })
  await new Promise<void>((r) => srv.listen(0, '127.0.0.1', r))
  base = `https://localhost:${(srv.address() as AddressInfo).port}/v1`
})
afterAll(async () => {
  await new Promise((r) => srv.close(r))
  await agent.close()
  fs.rmSync(h.userData, { recursive: true, force: true })
})
beforeEach(() => {
  server.bodies = []
  server.headers = []
})

const service = (json: ServiceInfo['json'] = 'schema', extra: Partial<ServiceInfo> = {}): AiProviderInfo => ({
  id: 'svc1',
  kind: 'openai',
  label: 'Local',
  model: 'test-model',
  maskedKey: '…1234',
  createdAt: '',
  service: { preset: 'other', baseUrl: base, host: new URL(base).host, loopback: true, json, ...extra }
})
const TITLE = { name: 'title', system: 'Write a title.', user: 'Captions: hello', schema: { type: 'object', properties: { title: { type: 'string' } }, required: ['title'], additionalProperties: false } }
const opts = (onUsage?: (u: { input: number; output: number }) => void) => ({ signal: AbortSignal.timeout(10_000), effort: 'low' as const, ...(onUsage ? { onUsage } : {}) })
const refuse = (type: string) => (b: Body): { status: number; json: unknown } =>
  b.response_format?.type === type ? { status: 400, json: { error: { message: `response_format type ${type} is not supported by this model`, type: 'invalid_request_error' } } } : { status: 200, json: chat('{"title":"Fine"}') }

describe('a service through Chat Completions (test 84)', () => {
  it('asks for a strict JSON schema first and reads the answer', async () => {
    server.reply = () => ({ status: 200, json: chat('{"title":"Export a report"}') })
    const client = compatibleClient(service('schema'), 'sk-local-0123456789', { setJsonMode: () => undefined }, trusted)
    expect(await client.json(TITLE, opts())).toEqual({ title: 'Export a report' })
    const b = server.bodies[0]
    expect(b.model).toBe('test-model')
    expect(b.response_format).toEqual({ type: 'json_schema', json_schema: { name: 'title', schema: TITLE.schema, strict: true } })
    expect(b.messages).toEqual([
      { role: 'system', content: 'Write a title.' },
      { role: 'user', content: 'Captions: hello' }
    ])
    expect(server.headers[0].authorization).toBe('Bearer sk-local-0123456789')
    expect(b).not.toHaveProperty('provider')
  })

  it('Save and check: a 400 drops to JSON mode, then to plain text read from its first {; the level is saved', async () => {
    server.reply = (b) =>
      b.response_format ? { status: 400, json: { error: { message: `'response_format' of type '${b.response_format.type}' is not supported` } } } : { status: 200, json: chat('Sure! {"ok": true} Anything else?') }
    const saved: string[] = []
    const client = compatibleClient(service('text'), 'sk-local-0123456789', { setJsonMode: (_id, j) => saved.push(j) }, trusted)
    expect(await client.test(AbortSignal.timeout(10_000))).toBe('Works; Flown checks its answers more closely.\nAnswers in plain text.')
    expect(server.bodies.map((b) => b.response_format?.type ?? 'none')).toEqual(['json_schema', 'json_object', 'none'])
    expect(saved).toEqual(['text'])
    // Without a strict schema, the schema is described in the system text.
    expect(server.bodies[2].messages[0].content).toContain('"ok":{"type":"boolean"}')
    server.reply = () => ({ status: 200, json: chat('Here it is: {"title": "Export {fast}"} done') })
    expect(await client.json(TITLE, opts())).toEqual({ title: 'Export {fast}' })
    expect(server.bodies.at(-1)!.response_format).toBeUndefined()
  })

  it('Save and check says "Works." for a strict schema and "Works; …" for JSON mode', async () => {
    server.reply = () => ({ status: 200, json: chat('{"ok":true}') })
    const saved: string[] = []
    expect(await compatibleClient(service('text'), null, { setJsonMode: (_id, j) => saved.push(j) }, trusted).test(AbortSignal.timeout(10_000))).toBe('Works.\nAnswers in JSON with a schema.')
    server.reply = refuse('json_schema')
    server.reply = (b) => (b.response_format?.type === 'json_schema' ? { status: 422, json: { error: { message: 'unsupported' } } } : { status: 200, json: chat('{"ok":true}') })
    expect(await compatibleClient(service('text'), null, { setJsonMode: (_id, j) => saved.push(j) }, trusted).test(AbortSignal.timeout(10_000))).toBe('Works; Flown checks its answers more closely.\nAnswers in plain JSON.')
    expect(saved).toEqual(['schema', 'object'])
  })

  it('a real request refused for its response format drops one level, tries once more and keeps the level', async () => {
    server.reply = refuse('json_schema')
    const saved: string[] = []
    const client = compatibleClient(service('schema'), 'sk-local-0123456789', { setJsonMode: (_id, j) => saved.push(j) }, trusted)
    expect(await client.json(TITLE, opts())).toEqual({ title: 'Fine' })
    expect(server.bodies.map((b) => b.response_format?.type)).toEqual(['json_schema', 'json_object'])
    expect(saved).toEqual(['object'])
    // The next request starts at the level kept.
    await client.json(TITLE, opts())
    expect(server.bodies.at(-1)!.response_format?.type).toBe('json_object')
  })

  it("every answer still passes the task's validator", async () => {
    server.reply = () => ({ status: 200, json: chat('{"heading":"Not a title"}') })
    const client = compatibleClient(service('schema'), null, { setJsonMode: () => undefined }, trusted)
    await expect(runTextTask({ task: 'title', segments: [{ id: 'a', start: 0, end: 1, text: 'Hello there.' }] }, (p) => client.json(p, opts()))).rejects.toBeInstanceOf(AiOutputError)
  })

  it("OpenRouter's keepNoData sends provider.data_collection 'deny'", async () => {
    server.reply = () => ({ status: 200, json: chat('{"title":"T"}') })
    await compatibleClient(service('schema', { keepNoData: true }), 'sk-or-0123456789', { setJsonMode: () => undefined }, trusted).json(TITLE, opts())
    expect(server.bodies[0].provider).toEqual({ data_collection: 'deny' })
  })

  it('reports the tokens the service counted', async () => {
    server.reply = () => ({ status: 200, json: chat('{"title":"T"}', { prompt_tokens: 120, completion_tokens: 30 }) })
    const seen: unknown[] = []
    await compatibleClient(service('schema'), null, { setJsonMode: () => undefined }, trusted).json(TITLE, opts((u) => seen.push(u)))
    expect(seen).toEqual([{ input: 120, output: 30 }])
  })

  it('a service on this PC without a key sends no Authorization header', async () => {
    server.reply = () => ({ status: 200, json: chat('{"title":"T"}') })
    await compatibleClient(service('schema'), null, { setJsonMode: () => undefined }, trusted).json(TITLE, opts())
    expect(server.headers[0].authorization).toBeUndefined()
  })

  it('firstObject reads the first balanced object, braces in strings ignored', () => {
    expect(firstObject('x {"a":{"b":"}"}} y {"c":1}')).toBe('{"a":{"b":"}"}}')
    expect(firstObject('no json')).toBeNull()
    expect(firstObject('{"open": ')).toBeNull()
  })
})

describe('Save and check sends only the fixed probe (test 98)', () => {
  it('the check never carries project text, through testAiProvider too', async () => {
    server.reply = () => ({ status: 200, json: chat('{"ok":true}') })
    await compatibleClient(service('text'), 'sk-local-0123456789', { setJsonMode: () => undefined }, trusted).test(AbortSignal.timeout(10_000))
    expect(server.bodies).toHaveLength(1)
    const sent = JSON.stringify(server.bodies[0].messages)
    expect(server.bodies[0].messages.map((m) => m.content)).toEqual(['Answer with this JSON object and nothing else: {"ok": true}', 'Check.'])
    expect(sent).not.toMatch(/caption|transcript|segment/i)
  })
})
