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
/** Whether the clipboard takes the text. */
let clipboardTakes = true
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
/** The page: `activeElement` is the stand-in that has the focus, or the body; querySelector finds a card. */
const page: { body: object; activeElement: unknown; querySelector?: (sel: string) => unknown } = { body: {}, activeElement: null }
vi.stubGlobal('document', page)
vi.stubGlobal('navigator', { clipboard: { writeText: () => (clipboardTakes ? Promise.resolve() : Promise.reject(new Error('Document is not focused'))) } })
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
/** The item a palette command asked for as the dialog opens. */
let request: { kind: string; n: number } | null = null
/** What scrolled the dialog, in order: a card shown, or an element focused without preventScroll. */
const scrolls: string[] = []
/** The elements of the last render (document.querySelector looks in them). */
let tree: El[] = []
/** What went to the editor's notice, which shows behind the dialog (it was given one before). */
const notices: string[] = []
const nameOf = (el: El): string => (el.type === 'button' ? textOf(el.props.children).trim() : el.props.role === 'dialog' ? 'panel' : String(el.type))

/** A stand-in for the element a ref is on: a disabled button does not take the focus. */
function standIn(el: El): { name: string; disabled?: boolean; focus(): void } {
  const disabled = el.type === 'button' ? el.props.disabled === true : undefined
  const stand = {
    name: nameOf(el),
    disabled,
    focus: (options?: { preventScroll?: boolean }) => {
      if (disabled) return
      if (!options?.preventScroll) scrolls.push(stand.name)
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
    const out = walk(PublishDialog({ project: current, request, onClose: () => undefined, onGenerateCaptions: () => undefined, onNotice: (m: string) => notices.push(m) }), [])
    for (const el of out) if (el.ref && typeof el.ref === 'object') (el.ref as { current: unknown }).current = standIn(el)
    tree = out
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
const card = (out: El[], kind: string): El[] => {
  const section = out.find((e) => e.props['data-publish-card'] === kind)
  if (!section) throw new Error(`No ${kind} card`)
  return walk(section.props.children, [])
}
const press = (els: El[], label: string): void => {
  const button = els.find((e) => e.type === 'button' && textOf(e.props.children).trim() === label)
  if (!button) throw new Error(`No "${label}" button`)
  if (button.props.disabled) throw new Error(`"${label}" is disabled`)
  ;(button.props.onClick as () => void)()
}
const type = (els: El[], label: string, value: string): void => {
  const field = els.find((e) => e.type === 'textarea' && e.props['aria-label'] === label)
  if (!field) throw new Error(`No "${label}" field`)
  ;(field.props.onChange as (e: { target: { value: string } }) => void)({ target: { value } })
}
/** What the card says its last action did: [role, text] of each message shown (its status line apart). */
const said = (els: El[]): [string, string][] =>
  els
    .filter((e) => (e.props.role === 'status' || e.props.role === 'alert') && !String(e.props.className).includes('publish-state') && textOf(e.props.children).trim())
    .map((e) => [e.props.role as string, textOf(e.props.children).trim()])

beforeEach(async () => {
  for (const c of cells) c.cleanup?.()
  cells = []
  effects = []
  focused = null
  request = null
  scrolls.length = 0
  notices.length = 0
  page.activeElement = null
  clipboardTakes = true
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

describe("Publish dialog: what a card's buttons did is said on that card (§5.1)", () => {
  it('Copy, and a copy the clipboard refused', async () => {
    let out = await opened()
    type(card(out, 'xpost'), 'X post text', 'New reports are here.')
    out = render()
    press(card(out, 'xpost'), 'Copy')
    await flush()
    out = render()
    expect(said(card(out, 'xpost'))).toEqual([['status', 'X post copied']])

    clipboardTakes = false
    press(card(out, 'xpost'), 'Copy')
    await flush()
    out = render()
    expect(said(card(out, 'xpost'))).toEqual([['alert', 'X post could not be copied']])
    // Only on that card, and not behind the dialog.
    expect(said(card(out, 'linkedin'))).toEqual([])
    expect(notices).toEqual([])
  })

  it('Use for exports, Stop using for exports and Rename the recording', async () => {
    let out = await opened()
    type(card(out, 'youtube'), 'YouTube description text', 'All about the new reports.')
    out = render()
    press(card(out, 'youtube'), 'Use for exports')
    out = render()
    expect(current.publish).toEqual({ description: 'All about the new reports.' })
    expect(said(card(out, 'youtube'))).toEqual([['status', "The export's description file will use this text"]])
    press(card(out, 'youtube'), 'Stop using for exports')
    out = render()
    expect(current.publish).toBeUndefined()
    expect(said(card(out, 'youtube'))).toEqual([['status', "The export's description is back to the standard one"]])

    type(card(out, 'title'), 'Title text', 'New reports')
    out = render()
    press(card(out, 'title'), 'Rename the recording')
    out = render()
    expect(current.name).toBe('New reports')
    expect(said(card(out, 'title'))).toEqual([['status', 'Recording renamed']])
    expect(notices).toEqual([])
  })
})

describe('Publish dialog: a card says when its text is written (§5.2)', () => {
  /** The card's status line (role status), which a screen reader reads out as it changes. */
  const state = (els: El[]): string => {
    const line = els.find((e) => String(e.props.className).includes('publish-state'))
    expect(line?.props.role).toBe('status')
    return textOf(line?.props.children).trim()
  }

  it('Not written yet, Writing… and then Written, not nothing', async () => {
    let out = await opened()
    expect(state(card(out, 'linkedin'))).toBe('Not written yet')
    press(card(out, 'linkedin'), 'Write')
    out = render()
    expect(state(card(out, 'linkedin'))).toMatch(/^(Waiting|Writing)…$/)
    expect(asked.map((a) => a.task)).toEqual(['linkedin'])
    asked[0].answer.resolve({ task: 'linkedin', text: 'The new reports are here.' })
    await flush()
    out = render()
    expect(state(card(out, 'linkedin'))).toBe('Written')
    // Regenerate says it again when the new text is in.
    press(card(out, 'linkedin'), 'Regenerate')
    out = render()
    expect(state(card(out, 'linkedin'))).toMatch(/^(Waiting|Writing)…$/)
    asked[1].answer.resolve({ task: 'linkedin', text: 'The new reports are out now.' })
    await flush()
    out = render()
    expect(state(card(out, 'linkedin'))).toBe('Written')
  })
})

describe('Publish dialog: a palette command shows the card it writes (§5.2)', () => {
  /** document.querySelector for a card: it scrolls into view, and finds its text field. */
  const findCard = (sel: string): unknown => {
    const kind = /^\[data-publish-card="(\w+)"\]$/.exec(sel)?.[1]
    const section = tree.find((e) => e.props['data-publish-card'] === kind)
    if (!section) return null
    const field = walk(section.props.children, []).find((e) => e.type === 'textarea' && String(e.props.className).includes('publish-text'))
    return {
      scrollIntoView: () => scrolls.push(`${kind} card`),
      querySelector: (inner: string) =>
        inner === '.publish-text' && field
          ? {
              focus: (options?: { preventScroll?: boolean }) => {
                const label = String(field.props['aria-label'])
                if (!options?.preventScroll) scrolls.push(label)
                focused = label
                page.activeElement = { name: 'textarea' }
              }
            }
          : null
    }
  }
  beforeEach(() => {
    page.querySelector = findCard
  })

  it('"Write release notes": that card stays in view, with the focus on its text, not on Write all', async () => {
    request = { kind: 'releaseNotes', n: 1 }
    render()
    expect(asked).toEqual([])
    await opened()
    expect(asked.map((a) => a.task)).toEqual(['releaseNotes'])
    expect(scrolls.at(-1)).toBe('releaseNotes card')
    expect(focused).toBe('Release notes text')
  })

  it('opened from its button, the focus is on Write all', async () => {
    await opened()
    expect(asked).toEqual([])
    expect(focused).toBe('Write all')
  })
})
