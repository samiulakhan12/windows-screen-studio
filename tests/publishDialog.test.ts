import { beforeEach, describe, expect, it, vi } from 'vitest'
import { createProject } from '../src/shared/engine/project'
import type { Project } from '../src/shared/types'

/*
 * The Publish dialog (docs/design/publish-pack.md §5) without a DOM: React's hooks are swapped for a
 * few lines that keep the dialog's state (as in polishDialog.test.ts), each ref is pointed at a
 * stand-in for its element before the effects run (a disabled button ignores focus(), as in a
 * browser), and a focused element that is no longer rendered leaves the focus on the page's body.
 * The cards are called as functions (they have no hooks), so their buttons can be pressed.
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
  ref?: unknown
}

let cells: Cell[] = []
let at = 0
let effects: (() => void)[] = []
let dirty = false
const cell = (): Cell => (cells[at++] ??= {})
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

const OPENAI = { id: 'o', kind: 'openai', label: '', model: 'm', transcriptionModel: 't', maskedKey: '', createdAt: '' }
/** The providers list waits for this. */
let providersGate = deferred<void>()
/** What the AI provider was asked (window.api.aiText), each with its answer to give. */
const asked: { task: string; answer: ReturnType<typeof deferred<unknown>> }[] = []
vi.stubGlobal('window', {
  api: {
    listAiProviders: () => providersGate.promise.then(() => [OPENAI]),
    aiText: (_provider: string, request: { task: string }) => {
      const answer = deferred<unknown>()
      asked.push({ task: request.task, answer })
      return answer.promise
    },
    cancelAiText: () => Promise.resolve()
  },
  addEventListener: () => undefined,
  removeEventListener: () => undefined,
  dispatchEvent: () => true,
  setTimeout: (fn: () => void, ms: number) => setTimeout(fn, ms),
  clearTimeout: (id: ReturnType<typeof setTimeout>) => clearTimeout(id)
})
/** The page: `activeElement` is the stand-in that has the focus, or the body. */
const page: { body: object; activeElement: unknown } = { body: {}, activeElement: null }
vi.stubGlobal('document', page)
vi.stubGlobal(
  'MutationObserver',
  class {
    observe(): void {}
    disconnect(): void {}
  }
)

/** A recording with sound and a few sentences of captions. */
const base: Project = {
  ...createProject({
    id: 'p',
    name: 'Demo',
    duration: 12,
    width: 1280,
    height: 720,
    hasWebcam: false,
    hasAudio: true,
    webcamOffset: 0,
    zooms: [],
    cursorValid: false,
    capture: { method: 'chromium', cursorInVideo: false, region: null }
  }),
  transcript: {
    provider: 'openai',
    model: 'm',
    createdAt: '',
    segments: [
      { id: 'a', start: 0, end: 4, text: 'Open the settings page first.' },
      { id: 'b', start: 4, end: 8, text: 'Then turn on the new reports and press save.' }
    ]
  }
}
let current: Project = base
let projects = 0
const store = {
  get state() {
    return current
  },
  update(fn: (p: Project) => Project) {
    current = fn(current)
    dirty = true
  },
  subscribe: () => () => undefined,
  getSnapshot: () => current
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
  // The pack's items change outside a render: each render reads them again.
  useSyncExternalStore: (_subscribe: unknown, get: () => unknown) => get(),
  // useEditor() is the only context the dialog reads.
  useContext: () => ({ store, player: {} })
}))
// Tab and Esc are not what is tested, and the hook reads the real document.
vi.doMock('../src/renderer/src/editor/modalFocus', () => ({ useModalFocus: () => undefined }))

// Renderer code: imported at run time so the Node typecheck of tests/ does not follow it.
const DIALOG = '../src/renderer/src/publish/PublishDialog'
const { PublishDialog } = (await import(/* @vite-ignore */ DIALOG)) as { PublishDialog: (props: unknown) => unknown }

const textOf = (node: unknown): string =>
  Array.isArray(node) ? node.map(textOf).join('') : typeof node === 'string' || typeof node === 'number' ? String(node) : node && typeof node === 'object' && 'props' in node ? textOf((node as El).props.children) : ''

/** Every element in the tree; the cards are called (other components are not). */
function walk(node: unknown, out: El[]): El[] {
  if (Array.isArray(node)) {
    node.forEach((n) => walk(n, out))
    return out
  }
  if (!node || typeof node !== 'object' || !('props' in node)) return out
  const el = node as El
  if (typeof el.type === 'function' && el.type.name === 'Card') return walk((el.type as (p: unknown) => unknown)(el.props), out)
  out.push(el)
  walk(el.props.children, out)
  return out
}

/** What has the focus: a button's text, 'panel' for the dialog itself, null while it is still behind the modal. */
let focused: string | null = null
const nameOf = (el: El): string => (el.type === 'button' ? textOf(el.props.children).trim() : el.props.role === 'dialog' ? 'panel' : String(el.type))

/** A stand-in for the element a ref is on: a disabled button does not take the focus. */
function standIn(el: El): { name: string; disabled?: boolean; focus(): void } {
  const disabled = el.type === 'button' ? el.props.disabled === true : undefined
  const stand = {
    name: nameOf(el),
    disabled,
    focus: () => {
      if (disabled) return
      focused = stand.name
      page.activeElement = stand
    }
  }
  return stand
}

/** The dialog, rendered until its state and effects settle; the refs are attached before the effects run, as React does. */
function render(): El[] {
  for (let pass = 0; pass < 20; pass++) {
    dirty = false
    at = 0
    const out = walk(PublishDialog({ project: current, request: null, onClose: () => undefined, onGenerateCaptions: () => undefined }), [])
    for (const el of out) if (el.ref && typeof el.ref === 'object') (el.ref as { current: unknown }).current = standIn(el)
    // A focused element that is gone leaves the focus on the body.
    const active = page.activeElement as { name?: string } | null
    if (active && active !== page.body && !out.some((el) => nameOf(el) === active.name)) page.activeElement = page.body
    const run = effects
    effects = []
    run.forEach((e) => e())
    if (!dirty) return out
  }
  throw new Error('The dialog keeps rendering')
}

const flush = (): Promise<void> => new Promise((r) => setTimeout(r, 0))
/** The dialog once the providers are read. */
async function opened(): Promise<El[]> {
  render()
  providersGate.resolve()
  await flush()
  return render()
}
const press = (els: El[], label: string): void => {
  const button = els.find((e) => e.type === 'button' && textOf(e.props.children).trim() === label)
  if (!button) throw new Error(`No "${label}" button`)
  if (button.props.disabled) throw new Error(`"${label}" is disabled`)
  ;(button.props.onClick as () => void)()
}

beforeEach(async () => {
  for (const c of cells) c.cleanup?.()
  cells = []
  effects = []
  focused = null
  page.activeElement = null
  // Requests a test left out end, so the next test has the queue to itself.
  for (const a of asked.splice(0)) a.answer.reject(new Error('gone'))
  await flush()
  providersGate = deferred<void>()
  // Each test has its own project: the cards are kept per project for the session.
  current = { ...base, id: `p${++projects}` }
})

describe('Publish dialog: the focus when it opens (§5.2)', () => {
  it('is on the dialog while the providers are read, then on Write all', async () => {
    render()
    expect(focused).toBe('panel')
    await opened()
    expect(focused).toBe('Write all')
  })

  it('is on the dialog for a recording without sound, which has no button', async () => {
    current = { ...current, hasAudio: false, transcript: undefined }
    render()
    expect(focused).toBe('panel')
    const out = await opened()
    expect(out.some((e) => e.props['data-blocker'] === 'no-sound')).toBe(true)
    expect(focused).toBe('panel')
  })

  it('is on the dialog for captions with too little speech, which have no button', async () => {
    current = { ...current, transcript: { ...base.transcript!, segments: [{ id: 'a', start: 0, end: 2, text: 'Hello there.' }] } }
    const out = await opened()
    expect(out.some((e) => e.props['data-blocker'] === 'too-little')).toBe(true)
    expect(focused).toBe('panel')
  })
})

describe('Publish dialog: Stop all keeps the focus in the dialog (§5.2)', () => {
  /** A keyboard user tabbed to Stop all. */
  const onStopAll = (out: El[]): void => {
    expect(out.some((e) => e.type === 'button' && textOf(e.props.children).trim() === 'Stop all')).toBe(true)
    focused = 'Stop all'
    page.activeElement = { name: 'Stop all' }
  }

  it('pressed: the focus goes to Write all, not the page', async () => {
    let out = await opened()
    press(out, 'Write all')
    out = render()
    expect(asked).toHaveLength(2)
    onStopAll(out)
    press(out, 'Stop all')
    await flush()
    out = render()
    expect(out.some((e) => e.type === 'button' && textOf(e.props.children).trim() === 'Stop all')).toBe(false)
    expect(focused).toBe('Write all')
    expect(page.activeElement).not.toBe(page.body)
  })

  it('gone when the last item is written: the focus goes to Write all again', async () => {
    let out = await opened()
    press(out, 'Write all')
    onStopAll(render())
    for (let i = 0; i < 7; i++) {
      const a = asked[i]
      a.answer.resolve(a.task === 'youtube' ? { task: a.task, text: 'About the reports.', tags: ['reports'] } : { task: a.task, text: 'About the reports.' })
      await flush()
      out = render()
    }
    expect(out.some((e) => e.type === 'button' && textOf(e.props.children).trim() === 'Stop all')).toBe(false)
    expect(focused).toBe('Write all again')
  })

  it('leaves the focus where it is when that is still in the dialog', async () => {
    let out = await opened()
    press(out, 'Write all')
    render()
    const field = { name: 'textarea' }
    page.activeElement = field
    focused = 'textarea'
    press(render(), 'Stop all')
    await flush()
    out = render()
    expect(focused).toBe('textarea')
    expect(page.activeElement).toBe(field)
  })
})
