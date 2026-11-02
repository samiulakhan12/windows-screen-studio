import { beforeEach, describe, expect, it, vi } from 'vitest'
import type { Project } from '../src/shared/types'
import { button, byTestId, contexts, mockReact, settle, testStore, unmountAll, useEditorContexts } from './studioHarness'

/*
 * Captions › Clean up's Tidy captions with the AI fix ticked (docs/design/captions-studio.md §11.7
 * rule 6) without a DOM: the provider fixes the captions as rules 1–4 leave them, so its answer
 * keeps the word list's terms, the digits, the capitals and the full stops. A cancelled run's late
 * answer leaves the next run working.
 */

type Sent = { task: string; segments: { id: string; start: number; end: number; text: string }[] }
const sent: Sent[] = []
// While `hold.on`, the provider's answers wait until the test lets each one go.
const hold = { on: false, answers: [] as (() => void)[] }
vi.stubGlobal('document', { activeElement: null, body: {} })
vi.stubGlobal('window', {
  api: {
    getPref: async (key: string) => (key === 'captionCleanup' ? { ai: true } : key === 'captionWordList' ? [{ term: 'Qbexel', heard: ['cubexel'] }] : null),
    setPref: async () => undefined,
    listAiProviders: async () => [{ id: 'g1', kind: 'gemini', label: '', model: 'gemini-x' }],
    // The provider fixes one misspelt word and keeps the rest as it was sent.
    aiText: async (_id: string, req: Sent) => {
      sent.push(req)
      if (hold.on) await new Promise<void>((go) => hold.answers.push(go))
      return { task: 'cleanup', segments: req.segments.map((s) => ({ ...s, text: s.text.replace('reprots', 'reports') })) }
    }
  },
  addEventListener: () => undefined,
  removeEventListener: () => undefined,
  dispatchEvent: () => true
})

mockReact()
// Renderer code: imported at run time so the Node typecheck of tests/ does not follow it.
const CLEANUP = '../src/renderer/src/editor/panels/CleanupSection'
const { CleanupSection } = (await import(/* @vite-ignore */ CLEANUP)) as { CleanupSection: (p: unknown) => unknown }
await useEditorContexts()
const { createProject } = await import('../src/shared/engine/project')

const base = (): Project => ({
  ...createProject({ id: 'p', name: 'p', duration: 10, width: 1920, height: 1080, hasWebcam: false, hasAudio: true, webcamOffset: 0, zooms: [], cursorValid: true, capture: { method: 'native', cursorInVideo: false, region: null } }),
  transcript: { language: 'en', segments: [{ id: 'c1', start: 0, end: 2, text: 'we use cubexel for twenty five reprots' }] } as Project['transcript']
})
let store: ReturnType<typeof testStore<Project>>
const cleanup = (): unknown => ({ type: CleanupSection, props: { project: store.state } })

beforeEach(() => {
  unmountAll()
  sent.length = 0
  hold.on = false
  hold.answers.length = 0
  store = testStore(base())
  contexts.editor = { store, player: { time: 0, subscribe: () => () => undefined } }
})

describe('Tidy captions with the AI fix (§11.7 rule 6)', () => {
  it('sends the captions as the rules leave them, and keeps the word list and digits with the fix', async () => {
    let els = await settle(cleanup())
    els = await settle(cleanup())
    expect(byTestId(els, 'cleanup-ai')?.props.checked).toBe(true)
    ;(byTestId(els, 'cleanup-run')!.props.onClick as () => void)()
    await settle(cleanup())
    expect(sent.map((r) => r.segments.map((s) => s.text))).toEqual([['We use Qbexel for 25 reprots.']])
    expect(store.state.transcript!.segments.map((s) => s.text)).toEqual(['We use Qbexel for 25 reports.'])
    // Remove in Review puts back the text from before the tidy.
    expect(store.state.captionAuto?.text).toMatchObject([{ caption: 'c1', text: 'we use cubexel for twenty five reprots' }])
    expect(store.steps).toBe(1)
  })

  it("keeps the next run working, with its Cancel, when a cancelled run's answer comes late", async () => {
    hold.on = true
    let els = await settle(cleanup())
    els = await settle(cleanup())
    ;(byTestId(els, 'cleanup-run')!.props.onClick as () => void)()
    els = await settle(cleanup())
    ;(button(els, 'Cancel')!.props.onClick as () => void)()
    els = await settle(cleanup())
    expect(byTestId(els, 'cleanup-run')?.props.disabled).toBe(false)
    ;(byTestId(els, 'cleanup-run')!.props.onClick as () => void)()
    els = await settle(cleanup())
    expect(sent).toHaveLength(2)
    // The cancelled run's answer comes while the second run still waits for its own.
    hold.answers[0]()
    els = await settle(cleanup())
    expect(byTestId(els, 'cleanup-run')?.props.disabled).toBe(true)
    expect(button(els, 'Cancel')).toBeDefined()
    expect(store.state.transcript!.segments.map((s) => s.text)).toEqual(['we use cubexel for twenty five reprots'])
    hold.answers[1]()
    els = await settle(cleanup())
    expect(byTestId(els, 'cleanup-run')?.props.disabled).toBe(false)
    expect(button(els, 'Cancel')).toBeUndefined()
    expect(store.state.transcript!.segments.map((s) => s.text)).toEqual(['We use Qbexel for 25 reports.'])
    expect(store.steps).toBe(1)
  })
})
