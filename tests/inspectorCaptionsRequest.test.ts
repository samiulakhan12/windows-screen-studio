import { afterEach, describe, expect, it, vi } from 'vitest'

/*
 * The Inspector's Selection view (E-06) and a command for the Captions tab (NW-13, docs/design/
 * publish-pack.md §2.8), without a DOM: React's hooks are swapped for a few lines that keep the
 * Inspector's state, and the panels are stand-ins, so what the Inspector shows can be read.
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
let dirty = false
const cell = (): Cell => (cells[at++] ??= {})
const changed = (a: readonly unknown[] | undefined, b: readonly unknown[] | undefined): boolean => !a || !b || a.length !== b.length || a.some((v, i) => !Object.is(v, b[i]))
const effect = (fn: () => (() => void) | void, deps?: unknown[]): void => {
  const c = cell()
  if (!changed(c.deps, deps)) return
  c.deps = deps
  effects.push(() => {
    c.cleanup?.()
    c.cleanup = fn()
  })
}

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
  useEffect: effect,
  useLayoutEffect: effect
}))

/** The selected items: two or more are a group, which the Selection view shows. */
let groupKeys: string[] = []
const EDITOR = '../src/renderer/src/editor'
vi.doMock(`${EDITOR}/groupContext`, () => ({ useGroup: () => ({ group: { keys: groupKeys }, command: () => undefined }) }))
vi.doMock(`${EDITOR}/speechState`, () => ({ useCaptionsHost: () => null }))
// Each panel is a stand-in named after it (the Inspector only places them).
const PANELS = ['Selection', 'Style', 'Cursor', 'Zoom', 'Clip', 'Text', 'Captions', 'Transcript', 'Shapes', 'Images', 'Effects', 'Camera', 'Audio'].map((p) => `${p}Panel`)
for (const name of PANELS) vi.doMock(`${EDITOR}/panels/${name}`, () => ({ [name]: { [name]: () => null }[name] }))

// Renderer code: imported at run time so the Node typecheck of tests/ does not follow it.
const INSPECTOR = `${EDITOR}/Inspector`
const ITEMS = `${EDITOR}/captionItems`
const { Inspector } = (await import(/* @vite-ignore */ INSPECTOR)) as { Inspector: { type: (props: unknown) => unknown } }
const { requestCaptions, takeCaptionsRequest } = (await import(/* @vite-ignore */ ITEMS)) as {
  requestCaptions: (r: { kind: 'ai'; task: 'cleanup' } | { kind: 'generate' }) => void
  takeCaptionsRequest: () => unknown
}

const walk = (node: unknown, out: El[]): El[] => {
  if (Array.isArray(node)) node.forEach((n) => walk(n, out))
  else if (node && typeof node === 'object' && 'props' in node) {
    out.push(node as El)
    walk((node as El).props.children, out)
  }
  return out
}

/** The Inspector with the editor's open tab, rendered until its state and effects settle. */
function render(tab: string, groupReveal: number): El[] {
  const props = { tab, onTab: () => undefined, project: { id: 'p' }, selection: null, revealSeq: 0, groupReveal, onSelect: () => undefined, onNotice: () => undefined }
  for (let pass = 0; pass < 20; pass++) {
    dirty = false
    at = 0
    const out = walk(Inspector.type(props), [])
    const run = effects
    effects = []
    run.forEach((e) => e())
    if (!dirty) return out
  }
  throw new Error('The Inspector keeps rendering')
}

/** The panel the Inspector shows. */
const shown = (out: El[]): string[] =>
  out.filter((e) => typeof e.type === 'function' && PANELS.includes((e.type as { name: string }).name)).map((e) => (e.type as { name: string }).name)

afterEach(() => {
  for (const c of cells) c.cleanup?.()
  cells = []
  effects = []
  takeCaptionsRequest()
})

describe('Inspector: a command for the Captions tab while the Selection view is shown (§2.8)', () => {
  it('"Fix captions with AI" opens the Captions tab at once, which takes the request then, not later', () => {
    groupKeys = ['zoom:a', 'text:b']
    expect(shown(render('style', 1))).toEqual(['SelectionPanel'])
    // The palette's command: the editor opens the Captions tab and asks it to run the tool.
    requestCaptions({ kind: 'ai', task: 'cleanup' })
    expect(shown(render('captions', 1))).toEqual(['CaptionsPanel'])
  })

  it('Generate captions too', () => {
    groupKeys = ['zoom:a', 'text:b']
    expect(shown(render('style', 1))).toEqual(['SelectionPanel'])
    requestCaptions({ kind: 'generate' })
    expect(shown(render('captions', 1))).toEqual(['CaptionsPanel'])
  })

  it('the Selection view stays while nothing asks the Captions tab', () => {
    groupKeys = ['zoom:a', 'text:b']
    expect(shown(render('style', 1))).toEqual(['SelectionPanel'])
    expect(shown(render('captions', 1))).toEqual(['SelectionPanel'])
  })
})
