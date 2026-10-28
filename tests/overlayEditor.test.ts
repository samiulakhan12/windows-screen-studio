import { beforeEach, describe, expect, it, vi } from 'vitest'
import type { ImageOverlay, Project } from '../src/shared/types'

/*
 * The selected image's handles on the preview (OverlayEditor, docs/design/brand-kit.md §1 and
 * docs/design/multi-select.md §4.6) without a DOM, as tests/cropEditor.test.ts renders the crop
 * tool: React's hooks are swapped for a few lines that keep the component's state, so it is called
 * as a function and its handlers run. `window` keeps the drag's listeners.
 */

interface Cell {
  value?: unknown
  deps?: readonly unknown[]
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
const pointer = (type: 'pointermove' | 'pointerup', clientX: number, clientY: number, shiftKey = false): void => {
  for (const fn of [...(listeners.get(type) ?? [])]) fn({ type, pointerId: 1, clientX, clientY, shiftKey })
}

let project: Project
const store = {
  update: (fn: (p: Project) => Project) => (project = fn(project)),
  beginGesture: () => undefined,
  endGesture: () => undefined
}
const player = { time: 1, subscribe: () => () => undefined }

vi.doMock('react', async (importOriginal) => ({
  ...(await importOriginal<Record<string, unknown>>()),
  useState: (init: unknown) => {
    const c = cell()
    if (!('value' in c)) c.value = typeof init === 'function' ? (init as () => unknown)() : init
    return [c.value, (v: unknown) => (c.value = typeof v === 'function' ? (v as (x: unknown) => unknown)(c.value) : v)]
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
const CONTEXT = '../src/renderer/src/editor/context'
vi.doMock(CONTEXT, async (importOriginal) => ({ ...(await importOriginal<Record<string, unknown>>()), useEditor: () => ({ store, player }) }))

// Renderer code: imported at run time so the Node typecheck of tests/ does not follow it.
const EDITOR = '../src/renderer/src/editor/OverlayEditor'
const { OverlayEditor } = (await import(/* @vite-ignore */ EDITOR)) as { OverlayEditor: (props: unknown) => unknown }

/** The preview: 1000 × 500 px, so a side of 0.1 is 50 px. */
const BOX = { w: 1000, h: 500 }
const overlay = (o: Partial<ImageOverlay> = {}): ImageOverlay => ({
  id: 'o',
  start: 0,
  end: 5,
  file: 'overlay-1.png',
  x: 0.5,
  y: 0.5,
  w: 0.2,
  h: 0.1,
  rotation: 0,
  opacity: 1,
  fadeIn: 0,
  fadeOut: 0,
  ...o
})
const current = (): ImageOverlay => project.overlays![0]

/** The handles for the project's image, with their effects run (it shows once the playhead is checked); flattened. */
function render(): El[] {
  let tree: unknown = null
  for (let pass = 0; pass < 2; pass++) {
    hooks = { i: 0 }
    tree = OverlayEditor({ project, selection: { kind: 'overlay', id: 'o' }, box: BOX, onDone: () => undefined })
    hooks = null
    const run = effects
    effects = []
    run.forEach((e) => e())
  }
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

/** Presses the element matching `which` at (x, y) of the preview; true when the handles took the press (a drag started). */
function press(which: (el: El) => boolean, x: number, y: number, keys: { shiftKey?: boolean; ctrlKey?: boolean } = {}): boolean {
  const el = render().find(which)!
  let taken = false
  const down = el.props.onPointerDown as (e: unknown) => void
  down({
    button: 0,
    pointerId: 1,
    clientX: x,
    clientY: y,
    shiftKey: false,
    ctrlKey: false,
    metaKey: false,
    ...keys,
    target: null,
    currentTarget: { closest: () => ({ getBoundingClientRect: () => ({ left: 0, top: 0 }) }) },
    preventDefault: () => undefined,
    stopPropagation: () => (taken = true)
  })
  return taken
}
const handle = (h: string) => (el: El) => el.props['data-handle'] === h
const rotateHandle = (el: El): boolean => el.props['data-testid'] === 'overlay-rotate'

beforeEach(() => {
  cells = []
  effects = []
  listeners.clear()
  project = { overlays: [overlay()] } as unknown as Project
})

describe('OverlayEditor: Shift held before the press', () => {
  // The box: 100 × 50 px around (500, 250).

  it('on a corner handle, resizes keeping the shape (it does not go on to the multi-select)', () => {
    expect(press(handle('se'), 550, 275, { shiftKey: true })).toBe(true)
    pointer('pointermove', 650, 275, true)
    pointer('pointerup', 650, 275, true)
    expect(current().w).toBeCloseTo(0.4, 9)
    expect(current().h).toBeCloseTo(0.2, 9)
  })

  it('on the rotate handle, rotates in 15° steps', () => {
    expect(press(rotateHandle, 500, 204, { shiftKey: true })).toBe(true)
    // 40° from straight up.
    pointer('pointermove', 500 + 100 * Math.tan((40 * Math.PI) / 180), 150, true)
    expect(current().rotation).toBe(45)
  })

  it('Ctrl on a handle still goes on to the preview, which adds or removes items (E-06)', () => {
    expect(press(handle('se'), 550, 275, { ctrlKey: true })).toBe(false)
    pointer('pointermove', 650, 275)
    expect(current().w).toBe(0.2)
  })
})

describe('OverlayEditor: the rotate handle stays where it can be grabbed', () => {
  const place = (): string => {
    const cls = render().find(rotateHandle)!.props.className as string
    return cls.includes('below') ? 'below' : cls.includes('inside') ? 'inside' : 'above'
  }

  it('sits above the box in the middle of the frame', () => {
    expect(place()).toBe('above')
  })

  it('near the top of the frame (cut off, or under the hint), sits below the box and turns the image the way it is dragged', () => {
    // A logo in a top corner: its box top is 15 px from the frame top, centre (100, 40).
    project = { overlays: [overlay({ x: 0.1, y: 0.08, w: 0.1, h: 0.1 })] } as unknown as Project
    expect(place()).toBe('below')
    // A logo at the top centre whose handle above would sit under the hint.
    project = { overlays: [overlay({ y: 0.15, w: 0.1, h: 0.1 })] } as unknown as Project
    expect(place()).toBe('below')
    project = { overlays: [overlay({ x: 0.1, y: 0.08, w: 0.1, h: 0.1 })] } as unknown as Project
    expect(press(rotateHandle, 100, 86)).toBe(true)
    // Straight below the centre is no turn at all (not half a turn).
    pointer('pointermove', 100, 90)
    expect(current().rotation).toBe(0)
    // Its bottom swung to the right: a quarter turn anticlockwise.
    pointer('pointermove', 150, 40)
    expect(current().rotation).toBe(-90)
  })

  it('on an image as tall as the frame, sits inside its bottom edge', () => {
    project = { overlays: [overlay({ w: 0.5, h: 1 })] } as unknown as Project
    expect(place()).toBe('inside')
    expect(press(rotateHandle, 500, 479)).toBe(true)
    pointer('pointermove', 500, 490)
    expect(current().rotation).toBe(0)
  })

  it('turned a quarter, goes by the box: its top faces right, so at the right edge of the frame the handle moves to the left', () => {
    project = { overlays: [overlay({ x: 0.95, rotation: 90, w: 0.1, h: 0.1 })] } as unknown as Project
    expect(place()).toBe('below')
    project = { overlays: [overlay({ x: 0.5, rotation: 90, w: 0.1, h: 0.1 })] } as unknown as Project
    expect(place()).toBe('above')
  })
})
