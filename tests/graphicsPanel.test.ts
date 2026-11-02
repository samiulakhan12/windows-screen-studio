import { beforeEach, describe, expect, it, vi } from 'vitest'
import type { CaptionTrack, Graphic, KeywordGraphic, ListGraphic, Project } from '../src/shared/types'
import { allByTestId, button, byLabel, byTestId, contexts, mockReact, render, settle, testStore, textOf, unmountAll, useEditorContexts, type El } from './studioHarness'

/*
 * Inspector › Graphics (docs/design/captions-studio.md §2.11, §10.5, test 33) without a DOM. The
 * pure edits are part P1's (graphicsEdit.ts) and the generator and the options part P4's
 * (graphicRules.ts, great.ts): stand-ins here that do what the design says and record the calls.
 */

const calls = vi.hoisted(() => ({ plan: [] as unknown[], add: [] as unknown[], resolved: { keywords: false, emoji: false, counters: true, lists: true, speakers: true, chapters: false, quotes: false } }))
vi.mock('../src/shared/editor/graphicsEdit', () => ({
  addGraphic: (p: Project, kind: Graphic['kind'], at: number) => {
    calls.add.push([kind, at])
    const g = { id: 'new1', kind, start: at, end: at + 1.6, place: 'auto', size: 0.1, enter: { kind: 'pop', duration: 0.24, strength: 1 }, exit: { kind: 'fade', duration: 0.18, strength: 1 }, text: 'Key point', look: 'card' } as Graphic
    return { project: { ...p, graphics: [...(p.graphics ?? []), g] }, id: 'new1' }
  },
  updateGraphic: (p: Project, id: string, patch: Partial<Graphic>) => ({ ...p, graphics: p.graphics!.map((g) => (g.id === id ? ({ ...g, ...patch } as Graphic) : g)) }),
  deleteGraphics: (p: Project, ids: string[]) => ({ ...p, graphics: p.graphics!.filter((g) => !ids.includes(g.id)) }),
  placeGraphicAt: (p: Project, id: string, place: Graphic['place']) => ({ ...p, graphics: p.graphics!.map((g) => (g.id === id ? { ...g, place } : g)) }),
  moveGraphics: (p: Project) => p,
  trimGraphic: (p: Project) => p
}))
vi.mock('../src/shared/captions/graphicRules', () => ({
  planGraphics: (p: Project, opts: unknown) => {
    calls.plan.push(opts)
    const made = [counterOf('auto1', 4, 7), { ...counterOf('auto2', 9, 12), to: 50 }]
    return { ...p, graphics: [...(p.graphics ?? []), ...made] }
  },
  graphicId: () => 'g-x'
}))
vi.mock('../src/shared/captions/great', async (importOriginal) => ({
  ...(await importOriginal<Record<string, unknown>>()),
  readGreatOptions: (raw: unknown) => ({ style: true, emphasis: true, emoji: 'auto', keywords: 'auto', counters: 'auto', lists: 'auto', speakers: true, chapters: 'auto', quotes: false, tidy: true, sound: 'none', provider: null, ...(raw as object) }),
  resolveGreatOptions: (o: { sound: string }) => ({ ...o, ...calls.resolved })
}))

// Whether the last input was a key (focus.ts keeps it from the window's events, which these tests have not).
const keys = vi.hoisted(() => ({ last: false }))
vi.mock('../src/renderer/src/editor/focus', async (importOriginal) => ({ ...(await importOriginal<Record<string, unknown>>()), lastInputWasKey: () => keys.last }))

const counterOf = (id: string, start: number, end: number): Graphic => ({
  id,
  kind: 'counter',
  start,
  end,
  place: 'auto',
  size: 0.11,
  enter: { kind: 'pop', duration: 0.24, strength: 1 },
  exit: { kind: 'fade', duration: 0.18, strength: 1 },
  from: 0,
  to: 300,
  decimals: 0,
  prefix: '',
  suffix: '%',
  locale: 'en',
  countFor: 1.2,
  auto: { by: 'number', via: 'rules', caption: 'c2' }
})

const prefs: { captionsGreat: unknown; writes: unknown[] } = { captionsGreat: null, writes: [] }
let providers: unknown[] = []
vi.stubGlobal('window', {
  api: {
    getPref: async (key: string) => (key === 'captionsGreat' ? prefs.captionsGreat : null),
    setPref: async (_key: string, value: unknown) => void prefs.writes.push(value),
    listAiProviders: async () => providers,
    listAssets: async () => [],
    onAssetProgress: () => () => undefined
  },
  addEventListener: () => undefined,
  removeEventListener: () => undefined
})
vi.stubGlobal('document', { activeElement: null, body: {} })

mockReact()
// Renderer code: imported at run time so the Node typecheck of tests/ does not follow it.
const PANEL = '../src/renderer/src/editor/panels/GraphicsPanel'
const { GraphicsPanel, graphicLabel } = (await import(/* @vite-ignore */ PANEL)) as { GraphicsPanel: (p: unknown) => unknown; graphicLabel: (g: Graphic) => string }
await useEditorContexts()
const { DEFAULT_KEYMAP } = await import('../src/shared/editor/shortcuts')
const { createProject } = await import('../src/shared/engine/project')
const { DEFAULT_CAPTIONS } = await import('../src/shared/captions/settings')

const base = createProject({
  id: 'p',
  name: 'p',
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
const transcript = { language: 'en', segments: [{ id: 'c1', start: 0, end: 2, text: 'Sales grew 300 percent' }] } as Project['transcript']
const keyword: KeywordGraphic = {
  id: 'k1',
  kind: 'keyword',
  start: 2,
  end: 3.6,
  place: { x: 0.3, y: 0.3 },
  size: 0.09,
  enter: { kind: 'pop', duration: 0.24, strength: 1 },
  exit: { kind: 'fade', duration: 0.18, strength: 1 },
  text: 'Auto Save',
  look: 'card',
  anchor: { caption: 'c1', from: 0, to: 1, text: 'Sales grew' }
}
const list: ListGraphic = {
  id: 'l1',
  kind: 'list',
  start: 5,
  end: 10,
  place: 'auto',
  size: 0.045,
  enter: { kind: 'rise', duration: 0.22, strength: 1 },
  exit: { kind: 'fade', duration: 0.18, strength: 1 },
  marker: 'number',
  items: [{ text: 'Open settings', at: 5.2 }]
}

let store: ReturnType<typeof testStore<Project>>
const selected: unknown[] = []
const notices: string[] = []
const player = { time: 6, seek: vi.fn(), subscribe: () => () => undefined }
const SKIP = ['FontPicker', 'LookButtons']
const view = (selection: unknown = null): unknown => ({ type: GraphicsPanel, props: { project: store.state, selection } })

beforeEach(() => {
  unmountAll()
  store = testStore<Project>({ ...base, transcript, graphics: [keyword, list] })
  contexts.editor = { store, player }
  contexts.keymap = DEFAULT_KEYMAP
  contexts.group = { group: { keys: [], anchor: null, stamp: 0 }, keys: new Set(), single: null, select: (keys: unknown[]) => selected.push(keys), notice: (m: string) => notices.push(m), command: () => undefined }
  selected.length = 0
  notices.length = 0
  calls.plan.length = 0
  calls.add.length = 0
  prefs.captionsGreat = null
  prefs.writes.length = 0
  providers = []
  keys.last = false
  player.seek.mockClear()
})

const chip = (els: El[], text: string): El | undefined => els.find((e) => e.type === 'button' && String(e.props.className ?? '').startsWith('chip') && textOf(e) === text)
const hints = (els: El[]): string[] => els.filter((e) => e.type === 'p' && e.props.className === 'hint').map(textOf)

describe('with nothing selected', () => {
  it('starts the chips as Make my captions great’s options resolve, Quotes only with a provider', async () => {
    let els = await settle(view(), SKIP)
    expect(chip(els, 'Counters')!.props['aria-pressed']).toBe(true)
    expect(chip(els, 'Emoji')!.props['aria-pressed']).toBe(false)
    expect(chip(els, 'Quotes')).toBeUndefined()
    unmountAll()
    providers = [{ id: 'a', kind: 'gemini' }]
    els = await settle(view(), SKIP)
    expect(chip(els, 'Quotes')).toBeDefined()
  })

  it('adds pop-ups from captions in one undo step with the chips and the saved sound, and says how many', async () => {
    prefs.captionsGreat = { sound: 'ding' }
    let els = await settle(view(), SKIP)
    ;(chip(els, 'Emoji')!.props.onClick as () => void)()
    els = await settle(view(), SKIP)
    ;(byTestId(els, 'graphics-generate')!.props.onClick as () => void)()
    expect(calls.plan).toEqual([{ keywords: false, emoji: true, counters: true, lists: true, speakers: true, chapters: false, quotes: false, sound: 'ding' }])
    expect(store.steps).toBe(1)
    expect(notices).toEqual(['Added 2 pop-ups (Undo removes them)'])
  })

  it('saves Sound on pop-ups with the options of Make my captions great', async () => {
    const els = await settle(view(), SKIP)
    ;(byTestId(els, 'graphics-sound')!.props.onChange as (e: unknown) => void)({ target: { value: 'pop' } })
    expect(prefs.writes.at(-1)).toMatchObject({ sound: 'pop', style: true })
  })

  it('adds one graphic of a kind from the Add menu at the playhead, selected', async () => {
    let els = await settle(view(), SKIP)
    const add = byTestId(els, 'graphics-add')!
    expect(add.props['aria-haspopup']).toBe('menu')
    ;(add.props.onClick as () => void)()
    els = await settle(view(), SKIP)
    expect(els.filter((e) => e.props.role === 'menuitem').map(textOf)).toEqual(['Keyword pop-up', 'Emoji', 'Counter', 'List card'])
    ;(byTestId(els, 'graphics-add-counter')!.props.onClick as () => void)()
    expect(calls.add).toEqual([['counter', 6]])
    expect(store.steps).toBe(1)
    expect(selected).toEqual([['graphic:new1']])
  })

  it('a pop-up added from the Add menu with the keyboard takes the focus in its first field, once, as the menu item goes', async () => {
    keys.last = true
    let els = await settle(view(), SKIP)
    ;(byTestId(els, 'graphics-add')!.props.onClick as () => void)()
    els = await settle(view(), SKIP)
    ;(byTestId(els, 'graphics-add-keyword')!.props.onClick as () => void)()
    expect(selected).toEqual([['graphic:new1']])
    // The panel shows the selected pop-up's fields: its Text field takes the focus as it mounts.
    els = render(view({ kind: 'graphic', id: 'new1' }), SKIP)
    expect(byLabel(els, 'Text')!.props.autoFocus).toBe(true)
    // Only then: shown again (another graphic selected and back), it does not take it again.
    unmountAll()
    els = render(view({ kind: 'graphic', id: 'new1' }), SKIP)
    expect(byLabel(els, 'Text')!.props.autoFocus).not.toBe(true)
  })

  it('a pop-up added from the Add menu with a click leaves the focus alone', async () => {
    let els = await settle(view(), SKIP)
    ;(byTestId(els, 'graphics-add')!.props.onClick as () => void)()
    els = await settle(view(), SKIP)
    ;(byTestId(els, 'graphics-add-keyword')!.props.onClick as () => void)()
    els = render(view({ kind: 'graphic', id: 'new1' }), SKIP)
    expect(byLabel(els, 'Text')!.props.autoFocus).not.toBe(true)
  })

  it('lists every graphic with its text, time and kind, and a row selects it', async () => {
    const els = await settle(view(), SKIP)
    const rows = els.filter((e) => e.props['data-graphic-item'])
    expect(rows.map(textOf)).toEqual(['“Auto Save”0:02 · Keyword pop-up', 'List: 1 item0:05 · List card'])
    ;(rows[1].props.onClick as (e: unknown) => void)({ ctrlKey: false, metaKey: false, shiftKey: false })
    expect(selected).toEqual([['graphic:l1']])
  })
})

describe('the hints (§0.4)', () => {
  // Review mode comes in phase B: until then no hint sends the user looking for it.
  it('point to nothing this version lacks, with nothing selected and on a pop-up made automatically', async () => {
    const panel = hints(await settle(view(), SKIP))
    expect(panel).toContain('Drag one in the preview to place it yourself.')
    unmountAll()
    store.state = { ...store.state, graphics: [counterOf('c9', 1, 4)] }
    const selectedHints = hints(await settle(view({ kind: 'graphic', id: 'c9' }), SKIP))
    expect(selectedHints).toContain('Made automatically. Editing it makes it yours.')
    for (const hint of [...panel, ...selectedHints]) expect(hint).not.toMatch(/Review/)
  })
})

describe('a selected graphic', () => {
  it('types a keyword’s text as one undo step per pause, and turns Replace the caption off', async () => {
    const els = await settle(view({ kind: 'graphic', id: 'k1' }), SKIP)
    const text = byLabel(els, 'Text')!
    ;(text.props.onChange as (e: unknown) => void)({ target: { value: 'Auto' } })
    ;(text.props.onChange as (e: unknown) => void)({ target: { value: 'Auto Save on' } })
    expect(store.updates.map((u) => u.key)).toEqual(['graphic-text:k1', 'graphic-text:k1'])
    expect(store.steps).toBe(1)
    expect(textOf(els.find((e) => e.type === 'p' && textOf(e).startsWith('Replaces'))!)).toBe('Replaces its caption words while it shows.')
    const replace = els.find((e) => e.type === 'input' && e.props['aria-label'] === 'Replace the caption')!
    ;(replace.props.onChange as (e: unknown) => void)({ target: { checked: false } })
    expect((store.state.graphics![0] as KeywordGraphic).replace).toBe(false)
  })

  it('places a dragged graphic automatically again, and deletes it', async () => {
    let els = await settle(view({ kind: 'graphic', id: 'k1' }), SKIP)
    expect(textOf(byTestId(els, 'graphic-place')!)).toContain('Placed by you')
    ;(button(els, 'Place automatically')!.props.onClick as () => void)()
    expect(store.state.graphics![0].place).toBe('auto')
    store.seal()
    els = await settle(view({ kind: 'graphic', id: 'k1' }), SKIP)
    ;(byTestId(els, 'graphic-delete')!.props.onClick as () => void)()
    expect(store.state.graphics!.map((g) => g.id)).toEqual(['l1'])
    expect(selected.at(-1)).toEqual([])
    expect(store.steps).toBe(2)
  })

  it('picks an emoji by name from the bundled list', async () => {
    store.state = { ...store.state, graphics: [{ ...counterOf('e1', 1, 2), kind: 'emoji', emoji: '1f525' } as unknown as Graphic] }
    let els = await settle(view({ kind: 'graphic', id: 'e1' }), SKIP)
    expect(textOf(els.find((e) => e.props.className === 'emoji-current')!)).toContain('fire')
    ;(byLabel(els, 'Search emoji by name')!.props.onChange as (e: unknown) => void)({ target: { value: 'light bulb' } })
    els = await settle(view({ kind: 'graphic', id: 'e1' }), SKIP)
    const cells = els.filter((e) => String(e.props.className ?? '').startsWith('emoji-cell'))
    expect(cells.map((c) => c.props['aria-label'])).toEqual(['light bulb'])
    ;(cells[0].props.onClick as () => void)()
    expect((store.state.graphics![0] as unknown as { emoji: string }).emoji).toBe('1f4a1')
  })

  it('adds list items up to seven, each shown from the playhead', async () => {
    let els = await settle(view({ kind: 'graphic', id: 'l1' }), SKIP)
    for (let i = 0; i < 6; i++) {
      ;(button(els, 'Add item')!.props.onClick as () => void)()
      els = await settle(view({ kind: 'graphic', id: 'l1' }), SKIP)
    }
    const l = store.state.graphics![1] as ListGraphic
    expect(l.items).toHaveLength(7)
    expect(l.items[1]).toEqual({ text: 'Point 2', at: 6 })
    expect(button(els, 'Add item')).toBeUndefined()
  })

  it('sets the sound and the size with their own undo steps', async () => {
    const els = await settle(view({ kind: 'graphic', id: 'l1' }), SKIP)
    ;(chip(els, 'Ding')!.props.onClick as () => void)()
    expect(store.state.graphics![1].sound).toBe('ding')
    const size = els.find((e) => e.type === 'input' && e.props['aria-label'] === 'Size')!
    ;(size.props.onChange as (e: unknown) => void)({ target: { value: '0.06' } })
    expect(store.updates.at(-1)!.key).toBe('graphic-size:l1')
  })

  it('names graphics for rows, blocks and the Selection view', () => {
    expect(graphicLabel(keyword)).toBe('“Auto Save”')
    expect(graphicLabel(counterOf('c', 1, 2))).toBe('300%')
    expect(graphicLabel({ ...list, title: '3 steps' })).toBe('List: 3 steps')
  })

  it('shows every field of a counter', async () => {
    store.state = { ...store.state, graphics: [counterOf('c9', 1, 4)] }
    const els = await settle(view({ kind: 'graphic', id: 'c9' }), SKIP)
    for (const label of ['From', 'To', 'Before', 'After', 'Label', 'Count for']) expect(byLabel(els, label), label).toBeDefined()
    expect(allByTestId(els, 'graphic-place')).toHaveLength(1)
  })
  it('the Font menu’s note follows the caption track shown on the video, as graphics are drawn', async () => {
    const track = (language: string, text: string): CaptionTrack => ({ language, by: 'openai', model: 'gpt-4.1-mini', createdAt: '2026-11-01T00:00:00Z', segments: [{ id: 'c1', text, src: 'x' }] })
    const noteLanguage = async (): Promise<unknown> => (await settle(view({ kind: 'graphic', id: 'k1' }), SKIP)).find((e) => e.props.testId === 'graphic-font')!.props.language
    // English speech with its Russian translation shown: graphics, like the captions, need Russian letters.
    store.state = { ...store.state, captions: { ...DEFAULT_CAPTIONS, track: 'ru' }, captionTracks: [track('ru', 'Продажи выросли')] }
    expect(await noteLanguage()).toBe('ru')
    // Russian speech with its English translation shown.
    store.state = { ...store.state, transcript: { ...transcript!, language: 'ru' }, captions: { ...DEFAULT_CAPTIONS, track: 'en' }, captionTracks: [track('en', 'Sales grew')] }
    expect(await noteLanguage()).toBe('en')
  })
})
