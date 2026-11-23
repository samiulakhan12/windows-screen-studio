import fs from 'node:fs'
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'
import { EditStore } from '../src/shared/editor/editStore'
import { createProject } from '../src/shared/engine/project'
import { DEFAULT_KEYMAP } from '../src/shared/editor/shortcuts'
import { PALETTE_COMMANDS, WAITING_P1 } from '../src/shared/editor/commands'
import { boxAt, pathKeys, writePath, type CoverKey } from '../src/shared/privacy/coverPath'
import { kindTitle, PRIVACY_COPY } from '../src/shared/privacy/copy'
import { COVER_COLOURS } from '../src/shared/privacy/kinds'
import { t } from '../src/shared/i18n/t'
import type { Cover, CursorTrack, Project, Shape } from '../src/shared/types'
import { allByTestId, byTestId, contexts, focused, mockReact, render, settle, textOf, unmountAll, useEditorContexts, type El } from './studioHarness'

/*
 * Covers in the editor's UI (docs/design/auto-blur.md §2.1-2.4, §2.8, §2.11, §2.15, §11; §17.1 tests
 * 41, 60-69, 71, 74 and 205-215): the Private info section, the Cover section, the note under blur,
 * the Cover tool, the Covers row, the handles, Peek's banner and magnified view, Cover this text
 * everywhere, Follow, and the commands. Rendered without a DOM (tests/studioHarness.ts); main and
 * the recording are fakes; nothing leaves the test.
 */

const api = {
  prefs: new Map<string, unknown>(),
  follow: null as null | ((req: Record<string, unknown>) => Promise<unknown>),
  under: null as null | ((req: Record<string, unknown>) => Promise<unknown>),
  everywhere: null as null | ((req: Record<string, unknown>) => Promise<unknown>),
  download: null as null | (() => Promise<unknown>),
  stopped: [] as string[],
  names: [] as string[][]
}
const windowListeners = new Map<string, ((e: unknown) => void)[]>()
vi.stubGlobal('window', {
  api: {
    getPref: async (k: string) => api.prefs.get(k) ?? null,
    setPref: async (k: string, v: unknown) => void api.prefs.set(k, v),
    followCover: (req: Record<string, unknown>) => api.follow!(req),
    underCover: (req: Record<string, unknown>) => api.under!(req),
    coverEverywhere: (req: Record<string, unknown>) => api.everywhere!(req),
    downloadReader: () => api.download!(),
    stopFind: async (id: string) => void api.stopped.push(id),
    setPrivateNames: async (names: string[]) => void api.names.push(names)
  },
  addEventListener: (type: string, fn: (e: unknown) => void) => windowListeners.set(type, [...(windowListeners.get(type) ?? []), fn]),
  removeEventListener: (type: string, fn: (e: unknown) => void) => windowListeners.set(type, (windowListeners.get(type) ?? []).filter((f) => f !== fn)),
  dispatchEvent: () => true
})
vi.stubGlobal('document', { addEventListener: () => undefined, removeEventListener: () => undefined, activeElement: null, body: {}, createElement: () => ({ getContext: () => null }) })
vi.stubGlobal('Path2D', class {})
for (const name of ['HTMLElement', 'Node', 'HTMLInputElement', 'HTMLButtonElement', 'HTMLCanvasElement']) vi.stubGlobal(name, class {})
mockReact()
vi.doMock('../src/renderer/src/editor/modalFocus', () => ({ useModalFocus: () => undefined }))
// The colour a new cover takes is read from the recording: answered here.
vi.doMock('../src/renderer/src/privacy/coverPick', () => ({ ringColourAt: async () => '#123456', coverColourNow: async () => '#654321' }))
// The reader's state is part P5's; the tests set it.
const reader = { state: null as unknown }
vi.doMock('../src/renderer/src/privacy/readerState', () => ({
  useReaderState: () => reader.state,
  useFindProgress: () => null,
  FindProgressLine: () => null,
  confirmLeaveFind: async () => true
}))
// Pointer drags: the move and the release handlers, run by the test.
const drag = { move: null as null | ((ev: unknown) => void), up: null as null | (() => void) }
vi.doMock('../src/renderer/src/editor/pointer', () => ({
  followPointer: (_e: unknown, move: (ev: unknown) => void, up?: () => void) => {
    drag.move = move
    drag.up = up ?? null
    return () => undefined
  }
}))

// Renderer code: imported at run time so the Node typecheck of tests/ does not follow it.
type Comp = (p: Record<string, unknown>) => unknown
const load = async <T>(file: string): Promise<T> => (await import(/* @vite-ignore */ `../src/renderer/src/${file}`)) as T
const { PrivacySection } = await load<{ PrivacySection: Comp }>('privacy/PrivacySection')
const { CoverSection } = await load<{ CoverSection: Comp }>('privacy/CoverSection')
const { WeakBlurNote } = await load<{ WeakBlurNote: Comp }>('privacy/WeakBlurNote')
const { CoverShapeButton } = await load<{ CoverShapeButton: Comp }>('privacy/CoverShapeButton')
const track = await load<{ CoverTrack: Comp; coverBars(c: Cover[]): { ids: string[] }[] }>('privacy/CoverTrack')
const { CoverHandles } = await load<{ CoverHandles: Comp }>('privacy/CoverHandles')
const { PeekBanner } = await load<{ PeekBanner: Comp }>('privacy/PeekBanner')
const inset = await load<{ PeekInset: Comp; insetGeometry(b: unknown, f: unknown, s: number): { sx: number; sy: number; sw: number; sh: number; scale: number } }>('privacy/PeekInset')
const { EverywhereDialog } = await load<{ EverywhereDialog: Comp }>('privacy/EverywhereDialog')
const follow = await load<{ runFollow(s: unknown, id: string, signal: AbortSignal): Promise<string>; runEverywhere(s: unknown, id: string, r: string, signal: AbortSignal): Promise<unknown>; readUnderCover(s: unknown, id: string): Promise<unknown>; onNamesChanged(l: (w: string) => void): () => void }>('privacy/followRun')
const commands = await load<{ coverCommands(d: unknown): Record<string, () => void>; addCoverNow(d: unknown, l?: string): Promise<string>; setCoverLength(l: string): void; setWholePath(on: boolean): void }>('privacy/coverCommands')
type PeekModule = {
  peekCovers(ids: readonly string[] | 'all' | null): void
  peekWhileReviewing(on: boolean): void
  listenBleep(id: string | null): void
  showCoverMarks(on: boolean): void
  clearPeek(): void
  peekNow(): { ids: readonly string[] | 'all' | null; review: boolean; listen: string | null; marks: boolean }
  peekedScene<S>(scene: S): S
}
const peek = await load<PeekModule>('privacy/peek')
const layer = await load<{ drawCoverOutput(c: unknown, scene: unknown, t: number, views: unknown[]): void; forOutput<S>(s: S): S }>('render/coverLayer')
const multi = await load<{ useMultiSelect(d: unknown): { press(e: unknown, key: string, mode: string): boolean } }>('editor/multiSelectControl')
await useEditorContexts()

const W = 1920
const H = 1080
const key = (t: number, x: number, y: number, w: number, h: number): CoverKey => ({ t, x, y, w, h })
const cover = (id: string, start: number, end: number, keys: CoverKey[], over: Partial<Cover> = {}): Cover => ({ id, start, end, path: writePath(keys), color: '#203040', ...over })
const blur = (id: string, start: number, end: number): Shape => ({ id, kind: 'blur', start, end, x: 0.1, y: 0.1, w: 0.2, h: 0.1, color: '#000000', strokeWidth: 4, fill: true, opacity: 1, strength: 0.6 })
function project(over: Partial<Project> = {}): Project {
  const p = createProject({ id: 'p', name: 'p', duration: 30, width: W, height: H, hasWebcam: false, hasAudio: true, webcamOffset: 0, zooms: [], cursorValid: true, capture: { method: 'native', cursorInVideo: false, region: null, fps: 60 } })
  return { ...p, ...over }
}
const NO_CURSOR: CursorTrack = { samples: [], clicks: [], valid: false } as unknown as CursorTrack

let store: EditStore<Project>
const player = {
  time: 2,
  moving: false,
  seeks: [] as number[],
  subscribe: () => () => undefined,
  seek(t: number) {
    this.seeks.push(t)
    this.time = t
  },
  screen: { readyState: 4, seeking: false, currentTime: 2, videoWidth: W, videoHeight: H },
  pausedFrame: (): unknown => null
}
const events = { selects: [] as { keys: string[]; anchor: string | null }[], notices: [] as string[], commands: [] as string[], single: [] as unknown[] }
function groupApi(keys: string[] = [], single: string | null = null): Record<string, unknown> {
  return {
    group: { keys, anchor: keys.at(-1) ?? null, stamp: 0 },
    keys: new Set(keys),
    single,
    select: (k: string[], anchor: string | null) => void events.selects.push({ keys: k, anchor }),
    notice: (m: string) => void events.notices.push(m),
    command: (id: string) => void events.commands.push(id)
  }
}
const services = (): { store: EditStore<Project>; player: typeof player } => ({ store, player })
function setUp(p: Project, keys: string[] = [], single: string | null = null): void {
  store = new EditStore<Project>(p)
  player.time = 2
  player.moving = false
  player.seeks = []
  player.screen.currentTime = 2
  contexts.editor = services()
  contexts.group = groupApi(keys, single)
  contexts.keymap = DEFAULT_KEYMAP
}
/** How many undo steps the store holds now. */
function steps(): number {
  let n = 0
  const s = store as unknown as { history: { past: unknown[] } }
  n = s.history.past.length
  return n
}
const click = (el: El | undefined, e: Record<string, unknown> = {}): void => (el!.props.onClick as (e: unknown) => void)({ preventDefault() {}, stopPropagation() {}, ...e })
const keyEvent = (k: string, mods: Record<string, boolean> = {}): Record<string, unknown> => ({ key: k, shiftKey: false, ctrlKey: false, metaKey: false, altKey: false, ...mods, prevented: false, preventDefault() {}, stopPropagation() {} })
/** Types `n` into a NumberField's input (English: a number input, its valueAsNumber). */
const setNumber = (el: El, n: number): void => (el.props.onChange as (e: unknown) => void)({ currentTarget: { valueAsNumber: n } })
const flush = async (): Promise<void> => {
  for (let i = 0; i < 10; i++) await Promise.resolve()
}

beforeEach(() => {
  events.selects = []
  events.notices = []
  events.commands = []
  api.prefs.clear()
  api.stopped = []
  api.names = []
  reader.state = null
  peek.clearPeek()
  peek.showCoverMarks(true)
  commands.setCoverLength('three')
  commands.setWholePath(false)
  unmountAll()
})
afterEach(() => {
  peek.clearPeek()
})

describe('auto-blur P1: adding covers', () => {
  it('41. addCover: 3 s at the playhead, 30% × 10% centred on the cursor and clipped; To the end; For the whole video; centred on the frame when the cursor is invalid; one undo step; the new cover is selected', async () => {
    setUp(project())
    player.time = 10
    // The cursor near the bottom right: the box is clipped to the frame.
    const cursor = { samples: [{ t: 0, x: 0.9, y: 0.97 }, { t: 30, x: 0.9, y: 0.97 }], clicks: [], valid: true } as unknown as CursorTrack
    const selected: unknown[] = []
    let revealed = 0
    const deps = { services: services(), cursor, scene: () => ({}), selection: () => null, select: (s: unknown) => void selected.push(s), reveal: () => void revealed++, notice: () => undefined }
    const id = await commands.addCoverNow(deps, 'three')
    expect(steps()).toBe(1)
    const c = store.state.covers!.find((x) => x.id === id)!
    expect([c.start, c.end, c.color]).toEqual([10, 13, '#654321'])
    const b = boxAt(c, 11)!
    expect(b.w).toBeCloseTo(0.3, 3)
    expect(b.h).toBeCloseTo(0.1, 3)
    expect(b.x + b.w).toBeCloseTo(1, 3)
    expect(b.y + b.h).toBeCloseTo(1, 3)
    expect(selected).toEqual([{ kind: 'cover', id }])
    expect(revealed).toBe(1)
    // To the end, and for the whole video.
    const toEnd = store.state.covers!.find((x) => x.id === undefined) ?? null
    void toEnd
    const id2 = await commands.addCoverNow(deps, 'toEnd')
    expect([store.state.covers!.find((x) => x.id === id2)!.start, store.state.covers!.find((x) => x.id === id2)!.end]).toEqual([10, 30])
    const id3 = await commands.addCoverNow(deps, 'whole')
    expect([store.state.covers!.find((x) => x.id === id3)!.start, store.state.covers!.find((x) => x.id === id3)!.end]).toEqual([0, 30])
    expect(steps()).toBe(3)
    // The cursor invalid: centred on the frame.
    const id4 = await commands.addCoverNow({ ...deps, cursor: NO_CURSOR }, 'three')
    const centred = boxAt(store.state.covers!.find((x) => x.id === id4)!, 11)!
    expect(centred.x).toBeCloseTo(0.35, 3)
    expect(centred.y).toBeCloseTo(0.45, 3)
    // The command uses the length chosen last in the menu (the session's).
    commands.setCoverLength('toEnd')
    commands.coverCommands(deps).addCover()
    await flush()
    expect(store.state.covers!.at(-1)!.end).toBe(30)
  })

  it('205. The Cover button sits after Pixelate in the add-shape row with its tooltip and does what Add cover does', async () => {
    setUp(project())
    const els = render({ type: CoverShapeButton, props: { services: services() } })
    const b = byTestId(els, 'cover-tool')!
    expect(textOf(b)).toBe('Cover')
    expect(b.props.title).toBe('Cover private content with a solid box')
    expect(b.props.className).toContain('shape-tool')
    click(b)
    expect(events.commands).toEqual(['addCover'])
    // After Pixelate: the add-shape row lists the kinds, then this button.
    const { shapeKinds } = await import('../src/shared/editor/itemNames')
    expect(shapeKinds().at(-1)!.kind).toBe('pixelate')
    const panel = fs.readFileSync('src/renderer/src/editor/panels/ShapesPanel.tsx', 'utf8')
    const row = panel.slice(panel.indexOf('{shapeKinds().map('), panel.indexOf("{t('text.shapesPanel.shapesStayOnThe')}"))
    expect(row).toMatch(/\)\)\}\s*<CoverShapeButton services=\{services\} \/>\s*<\/div>/)
  })

  it('Turn them all into covers in the Private info section turns every blur and pixelate shape into a cover in one undo step (test 206 holds the edit itself)', async () => {
    setUp(project({ shapes: [blur('b1', 1, 3), blur('b2', 2, 4)] }))
    let els = render({ type: PrivacySection, props: { services: services(), onFind: () => undefined } })
    expect(textOf(byTestId(els, 'privacy-weak'))).toContain('2 blurred or pixelated areas can sometimes be read back.')
    click(byTestId(els, 'privacy-weak-turn'))
    await flush()
    els = render({ type: PrivacySection, props: { services: services(), onFind: () => undefined } })
    expect(store.state.shapes).toEqual([])
    expect(store.state.covers!.map((c) => c.color)).toEqual(['#123456', '#123456'])
    expect(steps()).toBe(1)
    expect(byTestId(els, 'privacy-weak')).toBeUndefined()
  })
})

describe('auto-blur P1: the Private info section', () => {
  it('63. PrivacySection: its buttons, the remembered length, the private-item count and the to-check line, Show where covers are, the weak line and Turn them all into covers, the reader line, and the disclosure listing every privacy.notSee message, folder included', async () => {
    setUp(
      project({
        covers: [
          cover('a', 1, 3, [key(1, 0.1, 0.1, 0.2, 0.05)], { found: 'check', kind: 'email', group: 'g1' }),
          cover('b', 2, 4, [key(2, 0.1, 0.3, 0.2, 0.05)], { found: 'check', kind: 'email', group: 'g1' }),
          cover('m', 5, 6, [key(5, 0.5, 0.5, 0.2, 0.05)])
        ],
        shapes: [blur('b1', 1, 3)]
      })
    )
    let found = 0
    const root = { type: PrivacySection, props: { services: services(), onFind: () => void found++ } }
    let els = await settle(root)
    expect(textOf(els.find((e) => e.type === 'h3'))).toBe('Private info')
    // Add cover runs the command; its menu offers the three lengths and remembers the choice.
    click(byTestId(els, 'privacy-add-cover'))
    expect(events.commands).toEqual(['addCover'])
    const more = byTestId(els, 'privacy-add-cover-menu')!
    expect(more.props['aria-haspopup']).toBe('menu')
    expect(more.props['aria-label']).toBe('Choose how long the cover lasts')
    click(more)
    els = render(root)
    expect(allByTestId(els, 'privacy-length-three').concat(allByTestId(els, 'privacy-length-toEnd'), allByTestId(els, 'privacy-length-whole')).map(textOf)).toEqual(['For 3 seconds', 'To the end of the video', 'For the whole video'])
    expect(byTestId(els, 'privacy-length-three')!.props['aria-checked']).toBe(true)
    click(byTestId(els, 'privacy-length-whole'))
    els = render(root)
    expect(events.commands).toEqual(['addCover', 'addCover'])
    click(more)
    els = render(root)
    expect(byTestId(els, 'privacy-length-whole')!.props['aria-checked']).toBe(true)
    // Find private info….
    click(byTestId(els, 'privacy-find'))
    expect(found).toBe(1)
    expect(textOf(byTestId(els, 'privacy-find'))).toBe('Find private info…')
    // The count of private items (a group is one item) and of those to check, with Review.
    expect(textOf(byTestId(els, 'privacy-count'))).toBe('2 private items. 1 to check. Review')
    click(byTestId(els, 'privacy-review'))
    expect(events.commands.at(-1)).toBe('review')
    // Show where covers are: on by default; turning it off is remembered.
    const marks = els.find((e) => e.type === 'input' && e.props['aria-label'] === 'Show where covers are')!
    expect(marks.props.checked).toBe(true)
    expect(marks.props['aria-describedby']).toBeTruthy()
    expect(textOf(els.find((e) => e.props.id === marks.props['aria-describedby']))).toBe('Draws a dashed outline around each cover in the editor only. Exports never show it.')
    // The weak line and its button.
    expect(textOf(byTestId(els, 'privacy-weak'))).toBe('1 blurred or pixelated area can sometimes be read back. Turn them all into covers')
    // No reader line until the reader's state is known; then the download line when it is missing.
    expect(byTestId(els, 'privacy-reader-missing')).toBeUndefined()
    reader.state = { status: 'none' }
    els = render(root)
    expect(textOf(byTestId(els, 'privacy-reader-missing'))).toBe('Find needs the text reader, a 27.6 MB download from Hugging Face.')
    reader.state = { status: 'ready', bytes: 1, decodeMs: null }
    els = render(root)
    expect(byTestId(els, 'privacy-reader-missing')).toBeUndefined()
    // What Find does not see: a disclosure with aria-expanded, every message of §2.9.
    const head = byTestId(els, 'privacy-not-see')!
    expect(head.props['aria-expanded']).toBe(false)
    expect(byTestId(els, 'privacy-not-see-list')).toBeUndefined()
    click(head)
    els = render(root)
    expect(byTestId(els, 'privacy-not-see')!.props['aria-expanded']).toBe(true)
    const list = byTestId(els, 'privacy-not-see-list')!
    expect(byTestId(els, 'privacy-not-see')!.props['aria-controls']).toBe(list.props.id)
    const items = (list.props.children as El[]).map((li) => textOf(li))
    expect(items).toEqual(Object.values(PRIVACY_COPY.notSee).map((k) => t(k)))
    expect(items).toContain('The project folder on this PC keeps the original recording, without covers.')
    // Without covers or blur: no count and no weak line, the rest as before.
    setUp(project())
    els = await settle({ type: PrivacySection, props: { services: services(), onFind: () => undefined } })
    expect(byTestId(els, 'privacy-count')).toBeUndefined()
    expect(byTestId(els, 'privacy-weak')).toBeUndefined()
  })

  it('207. Show where covers are draws dashed outlines on the preview scene only, is on by default, and when turned off is remembered in the preferences (showCovers: false)', async () => {
    setUp(project({ covers: [cover('a', 1, 5, [key(1, 0.1, 0.1, 0.2, 0.1)])] }))
    const root = { type: PrivacySection, props: { services: services(), onFind: () => undefined } }
    let els = await settle(root)
    expect(peek.peekNow().marks).toBe(true)
    const scene = { project: store.state, cursor: NO_CURSOR }
    const preview = peek.peekedScene(scene as never) as Record<string, unknown>
    expect(preview.coverMarks).toBe(true)
    // Drawn on the preview's scene: a 1 px dashed accent outline with a black halo; never on an output's (forOutput strips it).
    const strokes: { style: unknown; dash: unknown; width: unknown }[] = []
    let dash: unknown = []
    const ctx = new Proxy({} as Record<string | symbol, unknown>, {
      get: (target, prop) => (prop in target ? target[prop] : prop === 'setLineDash' ? (d: unknown) => void (dash = d) : prop === 'strokeRect' ? () => void strokes.push({ style: target.strokeStyle, dash, width: target.lineWidth }) : () => undefined),
      set: (target, prop, v) => ((target[prop] = v), true)
    })
    const view = { toOut: (x: number, y: number) => ({ x: x * 1000, y: y * 500 }) }
    layer.drawCoverOutput(ctx, preview, 2, [view])
    expect(strokes).toEqual([
      { style: '#000000', dash: [], width: 1 },
      { style: '#6b5dfd', dash: [4, 3], width: 1 }
    ])
    strokes.length = 0
    layer.drawCoverOutput(ctx, layer.forOutput(preview), 2, [view])
    expect(strokes).toEqual([])
    // The checkbox turns it off, and the preference remembers it; on again removes the key.
    const box = els.find((e) => e.type === 'input' && e.props['aria-label'] === 'Show where covers are')!
    ;(box.props.onChange as (e: unknown) => void)({ target: { checked: false } })
    await flush()
    expect(peek.peekNow().marks).toBe(false)
    expect(api.prefs.get('privacy')).toEqual({ showCovers: false })
    expect((peek.peekedScene(scene as never) as Record<string, unknown>).coverMarks).toBeUndefined()
    // Read back when the section is shown again.
    unmountAll()
    peek.showCoverMarks(true)
    els = await settle(root)
    expect(peek.peekNow().marks).toBe(false)
    const again = els.find((e) => e.type === 'input' && e.props['aria-label'] === 'Show where covers are')!
    ;(again.props.onChange as (e: unknown) => void)({ target: { checked: true } })
    await flush()
    expect(api.prefs.get('privacy')).toEqual({})
  })
})

describe('auto-blur P1: the Cover section', () => {
  const suggestion = (): Cover => cover('c', 1, 9, [key(1, 0.25, 0.5, 0.2, 0.05), key(5, 0.3, 0.4, 0.2, 0.05)], { found: 'check', kind: 'email', group: 'g', lost: true, missed: true, thin: true })
  const section = (ids: string[] = ['c']): { type: Comp; props: Record<string, unknown> } => ({ type: CoverSection, props: { services: services(), coverIds: ids, shapeIds: [] } })

  it('64. CoverSection: the box fields in percent; the colour chips; Change the whole path; Start here and End here; Follow, Everywhere, Keep it for the whole video, Keep covered and Uncover; the lines for found, what it hides, check, lost, missed and thin', async () => {
    setUp(project({ covers: [suggestion()] }))
    player.time = 2
    let els = render(section())
    expect(textOf(els.find((e) => e.type === 'h3'))).toBe('Cover')
    // A suggestion's lines.
    expect(textOf(byTestId(els, 'cover-lines'))).toBe(
      [t(PRIVACY_COPY.cover.found), `${t(PRIVACY_COPY.cover.what)} ${t(kindTitle('email'))}`, t(PRIVACY_COPY.cover.toCheck), t(PRIVACY_COPY.cover.lost), t(PRIVACY_COPY.cover.missed), t(PRIVACY_COPY.cover.thin)].join('')
    )
    // The box at the playhead, in percent of the whole frame with one decimal.
    const field = (f: string): El => els.find((e) => e.props['data-field'] === f)!
    expect(['left', 'top', 'width', 'height'].map((f) => field(f).props.value)).toEqual([25, 50, 20, 5])
    expect(['left', 'top', 'width', 'height'].map((f) => field(f).props['aria-label'])).toEqual(['Left', 'Top', 'Width', 'Height'])
    // Width widens the right edge at every key; Left moves the span at the playhead only (the whole path off).
    setNumber(field('width'), 25)
    setNumber(field('left'), 20)
    const c1 = store.state.covers![0]
    expect(pathKeys(c1).map((k) => [+k.x.toFixed(4), +k.w.toFixed(4)])).toEqual([
      [0.2, 0.25],
      [0.3, 0.25]
    ])
    expect(c1.found).toBeUndefined()
    // The colour chips: Match the background, then Dark, Light, Black, White.
    els = render(section())
    const chips = byTestId(els, 'cover-colours')!
    expect(chips.props['aria-label']).toBe('Colour')
    expect((chips.props.children as El[]).map((b) => textOf(b))).toEqual(['Match the background', 'Dark', 'Light', 'Black', 'White'])
    click((chips.props.children as El[])[4])
    expect(store.state.covers![0].color).toBe(COVER_COLOURS.white)
    click((chips.props.children as El[])[0])
    await flush()
    expect(store.state.covers![0].color).toBe('#123456')
    // Change the whole path: a move then applies at every key.
    els = render(section())
    const whole = byTestId(els, 'cover-whole-path')!
    expect(whole.props.checked).toBe(false)
    ;(whole.props.onChange as (e: unknown) => void)({ target: { checked: true } })
    els = render(section())
    setNumber(els.find((e) => e.props['data-field'] === 'top')!, 60)
    expect(pathKeys(store.state.covers![0]).map((k) => +k.y.toFixed(4))).toEqual([0.6, 0.5])
    // Start here and End here, from the playhead inside the cover.
    player.time = 3
    els = render(section())
    expect(byTestId(els, 'cover-start-here')!.props.disabled).toBe(false)
    click(byTestId(els, 'cover-start-here'))
    expect(store.state.covers![0].start).toBe(3)
    player.time = 7
    els = render(section())
    click(byTestId(els, 'cover-end-here'))
    expect(store.state.covers![0].end).toBe(7)
    // Keep it for the whole video.
    els = render(section())
    click(byTestId(els, 'cover-whole'))
    expect([store.state.covers![0].start, store.state.covers![0].end]).toEqual([0, 30])
    // Follow, Everywhere: there, enabled, with Follow's hint as its description.
    const followButton = byTestId(els, 'cover-follow')!
    expect(followButton.props.disabled).toBe(false)
    expect(textOf(els.find((e) => e.props.id === followButton.props['aria-describedby']))).toBe(t(PRIVACY_COPY.cover.followHint))
    expect(textOf(byTestId(els, 'cover-everywhere'))).toBe('Cover this text everywhere…')
    // Keep covered shows only on a suggestion; Uncover always.
    expect(byTestId(els, 'cover-keep')).toBeUndefined()
    expect(textOf(byTestId(els, 'cover-uncover'))).toBe('Uncover')
    setUp(project({ covers: [suggestion()] }))
    els = render(section())
    expect(textOf(byTestId(els, 'cover-keep'))).toBe('Keep covered')
    click(byTestId(els, 'cover-keep'))
    expect(store.state.covers![0].found).toBeUndefined()
    // Each action was one undo step.
    expect(steps()).toBe(1)
  })

  it('Start here and End here are disabled with privacy.cover.outside as their description when the playhead is outside the cover', () => {
    setUp(project({ covers: [suggestion()] }))
    player.time = 20
    const els = render(section())
    for (const id of ['cover-start-here', 'cover-end-here']) {
      const b = byTestId(els, id)!
      expect(b.props.disabled).toBe(true)
      expect(textOf(els.find((e) => e.props.id === b.props['aria-describedby']))).toBe('The playhead is outside this cover.')
    }
  })

  it('209. Several covers selected: the title reads privacy.cover.selected; colour, Keep covered, Uncover, nudge and Paste look act on all in one step; the box fields, Follow and Everywhere are disabled with their reasons as descriptions', async () => {
    const covers = [suggestion(), cover('d', 2, 4, [key(2, 0.6, 0.6, 0.1, 0.1)], { found: 'auto', kind: 'key', group: 'g2' }), cover('e', 3, 5, [key(3, 0.7, 0.1, 0.1, 0.1)])]
    setUp(project({ covers, shapes: [blur('b1', 1, 3)] }), ['cover:c', 'cover:d', 'cover:e', 'shape:b1'])
    let els = render(section([]))
    expect(textOf(els.find((e) => e.type === 'h3'))).toBe('3 covers selected')
    // Disabled, each with its reason as its description (never a tooltip alone).
    const reason = (el: El): string => textOf(els.find((e) => e.props.id === el.props['aria-describedby']))
    const box = byTestId(els, 'cover-box')!
    expect(box.props.disabled).toBe(true)
    expect(reason(box)).toBe('Select one cover to change its box.')
    expect(byTestId(els, 'cover-follow')!.props.disabled).toBe(true)
    expect(reason(byTestId(els, 'cover-follow')!)).toBe('Select one cover to follow what is under it.')
    expect(byTestId(els, 'cover-everywhere')!.props.disabled).toBe(true)
    expect(reason(byTestId(els, 'cover-everywhere')!)).toBe('Select one cover to cover its text everywhere.')
    // Keep covered on all, one step.
    click(byTestId(els, 'cover-keep'))
    expect(store.state.covers!.map((c) => c.found)).toEqual([undefined, undefined, undefined])
    expect(steps()).toBe(1)
    // Colour on all, one step.
    els = render(section([]))
    expect(byTestId(els, 'cover-keep')).toBeUndefined()
    click((byTestId(els, 'cover-colours')!.props.children as El[])[3])
    expect(store.state.covers!.map((c) => c.color)).toEqual(['#000000', '#000000', '#000000'])
    expect(steps()).toBe(2)
    // Nudge (the preview's arrow keys) and Paste look on all, one step each.
    const { nudgeCovers } = await import('../src/shared/editor/coverEdit')
    store.update((p) => nudgeCovers(p, ['c', 'd', 'e'], 19.2, 0))
    expect(store.state.covers!.map((c) => +pathKeys(c)[0].x.toFixed(4))).toEqual([0.26, 0.61, 0.71])
    const { pasteLook } = await import('../src/shared/editor/groupEdit')
    store.update((p) => pasteLook(p, ['cover:c', 'cover:d', 'cover:e'], { cls: 'cover', values: { 'cover.color': '#ffffff' }, label: 'Cover' }, { crop: null, cursorValid: true, style: {} as never, background: {} as never }).project)
    expect(store.state.covers!.map((c) => c.color)).toEqual(['#ffffff', '#ffffff', '#ffffff'])
    expect(steps()).toBe(4)
    // The selected blur shape: Turn into covers, one step.
    els = render(section([]))
    expect(textOf(byTestId(els, 'cover-turn-selected'))).toBe('Turn 1 into a cover')
    click(byTestId(els, 'cover-turn-selected'))
    await flush()
    expect(store.state.shapes).toEqual([])
    expect(store.state.covers).toHaveLength(4)
    expect(steps()).toBe(5)
    // Uncover all, one step.
    els = render(section([]))
    click(byTestId(els, 'cover-uncover'))
    expect(store.state.covers?.filter((c) => ['c', 'd', 'e'].includes(c.id)) ?? []).toEqual([])
    expect(steps()).toBe(6)
  })

  it('213. Keep covered in the Cover section moves focus to the section\'s title (finding 37)', () => {
    setUp(project({ covers: [suggestion()] }))
    let els = render(section())
    focused.length = 0
    click(byTestId(els, 'cover-keep'))
    els = render(section())
    const title = els.find((e) => e.type === 'h3')!
    expect(title.props.tabIndex).toBe(-1)
    expect(focused.at(-1)).toBe(title)
  })

  it('215. Uncover says privacy.cover.uncovered in the status line, deletes the cover and writes its path to privacy.rejected in the same undo step', () => {
    setUp(project({ covers: [suggestion()] }))
    const els = render(section())
    click(byTestId(els, 'cover-uncover'))
    expect(events.notices).toEqual(['Uncovered. It will show in exports.'])
    expect(store.state.covers).toBeUndefined()
    expect(store.state.privacy!.rejected).toEqual([{ kind: 'email', start: 1, end: 9, path: suggestion().path }])
    expect(steps()).toBe(1)
    store.undo()
    expect(store.state.covers).toHaveLength(1)
    expect(store.state.privacy).toBeUndefined()
  })

  it('65. WeakBlurNote: the note and Turn into a cover; text.calloutSection.privacyNote unchanged', async () => {
    setUp(project({ shapes: [blur('b1', 1, 5)] }))
    const els = render({ type: WeakBlurNote, props: { services: services(), shapeId: 'b1' } })
    const note = byTestId(els, 'cover-weak-note')!
    expect(textOf(note)).toBe('Even fully on, blurred or pixelated text can sometimes be read back. A cover hides it completely.Turn into a cover')
    const turn = byTestId(els, 'cover-weak-turn')!
    expect(textOf(els.find((e) => e.props.id === turn.props['aria-describedby']))).toContain('can sometimes be read back')
    click(turn)
    await flush()
    expect(store.state.shapes).toEqual([])
    const c = store.state.covers![0]
    expect([c.start, c.end, c.color]).toEqual([1, 5, '#654321'])
    expect(steps()).toBe(1)
    expect(events.selects.at(-1)).toEqual({ keys: [`cover:${c.id}`], anchor: `cover:${c.id}` })
    // Not under any other shape.
    setUp(project({ shapes: [{ ...blur('r', 1, 5), kind: 'rect' }] }))
    expect(render({ type: WeakBlurNote, props: { services: services(), shapeId: 'r' } })).toEqual([])
    // The texts that say blur hides everything are unchanged (question 17 is the owner's).
    expect(t('text.calloutSection.privacyNote')).toBe('Blur and pixelate are fully on for their whole time, so nothing they hide shows.')
    expect(t('text.shape.blur.title')).toBe('Blur private content (always fully applied)')
  })
})

describe('auto-blur P1: Follow and Cover this text everywhere', () => {
  const email = (): Cover => cover('c', 1, 30, [key(1, 0.3, 0.6, 0.25, 0.04)])
  const followed = { ok: true, projectId: 'p', requestId: '', path: writePath([key(1, 0.3, 0.6, 0.25, 0.04), key(10, 0.3, 0.3, 0.25, 0.04)]), start: 1, end: 30, walked: { start: 1, end: 30 }, lostSpans: '', thin: false }

  it('61. runFollow lands through afterGestures while a drag is open, and both the drag\'s and the follow\'s results are kept (finding 16); Stop changes nothing and keeps focus on Follow; when it ends, focus moves to the cover\'s status line (finding 37)', async () => {
    setUp(project({ covers: [email(), cover('o', 2, 4, [key(2, 0.1, 0.1, 0.1, 0.1)])] }))
    let answer: (v: unknown) => void = () => undefined
    let asked: Record<string, unknown> | null = null
    api.follow = (req) => {
      asked = req
      return new Promise((r) => (answer = (v) => r({ ...(v as object), requestId: req.requestId })))
    }
    const running = follow.runFollow(services(), 'c', new AbortController().signal)
    await flush()
    // Asked for the box at the playhead, with the cover's path and times.
    expect(asked).toMatchObject({ projectId: 'p', t: 2, box: boxAt(email(), 2), start: 1, end: 30, path: email().path })
    // A drag of the other cover is open when the result lands.
    store.beginGesture()
    store.update((p) => ({ ...p, covers: p.covers!.map((c) => (c.id === 'o' ? { ...c, start: 3, end: 5 } : c)) }), 'drag-o')
    answer(followed)
    await flush()
    // Not applied yet: it waits for the drag to end, then lands on what the drag left.
    expect(pathKeys(store.state.covers![0])).toHaveLength(1)
    store.update((p) => ({ ...p, covers: p.covers!.map((c) => (c.id === 'o' ? { ...c, start: 3.5, end: 5.5 } : c)) }), 'drag-o')
    store.endGesture()
    expect(await running).toBe('done')
    const c = store.state.covers!.find((x) => x.id === 'c')!
    expect(boxAt(c, 12)!.y).toBeCloseTo(0.3, 4)
    expect(store.state.covers!.find((x) => x.id === 'o')!.start).toBe(3.5)
    // In the section: Stop changes nothing and keeps the focus on Follow.
    setUp(project({ covers: [email()] }))
    const root = { type: CoverSection, props: { services: services(), coverIds: ['c'], shapeIds: [] } }
    api.follow = (req) => new Promise((r) => (answer = (v) => r({ ...(v as object), requestId: req.requestId })))
    let els = render(root)
    click(byTestId(els, 'cover-follow'))
    els = render(root)
    expect(textOf(els.find((e) => e.props.className === 'cover-following'))).toContain('Following…')
    focused.length = 0
    click(byTestId(els, 'cover-follow-stop'))
    expect(api.stopped).toEqual(['p'])
    answer({ ok: false, projectId: 'p', reason: 'stopped' })
    await flush()
    els = render(root)
    expect(store.state.covers![0]).toEqual(email())
    expect(focused.at(-1)?.props['data-testid']).toBe('cover-follow')
    // Followed to the end: the status line says so and takes the focus.
    click(byTestId(els, 'cover-follow'))
    els = render(root)
    answer({ ...followed })
    await flush()
    els = render(root)
    const status = byTestId(els, 'cover-status')!
    expect(textOf(status)).toBe('The cover now follows the text from 0:01.0 to 0:30.0.')
    expect(focused.at(-1)).toBe(status)
    // Nothing under it: said so.
    click(byTestId(els, 'cover-follow'))
    els = render(root)
    answer({ ok: false, projectId: 'p', reason: 'none' })
    await flush()
    els = render(root)
    expect(textOf(byTestId(els, 'cover-status'))).toBe('Flown found no text under this cover to follow.')
  })

  it('62. runEverywhere adds text covers in one step; with remember project and a name-like text it adds the returned name to privacy.names in the same step, with settings to Settings\' names, and the open dialogs show the new list (finding 28); with a text that is not name-like nothing is added', async () => {
    const found = [
      { kind: 'text', score: 1, group: 'x', start: 1, end: 30, path: email().path, color: '#203040' },
      { kind: 'text', score: 1, group: 'x', start: 12, end: 14, path: writePath([key(12, 0.5, 0.2, 0.25, 0.04)]), color: '#203040' },
      { kind: 'text', score: 1, group: 'y', start: 20, end: 22, path: writePath([key(20, 0.1, 0.8, 0.25, 0.04)]), color: '#ffffff' }
    ]
    let remembered: string | undefined
    api.under = async () => ({ ok: true, nameLike: true })
    api.everywhere = async (req) => ({ ok: true, projectId: 'p', requestId: req.requestId, found, failedReads: 0, thinSpans: '', stopped: false, readTo: null, reader: 'r', ...(remembered ? { addedName: remembered } : {}) })
    const heard: string[] = []
    const off = follow.onNamesChanged((w) => void heard.push(w))
    for (const remember of ['project', 'settings', 'no'] as const) {
      setUp(project({ covers: [email()], privacy: { names: ['Jane'] } }))
      api.prefs.set('privacy', { names: ['Kim'] })
      remembered = remember === 'no' ? undefined : 'Ada Lovelace'
      await follow.readUnderCover(services(), 'c')
      const r = await follow.runEverywhere(services(), 'c', remember, new AbortController().signal)
      // The place under the cover itself is not added again; the other two are, as text covers in one new group.
      expect(r).toEqual({ added: 2, name: remember === 'no' ? null : 'Ada Lovelace' })
      const added = store.state.covers!.filter((c) => c.id !== 'c')
      expect(added.map((c) => [c.kind, c.start])).toEqual([
        ['text', 12],
        ['text', 20]
      ])
      expect(new Set(added.map((c) => c.group)).size).toBe(1)
      expect(steps()).toBe(1)
      expect(store.state.privacy?.names).toEqual(remember === 'project' ? ['Jane', 'Ada Lovelace'] : ['Jane'])
      expect((api.prefs.get('privacy') as { names: string[] }).names).toEqual(remember === 'settings' ? ['Kim', 'Ada Lovelace'] : ['Kim'])
      if (remember === 'settings') expect(api.names.at(-1)).toEqual(['Kim', 'Ada Lovelace'])
    }
    expect(heard).toEqual(['project', 'settings'])
    // Not name-like: main returns no name, and nothing is remembered whatever was asked.
    setUp(project({ covers: [email()] }))
    remembered = undefined
    await follow.readUnderCover(services(), 'c')
    expect(await follow.runEverywhere(services(), 'c', 'project', new AbortController().signal)).toEqual({ added: 2, name: null })
    expect(store.state.privacy).toBeUndefined()
    off()
  })

  it('212. EverywhereDialog\'s states: reading, needsReader with Download, noText, the remember choice only when nameLike, progress with Stop, done and failed', async () => {
    setUp(project({ covers: [email()] }))
    const root = { type: EverywhereDialog, props: { services: services(), coverId: 'c', onClose: () => undefined } }
    // Reading the text under the cover.
    let under: (v: unknown) => void = () => undefined
    api.under = () => new Promise((r) => (under = r))
    let els = render(root)
    const dialog = byTestId(els, 'everywhere-dialog')!
    expect(dialog.props.role).toBe('dialog')
    expect(dialog.props['aria-modal']).toBe('true')
    expect(textOf(els.find((e) => e.props.id === dialog.props['aria-labelledby']))).toBe('Cover this text everywhere')
    expect(textOf(byTestId(els, 'everywhere-reading'))).toBe('Reading the text under the cover…')
    // The reader is missing: Download.
    under({ ok: false, reason: 'reader' })
    els = await settle(root)
    expect(textOf(byTestId(els, 'everywhere-needs-reader'))).toContain('This needs the text reader, a 27.6 MB download from Hugging Face. It runs on this PC.')
    api.download = async () => ({ status: 'failed', reason: 'The network is off.' })
    click(byTestId(els, 'everywhere-download'))
    els = await settle(root)
    expect(textOf(byTestId(els, 'everywhere-needs-reader'))).toContain('The text reader could not be downloaded. The network is off.')
    expect(textOf(byTestId(els, 'everywhere-download'))).toBe('Try again')
    // Downloaded: read again; nothing under the cover.
    api.under = async () => ({ ok: false, reason: 'noText' })
    api.download = async () => ({ status: 'ready', bytes: 1, decodeMs: null })
    click(byTestId(els, 'everywhere-download'))
    els = await settle(root)
    expect(textOf(byTestId(els, 'everywhere-noText'))).toBe('Flown found no text under this cover.')
    // Text that is not name-like: no remember choice.
    unmountAll()
    api.under = async () => ({ ok: true, nameLike: false })
    els = await settle(root)
    expect(textOf(els.find((e) => e.props.className === 'modal-body'))).toContain('Flown reads the text under this cover, finds it wherever it shows in this video, and covers it there.')
    expect(byTestId(els, 'everywhere-remember')).toBeUndefined()
    // A name: the remember choice, No checked.
    unmountAll()
    api.under = async () => ({ ok: true, nameLike: true })
    els = await settle(root)
    const remember = byTestId(els, 'everywhere-remember')!
    expect(textOf(remember)).toBe('Also add it to the names to hideNoIn this video. The text is saved in this video\'s project file.In every video. The text is saved in Flown\'s settings on this PC.')
    const radios = els.filter((e) => e.type === 'input' && e.props.type === 'radio')
    expect(radios.map((r) => r.props.checked)).toEqual([true, false, false])
    // Running: progress with Stop; Stop keeps what was found so far (main answers with it).
    let ended: (v: unknown) => void = () => undefined
    let sent: Record<string, unknown> | null = null
    api.everywhere = (req) => {
      sent = req
      return new Promise((r) => (ended = r))
    }
    ;(radios[1].props.onChange as () => void)()
    els = render(root)
    click(byTestId(els, 'everywhere-start'))
    els = render(root)
    expect(byTestId(els, 'everywhere-running')).toBeDefined()
    expect(sent).toMatchObject({ projectId: 'p', remember: 'project' })
    click(byTestId(els, 'everywhere-stop'))
    expect(api.stopped).toEqual(['p'])
    ended({ ok: true, projectId: 'p', requestId: sent!.requestId, found: [{ kind: 'text', score: 1, group: 'x', start: 12, end: 14, path: writePath([key(12, 0.5, 0.2, 0.25, 0.04)]), color: '#203040' }], failedReads: 0, thinSpans: '', stopped: true, readTo: 14, reader: 'r' })
    els = await settle(root)
    expect(textOf(byTestId(els, 'everywhere-done'))).toBe('Covered 1 more place.')
    // Failed.
    unmountAll()
    api.everywhere = async () => ({ ok: false, projectId: 'p', requestId: 'x', reason: 'failed' })
    els = await settle(root)
    click(byTestId(els, 'everywhere-start'))
    els = await settle(root)
    expect(textOf(byTestId(els, 'everywhere-failed'))).toBe('Flown could not cover this text everywhere. Try again, or cover its other places by hand.')
  })
})

describe('auto-blur P1: the Covers row', () => {
  /** The timeline's snapping as the tracks use it: no snapping, the drag's own delta. */
  const snap = {
    begin: () => ({
      span: (_ev: unknown, _initial: unknown, _mode: unknown, dt: number, resolve: (d: number) => unknown) => resolve(dt),
      group: (_ev: unknown, _points: unknown, dt: number) => ({ delta: dt, exact: null })
    })
  }
  /** The row with the timeline's real multi-select controller (as Timeline.tsx makes it). */
  function Row(props: { selection: unknown; onSelect: (s: unknown) => void; onMulti: (m: unknown) => void }): unknown {
    const m = multi.useMultiSelect({ snap, pxRef: { current: 50 }, dragging: { current: false }, contentRef: { current: null }, boxRef: { current: null }, selection: props.selection, onSelect: props.onSelect })
    props.onMulti(m)
    return { type: track.CoverTrack, props: { px: 50, win: { start: 0, end: 30 }, duration: 30, selection: props.selection, onSelect: props.onSelect, scrub: () => undefined, snap, multi: m } }
  }
  const pointer = (over: Record<string, unknown> = {}): Record<string, unknown> => ({
    button: 0,
    clientX: 50,
    clientY: 5,
    ctrlKey: false,
    metaKey: false,
    shiftKey: false,
    altKey: false,
    currentTarget: { getBoundingClientRect: () => ({ left: 0, right: 100, width: 100, top: 0, bottom: 10 }) },
    target: {},
    preventDefault() {},
    stopPropagation() {},
    ...over
  })
  const covers = (): Cover[] => [
    cover('g1', 1, 3, [key(1, 0.1, 0.1, 0.2, 0.05)], { found: 'auto', kind: 'email', group: 'ga' }),
    cover('g2', 2, 4, [key(2, 0.1, 0.3, 0.2, 0.05)], { found: 'auto', kind: 'email', group: 'ga' }),
    cover('k', 6, 8, [key(6, 0.5, 0.5, 0.2, 0.05)], { found: 'check', kind: 'key', group: 'gb' }),
    cover('l', 9, 12, [key(9, 0.5, 0.5, 0.2, 0.05), key(10, 0.5, 0.4, 0.2, 0.05), key(11, 0.5, 0.3, 0.2, 0.05)], { kind: 'phone', group: 'gc', lost: true }),
    cover('m', 14, 16, [key(14, 0.7, 0.7, 0.1, 0.1)])
  ]
  const selections: unknown[] = []
  const rowOf = (els: El[]): El => byTestId(els, 'cover-track')!
  const bars = (els: El[]): El[] => els.filter((e) => e.props['data-cover-item'] !== undefined && e.props['data-cover'] !== undefined)

  it('66. CoverTrack draws only with covers: bars, dashed waiting edges, the warning edge for Check, hatched lost areas, one bar with a count for a group\'s overlapping covers; clicking it selects the group, Ctrl+click toggles one cover; each bar\'s accessible name', () => {
    setUp(project())
    const root = { type: Row, props: { selection: null, onSelect: (s: unknown) => void selections.push(s), onMulti: () => undefined } }
    expect(render(root)).toEqual([])
    setUp(project({ covers: covers() }))
    let els = render(root)
    const row = rowOf(els)
    expect([row.props.role, row.props['aria-label']]).toEqual(['listbox', 'Covers'])
    const b = bars(els)
    // The group's two overlapping covers are one bar with a count.
    expect(b.map((x) => x.props['data-cover'])).toEqual(['g1', 'k', 'l', 'm'])
    expect(textOf(b[0])).toBe('2')
    expect(b.map((x) => x.props['aria-label'])).toEqual([
      'Suggested cover, Email address, 0:01.0 to 0:04.0 · 2 places',
      'Cover to check, Key or token, 0:06.0 to 0:08.0',
      'Cover, Phone number, 0:09.0 to 0:12.0',
      'Cover, 0:14.0 to 0:16.0'
    ])
    // Waiting: dashed; Check: the warning edge; lost: hatched.
    expect(b[0].props.className).toContain(' waiting')
    expect(b[1].props.className).toContain(' check')
    expect(b[2].props.className).toContain(' lost')
    expect(b[3].props.className).not.toMatch(/waiting|check|lost/)
    // Thin marks where a path changes.
    expect(els.filter((e) => e.props.className === 'cover-key-mark')).toHaveLength(2)
    // A click on the group's bar selects every cover of the group.
    ;(b[0].props.onPointerDown as (e: unknown) => void)(pointer())
    drag.up?.()
    expect(events.selects.at(-1)).toEqual({ keys: ['cover:g1', 'cover:g2'], anchor: 'cover:g1' })
    // A click on a lone cover's bar selects it.
    ;(b[3].props.onPointerDown as (e: unknown) => void)(pointer())
    drag.up?.()
    expect(selections.at(-1)).toEqual({ kind: 'cover', id: 'm' })
    // Ctrl+click toggles one cover in or out of the selection.
    contexts.group = groupApi([], 'cover:m')
    els = render(root)
    ;(bars(els)[1].props.onPointerDown as (e: unknown) => void)(pointer({ ctrlKey: true }))
    drag.up?.()
    expect(events.selects.at(-1)!.keys).toEqual(['cover:m', 'cover:k'])
    contexts.group = groupApi(['cover:m', 'cover:k'])
    els = render(root)
    ;(bars(els)[1].props.onPointerDown as (e: unknown) => void)(pointer({ ctrlKey: true }))
    drag.up?.()
    expect(events.selects.at(-1)!.keys).toEqual(['cover:m'])
  })

  it('67. CoverTrack keys: roving focus, Left, Right, Home, End, Enter, Delete and Shift+arrows; selection follows focus (finding 36); dragging a followed cover in time is refused with the status line', () => {
    setUp(project({ covers: covers() }))
    selections.length = 0
    const root = { type: Row, props: { selection: null, onSelect: (s: unknown) => void selections.push(s), onMulti: () => undefined } }
    let els = render(root)
    const press = (k: string, mods: Record<string, boolean> = {}): void => {
      ;(rowOf(els).props.onKeyDown as (e: unknown) => void)(keyEvent(k, mods))
      els = render(root)
    }
    // One tab stop: the first bar.
    expect(bars(els).map((x) => x.props.tabIndex)).toEqual([0, -1, -1, -1])
    focused.length = 0
    press('ArrowRight')
    expect(bars(els).map((x) => x.props.tabIndex)).toEqual([-1, 0, -1, -1])
    expect(focused.at(-1)?.props['data-cover']).toBe('k')
    // Selection follows focus.
    expect(events.selects.at(-1)).toBeUndefined()
    expect(selections.at(-1)).toEqual({ kind: 'cover', id: 'k' })
    press('End')
    expect(selections.at(-1)).toEqual({ kind: 'cover', id: 'm' })
    press('Home')
    expect(events.selects.at(-1)).toEqual({ keys: ['cover:g1', 'cover:g2'], anchor: 'cover:g1' })
    press('ArrowLeft')
    expect(bars(els)[0].props.tabIndex).toBe(0)
    // Enter selects; Ctrl+Enter toggles one cover.
    press('ArrowRight')
    selections.length = 0
    press('Enter')
    expect(selections).toEqual([{ kind: 'cover', id: 'k' }])
    contexts.group = groupApi([], 'cover:m')
    els = render(root)
    press('Enter', { ctrlKey: true })
    expect(events.selects.at(-1)!.keys).toEqual(['cover:m', 'cover:k'])
    contexts.group = groupApi()
    els = render(root)
    // Delete uncovers the suggestion, with the status line, its place remembered.
    press('Delete')
    expect(store.state.covers!.some((c) => c.id === 'k')).toBe(false)
    expect(events.notices.at(-1)).toBe('Uncovered. It will show in exports.')
    expect(store.state.privacy!.rejected!.map((r) => r.kind)).toEqual(['key'])
    // The focus stays in place: the next bar. Shift+Right moves its end nearer the playhead by one frame, Shift+Left back.
    expect(bars(els).find((x) => x.props.tabIndex === 0)!.props['data-cover']).toBe('l')
    player.time = 11.9
    press('ArrowRight', { shiftKey: true })
    expect(store.state.covers!.find((c) => c.id === 'l')!.end).toBeCloseTo(12 + 1 / 60, 2)
    press('ArrowLeft', { shiftKey: true })
    press('ArrowLeft', { shiftKey: true })
    expect(store.state.covers!.find((c) => c.id === 'l')!.end).toBeCloseTo(12 - 1 / 60, 2)
    // Nearer its start: the start moves.
    player.time = 9.1
    press('ArrowRight', { shiftKey: true })
    expect(store.state.covers!.find((c) => c.id === 'l')!.start).toBeCloseTo(9 + 1 / 60, 2)
    // Escape returns the focus to the row.
    focused.length = 0
    press('Escape')
    expect(focused.at(-1)?.props['data-testid']).toBe('cover-track')
    // Dragging the middle of a cover that follows text in time: refused, with the status line.
    const followed = bars(els).find((x) => x.props['data-cover'] === 'l')!
    const before = store.state.covers!.find((c) => c.id === 'l')
    ;(followed.props.onPointerDown as (e: unknown) => void)(pointer())
    drag.move!({ clientX: 150, clientY: 5 })
    drag.up?.()
    expect(store.state.covers!.find((c) => c.id === 'l')).toBe(before)
    expect(events.notices.at(-1)).toBe("This cover follows moving text, so it can't be moved in time. Drag its ends to change how long it lasts.")
    // Its end can still be dragged (one undo step per drag); a one-key cover moves.
    const n = steps()
    els = render(root)
    const lEnd = store.state.covers!.find((c) => c.id === 'l')!.end
    ;(bars(els).find((x) => x.props['data-cover'] === 'l')!.props.onPointerDown as (e: unknown) => void)(pointer({ clientX: 98 }))
    drag.move!({ clientX: 123, clientY: 5 })
    drag.move!({ clientX: 148, clientY: 5 })
    drag.up?.()
    expect(store.state.covers!.find((c) => c.id === 'l')!.end).toBeCloseTo(lEnd + 1, 3)
    els = render(root)
    ;(bars(els).find((x) => x.props['data-cover'] === 'm')!.props.onPointerDown as (e: unknown) => void)(pointer())
    drag.move!({ clientX: 100, clientY: 5 })
    drag.up?.()
    expect([store.state.covers!.find((c) => c.id === 'm')!.start, store.state.covers!.find((c) => c.id === 'm')!.end]).toEqual([15, 17])
    expect(steps()).toBe(n + 2)
  })

  it('214. The Covers row\'s thin-span marks are items of its roving focus with their names, and Enter seeks to their start', () => {
    setUp(project({ covers: covers(), privacy: { find: { at: '2026-11-20T10:00:00.000Z', kinds: ['email'], listened: false, thin: '5 5.5;12.5 13.5' } } }))
    const root = { type: Row, props: { selection: null, onSelect: () => undefined, onMulti: () => undefined } }
    let els = render(root)
    const items = els.filter((e) => e.props['data-cover-item'] !== undefined)
    expect(items.map((e) => e.props['aria-label'])).toEqual([
      'Suggested cover, Email address, 0:01.0 to 0:04.0 · 2 places',
      'Read less often, 0:05.0 to 0:05.5',
      'Cover to check, Key or token, 0:06.0 to 0:08.0',
      'Cover, Phone number, 0:09.0 to 0:12.0',
      'Read less often, 0:12.5 to 0:13.5',
      'Cover, 0:14.0 to 0:16.0'
    ])
    const marks = els.filter((e) => e.props.className === 'cover-thin-mark')
    expect(marks.map((m) => [m.props.role, m.props.tabIndex])).toEqual([
      ['option', -1],
      ['option', -1]
    ])
    ;(rowOf(els).props.onKeyDown as (e: unknown) => void)(keyEvent('ArrowRight'))
    els = render(root)
    expect(els.filter((e) => e.props.className === 'cover-thin-mark')[0].props.tabIndex).toBe(0)
    player.seeks = []
    ;(rowOf(els).props.onKeyDown as (e: unknown) => void)(keyEvent('Enter'))
    expect(player.seeks).toEqual([5])
  })
})

describe('auto-blur P1: the preview', () => {
  const view = { screen: { x: 0, y: 0, w: 960, h: 540 }, camera: null, moving: false }
  function paused(p: Project): void {
    const scene = { project: p, cursor: NO_CURSOR, cursorPath: { at: () => ({ x: 0.5, y: 0.5 }) }, focusPath: { at: () => ({ x: 0.5, y: 0.5 }) } }
    player.pausedFrame = () => ({ scene })
  }
  const endGesture = (): void => {
    for (const f of windowListeners.get('pointerup') ?? []) f({})
  }

  it('68. CoverHandles: a drag moves the box at the playhead in one undo step', () => {
    const p = project({ covers: [cover('c', 1, 5, [key(1, 0.25, 0.5, 0.2, 0.05)])] })
    setUp(p, [], 'cover:c')
    // A slow drag: seconds between moves, past the undo merge window; the gesture still makes one step.
    let clock = 0
    store = new EditStore<Project>(p, 200, 800, () => (clock += 2000))
    contexts.editor = services()
    paused(p)
    const root = { type: CoverHandles, props: { project: p, selection: { kind: 'cover', id: 'c' }, view } }
    const els = render(root)
    const box = byTestId(els, 'cover-handles')!
    expect(box.props.style).toEqual({ left: 240, top: 270, width: 192, height: 27 })
    expect(els.filter((e) => e.props.className === 'cover-handle')).toHaveLength(8)
    ;(box.props.onPointerDown as (e: unknown) => void)({ button: 0, clientX: 300, clientY: 280, preventDefault() {}, stopPropagation() {}, target: {} })
    drag.move!({ clientX: 348, clientY: 280 })
    drag.move!({ clientX: 396, clientY: 307 })
    endGesture()
    const b = boxAt(store.state.covers![0], 2)!
    expect(b.x).toBeCloseTo(0.35, 4)
    expect(b.y).toBeCloseTo(0.55, 4)
    expect(steps()).toBe(1)
    store.undo()
    expect(store.state).toBe(p)
    // An edge handle widens it at every key.
    const e = render(root).filter((x) => x.props['data-handle'] === 'e')[0]
    ;(e.props.onPointerDown as (ev: unknown) => void)({ button: 0, clientX: 432, clientY: 280, preventDefault() {}, stopPropagation() {}, target: {} })
    drag.move!({ clientX: 480, clientY: 280 })
    endGesture()
    expect(boxAt(store.state.covers![0], 2)!.w).toBeCloseTo(0.25, 4)
    // Playing: no handles.
    player.moving = true
    expect(render(root)).toEqual([])
    player.moving = false
  })

  it('71. Group time moves move one-key covers and leave followed ones with the status line; arrow keys on the preview move whole paths', () => {
    const followedCover = cover('f', 6, 10, [key(6, 0.5, 0.5, 0.2, 0.05), key(8, 0.5, 0.4, 0.2, 0.05)])
    const p = project({ covers: [cover('a', 1, 3, [key(1, 0.1, 0.1, 0.2, 0.05)]), followedCover] })
    setUp(p, ['cover:a', 'cover:f'])
    let controller: { press(e: unknown, k: string, m: string): boolean } | null = null
    render({ type: (props: Record<string, unknown>) => {
      controller = multi.useMultiSelect({ snap: { begin: () => ({ group: (_e: unknown, _p: unknown, dt: number) => ({ delta: dt, exact: null }) }) }, pxRef: { current: 50 }, dragging: { current: false }, contentRef: { current: null }, boxRef: { current: null }, selection: null, onSelect: () => undefined })
      void props
      return null
    }, props: {} })
    // A drag of a member moves the group: the one-key cover by the drag, the followed one stays, and the status line says why.
    expect(controller!.press({ button: 0, clientX: 100, clientY: 5, ctrlKey: false, metaKey: false, shiftKey: false, preventDefault() {}, stopPropagation() {} }, 'cover:a', 'move')).toBe(true)
    drag.move!({ clientX: 150, clientY: 5 })
    drag.move!({ clientX: 200, clientY: 5 })
    drag.up?.()
    const a = store.state.covers!.find((c) => c.id === 'a')!
    expect([a.start, a.end]).toEqual([3, 5])
    expect(store.state.covers!.find((c) => c.id === 'f')).toBe(followedCover)
    expect(events.notices).toEqual(["This cover follows moving text, so it can't be moved in time. Drag its ends to change how long it lasts."])
    expect(steps()).toBe(1)
    // Arrow keys on the preview: the selected cover's whole path, one pixel of the recording (Shift: ten).
    setUp(p, [], 'cover:f')
    player.time = 7
    paused(p)
    const handles = byTestId(render({ type: CoverHandles, props: { project: p, selection: { kind: 'cover', id: 'f' }, view } }), 'cover-handles')!
    ;(handles.props.onKeyDown as (e: unknown) => void)(keyEvent('ArrowRight'))
    ;(handles.props.onKeyDown as (e: unknown) => void)(keyEvent('ArrowDown', { shiftKey: true }))
    const keys = pathKeys(store.state.covers!.find((c) => c.id === 'f')!)
    // (Written rounded outward: x and y down to 4 decimals.)
    expect(keys.map((k) => [+k.x.toFixed(4), +k.y.toFixed(4)])).toEqual([
      [0.5005, 0.5092],
      [0.5005, 0.4092]
    ])
  })

  it('69. PeekBanner shows while anything is peeked; Stop peeking clears it', () => {
    setUp(project())
    expect(render({ type: PeekBanner, props: {} })).toEqual([])
    peek.peekCovers(['a'])
    const els = render({ type: PeekBanner, props: {} })
    const banner = byTestId(els, 'peek-banner')!
    expect(banner.props.role).toBe('status')
    expect(textOf(banner)).toBe('Peeking under covers. Exports still cover them.Stop peeking')
    click(byTestId(els, 'peek-stop'))
    expect(peek.peekNow().ids).toBeNull()
    expect(render({ type: PeekBanner, props: {} })).toEqual([])
  })

  it('208. PeekInset draws the selected cover\'s area at 2× to 8× the preview\'s scale, never past the recording\'s own pixels, only while a row is peeked, and is not drawn by any export path', () => {
    // The geometry: a margin of half the box's height, clipped to the frame.
    const g = inset.insetGeometry({ x: 0.5, y: 0.5, w: 0.1, h: 0.01 }, { w: 1920, h: 1080 }, 0.25)
    expect([g.sx, g.sy, g.sw, g.sh]).toEqual([954, 534, 204, 23])
    // At least twice the preview's scale, at most eight times, never past one canvas pixel per recording pixel.
    expect(g.scale).toBeGreaterThanOrEqual(0.5)
    expect(g.scale).toBeLessThanOrEqual(1)
    expect(inset.insetGeometry({ x: 0.1, y: 0.1, w: 0.3, h: 0.3 }, { w: 1920, h: 1080 }, 0.1).scale).toBeCloseTo(0.2, 9)
    expect(inset.insetGeometry({ x: 0.1, y: 0.1, w: 0.1, h: 0.004 }, { w: 1920, h: 1080 }, 0.05).scale).toBeCloseTo(0.4, 9)
    expect(inset.insetGeometry({ x: 0.1, y: 0.1, w: 0.1, h: 0.01 }, { w: 1920, h: 1080 }, 0.9).scale).toBe(1)
    // Only while peeked: the selected cover's area, as a named canvas.
    const p = project({ covers: [cover('a', 1, 5, [key(1, 0.5, 0.5, 0.1, 0.01)]), cover('b', 1, 5, [key(1, 0.1, 0.1, 0.1, 0.01)])] })
    setUp(p, [], 'cover:b')
    const root = { type: inset.PeekInset, props: { services: services(), view } }
    expect(render(root)).toEqual([])
    peek.peekCovers('all')
    const els = render(root)
    const canvas = els.find((e) => e.type === 'canvas')!
    expect([canvas.props.role, canvas.props['aria-label']]).toEqual(['img', 'Magnified view of what is under the cover'])
    peek.clearPeek()
    expect(render(root)).toEqual([])
    // Not part of any scene: the compositor, the exporter, thumbnails and guide shots never reach it.
    for (const f of ['src/renderer/src/render/compositor.ts', 'src/renderer/src/editor/exporter.ts', 'src/renderer/src/editor/ExportPreview.tsx', 'src/renderer/src/guide/guideStills.ts', 'src/renderer/src/views/Home.tsx']) expect(fs.readFileSync(f, 'utf8')).not.toContain('PeekInset')
    const mounts = fs.readdirSync('src/renderer/src', { recursive: true }).filter((f) => String(f).endsWith('.tsx') && fs.readFileSync(`src/renderer/src/${f}`, 'utf8').includes('<PeekInset'))
    expect(mounts.map(String)).toEqual(['editor/PreviewStage.tsx'])
  })
})

describe('auto-blur P1: commands and the guide', () => {
  it('74. Add a cover, Peek under covers, Start the selected cover here and End the selected cover here run from the palette and WAITING_P1 is empty', async () => {
    expect(WAITING_P1).toEqual([])
    const ids = PALETTE_COMMANDS.map((c) => c.id as string)
    for (const id of ['addCover', 'peekCovers', 'coverStartHere', 'coverEndHere']) expect(ids, id).toContain(id)
    expect(PALETTE_COMMANDS.find((c) => c.id === 'addCover')!.title).toBe('Add a cover')
    setUp(project({ covers: [cover('c', 1, 9, [key(1, 0.25, 0.5, 0.2, 0.05)])] }))
    let sel: unknown = null
    const notices: string[] = []
    const run = commands.coverCommands({ services: services(), cursor: NO_CURSOR, scene: () => ({}), selection: () => sel, select: (s: unknown) => void (sel = s), reveal: () => undefined, notice: (m: string) => void notices.push(m) })
    run.addCover()
    await flush()
    expect(store.state.covers).toHaveLength(2)
    expect(sel).toEqual({ kind: 'cover', id: store.state.covers![1].id })
    // Peek under covers: every cover, until run again.
    run.peekCovers()
    expect(peek.peekNow().ids).toBe('all')
    run.peekCovers()
    expect(peek.peekNow().ids).toBeNull()
    // Start and End here on the selected cover.
    sel = { kind: 'cover', id: 'c' }
    player.time = 3
    run.coverStartHere()
    player.time = 6
    run.coverEndHere()
    expect([store.state.covers![0].start, store.state.covers![0].end]).toEqual([3, 6])
    // Outside it, or with nothing selected, they say why.
    player.time = 20
    run.coverStartHere()
    expect(notices.at(-1)).toBe('The playhead is outside this cover.')
    sel = null
    run.coverEndHere()
    expect(notices.at(-1)).toBe('Select something on the timeline first')
  })

  it('60. The guide\'s buttons add covers over the old box and times in one update; their labels are unchanged; the hint shows', async () => {
    const { blurArea, blurTypedText } = await load<{ blurArea(s: unknown, step: unknown, o: unknown): Promise<string>; blurTypedText(s: unknown, ty: unknown, m: unknown, scan: unknown, scale: number, c: unknown): Promise<void> }>('guide/guideRun')
    setUp(project())
    const step = { key: 'c3000', t: 3, kind: 'click', x: 0.5, y: 0.5 }
    const id = await blurArea(services(), step, { after: false, scale: 1, onSelect: () => undefined })
    expect(steps()).toBe(1)
    expect(store.state.shapes ?? []).toEqual([])
    const c = store.state.covers![0]
    expect(c.id).toBe(id)
    expect(boxAt(c, 3)).toEqual({ x: 0.35, y: 0.45, w: 0.3, h: 0.1 })
    const typing = { key: 'c20500', t: 20.5, kind: 'click', x: 0.4, y: 0.6, typing: { t: 21, end: 23, place: { x: 0.4, y: 0.6 } } }
    await blurTypedText(store, typing, { t: 24.5 }, null, 1, async () => '#abcdef')
    expect(steps()).toBe(2)
    expect([store.state.covers![1].start, store.state.covers![1].end, store.state.covers![1].color]).toEqual([21, 30, '#abcdef'])
    // Their labels are unchanged; the hint says what they do now.
    expect([t('smart.guide.blurArea'), t('smart.guide.blurTyped'), t('smart.shot.blurArea')]).toEqual(['Blur an area…', 'Blur the typed text', 'Blur an area…'])
    expect(t('privacy.guide.covered')).toBe('The area is covered with a solid box in the video and in every screenshot.')
    const panel = fs.readFileSync('src/renderer/src/guide/GuidePanel.tsx', 'utf8')
    const row = panel.slice(panel.indexOf('data-testid="guide-blur"'))
    expect(row.indexOf("t('privacy.guide.covered')")).toBeGreaterThan(0)
    expect(row.indexOf("t('privacy.guide.covered')")).toBeLessThan(row.indexOf('</li>'))
  })
})
