import { beforeEach, describe, expect, it, vi } from 'vitest'
import type { Project } from '../src/shared/types'
import { button, byTestId, contexts, focused, key, mockReact, render, renderIfChanged, settle, testStore, textOf, unmountAll, useEditorContexts, type El } from './studioHarness'

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

/** The question before a paid run (costConfirm.ts, tested in costConfirm.test.ts): who it was asked about, and its answer. */
const question = vi.hoisted(() => ({ answer: true, asked: [] as { place: string; task: string; count: number }[] }))
vi.mock('../src/renderer/src/ai/costConfirm', async (importOriginal) => ({
  ...(await importOriginal<Record<string, unknown>>()),
  confirmRequest: async (choice: { place: string }, request: { task: string; segments: unknown[] }) => {
    question.asked.push({ place: choice.place, task: request.task, count: request.segments.length })
    return question.answer
  }
}))

const sent: unknown[] = []
const GEMINI = { id: 'g1', kind: 'gemini', label: '', model: 'gemini-x' }
/** The AI providers listAiProviders answers with (one by default), or a promise of them still loading. */
const providers: { list: unknown[] | Promise<unknown[]> } = { list: [GEMINI] }
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
    listAiProviders: async () => providers.list,
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
  requestCaptions: (r: { kind: 'language'; via: 'ai' } | { kind: 'cleanup'; ai: true }) => void
  takeCaptionsRequest: () => unknown
}
await useEditorContexts()
const { createProject } = await import('../src/shared/engine/project')
const { languageName } = await import('../src/shared/captions/captionTracks')
const { WORD_LIST_MAX } = await import('../src/shared/captions/cleanup')
const SETTINGS = '../src/renderer/src/settings/SettingsButton'
const { AI_PROVIDERS_CHANGED_EVENT } = (await import(/* @vite-ignore */ SETTINGS)) as { AI_PROVIDERS_CHANGED_EVENT: string }

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
  providers.list = [GEMINI]
  sent.length = 0
  ids.sent.length = 0
  ids.stopped.length = 0
  ai.wait = null
  ai.fail = false
  question.answer = true
  question.asked.length = 0
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
    // Its cost line holds the click to ask (CostLine.tsx): the run does not ask a second time.
    expect(question.asked).toEqual([])
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

  it('… and Stop of AI on this PC beside Cancel, pressed with the keyboard, focuses Translate again too', async () => {
    keys.last = true
    ai.wait = new Promise(() => undefined)
    let els = await openForm()
    ;(byTestId(els, 'track-translate')!.props.onClick as () => void)()
    els = await settle(languages())
    // Stop (LocalProgress) sits in the running translation's row, beside Cancel; its onStop is Cancel's.
    const cancel = button(els, 'Cancel')!
    const row = els.find((e) => e.props.className === 'row start' && (e.props.children as unknown[]).some?.((c) => (c as El | null)?.props?.onClick === cancel.props.onClick))!
    const stop = { stop: true }
    const rowNode = (row.ref as { current?: { contains: (t: unknown) => boolean } } | undefined)?.current
    if (rowNode) rowNode.contains = (t) => t === stop
    fire('keydown', { key: 'Enter', target: stop })
    ;(cancel.props.onClick as () => void)()
    els = await settle(languages())
    expect(textOf(els.find((e) => e.props.role === 'alert'))).toBe('Could not translate: it was cancelled.')
    expect(focused.at(-1)?.props['data-testid']).toBe('track-translate')
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

  it('says so only while it holds: a translation removed, the status goes and Add a language opens without it', async () => {
    store.state = { ...base(), captionTracks: eight }
    await settle(languages())
    requestCaptions({ kind: 'language', via: 'ai' })
    takeCaptionsRequest()
    let els = await settle(languages())
    const status = (e: El[]): string => textOf(e.find((x) => x.props.role === 'status' && x.type === 'p'))
    expect(status(els)).toBe(FULL)
    ;(els.filter((e) => e.props['data-testid'] === 'track-remove')[0].props.onClick as () => void)()
    els = await settle(languages())
    expect(byTestId(els, 'track-add')!.props.disabled).toBe(false)
    expect(status(els)).toBe('')
    ;(byTestId(els, 'track-add')!.props.onClick as () => void)()
    els = await settle(languages())
    expect(byTestId(els, 'track-translate')).toBeDefined()
    expect(status(els)).toBe('')
  })
})

describe('a request again with Languages open (§2.14)', () => {
  /** Translate captions with AI… from the palette, the Captions tab open. */
  const ask = (): void => {
    requestCaptions({ kind: 'language', via: 'ai' })
    takeCaptionsRequest()
  }
  /** A keystroke in a caption box: a project change, which renders the section. */
  const typed = (): El[] => {
    store.state = { ...store.state, transcript: { ...store.state.transcript!, segments: [{ id: 'c1', start: 0, end: 2, text: 'Make every word count. Now' }] } }
    return render(languages())
  }

  it('no room: the list takes the focus at once, and a later edit keeps its focus', async () => {
    store.state = { ...base(), captionTracks: ['bn', 'hi', 'es', 'fr', 'de', 'pt', 'it', 'ja'].map(track) }
    await settle(languages())
    ask()
    await settle(languages())
    expect(focused.at(-1)?.props['data-testid']).toBe('track-show')
    // The user clicks into a caption, then asks again: the request renders on its own, as React would.
    focused.length = 0
    ask()
    expect(renderIfChanged(languages())).not.toBeNull()
    expect(focused.map((e) => e.props['data-testid'])).toEqual(['track-show'])
    focused.length = 0
    typed()
    expect(focused).toEqual([])
  })

  it('room left, the form open: the language select takes the focus at once, and a later edit keeps its focus', async () => {
    await settle(languages())
    ask()
    await settle(languages())
    expect(focused.at(-1)?.type).toBe('select')
    focused.length = 0
    ask()
    expect(renderIfChanged(languages())).not.toBeNull()
    expect(focused.map((e) => e.type)).toEqual(['select'])
    focused.length = 0
    typed()
    expect(focused).toEqual([])
  })
})

describe('a request with no AI provider (§2.14): no focus waits for one', () => {
  /** A provider added in Settings, the dialog still open over the editor: Settings announces it. */
  const providerAdded = (): void => {
    providers.list = [GEMINI]
    listeners[AI_PROVIDERS_CHANGED_EVENT]?.forEach((fn) => fn({}))
  }
  const named = (e: El | undefined): string => (e ? String(e.props['data-testid'] ?? e.type) : 'nothing')

  it('Translate captions with AI…: the form says to add one and its Add an AI provider takes the focus; a provider added later moves none', async () => {
    providers.list = []
    await settle(languages())
    focused.length = 0
    requestCaptions({ kind: 'language', via: 'ai' })
    takeCaptionsRequest()
    let els = await settle(languages())
    expect(els.some((e) => e.type === 'select')).toBe(false)
    expect(textOf(byTestId(els, 'track-add-provider'))).toBe('Add an AI provider')
    expect(focused.map(named)).toEqual(['track-add-provider'])
    focused.length = 0
    providerAdded()
    els = await settle(languages())
    expect(els.some((e) => e.type === 'select')).toBe(true)
    expect(focused.map(named)).toEqual([])
    expect(sent).toHaveLength(0)
  })

  it('Add a language pressed: the same, the button it replaces gone', async () => {
    providers.list = []
    let els = await settle(languages())
    focused.length = 0
    ;(byTestId(els, 'track-add')!.props.onClick as () => void)()
    els = await settle(languages())
    expect(byTestId(els, 'track-add')).toBeUndefined()
    expect(focused.map(named)).toEqual(['track-add-provider'])
    focused.length = 0
    providerAdded()
    await settle(languages())
    expect(focused.map(named)).toEqual([])
  })

  it('a request while the providers still load takes the focus once they are known: the select, or Add an AI provider when there is none', async () => {
    for (const [list, to] of [
      [[GEMINI], 'select'],
      [[], 'track-add-provider']
    ] as const) {
      unmountAll()
      let loaded!: (v: unknown[]) => void
      providers.list = new Promise<unknown[]>((r) => (loaded = r))
      await settle(languages())
      requestCaptions({ kind: 'language', via: 'ai' })
      takeCaptionsRequest()
      await settle(languages())
      // The form shows the select while the list loads; the focus waits for the list, not longer.
      expect(focused.map(named)).toEqual([])
      loaded([...list])
      await settle(languages())
      expect(focused.map(named)).toEqual([to])
      focused.length = 0
      providerAdded()
      await settle(languages())
      expect(focused.map(named)).toEqual([])
    }
  })

  it('Fix captions with AI: Clean up says to add one first; a provider added later takes that back and moves no focus', async () => {
    providers.list = []
    requestCaptions({ kind: 'cleanup', ai: true })
    takeCaptionsRequest()
    let els = await settle(cleanup())
    const status = (): string => textOf(els.find((e) => e.props.role === 'status'))
    expect(byTestId(els, 'cleanup-ai')).toBeUndefined()
    expect(status()).toBe('To fix spelling with AI, add an AI provider first: the button is in the AI tools section.')
    focused.length = 0
    providerAdded()
    els = await settle(cleanup())
    expect(byTestId(els, 'cleanup-ai')?.props.checked).toBe(true)
    expect(status()).toBe('')
    expect(focused.map(named)).toEqual([])
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

  it('asks the question before a paid run first, as Translate does: Cancel sends nothing, Run translates (smart-tools.md §11.5)', async () => {
    let els = await settle(languages())
    const again = byTestId(els, 'track-retranslate')!
    // Its own sentence says what it sends and where.
    expect(textOf(byId(els, String(again.props['aria-describedby'])))).toMatch(/; sends your captions to Gemini\.$/)
    question.answer = false
    ;(again.props.onClick as () => void)()
    els = await settle(languages())
    expect(question.asked).toEqual([{ place: 'Gemini', task: 'translate', count: 1 }])
    expect(sent).toEqual([])
    expect(store.state.captionTracks?.[0].segments).toEqual([])
    question.answer = true
    ;(byTestId(els, 'track-retranslate')!.props.onClick as () => void)()
    await settle(languages())
    expect(question.asked).toHaveLength(2)
    expect(sent).toHaveLength(1)
    expect(store.state.captionTracks?.[0].segments).toHaveLength(1)
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
