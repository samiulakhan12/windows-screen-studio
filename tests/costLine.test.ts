import { beforeEach, describe, expect, it, vi } from 'vitest'
import type { Project } from '../src/shared/types'
import type { AiTextRequest, TextChoice } from '../src/shared/api/ai'
import { BUNDLED_PRICE_LIST } from '../src/shared/ai/prices'
import { byTestId, contexts, mockReact, settle, testStore, textOf, unmountAll, useEditorContexts, type El } from './studioHarness'

/*
 * The cost line (docs/design/smart-tools.md §2.7, §11.5; §22 tests 94, 137 and the confirm of 92):
 * for a group, the place named once and each action's cost, each button's aria-describedby reading its
 * own short sentence, and Details listing the model, the date and the token ranges; every action of
 * the pickers has a cost its button names; no line names a place other than the choice's (a Groq
 * service shows "api.groq.com", On this PC "this PC", never "OpenAI" or "undefined"); a click above
 * the amount set is held, asked about, and made again only after Run.
 */

const local = vi.hoisted(() => ({ ready: false }))
vi.mock('../src/renderer/src/ai/localAiState', () => ({ useLocalAiReady: () => local.ready, useLocalAiProgress: () => null, useLocalNote: () => null }))
/** The question's answer (the dialog itself is tested in costConfirm.test.ts), and what was asked. */
const question = vi.hoisted(() => ({ answer: true, asked: [] as { usd: unknown; model: string }[] }))
vi.mock('../src/renderer/src/ai/costConfirm', () => ({
  confirmCost: async (e: { usd: unknown }, c: { model: string }) => {
    question.asked.push({ usd: e.usd, model: c.model })
    return question.answer
  },
  wasAsked: () => false,
  resetAskedCosts: () => undefined
}))

const GROQ = { id: 'svc1', kind: 'openai', label: 'Groq', model: 'openai/gpt-oss-20b', maskedKey: '', createdAt: '', service: { preset: 'groq', baseUrl: 'https://api.groq.com/openai/v1', host: 'api.groq.com', loopback: false, json: 'schema' } }
const OPENAI = { id: 'ai1', kind: 'openai', label: 'My OpenAI', model: 'gpt-6.1-sol', transcriptionModel: 'whisper-1', maskedKey: '', createdAt: '' }
const env = { providers: [GROQ] as unknown[], prefs: new Map<string, unknown>(), listeners: [] as ((e: unknown) => void)[] }
vi.stubGlobal('window', {
  api: {
    getPref: async (k: string) => env.prefs.get(k) ?? null,
    setPref: async () => undefined,
    listAiProviders: async () => env.providers,
    getAiPriceList: async () => BUNDLED_PRICE_LIST,
    localAiState: async () => ({ active: 'qwen3.5-2b', speeds: { 'qwen3.5-2b': { read: 200, write: 8 } } }),
    aiText: async () => ({ task: 'title', text: 'x' }),
    draftScript: async () => ({ text: 'x' }),
    cancelAiText: async () => undefined,
    cancelScriptDraft: async () => undefined
  },
  addEventListener: () => undefined,
  removeEventListener: () => undefined,
  dispatchEvent: () => true
})
vi.stubGlobal('document', {
  activeElement: null,
  body: {},
  addEventListener: (type: string, fn: (e: unknown) => void) => type === 'click' && env.listeners.push(fn),
  removeEventListener: (_type: string, fn: (e: unknown) => void) => {
    env.listeners = env.listeners.filter((l) => l !== fn)
  }
})
vi.stubGlobal('MutationObserver', class {
  observe(): void {}
  disconnect(): void {}
})
mockReact()

const COST_LINE = '../src/renderer/src/ai/CostLine'
const USE_COST = '../src/renderer/src/ai/useCost'
const CONFIRM = '../src/renderer/src/ai/costConfirm'
const { CostLine } = (await import(/* @vite-ignore */ COST_LINE)) as { CostLine: (p: unknown) => unknown }
const { refreshCostData } = (await import(/* @vite-ignore */ USE_COST)) as { refreshCostData: () => Promise<void> }
const { resetAskedCosts } = (await import(/* @vite-ignore */ CONFIRM)) as { resetAskedCosts: () => void }
const LANGUAGES = '../src/renderer/src/editor/panels/LanguagesSection'
const CLEANUP = '../src/renderer/src/editor/panels/CleanupSection'
const DRAFT = '../src/renderer/src/notes/DraftScript'
const { LanguagesSection } = (await import(/* @vite-ignore */ LANGUAGES)) as { LanguagesSection: (p: unknown) => unknown }
const { CleanupSection } = (await import(/* @vite-ignore */ CLEANUP)) as { CleanupSection: (p: unknown) => unknown }
const { DraftScript } = (await import(/* @vite-ignore */ DRAFT)) as { DraftScript: (p: unknown) => unknown }
await useEditorContexts()
const { createProject } = await import('../src/shared/engine/project')

const seg = (i: number, text: string) => ({ id: `c${i}`, start: i * 3, end: i * 3 + 2, text })
const SEGMENTS = Array.from({ length: 60 }, (_, i) => seg(i, `Now we open the report number ${i} and export it as a file.`))
const base = (): Project => ({
  ...createProject({ id: 'p', name: 'p', duration: 200, width: 1920, height: 1080, hasWebcam: false, hasAudio: true, webcamOffset: 0, zooms: [], cursorValid: true, capture: { method: 'native', cursorInVideo: false, region: null } }),
  transcript: { language: 'en', segments: SEGMENTS } as Project['transcript']
})

const choice = (c: Partial<TextChoice> = {}): TextChoice => ({ id: 'ai1', label: 'My OpenAI', kind: 'openai', model: 'gpt-6.1-sol', place: 'OpenAI', pictures: true, ...c })
const captionsGroup = (c: TextChoice): unknown => ({
  type: CostLine,
  props: {
    id: 'captions-ai-cost',
    choice: c,
    actions: (['chapters', 'title', 'summary'] as const).map((task) => ({
      key: task,
      label: task === 'chapters' ? 'Chapters' : task === 'title' ? 'Title' : 'Summary',
      buttonId: `captions-ai-${task}`,
      request: (): AiTextRequest => ({ task, segments: SEGMENTS })
    }))
  }
})
const byId = (els: El[], id: string): El | undefined => els.find((e) => e.props.id === id)
const hostText = (els: El[]): string => els.map((e) => (typeof e.type === 'string' ? textOf(e) : '')).join(' ')

beforeEach(async () => {
  unmountAll()
  env.prefs.clear()
  env.providers = [GROQ]
  env.listeners = []
  local.ready = false
  resetAskedCosts()
  await refreshCostData()
})

describe("a group's line (test 137)", () => {
  it('names the place once and each action’s cost; each button reads its own sentence', async () => {
    const els = await settle(captionsGroup(choice()))
    const line = textOf(byId(els, 'captions-ai-cost')!)
    // 60 captions of 13 words; gpt-6.1-sol thinks, which widens each high end.
    expect(line).toMatch(/^Sends about 780 words of captions to OpenAI · Chapters (about |under |up to )?US\$[\d.]+( to US\$[\d.]+)? · Title (about |under |up to )?US\$[\d.]+( to US\$[\d.]+)? · Summary (about |under |up to )?US\$[\d.]+( to US\$[\d.]+)?$/)
    expect(line.split('OpenAI')).toHaveLength(2)
    for (const key of ['chapters', 'title', 'summary']) {
      expect(textOf(byId(els, `captions-ai-cost-${key}`)!), key).toMatch(/^(About |Under |Up to )?US\$[\d.]+( to US\$[\d.]+)?; sends your captions to OpenAI\.$/)
    }
  })

  it('Details lists the model, the date of the prices and each action’s token ranges', async () => {
    let els = await settle(captionsGroup(choice()))
    const details = els.find((e) => e.type === 'button' && textOf(e) === 'Details')!
    expect(details.props['aria-expanded']).toBe(false)
    expect(details.props['aria-controls']).toBe('captions-ai-cost-details')
    ;(details.props.onClick as () => void)()
    els = await settle(captionsGroup(choice()))
    const list = textOf(byId(els, 'captions-ai-cost-details')!)
    expect(list).toContain('Model: gpt-6.1-sol')
    expect(list).toContain('Prices of 7 November 2026')
    expect(list).toMatch(/Chapters: [\d,]+–[\d,]+ tokens in, 25–2,050 out/)
    expect(list).toMatch(/Title: [\d,]+–[\d,]+ tokens in, 15–540 out/)
  })
})

describe('each provider type (test 94)', () => {
  const full = (c: TextChoice): unknown => ({ type: CostLine, props: { id: 'x-cost', choice: c, full: true, actions: [{ key: 'translate', label: 'Translate', buttonId: 'x', request: { task: 'translate', segments: SEGMENTS, targetLanguage: 'Bengali' } }] } })
  it('a known price, a service without one, a router, Ollama on this PC and On this PC', async () => {
    const line = async (c: TextChoice): Promise<string> => textOf(byId(await settle(full(c)), 'x-cost')!)
    expect(await line(choice())).toMatch(/^Sends about 780 words of captions to OpenAI · (About |Up to )?US\$[\d.]+( to US\$[\d.]+)? \(gpt-6\.1-sol, prices of 7 November 2026\)$/)
    expect(await line(choice({ id: 'svc1', model: 'llama-4-scout', host: 'api.groq.com', place: 'api.groq.com' }))).toBe('Sends about 780 words of captions to api.groq.com · Cost unknown for llama-4-scout: add its prices in Settings')
    expect(await line(choice({ id: 'svc2', model: 'openrouter/auto', host: 'openrouter.ai', place: 'openrouter.ai' }))).toBe('Sends about 780 words of captions to openrouter.ai · Cost unknown for openrouter/auto: it picks a model for each request')
    expect(await line(choice({ id: 'svc3', model: 'llama3', host: 'localhost:11434', place: 'Ollama on this PC', free: true }))).toBe('Sends about 780 words of captions to Ollama on this PC · No cost')
    expect(await line({ id: 'local', label: 'On this PC', kind: 'local', model: '', place: 'this PC', pictures: false })).toMatch(/^Stays on this PC · About \d+ (seconds|minutes?)$/)
  })

  it('Generate captions: the recording’s minutes with the transcription model', async () => {
    env.providers = [OPENAI]
    const els = await settle({ type: CostLine, props: { id: 'captions-generate-cost', choice: choice(), full: true, transcribeSeconds: 600, actions: [{ key: 'transcribe', label: 'Captions', buttonId: 'captions-generate', request: null }] } })
    expect(textOf(byId(els, 'captions-generate-cost')!)).toBe("Sends the recording's sound to OpenAI · About US$0.06 (whisper-1, prices of 7 November 2026)")
    expect(textOf(byId(els, 'captions-generate-cost-transcribe')!)).toBe("About US$0.06; sends the recording's sound to OpenAI.")
  })

  it('in the pickers, every button a cost line names finds its sentence, and no text names another place', async () => {
    const store = testStore(base())
    contexts.editor = { store, player: { time: 0, subscribe: () => () => undefined } }
    const views: El[][] = []
    let langs = await settle({ type: LanguagesSection, props: { project: store.state } }, ['LocalProgress'])
    ;(byTestId(langs, 'track-add')!.props.onClick as () => void)()
    langs = await settle({ type: LanguagesSection, props: { project: store.state } }, ['LocalProgress'])
    views.push(langs)
    env.prefs.set('captionCleanup', { ai: true })
    views.push(await settle({ type: CleanupSection, props: { project: store.state } }, ['LocalProgress']))
    views.push(await settle({ type: DraftScript, props: { text: '- point one\n- point two', onReplace: () => undefined } }, ['LocalProgress']))
    let named = 0
    for (const els of views) {
      for (const b of els.filter((e) => e.type === 'button' && typeof e.props['aria-describedby'] === 'string')) {
        const ids = String(b.props['aria-describedby']).split(/\s+/).filter((i) => /cost/.test(i))
        for (const id of ids) {
          named++
          const sentence = byId(els, id)
          expect(sentence, `${textOf(b)} → ${id}`).toBeDefined()
          expect(textOf(sentence!)).toMatch(/api\.groq\.com\.$/)
        }
      }
      expect(hostText(els)).not.toMatch(/OpenAI|undefined/)
    }
    expect(named).toBe(3)
    // On this PC: "this PC", never undefined.
    unmountAll()
    env.providers = []
    local.ready = true
    const drafted = await settle({ type: DraftScript, props: { text: '- point one', onReplace: () => undefined } }, ['LocalProgress'])
    expect(textOf(byId(drafted, 'notes-draft-cost-draft')!)).toMatch(/stays on this PC\.$/)
    expect(hostText(drafted)).not.toMatch(/undefined|OpenAI/)
  })
})

describe('a click above the amount set asks first (test 92)', () => {
  /** A stand-in button the document's listener sees. */
  const button = (id: string, describedBy: string) => {
    const b = { id, isConnected: true, clicks: 0, getAttribute: (n: string) => (n === 'aria-describedby' ? describedBy : null), click: () => void b.clicks++, closest: (sel: string) => (sel === 'button' ? b : null) }
    return b
  }
  const click = (target: unknown) => {
    const e = { target, stopped: false, prevented: false, preventDefault: () => (e.prevented = true), stopImmediatePropagation: () => (e.stopped = true) }
    for (const l of env.listeners) l(e)
    return e
  }

  it('Always ask: the click is held, asked about, and made again only after Run', async () => {
    env.prefs.set('aiConfirm', 'always')
    await refreshCostData()
    await settle(captionsGroup(choice()))
    question.asked = []
    question.answer = false
    const title = button('captions-ai-title', 'captions-ai-cost-title')
    const e = click(title)
    expect(e.prevented && e.stopped).toBe(true)
    await new Promise((r) => setTimeout(r, 0))
    expect(question.asked).toHaveLength(1)
    expect(question.asked[0].model).toBe('gpt-6.1-sol')
    expect(title.clicks).toBe(0)
    // Run: the click is made again, and that one goes through.
    question.answer = true
    click(title)
    await new Promise((r) => setTimeout(r, 0))
    expect(title.clicks).toBe(1)
    expect(click(title).prevented).toBe(false)
    // Write all names the line itself: it is asked about with the sum of the actions.
    question.asked = []
    const all = button('publish-write-all', 'captions-ai-cost')
    click(all)
    await new Promise((r) => setTimeout(r, 0))
    const [sum] = question.asked
    expect((sum.usd as number[])[1]).toBeGreaterThan(0)
  })

  it('under the amount set, the click goes through untouched', async () => {
    await settle(captionsGroup(choice()))
    const title = button('captions-ai-title', 'captions-ai-cost-title')
    const e = click(title)
    expect(e.prevented || e.stopped).toBe(false)
    // A button the line does not name is never held.
    env.prefs.set('aiConfirm', 'always')
    await refreshCostData()
    await settle(captionsGroup(choice()))
    expect(click(button('other', 'something-else')).prevented).toBe(false)
  })
})
