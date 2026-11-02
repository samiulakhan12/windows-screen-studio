import { beforeEach, describe, expect, it, vi } from 'vitest'

/*
 * The export dialog's "After export" (docs/design/share.md §2.7) without a DOM: React's hooks are
 * swapped for a few lines that keep the hook's state (as in copyMenu.test.ts), localStorage holds
 * the remembered choices and window.api is a stub of the main process.
 */

interface Cell {
  value?: unknown
  deps?: readonly unknown[]
  current?: unknown
  cleanup?: (() => void) | void
}

let cells: Cell[] = []
let at = 0
let effects: (() => void)[] = []
const cell = (): Cell => (cells[at++] ??= {})
const changed = (a: readonly unknown[] | undefined, b: readonly unknown[] | undefined): boolean => !a || !b || a.length !== b.length || a.some((v, i) => !Object.is(v, b[i]))

vi.doMock('react', async (importOriginal) => ({
  ...(await importOriginal<Record<string, unknown>>()),
  useState: (init: unknown) => {
    const c = cell()
    if (!('value' in c)) c.value = typeof init === 'function' ? (init as () => unknown)() : init
    const set = (v: unknown): void => {
      c.value = typeof v === 'function' ? (v as (x: unknown) => unknown)(c.value) : v
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
  },
  useMemo: (fn: () => unknown, deps: unknown[]) => {
    const c = cell()
    if (changed(c.deps, deps)) {
      c.deps = deps
      c.value = fn()
    }
    return c.value
  },
  useCallback: (fn: unknown, deps: unknown[]) => {
    const c = cell()
    if (changed(c.deps, deps)) {
      c.deps = deps
      c.value = fn
    }
    return c.value
  }
}))

type ShareTargets = import('../src/shared/api/share').ShareTargets
type ShareMeta = import('../src/shared/api/share').ShareMeta

const TARGETS: ShareTargets = {
  folders: [{ id: 'cf0000000001', service: 'onedrive', label: 'OneDrive', path: 'C:\\OneDrive', source: 'app', on: true }],
  hooks: [{ id: 'whkchat', service: 'slack', label: '#demos', masked: 'hooks.slack.com/…/AbCd', readable: true }],
  reviewed: true
}

/** The main process: the destinations it is still looking up, and what the page asks of it. */
const main = {
  lookups: [] as ((t: ShareTargets) => void)[],
  offers: [] as [string, ShareMeta, boolean][],
  starts: [] as [string, string[]][]
}
vi.stubGlobal('localStorage', {
  getItem: () => JSON.stringify({ v: 1, byPreset: { youtube: ['cf0000000001', 'whkchat'] } }),
  setItem: () => undefined
})
vi.stubGlobal('window', {
  api: {
    shareTargets: () => new Promise<ShareTargets>((resolve) => main.lookups.push(resolve)),
    shareOffer: async (file: string, meta: ShareMeta, auto: boolean) => void main.offers.push([file, meta, auto]),
    shareStart: async (file: string, ids: string[]) => {
      main.starts.push([file, ids])
      return { id: 'r', file, steps: [], finished: false }
    }
  }
})

// Renderer code: imported at run time so the Node typecheck of tests/ does not follow it.
const HOOK = '../src/renderer/src/share/useShare'
const { useAfterExport, actionLabel } = (await import(/* @vite-ignore */ HOOK)) as {
  useAfterExport: (preset: string | undefined) => { chosen: string[]; begin: (file: string, meta: ShareMeta) => Promise<void> }
  actionLabel: (t: ShareTargets | null, id: string) => string
}

/** One render of the dialog's hook, then its effects. */
function render(): ReturnType<typeof useAfterExport> {
  at = 0
  const out = useAfterExport('youtube')
  const run = effects
  effects = []
  for (const fn of run) fn()
  return out
}

const tick = (): Promise<void> => new Promise((r) => setTimeout(r, 0))
const META: ShareMeta = { title: 'Demo', seconds: 3 }

describe('After export', () => {
  beforeEach(() => {
    cells = []
    effects = []
    main.lookups = []
    main.offers = []
    main.starts = []
  })

  it('shares to the remembered choice when Export was pressed before the destinations loaded', async () => {
    // Enter on the focused Export button at once: the click's render has no destinations yet.
    const atClick = render()
    expect(atClick.chosen).toEqual([])
    // They load while the video exports.
    main.lookups.shift()!(TARGETS)
    await tick()
    expect(render().chosen).toEqual(['cf0000000001', 'whkchat'])
    // The export ends and the click's own begin runs.
    await atClick.begin('C:\\Videos\\Demo.mp4', META)
    expect(main.offers).toEqual([['C:\\Videos\\Demo.mp4', META, true]])
    expect(main.starts).toEqual([['C:\\Videos\\Demo.mp4', ['cf0000000001', 'whkchat']]])
  })

  it('names each of two destinations with the same label by where it is', () => {
    const t: ShareTargets = {
      folders: [TARGETS.folders[0], { ...TARGETS.folders[0], id: 'cf0000000002', path: 'D:\\OneDrive' }],
      hooks: [TARGETS.hooks[0], { ...TARGETS.hooks[0], id: 'whkother', masked: 'hooks.slack.com/…/WxYz' }],
      reviewed: true
    }
    expect(['cf0000000001', 'cf0000000002', 'whkchat', 'whkother'].map((id) => actionLabel(t, id))).toEqual([
      'Copy to OneDrive (C:)',
      'Copy to OneDrive (D:)',
      'Post to #demos (…AbCd)',
      'Post to #demos (…WxYz)'
    ])
    expect(actionLabel(TARGETS, 'cf0000000001')).toBe('Copy to OneDrive')
  })

  it('waits for the destinations when they are still loading as the export ends', async () => {
    const atClick = render()
    const done = atClick.begin('C:\\Videos\\Demo.mp4', META)
    await tick()
    for (const resolve of main.lookups.splice(0)) resolve(TARGETS)
    await done
    expect(main.starts).toEqual([['C:\\Videos\\Demo.mp4', ['cf0000000001', 'whkchat']]])
  })
})
