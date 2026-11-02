import { beforeEach, describe, expect, it, vi } from 'vitest'
import type { SearchHit, SearchResponse } from '../src/shared/search/types'

/*
 * Home's search box (docs/design/search.md §1, §5) without a DOM: React's hooks are swapped for a
 * few lines that keep the box's state (as in notesCard.test.ts), the document's keydown listener is
 * kept to press Ctrl+F, the input's ref gets a fake node (focus is recorded), and window.api answers
 * every query with two recordings.
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
  ref?: { current: unknown } | null
}

let cells: Cell[] = []
let at = 0
let effects: (() => void)[] = []
let dirty = false
const cell = (): Cell => (cells[at++] ??= {})
const changed = (a: readonly unknown[] | undefined, b: readonly unknown[] | undefined): boolean => !a || !b || a.length !== b.length || a.some((v, i) => !Object.is(v, b[i]))

vi.doMock('react', async (importOriginal) => ({
  ...(await importOriginal<Record<string, unknown>>()),
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
  useId: () => ':r0:'
}))

/** The typing pause's timers, run by hand. */
let timers = new Map<number, () => void>()
let nextTimer = 1
const runTimers = (): void => {
  const due = [...timers.values()]
  timers = new Map()
  due.forEach((fn) => fn())
}

const hit = (id: string, name: string): SearchHit => ({
  id,
  name,
  createdAt: '2026-10-01T10:00:00.000Z',
  duration: 60,
  title: [{ text: name, hit: false }],
  score: 1,
  moments: [{ kind: 'said', start: 12, end: 14, video: 12, snippet: [{ text: 'the budget', hit: true }], terms: 1, cut: false }],
  more: 0,
  nameOnly: false
})
/** Queries sent, and how each is answered (held until `answer` is called when `hold` is set). */
const api = { queries: [] as string[], hold: false, held: [] as (() => void)[] }
const answer = (): void => api.held.splice(0).forEach((fn) => fn())
vi.stubGlobal('window', {
  setTimeout: (fn: () => void) => {
    const id = nextTimer++
    timers.set(id, fn)
    return id
  },
  clearTimeout: (id: number) => void timers.delete(id),
  api: {
    searchLibrary: (q: string) => {
      api.queries.push(q)
      const r: SearchResponse = { query: q.trim(), hits: [hit('p1', 'Product demo'), hit('p2', 'Budget review')], status: { state: 'ready', indexed: 2, total: 2 }, withoutTranscript: 0 }
      return api.hold ? new Promise((resolve) => api.held.push(() => resolve(r))) : Promise.resolve(r)
    },
    onSearchStatus: () => () => undefined,
    refreshSearch: () => Promise.resolve({ state: 'ready', indexed: 2, total: 2 })
  }
})

/** The document: its keydown listeners (Ctrl+F), and nothing open over Home. */
const keyListeners = new Set<(e: unknown) => void>()
vi.stubGlobal('document', {
  addEventListener: (type: string, fn: (e: unknown) => void) => type === 'keydown' && keyListeners.add(fn),
  removeEventListener: (type: string, fn: (e: unknown) => void) => type === 'keydown' && keyListeners.delete(fn),
  querySelector: () => null,
  getElementById: () => null
})

// Renderer code: imported at run time so the Node typecheck of tests/ does not follow it.
const SEARCH = '../src/renderer/src/search/LibrarySearch'
interface Props {
  projects: { id: string }[]
  onOpen: (id: string) => void
  disabled?: boolean
}
const { LibrarySearch } = (await import(/* @vite-ignore */ SEARCH)) as { LibrarySearch: (props: Props) => unknown }

function walk(node: unknown, out: El[]): El[] {
  if (Array.isArray(node)) {
    node.forEach((n) => walk(n, out))
    return out
  }
  if (!node || typeof node !== 'object' || !('props' in node)) return out
  const el = node as El
  out.push(el)
  walk(el.props.children, out)
  return out
}

/** The input's DOM node: what focus and select did. */
const box = { focused: 0, selected: 0, focus: () => void box.focused++, select: () => void box.selected++, blur: () => undefined }

const projects = [{ id: 'p1' }, { id: 'p2' }]
let props: Props = { projects, onOpen: () => undefined }

/** The box, rendered until its state and effects settle; returns its input. */
function render(): El {
  for (let pass = 0; pass < 20; pass++) {
    dirty = false
    at = 0
    const out = walk(LibrarySearch(props), [])
    const input = out.find((e) => e.type === 'input')!
    if (input.ref) input.ref.current = box
    const run = effects
    effects = []
    run.forEach((e) => e())
    if (!dirty) return input
  }
  throw new Error('The search box keeps rendering')
}
const flush = (): Promise<void> => new Promise((r) => setTimeout(r, 0))

/** Types `text` into the box (its query is sent once the timers run). */
function type(text: string): void {
  ;(render().props.onChange as (e: unknown) => void)({ target: { value: text } })
  render()
}
/** Presses a key in the box; returns whether it was taken (default prevented). */
function press(key: string): boolean {
  let prevented = false
  ;(render().props.onKeyDown as (e: unknown) => void)({ key, nativeEvent: { isComposing: false }, preventDefault: () => (prevented = true) })
  return prevented
}
/** Presses Ctrl+F anywhere on Home; returns whether it was taken. */
function ctrlF(): boolean {
  let prevented = false
  const e = { key: 'f', ctrlKey: true, metaKey: false, shiftKey: false, altKey: false, preventDefault: () => (prevented = true) }
  keyListeners.forEach((fn) => fn(e))
  return prevented
}

beforeEach(() => {
  for (const c of cells) c.cleanup?.()
  cells = []
  effects = []
  timers = new Map()
  keyListeners.clear()
  Object.assign(api, { queries: [], hold: false, held: [] })
  Object.assign(box, { focused: 0, selected: 0 })
})

describe('the search box while Home is busy (saving or recovering a recording, importing)', () => {
  it('Ctrl+F and Enter work while Home is idle', async () => {
    const onOpen = vi.fn()
    props = { projects, onOpen }
    render()
    expect(ctrlF()).toBe(true)
    expect(box.focused).toBe(1)
    type('budget')
    runTimers()
    await flush()
    expect(press('Enter')).toBe(true)
    expect(onOpen).toHaveBeenCalledWith('p1')
  })

  it('Ctrl+F does not reach the box under the "Saving recording…" overlay', () => {
    props = { projects, onOpen: () => undefined, disabled: true }
    render()
    expect(ctrlF()).toBe(false)
    expect(box.focused).toBe(0)
    expect(box.selected).toBe(0)
  })

  it('Enter in the box opens no other recording', async () => {
    const onOpen = vi.fn()
    props = { projects, onOpen }
    type('budget')
    runTimers()
    await flush()
    render()
    // A recording stopped: Home is saving it (the box kept its focus and its results).
    props = { projects, onOpen, disabled: true }
    press('ArrowDown')
    press('Enter')
    expect(onOpen).not.toHaveBeenCalled()
  })

  it('an Enter that waited for its results opens nothing when they come while Home is busy', async () => {
    const onOpen = vi.fn()
    props = { projects, onOpen }
    api.hold = true
    type('budget')
    runTimers()
    // Enter before the answer: its first row is to open when it comes...
    expect(press('Enter')).toBe(true)
    // ...but Home started saving a recording meanwhile.
    props = { projects, onOpen, disabled: true }
    render()
    answer()
    await flush()
    render()
    expect(onOpen).not.toHaveBeenCalled()
    // Once Home is idle again, that old Enter does not open it either.
    props = { projects, onOpen }
    render()
    expect(onOpen).not.toHaveBeenCalled()
  })
})
