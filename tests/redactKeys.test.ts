import fs from 'node:fs'
import http from 'node:http'
import os from 'node:os'
import path from 'node:path'
import type { AddressInfo } from 'node:net'
import { afterAll, beforeAll, describe, expect, it, vi } from 'vitest'
import { redactLine } from '../src/shared/diagnostics/redact'

/*
 * Keys never reach a log or the renderer (docs/design/smart-tools.md §16.5, §10.3; §22 tests 87 and
 * 135): redactLine takes out each key main has read or saved, as it is and longest first, even one
 * shorter than the generic 32-character rule, and the name and password of any address; its callers
 * keep their arguments. A service, or any built-in provider through callWithRetry, that echoes the key
 * in a 400 body gives a message holding <secret> and not the key.
 */

const h = vi.hoisted(() => ({ userData: '' }))
vi.mock('electron', () => ({ app: { isPackaged: false, getPath: () => h.userData }, net: { fetch: () => Promise.reject(new Error('no net')) } }))

const { clearSecrets, registerSecret, scrubSecrets, secretValues } = await import('../src/main/ai/secrets')
const { AppLog } = await import('../src/main/appLog')
const { collectDiagnostics, diagnosticsText } = await import('../src/main/diagnostics')

describe('redactLine with secrets (test 87)', () => {
  it('takes out a stored 20-character key, the longer of two overlapping keys first', () => {
    const key = 'gsk_Ab3dEf6hIj9kLm2n'
    expect(key).toHaveLength(20)
    // The generic rules alone miss a key this short.
    expect(redactLine(`sent with ${key} to api.groq.com`)).toContain(key)
    expect(redactLine(`sent with ${key} to api.groq.com`, {}, [], [key])).toBe('sent with <secret> to api.groq.com')
    const short = 'abcdefgh12345678'
    const long = `${short}XYZ`
    expect(redactLine(`k=${long}; j=${short}`, {}, [], [short, long])).toBe('k=<secret>; j=<secret>')
    expect(redactLine('a key/with/slashes=1234 here', {}, [], ['key/with/slashes=1234'])).toBe('a <secret> here')
  })

  it("loses the name and password of an address", () => {
    expect(redactLine('GET https://user:pw@host.example/x failed')).toBe('GET https://<secret>@host.example/x failed')
    expect(redactLine('proxy http://admin:hunter2@10.0.0.1:8080 down')).toBe('proxy http://<secret>@10.0.0.1:8080 down')
    expect(redactLine('see https://example.com/a?b=c@d')).not.toContain('<secret>@example.com')
  })

  it("the existing callers' arguments still work, and their rules still apply", () => {
    expect(redactLine('C:\\Users\\Sam\\notes.txt', {})).toBe('<path>')
    expect(redactLine('key sk-proj-abcdefghijklmnopqrstuv', {})).toBe('key <secret>')
    expect(redactLine('saved in /home/sam/flown', { userData: '/home/sam/flown' }, ['sam'])).toBe('saved in <userData>')
    expect(redactLine('mail me: sam@example.com', {}, [])).toBe('mail me: <email>')
  })

  it("the log and the diagnostics report take out the keys main registered", async () => {
    clearSecrets()
    const key = 'or-key_0123456789abc'
    registerSecret(key)
    registerSecret('short')
    expect(secretValues()).toEqual([key])
    h.userData = fs.mkdtempSync(path.join(os.tmpdir(), 'redact-'))
    const log = new AppLog(h.userData, {}, { maxBytes: 1 << 20, flushMs: 10, lineMax: 2000 })
    log.write('warn', [`request failed: invalid key ${key}`])
    await log.flush()
    const text = fs.readFileSync(log.file, 'utf8')
    expect(text).toContain('<secret>')
    expect(text).not.toContain(key)
    expect((await log.recent(5)).join('\n')).not.toContain(key)
    const report = diagnosticsText(
      await collectDiagnostics({
        app: () => ({ name: 'Flown', version: '0.8.0', electron: '44', chrome: '140', node: '22', packaged: true }),
        system: async () => ({ os: 'Windows', build: '10', arch: 'x64', cpu: 'CPU', cores: 4, memoryGB: 8 }),
        displays: async () => [],
        gpu: async () => ({ devices: [], features: {} }),
        encoders: async () => [],
        probe: async () => ({ supported: true, windowCapture: true, cursorToggle: true, borderToggle: false, hardwareEncoders: [], reason: null }),
        lastCapture: async () => null,
        recordings: async () => 0,
        jobs: () => [],
        log: async () => [`2026-11-09T12:00:00.000Z WARN gateway said: bad key ${key}`],
        roots: {}
      }),
      {}
    )
    expect(report).toContain('gateway said: bad key <secret>')
    expect(report).not.toContain(key)
    fs.rmSync(h.userData, { recursive: true, force: true })
  })

  it('scrubSecrets does the same for a message', () => {
    clearSecrets()
    registerSecret('sk-echo-0123456789')
    expect(scrubSecrets('Unauthorized: sk-echo-0123456789 and https://a:b@c.example')).toBe('Unauthorized: <secret> and https://<secret>@c.example')
  })
})

/* ---------- test 135: a key echoed in a 400 body ---------- */

const echo: { seen: number } = { seen: 0 }
const srv = http.createServer((req, res) => {
  let body = ''
  req.on('data', (c) => (body += c))
  req.on('end', () => {
    echo.seen++
    const key = String(req.headers.authorization ?? '').replace(/^Bearer /, '') || String(req.headers['x-api-key'] ?? '') || String(req.headers['x-goog-api-key'] ?? '')
    const message = `Malformed request from client holding ${key} please retry`
    res.writeHead(400, { 'content-type': 'application/json' })
    if (/generateContent/.test(req.url ?? '')) return res.end(JSON.stringify({ error: { code: 400, message, status: 'INVALID_ARGUMENT' } }))
    if (/\/v1\/messages/.test(req.url ?? '')) return res.end(JSON.stringify({ type: 'error', error: { type: 'invalid_request_error', message } }))
    res.end(JSON.stringify({ error: { message, type: 'invalid_request_error', code: null } }))
  })
})
let origin = ''
beforeAll(async () => {
  await new Promise<void>((r) => srv.listen(0, '127.0.0.1', r))
  origin = `http://127.0.0.1:${(srv.address() as AddressInfo).port}`
  vi.stubEnv('SSW_AI_BASE_URL_OPENAI', `${origin}/v1`)
  vi.stubEnv('SSW_AI_BASE_URL_GEMINI', origin)
  vi.stubEnv('SSW_AI_BASE_URL_ANTHROPIC', origin)
})
afterAll(async () => {
  vi.unstubAllEnvs()
  await new Promise((r) => srv.close(r))
})

const PROMPT = { name: 'title', system: 's', user: 'u', schema: { type: 'object', properties: { title: { type: 'string' } }, required: ['title'], additionalProperties: false } }
const OPTS = { signal: AbortSignal.timeout(20_000), effort: 'low' as const }
const message = async (p: Promise<unknown>): Promise<string> => p.then(() => 'resolved', (e: unknown) => (e instanceof Error ? e.message : String(e)))

describe('error scrubbing (test 135)', () => {
  it('a service echoing the key gives <secret>, never the key', async () => {
    const { compatibleClient } = await import('../src/main/ai/compatible')
    const key = 'svc-echo-key-0123456789'
    const info = { id: 'svc1', kind: 'openai' as const, label: 'Echo', model: 'm', maskedKey: '', createdAt: '', service: { preset: 'other' as const, baseUrl: `${origin}/v1`, host: new URL(origin).host, loopback: true, json: 'text' as const } }
    const m = await message(compatibleClient(info, key, { setJsonMode: () => undefined }).json(PROMPT, OPTS))
    expect(m).toContain('<secret>')
    expect(m).not.toContain(key)
  })

  it('each built-in provider, through callWithRetry, gives <secret> too', async () => {
    const { openAiClient } = await import('../src/main/ai/openai')
    const { geminiClient } = await import('../src/main/ai/gemini')
    const { anthropicClient } = await import('../src/main/ai/anthropic')
    const cases: [string, string, () => Promise<unknown>][] = [
      ['OpenAI', 'sk-echo-openai-0123456789', () => openAiClient('sk-echo-openai-0123456789', 'gpt-6.1-sol', 'whisper-1').json(PROMPT, OPTS)],
      ['Gemini', 'AIzaEchoGemini0123456789', () => geminiClient('AIzaEchoGemini0123456789', 'gemini-3.8-flash', 'gemini-3.8-flash').json(PROMPT, OPTS)],
      ['Claude', 'claude-echo-key-0123456789', () => anthropicClient('claude-echo-key-0123456789', 'claude-opus-5-5').json(PROMPT, OPTS)]
    ]
    for (const [name, key, run] of cases) {
      const m = await message(run())
      expect(m, name).toContain('<secret>')
      expect(m, name).not.toContain(key)
    }
  })
})
