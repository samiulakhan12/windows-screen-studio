import { beforeEach, describe, expect, it, vi } from 'vitest'
import type { CropDraft } from '../src/shared/editor/cropEdit'
import { FULL_FRAME } from '../src/shared/engine/crop'

/*
 * The crop tool's overlay (CropEditor, docs/design/crop-in-editor.md §5) without a DOM, as
 * tests/captionsPanel.test.ts renders the Captions tab: React's hooks are swapped for a few lines
 * that keep the component's state, so it is called as a function and its handlers run. `window`
 * keeps the drag's listeners, so a test sees which are left and moves the pointer through them.
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
let hooks: { i: number } | null = null
let effects: (() => void)[] = []
const cell = (): Cell => (cells[hooks!.i++] ??= {})
const changed = (a: readonly unknown[] | undefined, b: readonly unknown[] | undefined): boolean => !a || !b || a.length !== b.length || a.some((v, i) => !Object.is(v, b[i]))

type Listener = (ev: unknown) => void
const listeners = new Map<string, Set<Listener>>()
vi.stubGlobal('window', {
  addEventListener: (type: string, fn: Listener) => listeners.set(type, (listeners.get(type) ?? new Set()).add(fn)),
  removeEventListener: (type: string, fn: Listener) => listeners.get(type)?.delete(fn)
})
vi.stubGlobal('document', { activeElement: null, body: {} })
vi.stubGlobal('HTMLElement', class {})
const pointer = (type: 'pointermove' | 'pointerup', clientX: number, clientY: number): void => {
  for (const fn of [...(listeners.get(type) ?? [])]) fn({ type, pointerId: 1, clientX, clientY, shiftKey: false })
}
const following = (): number => ['pointermove', 'pointerup', 'pointercancel'].reduce((n, t) => n + (listeners.get(t)?.size ?? 0), 0)

vi.doMock('react', async (importOriginal) => ({
  ...(await importOriginal<Record<string, unknown>>()),
  useState: (init: unknown) => {
    const c = cell()
    if (!('value' in c)) c.value = typeof init === 'function' ? (init as () => unknown)() : init
    return [c.value, (v: unknown) => (c.value = typeof v === 'function' ? (v as (x: unknown) => unknown)(c.value) : v)]
  },
  useRef: (init: unknown) => {
    const c = cell()
    if (!('current' in c)) c.current = init
    return c
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
const EDITOR = '../src/renderer/src/editor/CropEditor'
const { CropEditor } = (await import(/* @vite-ignore */ EDITOR)) as { CropEditor: (props: unknown) => unknown }

const RECORDED = { width: 1920, height: 1080 }
const RECT = { x: 0, y: 0, w: 960, h: 540 }
let drafts: CropDraft[] = []

/** The overlay for `draft`, rendered with its effects run; its elements, flattened. */
function render(draft: CropDraft): El[] {
  hooks = { i: 0 }
  const tree = CropEditor({ recorded: RECORDED, rect: RECT, draft, onDraft: (d: CropDraft) => drafts.push(d), onDone: () => undefined })
  hooks = null
  const run = effects
  effects = []
  run.forEach((e) => e())
  const out: El[] = []
  const walk = (node: unknown): void => {
    if (Array.isArray(node)) return node.forEach(walk)
    if (!node || typeof node !== 'object' || !('props' in node)) return
    out.push(node as El)
    walk((node as El).props.children)
  }
  walk(tree)
  return out
}
/** The tool closing (Esc, Enter, undo, export): React runs the effects' cleanups. */
const unmount = (): void => cells.forEach((c) => c.cleanup?.())

/** Presses the pointer on the handle `h` at (x, y) of the overlay. */
function grab(out: El[], h: string, x: number, y: number): void {
  const el = out.find((e) => e.props['data-testid'] === `crop-handle-${h}`)!
  const down = el.props.onPointerDown as (e: unknown) => void
  down({ button: 0, pointerId: 1, clientX: x, clientY: y, target: null, currentTarget: {}, preventDefault: () => undefined, stopPropagation: () => undefined })
}

beforeEach(() => {
  cells = []
  effects = []
  listeners.clear()
  drafts = []
})

describe('CropEditor: a drag', () => {
  const draft: CropDraft = { rect: { ...FULL_FRAME }, aspect: 'free' }

  it('writes the draft while the pointer moves, and stops listening when it is released', () => {
    grab(render(draft), 'e', 960, 270)
    pointer('pointermove', 720, 270)
    expect(drafts).toHaveLength(1)
    expect(drafts[0].rect.w).toBeCloseTo(0.75, 9)
    pointer('pointerup', 720, 270)
    expect(following()).toBe(0)
    pointer('pointermove', 600, 270)
    expect(drafts).toHaveLength(1)
  })

  it('still held when the tool closes, writes no more drafts: the tool stays closed', () => {
    grab(render(draft), 'e', 960, 270)
    pointer('pointermove', 720, 270)
    expect(drafts).toHaveLength(1)
    unmount()
    expect(following()).toBe(0)
    pointer('pointermove', 600, 270)
    pointer('pointerup', 600, 270)
    expect(drafts).toHaveLength(1)
  })
})
