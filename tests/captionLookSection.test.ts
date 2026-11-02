import { beforeEach, describe, expect, it, vi } from 'vitest'
import type { CaptionMark, CaptionSettings, CaptionTrack, Project } from '../src/shared/types'
import { byTestId, contexts, descendants, focused, key, mockReact, settle, testStore, textOf, unmountAll, useEditorContexts, type El } from './studioHarness'

/*
 * Captions › Look's controls (docs/design/captions-studio.md §2.4, §2.6, §2.7, §7.3, test 32)
 * without a DOM: each writes its field with its merge key and sets `picked` (Show captions does
 * not), the first change on a Classic look makes its twin in the same undo step, and the hint
 * under Make my captions great follows the options as they resolve. Parts P1, P2 and P4 are
 * stand-ins (studioStandIns.ts and below).
 */

const p4 = vi.hoisted(() => ({ marks: [] as unknown[] }))
vi.mock('../src/shared/captions/studioEdit', async () => await import('./studioStandIns'))
vi.mock('../src/shared/captions/colors', async () => await import('./studioStandIns'))
vi.mock('../src/shared/captions/marks', () => ({ clearEmphasis: (p: Project) => ({ ...p, captionMarks: undefined }) }))
vi.mock('../src/shared/captions/emphasis', () => ({ pickEmphasis: () => p4.marks }))
vi.mock('../src/shared/captions/great', async (importOriginal) => ({
  ...(await importOriginal<Record<string, unknown>>()),
  readGreatOptions: (raw: unknown) => ({ emoji: (raw as { emoji?: string } | null)?.emoji ?? 'auto' }),
  resolveGreatOptions: (o: { emoji?: string }, _p: unknown, frame: { w: number; h: number }) => ({ emoji: o.emoji === 'on' ? true : o.emoji === 'off' ? false : frame.h > frame.w }),
  greatHint: (o: { emoji: boolean }) => (o.emoji ? 'Picks a style, emphasises key words and adds emoji and pop-ups. You can review every change.' : 'Emphasises key words, tidies the text and adds lower thirds. You can review every change.')
}))
vi.mock('../src/shared/captions/autoStyle', () => ({ suggestedTile: () => 'subtitle' }))
vi.mock('../src/renderer/src/editor/panels/GreatOptions', () => ({ GreatOptionsPopover: () => ({ type: 'button', props: { 'data-testid': 'captions-great-options' } }) }))
vi.mock('../src/renderer/src/render/studioLayer', () => ({ drawStudioSample: () => ({ textPx: 18 }) }))
// Whether the last input was a key (focus.ts keeps it from the window's events, which these tests have not).
const keys = vi.hoisted(() => ({ last: false }))
vi.mock('../src/renderer/src/editor/focus', async (importOriginal) => ({ ...(await importOriginal<Record<string, unknown>>()), lastInputWasKey: () => keys.last }))
const probe = vi.hoisted(() => ({ asked: [] as number[] }))
vi.mock('../src/renderer/src/render/contrastProbe', () => ({
  probeContrast: async (_p: unknown, t: number) => {
    probe.asked.push(t)
    return { ratio: 3.14, at: t }
  }
}))

vi.stubGlobal('localStorage', { getItem: () => null, setItem: () => undefined })
vi.stubGlobal('matchMedia', () => ({ matches: false, addEventListener: () => undefined, removeEventListener: () => undefined }))
vi.stubGlobal('document', { activeElement: null, body: {}, createElement: () => ({ getContext: () => null, toDataURL: () => '' }) })
vi.stubGlobal('window', {
  devicePixelRatio: 1,
  api: { getPref: async () => null, setPref: async () => undefined, getBrandKit: async () => ({ colors: [], fonts: [], autoApply: false }), listAssets: async () => [], onAssetProgress: () => () => undefined },
  addEventListener: () => undefined,
  removeEventListener: () => undefined
})

mockReact()
// Renderer code: imported at run time so the Node typecheck of tests/ does not follow it.
const CONTROLS = '../src/renderer/src/editor/panels/StudioControls'
const LOOK = '../src/renderer/src/editor/panels/CaptionLookSection'
const GREAT_RUN = '../src/renderer/src/editor/greatRun'
const c = (await import(/* @vite-ignore */ CONTROLS)) as Record<string, (p: unknown) => unknown>
const { CaptionLookSection } = (await import(/* @vite-ignore */ LOOK)) as { CaptionLookSection: (p: unknown) => unknown }
await useEditorContexts()
const { DEFAULT_CAPTIONS } = await import('../src/shared/captions/settings')
const { studioPreset, SHADOW_CHIPS, LINE_LENGTHS, THEMES } = await import('../src/shared/captions/studioPresets')
const { createProject } = await import('../src/shared/engine/project')

const notices: string[] = []
let store: ReturnType<typeof testStore<Project>>
const player = { time: 4.2, subscribe: () => () => undefined, getPlaying: () => false }
const project = (captions?: CaptionSettings, extra: Partial<Project> = {}, size = { width: 1920, height: 1080 }): Project => ({
  ...createProject({ id: 'p', name: 'p', duration: 10, ...size, hasWebcam: false, hasAudio: true, webcamOffset: 0, zooms: [], cursorValid: true, capture: { method: 'native', cursorInVideo: false, region: null } }),
  transcript: { language: 'en', segments: [{ id: 'c1', start: 0, end: 2, text: 'Make every word count today' }] } as Project['transcript'],
  ...(captions ? { captions } : {}),
  ...extra
})
const boldPop = (): CaptionSettings => ({ ...DEFAULT_CAPTIONS, preset: 'bold', studio: { ...studioPreset('bold-pop')!.look, from: 'bold-pop' } })
const SKIP = ['FontPicker']
const view = (name: string): unknown => ({ type: c[name], props: { project: store.state } })
/** The control with test id `id`, or the first input rendered inside the element that has it (a Toggle). */
const input = (els: El[], id: string): El => {
  const el = byTestId(els, id)!
  return el.type === 'input' || el.type === 'select' ? el : els.slice(els.indexOf(el)).find((e) => e.type === 'input')!
}
/** A button with `text` rendered inside (after) the element with test id `id`. */
const chipIn = (els: El[], id: string, text: string): El => {
  const el = byTestId(els, id)!
  return [...descendants(el), ...els.slice(els.indexOf(el))].find((e) => e.type === 'button' && textOf(e) === text)!
}

beforeEach(() => {
  unmountAll()
  keys.last = false
  notices.length = 0
  probe.asked.length = 0
  p4.marks = []
  store = testStore(project(boldPop()))
  contexts.editor = { store, player }
  contexts.group = { group: { keys: [], anchor: null, stamp: 0 }, keys: new Set(), single: null, select: () => undefined, notice: (m: string) => notices.push(m), command: () => undefined }
})

describe('each control writes its field with its merge key and sets picked', () => {
  it('Size shows and sets the size drawn, as one undo step per gesture', async () => {
    const els = await settle(view('TextControls'), SKIP)
    const size = input(els, 'caption-size')
    expect(size.props.value).toBeCloseTo(studioPreset('bold-pop')!.look.text.size)
    expect(size.props['aria-valuetext']).toMatch(/percent of the shorter side$/)
    ;(size.props.onChange as (e: unknown) => void)({ target: { value: '0.1' } })
    ;(size.props.onChange as (e: unknown) => void)({ target: { value: '0.11' } })
    expect(store.updates.map((u) => u.key)).toEqual(['caption-size', 'caption-size'])
    expect(store.steps).toBe(1)
    expect(store.state.captions).toMatchObject({ picked: true, studio: { text: { size: 0.11 } } })
  })

  it('in a tall frame Size shows size × tall', async () => {
    store.state = project(boldPop(), {}, { width: 1080, height: 1920 })
    const els = await settle(view('TextControls'), SKIP)
    const look = studioPreset('bold-pop')!.look
    expect(input(els, 'caption-size').props.value).toBeCloseTo(look.text.size * look.text.tall)
  })

  it('letter spacing, strength and speed have their keys', async () => {
    let els = await settle(view('TextControls'), SKIP)
    ;(input(els, 'caption-tracking').props.onChange as (e: unknown) => void)({ target: { value: '0.02' } })
    unmountAll()
    els = await settle(view('MotionControls'), SKIP)
    ;(input(els, 'caption-strength').props.onChange as (e: unknown) => void)({ target: { value: '0.5' } })
    ;(input(els, 'caption-speed').props.onChange as (e: unknown) => void)({ target: { value: '1.5' } })
    expect(store.updates.map((u) => u.key)).toEqual(['caption-tracking', 'caption-strength', 'caption-speed'])
    expect(store.state.captions?.studio?.motion).toMatchObject({ strength: 0.5, speed: 1.5 })
  })

  it('a colour dot is one step; the picker’s stream merges', async () => {
    const els = await settle(view('ColourControls'), SKIP)
    ;(chipLike(els, 'caption-color-spoken', 'Spoken word #22d3ee').props.onClick as () => void)()
    const picker = descendants(byTestId(els, 'caption-color-text')!).find((e) => e.type === 'input')!
    ;(picker.props.onChange as (e: unknown) => void)({ target: { value: '#ABCDEF' } })
    expect(store.updates.map((u) => u.key)).toEqual([undefined, 'caption-color-text'])
    expect(store.state.captions?.studio?.theme).toMatchObject({ spoken: '#22d3ee', text: '#abcdef' })
  })

  it('Shadow chips write the chip’s shadow, Off one of α 0 (so Bangla gets no soft one, §0.2)', async () => {
    let els = await settle(view('ColourControls'), SKIP)
    ;(chipIn(els, 'caption-shadow', 'Hard').props.onClick as () => void)()
    expect(store.state.captions?.studio?.edge.shadow).toEqual(SHADOW_CHIPS.hard)
    els = await settle(view('ColourControls'), SKIP)
    expect(chipIn(els, 'caption-shadow', 'Hard').props['aria-pressed']).toBe(true)
    ;(chipIn(els, 'caption-shadow', 'Off').props.onClick as () => void)()
    expect(store.state.captions?.studio?.edge.shadow).toEqual({ x: 0, y: 0, blur: 0, alpha: 0 })
    els = await settle(view('ColourControls'), SKIP)
    expect(chipIn(els, 'caption-shadow', 'Off').props['aria-pressed']).toBe(true)
    expect(store.steps).toBe(2)
  })

  it('a theme is one undo step', async () => {
    const els = await settle(view('ColourControls'), SKIP)
    const cyan = descendants(byTestId(els, 'caption-theme')!).find((e) => e.type === 'button' && textOf(e).endsWith('Cyan'))!
    ;(cyan.props.onClick as () => void)()
    expect(store.steps).toBe(1)
    expect(store.state.captions?.studio?.theme.spoken).toBe(THEMES.find((t) => t.id === 'cyan')!.theme.spoken)
  })

  it('Line length chips write the characters, and none is selected for other values', async () => {
    store.state = project({ ...DEFAULT_CAPTIONS, studio: { ...studioPreset('subtitle')!.look, from: 'subtitle' } })
    let els = await settle(view('LayoutControls'), SKIP)
    expect(chipIn(els, 'caption-line-length', 'Long').props['aria-pressed']).toBe(true)
    ;(chipIn(els, 'caption-line-length', 'Short').props.onClick as () => void)()
    expect(store.state.captions?.studio?.layout).toMatchObject(LINE_LENGTHS.short)
    store.state = { ...store.state, captions: { ...store.state.captions!, studio: { ...store.state.captions!.studio!, layout: { ...store.state.captions!.studio!.layout, chars: 30 } } } }
    els = await settle(view('LayoutControls'), SKIP)
    expect(descendants(byTestId(els, 'caption-line-length')!).filter((e) => e.props['aria-pressed'] === true)).toHaveLength(0)
  })

  it('Position takes the Studio anchors and drops a drag; Reset position drops it alone', async () => {
    store.state = project({ ...DEFAULT_CAPTIONS, studio: { ...studioPreset('subtitle')!.look, layout: { ...studioPreset('subtitle')!.look.layout, place: { x: 0.5, y: 0.2 } } } })
    let els = await settle(view('LayoutControls'), SKIP)
    expect(descendants(byTestId(els, 'caption-position')!).filter((e) => e.props['aria-pressed'] === true)).toHaveLength(0)
    ;(byTestId(els, 'caption-position-reset')!.props.onClick as () => void)()
    expect(store.state.captions?.studio?.layout).not.toHaveProperty('place')
    els = await settle(view('LayoutControls'), SKIP)
    ;(chipIn(els, 'caption-position', 'Upper').props.onClick as () => void)()
    expect(store.state.captions?.studio?.layout.position).toBe('upper')
  })
})

describe('Show captions and Classic looks', () => {
  const look = (): unknown => ({ type: CaptionLookSection, props: { project: store.state, vw: 1920, vh: 1080, onGreat: () => undefined, greatBusy: false, onGreatCancel: () => undefined } })
  const SECTION_SKIP = ['TextControls', 'ColourControls', 'LayoutControls', 'MotionControls', 'EmphasisControls', 'SpeakerControls', 'FontPicker', 'ShowSpeakerToggle', 'CaptionGallery']

  it('Show captions does not set picked', async () => {
    store.state = project()
    const els = await settle(look(), SECTION_SKIP)
    ;(input(els, 'captions-show').props.onChange as (e: unknown) => void)({ target: { checked: false } })
    expect(store.state.captions).toEqual({ ...DEFAULT_CAPTIONS, show: false })
  })

  it('a Classic look shows today’s controls first, which write today’s fields and set picked', async () => {
    store.state = project({ ...DEFAULT_CAPTIONS, preset: 'boxed' })
    const els = await settle(look(), SECTION_SKIP)
    expect(els.some((e) => e.type === 'p' && textOf(e) === 'Changing these makes your own version of Boxed. It looks the same.')).toBe(true)
    const classic = els.find((e) => e.props.className === 'caption-classic')!
    const top = els.slice(els.indexOf(classic)).find((e) => e.type === 'button' && textOf(e) === 'Top')!
    ;(top.props.onClick as () => void)()
    expect(store.state.captions).toMatchObject({ preset: 'boxed', position: 'top', picked: true })
    expect(store.state.captions).not.toHaveProperty('studio')
  })

  it('the first Studio change on a Classic look makes its twin in the same undo step', async () => {
    store.state = project({ ...DEFAULT_CAPTIONS })
    const els = await settle(view('TextControls'), SKIP)
    ;(chipIn(els, 'caption-case', 'CAPITALS').props.onClick as () => void)()
    expect(store.steps).toBe(1)
    expect(store.state.captions).toMatchObject({ preset: 'clean', picked: true, studio: { from: 'clean', text: { case: 'upper' }, layout: { legacyAnchor: true } } })
  })

  it('the hint under Make my captions great follows the options as they resolve', async () => {
    store.state = project()
    let els = await settle(look(), SECTION_SKIP)
    expect(textOf(byTestId(els, 'captions-great-hint')!)).toBe('Emphasises key words, tidies the text and adds lower thirds. You can review every change.')
    unmountAll()
    store.state = project(undefined, {}, { width: 1080, height: 1920 })
    els = await settle({ type: CaptionLookSection, props: { project: store.state, vw: 1080, vh: 1920, onGreat: () => undefined, greatBusy: false, onGreatCancel: () => undefined } }, SECTION_SKIP)
    expect(textOf(byTestId(els, 'captions-great-hint')!)).toBe('Picks a style, emphasises key words and adds emoji and pop-ups. You can review every change.')
  })

  it('the hint changes as soon as the options are saved (the options store, not a later focus)', async () => {
    const { saveGreatOptions } = (await import(/* @vite-ignore */ GREAT_RUN)) as { saveGreatOptions: (o: unknown) => Promise<void> }
    store.state = project()
    try {
      await saveGreatOptions({ emoji: 'on' })
      const els = await settle(look(), SECTION_SKIP)
      expect(textOf(byTestId(els, 'captions-great-hint')!)).toBe('Picks a style, emphasises key words and adds emoji and pop-ups. You can review every change.')
    } finally {
      await saveGreatOptions({ emoji: 'auto' })
    }
  })

  it('Make my captions great reads Working… with Cancel while it runs', async () => {
    const run: string[] = []
    const els = await settle({ type: CaptionLookSection, props: { project: store.state, vw: 1920, vh: 1080, onGreat: () => run.push('great'), greatBusy: true, onGreatCancel: () => run.push('cancel') } }, SECTION_SKIP)
    expect(textOf(byTestId(els, 'captions-great')!)).toContain('Working…')
    ;(els.find((e) => e.type === 'button' && textOf(e) === 'Cancel')!.props.onClick as () => void)()
    expect(run).toEqual(['cancel'])
    expect(byTestId(els, 'captions-great-options')).toBeDefined()
  })
})

describe('Speakers', () => {
  const speakers = (show: boolean, colours = false): Project =>
    project(
      { ...boldPop(), ...(show ? { showSpeaker: true as const } : {}), studio: { ...boldPop().studio!, ...(colours ? { speakerColors: true as const } : {}) } },
      { transcript: { language: 'en', segments: [{ id: 'c1', start: 0, end: 2, text: 'Hi', speaker: 'Priya' }, { id: 'c2', start: 2, end: 4, text: 'Hello', speaker: 'Sam' }] } as Project['transcript'] }
    )

  it('a colour for each speaker is off while names are off, with the note', async () => {
    store.state = speakers(false)
    const els = await settle(view('SpeakerControls'), SKIP)
    expect(input(els, 'caption-speaker-colors').props.disabled).toBe(true)
    expect(els.some((e) => textOf(e) === 'Turn on speaker names first, so colour is never the only cue.')).toBe(true)
  })

  it('on a look where speaker colours would be hard to read, says so and shows no dots', async () => {
    const chat = speakers(true, true)
    store.state = { ...chat, captions: { ...chat.captions!, studio: { ...studioPreset('chat')!.look, from: 'chat', speakerColors: true } } }
    const els = await settle(view('SpeakerControls'), SKIP)
    expect(els.filter((e) => e.props.className === 'speaker-dot')).toHaveLength(0)
    expect(els.some((e) => textOf(e) === 'Speaker colours would be hard to read on this look, so it keeps its own text colour.')).toBe(true)
  })

  it('turning names off also turns colours off, in one undo step, without picked', async () => {
    store.state = speakers(true, true)
    const els = await settle(view('SpeakerControls'), SKIP)
    expect(els.filter((e) => e.props.className === 'speaker-dot')).toHaveLength(2)
    const names = descendants(els[0]).find((e) => e.type === 'input') ?? els.find((e) => e.type === 'input' && e.props['aria-label'] === 'Show speaker names')!
    ;(names.props.onChange as (e: unknown) => void)({ target: { checked: false } })
    expect(store.steps).toBe(1)
    expect(store.state.captions).not.toHaveProperty('showSpeaker')
    expect(store.state.captions?.studio).not.toHaveProperty('speakerColors')
  })
})

describe('Emphasis', () => {
  const marks: CaptionMark[] = [
    { id: 'm1', caption: 'c1', from: 1, to: 2, text: 'every word', auto: true },
    { id: 'm2', caption: 'c1', from: 4, to: 4, text: 'today', auto: true }
  ]

  it('Find important words adds the offline picks, making a Classic look’s twin without picked', async () => {
    store.state = project({ ...DEFAULT_CAPTIONS })
    p4.marks = marks
    const els = await settle(view('EmphasisControls'), SKIP)
    ;(byTestId(els, 'caption-emphasis-find')!.props.onClick as () => void)()
    expect(store.steps).toBe(1)
    expect(store.state.captionMarks).toEqual(marks)
    expect(store.state.captions?.studio?.from).toBe('clean')
    expect(store.state.captions).not.toHaveProperty('picked')
    expect(notices).toEqual(['Emphasised 3 words'])
  })

  it('says when no words stood out, and clears with Undo’s promise', async () => {
    let els = await settle(view('EmphasisControls'), SKIP)
    ;(byTestId(els, 'caption-emphasis-find')!.props.onClick as () => void)()
    expect(notices).toEqual(['No words stood out'])
    expect(store.steps).toBe(0)
    store.state = { ...store.state, captionMarks: marks }
    els = await settle(view('EmphasisControls'), SKIP)
    expect(textOf(byTestId(els, 'caption-emphasis-count')!)).toBe('3 words emphasised')
    ;(byTestId(els, 'caption-emphasis-clear')!.props.onClick as () => void)()
    expect(store.state.captionMarks).toBeUndefined()
    expect(notices.at(-1)).toBe('Removed emphasis from 3 words (Undo brings it back)')
  })

  it('the emphasis size has its key', async () => {
    const els = await settle(view('EmphasisControls'), SKIP)
    ;(input(els, 'caption-emphasis-size').props.onChange as (e: unknown) => void)({ target: { value: '1.3' } })
    expect(store.updates.map((u) => u.key)).toEqual(['caption-emphasis-size'])
    expect(store.state.captions?.studio?.emphasis.scale).toBe(1.3)
  })
})

describe('the contrast meter (§7.3)', () => {
  it('shows the static figure with a dependable outline', async () => {
    const els = await settle(view('ColourControls'), SKIP)
    const meter = byTestId(els, 'caption-contrast')!
    expect(meter.props['aria-label']).toBe('Contrast 13.6 to 1, easy to read')
    expect(textOf(meter)).toBe('Contrast 13.6 : 1 · Easy to read')
    expect(byTestId(els, 'caption-contrast-fix')).toBeUndefined()
    expect(probe.asked).toEqual([])
  })

  it('measures the video at the playhead while paused without one, and Fix is one undo step', async () => {
    const look = boldPop()
    store.state = project({ ...look, studio: { ...look.studio!, edge: { ...look.studio!.edge, outline: 0.02 }, box: { ...look.studio!.box, kind: 'none' } } })
    const els = await settle(view('ColourControls'), SKIP)
    expect(probe.asked).toEqual([4.2])
    const meter = byTestId(els, 'caption-contrast')!
    expect(textOf(meter)).toBe('Contrast 3.1 : 1 at 0:04 · Hard to read for some peopleFix')
    expect(meter.props['aria-label']).toBe('Contrast 3.1 to 1, hard to read for some people at 0:04')
    ;(byTestId(els, 'caption-contrast-fix')!.props.onClick as () => void)()
    expect(store.steps).toBe(1)
    expect(store.state.captions?.studio?.edge).toMatchObject({ outline: 0.06, outlineAlpha: 1 })
  })
})

describe('Digits (§0.2)', () => {
  it('offers Bangla or Western digits for Bangla captions, and writes digits', async () => {
    store.state = project(boldPop(), { transcript: { language: 'bn', segments: [{ id: 'c1', start: 0, end: 2, text: 'এখন এক্সপোর্ট চাপুন' }] } as Project['transcript'] })
    const els = await settle(view('TextControls'), SKIP)
    expect(byTestId(els, 'caption-case')).toBeUndefined()
    ;(chipIn(els, 'caption-digits', 'Bangla ০–৯').props.onClick as () => void)()
    expect(store.state.captions).toMatchObject({ digits: 'native', picked: true })
  })

  it('on a Classic look the choice makes its Studio twin in the same undo step (legacy drawing never shows it)', async () => {
    store.state = project({ ...DEFAULT_CAPTIONS, preset: 'boxed' }, { transcript: { language: 'bn', segments: [{ id: 'c1', start: 0, end: 2, text: 'এখন ৩টি ধাপ' }] } as Project['transcript'] })
    const els = await settle(view('TextControls'), SKIP)
    ;(chipIn(els, 'caption-digits', 'Bangla ০–৯').props.onClick as () => void)()
    expect(store.steps).toBe(1)
    expect(store.state.captions).toMatchObject({ preset: 'boxed', digits: 'native', picked: true, studio: { from: 'boxed', layout: { legacyAnchor: true } } })
  })

  it('is not offered for English', async () => {
    const els = await settle(view('TextControls'), SKIP)
    expect(byTestId(els, 'caption-digits')).toBeUndefined()
  })

  it('follows the caption track shown on the video, as the drawing does', async () => {
    const bnTrack: CaptionTrack = { language: 'bn', by: 'openai', model: 'gpt-4.1-mini', createdAt: '2026-11-01T00:00:00Z', segments: [{ id: 'c1', text: 'প্রতিটি শব্দ গুরুত্বপূর্ণ', src: 'x' }] }
    // English speech with its Bangla translation burned in: Bangla digits can be chosen, Case has nothing to change.
    store.state = project({ ...boldPop(), track: 'bn' }, { captionTracks: [bnTrack] })
    let els = await settle(view('TextControls'), SKIP)
    expect(byTestId(els, 'caption-case')).toBeUndefined()
    ;(chipIn(els, 'caption-digits', 'Bangla ০–৯').props.onClick as () => void)()
    expect(store.state.captions).toMatchObject({ digits: 'native', track: 'bn' })
    // Bangla speech with its English translation burned in: no Bangla digits to offer.
    const enTrack: CaptionTrack = { ...bnTrack, language: 'en', segments: [{ id: 'c1', text: 'Every word counts', src: 'x' }] }
    store.state = project({ ...boldPop(), track: 'en' }, { transcript: { language: 'bn', segments: [{ id: 'c1', start: 0, end: 2, text: 'এখন এক্সপোর্ট চাপুন' }] } as Project['transcript'], captionTracks: [enTrack] })
    els = await settle(view('TextControls'), SKIP)
    expect(byTestId(els, 'caption-digits')).toBeUndefined()
    expect(byTestId(els, 'caption-case')).toBeDefined()
  })

  it('is offered for Bangla captions whose transcript names no language', async () => {
    store.state = project(boldPop(), { transcript: { segments: [{ id: 'c1', start: 0, end: 2, text: 'এখন ৩টি ধাপ' }] } as Project['transcript'] })
    const els = await settle(view('TextControls'), SKIP)
    expect(chipIn(els, 'caption-digits', 'Bangla ০–৯')).toBeDefined()
  })
})

describe('the Font menus’ note (§2.6)', () => {
  /** The language each Font menu gives its note: Text, then Emphasis. */
  const noteLanguages = async (): Promise<unknown[]> => [
    byFontMenu(await settle(view('TextControls'), SKIP), 'caption-font'),
    byFontMenu(await settle(view('EmphasisControls'), SKIP), 'caption-emphasis-font')
  ]
  const byFontMenu = (els: El[], id: string): unknown => els.find((e) => e.props.testId === id)!.props.language
  const ruTrack: CaptionTrack = { language: 'ru', by: 'openai', model: 'gpt-4.1-mini', createdAt: '2026-11-01T00:00:00Z', segments: [{ id: 'c1', text: 'Каждое слово важно', src: 'x' }] }

  it('follows the caption track shown on the video, as the drawing does', async () => {
    // English speech with its Russian translation burned in: the captions need Russian letters.
    store.state = project({ ...boldPop(), track: 'ru' }, { captionTracks: [ruTrack] })
    expect(await noteLanguages()).toEqual(['ru', 'ru'])
    // Russian speech with its English translation burned in: no Russian letters are drawn.
    const enTrack: CaptionTrack = { ...ruTrack, language: 'en', segments: [{ id: 'c1', text: 'Every word counts', src: 'x' }] }
    store.state = project({ ...boldPop(), track: 'en' }, { transcript: { language: 'ru', segments: [{ id: 'c1', start: 0, end: 2, text: 'Каждое слово важно' }] } as Project['transcript'], captionTracks: [enTrack] })
    expect(await noteLanguages()).toEqual(['en', 'en'])
    // Bangla captions whose transcript names no language are drawn as Bangla.
    store.state = project(boldPop(), { transcript: { segments: [{ id: 'c1', start: 0, end: 2, text: 'এখন ৩টি ধাপ' }] } as Project['transcript'] })
    expect(await noteLanguages()).toEqual(['bn', 'bn'])
  })
})

/** A colour dot by its accessible name. */
function chipLike(els: El[], id: string, label: string): El {
  return descendants(byTestId(els, id)!).find((e) => e.props['aria-label'] === label)!
}

describe('Save as my style keeps the keyboard (§2.4, §2.15)', () => {
  const look = (): unknown => ({ type: CaptionLookSection, props: { project: store.state, vw: 1920, vh: 1080, onGreat: () => undefined, greatBusy: false, onGreatCancel: () => undefined } })
  const SECTION_SKIP = ['TextControls', 'ColourControls', 'LayoutControls', 'MotionControls', 'EmphasisControls', 'SpeakerControls', 'FontPicker', 'ShowSpeakerToggle', 'CaptionGallery']
  const open = async (): Promise<El[]> => {
    const els = await settle(look(), SECTION_SKIP)
    ;(byTestId(els, 'caption-style-save')!.props.onClick as () => void)()
    return settle(look(), SECTION_SKIP)
  }

  it('the name field takes the focus with its name selected, so typed keys name the style', async () => {
    const name = byTestId(await open(), 'caption-style-name-input')!
    expect(name.props.value).toMatch(/^My style \d+$/)
    expect(name.props.autoFocus).toBe(true)
    const selected: string[] = []
    ;(name.props.onFocus as (e: unknown) => void)({ currentTarget: { select: () => selected.push('all') } })
    expect(selected).toEqual(['all'])
  })

  it('Escape in the name cancels (not the editor’s blur) and the keyboard goes back to the button', async () => {
    keys.last = true
    const name = byTestId(await open(), 'caption-style-name-input')!
    let stopped = false
    const esc = { ...key('Escape'), stopPropagation: () => void (stopped = true) }
    esc.preventDefault = () => void (esc.prevented = true)
    ;(name.props.onKeyDown as (e: unknown) => void)(esc)
    expect(esc.prevented).toBe(true)
    expect(stopped).toBe(true)
    const els = await settle(look(), SECTION_SKIP)
    expect(byTestId(els, 'caption-style-name-input')).toBeUndefined()
    expect(focused.at(-1)?.props['data-testid']).toBe('caption-style-save')
    // Other keys are the field's.
    const other = byTestId(await open(), 'caption-style-name-input')!
    ;(other.props.onKeyDown as (e: unknown) => void)(key('t'))
    expect(byTestId(await settle(look(), SECTION_SKIP), 'caption-style-name-input')).toBeDefined()
  })

  it('Cancel with the keyboard gives the focus back; Cancel clicked leaves it, as a clicked button does', async () => {
    keys.last = true
    let els = await open()
    ;(els.find((e) => e.type === 'button' && textOf(e) === 'Cancel')!.props.onClick as () => void)()
    els = await settle(look(), SECTION_SKIP)
    expect(focused.map((e) => e.props['data-testid'])).toEqual(['caption-style-save'])
    focused.length = 0
    keys.last = false
    els = await open()
    ;(els.find((e) => e.type === 'button' && textOf(e) === 'Cancel')!.props.onClick as () => void)()
    els = await settle(look(), SECTION_SKIP)
    expect(byTestId(els, 'caption-style-save')).toBeDefined()
    expect(focused).toEqual([])
  })

  it('Save with the keyboard (Enter in the name) saves the look and gives the focus back to the button', async () => {
    keys.last = true
    const els = await open()
    const form = els.find((e) => e.type === 'form')!
    ;(form.props.onSubmit as (e: unknown) => void)({ preventDefault: () => undefined })
    const after = await settle(look(), SECTION_SKIP)
    expect(byTestId(after, 'caption-style-name-input')).toBeUndefined()
    expect(notices.at(-1)).toMatch(/^Saved “My style \d+” to your styles$/)
    expect(focused.at(-1)?.props['data-testid']).toBe('caption-style-save')
  })
})
