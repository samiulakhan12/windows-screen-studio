import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'
import { BUSY_COPY, type UpdateState } from '../src/shared/updates/updates'

/*
 * Home's update notice and Settings › About › Updates (docs/design/auto-update.md §1.7) without a
 * DOM: React's hooks are swapped
 * for a few lines that keep each component's state (as in copyMenu.test.ts), a component no longer
 * rendered is unmounted (its layout effects' cleanups first, as React does before it removes the
 * nodes), and the page then drops the focus a removed button had, as a browser does.
 */

interface Cell {
  value?: unknown
  deps?: readonly unknown[]
  current?: unknown
  cleanup?: (() => void) | void
  layout?: boolean
}
interface El {
  type: unknown
  props: Record<string, unknown>
  ref?: unknown
}

/** Each component's hooks, by its name (each shows once here). */
const mounted = new Map<string, Cell[]>()
let cells: Cell[] = []
let at = 0
let effects: { layout: boolean; run: () => void }[] = []
let dirty = false
const cell = (): Cell => (cells[at++] ??= {})
const changed = (a: readonly unknown[] | undefined, b: readonly unknown[] | undefined): boolean => !a || !b || a.length !== b.length || a.some((v, i) => !Object.is(v, b[i]))
const effect =
  (layout: boolean) =>
  (fn: () => (() => void) | void, deps?: unknown[]): void => {
    const c = cell()
    c.layout = layout
    if (!changed(c.deps, deps)) return
    c.deps = deps
    effects.push({
      layout,
      run: () => {
        c.cleanup?.()
        c.cleanup = fn()
      }
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
  useCallback: (fn: unknown) => fn,
  useEffect: effect(false),
  useLayoutEffect: effect(true)
}))

/* ---------- the page: a few nodes, the focus, and main ---------- */

interface FakeNode {
  name: string
  focus(): void
  contains(n: unknown): boolean
  nextElementSibling?: FakeNode
}
const doc = { body: { name: 'body' } as unknown, activeElement: null as unknown }
const nodes = new Map<string, FakeNode>()
function nodeFor(name: string): FakeNode {
  let n = nodes.get(name)
  if (!n) {
    const node: FakeNode = {
      name,
      focus: () => void (doc.activeElement = node),
      // The pill holds its two buttons.
      contains: (o) => o === node || (name === 'pill' && ['Restart now', 'Later'].includes((o as FakeNode | null)?.name ?? ''))
    }
    // The next control in Home's title bar is the Settings button.
    if (name === 'slot') node.nextElementSibling = nodeFor('Settings')
    nodes.set(name, node)
    n = node
  }
  return n
}
vi.stubGlobal('document', doc)

const main = {
  state: null as UpdateState | null,
  listeners: new Set<(s: UpdateState) => void>(),
  install: { ok: true } as { ok: true } | { ok: false; reason: string },
  /** How many times Restart now reached main. */
  installs: 0
}
vi.stubGlobal('window', {
  api: {
    updatesGet: () => Promise.resolve(main.state),
    onUpdatesChanged: (fn: (s: UpdateState) => void) => {
      main.listeners.add(fn)
      return () => main.listeners.delete(fn)
    },
    updatesInstall: () => {
      main.installs++
      return Promise.resolve(main.install)
    }
  },
  // Looked up when called, so fake timers apply.
  setTimeout: (fn: () => void, ms: number) => setTimeout(fn, ms),
  clearTimeout: (t: ReturnType<typeof setTimeout>) => clearTimeout(t)
})

// Renderer code: imported at run time so the Node typecheck of tests/ does not follow it.
const NOTICE = '../src/renderer/src/updates/UpdateNotice'
const BLOCK = '../src/renderer/src/updates/UpdatesBlock'
const HOOKS = '../src/renderer/src/updates/useUpdates'
const { UpdateNotice } = (await import(/* @vite-ignore */ NOTICE)) as { UpdateNotice: () => unknown }
const { UpdatesBlock } = (await import(/* @vite-ignore */ BLOCK)) as { UpdatesBlock: () => unknown }
const { REFUSED_MS, setRecordingBusy } = (await import(/* @vite-ignore */ HOOKS)) as { REFUSED_MS: number; setRecordingBusy: (reason: string | null) => void }

/* ---------- a tiny renderer ---------- */

/** The notice's own nodes (Settings is the title bar's, after it). */
const OWN = ['slot', 'pill', 'Restart now', 'Later']
const nameOf = (el: El): string | null => {
  const cls = typeof el.props.className === 'string' ? el.props.className : ''
  if (cls.includes('update-slot')) return 'slot'
  if (cls.includes('update-pill-btn')) return textOf(el.props.children)
  if (cls.includes('update-pill')) return 'pill'
  return null
}

function expand(node: unknown, out: El[], seen: Set<string>): unknown {
  if (Array.isArray(node)) return node.map((n) => expand(n, out, seen))
  if (!node || typeof node !== 'object' || !('props' in node)) return node
  const el = node as El
  if (typeof el.type === 'function') {
    const fn = el.type as ((p: unknown) => unknown) & { name: string }
    seen.add(fn.name)
    if (!mounted.has(fn.name)) mounted.set(fn.name, [])
    cells = mounted.get(fn.name)!
    at = 0
    return expand(fn(el.props), out, seen)
  }
  out.push(el)
  const name = nameOf(el)
  if (name && el.ref) (el.ref as { current: unknown }).current = nodeFor(name)
  expand(el.props.children, out, seen)
  return el
}

/** `component`, rendered until its state and effects settle. */
function render(component: () => unknown): El[] {
  for (let pass = 0; pass < 20; pass++) {
    dirty = false
    const out: El[] = []
    const seen = new Set<string>()
    expand({ type: component, props: {} }, out, seen)
    // Gone: layout cleanups run before the nodes go, then the page loses a focus it held.
    for (const [name, hooks] of [...mounted]) {
      if (seen.has(name)) continue
      mounted.delete(name)
      for (const c of hooks) if (c.layout) c.cleanup?.()
      for (const c of hooks) if (!c.layout) c.cleanup?.()
    }
    const shown = new Set(out.map(nameOf))
    const focused = (doc.activeElement as FakeNode | null)?.name ?? ''
    if (OWN.includes(focused) && !shown.has(focused)) doc.activeElement = doc.body
    const run = effects
    effects = []
    run.filter((e) => e.layout).forEach((e) => e.run())
    run.filter((e) => !e.layout).forEach((e) => e.run())
    if (!dirty) return out
  }
  throw new Error('The component keeps rendering')
}
/** Main's answers arrive, then it renders again. */
async function settle(component: () => unknown): Promise<El[]> {
  for (let i = 0; i < 10; i++) await Promise.resolve()
  return render(component)
}

const textOf = (node: unknown): string =>
  Array.isArray(node) ? node.map(textOf).join('') : typeof node === 'string' || typeof node === 'number' ? String(node) : node && typeof node === 'object' && 'props' in node ? textOf((node as El).props.children) : ''
const button = (out: El[], label: string): El | undefined => out.find((e) => e.type === 'button' && textOf(e.props.children) === label)
const pillOf = (out: El[]): El | undefined => out.find((e) => e.props['data-testid'] === 'update-notice')
const ready = (version: string): UpdateState => ({ phase: 'ready', current: '0.7.1', version, lastCheck: null, auto: true })
/** Main's state changes. */
const emit = (s: UpdateState): void => {
  main.state = s
  for (const l of main.listeners) l(s)
}

afterEach(() => {
  vi.useRealTimers()
})
beforeEach(() => {
  for (const hooks of mounted.values()) for (const c of hooks) c.cleanup?.()
  mounted.clear()
  effects = []
  nodes.clear()
  main.listeners.clear()
  main.install = { ok: true }
  main.installs = 0
  doc.activeElement = doc.body
})

describe("Home's update notice (docs/design/auto-update.md §1.7)", () => {
  it('Later hides it and the focus moves on to Settings, not to the page', async () => {
    main.state = ready('9.9.1')
    const view = UpdateNotice
    let out = render(view)
    out = await settle(view)
    expect(textOf(pillOf(out))).toContain('Flown 9.9.1 is ready. It installs when you close Flown.')
    // From the keyboard: Tab to Later, then Enter.
    nodeFor('Later').focus()
    ;(button(out, 'Later')!.props.onClick as () => void)()
    out = render(view)
    expect(pillOf(out)).toBeUndefined()
    expect(doc.activeElement).toBe(nodeFor('Settings'))
  })

  it('goes while Restart now has the focus (the update is no longer ready): the focus moves on to Settings', async () => {
    main.state = ready('9.9.2')
    const view = UpdateNotice
    render(view)
    await settle(view)
    nodeFor('Restart now').focus()
    emit({ phase: 'idle', current: '0.7.1', lastCheck: '2026-10-31T10:00:00.000Z', auto: true })
    const out = render(view)
    expect(pillOf(out)).toBeUndefined()
    expect(doc.activeElement).toBe(nodeFor('Settings'))
  })

  it('goes while the focus is elsewhere: the focus stays where it is', async () => {
    main.state = ready('9.9.3')
    const view = UpdateNotice
    render(view)
    await settle(view)
    emit({ phase: 'idle', current: '0.7.1', lastCheck: '2026-10-31T10:00:00.000Z', auto: true })
    render(view)
    expect(doc.activeElement).toBe(doc.body)
  })
})

const EXPORTING = 'Finish or stop the export first.'

describe('why Restart now was refused (docs/design/auto-update.md §1.7)', () => {
  it("Home: the reason shows for a while, then the notice says the update is ready again", async () => {
    vi.useFakeTimers()
    main.state = ready('9.9.4')
    main.install = { ok: false, reason: EXPORTING }
    const view = UpdateNotice
    render(view)
    let out = await settle(view)
    ;(button(out, 'Restart now')!.props.onClick as () => void)()
    out = await settle(view)
    expect(textOf(pillOf(out))).toContain(EXPORTING)
    // The export ends; main says nothing about it.
    vi.advanceTimersByTime(REFUSED_MS)
    out = render(view)
    expect(textOf(pillOf(out))).toContain('Flown 9.9.4 is ready. It installs when you close Flown.')
    expect(textOf(pillOf(out))).not.toContain(EXPORTING)
  })

  it('Home: the same reason again shows for its full time again', async () => {
    vi.useFakeTimers()
    main.state = ready('9.9.5')
    main.install = { ok: false, reason: EXPORTING }
    const view = UpdateNotice
    render(view)
    let out = await settle(view)
    ;(button(out, 'Restart now')!.props.onClick as () => void)()
    out = await settle(view)
    vi.advanceTimersByTime(REFUSED_MS - 1000)
    ;(button(out, 'Restart now')!.props.onClick as () => void)()
    out = await settle(view)
    vi.advanceTimersByTime(2000)
    out = render(view)
    expect(textOf(pillOf(out))).toContain(EXPORTING)
  })

  it('Home: a newer version ready replaces the reason at once', async () => {
    main.state = ready('9.9.6')
    main.install = { ok: false, reason: EXPORTING }
    const view = UpdateNotice
    render(view)
    let out = await settle(view)
    ;(button(out, 'Restart now')!.props.onClick as () => void)()
    out = await settle(view)
    expect(textOf(pillOf(out))).toContain(EXPORTING)
    emit(ready('9.9.7'))
    out = render(view)
    expect(textOf(pillOf(out))).toContain('Flown 9.9.7 is ready. It installs when you close Flown.')
  })

  const refusedOf = (out: El[]): El | undefined => out.find((e) => e.props['data-testid'] === 'updates-refused')
  const action = (out: El[]): El => out.find((e) => e.props['data-testid'] === 'updates-action')!

  it('Settings: the reason goes after a while, and at once when the update moves on', async () => {
    vi.useFakeTimers()
    main.state = ready('9.9.8')
    main.install = { ok: false, reason: EXPORTING }
    const view = UpdatesBlock
    render(view)
    let out = await settle(view)
    ;(action(out).props.onClick as () => void)()
    out = await settle(view)
    expect(refusedOf(out)?.props.role).toBe('alert')
    expect(textOf(refusedOf(out))).toBe(EXPORTING)
    vi.advanceTimersByTime(REFUSED_MS)
    out = render(view)
    expect(refusedOf(out)).toBeUndefined()

    ;(action(out).props.onClick as () => void)()
    out = await settle(view)
    expect(textOf(refusedOf(out))).toBe(EXPORTING)
    // The release was pulled: the button is Check for updates again, and the reason about it goes.
    emit({ phase: 'idle', current: '0.7.1', lastCheck: '2026-10-31T10:00:00.000Z', auto: true })
    out = render(view)
    expect(textOf(action(out).props.children)).toBe('Check for updates')
    expect(refusedOf(out)).toBeUndefined()
  })
})

describe('Restart now while Home makes, saves or processes a recording (docs/design/auto-update.md §1.5)', () => {
  const PROCESSING = BUSY_COPY.processing
  const refusedOf = (out: El[]): El | undefined => out.find((e) => e.props['data-testid'] === 'updates-refused')
  const action = (out: El[]): El => out.find((e) => e.props['data-testid'] === 'updates-action')!

  // Main cannot see a recording being saved or processed, and a quit then asks first (Keep working
  // or Quit anyway), where Quit anyway would install without reopening Flown.
  it('Home and Settings give the reason and never ask main; once it is done, main is asked', async () => {
    main.state = ready('9.9.10')
    try {
      setRecordingBusy(PROCESSING)
      const notice = UpdateNotice
      render(notice)
      let out = await settle(notice)
      ;(button(out, 'Restart now')!.props.onClick as () => void)()
      out = await settle(notice)
      expect(textOf(pillOf(out))).toContain(PROCESSING)

      const block = UpdatesBlock
      render(block)
      out = await settle(block)
      ;(action(out).props.onClick as () => void)()
      out = await settle(block)
      expect(textOf(refusedOf(out))).toBe(PROCESSING)
      expect(main.installs).toBe(0)

      setRecordingBusy(null)
      ;(action(out).props.onClick as () => void)()
      out = await settle(block)
      expect(main.installs).toBe(1)
      expect(refusedOf(out)).toBeUndefined()
    } finally {
      setRecordingBusy(null)
    }
  })
})

describe('Settings: what a screen reader hears (docs/design/auto-update.md §1.7)', () => {
  const live = (out: El[]): El[] => out.filter((e) => e.props.role === 'status' || e.props.role === 'alert' || 'aria-live' in e.props)
  const statusOf = (out: El[]): El => out.find((e) => e.props['data-testid'] === 'updates-status')!
  /** The block's text as a screen reader reads it down the page (browse mode): aria-hidden parts are skipped. */
  const readable = (node: unknown): string =>
    Array.isArray(node)
      ? node.map(readable).join('')
      : typeof node === 'string' || typeof node === 'number'
        ? String(node)
        : node && typeof node === 'object' && 'props' in node && !(node as El).props['aria-hidden']
          ? readable((node as El).props.children)
          : ''
  const timesRead = (out: El[], words: string): number => readable(out[0]).split(words).length - 1

  it('announces a download once, not at every percent; the page still shows the percent', async () => {
    main.state = { phase: 'available', current: '0.7.1', version: '9.9.9', lastCheck: null, auto: false }
    const view = UpdatesBlock
    render(view)
    let out = await settle(view)
    // The live region is there before the download starts, so its first change is read out.
    expect(live(out).map((e) => textOf(e.props.children))).toEqual(['Flown 9.9.9 is available.'])
    expect(timesRead(out, 'Flown 9.9.9 is available.')).toBe(1)
    const heard = new Set<string>()
    for (const percent of [1, 12, 13, 14, 60, 99]) {
      emit({ phase: 'downloading', current: '0.7.1', version: '9.9.9', percent, lastCheck: null, auto: false })
      out = render(view)
      expect(textOf(statusOf(out).props.children)).toBe(`Downloading Flown 9.9.9… ${percent}%`)
      expect(timesRead(out, 'Downloading Flown 9.9.9…')).toBe(1)
      for (const e of live(out)) heard.add(textOf(e.props.children))
    }
    expect([...heard]).toEqual(['Downloading Flown 9.9.9…'])
    emit(ready('9.9.9'))
    out = render(view)
    expect(live(out).map((e) => textOf(e.props.children))).toEqual(['Flown 9.9.9 is ready. It installs when you close Flown.'])
    expect(timesRead(out, 'Flown 9.9.9 is ready.')).toBe(1)
  })

  it('reads the status once when the page is read down, with the last check', async () => {
    main.state = { phase: 'idle', current: '0.7.1', lastCheck: new Date().toISOString(), auto: true }
    const view = UpdatesBlock
    render(view)
    const out = await settle(view)
    // The visible line is hidden from screen readers; the live region says the same words.
    expect(statusOf(out).props['aria-hidden']).toBe('true')
    expect(timesRead(out, 'Flown is up to date.')).toBe(1)
    expect(timesRead(out, 'Last checked')).toBe(1)
  })
})
