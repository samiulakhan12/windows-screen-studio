import { beforeEach, describe, expect, it, vi } from 'vitest'
import type { CostEstimate } from '../src/shared/ai/cost'
import type { AiTextRequest, TextChoice } from '../src/shared/api/ai'
import { sanitizeSmartPref } from '../src/shared/smart/smartPrefs'
import { byTestId, focused, mockReact, render, settle, textOf, unmountAll, type El } from './studioHarness'

/*
 * The question before a run (docs/design/smart-tools.md §11.5, §22 tests 92 and 136): it asks above
 * the amount of pref aiConfirm (US$1.40 asks at US$1, not at US$5; US$0.05 asks at Always ask;
 * nothing asks at Never), an unknown cost once per model in a session, a run on this PC over 10
 * minutes; Cancel has the focus. Settings shows and saves the five choices; anything else reads as US$1.
 */

const prefs = vi.hoisted(() => ({ values: new Map<string, unknown>(), set: [] as [string, unknown][], usage: {} as Record<string, unknown> }))
vi.stubGlobal('window', {
  api: {
    getPref: async (k: string) => prefs.values.get(k) ?? null,
    setPref: async (k: string, v: unknown) => void prefs.set.push([k, v]),
    getAiPriceList: async () => null,
    getAiUsage: async () => prefs.usage,
    localAiState: async () => null,
    listAiProviders: async () => [],
    getAiModelList: async () => null
  },
  addEventListener: () => undefined,
  removeEventListener: () => undefined,
  dispatchEvent: () => true
})
vi.stubGlobal('document', { activeElement: null, body: {}, addEventListener: () => undefined, removeEventListener: () => undefined })
vi.stubGlobal('HTMLElement', class {})
mockReact()

const COST_CONFIRM = '../src/renderer/src/ai/costConfirm'
const DIALOG = '../src/renderer/src/ai/CostConfirm'
const SECTION = '../src/renderer/src/settings/AiProvidersSection'
const { confirmCost, confirmRequest, resetAskedCosts } = (await import(/* @vite-ignore */ COST_CONFIRM)) as {
  confirmCost: (e: CostEstimate, c: TextChoice, ask?: (q: { text: string; action: string }) => Promise<boolean>) => Promise<boolean>
  confirmRequest: (c: TextChoice, r: AiTextRequest, ask?: (q: { text: string; action: string }) => Promise<boolean>) => Promise<boolean>
  resetAskedCosts: () => void
}
const { CostConfirm } = (await import(/* @vite-ignore */ DIALOG)) as { CostConfirm: (p: unknown) => unknown }

const CLAUDE: TextChoice = { id: 'ai2', label: 'Claude', kind: 'anthropic', model: 'claude-opus-5-5', place: 'Claude', pictures: true }
const OR: TextChoice = { id: 'svc1', label: 'OpenRouter', kind: 'openai', model: 'openrouter/auto', host: 'openrouter.ai', place: 'openrouter.ai', pictures: true }
const est = (low: number, high: number): CostEstimate => ({ requests: 1, words: 100, pictures: 0, inputTokens: [1, 2], outputTokens: [1, 2], usd: [low, high], price: { entry: { input: 4, output: 20 }, updated: '2026-11-07' } })
const UNKNOWN: CostEstimate = { ...est(0, 0), usd: null, unknown: 'varies' }

/** What the questions asked were; the answer given to each. */
let asked: string[] = []
let reply = true
const ask = async (q: { text: string; action: string }): Promise<boolean> => {
  asked.push(`${q.text} [${q.action}]`)
  return reply
}

beforeEach(() => {
  prefs.values.clear()
  prefs.set.length = 0
  asked = []
  reply = true
  resetAskedCosts()
  unmountAll()
})

describe('when a run asks first (test 92)', () => {
  it('a US$1.40 run asks at US$1 (the default) but not at US$5', async () => {
    expect(await confirmCost(est(0.8, 1.4), CLAUDE, ask)).toBe(true)
    expect(asked).toEqual(['This costs up to about US$1.40 with claude-opus-5-5. Run it? [Run]'])
    prefs.values.set('aiConfirm', '5')
    asked = []
    expect(await confirmCost(est(0.8, 1.4), CLAUDE, ask)).toBe(true)
    expect(asked).toEqual([])
  })

  it('Always ask asks for US$0.05; Never asks for nothing; Cancel is a no', async () => {
    prefs.values.set('aiConfirm', 'always')
    reply = false
    expect(await confirmCost(est(0.03, 0.05), CLAUDE, ask)).toBe(false)
    expect(asked).toHaveLength(1)
    prefs.values.set('aiConfirm', 'never')
    asked = []
    expect(await confirmCost(est(10, 50), CLAUDE, ask)).toBe(true)
    expect(await confirmCost(UNKNOWN, OR, ask)).toBe(true)
    expect(asked).toEqual([])
  })

  it('an unknown cost asks once per model in a session (after Run)', async () => {
    reply = false
    await confirmCost(UNKNOWN, OR, ask)
    reply = true
    await confirmCost(UNKNOWN, OR, ask)
    await confirmCost(UNKNOWN, OR, ask)
    expect(asked).toEqual(['Flown does not know what this costs with openrouter/auto. Run it? [Run]', 'Flown does not know what this costs with openrouter/auto. Run it? [Run]'])
    await confirmCost(UNKNOWN, { ...OR, model: 'other/model' }, ask)
    expect(asked).toHaveLength(3)
  })

  it("a run no cost line's button starts (Make my captions great, Translate again) is asked about from its request", async () => {
    const segments = Array.from({ length: 400 }, (_, i) => ({ id: `c${i}`, start: i * 3, end: i * 3 + 3, text: 'Open the quarterly billing report and export it for the whole team today.' }))
    const request: AiTextRequest = { task: 'translate', segments, targetLanguage: 'Bengali' }
    prefs.values.set('aiConfirm', 'always')
    reply = false
    expect(await confirmRequest(CLAUDE, request, ask)).toBe(false)
    expect(asked).toHaveLength(1)
    expect(asked[0]).toMatch(/^This costs up to about US\$\d+\.\d\d with claude-opus-5-5\. Run it\? \[Run\]$/)
    // The amount set in Settings: above it nothing is asked.
    prefs.values.set('aiConfirm', '5')
    asked = []
    expect(await confirmRequest(CLAUDE, request, ask)).toBe(true)
    expect(asked).toEqual([])
    // A model Flown has no price for asks once.
    prefs.values.set('aiConfirm', '1')
    reply = true
    expect(await confirmRequest(OR, request, ask)).toBe(true)
    expect(asked).toEqual(['Flown does not know what this costs with openrouter/auto. Run it? [Run]'])
  })

  it('how far earlier estimates were off (ai:usage) counts: a run that reports twice the tokens estimated asks next time', async () => {
    const SOL: TextChoice = { id: 'ai1', label: 'OpenAI', kind: 'openai', model: 'gpt-6.1-sol', place: 'OpenAI', pictures: true }
    const segments = Array.from({ length: 100 }, (_, i) => ({ id: `s${i}`, start: i * 3, end: i * 3 + 2.5, text: `Now click the Export button and choose the report number ${i}.` }))
    const request: AiTextRequest = { task: 'cleanup', segments }
    prefs.values.set('aiConfirm', '0.1')
    // About US$0.06 at most as estimated: nothing asked.
    expect(await confirmRequest(SOL, request, ask)).toBe(true)
    expect(asked).toEqual([])
    // Ratios that are not ones are left out.
    prefs.usage = { 'openai|gpt-6.1-sol|cleaned_captions': { input: 40, output: 40 }, 'openai|gpt-6.1-sol|Click Export': { input: 2, output: 2 } }
    expect(await confirmRequest(SOL, request, ask)).toBe(true)
    expect(asked).toEqual([])
    // Main kept a ratio of 2 after earlier runs: read again before the question, it doubles the estimate.
    prefs.usage = { 'openai|gpt-6.1-sol|cleaned_captions': { input: 2, output: 2 } }
    expect(await confirmRequest(SOL, request, ask)).toBe(true)
    expect(asked).toHaveLength(1)
    expect(asked[0]).toMatch(/^This costs up to about US\$0\.1\d with gpt-6\.1-sol\. Run it\? \[Run\]$/)
    prefs.usage = {}
  })

  it('on this PC, a run over 10 minutes asks to start', async () => {
    const local: TextChoice = { id: 'local', label: 'On this PC', kind: 'local', model: '', place: 'this PC' }
    await confirmCost({ ...est(0, 0), seconds: [700, 25 * 60] }, local, ask)
    await confirmCost({ ...est(0, 0), seconds: [100, 500] }, local, ask)
    expect(asked).toEqual(['This takes about 25 minutes on this PC. You can keep editing meanwhile. Start? [Start]'])
  })

  it('the dialog: an alert dialog naming the cost, Cancel focused; Run and Cancel answer', () => {
    const answers: boolean[] = []
    const els = render({ type: CostConfirm, props: { text: 'This costs up to about US$1.40 with claude-opus-5-5. Run it?', action: 'Run', onDone: (r: boolean) => answers.push(r) } }) as El[]
    const dialog = els.find((e) => e.props.role === 'alertdialog')!
    expect(dialog.props['aria-modal']).toBe('true')
    const described = els.find((e) => e.props.id === dialog.props['aria-describedby'])!
    expect(textOf(described)).toBe('This costs up to about US$1.40 with claude-opus-5-5. Run it?')
    const buttons = els.filter((e) => e.type === 'button')
    expect(buttons.map((b) => textOf(b))).toEqual(['Cancel', 'Run'])
    expect(focused.map((f) => textOf(f))).toEqual(['Cancel'])
    ;(buttons[0].props.onClick as () => void)()
    ;(byTestId(els, 'cost-confirm-run')!.props.onClick as () => void)()
    expect(answers).toEqual([false, true])
  })
})

describe('the aiConfirm pref (test 136)', () => {
  it('its sanitiser turns anything else into US$1', () => {
    for (const v of ['always', '0.1', '1', '5', 'never']) expect(sanitizeSmartPref('aiConfirm', v)).toBe(v)
    for (const v of ['2', 1, 'Always', {}, [], true]) expect(sanitizeSmartPref('aiConfirm', v)).toBe('1')
  })

  it('Settings shows the five choices, US$1 at first, and saves the one picked', async () => {
    const { AiProvidersSection } = (await import(/* @vite-ignore */ SECTION)) as { AiProvidersSection: (p: unknown) => unknown }
    const root = { type: AiProvidersSection, props: { autoFocus: false } }
    let els = await settle(root, ['ProviderForm', 'LocalAiRow'])
    const select = byTestId(els, 'ai-confirm')!
    expect(select.props.value).toBe('1')
    const options = els.filter((e) => e.type === 'option' && ['always', '0.1', '1', '5', 'never'].includes(String(e.props.value)))
    expect(options.map((o) => [o.props.value, textOf(o)])).toEqual([
      ['always', 'Always ask'],
      ['0.1', 'US$0.10'],
      ['1', 'US$1'],
      ['5', 'US$5'],
      ['never', 'Never']
    ])
    const label = els.find((e) => e.type === 'label' && e.props.htmlFor === select.props.id)!
    expect(textOf(label)).toContain('Ask before a run that costs more than')
    ;(select.props.onChange as (e: unknown) => void)({ target: { value: '5' } })
    await new Promise((r) => setTimeout(r, 0))
    expect(prefs.set).toEqual([['aiConfirm', '5']])
    els = await settle(root, ['ProviderForm', 'LocalAiRow'])
    expect(byTestId(els, 'ai-confirm')!.props.value).toBe('5')
    // A stored choice is shown when Settings opens.
    unmountAll()
    prefs.values.set('aiConfirm', 'never')
    expect(byTestId(await settle(root, ['ProviderForm', 'LocalAiRow']), 'ai-confirm')!.props.value).toBe('never')
  })
})
