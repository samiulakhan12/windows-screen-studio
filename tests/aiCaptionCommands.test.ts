import { beforeEach, describe, expect, it, vi } from 'vitest'
import type { AiProviderInfo } from '../src/shared/api/ai'
import type { Project } from '../src/shared/types'
import { byTestId, contexts, focused, mockReact, settle, testStore, unmountAll, useEditorContexts, type El } from './studioHarness'

/*
 * Test 57 (docs/design/captions-studio.md §2.14): the publishing pack's two caption commands open
 * Captions Studio's sections. Translate captions with AI… sends { kind: 'language', via: 'ai' } and
 * Languages opens Add a language with the first AI provider chosen and the language select
 * focused; Fix captions with AI sends { kind: 'cleanup', ai: true } and Clean up ticks and focuses
 * Also fix spelling and misheard words with AI (without a provider it says to add one first);
 * neither reaches the AI tools, whose tasks are chapters, a title and a summary.
 */

const providers = vi.hoisted(() => ({ list: [] as AiProviderInfo[] }))
const prefs: Record<string, unknown> = {}
vi.stubGlobal('document', { activeElement: null, body: {} })
vi.stubGlobal('window', {
  api: {
    getPref: async (k: string) => prefs[k] ?? null,
    setPref: async (k: string, v: unknown) => void (prefs[k] = v),
    listAiProviders: async () => providers.list,
    aiText: async () => {
      throw new Error('nothing is sent')
    }
  },
  addEventListener: () => undefined,
  removeEventListener: () => undefined,
  dispatchEvent: () => true
})

mockReact()
// Renderer code: imported at run time so the Node typecheck of tests/ does not follow it.
const COMMANDS = '../src/renderer/src/editor/captionCommands'
const ITEMS = '../src/renderer/src/editor/captionItems'
const LANGUAGES = '../src/renderer/src/editor/panels/LanguagesSection'
const CLEANUP = '../src/renderer/src/editor/panels/CleanupSection'
const { aiCaptionCommands } = (await import(/* @vite-ignore */ COMMANDS)) as {
  aiCaptionCommands: (deps: unknown) => Record<'aiTranslate' | 'aiCleanup', () => void>
}
const items = (await import(/* @vite-ignore */ ITEMS)) as { takeCaptionsRequest(): unknown; peekCaptionsRequest(): unknown; takeSectionRequest(kind: string): unknown }
const { LanguagesSection } = (await import(/* @vite-ignore */ LANGUAGES)) as { LanguagesSection: (p: unknown) => unknown }
const { CleanupSection } = (await import(/* @vite-ignore */ CLEANUP)) as { CleanupSection: (p: unknown) => unknown }
await useEditorContexts()
const { createProject } = await import('../src/shared/engine/project')

const GEMINI: AiProviderInfo = { id: 'g1', kind: 'gemini', label: '', model: 'gemini-x' } as AiProviderInfo
const OPENAI: AiProviderInfo = { id: 'o1', kind: 'openai', label: '', model: 'gpt-x' } as AiProviderInfo

const base = (captions = true): Project => ({
  ...createProject({ id: 'p', name: 'p', duration: 10, width: 1920, height: 1080, hasWebcam: false, hasAudio: true, webcamOffset: 0, zooms: [], cursorValid: true, capture: { method: 'native', cursorInVideo: false, region: null } }),
  ...(captions ? { transcript: { language: 'en', segments: [{ id: 'c1', start: 0, end: 2, text: 'Make every word count' }] } as Project['transcript'] } : {})
})

let store: ReturnType<typeof testStore<Project>>
const tabs: string[] = []
const notices: string[] = []
const commands = (): Record<'aiTranslate' | 'aiCleanup', () => void> => aiCaptionCommands({ store, setTab: (t: string) => tabs.push(t), notice: (m: string) => notices.push(m) })
const languages = (): unknown => ({ type: LanguagesSection, props: { project: store.state } })
const cleanup = (): unknown => ({ type: CleanupSection, props: { project: store.state } })
const chips = (els: El[]): El[] => els.filter((e) => e.type === 'button' && typeof e.props['aria-pressed'] === 'boolean')
const text = (e: El | undefined): string => (Array.isArray(e?.props.children) ? (e!.props.children as unknown[]).join('') : String(e?.props.children ?? ''))

beforeEach(() => {
  unmountAll()
  store = testStore(base())
  tabs.length = 0
  notices.length = 0
  for (const k of Object.keys(prefs)) delete prefs[k]
  providers.list = [GEMINI, OPENAI]
  items.takeSectionRequest('language')
  items.takeSectionRequest('cleanup')
  items.takeCaptionsRequest()
  contexts.editor = { store, player: { time: 0, subscribe: () => () => undefined } }
})

describe('Translate captions with AI… (aiTranslate)', () => {
  it('asks the Captions tab for Languages › Add a language by an AI provider', () => {
    commands().aiTranslate()
    expect(tabs).toEqual(['captions'])
    expect(items.peekCaptionsRequest()).toEqual({ kind: 'language', via: 'ai' })
    expect(notices).toEqual([])
  })

  it('opens Add a language with the first provider chosen and the language select focused', async () => {
    let els = await settle(languages())
    // The user had picked the second provider in an earlier form.
    ;(byTestId(els, 'track-add')!.props.onClick as () => void)()
    els = await settle(languages())
    ;(chips(els)[1].props.onClick as () => void)()
    els = await settle(languages())
    expect(chips(els).map((c) => c.props['aria-pressed'])).toEqual([false, true])
    const close = els.find((e) => e.type === 'button' && text(e) === 'Close')!
    ;(close.props.onClick as () => void)()
    await settle(languages())
    focused.length = 0
    commands().aiTranslate()
    els = await settle(languages())
    expect(byTestId(els, 'track-translate')).toBeDefined()
    expect(chips(els).map((c) => [text(c), c.props['aria-pressed']])).toEqual([
      ['Gemini', true],
      ['OpenAI', false]
    ])
    expect(focused.at(-1)?.type).toBe('select')
  })
})

describe('Fix captions with AI (aiCleanup)', () => {
  it('asks the Captions tab for Clean up with the AI fix', () => {
    commands().aiCleanup()
    expect(tabs).toEqual(['captions'])
    expect(items.peekCaptionsRequest()).toEqual({ kind: 'cleanup', ai: true })
  })

  it('opens Clean up with Also fix spelling and misheard words with AI ticked, saved and focused', async () => {
    let els = await settle(cleanup())
    expect(byTestId(els, 'cleanup-ai')?.props.checked).toBe(false)
    focused.length = 0
    commands().aiCleanup()
    els = await settle(cleanup())
    els = await settle(cleanup())
    expect(byTestId(els, 'cleanup-ai')?.props.checked).toBe(true)
    expect(focused.at(-1)?.props['data-testid']).toBe('cleanup-ai')
    expect(prefs.captionCleanup).toMatchObject({ ai: true })
  })

  it('without an AI provider says to add one first (the tick box is not shown), and focuses nothing', async () => {
    providers.list = []
    commands().aiCleanup()
    const els = await settle(cleanup())
    expect(byTestId(els, 'cleanup-ai')).toBeUndefined()
    expect(focused).toEqual([])
    const status = els.find((e) => e.props.role === 'status')
    expect(text(status)).toBe('To fix spelling with AI, add an AI provider first: the button is in the AI tools section.')
  })
})

describe('both commands without captions', () => {
  it('say there are no captions yet and open nothing', () => {
    store = testStore(base(false))
    commands().aiTranslate()
    commands().aiCleanup()
    expect(tabs).toEqual([])
    expect(items.peekCaptionsRequest()).toBeNull()
    expect(notices).toEqual(['This video has no captions yet: generate them in the Captions tab', 'This video has no captions yet: generate them in the Captions tab'])
  })
})
