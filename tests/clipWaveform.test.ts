import { beforeEach, describe, expect, it, vi } from 'vitest'
import { LEVEL_WINDOW, type AudioLevels } from '../src/shared/audio/loudness'
import { createProject } from '../src/shared/engine/project'

/*
 * The waveform's canvas (ClipWaveform, docs/design/timeline-waveform.md §4.6) without a DOM, as
 * tests/cropEditor.test.ts renders the crop tool: React's hooks are swapped for a few lines that
 * keep the component's state, so it is called as a function. Its canvas is a stub that keeps the
 * size it is given, and `matchMedia` answers for the display's scale factor as Chromium does.
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
  ref: { current: unknown }
}

let cells: Cell[] = []
let hooks: { i: number } | null = null
let layoutEffects: (() => void)[] = []
let effects: (() => void)[] = []
/** React would render again: a state or a subscribed value changed. */
let dirty = false
const cell = (): Cell => (cells[hooks!.i++] ??= {})
const changed = (a: readonly unknown[] | undefined, b: readonly unknown[] | undefined): boolean => !a || !b || a.length !== b.length || a.some((v, i) => !Object.is(v, b[i]))
const effect =
  (list: () => (() => void)[]) =>
  (fn: () => (() => void) | void, deps?: unknown[]): void => {
    const c = cell()
    if (!changed(c.deps, deps)) return
    c.deps = deps
    list().push(() => {
      c.cleanup?.()
      c.cleanup = fn()
    })
  }

/* ---------- the display: Chromium fires 'change' on each resolution query whose match flips ---------- */

const win = { devicePixelRatio: 1, api: { analyzeAudio: async (): Promise<Record<string, AudioLevels>> => ({ mix: LEVELS }) } }
const queries: { query: string; matches: boolean; listeners: Set<() => void> }[] = []
const matchesRatio = (query: string): boolean => query === `(resolution: ${win.devicePixelRatio}dppx)`
vi.stubGlobal('window', win)
vi.stubGlobal('matchMedia', (query: string) => {
  const q = { query, matches: matchesRatio(query), listeners: new Set<() => void>() }
  queries.push(q)
  return {
    media: query,
    addEventListener: (_type: string, fn: () => void) => q.listeners.add(fn),
    removeEventListener: (_type: string, fn: () => void) => q.listeners.delete(fn)
  }
})
/** The window dragged to a monitor at scale factor `ratio`: its CSS size stays the same, so nothing resizes. */
function moveToMonitor(ratio: number): void {
  win.devicePixelRatio = ratio
  for (const q of [...queries]) {
    if (matchesRatio(q.query) === q.matches) continue
    q.matches = !q.matches
    for (const fn of [...q.listeners]) fn()
  }
}
const listening = (): number => queries.reduce((n, q) => n + q.listeners.size, 0)

vi.stubGlobal('localStorage', { getItem: () => null, setItem: () => undefined })
vi.stubGlobal('getComputedStyle', () => ({ getPropertyValue: () => '#888' }))
vi.stubGlobal('requestIdleCallback', (fn: () => void) => (fn(), 1))
vi.stubGlobal('cancelIdleCallback', () => undefined)

const project = createProject({
  id: 'p',
  name: 'p',
  duration: 30,
  width: 1280,
  height: 720,
  hasWebcam: false,
  hasAudio: true,
  webcamOffset: 0,
  zooms: [],
  cursorValid: true,
  capture: { method: 'chromium', cursorInVideo: true, region: null }
})
const LEVELS: AudioLevels = { window: LEVEL_WINDOW, power: new Float32Array(30 / LEVEL_WINDOW).map((_, i) => (i % 40 < 20 ? 1e-3 : 0)) }
const store = { state: project, subscribe: () => () => undefined }

vi.doMock('react', async (importOriginal) => ({
  ...(await importOriginal<Record<string, unknown>>()),
  memo: (fn: unknown) => fn,
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
  useLayoutEffect: effect(() => layoutEffects),
  useEffect: effect(() => effects),
  useSyncExternalStore: (subscribe: (l: () => void) => () => void, get: () => unknown) => {
    const c = cell()
    c.value = get()
    c.cleanup ??= subscribe(() => {
      if (!Object.is(get(), c.value)) dirty = true
    })
    return c.value
  },
  // useEditor()
  useContext: () => ({ store })
}))

// Renderer code: imported at run time so the Node typecheck of tests/ does not follow it.
const WAVEFORM = '../src/renderer/src/editor/ClipWaveform'
const { ClipWaveform } = (await import(/* @vite-ignore */ WAVEFORM)) as { ClipWaveform: (props: unknown) => El | null }

/** The canvas React would hand the component: it keeps the backing size `draw()` gives it. */
let canvas: { width: number; height: number; parentElement: { clientHeight: number }; dataset: Record<string, string>; getContext: () => unknown }
const ctx = new Proxy({} as Record<string | symbol, unknown>, { get: (t, k) => (k in t ? t[k] : () => undefined) })

// 30 s at 10 px a second: 300 CSS px wide, on the 40 px clip track.
const PROPS = { px: 10, win: { start: 0, end: 30 }, duration: 30 }

const flush = async (): Promise<void> => {
  for (let i = 0; i < 5; i++) await new Promise((r) => setTimeout(r, 0))
}

/** The waveform rendered until its state, effects and level request settle; its canvas element. */
async function render(): Promise<El | null> {
  for (let pass = 0; pass < 10; pass++) {
    dirty = false
    hooks = { i: 0 }
    const el = ClipWaveform(PROPS)
    hooks = null
    if (el) el.ref.current = canvas
    const run = [...layoutEffects, ...effects]
    layoutEffects = []
    effects = []
    run.forEach((e) => e())
    await flush()
    if (!dirty && !run.length) return el
  }
  throw new Error('The waveform keeps rendering')
}
const unmount = (): void => cells.forEach((c) => c.cleanup?.())
const size = (): number[] => [canvas.width, canvas.height]
const draws = (): number => Number(canvas.dataset.draws)

beforeEach(() => {
  cells = []
  layoutEffects = []
  effects = []
  queries.length = 0
  win.devicePixelRatio = 1
  canvas = { width: 0, height: 0, parentElement: { clientHeight: 40 }, dataset: {}, getContext: () => ctx }
})

describe('ClipWaveform: the display scale factor', () => {
  it('redraws at the new scale factor when the window moves to another monitor, which no resize reports', async () => {
    expect((await render())?.props['data-state']).toBe('ready')
    expect(size()).toEqual([300, 40])
    const before = draws()

    moveToMonitor(2)
    // Nothing else changes (px, the render window, the clips): only the scale factor renders it again.
    expect(dirty).toBe(true)
    await render()
    expect(size()).toEqual([600, 80])
    expect(draws()).toBe(before + 1)

    // Asked again at the new ratio, so the next move is seen too.
    moveToMonitor(1.5)
    expect(dirty).toBe(true)
    await render()
    expect(size()).toEqual([450, 60])
    expect(draws()).toBe(before + 2)
  })

  it('stops listening when it is taken off the timeline', async () => {
    await render()
    moveToMonitor(2)
    await render()
    unmount()
    expect(listening()).toBe(0)
  })
})
