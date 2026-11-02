import { beforeEach, describe, expect, it, vi } from 'vitest'
import { playableFrom, keptBounds } from '../src/shared/engine/timeline'
import { createProject } from '../src/shared/engine/project'
import { SOUNDS_COPY } from '../src/shared/audio/soundsCopy'
import type { SoundRow } from '../src/shared/audio/sounds'
import type { Clip, Project } from '../src/shared/types'

/*
 * The Audio tab's Unwanted sounds section (editor/sounds/SoundsSection.tsx, docs/design/sound-finder.md
 * §5) without a DOM, as in copyMenu.test.ts: React's hooks are swapped for a few lines that keep its
 * state, elements get fake nodes (the focus, and the few queries the section makes), the scan is a
 * stand-in whose state the test sets, and the player records what it is asked.
 */

interface Cell {
  value?: unknown
  deps?: readonly unknown[]
  current?: unknown
  cleanup?: (() => void) | void
}
interface El {
  type: unknown
  key?: string | null
  props: Record<string, unknown>
  ref?: unknown
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
  },
  useSyncExternalStore: (_subscribe: unknown, get: () => unknown) => get()
}))

/* ---------- a tiny DOM: nodes that keep their identity across renders, and the focus ---------- */

interface FakeNode {
  el: El
  parent: FakeNode | null
  children: FakeNode[]
  dataset: Record<string, string>
  focus(options?: unknown): void
  scrollIntoView(options?: unknown): void
  contains(n: unknown): boolean
  querySelector(sel: string): FakeNode | null
  querySelectorAll(sel: string): FakeNode[]
}

const body = { body: true }
/** The page: the element with the focus, and focusin listeners. */
const doc = {
  body,
  activeElement: body as unknown,
  focusin: new Set<(e: { target: unknown }) => void>(),
  addEventListener(type: string, fn: (e: { target: unknown }) => void) {
    if (type === 'focusin') this.focusin.add(fn)
  },
  removeEventListener(type: string, fn: (e: { target: unknown }) => void) {
    if (type === 'focusin') this.focusin.delete(fn)
  }
}
vi.stubGlobal('document', doc)

/** Moves the focus to `target` (another control of the editor when it is not one of the section's). */
function focusOn(target: unknown): void {
  doc.activeElement = target
  for (const fn of [...doc.focusin]) fn({ target })
}

const classesOf = (n: FakeNode): string[] => String(n.el.props.className ?? '').split(/\s+/)
/** `tag.class.class` */
function simple(n: FakeNode, sel: string): boolean {
  const m = /^([a-z]*)((?:\.[\w-]+)*)$/.exec(sel)
  if (!m) throw new Error(`selector ${sel}`)
  if (m[1] && n.el.type !== m[1]) return false
  return m[2]
    .split('.')
    .filter(Boolean)
    .every((c) => classesOf(n).includes(c))
}
/** A list of descendant selectors. */
const matches = (n: FakeNode, sel: string): boolean =>
  sel.split(',').some((part) => {
    const steps = part.trim().split(/\s+/)
    if (!simple(n, steps[steps.length - 1])) return false
    let i = steps.length - 2
    for (let a = n.parent; a && i >= 0; a = a.parent) if (simple(a, steps[i])) i--
    return i < 0
  })
const descendants = (n: FakeNode): FakeNode[] => n.children.flatMap((c) => [c, ...descendants(c)])

const nodes = new Map<string, FakeNode>()
/** The rows scrolled into view (by key), with the options. */
const scrolled: { key: string; options: unknown }[] = []
function nodeAt(path: string, el: El): FakeNode {
  let n = nodes.get(path)
  if (!n) {
    const node: FakeNode = {
      el,
      parent: null,
      children: [],
      dataset: {},
      focus() {
        const p = node.el.props
        const focusable = node.el.type === 'button' || node.el.type === 'input' || p.tabIndex !== undefined
        if (focusable && !p.disabled) focusOn(node)
      },
      scrollIntoView(options?: unknown) {
        scrolled.push({ key: node.dataset.key, options })
      },
      contains: (o: unknown) => {
        for (let a = o as FakeNode | null; a && 'el' in a; a = a.parent) if (a === node) return true
        return false
      },
      querySelector: (sel: string) => descendants(node).find((d) => matches(d, sel)) ?? null,
      querySelectorAll: (sel: string) => descendants(node).filter((d) => matches(d, sel))
    }
    nodes.set(path, node)
    n = node
  }
  return n
}

let present = new Set<FakeNode>()
let refsSet = new Set<{ current: unknown }>()

/** Function components called, host elements given nodes (and refs); returns the root nodes. */
function expand(node: unknown, parent: FakeNode | null, path: string, counter: { i: number }): void {
  if (Array.isArray(node)) {
    for (const n of node) expand(n, parent, path, counter)
    return
  }
  if (!node || typeof node !== 'object' || !('props' in node)) return
  const el = node as El
  if (typeof el.type === 'function') return expand((el.type as (p: unknown) => unknown)(el.props), parent, path, counter)
  if (typeof el.type !== 'string') return expand(el.props.children, parent, path, counter)
  const here = `${path}/${el.type}[${el.key ?? counter.i++}]`
  const n = nodeAt(here, el)
  n.el = el
  n.parent = parent
  n.children = []
  n.dataset = Object.fromEntries(Object.entries(el.props).flatMap(([k, v]) => (k.startsWith('data-') ? [[k.slice(5), String(v)]] : [])))
  parent?.children.push(n)
  present.add(n)
  if (el.ref && typeof el.ref === 'object') {
    ;(el.ref as { current: unknown }).current = n
    refsSet.add(el.ref as { current: unknown })
  }
  expand(el.props.children, n, here, { i: 0 })
}

let root: FakeNode | null = null
let lastRefs = new Set<{ current: unknown }>()

/** `component`, rendered until its state and effects settle; a focused node that went leaves the focus on the page. */
function render(component: () => unknown): void {
  for (let pass = 0; pass < 20; pass++) {
    dirty = false
    at = 0
    present = new Set()
    refsSet = new Set()
    const top = nodeAt('', { type: 'root', props: {} })
    top.children = []
    expand(component(), top, '', { i: 0 })
    root = top
    for (const r of lastRefs) if (!refsSet.has(r)) r.current = null
    lastRefs = refsSet
    if (doc.activeElement !== body && (doc.activeElement as FakeNode)?.el && !present.has(doc.activeElement as FakeNode)) doc.activeElement = body
    const run = effects
    effects = []
    run.forEach((e) => e())
    if (!dirty) return
  }
  throw new Error('The component keeps rendering')
}

const textOf = (node: unknown): string =>
  Array.isArray(node) ? node.map(textOf).join('') : typeof node === 'string' || typeof node === 'number' ? String(node) : node && typeof node === 'object' && 'props' in node ? textOf((node as El).props.children) : ''
const all = (): FakeNode[] => (root ? descendants(root) : [])
const byTestId = (id: string): FakeNode | undefined => all().find((n) => n.el.props['data-testid'] === id)
const rowOf = (key: string): FakeNode | undefined => all().find((n) => n.el.type === 'li' && n.dataset.key === key)
/** The row's button: Play, or the one with that text. */
function buttonOf(key: string, text: string): FakeNode {
  const b = rowOf(key)
    ?.querySelectorAll('button')
    .find((n) => (text === 'Play' ? classesOf(n).includes('sound-play') : textOf(n.el.props.children) === text))
  if (!b) throw new Error(`no ${text} on ${key}`)
  return b
}
const click = (n: FakeNode): void => (n.el.props.onClick as () => void)()
/** What the live region says. */
const said = (): string => textOf(all().find((n) => n.el.props.role === 'status')?.el.props.children)

/* ---------- the editor around it ---------- */

/** soundScan.ts's ScanState (renderer code, which the Node typecheck of tests/ does not follow). */
type ScanState =
  | { status: 'idle'; checking?: boolean }
  | { status: 'listening'; progress: number; preparing?: boolean }
  | { status: 'done'; rows: SoundRow[]; fromCache: boolean; sources: string }
  | { status: 'failed'; message: string }
const scan = { state: { status: 'idle' } as ScanState, started: 0, cancelled: 0 }
vi.doMock('../src/renderer/src/editor/sounds/soundScan', () => ({
  scanState: () => scan.state,
  scanVersion: () => 0,
  subscribeScan: () => () => undefined,
  checkStored: () => Promise.resolve(),
  startScan: () => {
    scan.started++
    scan.state = { status: 'listening', progress: 0, preparing: true }
    return Promise.resolve()
  },
  cancelScan: () => {
    scan.cancelled++
    scan.state = { status: 'idle' }
  }
}))
vi.doMock('../src/renderer/src/editor/controls', () => ({
  Section: ({ children }: { children: unknown }) => ({ type: 'section', props: { className: 'insp-section', children } })
}))
vi.doMock('../src/renderer/src/editor/EditorIcon', () => ({ EditorIcon: () => null }))

/** The edit store: one update per action. */
const store = {
  state: null as unknown as Project,
  updates: 0,
  update(fn: (p: Project) => Project) {
    this.updates++
    this.state = fn(this.state)
  }
}
/** The preview player: as player.ts, it plays from the next kept time, and from the start past the edit's last frame. */
const player = {
  time: 0,
  playing: false,
  seeks: 0,
  calls: [] as string[],
  pause() {
    this.calls.push('pause')
    this.playing = false
  },
  seek(t: number) {
    this.seeks++
    this.calls.push(`seek ${t}`)
    this.time = t
  },
  play() {
    this.calls.push('play')
    const clips = store.state.clips
    let from = playableFrom(clips, this.time)
    if (!from || this.time >= keptBounds(clips).end - 1 / 30) from = { time: clips[0].start, index: 0 }
    this.time = from.time
    this.playing = true
  }
}
vi.doMock('../src/renderer/src/editor/context', () => ({ useEditor: () => ({ store, player }) }))

/** window: the api (never reached: the scan is a stand-in) and the timers Play watches with. */
const timers = new Map<number, () => void>()
let timerId = 0
vi.stubGlobal('window', {
  api: {},
  setInterval: (fn: () => void) => {
    timers.set(++timerId, fn)
    return timerId
  },
  clearInterval: (id: number) => void timers.delete(id)
})
/** One tick of every running timer. */
const tick = (): void => [...timers.values()].forEach((fn) => fn())

// Renderer code: imported at run time so the Node typecheck of tests/ does not follow it.
const SECTION = '../src/renderer/src/editor/sounds/SoundsSection'
const { SoundsSection } = (await import(/* @vite-ignore */ SECTION)) as { SoundsSection: (props: { project: Project }) => unknown }

function project(clips?: Clip[], duration = 120): Project {
  const p = createProject({
    id: 'rec-20261102-101500',
    name: 'Sounds',
    duration,
    width: 1920,
    height: 1080,
    hasWebcam: false,
    hasAudio: true,
    webcamOffset: 0,
    zooms: [],
    cursorValid: true,
    capture: { method: 'native', cursorInVideo: false, region: null, fps: 30 }
  })
  return clips ? { ...p, clips } : p
}
const row = (key: string, start: number, end: number): SoundRow => ({ key, kind: key.slice(0, key.lastIndexOf('-')) as SoundRow['kind'], start, end, score: 0.8, source: 'mix' })
const done = (rows: SoundRow[]): ScanState => ({ status: 'done', rows, fromCache: false, sources: 'mix' })
const view = (): void => render(() => SoundsSection({ project: store.state }))

beforeEach(() => {
  for (const c of cells) c.cleanup?.()
  cells = []
  effects = []
  nodes.clear()
  root = null
  lastRefs = new Set()
  doc.activeElement = body
  doc.focusin.clear()
  timers.clear()
  scrolled.length = 0
  Object.assign(scan, { state: { status: 'idle' }, started: 0, cancelled: 0 })
  Object.assign(store, { state: project(), updates: 0 })
  Object.assign(player, { time: 0, playing: false, seeks: 0, calls: [] })
})

describe('a refused action', () => {
  it('says why on screen, not only to a screen reader, until the next action', () => {
    // Kept 30–40 s only; the music row runs over all of it, so cutting it would leave nothing.
    store.state = project([{ id: 'a', start: 30, end: 40, speed: 1 }])
    scan.state = done([row('music-500', 5, 110), row('cough-3500', 35, 35.4)])
    view()
    click(buttonOf('music-500', 'Cut'))
    view()
    expect(store.updates).toBe(0)
    expect(textOf(byTestId('sounds-refused')?.el.props.children)).toBe(SOUNDS_COPY.wholeVideo)
    expect(said()).toBe(SOUNDS_COPY.wholeVideo)
    // The next action that goes through takes it away.
    click(buttonOf('cough-3500', 'Mute'))
    view()
    expect(store.updates).toBe(1)
    expect(byTestId('sounds-refused')).toBeUndefined()
  })
})

describe('Play', () => {
  // Kept 0–55 s of 60 s: the end, typing while the recording was stopped, is trimmed.
  const trimmed = (): Project => project([{ id: 'a', start: 0, end: 55, speed: 1 }], 60)

  it('plays a sound with half a second around it', () => {
    store.state = trimmed()
    scan.state = done([row('cough-1000', 10, 10.4)])
    view()
    click(buttonOf('cough-1000', 'Play'))
    view()
    expect(player.calls).toEqual(['pause', 'seek 9.5', 'play'])
    expect(player.playing).toBe(true)
  })

  it('says a sound in a trimmed end is cut out, rather than playing the whole video from its start', () => {
    store.state = trimmed()
    scan.state = done([row('typing-5700', 57, 57.6)])
    view()
    click(buttonOf('typing-5700', 'Play'))
    view()
    expect(player.calls).toEqual([])
    expect(player.playing).toBe(false)
    expect(textOf(byTestId('sounds-refused')?.el.props.children)).toBe(SOUNDS_COPY.playCut)
    expect(said()).toBe(SOUNDS_COPY.playCut)
  })

  it('also when only the edit’s last frame is left before it, where the player starts the video over', () => {
    store.state = trimmed()
    scan.state = done([row('typing-5548', 55.48, 56)])
    view()
    click(buttonOf('typing-5548', 'Play'))
    view()
    // The playhead is put back where it was asked to go, and nothing plays.
    expect(player.playing).toBe(false)
    expect(player.time).toBeCloseTo(54.98, 6)
    expect(textOf(byTestId('sounds-refused')?.el.props.children)).toBe(SOUNDS_COPY.playCut)
  })

  it('plays the kept half second before a sound that is cut, and says nothing of a cut around it all', () => {
    store.state = project([
      { id: 'a', start: 0, end: 10, speed: 1 },
      { id: 'b', start: 20, end: 60, speed: 1 }
    ])
    scan.state = done([row('dog-1010', 10.1, 10.3), row('dog-1400', 14, 15)])
    view()
    click(buttonOf('dog-1010', 'Play'))
    view()
    expect(player.calls).toEqual(['pause', 'seek 9.6', 'play'])
    expect(byTestId('sounds-refused')).toBeUndefined()
    player.calls = []
    // Cut with the half second around it: playing would only jump to 20 s.
    click(buttonOf('dog-1400', 'Play'))
    view()
    expect(player.calls).toEqual([])
    expect(textOf(byTestId('sounds-refused')?.el.props.children)).toBe(SOUNDS_COPY.playCut)
  })
})

describe('Play’s stop', () => {
  /** Plays the music row 10–100 s and lets playback run to `t`. */
  function playing(): void {
    scan.state = done([row('music-1000', 10, 100)])
    view()
    click(buttonOf('music-1000', 'Play'))
    view()
    player.calls = []
    player.time = 12
    tick()
    expect(player.calls).toEqual([])
  }

  it('pauses half a second after the sound', () => {
    playing()
    player.time = 100.4
    tick()
    expect(player.calls).toEqual([])
    player.time = 100.52
    tick()
    expect(player.calls).toEqual(['pause'])
    expect(timers.size).toBe(0)
  })

  it('lets the user’s own playback go on once they move the playhead past it', () => {
    playing()
    // A click on the timeline at 110 s while playing: playback goes on from there.
    player.seek(110)
    player.calls = []
    tick()
    expect(player.calls).toEqual([])
    expect(player.playing).toBe(true)
    expect(timers.size).toBe(0)
  })

  it('or back before it: playback is not stopped later at the sound’s end', () => {
    playing()
    player.seek(5)
    tick()
    player.calls = []
    player.time = 101
    tick()
    expect(player.calls).toEqual([])
    expect(player.playing).toBe(true)
  })
})

describe('the focus and what is said as the finder moves on', () => {
  const find = (): FakeNode => byTestId('sounds-find')!
  const statusButton = (text: string): FakeNode => byTestId('sounds-status')!.querySelectorAll('button').find((n) => textOf(n.el.props.children) === text)!
  /** Find pressed with the keyboard (the focus is on it). */
  function findWithKeyboard(): void {
    view()
    find().focus()
    click(find())
    view()
  }

  it('goes from Find to Cancel, then to the first sound, and the result is said', () => {
    findWithKeyboard()
    expect(scan.started).toBe(1)
    expect(doc.activeElement).toBe(statusButton('Cancel'))
    scan.state = done([row('cough-300', 3, 3.4), row('ping-900', 9, 9.5)])
    view()
    expect(doc.activeElement).toBe(buttonOf('cough-300', 'Play'))
    expect(said()).toBe('2 found. Nothing changes until you choose.')
  })

  it('goes to the sentence when nothing is found, which is said', () => {
    findWithKeyboard()
    scan.state = done([])
    view()
    const hint = byTestId('sounds-status')!.querySelector('p')!
    expect(textOf(hint.el.props.children)).toBe(SOUNDS_COPY.none)
    expect(doc.activeElement).toBe(hint)
    expect(said()).toBe(SOUNDS_COPY.none)
  })

  it('goes back to Find after Cancel, and from Try again to Cancel', () => {
    findWithKeyboard()
    click(statusButton('Cancel'))
    view()
    expect(scan.cancelled).toBe(1)
    expect(doc.activeElement).toBe(find())
    click(find())
    view()
    scan.state = { status: 'failed', message: 'The file is missing.' }
    view()
    expect(doc.activeElement).toBe(statusButton('Try again'))
    click(statusButton('Try again'))
    view()
    expect(doc.activeElement).toBe(statusButton('Cancel'))
  })

  it('stays where the user put it meanwhile', () => {
    findWithKeyboard()
    const timeline = { name: 'the timeline' }
    focusOn(timeline)
    scan.state = done([row('cough-300', 3, 3.4)])
    view()
    expect(doc.activeElement).toBe(timeline)
    expect(said()).toBe('1 found. Nothing changes until you choose.')
    // Nor is it taken when the list shows at once (sounds found before).
    cells = []
    nodes.clear()
    doc.activeElement = body
    view()
    expect(doc.activeElement).toBe(body)
  })

  it('does not show a refusal again with the next list', () => {
    store.state = project([{ id: 'a', start: 30, end: 40, speed: 1 }])
    scan.state = done([row('music-500', 5, 110)])
    view()
    click(buttonOf('music-500', 'Cut'))
    view()
    expect(byTestId('sounds-refused')).toBeDefined()
    scan.state = { status: 'idle' }
    view()
    click(find())
    view()
    scan.state = done([row('music-500', 5, 110)])
    view()
    expect(byTestId('sounds-refused')).toBeUndefined()
  })

  it('says the same result again after listening again', () => {
    findWithKeyboard()
    scan.state = done([row('cough-300', 3, 3.4)])
    view()
    expect(said()).toBe('1 found. Nothing changes until you choose.')
    // The recording's sources changed: Find again.
    scan.state = { status: 'idle' }
    view()
    click(find())
    view()
    expect(said()).toBe('')
    scan.state = done([row('cough-300', 3, 3.4)])
    view()
    expect(said()).toBe('1 found. Nothing changes until you choose.')
  })
})

describe('Mute all', () => {
  it('sends the focus to the first row and scrolls the list back to it', () => {
    scan.state = done([row('cough-300', 3, 3.4), row('ping-1000', 10, 10.3), row('typing-2000', 20, 21)])
    view()
    // Reached with Tab below the list, which scrolled to its end on the way.
    const muteAll = all().find((n) => n.el.type === 'button' && textOf(n.el.props.children) === SOUNDS_COPY.muteAll)
    if (!muteAll) throw new Error('no Mute all')
    muteAll.focus()
    click(muteAll)
    view()
    expect(store.updates).toBe(1)
    expect(doc.activeElement).toBe(buttonOf('cough-300', 'Restore'))
    expect(scrolled).toEqual([{ key: 'cough-300', options: { block: 'nearest' } }])
  })
})

describe('a muted stretch that no found row claims', () => {
  // Muted in an earlier session as cough-497; this listen no longer finds that cough.
  const orphan = (): Project => ({ ...project(), sounds: { spans: [{ start: 4.97, end: 5.3, action: 'mute', key: 'cough-497' }], ignored: [] } })

  it('sends the focus to the next row once restored', () => {
    store.state = orphan()
    scan.state = done([row('dog-1000', 10, 10.5)])
    view()
    const restore = buttonOf('cough-497', 'Restore')
    restore.focus()
    click(restore)
    view()
    expect(store.state.sounds?.spans ?? []).toEqual([])
    expect(rowOf('cough-497')).toBeUndefined()
    expect(doc.activeElement).toBe(buttonOf('dog-1000', 'Mute'))
  })

  it('sends the focus to the sentence, not to the page, when it was the only row', () => {
    store.state = orphan()
    scan.state = done([])
    view()
    const restore = buttonOf('cough-497', 'Restore')
    restore.focus()
    click(restore)
    view()
    expect(store.state.sounds?.spans ?? []).toEqual([])
    expect(byTestId('sound-list')).toBeUndefined()
    const hint = byTestId('sounds-status')!.querySelector('p')!
    expect(textOf(hint.el.props.children)).toBe(SOUNDS_COPY.none)
    expect(doc.activeElement).toBe(hint)
  })
})
