import { beforeEach, describe, expect, it, vi } from 'vitest'
import type { AiProviderInfo } from '../src/shared/api/ai'
import { mockReact, settle, textOf, unmountAll, type El } from './studioHarness'

/*
 * The user's own prices (pref aiPrices, docs/design/smart-tools.md §11.4) when Settings is opened
 * before any cost line has read them this session (Home › Settings): the form reads them itself, so
 * a model change still drops the ones typed for the old model, and prices typed for one provider
 * keep every other provider's.
 */

const api = vi.hoisted(() => ({ saved: [] as Record<string, unknown>[], prefs: [] as [string, unknown][], values: {} as Record<string, unknown> }))
vi.stubGlobal('window', {
  api: {
    getAiModelList: async () => null,
    saveAiProvider: async (input: Record<string, unknown>) => {
      api.saved.push(input)
      const service = input.service as { preset: string; baseUrl: string }
      return { id: input.id as string, kind: 'openai', label: input.label, model: input.model, maskedKey: '…1234', createdAt: '', service: { ...service, host: new URL(service.baseUrl).host, loopback: false, json: 'text' } }
    },
    removeAiProvider: async () => undefined,
    listAiProviders: async () => [],
    testAiProvider: async () => ({ ok: true, message: 'Works.' }),
    setPref: async (k: string, v: unknown) => void api.prefs.push([k, v]),
    getPref: async (k: string) => api.values[k] ?? null,
    getAiPriceList: async () => null,
    getAiUsage: async () => null,
    localAiState: async () => null,
    listModels: async () => []
  },
  addEventListener: () => undefined,
  removeEventListener: () => undefined,
  setTimeout
})
mockReact()
const FORM = '../src/renderer/src/settings/ProviderForm'
let ProviderForm: (p: unknown) => unknown

const service = (id: string, model: string, host: string): AiProviderInfo =>
  ({ id, kind: 'openai', label: id, model, maskedKey: '…6789', createdAt: '', service: { preset: 'other', baseUrl: `https://${host}/v1`, host, loopback: false, json: 'schema' } }) as AiProviderInfo
const form = (editing: AiProviderInfo): unknown => ({ type: ProviderForm, props: { editing, existing: [], onCancel: () => undefined, onSaved: () => undefined } })
const prices = (els: El[]): El[] => els.filter((e) => e.type === 'input' && e.props.type === 'number')
const type = (el: El, value: string): void => (el.props.onChange as (e: unknown) => void)({ target: { value } })
async function openPrices(root: unknown): Promise<El[]> {
  const els = await settle(root)
  ;(els.find((e) => e.type === 'button' && textOf(e) === 'Prices (US$ per million tokens)')!.props.onClick as () => void)()
  return settle(root)
}
async function submit(root: unknown): Promise<void> {
  const els = await settle(root)
  ;(els.find((e) => e.type === 'form')!.props.onSubmit as (e: unknown) => void)({ preventDefault: () => undefined })
  for (let i = 0; i < 6; i++) await new Promise((r) => setTimeout(r, 0))
}

beforeEach(async () => {
  unmountAll()
  api.saved.length = 0
  api.prefs.length = 0
  api.values = { aiPrices: { svc1: { input: 0.1, output: 0.5 }, svc2: { input: 1, output: 2 } } }
  // A fresh session: no cost line has read the cost data yet.
  vi.resetModules()
  ;({ ProviderForm } = (await import(/* @vite-ignore */ FORM)) as { ProviderForm: (p: unknown) => unknown })
})

describe("the provider form reads the user's own prices itself (Settings opened from Home)", () => {
  it('shows them for the model they were typed for, and drops them when the model changes', async () => {
    const editing = service('svc1', 'small-8b', 'llm.example.com')
    let els = await openPrices(form(editing))
    expect(prices(els).map((n) => n.props.value)).toEqual(['0.1', '0.5'])
    type(els.find((e) => e.type === 'input' && String(e.props.id).endsWith('-model'))!, 'large-405b')
    els = await settle(form(editing))
    expect(prices(els).map((n) => n.props.value)).toEqual(['', ''])
    await submit(form(editing))
    expect(api.saved[0]).toMatchObject({ id: 'svc1', model: 'large-405b' })
    expect(api.prefs).toEqual([['aiPrices', { svc2: { input: 1, output: 2 } }]])
  })

  it("prices typed for one provider keep every other provider's", async () => {
    const editing = service('svc2', 'mid-70b', 'llm2.example.com')
    let els = await openPrices(form(editing))
    type(prices(els)[0], '2')
    els = await settle(form(editing))
    type(prices(els)[1], '3')
    await submit(form(editing))
    expect(api.prefs).toEqual([['aiPrices', { svc1: { input: 0.1, output: 0.5 }, svc2: { input: 2, output: 3 } }]])
  })
})
