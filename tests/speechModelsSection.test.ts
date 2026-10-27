import { beforeEach, describe, expect, it, vi } from 'vitest'
import type { SpeechModelView, SpeechState } from '../src/shared/api/speech'
import { SPEECH_MODELS, type SpeechModelId } from '../src/shared/speech/catalog'

/*
 * Settings › Captions on this PC without a DOM, in captionsPanel.test.ts's way: React's hooks are
 * swapped for a few lines that keep each component's state by its place in the tree, refs point
 * at stand-ins of the elements rendered in the last pass (null once gone, as React leaves them),
 * and effects run after each pass. Focus is what the section's effects ask of those stand-ins.
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

const cells = new Map<string, Cell[]>()
let hooks: { cells: Cell[]; i: number } | null = null
let effects: (() => void)[] = []
let dirty = false
const cell = (): Cell => (hooks!.cells[hooks!.i++] ??= {})
const changed = (a: readonly unknown[] | undefined, b: readonly unknown[] | undefined): boolean => !a || !b || a.length !== b.length || a.some((v, i) => !Object.is(v, b[i]))

/** The elements that got the focus, in order. */
const focused: El[] = []
const body = {}
let speechListener: ((state: SpeechState) => void) | null = null
let reply: SpeechState

vi.stubGlobal('window', {
  api: {
    getSpeechState: () => Promise.resolve(reply),
    onSpeechState: (l: (state: SpeechState) => void) => {
      speechListener = l
      return () => undefined
    },
    downloadSpeechModel: () => new Promise(() => undefined),
    cancelSpeechDownload: () => Promise.resolve(),
    removeSpeechModel: () => Promise.resolve(),
    setDefaultSpeechModel: () => Promise.resolve(),
    showSpeechModelsFolder: () => Promise.resolve()
  },
  addEventListener: () => undefined,
  removeEventListener: () => undefined
})
const doc: { body: unknown; activeElement: unknown; querySelector: () => null } = { body, activeElement: body, querySelector: () => null }
vi.stubGlobal('document', doc)
vi.stubGlobal('CSS', { escape: (s: string) => s })

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
  useMemo: (fn: () => unknown, deps: unknown[]) => {
    const c = cell()
    if (changed(c.deps, deps)) Object.assign(c, { value: fn(), deps })
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
  useSyncExternalStore: (_subscribe: unknown, get: () => unknown) => get()
}))

// Renderer code: imported at run time so the Node typecheck of tests/ does not follow it.
const SECTION = '../src/renderer/src/settings/SpeechModelsSection'
const { SpeechModelsSection } = (await import(/* @vite-ignore */ SECTION)) as { SpeechModelsSection: (props: unknown) => unknown }

const RENDERED = new Set(['SpeechModelsSection', 'Models', 'Row'])
type Ref = { current?: unknown }
let refs = new Set<Ref>()

function walk(node: unknown, path: string, out: El[], seen: Set<Ref>): void {
  if (Array.isArray(node)) return node.forEach((n, i) => walk(n, `${path}.${i}`, out, seen))
  if (!node || typeof node !== 'object' || !('props' in node)) return
  const el = node as El
  if (typeof el.type === 'function' && RENDERED.has(el.type.name)) {
    if (!cells.has(path)) cells.set(path, [])
    hooks = { cells: cells.get(path)!, i: 0 }
    const child = (el.type as (p: unknown) => unknown)(el.props)
    hooks = null
    return walk(child, `${path}/${el.type.name}`, out, seen)
  }
  const ref = (node as { ref?: Ref | null }).ref
  if (ref && typeof ref === 'object') {
    ref.current = { focus: () => focused.push(el) }
    seen.add(ref)
  }
  out.push(el)
  walk(el.props.children, path, out, seen)
}

/** The section, rendered until its state and effects settle. */
function render(): El[] {
  for (let pass = 0; pass < 20; pass++) {
    dirty = false
    const out: El[] = []
    const seen = new Set<Ref>()
    walk({ type: SpeechModelsSection, props: {} }, 'root', out, seen)
    for (const r of refs) if (!seen.has(r)) r.current = null
    refs = seen
    const run = effects
    effects = []
    run.forEach((e) => e())
    if (!dirty) return out
  }
  throw new Error('The section keeps rendering')
}

const textOf = (node: unknown): string =>
  Array.isArray(node) ? node.map(textOf).join('') : typeof node === 'string' || typeof node === 'number' ? String(node) : node && typeof node === 'object' && 'props' in node ? textOf((node as El).props.children) : ''
const click = (out: El[], label: string): void => {
  const button = out.find((e) => e.type === 'button' && textOf(e.props.children).trim() === label)
  if (!button) throw new Error(`No "${label}" button`)
  ;(button.props.onClick as () => void)()
}
const flush = (): Promise<void> => new Promise((r) => setTimeout(r, 0))
const lastFocused = (): string => (focused.length ? textOf(focused[focused.length - 1].props.children).trim() : '')

type Status = SpeechModelView['status']
function speechState(statuses: Partial<Record<SpeechModelId, Status>> = {}, free = 100e9): SpeechState {
  return {
    engine: { available: true, build: 'standard', threads: 3 },
    detector: { available: true },
    models: SPEECH_MODELS.map((m) => ({
      id: m.id,
      tier: m.tier,
      name: m.name,
      bytes: m.bytes,
      rtf4: m.rtf4,
      ramMB: m.ramMB,
      wer: m.wer,
      partSeconds: m.partSeconds,
      license: m.license,
      status: statuses[m.id] ?? { state: 'missing' },
      inUse: false,
      allowed: true
    })),
    defaultModel: 'whisper-base',
    disk: { free, used: 0 },
    memory: { total: 16 * 2 ** 30, free: 8e9 },
    cores: 4
  }
}

/** The main process changed a status: the pushed state, rendered. */
const push = (state: SpeechState): El[] => {
  speechListener!(state)
  return render()
}

describe('Settings › Captions on this PC: focus never falls to the page (UI-6)', () => {
  beforeEach(async () => {
    for (const list of cells.values()) for (const c of list) c.cleanup?.()
    cells.clear()
    effects = []
    focused.length = 0
    reply = speechState()
    render()
    await flush()
  })

  it('a row whose buttons change gives the focus to its new one: Download → Cancel → Continue → Cancel → Checking… → Remove', () => {
    let out = render()
    expect(focused).toEqual([])
    click(out, 'Download 60 MB')
    out = push(speechState({ 'whisper-base': { state: 'downloading', received: 1e6, total: 60e6, bytesPerSecond: 0 } }))
    expect(lastFocused()).toBe('Cancel')
    out = push(speechState({ 'whisper-base': { state: 'stopped', received: 20e6, total: 60e6 } }))
    expect(lastFocused()).toBe('Continue')
    out = push(speechState({ 'whisper-base': { state: 'downloading', received: 20e6, total: 60e6, bytesPerSecond: 0 } }))
    expect(lastFocused()).toBe('Cancel')
    // Checking has no button: its status line takes the focus.
    out = push(speechState({ 'whisper-base': { state: 'verifying' } }))
    expect(lastFocused()).toBe('Checking…')
    out = push(speechState({ 'whisper-base': { state: 'installed' } }))
    expect(lastFocused()).toBe('Remove')
    expect(out.length).toBeGreaterThan(0)
  })

  it('a confirmed Remove: focus on the row, then on its Download once the model is gone', () => {
    let out = push(speechState({ 'whisper-base': { state: 'installed' } }))
    click(out, 'Remove')
    out = render()
    const question = out.find((e) => e.props.className === 'ai-remove-question')!
    const confirm = (question.props.children as unknown[]).flat().find((c) => c && typeof c === 'object' && textOf(c).trim() === 'Remove') as El
    ;(confirm.props.onClick as () => void)()
    out = render()
    expect(lastFocused()).toBe('Remove')
    out = push(speechState())
    expect(lastFocused()).toBe('Download 60 MB')
  })

  it('Check again that finds room: the focus goes to Try again', () => {
    const failed: Status = { state: 'failed', received: 0, total: 60e6, error: 'disk', message: '' }
    let out = push(speechState({ 'whisper-base': failed }, 10e6))
    click(out, 'Check again')
    out = push(speechState({ 'whisper-base': failed }, 50e9))
    expect(lastFocused()).toBe('Try again')
  })

  it('a change in another row while the focus is elsewhere moves nothing', () => {
    doc.activeElement = { focus: () => undefined }
    try {
      push(speechState({ 'whisper-small': { state: 'downloading', received: 1e6, total: 190e6, bytesPerSecond: 0 } }))
      push(speechState({ 'whisper-small': { state: 'installed' } }))
      expect(focused).toEqual([])
    } finally {
      doc.activeElement = body
    }
  })
})
