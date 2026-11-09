import { beforeEach, describe, expect, it, vi } from 'vitest'
import type { AiProviderInfo } from '../src/shared/api/ai'
import { mockReact, settle, textOf, unmountAll, type El } from './studioHarness'

/*
 * Add a provider › More services (docs/design/smart-tools.md §2.6, §22 test 95): the kind and its hint;
 * the presets fill the address; Azure asks for its resource name; a wrong address says why; the prices
 * disclosure, filled from the price list or saying it has none; OpenRouter's checkbox; the line naming
 * where the key and the text go; Save and check saves, then checks, and hands the row "Works." or
 * "Works; Flown checks its answers more closely." with how the service answers in JSON.
 */

const api = vi.hoisted(() => ({ saved: [] as Record<string, unknown>[], tested: [] as string[], check: { ok: true, message: 'Works.\nAnswers in JSON with a schema.' }, prefs: [] as [string, unknown][] }))
vi.stubGlobal('window', {
  api: {
    getAiModelList: async () => null,
    saveAiProvider: async (input: Record<string, unknown>) => {
      api.saved.push(input)
      const service = input.service as { preset: string; baseUrl: string } | undefined
      return { id: (input.id as string) ?? 'svcnew', kind: 'openai', label: input.label, model: input.model, maskedKey: '…1234', createdAt: '', ...(service ? { service: { ...service, host: new URL(service.baseUrl).host, loopback: false, json: 'text' } } : {}) }
    },
    testAiProvider: async (id: string) => {
      api.tested.push(id)
      return api.check
    },
    setPref: async (k: string, v: unknown) => void api.prefs.push([k, v]),
    getPref: async () => null,
    getAiPriceList: async () => null,
    localAiState: async () => null,
    listModels: async () => []
  },
  addEventListener: () => undefined,
  removeEventListener: () => undefined,
  setTimeout
})
mockReact()
const FORM = '../src/renderer/src/settings/ProviderForm'
const { ProviderForm, MORE_SERVICES_HINT } = (await import(/* @vite-ignore */ FORM)) as { ProviderForm: (p: unknown) => unknown; MORE_SERVICES_HINT: string }

let done: { saved: AiProviderInfo; check?: { ok: boolean; message: string } }[] = []
const form = (editing: AiProviderInfo | null = null): unknown => ({ type: ProviderForm, props: { editing, existing: [], onCancel: () => undefined, onSaved: (saved: AiProviderInfo, check?: { ok: boolean; message: string }) => done.push({ saved, check }) } })
const radio = (els: El[], label: string): El => els.find((e) => e.props.role === 'radio' && textOf(e) === label)!
const inputBy = (els: El[], test: (p: Record<string, unknown>) => boolean): El | undefined => els.find((e) => (e.type === 'input' || e.type === 'select') && test(e.props))
const type = (el: El, value: string): void => (el.props.onChange as (e: unknown) => void)({ target: { value, checked: value === 'on' } })
const text = (els: El[]): string => els.map((e) => (typeof e.type === 'string' && /^(p|span|h4|strong|label|button|option)$/.test(e.type) ? textOf(e) : '')).join(' | ')
const goesTo = (els: El[]): string => textOf(els.find((e) => e.props['data-testid'] === 'ai-goes-to')!)
async function submit(root: unknown): Promise<El[]> {
  const els = await settle(root)
  ;(els.find((e) => e.type === 'form')!.props.onSubmit as (e: unknown) => void)({ preventDefault: () => undefined })
  for (let i = 0; i < 4; i++) await new Promise((r) => setTimeout(r, 0))
  return settle(root)
}

beforeEach(() => {
  unmountAll()
  done = []
  api.saved.length = 0
  api.tested.length = 0
  api.prefs.length = 0
  api.check = { ok: true, message: 'Works.\nAnswers in JSON with a schema.' }
})

describe('Add a provider › More services (test 95)', () => {
  it('offers More services with its hint; the presets fill the address and name where the text goes', async () => {
    let els = await settle(form())
    expect(els.filter((e) => e.props.role === 'radio').map((e) => textOf(e))).toEqual(['OpenAI', 'Google Gemini', 'Anthropic Claude', 'More services'])
    expect(goesTo(els)).toBe('Your key and the text you send go to api.openai.com.')
    ;(radio(els, 'More services').props.onClick as () => void)()
    els = await settle(form())
    expect(text(els)).toContain(MORE_SERVICES_HINT)
    expect(MORE_SERVICES_HINT).toBe('OpenRouter, Groq, Together AI, Azure OpenAI, Ollama, LM Studio or any OpenAI-compatible address')
    const preset = inputBy(els, (p) => p['data-testid'] === 'service-preset')!
    expect(els.filter((e) => e.type === 'option').map((o) => textOf(o))).toEqual(['OpenRouter', 'Groq', 'Together AI', 'Azure OpenAI', 'Ollama on this PC', 'LM Studio on this PC', 'Other address'])
    expect(inputBy(els, (p) => p.id === ':r1:-url')?.props.value ?? inputBy(els, (p) => String(p.id).endsWith('-url'))!.props.value).toBe('https://openrouter.ai/api/v1')
    type(preset, 'groq')
    els = await settle(form())
    expect(inputBy(els, (p) => String(p.id).endsWith('-url'))!.props.value).toBe('https://api.groq.com/openai/v1')
    expect(goesTo(els)).toBe('Your key and the text you send go to api.groq.com.')
    type(preset, 'ollama')
    els = await settle(form())
    expect(goesTo(els)).toBe('Your key and the text you send go to localhost:11434.')
    expect(text(els)).toContain('No key needed for Ollama and LM Studio on this PC.')
  })

  it('a wrong address says why under the field; Azure asks for its resource name and builds the address', async () => {
    let els = await settle(form())
    ;(radio(els, 'More services').props.onClick as () => void)()
    els = await settle(form())
    type(inputBy(els, (p) => p['data-testid'] === 'service-preset')!, 'other')
    els = await settle(form())
    type(inputBy(els, (p) => String(p.id).endsWith('-url'))!, 'http://192.168.1.5:11434/v1')
    els = await settle(form())
    const url = inputBy(els, (p) => String(p.id).endsWith('-url'))!
    expect(url.props['aria-invalid']).toBe(true)
    expect(textOf(els.find((e) => e.props.id === url.props['aria-describedby'])!)).toBe('Use an https:// address. Plain http:// is only for a service on this PC.')
    type(inputBy(els, (p) => p['data-testid'] === 'service-preset')!, 'azure')
    els = await settle(form())
    expect(text(els)).toContain('Your resource name')
    type(inputBy(els, (p) => String(p.id).endsWith('-resource'))!, 'my-res')
    els = await settle(form())
    expect(text(els)).toContain('https://my-res.openai.azure.com/openai/v1')
    expect(goesTo(els)).toBe('Your key and the text you send go to my-res.openai.azure.com.')
    expect(text(els)).toContain('Model (the deployment’s name)')
  })

  it('the prices disclosure: filled from the price list, or saying it has none; OpenRouter keeps no prompts by default', async () => {
    let els = await settle(form())
    ;(radio(els, 'More services').props.onClick as () => void)()
    els = await settle(form())
    expect(inputBy(els, (p) => p.type === 'checkbox')!.props.checked).toBe(true)
    expect(text(els)).toContain('Only use hosts that do not keep my prompts')
    type(inputBy(els, (p) => p['data-testid'] === 'service-preset')!, 'groq')
    els = await settle(form())
    expect(inputBy(els, (p) => p.type === 'checkbox')).toBeUndefined()
    const disclosure = els.find((e) => e.type === 'button' && textOf(e) === 'Prices (US$ per million tokens)')!
    expect(disclosure.props['aria-expanded']).toBe(false)
    ;(disclosure.props.onClick as () => void)()
    els = await settle(form())
    type(inputBy(els, (p) => String(p.id).endsWith('-model'))!, 'openai/gpt-oss-20b')
    els = await settle(form())
    const numbers = els.filter((e) => e.type === 'input' && e.props.type === 'number')
    expect(numbers.map((n) => n.props.value)).toEqual(['0.075', '0.3'])
    type(inputBy(els, (p) => String(p.id).endsWith('-model'))!, 'llama-4-scout')
    els = await settle(form())
    expect(els.filter((e) => e.type === 'input' && e.props.type === 'number').map((n) => n.props.value)).toEqual(['', ''])
    expect(text(els)).toContain("Not in Flown's price list: add them to see costs.")
  })

  it('Save and check saves the service, checks it, and hands the row what the check said', async () => {
    let els = await settle(form())
    ;(radio(els, 'More services').props.onClick as () => void)()
    els = await settle(form())
    type(inputBy(els, (p) => p['data-testid'] === 'service-preset')!, 'groq')
    els = await settle(form())
    expect(els.find((e) => e.type === 'button' && e.props.type === 'submit')!.props.children).toBe('Save and check')
    type(inputBy(els, (p) => String(p.id).endsWith('-key'))!, 'gsk_test_0123456789')
    type(inputBy(els, (p) => String(p.id).endsWith('-model'))!, 'llama-4-scout')
    await submit(form())
    expect(api.saved).toEqual([{ kind: 'openai', label: 'Groq', apiKey: 'gsk_test_0123456789', model: 'llama-4-scout', service: { preset: 'groq', baseUrl: 'https://api.groq.com/openai/v1' } }])
    expect(api.tested).toEqual(['svcnew'])
    expect(done[0].check).toEqual({ ok: true, message: 'Works.\nAnswers in JSON with a schema.' })
    // A service that answers in plain JSON: the row says Flown checks its answers more closely.
    unmountAll()
    done = []
    api.check = { ok: true, message: 'Works; Flown checks its answers more closely.\nAnswers in plain JSON.' }
    els = await settle(form())
    ;(radio(els, 'More services').props.onClick as () => void)()
    els = await settle(form())
    type(inputBy(els, (p) => p['data-testid'] === 'service-preset')!, 'ollama')
    els = await settle(form())
    type(inputBy(els, (p) => String(p.id).endsWith('-model'))!, 'llama3.2:3b')
    await submit(form())
    expect(api.saved.at(-1)).not.toHaveProperty('apiKey')
    expect(done[0].check?.message).toBe('Works; Flown checks its answers more closely.\nAnswers in plain JSON.')
  })

  it('editing a service at a new address needs its key again', async () => {
    const editing = { id: 'svc1', kind: 'openai', label: 'Groq', model: 'llama-4-scout', maskedKey: '…6789', createdAt: '', service: { preset: 'groq', baseUrl: 'https://api.groq.com/openai/v1', host: 'api.groq.com', loopback: false, json: 'schema' } } as AiProviderInfo
    let els = await settle(form(editing))
    expect(text(els)).toContain('Leave empty to keep the current key (…6789).')
    type(inputBy(els, (p) => String(p.id).endsWith('-url'))!, 'https://groq.example.com/openai/v1')
    els = await settle(form(editing))
    expect(text(els)).toContain('Enter the API key for the new address.')
    els = await submit(form(editing))
    expect(api.saved).toHaveLength(0)
    expect(textOf(els.find((e) => e.props.role === 'alert')!)).toBe('Enter the API key for the new address.')
  })
})
