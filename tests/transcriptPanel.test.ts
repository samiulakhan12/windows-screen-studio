import v8 from 'node:v8'
import vm from 'node:vm'
import { beforeEach, describe, expect, it, vi } from 'vitest'
import type { CaptionSegment, Clip, Project, Transcript } from '../src/shared/types'

/*
 * The Transcript tab (editor/panels/TranscriptPanel.tsx, docs/design/edit-by-text.md §5) without a
 * DOM: React's hooks are swapped for a few lines that keep each component's state by its place in
 * the tree (as in captionsPanel.test.ts), so the tab's components can be called as functions and their
 * elements read and their handlers called. The word list's ref gets a stand-in element with a simple
 * layout (one word per 10 px line, 100 px tall), so focus and scrolling are seen.
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

/** What the tab did: notices shown, timeline selections asked for, elements focused, words scrolled into view. */
const log: { notices: string[]; selects: unknown[]; focused: string[]; scrolledIntoView: string[] } = { notices: [], selects: [], focused: [], scrolledIntoView: [] }

class FakeElement {}
vi.stubGlobal('Element', FakeElement)
/** A focusable element outside the word list (a button), in the Inspector. */
class FakeHTMLElement extends FakeElement {
  isConnected = true
  closest(sel: string): unknown {
    return sel === '.inspector' ? this : null
  }
}
vi.stubGlobal('HTMLElement', FakeHTMLElement)
/** Callbacks waiting on window.setTimeout, run by the test. */
const timers: (() => void)[] = []
vi.stubGlobal('window', { addEventListener: () => undefined, removeEventListener: () => undefined, setTimeout: (fn: () => void) => timers.push(fn) })
/** The open tab's button on the Inspector's rail. */
const railButton = {
  focus(): void {
    log.focused.push('rail button')
    doc.activeElement = railButton
  }
}
const doc: { activeElement: unknown; body: object; elementFromPoint: () => null; querySelector: (sel: string) => unknown } = {
  activeElement: null,
  body: {},
  elementFromPoint: () => null,
  querySelector: (sel) => (sel === '.inspector .insp-tabs button.active' ? railButton : null)
}
vi.stubGlobal('document', doc)

let store: { state: Project; update: (fn: (p: Project) => Project) => void }
let playing = false
const player = {
  time: 0,
  subscribe: () => () => undefined,
  getPlaying: () => playing,
  seek(t: number) {
    player.time = t
  }
}
const editor = {
  get store() {
    return store
  },
  player
}

vi.doMock('react', async (importOriginal) => ({
  ...(await importOriginal<Record<string, unknown>>()),
  useState: (init: unknown) => {
    const c = cell()
    if (!('value' in c)) c.value = typeof init === 'function' ? (init as () => unknown)() : init
    const set = (v: unknown): void => {
      const next = typeof v === 'function' ? (v as (x: unknown) => unknown)(c.value) : v
      if (!Object.is(next, c.value)) dirty = true
      c.value = next
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
  useSyncExternalStore: (_subscribe: unknown, get: () => unknown) => get(),
  useContext: () => editor
}))

// Renderer code: imported at run time so the Node typecheck of tests/ does not follow it.
const PANEL = '../src/renderer/src/editor/panels/TranscriptPanel'
const { TranscriptPanel } = (await import(/* @vite-ignore */ PANEL)) as { TranscriptPanel: (props: unknown) => unknown }

const RENDERED = new Set(['TranscriptPanel', 'TranscriptEditor', 'TranscriptIntro', 'ReviewSection'])

/** The word list's stand-in: one word per 10 px line, 100 px of it shown, scrolled by scrollTop. */
class ListStandIn {
  scrollTop = 0
  clientTop = 0
  clientHeight = 100
  constructor(public el: El) {}
  focus(): void {
    log.focused.push('list')
    doc.activeElement = this
  }
  getBoundingClientRect(): { top: number; bottom: number } {
    return { top: 0, bottom: 100 }
  }
  querySelector(sel: string): unknown {
    const m = /^#tw-(\d+)$/.exec(sel)
    if (!m || !descendants(this.el).some((d) => d.props.id === `tw-${m[1]}`)) return null
    const top = Number(m[1]) * 10 - this.scrollTop
    return {
      getBoundingClientRect: () => ({ top, bottom: top + 10 }),
      scrollIntoView: () => log.scrolledIntoView.push(sel)
    }
  }
}

/** Calls the components in RENDERED (hooks kept by `path`) and lists every other element under them. */
function walk(node: unknown, path: string, out: El[]): void {
  if (Array.isArray(node)) return node.forEach((n, i) => walk(n, `${path}.${i}`, out))
  if (!node || typeof node !== 'object' || !('props' in node)) return
  const el = node as El
  if (typeof el.type === 'function' && RENDERED.has(el.type.name)) {
    if (!cells.has(path)) cells.set(path, [])
    hooks = { cells: cells.get(path)!, i: 0 }
    const child = (el.type as (p: unknown) => unknown)(el.props)
    hooks = null
    return walk(child, `${path}/${el.type.name}`, out)
  }
  const ref = (node as { ref?: { current?: unknown } | null }).ref
  if (ref && typeof ref === 'object') {
    if (!ref.current) ref.current = new ListStandIn(el)
    else if (ref.current instanceof ListStandIn) ref.current.el = el
  }
  out.push(el)
  walk(el.props.children, path, out)
}

/** The host elements under `el` (its children, theirs, …). */
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

/** The tab for the project in the store, rendered until its state and effects settle. */
function render(): El[] {
  for (let pass = 0; pass < 20; pass++) {
    dirty = false
    const out: El[] = []
    const props = {
      project: store.state,
      selection: null,
      onSelect: (s: unknown) => log.selects.push(s),
      onNotice: (m: string) => log.notices.push(m),
      onOpenCaptions: () => undefined
    }
    walk({ type: TranscriptPanel, props }, 'root', out)
    const run = effects
    effects = []
    run.forEach((e) => e())
    if (!dirty) return out
  }
  throw new Error('The tab keeps rendering')
}

/** Unmounts the tab (its effects cleaned up, its state gone). */
function unmount(): void {
  for (const list of cells.values()) for (const c of list) c.cleanup?.()
  cells.clear()
  effects = []
}

const textOf = (node: unknown): string =>
  Array.isArray(node) ? node.map(textOf).join('') : typeof node === 'string' || typeof node === 'number' ? String(node) : node && typeof node === 'object' && 'props' in node ? textOf((node as El).props.children) : ''
const button = (out: El[], label: string): El => {
  const b = out.find((e) => e.type === 'button' && textOf(e.props.children).trim() === label)
  if (!b) throw new Error(`No "${label}" button`)
  return b
}
/** A mouse click on a button (`detail` 1), or Enter or Space on it from the keyboard (`detail` 0). */
const click = (label: string, detail = 1): void => {
  ;(button(render(), label).props.onClick as (e: unknown) => void)({ detail })
  // A mouse click leaves the focus on the button, which the editor then releases to the page.
  if (detail > 0) doc.activeElement = doc.body
}
const list = (out = render()): El => out.find((e) => e.props.role === 'listbox')!

/** The word list's stand-in element. */
function standIn(): ListStandIn {
  for (const c of [...cells.values()].flat()) if (c.current instanceof ListStandIn) return c.current
  throw new Error('No word list')
}

/** A press of the main button on word `i` (focus goes to the list, as the browser would put it there). */
function pointerDown(i: number, shift = false): void {
  const target = Object.assign(new FakeElement(), { closest: () => ({ dataset: { w: String(i) } }) })
  ;(list().props.onPointerDown as (e: unknown) => void)({ button: 0, target, shiftKey: shift, preventDefault: () => undefined })
  render()
}

/**
 * A key pressed on `target` (the word list, a button): its own handler, then the tab's (no element
 * between has one), as the key bubbles; whether the tab kept it from the editor's shortcuts.
 */
function keyDown(target: El, key: string, mods: { shift?: boolean; ctrl?: boolean; code?: string } = {}): boolean {
  let stopped = false
  const e = {
    key,
    code: mods.code ?? '',
    shiftKey: !!mods.shift,
    ctrlKey: !!mods.ctrl,
    metaKey: false,
    altKey: false,
    preventDefault: () => undefined,
    stopPropagation: () => void (stopped = true)
  }
  const panel = render().find((el) => el.props.className === 'transcript-panel')!
  for (const el of [target, panel]) if (!stopped) (el.props.onKeyDown as ((e: unknown) => void) | undefined)?.(e)
  render()
  return stopped
}
/** A key pressed in the word list. */
const press = (key: string, mods: { shift?: boolean; ctrl?: boolean; code?: string } = {}): boolean => keyDown(list(), key, mods)

const selectedWords = (): number[] =>
  render()
    .filter((e) => e.props.role === 'option' && e.props['aria-selected'] === true)
    .map((e) => Number(e.props['data-w']))

const seg = (id: string, start: number, end: number, words: [string, number, number][]): CaptionSegment => ({
  id,
  start,
  end,
  text: words.map((w) => w[0]).join(' '),
  words: words.map(([text, s, e]) => ({ text, start: s, end: e }))
})

function useProject(duration: number, segments: CaptionSegment[], clips: Clip[] = [{ id: 'c', start: 0, end: duration, speed: 1 }]): void {
  const transcript: Transcript = { provider: 'local', model: 'test', createdAt: '', language: 'en', segments }
  const state = { id: 'p1', duration, clips, hasAudio: true, freezes: [], transcript } as unknown as Project
  store = {
    state,
    update(fn) {
      store.state = fn(store.state)
    }
  }
}

/** `n` captions of three words each, a second apart. */
const captions = (n: number): CaptionSegment[] =>
  Array.from({ length: n }, (_, i) =>
    seg(`s${i}`, i, i + 0.9, [
      [`one${i}`, i, i + 0.2],
      [`two${i}`, i + 0.3, i + 0.5],
      [`three${i}.`, i + 0.6, i + 0.9]
    ])
  )

beforeEach(() => {
  unmount()
  playing = false
  player.time = 0
  doc.activeElement = null
  timers.length = 0
  log.notices.length = 0
  log.selects.length = 0
  log.focused.length = 0
  log.scrolledIntoView.length = 0
})

describe('the Transcript tab', () => {
  it('Ctrl+A then Delete on every word says it would cut the whole video', () => {
    // A 5 s recording whose words run from 0.55 to 4.45 s: the cut stops 0.05 s short of each end.
    useProject(5, [
      seg('a', 0.55, 4.45, [
        ['So', 0.55, 1],
        ['this', 1.2, 2],
        ['works.', 2.2, 4.45]
      ])
    ])
    render()
    press('a', { ctrl: true, code: 'KeyA' })
    expect(selectedWords()).toEqual([0, 1, 2])
    press('Delete')
    expect(log.notices).toEqual(['That would cut the whole video'])
    expect(store.state.clips).toEqual([{ id: 'c', start: 0, end: 5, speed: 1 }])
  })

  it('Delete on a zero-length word between touching words says it is too short', () => {
    useProject(10, [
      seg('a', 1, 2, [
        ['a', 1, 1.5],
        ['b', 1.5, 1.5],
        ['c', 1.5, 2]
      ])
    ])
    render()
    press('Home')
    press('ArrowRight')
    expect(selectedWords()).toEqual([1])
    press('Delete')
    expect(log.notices).toEqual(['Too short to cut on its own. Select more words'])
  })

  it('Ctrl+A selects every word on a Cyrillic, Greek or Bangla layout too, and keeps it from the editor', () => {
    useProject(10, captions(3))
    for (const key of ['ф', 'α', 'ো', 'A']) {
      unmount()
      render()
      expect(press(key, { ctrl: true, code: 'KeyA' })).toBe(true)
      expect(selectedWords()).toHaveLength(9)
    }
  })

  it('a word selection clears the timeline selection, so Delete outside the list never removes a hidden item', () => {
    useProject(60, captions(3))
    render()
    pointerDown(4)
    expect(selectedWords()).toEqual([4])
    expect(log.selects).toEqual([null])
    log.selects.length = 0
    press('ArrowRight', { shift: true })
    expect(selectedWords()).toEqual([4, 5])
    expect(log.selects).toContain(null)
    log.selects.length = 0
    press('a', { ctrl: true, code: 'KeyA' })
    expect(log.selects).toContain(null)
  })

  it('Find clears the timeline selection, and Delete on a review or toolbar button stays in the tab', () => {
    // Two fillers, "um" and "uh".
    useProject(10, [
      seg('a', 1, 4, [
        ['So', 1, 1.2],
        ['um', 1.5, 1.7],
        ['this', 2, 2.2],
        ['works', 2.3, 2.6],
        ['uh', 2.9, 3.1],
        ['fine.', 3.4, 3.8]
      ])
    ])
    render()
    click('Find fillers and retakes')
    expect(log.selects).toEqual([null])
    // Tab to a row's buttons (or back to Find) and press Delete or Backspace, meaning "drop this one":
    // nothing is cut, and the key never reaches the editor (which would delete its hidden selection).
    const out = render()
    const goTo = out.find((e) => e.type === 'button' && e.props.title === 'Go to it')!
    for (const target of [goTo, button(out, 'Keep'), button(out, 'Remove'), button(out, 'Remove all'), button(out, 'Close'), button(out, 'Find fillers and retakes')])
      for (const key of ['Delete', 'Backspace']) expect(keyDown(target, key), `${key} on ${textOf(target.props.children)}`).toBe(true)
    expect(store.state.clips).toEqual([{ id: 'c', start: 0, end: 10, speed: 1 }])
    expect(log.notices).toEqual(['Found 2 fillers and retakes'])
    expect(render().filter((e) => e.type === 'li')).toHaveLength(2)
    // With words selected, Delete there cuts them, as in the list.
    pointerDown(2)
    expect(keyDown(button(render(), 'Keep'), 'Delete')).toBe(true)
    expect(log.notices.at(-1)).toMatch(/^Cut 1 word \(/)
  })

  it('Go to it clears the timeline selection, also on a review list kept from before that selection', () => {
    useProject(10, [
      seg('a', 1, 4, [
        ['So', 1, 1.2],
        ['um', 1.5, 1.7],
        ['this', 2, 2.2],
        ['works.', 2.3, 2.6]
      ])
    ])
    render()
    click('Find fillers and retakes')
    // A clip clicked on the timeline (another tab), then the Transcript tab again: the list comes back
    // without a Find, and the clip stays selected.
    unmount()
    log.selects.length = 0
    const goTo = render().find((e) => e.type === 'button' && e.props.title === 'Go to it')!
    // A mouse click leaves the focus on the page, where Delete is the editor's.
    ;(goTo.props.onClick as (e: unknown) => void)({ detail: 1 })
    render()
    expect(player.time).toBe(1.5)
    expect(log.selects).toEqual([null])
  })

  it('Find, Earlier and Later give the focus back to the word list', () => {
    useProject(60, captions(45))
    render()
    pointerDown(4)
    for (const label of ['Later', 'Earlier', 'Find fillers and retakes']) {
      log.focused.length = 0
      click(label)
      expect(log.focused, label).toEqual(['list'])
    }
  })

  it('Keep, Remove, Remove all and Close give the focus back to the word list, as their row or the list goes', () => {
    // Two fillers, "um" and "uh".
    const fillers = (): CaptionSegment[] => [
      seg('a', 1, 4, [
        ['So', 1, 1.2],
        ['um', 1.5, 1.7],
        ['this', 2, 2.2],
        ['works', 2.3, 2.6],
        ['uh', 2.9, 3.1],
        ['fine.', 3.4, 3.8]
      ])
    ]
    const rows = (): number => render().filter((e) => e.type === 'li').length
    // A mouse click (detail 1), and Enter from the keyboard (detail 0).
    for (const detail of [1, 0]) {
      for (const [label, left] of [
        ['Keep', 1],
        ['Remove', 1],
        ['Remove all', 0],
        ['Close', 0]
      ] as const) {
        unmount()
        useProject(10, fillers())
        render()
        click('Find fillers and retakes')
        expect(rows()).toBe(2)
        log.focused.length = 0
        click(label, detail)
        expect(rows(), label).toBe(left)
        expect(log.focused, `${label} (detail ${detail})`).toEqual(['list'])
      }
    }
  })

  it('Make captions gives the keyboard to the Captions tab, not the top of the window, as this tab goes', () => {
    useProject(10, [])
    // The Captions tab put the focus on a button of its own (Cancel on this PC), or nothing caught it (Cancel of an AI run).
    for (const caught of [true, false]) {
      timers.length = 0
      log.focused.length = 0
      // Enter on the button: the focus is on it, in the Inspector.
      doc.activeElement = new FakeHTMLElement()
      ;(button(render(), 'Make captions').props.onClick as (e: unknown) => void)({ detail: 0 })
      // The Captions tab replaces this one, and the focused button goes with it.
      doc.activeElement = caught ? new FakeHTMLElement() : doc.body
      timers.splice(0).forEach((run) => run())
      expect(log.focused, caught ? 'caught' : 'not caught').toEqual(caught ? [] : ['rail button'])
    }
  })

  it('the arrow keys start on the page chosen with Earlier and Later', () => {
    // 45 captions of three words: page 1 holds captions 0..39 (words 0..119), page 2 the rest.
    useProject(60, captions(45))
    render()
    const shownWords = (): number[] => render().filter((e) => e.props.role === 'option').map((e) => Number(e.props['data-w']))
    // No selection yet: Later, then Right selects the page's first word and the page stays.
    click('Later')
    press('ArrowRight')
    expect(selectedWords()).toEqual([120])
    expect(shownWords()[0]).toBe(120)
    // A selection on page 1: Later, then Left selects the page's last word.
    pointerDown(4)
    expect(shownWords()[0]).toBe(0)
    click('Later')
    press('ArrowLeft')
    expect(selectedWords()).toEqual([134])
    expect(shownWords()[0]).toBe(120)
    // Shift extends the selection from its anchor onto the page shown.
    pointerDown(130)
    click('Earlier')
    press('ArrowDown', { shift: true })
    expect(list().props['aria-activedescendant']).toBe('tw-0')
    expect(selectedWords()).toEqual(Array.from({ length: 120 }, (_, i) => i))
    click('Later')
    expect(selectedWords()).toEqual(Array.from({ length: 11 }, (_, i) => 120 + i))
    // Home and End go where they always go; on the page that holds the focus the keys move from it.
    press('Home')
    expect(selectedWords()).toEqual([0])
    press('ArrowRight')
    expect(selectedWords()).toEqual([1])
  })

  it('after playback turned the page, the arrow keys move from the selection as before', () => {
    useProject(60, captions(45))
    render()
    const shownWords = (): number[] => render().filter((e) => e.props.role === 'option').map((e) => Number(e.props['data-w']))
    // The last two words of page 1, then playback runs on into caption 41 ("two41", word 124): the tab turns to page 2.
    pointerDown(118)
    pointerDown(119, true)
    playing = true
    player.time = 41.35
    render()
    expect(shownWords()[0]).toBe(120)
    playing = false
    render()
    // Shift+Left drops one word; Left moves one word.
    press('ArrowLeft', { shift: true })
    expect(selectedWords()).toEqual([118])
    expect(shownWords()[0]).toBe(0)
    press('ArrowLeft')
    expect(selectedWords()).toEqual([117])
  })

  it('with nothing selected, the arrow keys start on the page shown, also after playback turned it or Escape cleared the selection', () => {
    useProject(60, captions(45))
    const shownWords = (): number[] => render().filter((e) => e.props.role === 'option').map((e) => Number(e.props['data-w']))
    // Playback runs into caption 41 without a word clicked: the tab turns to page 2.
    for (const key of ['ArrowRight', 'ArrowLeft']) {
      unmount()
      playing = true
      player.time = 41.35
      render()
      playing = false
      expect(shownWords()[0]).toBe(120)
      press(key)
      expect(selectedWords(), key).toEqual([key === 'ArrowRight' ? 120 : 134])
      expect(shownWords()[0], key).toBe(120)
    }
    // A word on page 2, then Escape.
    unmount()
    render()
    pointerDown(125)
    press('Escape')
    expect(selectedWords()).toEqual([])
    press('ArrowRight')
    expect(selectedWords()).toEqual([120])
    expect(shownWords()[0]).toBe(120)
  })

  it('Earlier and Later keep the focus when pressed from the keyboard, so Enter turns page after page', () => {
    // 130 captions: four pages.
    useProject(140, captions(130))
    render()
    const shownWords = (): number[] => render().filter((e) => e.props.role === 'option').map((e) => Number(e.props['data-w']))
    for (const first of [120, 240]) {
      click('Later', 0)
      expect(shownWords()[0]).toBe(first)
    }
    click('Earlier', 0)
    expect(shownWords()[0]).toBe(120)
    expect(log.focused).toEqual([])
    // The arrow keys then start on the page shown.
    press('ArrowRight')
    expect(selectedWords()).toEqual([120])
  })

  it('Later pressed from the keyboard onto the last page, or Earlier onto the first, gives the focus to the word list, as the button turns disabled', () => {
    // 130 captions: four pages. Two (45 captions): Later reaches the last page at once.
    for (const [n, presses] of [
      [130, 3],
      [45, 1]
    ]) {
      unmount()
      useProject(140, captions(n))
      render()
      log.focused.length = 0
      for (let k = 1; k <= presses; k++) {
        click('Later', 0)
        expect(log.focused, `${n} captions, Later ${k}`).toEqual(k < presses ? [] : ['list'])
      }
      expect(button(render(), 'Later').props.disabled).toBe(true)
      log.focused.length = 0
      for (let k = 1; k <= presses; k++) {
        click('Earlier', 0)
        expect(log.focused, `${n} captions, Earlier ${k}`).toEqual(k < presses ? [] : ['list'])
      }
      expect(button(render(), 'Earlier').props.disabled).toBe(true)
    }
  })

  it('Find says what it found', () => {
    useProject(10, [
      seg('a', 1, 4, [
        ['So', 1, 1.2],
        ['um', 1.5, 1.7],
        ['this', 2, 2.2],
        ['works', 2.3, 2.6],
        ['uh', 2.9, 3.1],
        ['fine.', 3.4, 3.8]
      ])
    ])
    render()
    click('Find fillers and retakes')
    expect(log.notices).toEqual(['Found 2 fillers and retakes'])
    unmount()
    useProject(10, captions(1))
    render()
    click('Find fillers and retakes')
    expect(log.notices.at(-1)).toBe('No fillers or retakes found')
  })

  it('while playing, follows the word being said in the word list only (the Inspector does not move)', () => {
    useProject(60, captions(45))
    render()
    const list = standIn()
    playing = true
    // "two5" (5.3 to 5.5 s), word 16: below the 100 px shown, scrolled up to just show it.
    player.time = 5.35
    render()
    expect(log.scrolledIntoView).toEqual([])
    expect(list.scrollTop).toBe(70)
    // "two1", word 4, above it now: scrolled back down to it.
    player.time = 1.35
    render()
    expect(log.scrolledIntoView).toEqual([])
    expect(list.scrollTop).toBe(40)
    // In view: nothing moves.
    player.time = 1.65
    render()
    expect(list.scrollTop).toBe(40)
  })

  it('Delete and Remove in captions without word timings store their times, and the review list stays, also across undo', () => {
    // A caption with no word timings (a provider that gives none): every word time is estimated.
    const untimed = (): CaptionSegment[] => [{ id: 'a', start: 1, end: 4, text: 'So um this works uh fine.' }]
    const rows = (): number => render().filter((e) => e.type === 'li').length
    useProject(10, untimed())
    render()
    click('Find fillers and retakes')
    expect(rows()).toBe(2)
    const before = store.state
    click('Remove')
    // The times the cut was made by are kept with it (one store update), and the other row stays.
    const words = store.state.transcript!.segments[0].words!
    expect(words.map((w) => w.text)).toEqual(['So', 'um', 'this', 'works', 'uh', 'fine.'])
    expect(store.state.clips).not.toBe(before.clips)
    expect(rows()).toBe(1)
    // Undo with the tab open, and with it closed: the removed row comes back.
    const removed = store.state
    store.state = before
    expect(rows()).toBe(2)
    store.state = removed
    expect(rows()).toBe(1)
    unmount()
    store.state = before
    expect(rows()).toBe(2)
    // Delete on a word does the same.
    unmount()
    useProject(10, untimed())
    pointerDown(3)
    press('Delete')
    expect(store.state.transcript!.segments[0].words?.length).toBe(6)
    expect(store.state.clips.length).toBe(2)
  })

  it('keeps the review list while the tab is closed, and nothing of it once the editor is gone', async () => {
    const fillers = (): CaptionSegment[] => [
      seg('a', 1, 4, [
        ['So', 1, 1.2],
        ['um', 1.5, 1.7],
        ['this', 2, 2.2],
        ['works.', 2.3, 2.6]
      ])
    ]
    const rows = (): number => render().filter((e) => e.type === 'li').length
    let gone: WeakRef<object> | null = null
    ;(() => {
      useProject(10, fillers())
      gone = new WeakRef(store.state.transcript!)
      render()
      click('Find fillers and retakes')
      expect(rows()).toBe(1)
      // Another tab, then back: the list is still there.
      unmount()
      expect(rows()).toBe(1)
      unmount()
    })()
    // The editor closes (its project and transcript go); the same project opened again starts afresh.
    doc.activeElement = null
    useProject(10, fillers())
    expect(rows()).toBe(0)
    unmount()
    v8.setFlagsFromString('--expose-gc')
    const gc = vm.runInNewContext('gc') as () => void
    for (let i = 0; i < 5 && gone!.deref(); i++) {
      await new Promise((r) => setTimeout(r, 0))
      gc()
    }
    expect(gone!.deref()).toBeUndefined()
  })
})
