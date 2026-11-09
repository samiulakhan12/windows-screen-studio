import { vi } from 'vitest'

/*
 * Renders the Captions Studio editor UI without a DOM (as tests/captionsPanel.test.ts renders the
 * Captions tab): React's hooks are swapped for a few lines that keep each component's state by its
 * place in the tree, function components are called and the host elements they give are listed.
 * Contexts: the editor's (store and player), the group's and the keymap's are answered by the test;
 * any other context gives its default value. Refs get a stand-in element that records focus.
 */

export interface El {
  type: unknown
  props: Record<string, unknown>
  ref?: unknown
}
interface Cell {
  value?: unknown
  deps?: readonly unknown[]
  current?: unknown
  cleanup?: (() => void) | void
}

const cells = new Map<string, Cell[]>()
let hooks: { cells: Cell[]; i: number } | null = null
let effects: (() => void)[] = []
let dirty = false
let ids = 0
const cell = (): Cell => (hooks!.cells[hooks!.i++] ??= {})
const changed = (a: readonly unknown[] | undefined, b: readonly unknown[] | undefined): boolean => !a || !b || a.length !== b.length || a.some((v, i) => !Object.is(v, b[i]))

/** What the contexts give: set by each test file before rendering. */
export const contexts: { editor: unknown; group: unknown; keymap: unknown; editorCtx: unknown; groupCtx: unknown; keymapCtx: unknown } = {
  editor: null,
  group: null,
  keymap: null,
  editorCtx: null,
  groupCtx: null,
  keymapCtx: null
}
/** Elements that got the focus. */
export const focused: El[] = []

// Renderer code: imported at run time so the Node typecheck of tests/ does not follow it.
const CONTEXT = '../src/renderer/src/editor/context'
const GROUP = '../src/renderer/src/editor/groupContext'
const KEYMAP = '../src/renderer/src/editor/keymapContext'

/** The editor's, the group's and the keymap's contexts, so useContext can answer them (after mockReact). */
export async function useEditorContexts(): Promise<void> {
  contexts.editorCtx = ((await import(/* @vite-ignore */ CONTEXT)) as { EditorContext: unknown }).EditorContext
  contexts.groupCtx = ((await import(/* @vite-ignore */ GROUP)) as { GroupContext: unknown }).GroupContext
  contexts.keymapCtx = ((await import(/* @vite-ignore */ KEYMAP)) as { KeymapContext: unknown }).KeymapContext
}

/** Swaps React's hooks; call before importing renderer modules. */
export function mockReact(): void {
  vi.doMock('react', async (importOriginal) => {
    const real = await importOriginal<Record<string, unknown>>()
    return {
      ...real,
      useState: (init: unknown) => {
        const c = cell()
        if (!('value' in c)) c.value = typeof init === 'function' ? (init as () => unknown)() : init
        const set = (v: unknown): void => {
          const next = typeof v === 'function' ? (v as (x: unknown) => unknown)(c.value) : v
          if (Object.is(next, c.value)) return
          c.value = next
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
      useLayoutEffect: (fn: () => (() => void) | void, deps?: unknown[]) => {
        const c = cell()
        if (!changed(c.deps, deps)) return
        c.deps = deps
        effects.push(() => {
          c.cleanup?.()
          c.cleanup = fn()
        })
      },
      useSyncExternalStore: (_subscribe: unknown, get: () => unknown) => get(),
      useId: () => {
        const c = cell()
        if (!('value' in c)) c.value = `:r${++ids}:`
        return c.value
      },
      useContext: (ctx: unknown) => {
        if (ctx === contexts.editorCtx) return contexts.editor
        if (ctx === contexts.groupCtx) return contexts.group
        if (ctx === contexts.keymapCtx) return contexts.keymap
        return (ctx as { _currentValue?: unknown })._currentValue
      },
      memo: (c: unknown) => c
    }
  })
}

/** The host elements under `el`, as a querySelector would search them. */
export function descendants(el: El): El[] {
  const found: El[] = []
  const visit = (node: unknown): void => {
    if (Array.isArray(node)) return node.forEach(visit)
    if (!node || typeof node !== 'object' || !('props' in node)) return
    const child = node as El
    if (typeof child.type === 'string') found.push(child)
    visit(child.props.children)
  }
  visit(el.props.children)
  return found
}

/**
 * A stand-in DOM node for a ref: focus is recorded, `disabled`, `id` and getAttribute are its
 * element's; querySelector(All) finds `[attr="value"]`, `[attr]` or `.class` among its elements.
 * click() is the DOM's: nothing on a disabled element, else the page's click listeners see it first
 * (through document.dispatchEvent, when the test gives the page one) and may stop it, then onClick.
 */
function standIn(el: El): Record<string, unknown> {
  const match = (sel: string) => (d: El): boolean => {
    const attr = /^\[([\w-]+)(?:=["']([^"']*)["'])?\]$/.exec(sel)
    if (attr) return attr[2] === undefined ? d.props[attr[1]] !== undefined : String(d.props[attr[1]]) === attr[2]
    const cls = /^\.([\w-]+)$/.exec(sel)
    return !!cls && String(d.props.className ?? '').split(/\s+/).includes(cls[1])
  }
  // focus() gives nothing back, as the DOM's (an effect that returns it has no cleanup).
  const node = (d: El): Record<string, unknown> => ({ el: d, focus: () => void focused.push(d), disabled: !!d.props.disabled, dataset: {}, getBoundingClientRect: () => ({ left: 0, top: 0, width: 0, height: 0 }) })
  const stand: Record<string, unknown> = {
    el,
    get disabled(): boolean {
      return !!(stand.el as El).props.disabled
    },
    get id(): unknown {
      return (stand.el as El).props.id
    },
    getAttribute: (name: string): string | null => {
      const v = (stand.el as El).props[name]
      return v === undefined || v === null ? null : String(v)
    },
    isConnected: true,
    clientWidth: 280,
    // No child nodes are laid out here (a list's rows are read from its elements instead).
    children: [],
    focus: () => void focused.push(stand.el as El),
    click: (): void => {
      const d = stand.el as El
      if (d.props.disabled) return
      let stopped = false
      const event = { type: 'click', target: stand, preventDefault: () => undefined, stopPropagation: () => void (stopped = true), stopImmediatePropagation: () => void (stopped = true) }
      const page = (globalThis as { document?: { dispatchEvent?: (e: unknown) => unknown } }).document
      if (typeof page?.dispatchEvent === 'function') page.dispatchEvent(event)
      if (!stopped) (d.props.onClick as ((e: unknown) => void) | undefined)?.(event)
    },
    contains: () => false,
    // Nothing covers a stand-in (no inert part of the page above it); a button is its own closest('button').
    closest: (sel: string) => (sel === 'button' && (stand.el as El).type === 'button' ? stand : null),
    scrollIntoView: () => undefined,
    getBoundingClientRect: () => ({ left: 0, top: 0, width: 280, height: 96, right: 280, bottom: 96 }),
    querySelector: (sel: string) => {
      const found = descendants(stand.el as El).find(match(sel))
      return found ? node(found) : null
    },
    querySelectorAll: (sel: string) => descendants(stand.el as El).filter(match(sel)).map(node),
    getContext: () => null,
    toDataURL: () => 'data:image/png;base64,'
  }
  return stand
}

/** Calls every function component under `node` (hooks kept by path, except `skip`) and lists the host elements. */
function walk(node: unknown, path: string, out: El[], skip: ReadonlySet<string>): void {
  if (Array.isArray(node)) return node.forEach((n, i) => walk(n, `${path}.${i}`, out, skip))
  if (!node || typeof node !== 'object' || !('props' in node)) return
  const el = node as El
  if (typeof el.type === 'function') {
    const name = (el.type as { name: string }).name
    if (skip.has(name)) {
      out.push(el)
      return
    }
    const key = `${path}/${name}`
    if (!cells.has(key)) cells.set(key, [])
    const outer = hooks
    hooks = { cells: cells.get(key)!, i: 0 }
    const child = (el.type as (p: unknown) => unknown)(el.props)
    hooks = outer
    return walk(child, key, out, skip)
  }
  if (typeof el.type === 'object' && el.type && 'Provider' in (el.type as object) === false && '_context' in (el.type as object)) {
    // A context provider: render its children.
    return walk(el.props.children, path, out, skip)
  }
  const ref = el.ref as { current?: unknown } | null | undefined
  if (ref && typeof ref === 'object') {
    if (!ref.current) ref.current = standIn(el)
    else if (typeof ref.current === 'object' && 'el' in (ref.current as object)) (ref.current as { el: El }).el = el
  }
  out.push(el)
  walk(el.props.children, path, out, skip)
}

/** Renders `root` until its state and effects settle; returns every host element (and skipped components). */
export function render(root: unknown, skip: readonly string[] = []): El[] {
  const set = new Set(skip)
  let out: El[] = []
  for (let pass = 0; pass < 30; pass++) {
    dirty = false
    out = []
    walk(root, 'root', out, set)
    const run = effects
    effects = []
    for (const fn of run) fn()
    if (!dirty && effects.length === 0) return out
  }
  throw new Error('the render did not settle')
}

/**
 * After an event outside a render (a palette command, a store update), renders `root` again only
 * when a state changed since the last render, as React does: a setState to the value it already
 * has renders nothing, so effects wait for the next render. Null when nothing rendered.
 */
export function renderIfChanged(root: unknown, skip: readonly string[] = []): El[] | null {
  return dirty ? render(root, skip) : null
}

/** Forgets every component's state (a fresh mount). */
export function unmountAll(): void {
  for (const list of cells.values()) for (const c of list) c.cleanup?.()
  cells.clear()
  effects = []
  focused.length = 0
}

/** Lets promises settle (window.api answers), then renders again. */
export async function settle(root: unknown, skip: readonly string[] = []): Promise<El[]> {
  render(root, skip)
  for (let i = 0; i < 5; i++) await Promise.resolve()
  await new Promise((r) => setTimeout(r, 0))
  return render(root, skip)
}

/** The text of an element (its strings, nested). */
export const textOf = (node: unknown): string => {
  if (typeof node === 'string' || typeof node === 'number') return String(node)
  if (Array.isArray(node)) return node.map(textOf).join('')
  if (node && typeof node === 'object' && 'props' in node) return textOf((node as El).props.children)
  return ''
}
export const byTestId = (els: El[], id: string): El | undefined => els.find((e) => e.props['data-testid'] === id)
export const allByTestId = (els: El[], id: string): El[] => els.filter((e) => e.props['data-testid'] === id)
export const byLabel = (els: El[], label: string): El | undefined => els.find((e) => e.props['aria-label'] === label)
/** A button by its text. */
export const button = (els: El[], text: string): El | undefined => els.find((e) => e.type === 'button' && textOf(e).trim() === text)

/** A keyboard event with the given key and modifiers; `prevented` tells whether a handler took it, `stopped` whether it kept it from the editor's window listener. */
export function key(k: string, mods: { ctrlKey?: boolean; shiftKey?: boolean; altKey?: boolean; metaKey?: boolean } = {}): { key: string; prevented: boolean; stopped: boolean; preventDefault(): void; stopPropagation(): void; ctrlKey: boolean; shiftKey: boolean; altKey: boolean; metaKey: boolean; target: unknown; currentTarget: unknown; nativeEvent: unknown } {
  const e = {
    key: k,
    prevented: false,
    stopped: false,
    ctrlKey: !!mods.ctrlKey,
    shiftKey: !!mods.shiftKey,
    altKey: !!mods.altKey,
    metaKey: !!mods.metaKey,
    target: {},
    currentTarget: {},
    nativeEvent: {},
    preventDefault() {
      e.prevented = true
    },
    stopPropagation() {
      e.stopped = true
    }
  }
  return e
}

/** A store like the editor's: updates with their merge keys, seals, gestures; undo steps counted the way EditStore merges them. */
export function testStore<T>(initial: T): {
  state: T
  updates: { key?: string }[]
  steps: number
  update(fn: (s: T) => T, key?: string): void
  seal(): void
  beginGesture(): void
  endGesture(): void
  subscribe(l: () => void): () => void
  replace(s: T): void
} {
  let lastKey: string | null = null
  const store = {
    state: initial,
    updates: [] as { key?: string }[],
    steps: 0,
    update(fn: (s: T) => T, key?: string) {
      const next = fn(store.state)
      if (next === store.state) return
      store.state = next
      store.updates.push({ key })
      if (key === undefined || key !== lastKey) store.steps++
      lastKey = key ?? null
    },
    seal() {
      lastKey = null
    },
    beginGesture() {},
    endGesture() {
      lastKey = null
    },
    subscribe: () => () => undefined,
    replace(s: T) {
      store.state = s
    }
  }
  return store
}
