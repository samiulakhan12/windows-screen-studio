import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'

/*
 * The title bar's copy menu, the progress of a copy, and the editor's flow that makes one
 * (docs/design/vertical-video.md §2.2, §2.3, test 65), without a DOM: React's hooks are swapped
 * for a few lines that keep the components' state (as in notesCard.test.ts), elements get fake
 * DOM nodes for their refs (focus is recorded), and window.api is a stub of the main process.
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
interface Key {
  key: string
  prevented: boolean
  stopped: boolean
  preventDefault(): void
  stopPropagation(): void
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
/** What the progress dialog asked of useModalFocus: its Esc action. */
const modal = { onClose: null as (() => void) | null }
vi.doMock('../src/renderer/src/editor/modalFocus', () => ({
  useModalFocus: (_ref: unknown, onClose: () => void) => {
    modal.onClose = onClose
  }
}))

/** The document: pointer listeners (a press elsewhere closes the menu) and a canvas to measure text on. */
const docListeners = new Map<string, (e: unknown) => void>()
const measured: string[] = []
vi.stubGlobal('document', {
  body: {},
  addEventListener: (type: string, fn: (e: unknown) => void) => docListeners.set(type, fn),
  removeEventListener: (type: string) => docListeners.delete(type),
  createElement: () => ({
    getContext: () => ({
      font: '',
      measureText(text: string) {
        measured.push(`${this.font}|${text}`)
        return { width: text.length * 10 }
      }
    })
  })
})

/** The main process: the copy it is making, its progress listeners, Cancel and Delete. */
const api = {
  calls: [] as [string, import('../src/shared/types').Project][],
  pending: null as { resolve: (r: unknown) => void; reject: (e: unknown) => void } | null,
  listeners: new Set<(p: unknown) => void>(),
  cancelled: 0,
  deleted: [] as string[]
}
vi.stubGlobal('window', {
  api: {
    duplicateProject: (id: string, copy: import('../src/shared/types').Project) => {
      api.calls.push([id, copy])
      return new Promise((resolve, reject) => (api.pending = { resolve, reject }))
    },
    onDuplicateProgress: (fn: (p: unknown) => void) => {
      api.listeners.add(fn)
      return () => api.listeners.delete(fn)
    },
    cancelDuplicate: () => void api.cancelled++,
    deleteProject: (id: string) => {
      api.deleted.push(id)
      return Promise.resolve()
    }
  }
})

// Renderer code: imported at run time so the Node typecheck of tests/ does not follow it.
const MENU = '../src/renderer/src/editor/CopyMenu'
const FLOW = '../src/renderer/src/editor/duplicateFlow'
type Project = import('../src/shared/types').Project
type CopyKind = import('../src/shared/editor/duplicate').CopyKind
type Progress = import('../src/shared/api/projects').DuplicateProgress
const { CopyMenu, CopyProgress } = (await import(/* @vite-ignore */ MENU)) as {
  CopyMenu: (props: { project: Project; vw: number; vh: number; run(kind: CopyKind): void }) => unknown
  CopyProgress: (props: { kind: CopyKind; name: string; progress: Progress | null; onCancel(): void }) => unknown
}
const { runDuplicate } = (await import(/* @vite-ignore */ FLOW)) as {
  runDuplicate: (
    kind: CopyKind,
    deps: { project: Project; flush(): Promise<boolean>; confirm(msg: string): boolean; onProgress(p: Progress | null): void; signal: AbortSignal }
  ) => Promise<{ id: string; notice: string } | null>
}
const { createProject } = await import('../src/shared/engine/project')

/* ---------- a tiny renderer ---------- */

/** The element whose node has the focus (by data-testid, or 'menu' for the menu itself). */
let focused: string | null = null
const nodes = new Map<string, { name: string; focus(): void; contains(n: unknown): boolean }>()
function nodeFor(name: string) {
  let n = nodes.get(name)
  if (!n) {
    // The menu holds its items.
    const node = {
      name,
      focus: () => void (focused = name),
      contains: (o: unknown) => o === node || (name === 'menu' && /^copy-(vertical|square|duplicate)$/.test((o as { name?: string } | null)?.name ?? ''))
    }
    nodes.set(name, node)
    n = node
  }
  return n
}

/** Function components called, refs given fake nodes; returns every host element. */
function expand(node: unknown, out: El[]): unknown {
  if (Array.isArray(node)) return node.map((n) => expand(n, out))
  if (!node || typeof node !== 'object' || !('props' in node)) return node
  const el = node as El
  if (typeof el.type === 'function') return expand((el.type as (p: unknown) => unknown)(el.props), out)
  out.push(el)
  const name = (el.props['data-testid'] as string | undefined) ?? (el.props.role === 'menu' ? 'menu' : null)
  if (name && el.ref) {
    if (typeof el.ref === 'function') (el.ref as (n: unknown) => void)(nodeFor(name))
    else (el.ref as { current: unknown }).current = nodeFor(name)
  }
  expand(el.props.children, out)
  return el
}

/** `component`, rendered until its state and effects settle. */
function render(component: () => unknown): El[] {
  for (let pass = 0; pass < 20; pass++) {
    dirty = false
    at = 0
    const out: El[] = []
    expand(component(), out)
    const run = effects
    effects = []
    run.forEach((e) => e())
    if (!dirty) return out
  }
  throw new Error('The component keeps rendering')
}

const textOf = (node: unknown): string =>
  Array.isArray(node) ? node.map(textOf).join('') : typeof node === 'string' || typeof node === 'number' ? String(node) : node && typeof node === 'object' && 'props' in node ? textOf((node as El).props.children) : ''
const byId = (out: El[], id: string): El | undefined => out.find((e) => e.props['data-testid'] === id)
const menuOf = (out: El[]): El | undefined => out.find((e) => e.props.role === 'menu')
const key = (k: string): Key => ({
  key: k,
  prevented: false,
  stopped: false,
  preventDefault() {
    this.prevented = true
  },
  stopPropagation() {
    this.stopped = true
  }
})

function project(width = 1920, height = 1080, over: Partial<Project> = {}): Project {
  return {
    ...createProject({
      id: 'rec-20261028-101500',
      name: 'Billing demo',
      duration: 20,
      width,
      height,
      hasWebcam: false,
      hasAudio: true,
      webcamOffset: 0,
      zooms: [],
      cursorValid: true,
      capture: { method: 'native', cursorInVideo: false, region: null }
    }),
    ...over
  }
}
const following = (aspectRatio: '9:16' | '1:1'): Project =>
  project(1920, 1080, {
    style: { ...project().style, aspectRatio },
    reframe: { mode: 'follow', level: 1, camera: aspectRatio === '9:16' ? 'top' : 'bubble', band: 0.32, pace: 'balanced', appSafe: aspectRatio === '9:16' }
  })

beforeEach(() => {
  for (const c of cells) c.cleanup?.()
  cells = []
  effects = []
  focused = null
  nodes.clear()
  docListeners.clear()
  measured.length = 0
  modal.onClose = null
  Object.assign(api, { calls: [], pending: null, cancelled: 0, deleted: [] })
  api.listeners.clear()
})
afterEach(() => {
  vi.useRealTimers()
})

/* ---------- the menu ---------- */

describe('the copy menu (test 65)', () => {
  const ran: CopyKind[] = []
  beforeEach(() => {
    ran.length = 0
  })
  const menu = (p = project(), vw = 1920, vh = 1080) => () => CopyMenu({ project: p, vw, vh, run: (k) => ran.push(k) })

  it('is a button that opens a menu of three items', () => {
    const view = menu()
    let out = render(view)
    const button = byId(out, 'copy-menu')!
    expect(button.props).toMatchObject({ title: 'Duplicate or make a vertical version', 'aria-label': 'Duplicate or make a vertical version', 'aria-haspopup': 'menu', 'aria-expanded': false })
    expect(menuOf(out)).toBeUndefined()
    ;(button.props.onClick as () => void)()
    out = render(view)
    expect(byId(out, 'copy-menu')!.props['aria-expanded']).toBe(true)
    const items = out.filter((e) => e.props.role === 'menuitem')
    expect(items.map((e) => e.props['data-testid'])).toEqual(['copy-vertical', 'copy-square', 'copy-duplicate'])
    expect(items.map((e) => textOf(e.props.children))).toEqual([
      'Make a vertical versionA 9:16 copy that follows your cursor, for TikTok, Reels and Shorts',
      'Make a square versionA 1:1 copy that follows your cursor',
      'DuplicateA copy you can edit separately'
    ])
    expect(items.every((e) => e.props['aria-disabled'] === undefined)).toBe(true)
    // Opened by a click or Enter, the menu itself has the focus: Down goes to the first item.
    expect(focused).toBe('menu')
  })

  /** The menu's items for a project, opened. */
  const itemsOf = (p: Project, vw: number, vh: number): El[] => {
    cells = []
    const view = menu(p, vw, vh)
    ;(byId(render(view), 'copy-menu')!.props.onClick as () => void)()
    return render(view).filter((e) => e.props.role === 'menuitem')
  }
  const reasons = (items: El[]): (string | null)[] => items.map((e) => (e.props['aria-disabled'] ? textOf((e.props.children as El[])[1]) : null))

  it('says why an item cannot run, in its second line', () => {
    expect(reasons(itemsOf(following('9:16'), 1920, 1080))).toEqual(['This video already follows the action', null, null])
    expect(reasons(itemsOf(following('1:1'), 1920, 1080))).toEqual([null, 'This video already follows the action', null])
    expect(reasons(itemsOf(project(1080, 1920), 1080, 1920))).toEqual(['Your recording is already tall', 'Your recording is already square or tall', null])
    expect(reasons(itemsOf(project(1080, 1080), 1080, 1080))).toEqual([null, 'Your recording is already square or tall', null])
  })

  it('moves with Up and Down (Home, End), runs with Enter and gives the focus back to the button', () => {
    const view = menu()
    ;(byId(render(view), 'copy-menu')!.props.onClick as () => void)()
    let out = render(view)
    const press = (k: string): Key => {
      const e = key(k)
      ;(menuOf(out)!.props.onKeyDown as (e: Key) => void)(e)
      out = render(view)
      return e
    }
    const down = press('ArrowDown')
    expect(focused).toBe('copy-vertical')
    // The menu's keys never reach the editor's shortcuts.
    expect([down.prevented, down.stopped]).toEqual([true, true])
    press('ArrowDown')
    expect(focused).toBe('copy-square')
    press('ArrowDown')
    press('ArrowDown')
    expect(focused).toBe('copy-vertical')
    press('ArrowUp')
    expect(focused).toBe('copy-duplicate')
    press('Home')
    expect(focused).toBe('copy-vertical')
    press('End')
    expect(focused).toBe('copy-duplicate')
    expect(out.filter((e) => e.props.role === 'menuitem').map((e) => e.props.tabIndex)).toEqual([-1, -1, 0])
    press('ArrowUp')
    press('Enter')
    expect(ran).toEqual(['square'])
    expect(menuOf(out)).toBeUndefined()
    expect(focused).toBe('copy-menu')
  })

  it('closes with Esc and gives the focus back to the button; Down on the button opens it at the first item', () => {
    const view = menu()
    const out = render(view)
    const e = key('ArrowDown')
    ;(byId(out, 'copy-menu')!.props.onKeyDown as (e: Key) => void)(e)
    let now = render(view)
    expect(menuOf(now)).toBeDefined()
    expect(focused).toBe('copy-vertical')
    const esc = key('Escape')
    ;(menuOf(now)!.props.onKeyDown as (e: Key) => void)(esc)
    now = render(view)
    expect(menuOf(now)).toBeUndefined()
    expect(focused).toBe('copy-menu')
    expect([esc.prevented, esc.stopped]).toEqual([true, true])
    expect(ran).toEqual([])
  })

  it('does not run an item that cannot run, by key or by click', () => {
    const view = menu(following('9:16'))
    ;(byId(render(view), 'copy-menu')!.props.onClick as () => void)()
    let out = render(view)
    ;(menuOf(out)!.props.onKeyDown as (e: Key) => void)(key('ArrowDown'))
    out = render(view)
    ;(menuOf(out)!.props.onKeyDown as (e: Key) => void)(key('Enter'))
    out = render(view)
    ;(byId(out, 'copy-vertical')!.props.onClick as () => void)()
    out = render(view)
    expect(ran).toEqual([])
    expect(menuOf(out)).toBeDefined()
    ;(byId(out, 'copy-duplicate')!.props.onClick as () => void)()
    expect(ran).toEqual(['copy'])
  })

  it('closes when the pointer is pressed elsewhere', () => {
    const view = menu()
    ;(byId(render(view), 'copy-menu')!.props.onClick as () => void)()
    render(view)
    docListeners.get('pointerdown')!({ target: nodeFor('copy-square') })
    expect(menuOf(render(view))).toBeDefined()
    docListeners.get('pointerdown')!({ target: { elsewhere: true } })
    expect(menuOf(render(view))).toBeUndefined()
    expect(docListeners.has('pointerdown')).toBe(false)
  })
})

/* ---------- the progress window ---------- */

describe('the progress of a copy (test 65)', () => {
  it('appears only after 0.5 s, with what is copied, a progress bar and Cancel', () => {
    vi.useFakeTimers()
    let cancels = 0
    let progress: Progress | null = null
    const view = () => CopyProgress({ kind: 'vertical', name: 'Billing demo', progress, onCancel: () => void cancels++ })
    expect(byId(render(view), 'copy-progress')).toBeUndefined()
    vi.advanceTimersByTime(499)
    expect(byId(render(view), 'copy-progress')).toBeUndefined()
    // Not shown yet: Esc is not taken from the editor.
    expect(modal.onClose).toBeNull()
    vi.advanceTimersByTime(1)
    let out = render(view)
    const dialog = byId(out, 'copy-progress')!
    expect(dialog.props).toMatchObject({ role: 'dialog', 'aria-modal': 'true' })
    expect(textOf(out.find((e) => e.type === 'h2'))).toBe('Making a vertical version')
    expect(textOf(out.find((e) => e.props.id === 'copy-progress-body'))).toBe('Copying “Billing demo”. Your original stays as it is.')

    progress = { done: 0.7e9, total: 1.4e9 }
    out = render(view)
    expect(textOf(out.find((e) => e.props.id === 'copy-progress-body'))).toBe('Copying “Billing demo” (1.4 GB). Your original stays as it is.')
    expect(out.find((e) => e.props.role === 'progressbar')!.props).toMatchObject({ 'aria-valuenow': 0.7e9, 'aria-valuemax': 1.4e9, 'aria-valuetext': '50%' })

    const cancel = out.find((e) => e.type === 'button' && textOf(e.props.children) === 'Cancel')!
    ;(cancel.props.onClick as () => void)()
    expect(cancels).toBe(1)
    // Esc cancels too.
    modal.onClose!()
    expect(cancels).toBe(2)
  })

  it('is titled by the kind of copy', () => {
    vi.useFakeTimers()
    for (const [kind, title] of [
      ['square', 'Making a square version'],
      ['copy', 'Making a copy']
    ] as const) {
      for (const c of cells) c.cleanup?.()
      cells = []
      const view = () => CopyProgress({ kind, name: 'x', progress: null, onCancel: () => undefined })
      render(view)
      vi.advanceTimersByTime(500)
      expect(textOf(render(view).find((e) => e.type === 'h2'))).toBe(title)
    }
  })
})

/* ---------- making the copy ---------- */

describe('runDuplicate (test 65)', () => {
  const flow = (kind: CopyKind, over: { project?: Project; saved?: boolean; confirm?: boolean } = {}) => {
    const abort = new AbortController()
    const asked: string[] = []
    const progress: (Progress | null)[] = []
    const made = runDuplicate(kind, {
      project: over.project ?? project(),
      flush: () => Promise.resolve(over.saved ?? true),
      confirm: (msg) => {
        asked.push(msg)
        return over.confirm ?? false
      },
      onProgress: (p) => progress.push(p),
      signal: abort.signal
    })
    return { made, abort, asked, progress }
  }
  const tick = (): Promise<void> => new Promise((r) => setTimeout(r, 0))
  const sendProgress = (p: Progress): void => api.listeners.forEach((fn) => fn(p))

  it('sends the copy (still with the source id) and says what was made, passing the progress on', async () => {
    const p = project(1920, 1080, { annotations: [{ id: 'a1', start: 1, end: 3, text: 'Click Save', x: 0.5, y: 0.95, size: 0.05, style: 'pill' }] })
    const run = flow('vertical', { project: p })
    await tick()
    expect(api.calls).toHaveLength(1)
    const [id, copy] = api.calls[0]
    expect(id).toBe(p.id)
    expect(copy.id).toBe(p.id)
    expect(copy.name).toBe('Billing demo (vertical)')
    expect(copy.style.aspectRatio).toBe('9:16')
    expect(copy.reframe?.mode).toBe('follow')
    // The text was measured on a canvas, as the compositor draws it.
    expect(measured).toContain("600 54px 'Segoe UI', system-ui, sans-serif|Click Save")
    expect(copy.annotations[0].y).toBeLessThan(0.76)
    sendProgress({ done: 5, total: 10 })
    api.pending!.resolve({ id: 'rec-20261028-101501', name: 'Billing demo (vertical)', linked: true })
    expect(await run.made).toEqual({ id: 'rec-20261028-101501', notice: 'Made a vertical version. Your original “Billing demo” is unchanged.' })
    expect(run.progress).toEqual([{ done: 5, total: 10 }, null])
    expect(api.listeners.size).toBe(0)
    expect(run.asked).toEqual([])
  })

  it('says "Made a square version" and "Made a copy"; a blank name is "Untitled recording"', async () => {
    for (const [kind, notice] of [
      ['square', 'Made a square version. Your original “Billing demo” is unchanged.'],
      ['copy', 'Made a copy. Your original “Billing demo” is unchanged.']
    ] as const) {
      const run = flow(kind)
      await tick()
      api.pending!.resolve({ id: 'rec-x', name: 'x', linked: true })
      expect((await run.made)?.notice).toBe(notice)
    }
    const run = flow('copy', { project: project(1920, 1080, { name: '  ' }) })
    await tick()
    api.pending!.resolve({ id: 'rec-y', name: 'Untitled recording (copy)', linked: true })
    expect((await run.made)?.notice).toBe('Made a copy. Your original “Untitled recording” is unchanged.')
  })

  it('asks before copying when the latest changes could not be saved', async () => {
    const no = flow('copy', { saved: false, confirm: false })
    expect(await no.made).toBeNull()
    expect(no.asked).toEqual(['Your latest changes could not be saved. Make the copy anyway? It will include them.'])
    expect(api.calls).toHaveLength(0)
    const yes = flow('copy', { saved: false, confirm: true })
    await tick()
    expect(api.calls).toHaveLength(1)
    api.pending!.resolve({ id: 'rec-z', name: 'z', linked: false })
    expect((await yes.made)?.id).toBe('rec-z')
  })

  it('rejects with the reason after "Could not make the copy: "', async () => {
    const run = flow('vertical')
    await tick()
    api.pending!.reject(new Error("Error invoking remote method 'projects:duplicate': Error: there is not enough free space on this drive (it needs 1.4 GB, 0.6 GB is free)."))
    await expect(run.made).rejects.toThrow(/^Could not make the copy: there is not enough free space on this drive \(it needs 1\.4 GB, 0\.6 GB is free\)\.$/)
    expect(run.progress.at(-1)).toBeNull()
    expect(api.listeners.size).toBe(0)
  })

  it('Cancel stops the copy in main and answers at once, without a message', async () => {
    const run = flow('vertical')
    await tick()
    sendProgress({ done: 1, total: 10 })
    run.abort.abort()
    // Progress after Cancel is not shown.
    sendProgress({ done: 2, total: 10 })
    expect(await run.made).toBeNull()
    expect(api.cancelled).toBe(1)
    sendProgress({ done: 3, total: 10 })
    expect(run.progress).toEqual([{ done: 1, total: 10 }, null])
    // Main removes the half-made folder and rejects: nothing more happens.
    api.pending!.reject(new Error('AbortError: The copy was cancelled.'))
    await tick()
    expect(api.deleted).toEqual([])
  })

  it('removes a copy that was finished as Cancel was pressed', async () => {
    const run = flow('copy')
    await tick()
    run.abort.abort()
    expect(await run.made).toBeNull()
    api.pending!.resolve({ id: 'rec-late', name: 'late', linked: true })
    await tick()
    expect(api.deleted).toEqual(['rec-late'])
  })
})

/*
 * The copy button (36 px and the title bar's 6 px gap) is new in the title bar. At the window's
 * 1040 px minimum nothing else there can shrink, so the name field gives that room up: otherwise
 * Export runs under the window's own buttons and a click on its right part minimizes the window.
 */
describe('the title bar at the minimum window width', () => {
  it('the name field gives way by the copy button\'s width (it was at least 200 px)', async () => {
    const { readFileSync } = await import('node:fs')
    const path = await import('node:path')
    const css = readFileSync(path.resolve(__dirname, '../src/renderer/src/editor/editor.css'), 'utf8').replace(/\/\*[\s\S]*?\*\//g, '')
    const rule = [...css.matchAll(/([^{}]+)\{([^}]*)\}/g)].find((m) => m[1].trim() === '.editor .titlebar .title-input')!
    const minWidth = Number(/min-width:\s*(\d+)px/.exec(rule[2])?.[1])
    expect(minWidth).toBeGreaterThanOrEqual(120)
    expect(minWidth).toBeLessThanOrEqual(200 - 36 - 6)
  })
})
