import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'
import type { CaptionSettings, CaptionStudio, Project } from '../src/shared/types'
import { byTestId, contexts, descendants, focused, key, mockReact, render, settle, testStore, textOf, unmountAll, useEditorContexts, type El } from './studioHarness'

/*
 * The caption style gallery (docs/design/captions-studio.md §2.4, §2.5, §2.15, test 31) without a
 * DOM. The thumbnails are part P2's drawStudioSample, a stand-in here that records the size and
 * language it was asked for and draws its text at the sample's 18 CSS px; the picks are part P1's
 * (stand-ins in studioStandIns.ts).
 */

const samples = vi.hoisted(() => ({ calls: [] as { look: { from: string }; tile: { w: number; h: number }; language?: string; t: number }[] }))
vi.mock('../src/renderer/src/render/studioLayer', () => ({
  drawStudioSample: (_ctx: unknown, look: { from: string }, _frame: unknown, tile: { w: number; h: number }, t: number, language?: string) => {
    samples.calls.push({ look, tile, t, language })
    return { textPx: look.from === 'one-word' ? 28 : 18 }
  },
  drawStudioCaptions: () => undefined,
  studioBlockAt: () => null
}))
vi.mock('../src/shared/captions/studioEdit', async () => await import('./studioStandIns'))
vi.mock('../src/shared/captions/great', async (importOriginal) => ({
  ...(await importOriginal<Record<string, unknown>>()),
  readGreatOptions: () => ({}),
  resolveGreatOptions: (_o: unknown, _p: unknown, frame: { w: number; h: number }) => ({ tall: frame.h > frame.w }),
  greatHint: (o: { tall: boolean }) => (o.tall ? 'Picks a style, emphasises key words and adds emoji and pop-ups. You can review every change.' : 'Emphasises key words, tidies the text and adds lower thirds. You can review every change.')
}))
vi.mock('../src/shared/captions/autoStyle', () => ({ suggestedTile: (_p: unknown, frame: { w: number; h: number }) => (frame.h > frame.w ? 'clean-short' : 'karaoke-fill') }))
vi.mock('../src/renderer/src/editor/panels/GreatOptions', () => ({ GreatOptionsPopover: () => ({ type: 'span', props: { 'data-testid': 'great-options-stand-in' } }) }))
const presets = vi.hoisted(() => ({ removed: [] as string[], restored: [] as unknown[] }))
vi.mock('../src/renderer/src/editor/captionPresets', async (importOriginal) => ({
  ...(await importOriginal<Record<string, unknown>>()),
  removeLook: async (id: string) => void presets.removed.push(id),
  restoreLook: async (entry: unknown, at: number) => void presets.restored.push([entry, at])
}))

const storage = new Map<string, string>()
let reduced = false
vi.stubGlobal('localStorage', { getItem: (k: string) => storage.get(k) ?? null, setItem: (k: string, v: string) => void storage.set(k, v), removeItem: (k: string) => void storage.delete(k) })
vi.stubGlobal('matchMedia', () => ({ matches: reduced, addEventListener: () => undefined, removeEventListener: () => undefined }))
vi.stubGlobal('document', {
  activeElement: null,
  body: {},
  createElement: () => ({ width: 0, height: 0, getContext: () => ({ setTransform: () => undefined }), toDataURL: () => 'data:image/png;base64,AAAA' })
})
vi.stubGlobal('window', {
  devicePixelRatio: 2,
  api: { getPref: async () => null, setPref: async () => undefined, getBrandKit: async () => ({ colors: [], fonts: [], autoApply: false }), listAssets: async () => [], onAssetProgress: () => () => undefined },
  addEventListener: () => undefined,
  removeEventListener: () => undefined
})

mockReact()
// Renderer code: imported at run time so the Node typecheck of tests/ does not follow it.
const GALLERY = '../src/renderer/src/editor/panels/CaptionGallery'
const LOOK = '../src/renderer/src/editor/panels/CaptionLookSection'
const PREVIEW = '../src/renderer/src/editor/previewLook'
const { CaptionGallery, FILTER_KEY } = (await import(/* @vite-ignore */ GALLERY)) as { CaptionGallery: (p: unknown) => unknown; FILTER_KEY: string }
const { CaptionLookSection } = (await import(/* @vite-ignore */ LOOK)) as { CaptionLookSection: (p: unknown) => unknown }
const preview = (await import(/* @vite-ignore */ PREVIEW)) as { previewLook(): { tile: string; name: string; captions: CaptionSettings } | null; previewLabel(l: unknown): string }
await useEditorContexts()
const { DEFAULT_CAPTIONS } = await import('../src/shared/captions/settings')
const { studioPreset, STUDIO_PRESETS } = await import('../src/shared/captions/studioPresets')
const { createProject } = await import('../src/shared/engine/project')

const WIDE = { w: 1920, h: 1080 }
const TALL = { w: 1080, h: 1920 }
const notices: { text: string; action?: { label: string; run: () => void } }[] = []
const picks: string[] = []
const previews: (string | null)[] = []
const mine = { id: 'abc', name: 'My style 1', look: { ...studioPreset('neon')!.look, from: 'mine:abc' } }

function gallery(extra: Partial<{ value: CaptionSettings; frame: { w: number; h: number }; saved: unknown[]; brand: CaptionStudio | null; suggested: string; language: string }> = {}): unknown {
  return {
    type: CaptionGallery,
    props: { value: { ...DEFAULT_CAPTIONS, studio: studioPreset('subtitle')!.look }, frame: WIDE, saved: [], brand: null, suggested: 'subtitle', onPick: (t: string) => picks.push(t), onPreview: (t: string | null) => previews.push(t), ...extra }
  }
}
const grid = (els: El[]): El => byTestId(els, 'caption-gallery')!
const tiles = (els: El[]): El[] => els.filter((e) => e.props.role === 'radio')
const ids = (els: El[]): string[] => tiles(els).map((t) => t.props['data-tile'] as string)

beforeEach(() => {
  unmountAll()
  storage.clear()
  reduced = false
  notices.length = 0
  picks.length = 0
  previews.length = 0
  samples.calls.length = 0
  presets.removed.length = 0
  presets.restored.length = 0
  contexts.group = { group: { keys: [], anchor: null, stamp: 0 }, keys: new Set(), single: null, select: () => undefined, notice: (text: string, opts?: { action?: { label: string; run: () => void } }) => notices.push({ text, ...opts }), command: () => undefined }
})
afterEach(() => vi.useRealTimers())

describe('filters and rows', () => {
  it('opens on the frame’s group, then remembers the last filter', async () => {
    let els = await settle(gallery({ frame: TALL }))
    expect(ids(els).every((id) => STUDIO_PRESETS.find((p) => p.id === id)?.group === 'short')).toBe(true)
    unmountAll()
    els = await settle(gallery({ frame: WIDE }))
    expect(ids(els).every((id) => STUDIO_PRESETS.find((p) => p.id === id)?.group === 'long')).toBe(true)
    const chip = (text: string): El => descendants(byTestId(els, 'caption-gallery-filter')!).find((e) => textOf(e) === text)!
    ;(chip('Classic').props.onClick as () => void)()
    expect(storage.get(FILTER_KEY)).toBe('classic')
    unmountAll()
    els = await settle(gallery({ frame: TALL }))
    expect(ids(els)[0]).toBe('legacy:clean')
  })

  it('shows Mine and Brand only when there is something in them', async () => {
    let els = await settle(gallery())
    const names = (): string[] => descendants(byTestId(els, 'caption-gallery-filter')!).filter((e) => e.type === 'button').map(textOf)
    expect(names()).toEqual(['Long videos', 'Short clips', 'Classic', 'All'])
    unmountAll()
    els = await settle(gallery({ saved: [mine], brand: studioPreset('gold')!.look }))
    expect(names()).toEqual(['Long videos', 'Short clips', 'Classic', 'Mine', 'Brand', 'All'])
  })

  it('shows two rows until Show all styles', async () => {
    let els = await settle(gallery())
    expect(tiles(els)).toHaveLength(4)
    const more = byTestId(els, 'caption-gallery-more')!
    expect(more.props['aria-expanded']).toBe(false)
    ;(more.props.onClick as () => void)()
    els = await settle(gallery())
    expect(tiles(els).length).toBe(STUDIO_PRESETS.filter((p) => p.group === 'long').length)
    expect(byTestId(els, 'caption-gallery-more')!.props['aria-expanded']).toBe(true)
  })

  it('keeps Classic looks out of All unless the project uses one, then first, as your current style', async () => {
    storage.set(FILTER_KEY, 'all')
    let els = await settle(gallery())
    ;(byTestId(els, 'caption-gallery-more')!.props.onClick as () => void)()
    els = await settle(gallery())
    expect(ids(els).some((id) => id.startsWith('legacy:'))).toBe(false)
    unmountAll()
    els = await settle(gallery({ value: { ...DEFAULT_CAPTIONS, preset: 'boxed' } }))
    expect(ids(els)[0]).toBe('legacy:boxed')
    expect(tiles(els)[0].props['aria-checked']).toBe(true)
    expect(textOf(tiles(els)[0])).toContain('Boxed · Your current style')
    expect(ids(els).filter((id) => id.startsWith('legacy:'))).toEqual(['legacy:boxed'])
  })

  it('names each tile with its group and description, and checks the project’s look', async () => {
    storage.set(FILTER_KEY, 'short')
    const els = await settle(gallery({ value: { ...DEFAULT_CAPTIONS, studio: { ...studioPreset('bold-pop')!.look, from: 'bold-pop' } } }))
    const bold = tiles(els).find((t) => t.props['data-tile'] === 'bold-pop')!
    expect(bold.props['aria-label']).toBe(`Bold Pop, short clips: ${studioPreset('bold-pop')!.description.charAt(0).toLowerCase()}${studioPreset('bold-pop')!.description.slice(1)}`)
    expect(bold.props['aria-checked']).toBe(true)
    expect(grid(els).props.role).toBe('radiogroup')
    expect(grid(els).props['aria-label']).toBe('Caption style')
  })
})

describe('the keyboard (§2.15)', () => {
  it('is one tab stop; arrows move by one and by a row, Home and End; Enter and Space pick', async () => {
    storage.set(FILTER_KEY, 'long')
    let els = await settle(gallery())
    const stops = (): string[] => tiles(els).filter((t) => t.props.tabIndex === 0).map((t) => t.props['data-tile'] as string)
    expect(stops()).toEqual(['subtitle'])
    const press = async (k: string): Promise<void> => {
      ;(grid(els).props.onKeyDown as (e: unknown) => void)(key(k))
      els = await settle(gallery())
    }
    await press('ArrowRight')
    expect(stops()).toEqual([ids(els)[1]])
    expect(focused.at(-1)?.props['data-tile']).toBe(ids(els)[1])
    await press('ArrowDown')
    expect(stops()).toEqual([ids(els)[3]])
    await press('Home')
    expect(stops()).toEqual([ids(els)[0]])
    await press('End')
    expect(stops()).toEqual([ids(els)[3]])
    await press('ArrowUp')
    expect(stops()).toEqual([ids(els)[1]])
    await press('Enter')
    expect(picks).toEqual([ids(els)[1]])
    await press(' ')
    expect(picks).toHaveLength(2)
  })
})

describe('thumbnails', () => {
  it('draws every tile with the real sample at 18 CSS px or more, the size of a tile at the default Inspector width', async () => {
    storage.set(FILTER_KEY, 'short')
    let els = await settle(gallery({ frame: TALL }))
    ;(byTestId(els, 'caption-gallery-more')!.props.onClick as () => void)()
    els = await settle(gallery({ frame: TALL }))
    const thumbs = els.filter((e) => e.props.className === 'tile-thumb')
    expect(thumbs.length).toBe(STUDIO_PRESETS.filter((p) => p.group === 'short').length)
    for (const th of thumbs) expect(th.props['data-text-px']).toBeGreaterThanOrEqual(18)
    expect(new Set(samples.calls.map((c) => `${c.tile.w}x${c.tile.h}`))).toEqual(new Set(['136x96']))
  })

  it('draws Bangla sample text when the captions are Bangla', async () => {
    await settle(gallery({ language: 'bn' }))
    expect(samples.calls.length).toBeGreaterThan(0)
    expect(samples.calls.every((c) => c.language === 'bn')).toBe(true)
  })

  it('plays the focused tile’s look, never under reduced motion', async () => {
    // The picture of the second tile: its thumbnail's content.
    const picture = (els: El[]): unknown => (els.filter((e) => e.props.className === 'tile-thumb')[1].props.children as El | null)?.type
    let els = await settle(gallery())
    expect(picture(els)).toBe('img')
    ;(tiles(els)[1].props.onFocus as () => void)()
    els = await settle(gallery())
    expect(picture(els)).toBe('canvas')
    unmountAll()
    reduced = true
    els = await settle(gallery())
    ;(tiles(els)[1].props.onFocus as () => void)()
    els = await settle(gallery())
    expect(picture(els)).toBe('img')
  })

  it('marks the suggested tile, with why: Karaoke Fill in a wide camera-led project', async () => {
    const els = await settle(gallery({ suggested: 'karaoke-fill' }))
    const karaoke = tiles(els).find((t) => t.props['data-tile'] === 'karaoke-fill')!
    const why = els.find((e) => e.props.id === karaoke.props['aria-describedby'])!
    expect(textOf(why)).toBe('Suggested when you are on camera')
    expect(descendants(karaoke).some((e) => e.props.className === 'tile-badge' && textOf(e) === 'Suggested')).toBe(true)
  })
})

describe('Play and Delete beside the grid', () => {
  it('are outside the radio group and name the tile they act on', async () => {
    storage.set(FILTER_KEY, 'mine')
    let els = await settle(gallery({ saved: [mine, { ...mine, id: 'def', name: 'Launch' }] }))
    const inGrid = new Set(descendants(grid(els)))
    const play = byTestId(els, 'caption-tile-play')!
    const del = byTestId(els, 'caption-tile-delete')!
    expect(inGrid.has(play)).toBe(false)
    expect(inGrid.has(del)).toBe(false)
    expect(play.props['aria-label']).toBe('Play a preview of My style 1')
    // Nothing checked or focused among the saved tiles: Delete waits for one.
    expect(del.props.disabled).toBe(true)
    ;(tiles(els)[1].props.onFocus as () => void)()
    els = await settle(gallery({ saved: [mine, { ...mine, id: 'def', name: 'Launch' }] }))
    expect(textOf(byTestId(els, 'caption-tile-delete')!)).toBe('Delete “Launch”')
  })

  it('deletes the checked saved tile first, with Undo in the notice', async () => {
    storage.set(FILTER_KEY, 'mine')
    const value = { ...DEFAULT_CAPTIONS, studio: mine.look }
    let els = await settle(gallery({ value, saved: [mine, { ...mine, id: 'def', name: 'Launch' }] }))
    ;(tiles(els)[1].props.onFocus as () => void)()
    els = await settle(gallery({ value, saved: [mine, { ...mine, id: 'def', name: 'Launch' }] }))
    const del = byTestId(els, 'caption-tile-delete')!
    expect(textOf(del)).toBe('Delete “My style 1”')
    ;(del.props.onClick as () => void)()
    await settle(gallery({ value, saved: [mine] }))
    expect(presets.removed).toEqual(['abc'])
    expect(notices[0].text).toBe('Deleted “My style 1”')
    notices[0].action!.run()
    expect(presets.restored).toEqual([[mine, 0]])
  })
})

describe('in the Look section', () => {
  const project = (captions?: CaptionSettings): Project => ({
    ...createProject({ id: 'p', name: 'p', duration: 10, width: 1920, height: 1080, hasWebcam: false, hasAudio: true, webcamOffset: 0, zooms: [], cursorValid: true, capture: { method: 'native', cursorInVideo: false, region: null } }),
    transcript: { language: 'en', segments: [{ id: 'c1', start: 0, end: 2, text: 'Make every word count today' }] } as Project['transcript'],
    ...(captions ? { captions } : {})
  })
  let store: ReturnType<typeof testStore<Project>>
  const look = (): unknown => ({ type: CaptionLookSection, props: { project: store.state, vw: 1920, vh: 1080, onGreat: () => undefined, greatBusy: false, onGreatCancel: () => undefined } })
  const SKIP = ['TextControls', 'ColourControls', 'LayoutControls', 'MotionControls', 'EmphasisControls', 'SpeakerControls', 'FontPicker', 'ShowSpeakerToggle']
  beforeEach(() => {
    store = testStore(project())
    contexts.editor = { store, player: { time: 0, subscribe: () => () => undefined } }
  })

  it('picks a tile in one undo step, its look picked, and says so', async () => {
    const els = await settle(look(), SKIP)
    const karaoke = tiles(els).find((t) => t.props['data-tile'] === 'karaoke-fill')!
    ;(karaoke.props.onClick as () => void)()
    expect(store.steps).toBe(1)
    expect(store.state.captions).toMatchObject({ preset: 'karaoke', picked: true, studio: { from: 'karaoke-fill' } })
    expect(notices.map((n) => n.text)).toEqual(['Caption style: Karaoke Fill'])
  })

  it('previews a tile hovered for 300 ms on the video, and leaving it or picking stops; the project does not change', async () => {
    vi.useFakeTimers()
    let els = render(look(), SKIP)
    const tile = (): El => tiles(els).find((t) => t.props['data-tile'] === 'karaoke-fill')!
    ;(tile().props.onPointerEnter as () => void)()
    vi.advanceTimersByTime(299)
    expect(preview.previewLook()).toBeNull()
    vi.advanceTimersByTime(1)
    expect(preview.previewLook()).toMatchObject({ tile: 'karaoke-fill', name: 'Karaoke Fill', captions: { studio: { from: 'karaoke-fill' } } })
    expect(preview.previewLabel(preview.previewLook())).toBe('Previewing Karaoke Fill · Enter uses it')
    els = render(look(), SKIP)
    ;(tile().props.onPointerLeave as () => void)()
    expect(preview.previewLook()).toBeNull()
    expect(store.steps).toBe(0)
    expect(store.state.captions).toBeUndefined()
  })

  it('Escape in the grid ends the preview', async () => {
    vi.useFakeTimers()
    const els = render(look(), SKIP)
    ;(tiles(els)[1].props.onFocus as () => void)()
    vi.advanceTimersByTime(300)
    expect(preview.previewLook()).not.toBeNull()
    ;(grid(els).props.onKeyDown as (e: unknown) => void)(key('Escape'))
    expect(preview.previewLook()).toBeNull()
  })

  it('names the look, "(edited)" with Reset when it differs from its tile', async () => {
    store.state = project({ ...DEFAULT_CAPTIONS, studio: { ...studioPreset('bold-pop')!.look, from: 'bold-pop', text: { ...studioPreset('bold-pop')!.look.text, size: 0.2 } }, picked: true })
    const els = await settle(look(), SKIP)
    expect(textOf(byTestId(els, 'caption-style-name')!)).toBe('Bold Pop (edited)')
    const reset = byTestId(els, 'caption-style-reset')!
    expect(reset.props.title).toBe('Go back to Bold Pop as it comes')
    ;(reset.props.onClick as () => void)()
    expect(store.state.captions?.studio?.text.size).toBe(studioPreset('bold-pop')!.look.text.size)
  })
})
