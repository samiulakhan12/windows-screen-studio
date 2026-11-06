import { beforeEach, describe, expect, it, vi } from 'vitest'

/*
 * The Versions dialog's rows (docs/design/versions.md §2.7) without a DOM: React's hooks are swapped
 * for a few lines that keep the dialog's state (as in copyMenu.test.ts), ref objects get stand-in
 * elements that record the focus, and window.api is a stub of the main process whose renames wait
 * until the test lets them finish.
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
vi.doMock('../src/renderer/src/editor/modalFocus', () => ({ useModalFocus: () => undefined }))

/** The page: `activeElement` is where the focus is (the body: it fell to the page). */
const page: { body: object; activeElement: unknown } = { body: {}, activeElement: null }
vi.stubGlobal('document', page)

const { createProject, migrateProject } = await import('../src/shared/engine/project')
const { versionSummary } = await import('../src/shared/editor/versions')
const { freezeAtPlayhead, moveFreeze } = await import('../src/shared/editor/freezeEdit')
type Project = import('../src/shared/types').Project
type VersionMeta = import('../src/shared/editor/versions').VersionMeta

const project: Project = createProject({
  id: 'rec-20261028-101500',
  name: 'Billing demo',
  duration: 20,
  width: 1920,
  height: 1080,
  hasWebcam: false,
  hasAudio: true,
  webcamOffset: 0,
  zooms: [],
  cursorValid: true,
  capture: { method: 'native', cursorInVideo: false, region: null }
})
const meta = (id: string, name: string): VersionMeta => ({ id, name, auto: false, createdAt: '2026-11-06T10:00:00.000Z', bytes: 2048, hash: '0'.repeat(64), summary: versionSummary(project) })
const V1 = meta('v-mabc12-0123abcd', 'First')
const V2 = meta('v-mabc13-4567abcd', 'Second')

/** The edit now (what getProject gives). */
let edit: Project = project

/** The main process: the kept versions, renames that finish when the test says, the project a version holds. */
const api = { renames: [] as { id: string; name: string; finish: () => void }[], kept: project }
vi.stubGlobal('window', {
  api: {
    listVersions: () => Promise.resolve([V1, V2]),
    renameVersion: (_project: string, id: string, name: string) => new Promise<void>((resolve) => api.renames.push({ id, name, finish: resolve })),
    readVersion: () => Promise.resolve({ project: api.kept, changed: [] }),
    deleteVersion: () => Promise.resolve(),
    saveVersion: () => Promise.resolve({ saved: null })
  }
})

// Renderer code: imported at run time so the Node typecheck of tests/ does not follow it.
const DIALOG = '../src/renderer/src/versions/VersionsDialog'
const { VersionsDialog } = (await import(/* @vite-ignore */ DIALOG)) as {
  VersionsDialog: (props: { getProject(): Project; focusName: boolean; onOpen(v: unknown): void; onNotice(t: string): void; onClose(): void }) => unknown
}

/* ---------- a tiny renderer ---------- */

/** What got the focus: a control's aria-label (or its text), 'dialog' for the dialog box. */
const focused: string[] = []
const labelOf = (el: El): string => (el.props['aria-label'] as string | undefined) ?? (el.props.role === 'dialog' ? 'dialog' : textOf(el.props.children))

const textOf = (node: unknown): string =>
  Array.isArray(node) ? node.map(textOf).join('') : typeof node === 'string' || typeof node === 'number' ? String(node) : node && typeof node === 'object' && 'props' in node ? textOf((node as El).props.children) : ''

/** The host elements under `el`, as a querySelector would search them. */
function descendants(el: El): El[] {
  const found: El[] = []
  const visit = (node: unknown): void => {
    if (Array.isArray(node)) return node.forEach(visit)
    if (!node || typeof node !== 'object' || !('props' in node)) return
    const child = node as El
    if (typeof child.type === 'string') found.push(child)
    visit(child.props.children)
  }
  visit(el.props.children)
  return found
}

/**
 * A ref object gets a stand-in element that records its focus; its querySelector finds
 * `[data-version="…"] button[aria-label^="…"]` among the elements it holds in the latest render.
 */
function standIn(el: El): { el: El; focus(): void; querySelector(sel: string): unknown } {
  const stand = {
    el,
    focus: () => void focused.push(labelOf(stand.el)),
    querySelector: (sel: string) => {
      const m = /^\[data-version="([^"]+)"\] button\[aria-label\^="([^"]+)"\]$/.exec(sel)
      if (!m) throw new Error(`The stand-in cannot find ${sel}`)
      const row = descendants(stand.el).find((d) => d.props['data-version'] === m[1])
      const button = row && descendants(row).find((d) => d.type === 'button' && String(d.props['aria-label'] ?? '').startsWith(m[2]))
      return button ? { focus: () => void focused.push(labelOf(button)) } : null
    }
  }
  return stand
}

/** Function components called, refs given stand-ins; returns every host element. */
function expand(node: unknown, out: El[]): void {
  if (Array.isArray(node)) return node.forEach((n) => expand(n, out))
  if (!node || typeof node !== 'object' || !('props' in node)) return
  const el = node as El
  if (typeof el.type === 'function') return expand((el.type as (p: unknown) => unknown)(el.props), out)
  const ref = el.ref as { current?: unknown } | null | undefined
  if (ref && typeof ref === 'object') {
    if (!ref.current) ref.current = standIn(el)
    else (ref.current as { el: El }).el = el
  }
  out.push(el)
  expand(el.props.children, out)
}

const dialog = (): unknown => VersionsDialog({ getProject: () => edit, focusName: false, onOpen: () => undefined, onNotice: () => undefined, onClose: () => undefined })

/** The dialog, rendered until its state and effects settle. */
function render(): El[] {
  for (let pass = 0; pass < 20; pass++) {
    dirty = false
    at = 0
    const out: El[] = []
    expand(dialog(), out)
    const run = effects
    effects = []
    run.forEach((e) => e())
    if (!dirty) return out
  }
  throw new Error('The dialog keeps rendering')
}

const flush = (): Promise<void> => new Promise((r) => setTimeout(r, 0))
const key = (k: string): Key => ({ key: k, preventDefault: () => undefined, stopPropagation: () => undefined })
const button = (out: El[], label: string): El => {
  const found = out.find((e) => e.type === 'button' && labelOf(e) === label)
  if (!found) throw new Error(`No button "${label}"`)
  return found
}
const click = (out: El[], label: string): void => (button(out, label).props.onClick as () => void)()
const question = (out: El[], v: VersionMeta): El | undefined => out.find((e) => e.props.role === 'group' && e.props['aria-label'] === `Delete ${v.name}?`)
const renameField = (out: El[], v: VersionMeta): El | undefined => out.find((e) => e.props['aria-label'] === `New name for ${v.name}`)

/** The dialog with its list read. */
async function opened(): Promise<El[]> {
  render()
  await flush()
  return render()
}

beforeEach(() => {
  for (const c of cells) c.cleanup?.()
  cells = []
  effects = []
  focused.length = 0
  page.activeElement = null
  api.renames.length = 0
  api.kept = project
  edit = project
})

describe('the focus when a row’s question or rename field closes', () => {
  it('Keep and Esc in the delete question give it back to the row’s Delete', async () => {
    let out = await opened()
    click(out, 'Delete First')
    out = render()
    expect(question(out, V1)).toBeDefined()
    focused.length = 0
    // The focused Keep goes with the question: the focus falls to the page.
    page.activeElement = page.body
    click(out, 'Keep')
    out = render()
    expect(question(out, V1)).toBeUndefined()
    expect(focused).toEqual(['Delete First'])

    click(out, 'Delete First')
    out = render()
    focused.length = 0
    ;(question(out, V1)!.props.onKeyDown as (e: Key) => void)(key('Escape'))
    out = render()
    expect(question(out, V1)).toBeUndefined()
    expect(focused).toEqual(['Delete First'])
  })

  it('Enter or Esc in the rename field give it back to the row’s Rename', async () => {
    let out = await opened()
    click(out, 'Rename First')
    out = render()
    ;(renameField(out, V1)!.props.onChange as (e: unknown) => void)({ target: { value: 'Final cut' } })
    out = render()
    ;(renameField(out, V1)!.props.onKeyDown as (e: Key) => void)(key('Enter'))
    expect(api.renames.map((r) => r.name)).toEqual(['Final cut'])
    focused.length = 0
    page.activeElement = page.body
    api.renames[0].finish()
    await flush()
    out = render()
    expect(renameField(out, V1)).toBeUndefined()
    expect(focused).toEqual(['Rename First'])

    click(out, 'Rename Second')
    out = render()
    focused.length = 0
    ;(renameField(out, V2)!.props.onKeyDown as (e: Key) => void)(key('Escape'))
    out = render()
    expect(renameField(out, V2)).toBeUndefined()
    expect(focused).toEqual(['Rename Second'])
  })

  it('leaves a focus that moved on where it is', async () => {
    let out = await opened()
    click(out, 'Delete First')
    out = render()
    focused.length = 0
    page.activeElement = { elsewhere: true }
    click(out, 'Keep')
    out = render()
    expect(question(out, V1)).toBeUndefined()
    expect(focused).toEqual([])
  })
})

describe('a rename saved as its field loses the focus', () => {
  it('keeps the delete question the click that left the field opened', async () => {
    let out = await opened()
    click(out, 'Rename First')
    out = render()
    ;(renameField(out, V1)!.props.onChange as (e: unknown) => void)({ target: { value: 'Final cut' } })
    out = render()
    // Pressing Delete takes the focus from the field (the rename starts), then the click opens the question.
    ;(renameField(out, V1)!.props.onBlur as () => void)()
    click(out, 'Delete First')
    out = render()
    expect(question(out, V1)).toBeDefined()
    api.renames[0].finish()
    await flush()
    out = render()
    expect(api.renames.map((r) => [r.id, r.name])).toEqual([[V1.id, 'Final cut']])
    expect(question(out, V1)).toBeDefined()
  })

  it('keeps the rename field of the row whose Rename the click pressed', async () => {
    let out = await opened()
    click(out, 'Rename First')
    out = render()
    ;(renameField(out, V1)!.props.onBlur as () => void)()
    click(out, 'Rename Second')
    out = render()
    ;(renameField(out, V2)!.props.onChange as (e: unknown) => void)({ target: { value: 'Second take' } })
    api.renames[0].finish()
    await flush()
    out = render()
    expect(renameField(out, V2)?.props.value).toBe('Second take')
  })
})

describe('Compare', () => {
  /** What the compare row of the version says. */
  const comparison = (out: El[]): string => textOf(out.find((e) => e.props['data-testid'] === 'version-compare')?.props.children)
  /** `p` kept as saveVersion and readVersion do: migrated, written as JSON, read back and migrated. */
  const kept = (p: Project): Project => migrateProject(JSON.parse(JSON.stringify(migrateProject(JSON.parse(JSON.stringify(p))))))

  it('says a version kept just now is the same with a freeze frame at the edit’s end', async () => {
    // The edit ends at a playhead time that is not whole ms; the freeze there holds its last frame.
    const end = 17.3333333
    const added = freezeAtPlayhead({ ...project, clips: [{ ...project.clips[0], end }] }, end)
    if ('refused' in added) throw new Error(added.refused)
    edit = added.project
    api.kept = kept(edit)
    let out = await opened()
    click(out, 'Compare First with your edit now')
    await flush()
    out = render()
    expect(comparison(out)).toBe('Same as your edit now.')

    // A freeze moved since is still named.
    edit = moveFreeze(edit, added.id, 5)
    click(out, 'Compare First with your edit now')
    out = render()
    click(out, 'Compare First with your edit now')
    await flush()
    out = render()
    expect(comparison(out)).toContain('freeze frames')
  })
})
