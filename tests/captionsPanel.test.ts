import { beforeEach, describe, expect, it, vi } from 'vitest'
import type { TranscribeProgress } from '../src/shared/api/ai'
import { MAX_CAPTIONS } from '../src/shared/captions/captionData'

/*
 * The Captions tab's Generate section without a DOM: React's hooks are swapped for a few lines
 * that keep each component's state by its place in the tree, so CaptionsPanel and GenerateSection
 * can be called as functions and their elements read; the other sections are left unrendered.
 */

interface Cell {
  value?: unknown
  deps?: readonly unknown[]
  current?: unknown
  cleanup?: (() => void) | void
}
interface El {
  type: unknown
  props: Record<string, unknown>
}

const cells = new Map<string, Cell[]>()
let hooks: { cells: Cell[]; i: number } | null = null
let effects: (() => void)[] = []
let dirty = false
const cell = (): Cell => (hooks!.cells[hooks!.i++] ??= {})
const changed = (a: readonly unknown[] | undefined, b: readonly unknown[] | undefined): boolean => !a || !b || a.length !== b.length || a.some((v, i) => !Object.is(v, b[i]))

function deferred<T>(): { promise: Promise<T>; resolve: (v: T) => void; reject: (err: unknown) => void } {
  let resolve!: (v: T) => void
  let reject!: (err: unknown) => void
  const promise = new Promise<T>((a, b) => {
    resolve = a
    reject = b
  })
  return { promise, resolve, reject }
}

/** Elements that got the focus (refs are given a stand-in element as they are rendered). */
const focused: El[] = []

const runs: ReturnType<typeof deferred<unknown>>[] = []
const OPENAI = { id: 'o', kind: 'openai', label: '', model: 'm', transcriptionModel: 't', maskedKey: '', createdAt: '' }
/** What the main process answers; the speech state rejects by default, as before workstream B's handlers exist. */
const replies: { providers: () => Promise<unknown>; speech: () => Promise<unknown>; download: (id: string) => Promise<void>; confirm: boolean } = {
  providers: () => Promise.resolve([OPENAI]),
  speech: () => Promise.reject(new Error("Error invoking remote method 'speech:state': Error: No handler registered for 'speech:state'")),
  download: () => Promise.resolve(),
  confirm: true
}
const calls: { transcribe: unknown[]; setDefault: string[]; download: string[]; cancelDownload: unknown[]; confirm: string[] } = {
  transcribe: [],
  setDefault: [],
  download: [],
  cancelDownload: [],
  confirm: []
}
/** The job's progress listener (the main process's progress lines go to it). */
let progress: ((p: TranscribeProgress) => void) | null = null
vi.stubGlobal('window', {
  api: {
    listAiProviders: () => replies.providers(),
    getSpeechState: () => replies.speech(),
    onSpeechState: () => () => undefined,
    setDefaultSpeechModel: (id: string) => {
      calls.setDefault.push(id)
      return Promise.resolve()
    },
    downloadSpeechModel: (id: string) => {
      calls.download.push(id)
      return replies.download(id)
    },
    cancelSpeechDownload: (...args: unknown[]) => {
      calls.cancelDownload.push(args)
      return Promise.resolve()
    },
    transcribe: (_id: string, options: unknown) => {
      calls.transcribe.push(options)
      const d = deferred<unknown>()
      runs.push(d)
      return d.promise
    },
    onTranscribeProgress: (l: (p: TranscribeProgress) => void) => {
      progress = l
      return () => {
        if (progress === l) progress = null
      }
    },
    cancelTranscription: () => Promise.resolve()
  },
  confirm: (question: string) => {
    calls.confirm.push(question)
    return replies.confirm
  },
  addEventListener: () => undefined,
  removeEventListener: () => undefined
})
vi.stubGlobal('document', { body: {} })
vi.stubGlobal(
  'MutationObserver',
  class {
    observe(): void {}
    disconnect(): void {}
  }
)

let store: { state: Record<string, unknown>; update: (fn: (p: Record<string, unknown>) => Record<string, unknown>) => void }
const editor = {
  get store() {
    return store
  },
  player: {}
}

vi.doMock('react', async (importOriginal) => ({
  ...(await importOriginal<Record<string, unknown>>()),
  useState: (init: unknown) => {
    const c = cell()
    if (!('value' in c)) c.value = typeof init === 'function' ? (init as () => unknown)() : init
    const set = (v: unknown): void => {
      c.value = typeof v === 'function' ? (v as (x: unknown) => unknown)(c.value) : v
      dirty = true
    }
    return [c.value, set]
  },
  useRef: (init: unknown) => {
    const c = cell()
    if (!('current' in c)) c.current = init
    return c
  },
  useMemo: (fn: () => unknown, deps: unknown[]) => {
    const c = cell()
    if (changed(c.deps, deps)) Object.assign(c, { value: fn(), deps })
    return c.value
  },
  useCallback: (fn: unknown, deps: unknown[]) => {
    const c = cell()
    if (changed(c.deps, deps)) Object.assign(c, { value: fn, deps })
    return c.value
  },
  useEffect: (fn: () => (() => void) | void, deps?: unknown[]) => {
    const c = cell()
    if (!changed(c.deps, deps)) return
    c.deps = deps
    effects.push(() => {
      c.cleanup?.()
      c.cleanup = fn()
    })
  },
  useSyncExternalStore: (_subscribe: unknown, get: () => unknown) => get(),
  // useEditor() is the only context the rendered components read: one object, as a provider gives.
  useContext: () => editor
}))

// Renderer code: imported at run time so the Node typecheck of tests/ does not follow it.
const PANEL = '../src/renderer/src/editor/panels/CaptionsPanel'
const ITEMS = '../src/renderer/src/editor/captionItems'
const SPEECH_STATE = '../src/renderer/src/editor/speechState'
const { CaptionsPanel } = (await import(/* @vite-ignore */ PANEL)) as { CaptionsPanel: (props: unknown) => unknown }
const items = (await import(/* @vite-ignore */ ITEMS)) as { requestCaptions(r: { kind: 'generate' }): void; clearTranscriptionError(): void }

const RENDERED = new Set(['CaptionsPanel', 'GenerateSection', 'LocalQuality', 'LocalAction', 'LocalRunning', 'BanglaOffer', 'Host'])

/** Calls the components in RENDERED (hooks kept by `path`) and lists every other element under them. */
function walk(node: unknown, path: string, out: El[]): void {
  if (Array.isArray(node)) return node.forEach((n, i) => walk(n, `${path}.${i}`, out))
  if (!node || typeof node !== 'object' || !('props' in node)) return
  const el = node as El
  if (typeof el.type === 'function' && RENDERED.has(el.type.name)) {
    if (!cells.has(path)) cells.set(path, [])
    hooks = { cells: cells.get(path)!, i: 0 }
    const child = (el.type as (p: unknown) => unknown)(el.props)
    hooks = null
    return walk(child, `${path}/${el.type.name}`, out)
  }
  // A ref object gets a stand-in element, so effects that focus it are seen.
  const ref = (node as { ref?: { current?: unknown } | null }).ref
  if (ref && typeof ref === 'object' && !ref.current) ref.current = { focus: () => focused.push(el), querySelector: () => null, scrollIntoView: () => undefined }
  out.push(el)
  walk(el.props.children, path, out)
}

/** The tab for the project in the store, rendered until its state and effects settle. */
function render(panel: (props: unknown) => unknown = CaptionsPanel, extra: unknown = null): El[] {
  for (let pass = 0; pass < 20; pass++) {
    dirty = false
    const out: El[] = []
    walk([{ type: panel, props: { project: store.state, selection: null, onSelect: () => undefined, onNotice: () => undefined } }, extra], 'root', out)
    const run = effects
    effects = []
    run.forEach((e) => e())
    if (!dirty) return out
  }
  throw new Error('The tab keeps rendering')
}

const textOf = (node: unknown): string =>
  Array.isArray(node) ? node.map(textOf).join('') : typeof node === 'string' || typeof node === 'number' ? String(node) : node && typeof node === 'object' && 'props' in node ? textOf((node as El).props.children) : ''
const sections = (out: El[]): string[] => out.filter((e) => typeof e.props.title === 'string' && 'children' in e.props).map((e) => e.props.title as string)
const click = (out: El[], label: string): void => {
  const button = out.find((e) => e.type === 'button' && textOf(e.props.children).trim() === label)
  if (!button) throw new Error(`No "${label}" button`)
  ;(button.props.onClick as () => void)()
}
const flush = (): Promise<void> => new Promise((r) => setTimeout(r, 0))

/** More captions than a project keeps: the job ends with a notice. */
const tooMany = { provider: 'openai', model: 'm', createdAt: '', segments: Array.from({ length: MAX_CAPTIONS + 10 }, (_, i) => ({ id: `s${i}`, start: i * 3, end: i * 3 + 2, text: `caption ${i}` })) }
const NOTICE = `A project keeps at most ${MAX_CAPTIONS} captions`

beforeEach(() => {
  // The tab of the test before goes away (its effects cleaned up, so it stops taking requests).
  for (const list of cells.values()) for (const c of list) c.cleanup?.()
  items.clearTranscriptionError()
  cells.clear()
  effects = []
  runs.length = 0
  const state: Record<string, unknown> = { id: 'p1', duration: 100000, clips: [{ id: 'c', start: 0, end: 100000, speed: 1 }], hasAudio: true }
  store = {
    state,
    update(fn) {
      store.state = fn(store.state)
    }
  }
})

describe('CaptionsPanel: after a run the summary shows, with its notice (AI-8)', () => {
  it('Regenerate captions…, then Regenerate', async () => {
    store.state = { ...store.state, transcript: { provider: 'openai', model: 'm', createdAt: '', segments: [{ id: 'a', start: 0, end: 1, text: 'hi' }] } }
    render()
    await flush()
    let out = render()
    expect(sections(out)).toContain('Generate')
    click(out, 'Regenerate captions…')
    out = render()
    expect(sections(out)).toContain('Regenerate captions')
    click(out, 'Regenerate')
    expect(sections(render())).toContain('Generating captions')
    runs[0].resolve(tooMany)
    await flush()
    out = render()
    expect(sections(out)).toContain('Generate')
    expect(sections(out)).not.toContain('Regenerate captions')
    expect(out.some((e) => textOf(e.props.children).startsWith(NOTICE))).toBe(true)
  })

  it('the Generate captions command on a recording without captions', async () => {
    items.requestCaptions({ kind: 'generate' })
    render()
    await flush()
    // The providers are read: the command starts the run.
    expect(sections(render())).toContain('Generating captions')
    runs[0].resolve(tooMany)
    await flush()
    const out = render()
    expect(sections(out)).toContain('Generate')
    expect(out.some((e) => textOf(e.props.children).startsWith(NOTICE))).toBe(true)
  })
})

/* ---------- captions on this PC (docs/design/offline-captions.md §7.1-7.2, §7.6) ---------- */

import type { SpeechModelStatus, SpeechModelView, SpeechState } from '../src/shared/api/speech'
import { SPEECH_MODELS, type SpeechModelId } from '../src/shared/speech/catalog'
import { localErrorMessage } from '../src/shared/speech/errors'

type Status = SpeechModelView['status']
function speechState(over: Partial<SpeechState> & { statuses?: Partial<Record<SpeechModelId, Status>> } = {}): SpeechState {
  const { statuses = {}, ...rest } = over
  return {
    engine: { available: true, build: 'standard', threads: 3 },
    detector: { available: true },
    models: SPEECH_MODELS.map((m) => ({
      id: m.id,
      tier: m.tier,
      name: m.name,
      bytes: m.bytes,
      rtf4: m.rtf4,
      ramMB: m.ramMB,
      wer: m.wer,
      partSeconds: m.partSeconds,
      license: m.license,
      status: statuses[m.id] ?? { state: 'missing' },
      inUse: false,
      allowed: true
    })),
    defaultModel: 'whisper-base',
    disk: { free: 100e9, used: 0 },
    memory: { total: 16 * 2 ** 30, free: 8e9 },
    cores: 4,
    ...rest
  }
}

interface Mods {
  panel: (props: unknown) => unknown
  items: { requestCaptions(r: { kind: 'generate' }): void; clearTranscriptionError(): void }
  speech: { useCaptionsHost(projectId: string, onNotice: (m: string) => void, open: boolean): unknown }
}

/** Fresh modules: the module-level stores (speech state, session choice, intents, remembered choices) start empty. */
async function fresh(): Promise<Mods> {
  vi.resetModules()
  const { CaptionsPanel: panel } = (await import(/* @vite-ignore */ PANEL)) as { CaptionsPanel: Mods['panel'] }
  const items = (await import(/* @vite-ignore */ ITEMS)) as Mods['items']
  const speech = (await import(/* @vite-ignore */ SPEECH_STATE)) as Mods['speech']
  return { panel, items, speech }
}

const byTest = (out: El[], id: string): El[] => out.filter((e) => e.props['data-testid'] === id)
const local = (out: El[]): El | undefined => byTest(out, 'local-captions')[0]
const buttons = (out: El[]): string[] => out.filter((e) => e.type === 'button').map((e) => textOf(e.props.children).trim())
const has = (out: El[], text: string): boolean => out.some((e) => typeof e.type === 'string' && textOf(e.props.children).includes(text))
const chips = (out: El[]): El[] => out.filter((e) => e.props.role === 'radio')

describe('CaptionsPanel: captions on this PC', () => {
  let m: Mods
  beforeEach(async () => {
    m = await fresh()
    calls.transcribe.length = 0
    calls.setDefault.length = 0
    calls.download.length = 0
    calls.cancelDownload.length = 0
    calls.confirm.length = 0
    focused.length = 0
    replies.providers = () => Promise.resolve([OPENAI])
    replies.download = () => Promise.resolve()
    replies.confirm = true
    store.state = { ...store.state, duration: 1200, clips: [{ id: 'c', start: 0, end: 1200, speed: 1 }] }
  })
  const show = async (): Promise<El[]> => {
    render(m.panel)
    await flush()
    await flush()
    return render(m.panel)
  }

  it('shows only "Checking this PC…" while either read is pending: no key block flashes', async () => {
    replies.providers = () => Promise.resolve([])
    replies.speech = () => new Promise(() => undefined)
    let out = await show()
    expect(local(out)?.props['data-state']).toBe('checking')
    expect(has(out, 'Checking this PC…')).toBe(true)
    expect(buttons(out).some((b) => b.includes('Add an AI provider'))).toBe(false)
    m = await fresh()
    replies.providers = () => new Promise(() => undefined)
    replies.speech = () => Promise.resolve(speechState())
    out = await show()
    expect(local(out)?.props['data-state']).toBe('checking')
  })

  it('a failed read of the speech state is unavailable: the tab is exactly as before (keys only)', async () => {
    replies.providers = () => Promise.resolve([])
    replies.speech = () => Promise.reject(new Error('No handler registered'))
    const warn = vi.spyOn(console, 'warn').mockImplementation(() => undefined)
    const out = await show()
    expect(warn).toHaveBeenCalled()
    warn.mockRestore()
    expect(local(out)).toBeUndefined()
    expect(buttons(out).some((b) => b.includes('Add an AI provider'))).toBe(true)
  })

  it('lists "On this PC (free, private)" first; a key user keeps their provider until they pick it', async () => {
    replies.speech = () => Promise.resolve(speechState())
    const out = await show()
    const select = out.find((e) => e.props['aria-label'] === 'Transcription provider')!
    const options = out.filter((e) => e.type === 'option' && ['local', 'o'].includes(e.props.value as string))
    expect(options.map((o) => o.props.value)).toEqual(['local', 'o'])
    expect(textOf(options[0].props.children)).toBe('On this PC (free, private)')
    expect(select.props.value).toBe('o')
    expect(local(out)).toBeUndefined()
  })

  it('the engine unavailable: the option is left out and the hint says why', async () => {
    replies.speech = () => Promise.resolve(speechState({ engine: { available: false, build: null, threads: 1, reason: 'missing' } }))
    const out = await show()
    expect(out.some((e) => e.type === 'option' && e.props.value === 'local')).toBe(false)
    expect(has(out, 'Captions on this PC are not available here: part of Flown is missing; reinstall it to get them back.')).toBe(true)
  })

  it('without keys: one primary download button, one cloud link, no key block; chips choose for the session only', async () => {
    replies.providers = () => Promise.resolve([])
    replies.speech = () => Promise.resolve(speechState())
    let out = await show()
    expect(local(out)?.props['data-state']).toBe('needs-model')
    expect(has(out, 'Captions are made on this PC: free, and nothing is uploaded.')).toBe(true)
    expect(buttons(out).some((b) => b.includes('Add an AI provider'))).toBe(false)
    expect(buttons(out).filter((b) => b === 'Prefer the cloud? Use your own OpenAI or Gemini key…')).toHaveLength(1)
    const primaries = out.filter((e) => e.type === 'button' && String(e.props.className).includes('primary'))
    expect(primaries.map((b) => textOf(b.props.children).trim())).toEqual(['Download 60 MB and make captions'])
    expect(primaries[0].props['aria-label']).toBe('Download Standard (Whisper base), 60 megabytes, and make captions')
    expect(has(out, 'Flown first downloads the speech model for Standard (Whisper base) once (60 MB, from Hugging Face) and checks it before use. Then this 20 min recording takes about 3 min.')).toBe(true)
    expect(chips(out).map((c) => textOf(c.props.children))).toEqual(['Fast · 44 MB', 'Standard · 60 MB', 'Accurate · 190 MB'])
    expect(chips(out).map((c) => c.props['aria-label'])).toEqual(['Fast, 44 megabyte download', 'Standard, 60 megabyte download', 'Accurate, 190 megabyte download'])
    expect(textOf(byTest(out, 'local-estimate')[0].props.children)).toBe('60 MB download · about 3 min for this recording')
    ;(chips(out)[0].props.onClick as () => void)()
    out = render(m.panel)
    expect(buttons(out)).toContain('Download 44 MB and make captions')
    expect(textOf(byTest(out, 'local-estimate')[0].props.children)).toBe('44 MB download · about 1½ min for this recording')
    expect(calls.setDefault).toEqual([])
    expect(calls.download).toEqual([])
  })

  it('chips read "Downloaded"; Most accurate only once downloaded and allowed here', async () => {
    replies.providers = () => Promise.resolve([])
    replies.speech = () => Promise.resolve(speechState({ statuses: { 'whisper-base': { state: 'installed' }, 'whisper-turbo': { state: 'installed' } } }))
    const out = await show()
    expect(chips(out).map((c) => textOf(c.props.children))).toEqual(['Fast · 44 MB', 'Standard · Downloaded', 'Accurate · 190 MB', 'Most accurate (slow) · Downloaded'])
    expect(chips(out)[1].props['aria-label']).toBe('Standard, downloaded')
    expect(local(out)?.props['data-state']).toBe('ready')
    expect(has(out, 'Runs on this PC: nothing is uploaded and it costs nothing.')).toBe(true)
  })

  it('a chosen Most accurate that is removed or damaged falls back to a listed chip: one is always checked (UI-10)', async () => {
    replies.providers = () => Promise.resolve([])
    replies.speech = () => Promise.resolve(speechState({ statuses: { 'whisper-base': { state: 'installed' }, 'whisper-turbo': { state: 'installed' } } }))
    let out = await show()
    ;(chips(out)[3].props.onClick as () => void)()
    out = render(m.panel)
    expect(local(out)?.props['data-model']).toBe('whisper-turbo')
    // Settings removes turbo (the main process moves the default to an installed model).
    replies.speech = () => Promise.resolve(speechState({ statuses: { 'whisper-base': { state: 'installed' } } }))
    ;(m.speech as unknown as { loadSpeechState(force: boolean): void }).loadSpeechState(true)
    await flush()
    out = render(m.panel)
    const checked = (o: El[]): El[] => chips(o).filter((c) => c.props['aria-checked'])
    expect(checked(out).map((c) => [c.props['data-model'], c.props.tabIndex])).toEqual([['whisper-base', 0]])
    expect(local(out)?.props['data-model']).toBe('whisper-base')
    expect(local(out)?.props['data-state']).toBe('ready')
    expect(buttons(out).some((b) => b.startsWith('Download'))).toBe(false)
  })

  it('a chosen Most accurate whose Download again fails or stops keeps its error or Continue card', async () => {
    replies.providers = () => Promise.resolve([])
    replies.speech = () => Promise.resolve(speechState({ statuses: { 'whisper-base': { state: 'installed' }, 'whisper-turbo': { state: 'installed' } } }))
    let out = await show()
    ;(chips(out)[3].props.onClick as () => void)()
    const reload = async (turbo: SpeechModelStatus): Promise<El[]> => {
      replies.speech = () => Promise.resolve(speechState({ statuses: { 'whisper-base': { state: 'installed' }, 'whisper-turbo': turbo } }))
      ;(m.speech as unknown as { loadSpeechState(force: boolean): void }).loadSpeechState(true)
      await flush()
      return render(m.panel)
    }
    const total = 574_041_195
    out = await reload({ state: 'failed', received: 20_000_000, total, error: 'network', message: 'reset' })
    expect([local(out)?.props['data-model'], local(out)?.props['data-state']]).toEqual(['whisper-turbo', 'download-failed'])
    expect(chips(out).filter((c) => c.props['aria-checked']).map((c) => c.props['data-model'])).toEqual(['whisper-turbo'])
    out = await reload({ state: 'stopped', received: 20_000_000, total })
    expect([local(out)?.props['data-model'], local(out)?.props['data-state']]).toEqual(['whisper-turbo', 'stopped'])
  })

  it('a damaged Most accurate as the default falls back the same way (UI-10)', async () => {
    replies.providers = () => Promise.resolve([])
    replies.speech = () => Promise.resolve(speechState({ defaultModel: 'whisper-turbo', statuses: { 'whisper-base': { state: 'installed' }, 'whisper-turbo': { state: 'damaged' } } }))
    const out = await show()
    expect(chips(out).filter((c) => c.props['aria-checked']).map((c) => c.props['data-model'])).toEqual(['whisper-base'])
    expect(local(out)?.props['data-state']).toBe('ready')
    expect(buttons(out).some((b) => b.startsWith('Download'))).toBe(false)
  })

  it('needs-model with another model downloaded offers "Make them now with …", which makes captions with it', async () => {
    replies.providers = () => Promise.resolve([])
    replies.speech = () => Promise.resolve(speechState({ defaultModel: 'whisper-tiny', statuses: { 'whisper-tiny': { state: 'installed' } } }))
    let out = await show()
    expect(local(out)?.props['data-state']).toBe('ready')
    ;(chips(out)[2].props.onClick as () => void)()
    out = render(m.panel)
    expect(local(out)?.props['data-state']).toBe('needs-model')
    expect(buttons(out)).toContain('Make them now with Fast (downloaded)')
    click(out, 'Make them now with Fast (downloaded)')
    expect(calls.transcribe).toEqual([{ providerId: 'local', model: 'whisper-tiny', source: 'auto' }])
    expect(calls.download).toEqual([])
    // It selected that chip (UI-7): Regenerate reopens on Fast, ready, not on Accurate's download.
    runs[runs.length - 1].resolve({ provider: 'local', model: 'whisper-tiny', language: 'en', createdAt: 'x', segments: [{ id: 't1', start: 1, end: 2, text: 'hi' }] })
    await flush()
    out = render(m.panel)
    click(out, 'Regenerate captions…')
    out = render(m.panel)
    expect(chips(out).find((c) => c.props['aria-checked'])?.props['data-model']).toBe('whisper-tiny')
    expect(local(out)?.props['data-state']).toBe('ready')
    store.state = { ...store.state, transcript: undefined }
  })

  it('"Make them now with …" leaves the chip alone when the user keeps the captions (UI-7)', async () => {
    replies.providers = () => Promise.resolve([])
    replies.speech = () => Promise.resolve(speechState({ defaultModel: 'whisper-tiny', statuses: { 'whisper-tiny': { state: 'installed' } } }))
    store.state = { ...store.state, transcript: { provider: 'openai', model: 'm', createdAt: '', segments: [{ id: 'a', start: 0, end: 1, text: 'hi' }] } }
    let out = await show()
    click(out, 'Regenerate captions…')
    out = render(m.panel)
    ;(chips(out)[2].props.onClick as () => void)()
    out = render(m.panel)
    replies.confirm = false
    click(out, 'Make them now with Fast (downloaded)')
    out = render(m.panel)
    expect(calls.transcribe).toEqual([])
    expect(chips(out).find((c) => c.props['aria-checked'])?.props['data-model']).toBe('whisper-small')
    store.state = { ...store.state, transcript: undefined }
  })

  it('arrow keys on the Quality chips choose a chip and go no further: the playhead does not step (UI-5)', async () => {
    replies.providers = () => Promise.resolve([])
    replies.speech = () => Promise.resolve(speechState())
    let out = await show()
    const group = out.find((e) => e.props.role === 'radiogroup')!
    const stopped: string[] = []
    ;(group.props.onKeyDown as (e: unknown) => void)({ key: 'ArrowRight', preventDefault: () => stopped.push('default'), stopPropagation: () => stopped.push('propagation') })
    // The editor's window keydown handler steps the playhead on Left and Right: the event must not reach it.
    expect(stopped).toEqual(['default', 'propagation'])
    out = render(m.panel)
    expect(chips(out).find((c) => c.props['aria-checked'])?.props['data-model']).toBe('whisper-small')
  })

  it('the compatible build and an estimate longer than the recording each get a line', async () => {
    replies.providers = () => Promise.resolve([])
    replies.speech = () => Promise.resolve(speechState({ engine: { available: true, build: 'compatible', threads: 3 } }))
    let out = await show()
    expect(has(out, "This PC's processor runs the speech engine in a slower mode, so captions take longer. Fast is suggested.")).toBe(true)
    expect(has(out, 'Slower than playing the recording')).toBe(false)
    ;(chips(out)[2].props.onClick as () => void)()
    out = render(m.panel)
    expect(has(out, 'Slower than playing the recording: about 42 min for this one.')).toBe(true)
  })

  it('a recording without sound offers no download', async () => {
    replies.providers = () => Promise.resolve([])
    replies.speech = () => Promise.resolve(speechState())
    store.state = { ...store.state, hasAudio: false }
    const out = await show()
    expect(local(out)?.props['data-state']).toBe('no-sound')
    expect(buttons(out).some((b) => b.startsWith('Download'))).toBe(false)
    store.state = { ...store.state, hasAudio: true }
  })

  it('the Generate captions command waits for both reads, then focuses the download button and starts nothing', async () => {
    replies.providers = () => Promise.resolve([])
    const speech = deferred<unknown>()
    replies.speech = () => speech.promise
    m.items.requestCaptions({ kind: 'generate' })
    let out = await show()
    expect(local(out)?.props['data-state']).toBe('checking')
    speech.resolve(speechState())
    await flush()
    out = render(m.panel)
    expect(local(out)?.props['data-state']).toBe('needs-model')
    expect(focused.map((e) => e.props['data-testid'])).toContain('local-download')
    expect(calls.download).toEqual([])
    expect(calls.transcribe).toEqual([])
  })

  it('the command starts at once when the chosen quality is downloaded', async () => {
    replies.providers = () => Promise.resolve([])
    replies.speech = () => Promise.resolve(speechState({ statuses: { 'whisper-base': { state: 'installed' } } }))
    m.items.requestCaptions({ kind: 'generate' })
    const out = await show()
    expect(calls.transcribe).toEqual([{ providerId: 'local', model: 'whisper-base', source: 'auto' }])
    expect(local(out)?.props['data-state']).toBe('running')
  })

  it.each([
    ['damaged', localErrorMessage('damaged', { model: 'whisper-base' }), 'Download again (60 MB)'],
    ['memory', localErrorMessage('memory', { model: 'whisper-base' }), 'Use Fast'],
    ['crashed', localErrorMessage('crashed', { part: 2, parts: 3 }), 'Generate captions again'],
    ['stalled', localErrorMessage('stalled'), 'Generate captions again'],
    ['protocol', localErrorMessage('protocol'), null],
    ['other', 'No speech was found in this recording', null]
  ])('a local error (%s) offers the button localErrorCode chooses', async (_code, message, button) => {
    replies.providers = () => Promise.resolve([])
    replies.speech = () => Promise.resolve(speechState({ statuses: { 'whisper-base': { state: 'installed' } } }))
    let out = await show()
    click(out, 'Generate captions')
    runs[runs.length - 1].reject(new Error(`Error invoking remote method 'ai:transcribe': Error: ${message}`))
    await flush()
    out = render(m.panel)
    expect(local(out)?.props['data-state']).toBe('error')
    expect(has(out, `Captions could not be made: ${message}`)).toBe(true)
    const offered = buttons(out).filter((b) => b !== 'Dismiss' && !b.includes('·') && b !== 'Manage speech models…')
    expect(offered).toEqual(button ? [button] : [])
    if (button === 'Download again (60 MB)') {
      click(out, button)
      expect(calls.download).toEqual(['whisper-base'])
    }
    if (button === 'Use Fast') {
      click(out, button)
      out = render(m.panel)
      expect(chips(out).find((c) => c.props['aria-checked'])?.props['data-model']).toBe('whisper-tiny')
    }
  })

  it('a download that failed for lack of space: Check again while it is short, then Try again downloads (UI-1)', async () => {
    replies.providers = () => Promise.resolve([])
    const failed: Status = { state: 'failed', received: 0, total: 60e6, error: 'disk', message: '' }
    replies.speech = () => Promise.resolve(speechState({ statuses: { 'whisper-base': failed }, disk: { free: 10e6, used: 0 } }))
    let out = await show()
    expect(local(out)?.props['data-state']).toBe('download-failed')
    expect(has(out, 'Not enough free space: the model needs 60 MB and the disk has 10 MB free.')).toBe(true)
    // The main process keeps the failure until a new download starts: once the disk has room, the
    // button that read the state again becomes one that downloads.
    replies.speech = () => Promise.resolve(speechState({ statuses: { 'whisper-base': failed }, disk: { free: 50e9, used: 0 } }))
    click(out, 'Check again')
    await flush()
    out = render(m.panel)
    expect(has(out, 'There was not enough free space: the model needs 60 MB. The disk now has 50 GB free.')).toBe(true)
    expect(buttons(out)).not.toContain('Check again')
    click(out, 'Try again')
    expect(calls.download).toEqual(['whisper-base'])
  })

  it('"N of M parts are kept" only for the tier and language whose parts were kept (UI-9)', async () => {
    replies.providers = () => Promise.resolve([])
    replies.speech = () => Promise.resolve(speechState({ statuses: { 'whisper-base': { state: 'installed' }, 'whisper-tiny': { state: 'installed' } } }))
    let out = await show()
    click(out, 'Generate captions')
    progress!({ projectId: 'p1', phase: 'transcribing', done: 3, total: 6, fraction: 0.55 })
    out = render(m.panel)
    expect(local(out)?.props['data-state']).toBe('running')
    click(out, 'Cancel')
    await flush()
    out = render(m.panel)
    const KEPT = 'Stopped. 3 of 6 parts are kept: Generate captions continues from there.'
    expect(local(out)?.props['data-state']).toBe('cancelled')
    expect(has(out, KEPT)).toBe(true)
    // The parts are cached for Standard and the language asked for: another tier starts from scratch.
    ;(chips(out)[0].props.onClick as () => void)()
    out = render(m.panel)
    expect(local(out)?.props['data-state']).toBe('ready')
    expect(has(out, KEPT)).toBe(false)
    ;(chips(out)[1].props.onClick as () => void)()
    out = render(m.panel)
    expect(local(out)?.props['data-state']).toBe('cancelled')
    // So does another spoken language.
    const language = out.find((e) => e.props['aria-label'] === 'Spoken language')!
    ;(language.props.onChange as (e: unknown) => void)({ target: { value: 'de' } })
    out = render(m.panel)
    expect(local(out)?.props['data-state']).toBe('ready')
    expect(has(out, KEPT)).toBe(false)
  })

  it('a resumed job counts its time left from the last part taken from the earlier run (UI-2)', async () => {
    replies.providers = () => Promise.resolve([])
    replies.speech = () => Promise.resolve(speechState({ statuses: { 'whisper-base': { state: 'installed' } } }))
    store.state = { ...store.state, duration: 3600, clips: [{ id: 'c', start: 0, end: 3600, speed: 1 }] }
    let out = await show()
    let clock = 1_000_000
    const now = vi.spyOn(Date, 'now').mockImplementation(() => clock)
    try {
      click(out, 'Generate captions')
      const line = (seconds: number, p: Partial<TranscribeProgress>): void => {
        clock = 1_000_000 + seconds * 1000
        progress!({ projectId: 'p1', phase: 'transcribing', done: 0, total: 6, ...p })
        out = render(m.panel)
      }
      // Six parts of 600 s; the first three come from the cache, each within a fraction of a second.
      line(0, { phase: 'loading', fraction: 0 })
      line(0.5, { done: 0, fraction: 1 / 6, resumed: 1 })
      line(0.7, { done: 1, fraction: 1 / 6, resumed: 1 })
      line(0.8, { done: 1, fraction: 2 / 6, resumed: 2 })
      line(1.0, { done: 2, fraction: 2 / 6, resumed: 2 })
      line(1.1, { done: 2, fraction: 3 / 6, resumed: 3 })
      line(1.3, { done: 3, fraction: 3 / 6, resumed: 3 })
      expect(has(out, 'Continuing: 3 of 6 parts were already done.')).toBe(true)
      // Then this PC makes each part in 240 s: after 60 s, 720 - 60 = 660 s are left (11 min; the
      // smoothed estimate rounds up to whole minutes).
      for (let k = 1; k <= 3; k++) line(1.3 + 20 * k, { done: 3, fraction: 3 / 6 + ((20 * k) / 240) * (1 / 6), resumed: 3 })
      const left = out.filter((e) => e.type === 'span' && e.props.className === 'hint').map((e) => textOf(e.props.children))
      expect(left).toHaveLength(1)
      expect(left[0]).toMatch(/^about 1[12] min left$/)
    } finally {
      now.mockRestore()
    }
  })

  it('no-model goes back to the consent card', async () => {
    replies.providers = () => Promise.resolve([])
    replies.speech = () => Promise.resolve(speechState({ statuses: { 'whisper-base': { state: 'installed' } } }))
    let out = await show()
    click(out, 'Generate captions')
    runs[runs.length - 1].reject(new Error(localErrorMessage('no-model', { model: 'whisper-base' })))
    await flush()
    // The main process says the model is not installed after all.
    replies.speech = () => Promise.resolve(speechState())
    ;(m.speech as unknown as { loadSpeechState(force: boolean): void }).loadSpeechState(true)
    await flush()
    out = render(m.panel)
    expect(local(out)?.props['data-state']).toBe('needs-model')
  })

  it('a cloud error offers "Use On this PC", which switches without downloading', async () => {
    replies.speech = () => Promise.resolve(speechState())
    let out = await show()
    click(out, 'Generate captions')
    runs[runs.length - 1].reject(new Error('The provider refused the key.'))
    await flush()
    out = render(m.panel)
    expect(has(out, 'Or make them on this PC: free, and nothing is uploaded.')).toBe(true)
    click(out, 'Use On this PC')
    out = render(m.panel)
    expect(local(out)?.props['data-state']).toBe('needs-model')
    expect(calls.download).toEqual([])
  })

  it('the summary of local captions: "Not English?" only after a detection in this session', async () => {
    replies.providers = () => Promise.resolve([])
    replies.speech = () => Promise.resolve(speechState({ statuses: { 'whisper-base': { state: 'installed' } } }))
    const made = { provider: 'local', model: 'whisper-base', language: 'en', createdAt: '2026-10-27T10:00:00.000Z', segments: [{ id: 't1', start: 1, end: 2, text: 'hello there' }] }
    store.state = { ...store.state, transcript: made }
    let out = await show()
    expect(has(out, '1 caption made on this PC with Whisper base (English).')).toBe(true)
    expect(buttons(out)).not.toContain('Not English?')
    click(out, 'Regenerate captions…')
    out = render(m.panel)
    click(out, 'Regenerate')
    runs[runs.length - 1].resolve({ ...made, createdAt: '2026-10-27T11:00:00.000Z' })
    await flush()
    out = render(m.panel)
    expect(out.some((e) => /^1 caption made on this PC with Whisper base \(English, detected\) in \d+ s\. Nothing was uploaded\./.test(textOf(e.props.children)))).toBe(true)
    expect(buttons(out)).toContain('Not English?')
    store.state = { ...store.state, transcript: undefined }
  })

  /** The editor of `projectId` (Inspector registers it): captions may start for it. */
  const host = (projectId: string): El => {
    const Host = (props: { projectId: string }): null => {
      m.speech.useCaptionsHost(props.projectId, () => undefined, true)
      return null
    }
    return { type: Host, props: { projectId } }
  }
  const closeEditor = (): void => {
    for (const [path, list] of cells) if (path.startsWith('root.1')) for (const c of list) c.cleanup?.()
  }

  it('download, then captions: the model becomes the default and captions start for this open editor', async () => {
    replies.providers = () => Promise.resolve([])
    replies.speech = () => Promise.resolve(speechState())
    const dl = deferred<void>()
    replies.download = () => dl.promise
    render(m.panel, host('p1'))
    await flush()
    let out = render(m.panel, host('p1'))
    click(out, 'Download 60 MB and make captions')
    expect(calls.download).toEqual(['whisper-base'])
    dl.resolve()
    await flush()
    await flush()
    out = render(m.panel, host('p1'))
    expect(calls.setDefault).toEqual(['whisper-base'])
    expect(calls.transcribe).toEqual([{ providerId: 'local', model: 'whisper-base', source: 'auto' }])
  })

  it('download, then captions asks before replacing captions, like every other Regenerate (UI-8)', async () => {
    replies.providers = () => Promise.resolve([])
    replies.speech = () => Promise.resolve(speechState({ statuses: { 'whisper-base': { state: 'installed' } } }))
    store.state = { ...store.state, transcript: { provider: 'local', model: 'whisper-base', createdAt: '', segments: [{ id: 'a', start: 0, end: 1, text: 'hi' }] } }
    let out = await show()
    click(out, 'Regenerate captions…')
    out = render(m.panel)
    ;(chips(out)[2].props.onClick as () => void)()
    out = render(m.panel)
    replies.confirm = false
    click(out, 'Download 190 MB and make captions')
    expect(calls.confirm).toHaveLength(1)
    expect(calls.download).toEqual([])
    replies.confirm = true
    click(out, 'Download 190 MB and make captions')
    expect(calls.confirm).toHaveLength(2)
    expect(calls.download).toEqual(['whisper-small'])
    store.state = { ...store.state, transcript: undefined }
  })

  it('while one model downloads, another tier cannot be downloaded: the first one still makes captions (UI-3)', async () => {
    replies.providers = () => Promise.resolve([])
    replies.speech = () => Promise.resolve(speechState())
    const dl = deferred<void>()
    replies.download = () => dl.promise
    render(m.panel, host('p1'))
    await flush()
    let out = render(m.panel, host('p1'))
    click(out, 'Download 60 MB and make captions')
    // The main process says it is downloading; the user picks Fast.
    replies.speech = () => Promise.resolve(speechState({ statuses: { 'whisper-base': { state: 'downloading', received: 20e6, total: 60e6, bytesPerSecond: 0 } } }))
    ;(m.speech as unknown as { loadSpeechState(force: boolean): void }).loadSpeechState(true)
    await flush()
    out = render(m.panel, host('p1'))
    ;(chips(out)[0].props.onClick as () => void)()
    out = render(m.panel, host('p1'))
    const button = byTest(out, 'local-download')[0]
    expect(button.props['aria-disabled']).toBe('true')
    expect(button.props['aria-describedby']).toBe('local-download-why')
    const why = out.find((e) => e.props.id === 'local-download-why')
    expect(textOf(why?.props.children)).toBe('Standard (Whisper base) is downloading, and one speech model downloads at a time: download Fast once it is done.')
    click(out, 'Download 44 MB and make captions')
    expect(calls.download).toEqual(['whisper-base'])
    // Standard's "then make captions" still stands.
    dl.resolve()
    await flush()
    await flush()
    expect(calls.transcribe).toEqual([{ providerId: 'local', model: 'whisper-base', source: 'auto' }])
  })

  it('download, then captions keeps the pending intent when another model is downloading (UI-3)', async () => {
    const speech = m.speech as unknown as {
      loadSpeechState(force: boolean): void
      downloadThenCaptions(projectId: string, model: string, options: unknown): Promise<void>
      captionsIntent(projectId: string): { model: string } | null
    }
    replies.speech = () => Promise.resolve(speechState())
    speech.loadSpeechState(true)
    await flush()
    replies.download = () => new Promise(() => undefined)
    void speech.downloadThenCaptions('p1', 'whisper-base', { providerId: 'local' })
    replies.speech = () => Promise.resolve(speechState({ statuses: { 'whisper-base': { state: 'downloading', received: 0, total: 60e6, bytesPerSecond: 0 } } }))
    speech.loadSpeechState(true)
    await flush()
    // The main process would refuse it: the intent of the running download is not replaced.
    const warn = vi.spyOn(console, 'warn').mockImplementation(() => undefined)
    void speech.downloadThenCaptions('p1', 'whisper-tiny', { providerId: 'local' })
    await flush()
    warn.mockRestore()
    expect(calls.download).toEqual(['whisper-base'])
    expect(speech.captionsIntent('p1')?.model).toBe('whisper-base')
  })

  it('download, then captions: nothing starts once the editor closed', async () => {
    replies.providers = () => Promise.resolve([])
    replies.speech = () => Promise.resolve(speechState())
    const dl = deferred<void>()
    replies.download = () => dl.promise
    render(m.panel, host('p1'))
    await flush()
    const out = render(m.panel, host('p1'))
    click(out, 'Download 60 MB and make captions')
    closeEditor()
    dl.resolve()
    await flush()
    await flush()
    expect(calls.setDefault).toEqual(['whisper-base'])
    expect(calls.transcribe).toEqual([])
  })

  it('download, then captions: never for another project', async () => {
    replies.providers = () => Promise.resolve([])
    replies.speech = () => Promise.resolve(speechState())
    const dl = deferred<void>()
    replies.download = () => dl.promise
    render(m.panel, host('p2'))
    await flush()
    const out = render(m.panel, host('p2'))
    click(out, 'Download 60 MB and make captions')
    dl.resolve()
    await flush()
    await flush()
    expect(calls.transcribe).toEqual([])
  })
})

/* ---------- the Bangla model (docs/design/offline-captions.md §14.4) ---------- */

describe('CaptionsPanel: the Bangla model', () => {
  let m: Mods
  beforeEach(async () => {
    m = await fresh()
    calls.transcribe.length = 0
    calls.setDefault.length = 0
    calls.download.length = 0
    calls.confirm.length = 0
    replies.providers = () => Promise.resolve([])
    replies.download = () => Promise.resolve()
    replies.confirm = true
    store.state = { ...store.state, transcript: undefined, duration: 1200, clips: [{ id: 'c', start: 0, end: 1200, speed: 1 }] }
  })
  const show = async (): Promise<El[]> => {
    render(m.panel)
    await flush()
    await flush()
    return render(m.panel)
  }
  const speak = (out: El[], code: string): El[] => {
    const select = out.find((e) => e.props['aria-label'] === 'Spoken language')!
    ;(select.props.onChange as (e: { target: { value: string } }) => void)({ target: { value: code } })
    return render(m.panel)
  }
  const chipTexts = (out: El[]): string[] => chips(out).map((c) => textOf(c.props.children))
  const checked = (out: El[]): unknown => chips(out).find((c) => c.props['aria-checked'])?.props['data-model']
  const banglaLine = (out: El[]): El | undefined => byTest(out, 'bangla-hint')[0]
  const BN = 'whisper-bn-medium'

  it('Bengali: the Bangla chip, chosen, and the recommendation with why, offline and its size; other languages never see it', async () => {
    replies.speech = () => Promise.resolve(speechState({ statuses: { 'whisper-base': { state: 'installed' } } }))
    let out = await show()
    expect(chipTexts(out)).toEqual(['Fast · 44 MB', 'Standard · Downloaded', 'Accurate · 190 MB'])
    expect(local(out)?.props['data-state']).toBe('ready')
    out = speak(out, 'bn')
    expect(chipTexts(out)).toEqual(['Fast · 44 MB', 'Standard · Downloaded', 'Accurate · 190 MB', 'Bangla · 539 MB'])
    expect(checked(out)).toBe(BN)
    expect(local(out)?.props['data-state']).toBe('needs-model')
    expect(has(out, 'Make Bangla captions on this PC')).toBe(true)
    expect(has(out, 'Recommended for Bangla: the Bangla model gets about 4 in 5 words right, where the other tiers get most Bangla words wrong.')).toBe(true)
    expect(has(out, 'works offline once downloaded')).toBe(true)
    expect(has(out, 'Then this 20 min recording takes about 29 min.')).toBe(true)
    const primaries = out.filter((e) => e.type === 'button' && String(e.props.className).includes('primary'))
    expect(primaries.map((b) => textOf(b.props.children).trim())).toEqual(['Download Bangla model (539 MB) and make captions'])
    expect(primaries[0].props['aria-label']).toBe('Download Bangla (Bengali.AI Whisper medium), 539 megabytes, and make captions')
    // The downloaded general model is still offered, as for every tier.
    expect(buttons(out)).toContain('Make them now with Standard (downloaded)')
    expect(has(out, 'Bengali.AI Whisper medium, Apache-2.0 licence · huggingface.co/winshades/bengaliai-whisper-medium-ggml')).toBe(true)
    // The general "Smaller models…" line is replaced by the Bangla model's own.
    expect(has(out, 'Smaller models make more mistakes')).toBe(false)
    for (const other of ['en', 'hi', '']) {
      out = speak(out, other)
      expect(chipTexts(out)).not.toContain('Bangla · 539 MB')
      expect(checked(out)).toBe('whisper-base')
      expect(banglaLine(out)).toBeUndefined()
    }
    expect(calls.download).toEqual([])
  })

  it('downloads it after the click, never makes it the default, and makes captions in Bangla', async () => {
    replies.speech = () => Promise.resolve(speechState())
    const dl = deferred<void>()
    replies.download = () => dl.promise
    // The open editor (captions start only for it), as the badge's host registers it.
    const Host = (props: { projectId: string }): null => {
      m.speech.useCaptionsHost(props.projectId, () => undefined, true)
      return null
    }
    const host = { type: Host, props: { projectId: 'p1' } }
    render(m.panel, host)
    await flush()
    speak(render(m.panel, host), 'bn')
    let out = render(m.panel, host)
    click(out, 'Download Bangla model (539 MB) and make captions')
    expect(calls.download).toEqual([BN])
    dl.resolve()
    await flush()
    await flush()
    expect(calls.setDefault).toEqual([])
    expect(calls.transcribe).toEqual([{ providerId: 'local', model: BN, source: 'auto', language: 'bn' }])
    out = render(m.panel, host)
    expect(local(out)?.props['data-state']).toBe('running')
  })

  it('Bengali keeps its own chip choice: another chip says to choose Bangla; other languages keep theirs', async () => {
    replies.speech = () => Promise.resolve(speechState({ statuses: { 'whisper-base': { state: 'installed' }, [BN]: { state: 'installed' } } }))
    let out = speak(await show(), 'bn')
    expect(checked(out)).toBe(BN)
    expect(local(out)?.props['data-state']).toBe('ready')
    expect(chipTexts(out)).toContain('Bangla · Downloaded')
    expect(banglaLine(out)).toBeUndefined()
    // Standard for Bengali: the hint, and the choice is Bengali's only.
    ;(chips(out).find((c) => c.props['data-model'] === 'whisper-base')!.props.onClick as () => void)()
    out = render(m.panel)
    expect(checked(out)).toBe('whisper-base')
    expect(banglaLine(out)?.props['data-kind']).toBe('choose')
    expect(textOf(banglaLine(out)!.props.children)).toBe('For Bangla, choose Bangla: it makes far fewer mistakes.')
    out = speak(out, 'en')
    ;(chips(out).find((c) => c.props['data-model'] === 'whisper-tiny')!.props.onClick as () => void)()
    out = render(m.panel)
    expect(checked(out)).toBe('whisper-tiny')
    out = speak(out, 'bn')
    expect(checked(out)).toBe('whisper-base')
    out = speak(out, 'en')
    expect(checked(out)).toBe('whisper-tiny')
    expect(calls.setDefault).toEqual([])
  })

  it('Bengali where the Bangla model is not allowed: no chip, the reason, and the general lines as before', async () => {
    const reason = 'Needs about 1.3 GB of memory and a PC with 8 GB in all; this one has 4 GB.'
    replies.speech = () =>
      Promise.resolve({ ...speechState(), models: speechState().models.map((v) => (v.id === BN ? { ...v, allowed: false, reason } : v)) })
    const out = speak(await show(), 'bn')
    expect(chipTexts(out)).toEqual(['Fast · 44 MB', 'Standard · 60 MB', 'Accurate · 190 MB'])
    expect(checked(out)).toBe('whisper-base')
    expect(banglaLine(out)?.props['data-kind']).toBe('blocked')
    expect(textOf(banglaLine(out)!.props.children)).toBe(`The Bangla model is not offered on this PC: ${reason}`)
    expect(has(out, 'Smaller models make more mistakes in languages other than English. If accuracy matters, choose Accurate.')).toBe(true)
  })

  it('Detect automatically with the Bangla model downloaded: "Speaking Bangla?" sets Bengali in one click', async () => {
    replies.speech = () => Promise.resolve(speechState({ statuses: { 'whisper-base': { state: 'installed' }, [BN]: { state: 'installed' } } }))
    let out = await show()
    expect(checked(out)).toBe('whisper-base')
    expect(banglaLine(out)?.props['data-kind']).toBe('detect')
    expect(textOf(banglaLine(out)!.props.children)).toContain('Speaking Bangla? Choose Bengali to use the Bangla model.')
    click(out, 'Choose Bengali')
    out = render(m.panel)
    expect(out.find((e) => e.props['aria-label'] === 'Spoken language')!.props.value).toBe('bn')
    expect(checked(out)).toBe(BN)
    click(out, 'Generate captions')
    expect(calls.transcribe).toEqual([{ providerId: 'local', model: BN, source: 'auto', language: 'bn' }])
  })

  it('with a key provider and Bengali: the provider stays, with one link to the Bangla model on this PC', async () => {
    replies.providers = () => Promise.resolve([OPENAI])
    replies.speech = () => Promise.resolve(speechState())
    let out = await show()
    expect(byTest(out, 'bangla-key-hint')).toEqual([])
    out = speak(out, 'bn')
    expect(out.find((e) => e.props['aria-label'] === 'Transcription provider')!.props.value).toBe('o')
    expect(local(out)).toBeUndefined()
    expect(textOf(byTest(out, 'bangla-key-hint')[0].props.children)).toContain('For Bangla, the Bangla model on this PC makes far fewer mistakes, free and offline.')
    click(out, 'Use the Bangla model')
    out = render(m.panel)
    expect(out.find((e) => e.props['aria-label'] === 'Transcription provider')!.props.value).toBe('local')
    expect([local(out)?.props['data-model'], local(out)?.props['data-state']]).toEqual([BN, 'needs-model'])
    expect(byTest(out, 'bangla-key-hint')).toEqual([])
    expect(calls.download).toEqual([])
    out = speak(out, 'en')
    expect(byTest(out, 'bangla-key-hint')).toEqual([])
  })

  it('with a key provider: Bengali uses On this PC once the Bangla model is here, and the key otherwise, as before', async () => {
    replies.providers = () => Promise.resolve([OPENAI])
    replies.speech = () => Promise.resolve(speechState({ statuses: { [BN]: { state: 'installed' } } }))
    let out = await show()
    expect(out.find((e) => e.props['aria-label'] === 'Transcription provider')!.props.value).toBe('o')
    out = speak(out, 'bn')
    expect(out.find((e) => e.props['aria-label'] === 'Transcription provider')!.props.value).toBe('local')
    expect(local(out)?.props['data-state']).toBe('ready')
  })

  it('the summary of Bengali captions made with another model offers the Bangla model; the click downloads it and makes them again', async () => {
    replies.speech = () => Promise.resolve(speechState({ statuses: { 'whisper-base': { state: 'installed' } } }))
    store.state = { ...store.state, transcript: { provider: 'local', model: 'whisper-base', language: 'bn', createdAt: 'x', segments: [{ id: 't1', start: 1, end: 2, text: 'কিছু' }] } }
    let out = await show()
    const offer = byTest(out, 'bangla-offer')[0]
    expect(offer).toBeTruthy()
    expect(has(out, 'Bangla captions: the Bangla model gets about 4 in 5 words right')).toBe(true)
    expect(has(out, 'Smaller models make more mistakes')).toBe(false)
    const button = byTest(out, 'bangla-offer-button')[0]
    expect(textOf(button.props.children).trim()).toBe('Download Bangla model (539 MB) and make captions')
    expect(button.props['aria-label']).toBe('Download Bangla (Bengali.AI Whisper medium), 539 megabytes, and make captions')
    ;(button.props.onClick as () => void)()
    expect(calls.confirm).toHaveLength(1)
    expect(calls.download).toEqual([BN])
    out = render(m.panel)
    // The form opens with Bengali, where the download shows.
    expect(sections(out)).toContain('Regenerate captions')
    expect(out.find((e) => e.props['aria-label'] === 'Spoken language')!.props.value).toBe('bn')
    expect(local(out)?.props['data-model']).toBe(BN)
    expect(calls.setDefault).toEqual([])
  })

  it('the offer once the Bangla model is here makes them again with it; never for Bangla, English or cloud captions', async () => {
    replies.speech = () => Promise.resolve(speechState({ statuses: { 'whisper-base': { state: 'installed' }, [BN]: { state: 'installed' } } }))
    const t = { provider: 'local', model: 'whisper-small', language: 'bn', createdAt: 'x', segments: [{ id: 't1', start: 1, end: 2, text: 'কিছু' }] }
    store.state = { ...store.state, transcript: t }
    let out = await show()
    click(out, 'Make them again with Bangla (downloaded)')
    expect(calls.transcribe).toEqual([{ providerId: 'local', model: BN, source: 'auto', language: 'bn' }])
    expect(calls.download).toEqual([])
    for (const other of [{ ...t, model: BN }, { ...t, language: 'en' }, { ...t, provider: 'openai', model: 'whisper-1' }]) {
      m = await fresh()
      store.state = { ...store.state, transcript: other }
      out = await show()
      expect(byTest(out, 'bangla-offer')).toEqual([])
    }
  })
})
