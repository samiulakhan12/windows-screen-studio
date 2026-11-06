import { beforeEach, describe, expect, it, vi } from 'vitest'
import type { CaptionSettings, Graphic, Project } from '../src/shared/types'
import { contexts, key, mockReact, render, testStore, unmountAll, useEditorContexts, type El } from './studioHarness'

/*
 * The Captions commands of the palette (docs/design/captions-studio.md §2.14, test 57's phase-A
 * part) and the graphics' handles on the preview (§2.11). Parts P1, P2 and P4 are stand-ins.
 * The publishing pack's aiTranslate and aiCleanup, retargeted in phase B: aiCaptionCommands.test.ts.
 */

const p4 = vi.hoisted(() => ({ great: [] as unknown[], plans: [] as unknown[], tidies: [] as unknown[] }))
vi.mock('../src/renderer/src/editor/greatRun', () => ({
  runCaptionsGreat: async (deps: { options: unknown; frame: unknown; undo?: string }) => {
    p4.great.push(deps)
    return { notice: `Captions: Bold Pop, 38 words emphasised${deps.undo ?? ''}` }
  }
}))
vi.mock('../src/shared/captions/great', async (importOriginal) => ({
  ...(await importOriginal<Record<string, unknown>>()),
  readGreatOptions: (raw: unknown) => ({ read: raw ?? 'defaults' }),
  resolveGreatOptions: () => ({ keywords: false, emoji: false, counters: true, lists: true, speakers: true, chapters: false, quotes: true, sound: 'pop' })
}))
vi.mock('../src/shared/captions/graphicRules', () => ({
  planGraphics: (p: Project, opts: unknown) => {
    p4.plans.push(opts)
    return { ...p, graphics: [{ id: 'g-1', kind: 'counter', start: 1, end: 3 } as Graphic] }
  }
}))
vi.mock('../src/shared/captions/cleanup', async (importOriginal) => ({
  ...(await importOriginal<Record<string, unknown>>()),
  readCleanupChoices: (raw: unknown) => ({ caps: true, punct: true, digits: 'above-ten', bleep: 'off', bleepSound: 'tone', ai: false, ...(raw as object) }),
  tidyCaptions: (p: Project, opts: unknown) => {
    p4.tidies.push(opts)
    return { project: { ...p, name: 'tidied' }, changed: 12, bleeped: 2 }
  }
}))
vi.mock('../src/shared/captions/emphasis', () => ({ pickEmphasis: () => [{ id: 'm1', caption: 'c1', from: 0, to: 1, text: 'Make every', auto: true }] }))
vi.mock('../src/shared/captions/studioEdit', async () => await import('./studioStandIns'))
const handles = vi.hoisted(() => ({ rects: [] as { id: string; rect: { x: number; y: number; w: number; h: number } }[], block: null as { box: { x: number; y: number; w: number; h: number } } | null }))
vi.mock('../src/renderer/src/render/graphicsLayer', () => ({ graphicRects: () => handles.rects, drawGraphicsLayer: () => undefined }))
vi.mock('../src/renderer/src/render/studioLayer', () => ({ studioBlockAt: () => handles.block, drawStudioSample: () => ({ textPx: 18 }) }))
vi.mock('../src/shared/editor/graphicsEdit', () => ({
  placeGraphicAt: (p: Project, id: string, place: Graphic['place']) => ({ ...p, graphics: p.graphics!.map((g) => (g.id === id ? { ...g, place } : g)) })
}))

const prefs: Record<string, unknown> = {}
const writes: [string, unknown][] = []
/** The window's listeners (a drag on the preview follows the pointer there); fire() sends them an event. */
const listeners = new Map<string, Set<(e: unknown) => void>>()
const fire = (type: string, e: object): void => {
  for (const fn of [...(listeners.get(type) ?? [])]) fn({ type, ...e })
}
vi.stubGlobal('window', {
  api: { getPref: async (k: string) => prefs[k] ?? null, setPref: async (k: string, v: unknown) => void writes.push([k, v]) },
  addEventListener: (type: string, fn: (e: unknown) => void) => void (listeners.get(type) ?? listeners.set(type, new Set()).get(type)!).add(fn),
  removeEventListener: (type: string, fn: (e: unknown) => void) => void listeners.get(type)?.delete(fn)
})
// Pressing a handle lets go of the focus (focus.ts): nothing is focused here.
vi.stubGlobal('HTMLElement', class {})
vi.stubGlobal('document', { activeElement: null, body: {}, createElement: () => ({ getContext: () => ({}) }) })
vi.stubGlobal('requestAnimationFrame', (fn: () => void) => fn())

mockReact()
// Renderer code: imported at run time so the Node typecheck of tests/ does not follow it.
const COMMANDS = '../src/renderer/src/editor/captionCommands'
const ITEMS = '../src/renderer/src/editor/captionItems'
const HANDLE = '../src/renderer/src/editor/GraphicHandle'
const PRESETS = '../src/renderer/src/editor/captionPresets'
const { captionCommands, localTranslationOffered } = (await import(/* @vite-ignore */ COMMANDS)) as {
  captionCommands: (deps: unknown) => Record<string, () => void>
  localTranslationOffered: () => boolean
}
const items = (await import(/* @vite-ignore */ ITEMS)) as { takeCaptionsRequest(): unknown }
const { GraphicHandles, arrowStep } = (await import(/* @vite-ignore */ HANDLE)) as { GraphicHandles: (p: unknown) => unknown; arrowStep: (e: unknown) => { dx: number; dy: number } | null }
const presets = (await import(/* @vite-ignore */ PRESETS)) as { resetSavedLooksForTest(): void }
await useEditorContexts()
const { COMMAND_IDS } = await import('../src/shared/editor/commands')
const { DEFAULT_CAPTIONS } = await import('../src/shared/captions/settings')
const { createProject } = await import('../src/shared/engine/project')

const base = (captions?: CaptionSettings): Project => ({
  ...createProject({ id: 'p', name: 'p', duration: 10, width: 1080, height: 1920, hasWebcam: false, hasAudio: true, webcamOffset: 0, zooms: [], cursorValid: true, capture: { method: 'native', cursorInVideo: false, region: null } }),
  transcript: { language: 'en', segments: [{ id: 'c1', start: 0, end: 2, text: 'Make every word count today' }] } as Project['transcript'],
  ...(captions ? { captions } : {})
})

let store: ReturnType<typeof testStore<Project>>
const tabs: string[] = []
const notices: string[] = []
const deps = (): unknown => ({ store, setTab: (t: string) => tabs.push(t), notice: (m: string) => notices.push(m), frame: () => ({ w: 1080, h: 1920 }), undo: () => ' · Ctrl + Z to undo' })
const flush = async (): Promise<void> => {
  for (let i = 0; i < 6; i++) await Promise.resolve()
  await new Promise((r) => setTimeout(r, 0))
}

beforeEach(() => {
  unmountAll()
  store = testStore(base())
  tabs.length = 0
  notices.length = 0
  writes.length = 0
  for (const k of Object.keys(prefs)) delete prefs[k]
  p4.great.length = 0
  p4.plans.length = 0
  p4.tidies.length = 0
  items.takeCaptionsRequest()
  presets.resetSavedLooksForTest()
})

describe('the seven Captions commands', () => {
  it('are all wired, each to a palette id', () => {
    const c = captionCommands(deps())
    for (const id of Object.keys(c)) expect(COMMAND_IDS).toContain(id)
    expect(Object.keys(c).sort()).toEqual(['captionEmphasis', 'captionGraphics', 'captionLanguage', 'captionStyles', 'captionTidy', 'captionsGreat', 'saveCaptionStyle'])
  })

  it('Make my captions great runs with the saved options for the frame and shows its notice', async () => {
    prefs.captionsGreat = { emoji: true }
    captionCommands(deps()).captionsGreat()
    await flush()
    expect(tabs).toEqual(['captions'])
    expect(p4.great).toHaveLength(1)
    expect(p4.great[0]).toMatchObject({ options: { read: { emoji: true } }, frame: { w: 1080, h: 1920 }, undo: ' · Ctrl + Z to undo' })
    expect(notices).toEqual(['Captions: Bold Pop, 38 words emphasised · Ctrl + Z to undo'])
  })

  it('Add a caption language… asks Languages for the AI route while On this PC is not offered', () => {
    expect(localTranslationOffered()).toBe(false)
    captionCommands(deps()).captionLanguage()
    expect(tabs).toEqual(['captions'])
    expect(items.takeCaptionsRequest()).toEqual({ kind: 'language', via: 'ai' })
  })

  it('Find important words emphasises in one undo step, making a Classic look’s twin', () => {
    captionCommands(deps()).captionEmphasis()
    expect(store.steps).toBe(1)
    expect(store.state.captionMarks).toHaveLength(1)
    expect(store.state.captions?.studio).toBeDefined()
    expect(notices).toEqual(['Emphasised 2 words'])
  })

  it('Add pop-ups from captions opens Graphics and plans with the options as they resolve, quotes left to Make my captions great', async () => {
    captionCommands(deps()).captionGraphics()
    await flush()
    expect(tabs).toEqual(['graphics'])
    expect(p4.plans).toEqual([{ keywords: false, emoji: false, counters: true, lists: true, speakers: true, chapters: false, quotes: false, sound: 'pop' }])
    expect(store.steps).toBe(1)
    expect(notices).toEqual(['Added 1 pop-up (Undo removes it)'])
  })

  it('Tidy captions uses the saved choices and the word list, in one undo step', async () => {
    prefs.captionCleanup = { digits: 'all' }
    prefs.captionWordList = [{ term: 'Flown', heard: ['flow in'] }]
    captionCommands(deps()).captionTidy()
    await flush()
    expect(p4.tidies[0]).toMatchObject({ digits: 'all', ai: false, words: [{ term: 'Flown', heard: ['flow in'] }] })
    expect(store.steps).toBe(1)
    expect(notices).toEqual(['Tidied 12 captions, bleeped 2 words'])
  })

  it('Save caption style as mine saves the look as the next My style', async () => {
    prefs.captionPresets = [{ id: 'a1', name: 'My style 1', look: { ...(await import('../src/shared/captions/studioPresets')).studioPreset('neon')!.look } }]
    store.state = base({ ...DEFAULT_CAPTIONS, studio: (await import('../src/shared/captions/studioPresets')).studioPreset('gold')!.look })
    captionCommands(deps()).saveCaptionStyle()
    await flush()
    const [k, list] = writes.at(-1)!
    expect(k).toBe('captionPresets')
    expect((list as { name: string }[]).map((s) => s.name)).toEqual(['My style 1', 'My style 2'])
    expect(notices).toEqual(['Saved “My style 2” to your styles'])
  })
})

describe('graphics on the preview (§2.11)', () => {
  const g = (id: string, place: Graphic['place']): Graphic => ({ id, kind: 'emoji', start: 0, end: 5, place, size: 0.12, enter: { kind: 'pop', duration: 0.24, strength: 1 }, exit: { kind: 'fade', duration: 0.18, strength: 1 }, emoji: '1f525' }) as Graphic

  it('moves 1% of the frame per arrow, 10% with Shift, and nothing for other keys', () => {
    expect(arrowStep(key('ArrowLeft'))).toEqual({ dx: -0.01, dy: 0 })
    expect(arrowStep(key('ArrowDown', { shiftKey: true }))).toEqual({ dx: 0, dy: 0.1 })
    expect(arrowStep(key('ArrowUp', { ctrlKey: true }))).toBeNull()
    expect(arrowStep(key('a'))).toBeNull()
  })

  it('a focused handle moves its graphic with the keys, one undo step per press, placed by you; nothing while playing', () => {
    store.state = { ...base(), graphics: [g('e1', 'auto')] }
    handles.rects = [{ id: 'e1', rect: { x: 432, y: 864, w: 216, h: 192 } }]
    contexts.editor = { store, player: { time: 1, subscribe: () => () => undefined } }
    const selected: unknown[] = []
    const view = (paused: boolean): unknown => ({ type: GraphicHandles, props: { project: store.state, box: { w: 540, h: 960 }, out: { w: 1080, h: 1920 }, selection: null, onSelect: (s: unknown) => selected.push(s), paused } })
    let els = render(view(true))
    const handle = (): El => els.find((e) => e.props['data-graphic-handle'] === 'e1')!
    expect(handle().props.style).toEqual({ left: 216, top: 432, width: 108, height: 96 })
    expect(handle().props['aria-label']).toBe('🔥 fire: drag or use the arrow keys to move it')
    ;(handle().props.onFocus as () => void)()
    expect(selected).toEqual([{ kind: 'graphic', id: 'e1' }])
    ;(handle().props.onKeyDown as (e: unknown) => void)(key('ArrowRight'))
    expect(store.state.graphics![0].place).toEqual({ x: 0.51, y: 0.5 })
    els = render(view(true))
    ;(handle().props.onKeyDown as (e: unknown) => void)(key('ArrowUp', { shiftKey: true }))
    const place = store.state.graphics![0].place as { x: number; y: number }
    expect(place.x).toBeCloseTo(0.51)
    expect(place.y).toBeCloseTo(0.4)
    expect(store.steps).toBe(2)
    unmountAll()
    expect(render(view(false)).some((e) => e.props['data-graphic-handle'])).toBe(false)
  })

  it('the caption block: a drag places the captions; a plain click plays or pauses; Ctrl or Shift+click goes on to the preview (E-06)', async () => {
    const { studioPreset } = await import('../src/shared/captions/studioPresets')
    store.state = base({ ...DEFAULT_CAPTIONS, studio: studioPreset('subtitle')!.look })
    handles.rects = []
    handles.block = { box: { x: 100, y: 1500, w: 880, h: 200 } }
    contexts.editor = { store, player: { time: 1, subscribe: () => () => undefined } }
    let toggles = 0
    const els = render({ type: GraphicHandles, props: { project: store.state, box: { w: 540, h: 960 }, out: { w: 1080, h: 1920 }, selection: null, onSelect: () => undefined, onTogglePlay: () => toggles++, paused: true } })
    handles.block = null
    const handle = els.find((e) => e.props['data-testid'] === 'caption-block-handle')!
    expect(handle.props.style).toEqual({ left: 50, top: 750, width: 440, height: 100 })
    const press = (mods: Record<string, boolean> = {}): { prevented: boolean; stopped: boolean } => {
      const e = {
        button: 0,
        pointerId: 1,
        clientX: 300,
        clientY: 800,
        target: {},
        currentTarget: {},
        prevented: false,
        stopped: false,
        preventDefault: () => void (e.prevented = true),
        stopPropagation: () => void (e.stopped = true),
        ...mods
      }
      ;(handle.props.onPointerDown as (ev: unknown) => void)(e)
      return e
    }
    for (const mod of ['ctrlKey', 'shiftKey', 'metaKey']) {
      const e = press({ [mod]: true })
      expect({ mod, prevented: e.prevented, stopped: e.stopped, following: listeners.get('pointerup')?.size ?? 0 }).toEqual({ mod, prevented: false, stopped: false, following: 0 })
    }
    expect(press()).toMatchObject({ prevented: true, stopped: true })
    fire('pointerup', { pointerId: 1, clientX: 301, clientY: 801 })
    expect(toggles).toBe(1)
    expect(store.steps).toBe(0)
    press()
    fire('pointermove', { pointerId: 1, clientX: 300, clientY: 750 })
    fire('pointerup', { pointerId: 1, clientX: 300, clientY: 750 })
    expect(toggles).toBe(1)
    expect(store.steps).toBe(1)
    const place = store.state.captions!.studio!.layout.place as { x: number; y: number }
    expect(place.x).toBeCloseTo(0.5)
    expect(place.y).toBeCloseTo(1600 / 1920 - 50 / 0.5 / 1920)
  })

  it('the caption block lies under the selected item’s handles: before them in the overlay, with no z-index of its own', async () => {
    const { readFileSync } = await import('node:fs')
    const css = readFileSync(new URL('../src/renderer/src/editor/panels/graphics.css', import.meta.url), 'utf8').replace(/\/\*[\s\S]*?\*\//g, '')
    const rules = [...css.matchAll(/([^{}]+)\{([^}]*)\}/g)].filter((m) => m[1].split(',').some((sel) => sel.trim() === '.caption-block-handle'))
    expect(rules.length).toBeGreaterThan(0)
    for (const m of rules) expect(m[2]).not.toMatch(/z-index/)
    const stage = readFileSync(new URL('../src/renderer/src/editor/PreviewStage.tsx', import.meta.url), 'utf8')
    const at = (tag: string): number => stage.indexOf(`<${tag} `)
    for (const editor of ['AnnotationHandle', 'OverlayEditor', 'ShapeEditor', 'CropEditor']) expect(at('GraphicHandles'), editor).toBeLessThan(at(editor))
    expect(at('GraphicHandles')).toBeGreaterThan(stage.indexOf('className={[\'preview-overlay\''))
  })
})
