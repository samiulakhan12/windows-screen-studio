import { describe, expect, it } from 'vitest'
import { azureBaseUrl, azureResource, isLoopbackHost, readBaseUrl } from '../src/shared/ai/baseUrl'
import { presetApplies, presetAt, SERVICE_PRESETS, serviceName } from '../src/shared/ai/presets'

/*
 * A service's base URL (docs/design/smart-tools.md §10.2, §0 decision 6; §22 test 81) and the
 * presets' hosts (§10.5): https only, plain http only on this PC; no credentials, query or fragment;
 * at most 300 characters; the ASCII host is where the key and the text go.
 */

const ok = (raw: string): { baseUrl: string; origin: string; host: string; loopback: boolean } => {
  const r = readBaseUrl(raw)
  if (!r.ok) throw new Error(`refused ${raw}: ${r.message}`)
  return r
}
const refused = (raw: string): string => {
  const r = readBaseUrl(raw)
  if (r.ok) throw new Error(`took ${raw}`)
  return r.message
}

describe('readBaseUrl (test 81)', () => {
  it('normalises an https address: the path kept, the trailing slash removed', () => {
    expect(readBaseUrl('https://api.groq.com/openai/v1/')).toEqual({ ok: true, baseUrl: 'https://api.groq.com/openai/v1', origin: 'https://api.groq.com', host: 'api.groq.com', loopback: false })
    expect(ok('  https://openrouter.ai/api/v1  ').baseUrl).toBe('https://openrouter.ai/api/v1')
    expect(ok('HTTPS://API.Together.xyz/v1').baseUrl).toBe('https://api.together.xyz/v1')
    expect(ok('https://example.com:8443/v1').host).toBe('example.com:8443')
  })

  it('allows plain http only on this PC: localhost, 127.0.0.0/8 and [::1]', () => {
    expect(ok('http://localhost:11434/v1')).toMatchObject({ baseUrl: 'http://localhost:11434/v1', origin: 'http://localhost:11434', host: 'localhost:11434', loopback: true })
    expect(ok('http://127.0.0.5:1234/v1')).toMatchObject({ host: '127.0.0.5:1234', loopback: true })
    expect(ok('http://[::1]:8080')).toMatchObject({ baseUrl: 'http://[::1]:8080', host: '[::1]:8080', loopback: true })
    expect(ok('https://localhost:8443/v1').loopback).toBe(true)
    for (const raw of ['http://192.168.1.5:11434', 'http://example.com/v1', 'http://10.0.0.2/v1', 'http://localhost.example.com/v1', 'http://128.0.0.1/v1']) {
      expect(refused(raw), raw).toBe('Use an https:// address. Plain http:// is only for a service on this PC.')
    }
    expect(refused('ftp://example.com/v1')).toMatch(/https:\/\//)
    expect(refused('javascript:alert(1)')).toMatch(/https:\/\//)
  })

  it('refuses a name and password, a query and a fragment, even a bare ? or #', () => {
    expect(refused('https://user:pw@api.groq.com/openai/v1')).toBe('Remove the name and password from the address.')
    expect(refused('https://user@api.groq.com/openai/v1')).toBe('Remove the name and password from the address.')
    expect(refused('https://api.groq.com/openai/v1?key=1')).toBe('Remove the part after ?')
    expect(refused('https://api.groq.com/openai/v1?')).toBe('Remove the part after ?')
    expect(refused('https://api.groq.com/openai/v1#x')).toBe('Remove the part after #')
    expect(refused('https://api.groq.com/openai/v1#')).toBe('Remove the part after #')
  })

  it('takes 300 characters and refuses 301; refuses what is not an address', () => {
    const base = 'https://example.com/'
    expect(ok(base + 'a'.repeat(300 - base.length)).baseUrl).toHaveLength(300)
    expect(refused(base + 'a'.repeat(301 - base.length))).toMatch(/too long/)
    expect(refused('')).toMatch(/Enter the address/)
    expect(refused('api.groq.com')).toMatch(/not a web address/)
  })

  it('shows and stores an internationalised host in its ASCII (xn--) form', () => {
    const r = ok('https://bücher.example/v1')
    expect(r.host).toBe('xn--bcher-kva.example')
    expect(r.baseUrl).toBe('https://xn--bcher-kva.example/v1')
    expect(r.origin).toBe('https://xn--bcher-kva.example')
  })

  it("azureBaseUrl builds the resource's address and checks its name", () => {
    expect(azureBaseUrl('my-res')).toEqual({ ok: true, baseUrl: 'https://my-res.openai.azure.com/openai/v1', origin: 'https://my-res.openai.azure.com', host: 'my-res.openai.azure.com', loopback: false })
    for (const bad of ['', 'a', '-res', 'My-Res', 'res.evil.com', 'res/x', 'a'.repeat(64)]) expect(azureBaseUrl(bad).ok, bad).toBe(false)
    expect(azureResource('https://my-res.openai.azure.com/openai/v1')).toBe('my-res')
    expect(azureResource('https://my-res.openai.azure.com.evil.com/openai/v1')).toBeNull()
  })

  it('isLoopbackHost knows this PC only', () => {
    for (const h of ['localhost', 'LOCALHOST', '127.0.0.1', '127.255.255.254', '[::1]', '::1', 'localhost:11434', '[::1]:80']) expect(isLoopbackHost(h), h).toBe(true)
    for (const h of ['localhost.', 'mylocalhost', '127.0.0.256', '128.0.0.1', '0.0.0.0', '[::2]', '192.168.1.5', 'example.com']) expect(isLoopbackHost(h), h).toBe(false)
  })
})

describe("presets apply only at their own host (§10.5, test 134's parts)", () => {
  it("a preset's prices and no cost apply at its own host; Azure at any resource's; Other address never", () => {
    expect(presetApplies('groq', 'api.groq.com')).toBe(true)
    expect(presetApplies('groq', 'groq.example.com')).toBe(false)
    expect(presetApplies('ollama', 'localhost:11434')).toBe(true)
    expect(presetApplies('ollama', 'localhost:11435')).toBe(false)
    expect(presetApplies('ollama', '127.0.0.1:11434')).toBe(false)
    expect(presetApplies('lmstudio', 'localhost:1234')).toBe(true)
    expect(presetApplies('azure', 'my-res.openai.azure.com')).toBe(true)
    expect(presetApplies('azure', 'my-res.openai.azure.com.evil.com')).toBe(false)
    expect(presetApplies('other', 'api.groq.com')).toBe(false)
    expect(presetAt('api.groq.com')).toBe('groq')
    expect(presetAt('api.groq.example')).toBe('other')
    for (const p of Object.values(SERVICE_PRESETS)) if (p.baseUrl) expect(readBaseUrl(p.baseUrl)).toMatchObject({ ok: true, host: p.host })
  })

  it('a service is named by where its key and text go: its host, or its preset on this PC', () => {
    const svc = (preset: 'groq' | 'ollama' | 'other' | 'openrouter', host: string, loopback = false) => ({ label: 'My service', service: { preset, baseUrl: `x`, host, loopback, json: 'text' as const } })
    expect(serviceName(svc('groq', 'api.groq.com'))).toBe('api.groq.com')
    expect(serviceName(svc('openrouter', 'openrouter.ai'))).toBe('openrouter.ai')
    expect(serviceName(svc('ollama', 'localhost:11434', true))).toBe('Ollama on this PC')
    expect(serviceName(svc('ollama', 'localhost:9999', true))).toBe('localhost:9999')
    expect(serviceName(svc('other', 'proxy.example.com'))).toBe('proxy.example.com')
    expect(serviceName({ label: 'My OpenAI' })).toBe('My OpenAI')
  })
})
