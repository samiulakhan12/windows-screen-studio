import { beforeEach, describe, expect, it, vi } from 'vitest'
import { createProject } from '../src/shared/engine/project'
import { NEW_CHAPTER_BAR } from '../src/shared/render/chapterBar'
import { magnifierPhase } from '../src/shared/render/magnifier'
import type { CursorTrack, Project, Spotlight } from '../src/shared/types'

/*
 * The magnifier's and the progress bar's panels (docs/design/editing-polish.md §2.2, §2.4, §12,
 * §19.1 test 35) without a DOM: the components are called as functions (as
 * tests/followSection.test.ts does), with React's hooks swapped for a few lines and the editor's
 * contexts (store, player, keymap, the group's commands) answered here. Also the editor's
 * addMagnifierAt, with a fake store and player.
 */

interface El {
  type: unknown
  props: Record<string, unknown>
}

let store: { state: Project; updates: number; keys: (string | undefined)[]; update: (fn: (p: Project) => Project, key?: string) => void; beginGesture(): void; endGesture(): void }
const player = { time: 4, seek: (t: number) => void (player.time = t), subscribe: () => () => undefined }
const commands: string[] = []
const selected: unknown[] = []
const contexts: { group?: unknown; keymap?: unknown } = {}

vi.doMock('react', async (importOriginal) => ({
  ...(await importOriginal<Record<string, unknown>>()),
  useMemo: (fn: () => unknown) => fn(),
  useRef: (init: unknown) => ({ current: init }),
  useState: (init: unknown) => [typeof init === 'function' ? (init as () => unknown)() : init, () => undefined],
  useEffect: () => undefined,
  useSyncExternalStore: (_subscribe: unknown, get: () => unknown) => get(),
  useContext: (ctx: unknown) => {
    if (ctx === contexts.keymap) return KEYMAP
    if (ctx === contexts.group) return { command: (id: string) => commands.push(id), select: (keys: unknown) => selected.push(keys) }
    return { store, player }
  }
}))

const { DEFAULT_KEYMAP: KEYMAP } = await import('../src/shared/editor/shortcuts')
// Renderer code: imported at run time so the Node typecheck of tests/ does not follow it.
const P = '../src/renderer/src/editor/'
type Component = (props: unknown) => unknown
const { MagnifierSection, SOFT_NOTE } = (await import(/* @vite-ignore */ `${P}panels/MagnifierSection`)) as { MagnifierSection: Component; SOFT_NOTE: string }
const { MagnifierZoomRow } = (await import(/* @vite-ignore */ `${P}panels/MagnifierZoomRow`)) as { MagnifierZoomRow: Component }
const { ChapterBarSection, FEW_CHAPTERS } = (await import(/* @vite-ignore */ `${P}panels/ChapterBarSection`)) as { ChapterBarSection: Component; FEW_CHAPTERS: string }
const { ProgressBarLink } = (await import(/* @vite-ignore */ `${P}panels/ProgressBarLink`)) as { ProgressBarLink: Component }
const { addMagnifierAt } = (await import(/* @vite-ignore */ `${P}playheadItems`)) as {
  addMagnifierAt: (services: unknown, mode: 'region' | 'cursor', cursor: CursorTrack | null, opts: { onSelect: (s: unknown) => void }) => Spotlight
}
contexts.group = ((await import(/* @vite-ignore */ `${P}groupContext`)) as { GroupContext: unknown }).GroupContext
contexts.keymap = ((await import(/* @vite-ignore */ `${P}keymapContext`)) as { KeymapContext: unknown }).KeymapContext

/** Every element under `root`, components called. */
function render(root: El): El[] {
  const out: El[] = []
  const walk = (node: unknown): void => {
    if (Array.isArray(node)) return node.forEach(walk)
    if (!node || typeof node !== 'object' || !('props' in node)) return
    const el = node as El
    if (typeof el.type === 'function') return walk((el.type as (p: unknown) => unknown)(el.props))
    out.push(el)
    walk(el.props.children)
  }
  walk(root)
  return out
}
const textOf = (node: unknown): string => {
  if (typeof node === 'string' || typeof node === 'number') return String(node)
  if (Array.isArray(node)) return node.map(textOf).join('')
  if (node && typeof node === 'object' && 'props' in node) return textOf((node as El).props.children)
  return ''
}
const byId = (els: El[], id: string): El | undefined => els.find((e) => e.props['data-testid'] === id)
const radios = (els: El[], id: string): El[] => {
  const host = byId(els, id)!
  return render({ type: 'div', props: { children: host.props.children } }).filter((e) => e.props.role === 'radio')
}
const allText = (els: El[]): string => els.map((e) => (typeof e.props.children === 'string' ? e.props.children : '')).join('\n')

const MAG: Spotlight = { id: 'm1', mode: 'region', start: 2, end: 5, x: 0.4, y: 0.4, w: 0.2, h: 0.3, shape: 'ellipse', dim: 0.2, feather: 0, magnify: 2 }
const TRACK: CursorTrack = { samples: [{ t: 0, x: 0.3, y: 0.6 }, { t: 10, x: 0.3, y: 0.6 }], clicks: [], keys: [], shapes: [], scale: 1, valid: true }

function project(extra: Partial<Project> = {}): Project {
  const p = createProject({ id: 'p', name: 'p', duration: 10, width: 1920, height: 1080, hasWebcam: false, hasAudio: false, webcamOffset: 0, zooms: [], cursorValid: true, capture: { method: 'native', cursorInVideo: false, region: null, target: 'screen' } })
  return { ...p, spotlights: [MAG], ...extra }
}

beforeEach(() => {
  commands.length = 0
  selected.length = 0
  player.time = 4
  store = {
    state: project(),
    updates: 0,
    keys: [],
    update(fn, key) {
      const next = fn(store.state)
      if (next === store.state) return
      store.updates++
      store.keys.push(key)
      store.state = next
    },
    beginGesture() {},
    endGesture() {}
  }
})

const magnifierPanel = (cursor: CursorTrack | undefined = TRACK): El[] => render({ type: MagnifierSection, props: { project: store.state, selection: { kind: 'spotlight', id: 'm1' }, cursor } })

describe('MagnifierSection (test 35)', () => {
  it('the Zoom slider: "2 times", steps of 0.25 from 1.5 to 4, Page Up a whole step, one update per change', () => {
    const zoom = byId(magnifierPanel(), 'magnifier-zoom')!
    expect(zoom.props).toMatchObject({ type: 'range', 'aria-label': 'Zoom', 'aria-valuetext': '2 times', min: 1.5, max: 4, step: 0.25, value: 2 })
    ;(zoom.props.onChange as (e: unknown) => void)({ target: { value: '2.25' } })
    expect(store.updates).toBe(1)
    expect(store.state.spotlights![0].magnify).toBe(2.25)
    expect(byId(magnifierPanel(), 'magnifier-zoom')!.props['aria-valuetext']).toBe('2.25 times')
    let prevented = false
    ;(byId(magnifierPanel(), 'magnifier-zoom')!.props.onKeyDown as (e: unknown) => void)({ key: 'PageUp', preventDefault: () => (prevented = true) })
    expect(prevented).toBe(true)
    expect(store.state.spotlights![0].magnify).toBe(3.25)
    expect(store.updates).toBe(2)
    // A drag merges into one undo step: every change of one slider has the same key.
    expect(new Set(store.keys).size).toBe(1)
  })

  it('the Darkness slider: its label, 0 to 40 %, "20 percent"', () => {
    const dark = byId(magnifierPanel(), 'magnifier-darkness')!
    expect(dark.props).toMatchObject({ 'aria-label': 'Darkness', 'aria-valuetext': '20 percent', min: 0, max: 0.4 })
    ;(dark.props.onChange as (e: unknown) => void)({ target: { value: '0.3' } })
    expect(store.state.spotlights![0].dim).toBe(0.3)
    expect(store.updates).toBe(1)
  })

  it('the softness note shows when the lens would show more than 2.5 output pixels per recorded pixel', () => {
    expect(byId(magnifierPanel(), 'magnifier-soft')).toBeUndefined()
    store.state = { ...store.state, spotlights: [{ ...MAG, magnify: 4 }] }
    const note = byId(magnifierPanel(), 'magnifier-soft')!
    expect(textOf(note)).toBe(SOFT_NOTE)
    // Inside a zoom of 2x the same lens at 2 times is soft too.
    store.state = { ...store.state, spotlights: [MAG], zooms: [{ id: 'z', start: 0, end: 8, scale: 2, focus: { mode: 'fixed', x: 0.5, y: 0.5 }, auto: false }] }
    expect(byId(magnifierPanel(), 'magnifier-soft')).toBeTruthy()
  })

  it('Shape and Follows are radio groups; each change is one update; The cursor needs cursor data', () => {
    const els = magnifierPanel()
    expect(byId(els, 'magnifier-shape')!.props.role).toBe('radiogroup')
    const shape = radios(els, 'magnifier-shape')
    expect(shape.map((r) => [textOf(r), r.props['aria-checked'], r.props.tabIndex])).toEqual([
      ['Round', true, 0],
      ['Rounded rectangle', false, -1]
    ])
    ;(shape[1].props.onClick as () => void)()
    expect(store.state.spotlights![0].shape).toBe('rect')
    expect(store.updates).toBe(1)
    const follows = radios(magnifierPanel(), 'magnifier-follows')
    expect(follows.map((r) => textOf(r))).toEqual(['A place on the screen', 'The cursor'])
    ;(follows[1].props.onClick as () => void)()
    expect(store.state.spotlights![0].mode).toBe('cursor')
    expect(store.updates).toBe(2)
    // Back to a place: it stays where the cursor is (0.3, 0.6), in one update.
    ;(radios(magnifierPanel(), 'magnifier-follows')[0].props.onClick as () => void)()
    const s = store.state.spotlights![0]
    expect(s.mode).toBe('region')
    expect(s.x + s.w / 2).toBeCloseTo(0.3, 6)
    expect(s.y + s.h / 2).toBeCloseTo(0.6, 6)
    expect(store.updates).toBe(3)
    const none = { ...TRACK, valid: false }
    expect(radios(magnifierPanel(none), 'magnifier-follows')[1].props.disabled).toBe(true)
    expect(byId(magnifierPanel(none), 'magnifier-add-cursor')!.props.disabled).toBe(true)
  })

  it('shows the hint, and no magnifier panel for a plain spotlight', () => {
    expect(allText(magnifierPanel())).toContain('Blurred and pixelated areas stay hidden inside it.')
    store.state = { ...store.state, spotlights: [{ ...MAG, magnify: undefined }] }
    expect(byId(magnifierPanel(), 'magnifier-section')).toBeUndefined()
    expect(byId(magnifierPanel(), 'magnifier-add')).toBeTruthy()
  })

  it('the Zoom tab\'s Add magnifier runs the same command as the Shapes tab\'s', () => {
    ;(byId(magnifierPanel(), 'magnifier-add')!.props.onClick as () => void)()
    const row = render({ type: MagnifierZoomRow, props: {} })
    expect(textOf(byId(row, 'zoom-add-magnifier'))).toContain('Show a detail larger without zooming:')
    ;(row.find((e) => e.type === 'button')!.props.onClick as () => void)()
    ;(byId(magnifierPanel(), 'magnifier-add-cursor')!.props.onClick as () => void)()
    expect(commands).toEqual(['addMagnifier', 'addMagnifier', 'addMagnifierCursor'])
  })
})

describe('ChapterBarSection and ProgressBarLink (test 35)', () => {
  const bar = (): El[] => render({ type: ChapterBarSection, props: { project: store.state } })

  it('the switch turns the bar on in one update; its settings show then', () => {
    let els = bar()
    const toggle = byId(els, 'progress-bar-toggle')!
    expect(toggle.props).toMatchObject({ role: 'switch', 'aria-checked': false })
    expect(byId(els, 'progress-bar-place')).toBeUndefined()
    ;(toggle.props.onChange as (e: unknown) => void)({ target: { checked: true } })
    expect(store.updates).toBe(1)
    expect(store.state.chapterBar).toEqual(NEW_CHAPTER_BAR)
    els = bar()
    for (const id of ['progress-bar-place', 'progress-bar-look', 'progress-bar-colour']) expect(byId(els, id)!.props.role, id).toBe('radiogroup')
    expect(radios(els, 'progress-bar-place').map((r) => [textOf(r), r.props['aria-checked']])).toEqual([
      ['Auto', true],
      ['Top', false],
      ['Bottom', false]
    ])
    expect(radios(els, 'progress-bar-look').map((r) => textOf(r))).toEqual(['Floating', 'Edge'])
  })

  it('with fewer than two chapters: no names choice, a hint; with two: Current chapter, All chapters, None', () => {
    store.state = { ...store.state, chapterBar: { ...NEW_CHAPTER_BAR } }
    let els = bar()
    expect(byId(els, 'progress-bar-labels')).toBeUndefined()
    expect(allText(els)).toContain(FEW_CHAPTERS)
    store.state = { ...store.state, chapters: [{ id: 'a', t: 1, title: 'A' }, { id: 'b', t: 5, title: 'B' }] }
    els = bar()
    const names = radios(els, 'progress-bar-labels')
    expect(names.map((r) => textOf(r))).toEqual(['Current chapter', 'All chapters', 'None'])
    ;(names[1].props.onClick as () => void)()
    expect(store.state.chapterBar!.labels).toBe('all')
    expect(store.updates).toBe(1)
  })

  it('every setting is one update: place, look, colour, only at chapters', () => {
    store.state = { ...store.state, chapterBar: { ...NEW_CHAPTER_BAR }, brand: { colors: ['#0060df'] } }
    ;(radios(bar(), 'progress-bar-place')[2].props.onClick as () => void)()
    ;(radios(bar(), 'progress-bar-look')[1].props.onClick as () => void)()
    const colours = radios(bar(), 'progress-bar-colour')
    expect(colours.map((r) => [r.props['aria-label'], r.props['aria-checked']])).toEqual([
      ['Brand colour 1, #0060df', true],
      ['White', false]
    ])
    ;(colours[1].props.onClick as () => void)()
    ;(byId(bar(), 'progress-bar-only')!.props.onChange as (e: unknown) => void)({ target: { checked: true } })
    expect(store.updates).toBe(4)
    expect(store.state.chapterBar).toEqual({ show: true, place: 'bottom', style: 'edge', labels: 'current', color: '#ffffff', onlyAtChapters: true })
  })

  it('the Effects tab\'s Progress bar… opens the Text tab', () => {
    const link = render({ type: ProgressBarLink, props: {} })
    ;(byId(link, 'progress-bar-link')!.props.onClick as () => void)()
    expect(commands).toEqual(['showText'])
  })
})

describe('addMagnifierAt', () => {
  it('adds a magnifier fully grown at the playhead on the cursor, selects it, in one update', () => {
    store.state = project({ spotlights: [] })
    const sel: unknown[] = []
    const s = addMagnifierAt({ store, player }, 'region', TRACK, { onSelect: (x) => sel.push(x) })
    expect(store.updates).toBe(1)
    expect(sel).toEqual([{ kind: 'spotlight', id: s.id }])
    expect(store.state.spotlights).toEqual([s])
    expect(magnifierPhase(s, 4, store.state.clips, false)).toEqual({ r: 1, z: s.magnify, alpha: 1 })
    expect(s.x + s.w / 2).toBeCloseTo(0.3, 6)
    expect(s.y + s.h / 2).toBeCloseTo(0.6, 6)
    expect(player.time).toBe(4)
  })

  it('at the very start of the video it cannot start earlier: the playhead moves to where it is fully grown', () => {
    store.state = project({ spotlights: [] })
    player.time = 0
    const s = addMagnifierAt({ store, player }, 'region', TRACK, { onSelect: () => undefined })
    expect(s.start).toBe(0)
    expect(player.time).toBeGreaterThanOrEqual(0.3)
    expect(magnifierPhase(s, player.time, store.state.clips, false)!.r).toBe(1)
  })
})
