import { beforeEach, describe, expect, it, vi } from 'vitest'
import type { ListedModel } from '../src/shared/api/ai'
import { key, mockReact, render, settle, textOf, unmountAll, type El } from './studioHarness'

/*
 * The model field as a list from the provider (docs/design/smart-tools.md §2.6, §22 test 96): the ARIA
 * 1.2 combobox pattern (Down opens and moves, Enter picks, Esc closes the list only, any text kept),
 * "Loaded 47 models" after Load models, typing filters, and "price varies" for a router model.
 */

const api = vi.hoisted(() => ({ list: [] as ListedModel[], targets: [] as unknown[], fail: null as string | null }))
vi.stubGlobal('window', {
  api: {
    listModels: async (t: unknown) => {
      api.targets.push(t)
      if (api.fail) throw new Error(`Error invoking remote method 'ai:listModels': Error: ${api.fail}`)
      return api.list
    }
  },
  addEventListener: () => undefined,
  removeEventListener: () => undefined
})
mockReact()
const PATH = '../src/renderer/src/ai/ModelCombobox'
const { ModelCombobox } = (await import(/* @vite-ignore */ PATH)) as { ModelCombobox: (p: unknown) => unknown }

const OR: ListedModel[] = [
  { id: 'openai/gpt-6.1-sol', prices: { input: 2, output: 10 }, schema: true },
  { id: 'openrouter/auto', prices: 'varies' },
  { id: 'meta/llama-4-scout', prices: { input: 0.1, output: 0.3 } },
  ...Array.from({ length: 44 }, (_, i) => ({ id: `vendor/model-${i}` }))
]

let value = ''
const changes: string[] = []
const root = (field: 'text' | 'transcription' = 'text', kind: 'openai' | 'gemini' = 'openai'): unknown => ({
  type: ModelCombobox,
  props: {
    id: 'm',
    label: 'Model',
    value,
    field,
    target: { draft: { kind, label: 'x', apiKey: 'sk-0123456789' } },
    onChange: (v: string) => {
      value = v
      changes.push(v)
    }
  }
})
const inputOf = (els: El[]): El => els.find((e) => e.type === 'input' && e.props.role === 'combobox')!
const options = (els: El[]): El[] => els.filter((e) => e.props.role === 'option')
const press = (els: El[], k: string) => {
  const e = key(k)
  ;(inputOf(els).props.onKeyDown as (e: unknown) => void)(e)
  return e
}

beforeEach(() => {
  unmountAll()
  value = 'openai/gpt-6.1-sol'
  changes.length = 0
  api.list = OR
  api.targets.length = 0
  api.fail = null
})

describe('the model combobox (test 96)', () => {
  it('is an ARIA 1.2 combobox: a text field with a list it controls', async () => {
    const els = await settle(root())
    const input = inputOf(els)
    expect(input.props).toMatchObject({ role: 'combobox', 'aria-autocomplete': 'list', 'aria-expanded': false, 'aria-controls': 'm-list' })
    const list = els.find((e) => e.props.role === 'listbox')!
    expect(list.props.id).toBe('m-list')
    expect(els.find((e) => e.type === 'label')!.props.htmlFor).toBe('m')
  })

  it('Load models fills the list and says how many came; router models say "price varies"', async () => {
    let els = await settle(root())
    ;(els.find((e) => e.type === 'button' && textOf(e) === 'Load models')!.props.onClick as () => void)()
    els = await settle(root())
    expect(api.targets).toEqual([{ draft: { kind: 'openai', label: 'x', apiKey: 'sk-0123456789' } }])
    expect(textOf(els.find((e) => e.props.id === 'm-status')!)).toBe('Loaded 47 models')
    expect(inputOf(els).props['aria-expanded']).toBe(true)
    const opts = options(els)
    expect(opts).toHaveLength(47)
    expect(textOf(opts[0])).toBe('openai/gpt-6.1-solUS$2.00 / US$10.00 per million tokens')
    expect(textOf(opts[1])).toBe('openrouter/autoprice varies')
    expect(opts[0].props['aria-selected']).toBe(true)
  })

  it('Down opens and moves, Up moves back, Enter picks; Esc closes the list only; free text is kept', async () => {
    let els = await settle(root())
    ;(els.find((e) => e.type === 'button' && textOf(e) === 'Load models')!.props.onClick as () => void)()
    els = await settle(root())
    // Esc closes the list and does not reach the form.
    const esc = press(els, 'Escape')
    expect(esc.prevented).toBe(true)
    els = render(root())
    expect(inputOf(els).props['aria-expanded']).toBe(false)
    // Down opens it on the current value, Down again moves on.
    expect(press(els, 'ArrowDown').prevented).toBe(true)
    els = render(root())
    expect(inputOf(els).props['aria-expanded']).toBe(true)
    expect(inputOf(els).props['aria-activedescendant']).toMatch(/-opt-0$/)
    press(els, 'ArrowDown')
    els = render(root())
    press(els, 'ArrowDown')
    els = render(root())
    press(els, 'ArrowUp')
    els = render(root())
    expect(inputOf(els).props['aria-activedescendant']).toMatch(/-opt-1$/)
    const enter = press(els, 'Enter')
    expect(enter.prevented).toBe(true)
    expect(value).toBe('openrouter/auto')
    els = render(root())
    expect(inputOf(els).props['aria-expanded']).toBe(false)
    // Enter with no option highlighted is left to the form.
    expect(press(els, 'Enter').prevented).toBe(false)
    // Typing filters the list, and any text stays.
    ;(inputOf(els).props.onChange as (e: unknown) => void)({ target: { value: 'llama' } })
    els = render(root())
    expect(options(els).map((o) => textOf(o).split('US$')[0])).toEqual(['meta/llama-4-scout'])
    ;(inputOf(els).props.onChange as (e: unknown) => void)({ target: { value: 'my-own-deployment' } })
    els = render(root())
    expect(value).toBe('my-own-deployment')
    expect(options(els)).toHaveLength(0)
    expect(inputOf(els).props['aria-expanded']).toBe(false)
  })

  it('keeps the field’s models only, and says why a list could not be loaded', async () => {
    api.list = [{ id: 'gpt-6.1-sol' }, { id: 'whisper-1' }, { id: 'gpt-transcribe' }]
    let els = await settle(root('transcription'))
    ;(els.find((e) => e.type === 'button' && textOf(e) === 'Load models')!.props.onClick as () => void)()
    els = await settle(root('transcription'))
    expect(options(els).map((o) => textOf(o))).toEqual(['whisper-1', 'gpt-transcribe'])
    expect(textOf(els.find((e) => e.props.id === 'm-status')!)).toBe('Loaded 2 models')
    unmountAll()
    api.fail = 'Enter the API key for the new address.'
    els = await settle(root())
    ;(els.find((e) => e.type === 'button' && textOf(e) === 'Load models')!.props.onClick as () => void)()
    els = await settle(root())
    const status = els.find((e) => e.props.id === 'm-status')!
    expect(textOf(status)).toBe('Enter the API key for the new address.')
    expect(status.props.className).toContain('error')
  })
})
