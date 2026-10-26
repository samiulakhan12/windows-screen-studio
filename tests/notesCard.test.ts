import { beforeEach, describe, expect, it, vi } from 'vitest'

/*
 * Home's "Speaker notes" card and its useNotes() without a DOM: React's hooks are swapped for a
 * few lines that keep the card's state (as in captionsPanel.test.ts), the Notes dialog is a stub
 * whose props are read, and window.api is a store whose text saves can fail.
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

/** The main process's notes: the saved text, and how many text saves fail from now on. */
const store = { text: 'old script', failures: 0, saves: [] as string[] }
const stateOf = () => ({
  settings: { text: store.text, wpm: 130, showWhileRecording: true },
  support: { hiddenFromCapture: true },
  window: null
})
vi.stubGlobal('window', {
  api: {
    onNotesState: () => () => undefined,
    getNotes: () => Promise.resolve(stateOf()),
    updateNotes: (patch: { text?: string }) => {
      if (patch.text !== undefined) {
        if (store.failures > 0) {
          store.failures--
          return Promise.reject(new Error("Error invoking remote method 'notes:update': Error: EBUSY: resource busy or locked"))
        }
        store.text = patch.text
        store.saves.push(patch.text)
      }
      return Promise.resolve(stateOf())
    },
    rehearseNotes: () => Promise.resolve(stateOf())
  }
})
vi.stubGlobal('document', { body: {} })

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
  }
}))
vi.doMock('react-dom', async (importOriginal) => ({ ...(await importOriginal<Record<string, unknown>>()), createPortal: (child: unknown) => child }))
vi.doMock('../src/renderer/src/notes/NotesDialog', () => ({ NotesDialog: function NotesDialog(): null {
  return null
} }))

// Renderer code: imported at run time so the Node typecheck of tests/ does not follow it.
const CARD = '../src/renderer/src/notes/NotesCard'
const { NotesCard } = (await import(/* @vite-ignore */ CARD)) as { NotesCard: (props: { disabled: boolean }) => unknown }

interface Controller {
  setText(text: string): void
  flushText(): Promise<void>
}

/** Every element under `node` (the stub dialog included, not called). */
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

/** The card's element tree from the last render. */
let tree: unknown = null

/** The card, rendered until its state and effects settle. */
function render(): El[] {
  for (let pass = 0; pass < 20; pass++) {
    dirty = false
    at = 0
    tree = NotesCard({ disabled: false })
    const out = walk(tree, [])
    const run = effects
    effects = []
    run.forEach((e) => e())
    if (!dirty) return out
  }
  throw new Error('The card keeps rendering')
}

const textOf = (node: unknown): string =>
  Array.isArray(node) ? node.map(textOf).join('') : typeof node === 'string' || typeof node === 'number' ? String(node) : node && typeof node === 'object' && 'props' in node ? textOf((node as El).props.children) : ''
const flush = (): Promise<void> => new Promise((r) => setTimeout(r, 0))
const alerts = (out: El[]): string[] => out.filter((e) => e.props.role === 'alert').map((e) => textOf(e.props.children))
const dialogOf = (out: El[]): El | undefined => out.find((e) => typeof e.type === 'function' && e.type.name === 'NotesDialog')

/**
 * Where the first element passing `test` sits in the card's tree, as React matches elements
 * between renders: each step is the position among its siblings and the element's type.
 */
function placeOf(node: unknown, test: (e: El) => boolean, path: string[] = []): string | null {
  if (Array.isArray(node)) {
    for (let i = 0; i < node.length; i++) {
      const found = placeOf(node[i], test, [...path, `${i}`])
      if (found) return found
    }
    return null
  }
  if (!node || typeof node !== 'object' || !('props' in node)) return null
  const el = node as El
  const step = [...path, typeof el.type === 'function' ? el.type.name : String(el.type)]
  return test(el) ? step.join('/') : placeOf(el.props.children, test, step)
}
const isOpener = (e: El): boolean => e.type === 'button' && e.props['aria-haspopup'] === 'dialog'

/** Opens the Notes dialog from the card; returns its props. */
async function openDialog(): Promise<{ notes: Controller; onClose: () => void }> {
  render()
  await flush()
  const out = render()
  const open = out.find(isOpener)
  ;(open!.props.onClick as (e: unknown) => void)({ currentTarget: {} })
  return dialogOf(render())!.props as unknown as { notes: Controller; onClose: () => void }
}

beforeEach(() => {
  for (const c of cells) c.cleanup?.()
  cells = []
  effects = []
  Object.assign(store, { text: 'old script', failures: 0, saves: [] })
})

describe('Speaker notes card: a text save that failed (renderer-ui-9)', () => {
  it('is sent again by the next flush (Done, Rehearse, leaving Home)', async () => {
    const dialog = await openDialog()
    store.failures = 1
    dialog.notes.setText('new script')
    await dialog.notes.flushText()
    expect(store.text).toBe('old script')
    // Done closes the dialog: its flush saves the text this time.
    await dialog.notes.flushText()
    dialog.onClose()
    expect(store.text).toBe('new script')
    expect(store.saves).toEqual(['new script'])
    expect(alerts(render())).toEqual([])
  })

  it('shows on the card once the dialog is closed, and goes when a retry saves it', async () => {
    const dialog = await openDialog()
    store.failures = 2
    dialog.notes.setText('new script')
    await dialog.notes.flushText()
    await dialog.notes.flushText()
    dialog.onClose()
    const out = render()
    expect(dialogOf(out)).toBeUndefined()
    expect(alerts(out)).toEqual(['Could not save your notes: EBUSY: resource busy or locked'])
    expect(textOf(out.find((e) => e.props.className === 'notes-summary')?.props.children)).toMatch(/^2 words/)
    // Leaving Home (the card's effects cleaned up) tries once more.
    for (const c of cells) c.cleanup?.()
    await flush()
    expect(store.text).toBe('new script')
  })

  it('is not sent over a newer edit typed while it was being saved', async () => {
    const dialog = await openDialog()
    store.failures = 1
    dialog.notes.setText('first')
    const first = dialog.notes.flushText()
    dialog.notes.setText('second')
    const second = dialog.notes.flushText()
    await Promise.all([first, second])
    await dialog.notes.flushText()
    expect(store.saves).toEqual(['second'])
    expect(store.text).toBe('second')
  })
})

describe('Speaker notes card: the button that opened the dialog (renderer-ui-7)', () => {
  it('stays the same element when the first word is typed or the text is cleared, so the focus can go back to it', async () => {
    store.text = ''
    const dialog = await openDialog()
    const empty = placeOf(tree, isOpener)
    expect(textOf(render().find(isOpener)?.props.children)).toBe('Add notes…')
    dialog.notes.setText('Hello')
    let out = render()
    expect(textOf(out.find(isOpener)?.props.children)).toBe('Edit notes…')
    expect(placeOf(tree, isOpener)).toBe(empty)
    dialog.notes.setText('')
    out = render()
    expect(textOf(out.find(isOpener)?.props.children)).toBe('Add notes…')
    expect(placeOf(tree, isOpener)).toBe(empty)
    await dialog.notes.flushText()
  })
})
