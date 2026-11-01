import { beforeEach, describe, expect, it, vi } from 'vitest'
import type { Project } from '../src/shared/types'
import { button, byTestId, contexts, focused, mockReact, settle, testStore, textOf, unmountAll, useEditorContexts, type El } from './studioHarness'

/*
 * Captions › Languages and Clean up's word list from the keyboard (docs/design/captions-studio.md
 * §2.10, §2.15) without a DOM: the forms that open in place of their button (Add a language, Add a
 * word) give the keyboard back to it when the keyboard closes them; a click does not.
 */

// Whether the last input was a key (focus.ts keeps it from the window's events, which these tests have not).
const keys = vi.hoisted(() => ({ last: false }))
vi.mock('../src/renderer/src/editor/focus', async (importOriginal) => ({ ...(await importOriginal<Record<string, unknown>>()), lastInputWasKey: () => keys.last }))

const sent: unknown[] = []
vi.stubGlobal('document', { activeElement: null, body: {} })
vi.stubGlobal('window', {
  api: {
    getPref: async () => null,
    setPref: async () => undefined,
    listAiProviders: async () => [{ id: 'g1', kind: 'gemini', label: '', model: 'gemini-x' }],
    aiText: async (_id: string, req: { segments: { id: string; start: number; end: number; text: string }[] }) => {
      sent.push(req)
      return { task: 'translate', segments: req.segments.map((s) => ({ id: s.id, start: s.start, end: s.end, text: `bn ${s.text}` })) }
    }
  },
  addEventListener: () => undefined,
  removeEventListener: () => undefined,
  dispatchEvent: () => true
})

mockReact()
// Renderer code: imported at run time so the Node typecheck of tests/ does not follow it.
const LANGUAGES = '../src/renderer/src/editor/panels/LanguagesSection'
const CLEANUP = '../src/renderer/src/editor/panels/CleanupSection'
const { LanguagesSection } = (await import(/* @vite-ignore */ LANGUAGES)) as { LanguagesSection: (p: unknown) => unknown }
const { CleanupSection } = (await import(/* @vite-ignore */ CLEANUP)) as { CleanupSection: (p: unknown) => unknown }
await useEditorContexts()
const { createProject } = await import('../src/shared/engine/project')

const base = (): Project => ({
  ...createProject({ id: 'p', name: 'p', duration: 10, width: 1920, height: 1080, hasWebcam: false, hasAudio: true, webcamOffset: 0, zooms: [], cursorValid: true, capture: { method: 'native', cursorInVideo: false, region: null } }),
  transcript: { language: 'en', segments: [{ id: 'c1', start: 0, end: 2, text: 'Make every word count' }] } as Project['transcript']
})
let store: ReturnType<typeof testStore<Project>>
const languages = (): unknown => ({ type: LanguagesSection, props: { project: store.state } })
const cleanup = (): unknown => ({ type: CleanupSection, props: { project: store.state } })

beforeEach(() => {
  unmountAll()
  keys.last = false
  sent.length = 0
  store = testStore(base())
  contexts.editor = { store, player: { time: 0, subscribe: () => () => undefined } }
})

describe('Add a language gives the keyboard back to its button (§2.15)', () => {
  const openForm = async (): Promise<El[]> => {
    const els = await settle(languages())
    ;(byTestId(els, 'track-add')!.props.onClick as () => void)()
    return settle(languages())
  }

  it('Close with the keyboard focuses Add a language; Close clicked does not', async () => {
    keys.last = true
    let els = await openForm()
    expect(focused.at(-1)?.type).toBe('select')
    ;(button(els, 'Close')!.props.onClick as () => void)()
    els = await settle(languages())
    expect(byTestId(els, 'track-translate')).toBeUndefined()
    expect(focused.at(-1)?.props['data-testid']).toBe('track-add')
    focused.length = 0
    keys.last = false
    els = await openForm()
    ;(button(els, 'Close')!.props.onClick as () => void)()
    els = await settle(languages())
    expect(byTestId(els, 'track-add')).toBeDefined()
    expect(focused.map((e) => e.type)).toEqual(['select'])
  })

  it('Translate pressed with the keyboard focuses Add a language once the translation is written', async () => {
    keys.last = true
    const els = await openForm()
    ;(byTestId(els, 'track-translate')!.props.onClick as () => void)()
    const after = await settle(languages())
    expect(sent).toHaveLength(1)
    expect(store.state.captionTracks?.map((t) => t.language)).toHaveLength(1)
    expect(byTestId(after, 'track-translate')).toBeUndefined()
    expect(focused.at(-1)?.props['data-testid']).toBe('track-add')
  })
})

describe('Add a word gives the keyboard back to its button (§2.15)', () => {
  const openForm = async (): Promise<El[]> => {
    const els = await settle(cleanup())
    ;(button(els, 'Add a word')!.props.onClick as () => void)()
    return settle(cleanup())
  }

  it('Add and Cancel with the keyboard focus Add a word; a click does not', async () => {
    keys.last = true
    let els = await openForm()
    expect(focused.at(-1)?.type).toBe('input')
    const term = els.find((e) => e.type === 'input' && e.props.maxLength !== undefined)!
    ;(term.props.onChange as (e: unknown) => void)({ target: { value: 'Flown' } })
    els = await settle(cleanup())
    ;(els.find((e) => e.type === 'form')!.props.onSubmit as (e: unknown) => void)({ preventDefault: () => undefined })
    els = await settle(cleanup())
    expect(els.find((e) => e.type === 'form')).toBeUndefined()
    expect(textOf(focused.at(-1))).toBe('Add a word')

    els = await openForm()
    ;(button(els, 'Cancel')!.props.onClick as () => void)()
    els = await settle(cleanup())
    expect(textOf(focused.at(-1))).toBe('Add a word')

    focused.length = 0
    keys.last = false
    els = await openForm()
    ;(button(els, 'Cancel')!.props.onClick as () => void)()
    els = await settle(cleanup())
    expect(button(els, 'Add a word')).toBeDefined()
    expect(focused.map((e) => e.type)).toEqual(['input'])
  })
})
