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

function deferred<T>(): { promise: Promise<T>; resolve: (v: T) => void } {
  let resolve!: (v: T) => void
  const promise = new Promise<T>((a) => (resolve = a))
  return { promise, resolve }
}

const runs: ReturnType<typeof deferred<unknown>>[] = []
vi.stubGlobal('window', {
  api: {
    listAiProviders: () => Promise.resolve([{ id: 'o', kind: 'openai', label: '', model: 'm', transcriptionModel: 't', maskedKey: '', createdAt: '' }]),
    transcribe: () => {
      const d = deferred<unknown>()
      runs.push(d)
      return d.promise
    },
    onTranscribeProgress: (_l: (p: TranscribeProgress) => void) => () => undefined
  },
  confirm: () => true,
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
  // useEditor() is the only context the rendered components read.
  useContext: () => ({ store, player: {} })
}))

// Renderer code: imported at run time so the Node typecheck of tests/ does not follow it.
const PANEL = '../src/renderer/src/editor/panels/CaptionsPanel'
const ITEMS = '../src/renderer/src/editor/captionItems'
const { CaptionsPanel } = (await import(/* @vite-ignore */ PANEL)) as { CaptionsPanel: (props: unknown) => unknown }
const items = (await import(/* @vite-ignore */ ITEMS)) as { requestCaptions(r: { kind: 'generate' }): void; clearTranscriptionError(): void }

const RENDERED = new Set(['CaptionsPanel', 'GenerateSection'])

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
  out.push(el)
  walk(el.props.children, path, out)
}

/** The tab for the project in the store, rendered until its state and effects settle. */
function render(): El[] {
  for (let pass = 0; pass < 20; pass++) {
    dirty = false
    const out: El[] = []
    walk({ type: CaptionsPanel, props: { project: store.state, selection: null, onSelect: () => undefined, onNotice: () => undefined } }, 'root', out)
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
