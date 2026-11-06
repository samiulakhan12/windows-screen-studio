import { beforeEach, describe, expect, it, vi } from 'vitest'
import type { Project } from '../src/shared/types'
import { button, byTestId, contexts, focused, key, mockReact, settle, testStore, textOf, unmountAll, useEditorContexts, type El } from './studioHarness'

/*
 * Captions › Languages and Clean up's word list from the keyboard (docs/design/captions-studio.md
 * §2.10, §2.15) without a DOM: each Show on the video radio is named with its row's language and
 * keeps Left and Right (the editor would step the playhead), and the forms that open in place of
 * their button (Add a language, Add a word) give the keyboard back to it when the keyboard closes
 * them, or to what took the button's place once it is off; a click does not. A translation the
 * keyboard started puts the focus back when it ends, done, failed or cancelled, unless a click or
 * an editor shortcut came meanwhile. Clean up's hints name nothing this version lacks.
 */

// Whether the last input was a key (focus.ts keeps it from the window's events, which these tests have not).
const keys = vi.hoisted(() => ({ last: false }))
vi.mock('../src/renderer/src/editor/focus', async (importOriginal) => ({ ...(await importOriginal<Record<string, unknown>>()), lastInputWasKey: () => keys.last }))

const sent: unknown[] = []
/** The request ids each translation was sent with, and those cancelAiText was asked to stop. */
const ids = { sent: [] as unknown[], stopped: [] as unknown[] }
// A translation answers at once, or once `ai.wait` settles; it fails when `ai.fail` is set.
const ai: { wait: Promise<void> | null; fail: boolean } = { wait: null, fail: false }
/** The page (document.body). */
const page = {}
vi.stubGlobal('document', { activeElement: null, body: page })
/** The window's listeners, by event type. */
const listeners: Record<string, Set<(e: unknown) => void>> = {}
/** A key or a pointer press as the window hears it: `target` is what had the focus (the page by default). */
const fire = (type: 'keydown' | 'pointerdown', e: { key?: string; shiftKey?: boolean; target?: unknown } = {}): void =>
  listeners[type]?.forEach((fn) => fn({ type, target: page, ...e }))
/** What has the focus: null stands for the page (the focused control went, or was turned off). */
const setActive = (el: unknown): void => void ((globalThis as unknown as { document: { activeElement: unknown } }).document.activeElement = el)
vi.stubGlobal('window', {
  api: {
    getPref: async () => null,
    setPref: async () => undefined,
    listAiProviders: async () => [{ id: 'g1', kind: 'gemini', label: '', model: 'gemini-x' }],
    aiText: async (_id: string, req: { segments: { id: string; start: number; end: number; text: string }[] }, requestId?: string) => {
      sent.push(req)
      ids.sent.push(requestId)
      if (ai.wait) await ai.wait
      if (ai.fail) throw new Error('the provider is busy')
      return { task: 'translate', segments: req.segments.map((s) => ({ id: s.id, start: s.start, end: s.end, text: `bn ${s.text}` })) }
    },
    cancelAiText: async (requestId: string) => void ids.stopped.push(requestId)
  },
  addEventListener: (type: string, fn: (e: unknown) => void) => void (listeners[type] ??= new Set()).add(fn),
  removeEventListener: (type: string, fn: (e: unknown) => void) => void listeners[type]?.delete(fn),
  dispatchEvent: () => true
})

mockReact()
// Renderer code: imported at run time so the Node typecheck of tests/ does not follow it.
const LANGUAGES = '../src/renderer/src/editor/panels/LanguagesSection'
const CLEANUP = '../src/renderer/src/editor/panels/CleanupSection'
const ITEMS = '../src/renderer/src/editor/captionItems'
const { LanguagesSection } = (await import(/* @vite-ignore */ LANGUAGES)) as { LanguagesSection: (p: unknown) => unknown }
const { CleanupSection } = (await import(/* @vite-ignore */ CLEANUP)) as { CleanupSection: (p: unknown) => unknown }
const { saveWordList, requestCaptions, takeCaptionsRequest } = (await import(/* @vite-ignore */ ITEMS)) as {
  saveWordList: (next: readonly { term: string; heard: string[] }[]) => Promise<void>
  requestCaptions: (r: { kind: 'language'; via: 'ai' }) => void
  takeCaptionsRequest: () => unknown
}
await useEditorContexts()
const { createProject } = await import('../src/shared/engine/project')
const { languageName } = await import('../src/shared/captions/captionTracks')
const { WORD_LIST_MAX } = await import('../src/shared/captions/cleanup')

const base = (): Project => ({
  ...createProject({ id: 'p', name: 'p', duration: 10, width: 1920, height: 1080, hasWebcam: false, hasAudio: true, webcamOffset: 0, zooms: [], cursorValid: true, capture: { method: 'native', cursorInVideo: false, region: null } }),
  transcript: { language: 'en', segments: [{ id: 'c1', start: 0, end: 2, text: 'Make every word count' }] } as Project['transcript']
})
let store: ReturnType<typeof testStore<Project>>
/** Languages as the Captions tab mounts it: with the project the store holds when it renders. */
function LanguagesNow(): unknown {
  return { type: LanguagesSection, props: { project: store.state } }
}
const languages = (): unknown => ({ type: LanguagesNow, props: {} })
const cleanup = (): unknown => ({ type: CleanupSection, props: { project: store.state } })
const radios = (els: El[]): El[] => els.filter((e) => e.type === 'input' && e.props.type === 'radio')
const byId = (els: El[], id: string): El | undefined => els.find((e) => e.props.id === id)
/** An element's name from its aria-labelledby: "Show on the video, Bengali · translated with Gemini". */
const nameOf = (els: El[], el: El | undefined): string =>
  String(el?.props['aria-labelledby'] ?? '')
    .split(' ')
    .map((id) => textOf(byId(els, id)))
    .join(', ')
const track = (language: string): NonNullable<Project['captionTracks']>[number] => ({ language, by: 'gemini', model: 'gemini-x', createdAt: '2026-01-01T00:00:00.000Z', segments: [] })
/** Lets window.api answer without rendering, as the app does between two commits. */
const answer = (): Promise<void> => new Promise((r) => setTimeout(r, 0))

beforeEach(() => {
  unmountAll()
  keys.last = false
  sent.length = 0
  ids.sent.length = 0
  ids.stopped.length = 0
  ai.wait = null
  ai.fail = false
  setActive(null)
  store = testStore(base())
  contexts.editor = { store, player: { time: 0, subscribe: () => () => undefined } }
})

describe('Show on the video (§2.10)', () => {
  beforeEach(() => {
    store.state = { ...base(), captionTracks: [track('bn')] }
  })

  it('names each radio with its words and its row’s language', async () => {
    const els = await settle(languages())
    const names = radios(els).map((r) => nameOf(els, r))
    expect(names).toEqual(['Show on the video, English · spoken', 'Show on the video, Bengali · translated with Gemini'])
  })

  it('keeps Left and Right for the radios (the editor would step the playhead), and leaves their move to the browser', async () => {
    const radio = radios(await settle(languages()))[1]
    for (const k of ['ArrowLeft', 'ArrowRight']) {
      let stopped = false
      const e = { ...key(k), stopPropagation: () => void (stopped = true) }
      ;(radio.props.onKeyDown as (e: unknown) => void)(e)
      expect(stopped).toBe(true)
      expect(e.prevented).toBe(false)
    }
    let stopped = false
    ;(radio.props.onKeyDown as (e: unknown) => void)({ ...key('s'), stopPropagation: () => void (stopped = true) })
    expect(stopped).toBe(false)
  })
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

  it('… also when the keyboard went on to Cancel, which goes with the translation', async () => {
    keys.last = true
    let release = (): void => undefined
    ai.wait = new Promise((r) => (release = r))
    let els = await openForm()
    ;(byTestId(els, 'track-translate')!.props.onClick as () => void)()
    els = await settle(languages())
    // Tab, Tab and Shift+Tab look for the focus: Cancel.
    fire('keydown', { key: 'Tab' })
    fire('keydown', { key: 'Tab' })
    fire('keydown', { key: 'Shift', shiftKey: true })
    fire('keydown', { key: 'Tab', shiftKey: true })
    setActive(button(els, 'Cancel'))
    release()
    await answer()
    setActive(null)
    await settle(languages())
    expect(store.state.captionTracks?.map((t) => t.language)).toHaveLength(1)
    expect(focused.at(-1)?.props['data-testid']).toBe('track-add')
  })

  it('the translation that fills the project’s translations focuses its new row’s Show on the video, as Add a language turns off', async () => {
    store.state = { ...base(), captionTracks: ['bn', 'hi', 'es', 'fr', 'de', 'pt', 'it'].map(track) }
    keys.last = true
    const els = await openForm()
    ;(byTestId(els, 'track-translate')!.props.onClick as () => void)()
    const after = await settle(languages())
    const added = store.state.captionTracks?.[7]?.language ?? ''
    expect(byTestId(after, 'track-add')!.props.disabled).toBe(true)
    expect(focused.at(-1)?.props['data-testid']).toBe('track-show')
    expect(nameOf(after, focused.at(-1))).toBe(`Show on the video, ${languageName(added)} · translated with Gemini`)
  })

  it('Cancel pressed with the keyboard, and a translation that fails, focus Translate again', async () => {
    keys.last = true
    ai.wait = new Promise(() => undefined)
    let els = await openForm()
    ;(byTestId(els, 'track-translate')!.props.onClick as () => void)()
    els = await settle(languages())
    const cancel = button(els, 'Cancel')!
    fire('keydown', { key: 'Enter', target: (cancel.ref as { current?: unknown } | null)?.current })
    ;(cancel.props.onClick as () => void)()
    els = await settle(languages())
    expect(textOf(els.find((e) => e.props.role === 'alert'))).toBe('Could not translate: it was cancelled.')
    expect(focused.at(-1)?.props['data-testid']).toBe('track-translate')
    // Cancel also stops the provider's own request, by the id it was sent with.
    expect(ids.sent).toHaveLength(1)
    expect(ids.sent[0]).toMatch(/^[A-Za-z0-9_-]{1,64}$/)
    expect(ids.stopped).toEqual(ids.sent)

    focused.length = 0
    ai.wait = null
    ai.fail = true
    ;(byTestId(els, 'track-translate')!.props.onClick as () => void)()
    els = await settle(languages())
    expect(textOf(els.find((e) => e.props.role === 'alert'))).toBe('Could not translate: the provider is busy.')
    expect(focused.map((e) => e.props['data-testid'])).toEqual(['track-translate'])
    // Each translation has its own id; one that ended by itself is not stopped.
    expect(ids.sent).toHaveLength(2)
    expect(ids.sent[1]).not.toBe(ids.sent[0])
    expect(ids.stopped).toEqual([ids.sent[0]])
  })

  it('a translation still under way when the section goes stops the provider’s request', async () => {
    ai.wait = new Promise(() => undefined)
    const els = await openForm()
    ;(byTestId(els, 'track-translate')!.props.onClick as () => void)()
    await settle(languages())
    expect(ids.stopped).toEqual([])
    unmountAll()
    expect(ids.stopped).toEqual(ids.sent)
  })

  it('a click while the translation runs leaves the focus where the click left it', async () => {
    keys.last = true
    let release = (): void => undefined
    ai.wait = new Promise((r) => (release = r))
    const els = await openForm()
    focused.length = 0
    ;(byTestId(els, 'track-translate')!.props.onClick as () => void)()
    await settle(languages())
    keys.last = false
    release()
    await settle(languages())
    expect(store.state.captionTracks).toHaveLength(1)
    expect(focused).toEqual([])
  })

  it('… also when keys follow the click', async () => {
    keys.last = true
    let release = (): void => undefined
    ai.wait = new Promise((r) => (release = r))
    const els = await openForm()
    focused.length = 0
    ;(byTestId(els, 'track-translate')!.props.onClick as () => void)()
    await settle(languages())
    fire('pointerdown')
    // Space plays, Right steps a frame: the last input is a key again.
    fire('keydown', { key: ' ' })
    fire('keydown', { key: 'ArrowRight' })
    release()
    await settle(languages())
    expect(store.state.captionTracks).toHaveLength(1)
    expect(focused).toEqual([])
  })

  it('a shortcut pressed on the page while it runs leaves the focus there, so the next one does not pick a radio', async () => {
    store.state = { ...base(), captionTracks: ['bn', 'hi', 'es', 'fr', 'de', 'pt', 'it'].map(track) }
    keys.last = true
    let release = (): void => undefined
    ai.wait = new Promise((r) => (release = r))
    const els = await openForm()
    focused.length = 0
    ;(byTestId(els, 'track-translate')!.props.onClick as () => void)()
    await settle(languages())
    fire('keydown', { key: 'ArrowLeft' })
    release()
    const after = await settle(languages())
    expect(store.state.captionTracks).toHaveLength(8)
    expect(byTestId(after, 'track-add')!.props.disabled).toBe(true)
    expect(focused).toEqual([])
  })
})

describe('a project with the most translations (§2.10, §2.14)', () => {
  const FULL = 'A project keeps at most 8 translations: remove one to add another'
  const eight = ['bn', 'hi', 'es', 'fr', 'de', 'pt', 'it', 'ja'].map(track)

  it('Translate captions with AI… says so and focuses the list instead of opening Add a language; nothing is sent', async () => {
    store.state = { ...base(), captionTracks: eight }
    let els = await settle(languages())
    expect(byTestId(els, 'track-add')!.props).toMatchObject({ disabled: true, title: FULL })
    focused.length = 0
    requestCaptions({ kind: 'language', via: 'ai' })
    takeCaptionsRequest()
    els = await settle(languages())
    expect(byTestId(els, 'track-translate')).toBeUndefined()
    expect(textOf(els.find((e) => e.props.role === 'status' && e.type === 'p'))).toBe(FULL)
    // The radio of the row drawn on the video (the spoken captions).
    expect(focused.at(-1)?.props['data-testid']).toBe('track-show')
    expect(nameOf(els, focused.at(-1))).toBe('Show on the video, English · spoken')
    expect(sent).toHaveLength(0)
  })

  it('Translate in a form left open when the project filled sends nothing and says why', async () => {
    store.state = { ...base(), captionTracks: eight.slice(0, 7) }
    let els = await settle(languages())
    ;(byTestId(els, 'track-add')!.props.onClick as () => void)()
    els = await settle(languages())
    store.state = { ...store.state, captionTracks: eight }
    els = await settle(languages())
    ;(byTestId(els, 'track-translate')!.props.onClick as () => void)()
    els = await settle(languages())
    expect(sent).toHaveLength(0)
    expect(textOf(els.find((e) => e.props.role === 'alert'))).toBe(`Could not translate: a project keeps at most 8 translations: remove one to add another.`)
    expect(store.state.captionTracks).toHaveLength(8)
  })
})

describe('Translate again from the keyboard (§2.15)', () => {
  beforeEach(() => {
    // Not translated yet, so out of date.
    store.state = { ...base(), captionTracks: [track('bn')] }
  })

  it('ends on its row: Show on the video once up to date, Translate again when it failed', async () => {
    keys.last = true
    ai.fail = true
    let els = await settle(languages())
    ;(byTestId(els, 'track-retranslate')!.props.onClick as () => void)()
    els = await settle(languages())
    expect(focused.at(-1)?.props['data-testid']).toBe('track-retranslate')

    ai.fail = false
    ;(byTestId(els, 'track-retranslate')!.props.onClick as () => void)()
    els = await settle(languages())
    expect(byTestId(els, 'track-retranslate')!.props.disabled).toBe(true)
    expect(focused.at(-1)?.props['data-testid']).toBe('track-show')
    expect(nameOf(els, focused.at(-1))).toBe('Show on the video, Bengali · translated with Gemini')
  })

  it('stays on the page when a shortcut was pressed there while it ran (Right steps frames, it does not switch the captions)', async () => {
    store.state = { ...base(), captionTracks: [track('bn'), track('hi')] }
    keys.last = true
    let release = (): void => undefined
    ai.wait = new Promise((r) => (release = r))
    const els = await settle(languages())
    focused.length = 0
    ;(byTestId(els, 'track-retranslate')!.props.onClick as () => void)()
    await settle(languages())
    fire('keydown', { key: 'ArrowRight' })
    fire('keydown', { key: 'ArrowRight' })
    release()
    await settle(languages())
    expect(store.state.captionTracks?.[0].segments).toHaveLength(1)
    expect(focused).toEqual([])
  })
})

describe('Clean up’s hints (§2.9, §0.4)', () => {
  // Until Captions Studio phase B, Review mode did not list tidy changes and the hint left it out.
  it('say tidy changes are listed in Review mode', async () => {
    const hints = (await settle(cleanup())).filter((e) => e.type === 'p' && e.props.className === 'hint').map(textOf)
    expect(hints).toContain('Tidy changes are listed in Review mode. The word list also helps Generate captions spell these words.')
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

  const addFlown = async (els: El[]): Promise<void> => {
    const term = els.find((e) => e.type === 'input' && e.props.maxLength !== undefined)!
    ;(term.props.onChange as (e: unknown) => void)({ target: { value: 'Flown' } })
    els = await settle(cleanup())
    ;(els.find((e) => e.type === 'form')!.props.onSubmit as (e: unknown) => void)({ preventDefault: () => undefined })
  }

  it('Add with the keyboard that fills the list focuses the new word’s Remove, as Add a word turns off', async () => {
    await saveWordList(Array.from({ length: WORD_LIST_MAX - 1 }, (_, i) => ({ term: `word ${i}`, heard: [] })))
    try {
      keys.last = true
      await addFlown(await openForm())
      const els = await settle(cleanup())
      expect(button(els, 'Add a word')!.props.disabled).toBe(true)
      expect(focused.at(-1)?.props['aria-label']).toBe('Remove Flown from the word list')
    } finally {
      await saveWordList([])
    }
  })

  it('a click while the word is saved leaves the focus alone', async () => {
    keys.last = true
    const els = await openForm()
    focused.length = 0
    await addFlown(els)
    keys.last = false
    await settle(cleanup())
    expect(button(await settle(cleanup()), 'Add a word')).toBeDefined()
    expect(focused).toEqual([])
    await saveWordList([])
  })
})
