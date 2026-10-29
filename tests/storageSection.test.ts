import { beforeEach, describe, expect, it, vi } from 'vitest'
import type { StorageCleanupResult, StorageOverview } from '../src/shared/api/storage'
import { DEFAULT_RULES, type CleanupItem } from '../src/shared/storage/rules'

/*
 * Settings › Storage (F-26) without a DOM, in speechModelsSection.test.ts's way: React's hooks are
 * swapped for a few lines that keep the section's state, refs point at stand-ins of the elements
 * rendered in the last pass (null once gone), effects run after each pass, and animation frames run
 * after the pass that follows them, as a browser paints after React commits.
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

let cells: Cell[] = []
let at = 0
let effects: (() => void)[] = []
let frames: (() => void)[] = []
let dirty = false
const cell = (): Cell => (cells[at++] ??= {})
const changed = (a: readonly unknown[] | undefined, b: readonly unknown[] | undefined): boolean => !a || !b || a.length !== b.length || a.some((v, i) => !Object.is(v, b[i]))

/** The elements that got the focus, in order. */
const focused: El[] = []
/** Events the section dispatched on window. */
const dispatched: string[] = []

const item = (id: string, action: CleanupItem['action']): CleanupItem => ({ id, name: `Rec ${id}`, action, bytes: 1000, lastUsed: 0, createdAt: '2025-01-01T00:00:00.000Z' })
const overview: StorageOverview = { root: 'x', free: null, total: null, bytes: 0, recordings: [], rules: { ...DEFAULT_RULES, removeDays: 90 }, now: 0 }
let plan: () => Promise<CleanupItem[]>
let clean: (items: { id: string; action: CleanupItem['action'] }[]) => Promise<StorageCleanupResult>

vi.stubGlobal('window', {
  api: {
    storageScan: () => Promise.resolve(overview),
    storagePlan: () => plan(),
    storageClean: (items: { id: string; action: CleanupItem['action'] }[]) => clean(items),
    storageSetRules: (r: unknown) => Promise.resolve(r),
    revealProject: () => Promise.resolve()
  },
  addEventListener: () => undefined,
  removeEventListener: () => undefined,
  dispatchEvent: (e: Event) => {
    dispatched.push(e.type)
    return true
  }
})
vi.stubGlobal('requestAnimationFrame', (fn: () => void) => {
  frames.push(fn)
  return frames.length
})

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
  }
}))

// Renderer code: imported at run time so the Node typecheck of tests/ does not follow it.
const SECTION = '../src/renderer/src/settings/StorageSection'
const section = (await import(/* @vite-ignore */ SECTION)) as { StorageSection: () => unknown; PROJECTS_CHANGED_EVENT: string }

type Ref = { current?: unknown }
let refs = new Set<Ref>()

function walk(node: unknown, out: El[], seen: Set<Ref>): void {
  if (Array.isArray(node)) return node.forEach((n) => walk(n, out, seen))
  if (!node || typeof node !== 'object' || !('props' in node)) return
  const el = node as El
  const ref = (node as { ref?: Ref | null }).ref
  if (ref && typeof ref === 'object') {
    ref.current = { focus: () => focused.push(el) }
    seen.add(ref)
  }
  out.push(el)
  walk(el.props.children, out, seen)
}

/** The section, rendered until its state and effects settle; then the frames asked for meanwhile. */
function render(): El[] {
  for (let pass = 0; pass < 20; pass++) {
    dirty = false
    at = 0
    const out: El[] = []
    const seen = new Set<Ref>()
    walk(section.StorageSection(), out, seen)
    for (const r of refs) if (!seen.has(r)) r.current = null
    refs = seen
    const run = effects
    effects = []
    run.forEach((e) => e())
    if (dirty) continue
    const painted = frames
    frames = []
    painted.forEach((f) => f())
    if (!dirty) return out
  }
  throw new Error('The section keeps rendering')
}

const textOf = (node: unknown): string =>
  Array.isArray(node) ? node.map(textOf).join('') : typeof node === 'string' || typeof node === 'number' ? String(node) : node && typeof node === 'object' && 'props' in node ? textOf((node as El).props.children) : ''
const click = (out: El[], label: RegExp): void => {
  const button = out.find((e) => e.type === 'button' && label.test(textOf(e.props.children).trim()))
  if (!button) throw new Error(`No ${label} button`)
  ;(button.props.onClick as () => void)()
}
const flush = (): Promise<void> => new Promise((r) => setTimeout(r, 0))
const lastFocused = (): string => (focused.length ? textOf(focused[focused.length - 1].props.children).trim() : '')

/** Clicks `label`, lets the answers come back, and renders the result. */
async function press(label: RegExp): Promise<El[]> {
  click(render(), label)
  render()
  await flush()
  await flush()
  return render()
}

beforeEach(async () => {
  for (const c of cells) c.cleanup?.()
  cells = []
  effects = []
  frames = []
  refs = new Set()
  focused.length = 0
  dispatched.length = 0
  plan = () => Promise.resolve([item('a', 'remove'), item('b', 'caches')])
  clean = (items) => Promise.resolve({ moved: items.map((i) => item(i.id, i.action)), failed: [], freed: 1000 * items.length })
  render()
  await flush()
  render()
})

describe('Settings › Storage: focus never falls to the page', () => {
  it('Cancel in the review gives the focus back to Review clean-up…', async () => {
    await press(/^Review clean-up…$/)
    expect(lastFocused()).toBe('Review clean-up')
    await press(/^Cancel$/)
    expect(lastFocused()).toBe('Review clean-up…')
  })

  it('Close on an empty review does the same', async () => {
    plan = () => Promise.resolve([])
    await press(/^Review clean-up…$/)
    expect(lastFocused()).toBe('Review clean-up')
    await press(/^Close$/)
    expect(lastFocused()).toBe('Review clean-up…')
  })

  it('a review that fails keeps the focus on its button; a clean-up that fails, on the review', async () => {
    plan = () => Promise.reject(new Error('no'))
    await press(/^Review clean-up…$/)
    expect(lastFocused()).toBe('Review clean-up…')
    plan = () => Promise.resolve([item('a', 'remove')])
    await press(/^Review clean-up…$/)
    clean = () => Promise.reject(new Error('busy'))
    focused.length = 0
    await press(/^Move 1 to the Recycle Bin/)
    expect(lastFocused()).toBe('Review clean-up')
  })
})
