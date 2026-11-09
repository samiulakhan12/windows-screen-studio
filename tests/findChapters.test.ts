/**
 * Running Find chapters (docs/design/smart-tools.md §2.3, §7.8; §22.1 tests 118 and 120, and the
 * run and panel of part P2): the notices, the first weak name for the focus, the screen read with
 * its progress, a failed scan, Stop, names written on this PC, "Make captions first" when speech
 * is heard without captions (speechHeard), and the Text tab's panel with its options and the
 * palette's request. window.api is a fake; nothing leaves the test.
 */
import { beforeEach, describe, expect, it, onTestFinished, vi } from 'vitest'
import type { AudioLevels } from '../src/shared/audio/loudness'
import type { SceneScan } from '../src/shared/api/projects'
import { EditStore } from '../src/shared/editor/editStore'
import { speechHeard } from '../src/shared/smart/speechHeard'
import { chapterReviewItems } from '../src/shared/review/chapterReview'
import type { Chapter, CursorTrack, Project } from '../src/shared/types'
import { chapterProject, scanOf, type Said } from './chapterFixtures'
import { button, byTestId, contexts, mockReact, settle, textOf, unmountAll, useEditorContexts, type El } from './studioHarness'

/* ---------- the fake main process ---------- */

const OPENAI = { id: 'o1', kind: 'openai', label: 'My OpenAI', model: 'gpt', maskedKey: '…', createdAt: '' }
const fake = vi.hoisted(() => ({
  scan: null as SceneScan | null,
  scanFails: false,
  scanGate: null as Promise<void> | null,
  scans: [] as { id: string; crop: unknown }[],
  progress: null as ((p: { id: string; fraction: number }) => void) | null,
  levels: {} as Record<string, unknown>,
  ai: [] as { provider: string; request: Record<string, unknown>; requestId: unknown }[],
  answer: null as ((request: Record<string, unknown>) => unknown) | null,
  cancelled: [] as unknown[],
  prefs: new Map<string, unknown>(),
  commands: [] as string[]
}))
vi.stubGlobal('window', {
  api: {
    detectScenes: async (id: string, crop: unknown) => {
      fake.scans.push({ id, crop })
      fake.progress?.({ id, fraction: 0.4 })
      if (fake.scanGate) await fake.scanGate
      if (fake.scanFails) throw new Error('ffmpeg could not read the video')
      return fake.scan ?? { step: 0.25, t: [], changed: [], stills: [] }
    },
    onSceneProgress: (l: (p: { id: string; fraction: number }) => void) => {
      fake.progress = l
      return () => void (fake.progress = null)
    },
    analyzeAudio: async (_id: string, sources: string[]) => Object.fromEntries(sources.filter((s) => fake.levels[s]).map((s) => [s, fake.levels[s]])),
    listAiProviders: async () => [OPENAI],
    aiText: async (provider: string, request: Record<string, unknown>, requestId: unknown) => {
      fake.ai.push({ provider, request, requestId })
      return fake.answer!(request)
    },
    cancelAiText: async (id: unknown) => void fake.cancelled.push(id),
    getPref: async (key: string) => fake.prefs.get(key) ?? null,
    setPref: async (key: string, value: unknown) => void fake.prefs.set(key, value),
    localAiState: async () => ({ models: [], use: 'auto', active: null, pc: {}, speeds: {} })
  },
  addEventListener: () => undefined,
  removeEventListener: () => undefined,
  dispatchEvent: () => true
})

/** The question before a paid run (the dialog itself is tested in costConfirm.test.ts): its answer, and how often it was asked. */
const question = vi.hoisted(() => ({ answer: true, asked: 0 }))
vi.mock('../src/renderer/src/ai/costConfirm', () => ({
  confirmCost: async () => {
    question.asked++
    return question.answer
  },
  wasAsked: () => false,
  resetAskedCosts: () => undefined
}))

mockReact()
// Renderer code: imported at run time so the Node typecheck of tests/ does not follow it.
const RUN = '../src/renderer/src/editor/chaptersRun'
const PANEL = '../src/renderer/src/editor/panels/FindChapters'
const REQUESTS = '../src/renderer/src/editor/smartRequests'
type Run = (deps: { store: EditStore<Project>; recorded: CursorTrack; options: Record<string, unknown>; signal: AbortSignal; requestId: string; onProgress(text: string, fraction: number | null): void }) => Promise<{ notice: string; weak: string | null } | { needsCaptions: true }>
const { runFindChapters, FIND_WORDS, FIND_CHAPTERS_BUILT } = (await import(/* @vite-ignore */ RUN)) as { runFindChapters: Run; FIND_WORDS: Record<string, string>; FIND_CHAPTERS_BUILT: boolean }
const { FindChapters, FIND_HINT } = (await import(/* @vite-ignore */ PANEL)) as { FindChapters: (p: unknown) => unknown; FIND_HINT: string }
const { requestFindChapters } = (await import(/* @vite-ignore */ REQUESTS)) as { requestFindChapters(): void }
const USE_COST = '../src/renderer/src/ai/useCost'
const { refreshCostData } = (await import(/* @vite-ignore */ USE_COST)) as { refreshCostData(): Promise<void> }
await useEditorContexts()

const NO_INPUT: CursorTrack = { samples: [], clicks: [], keys: [], valid: false }
const OPTIONS = { density: 'normal', use: { screen: true, pauses: true, words: true }, names: 'offline' }
let ids = 0
/** A project with its own id (the audio levels are kept by id). */
const projectOf = (duration: number, said?: Said[], chapters?: Chapter[]): Project => ({ ...chapterProject({ duration, said, chapters }), id: `find-${++ids}` })
const run = (store: EditStore<Project>, options: Record<string, unknown> = OPTIONS, signal = new AbortController().signal, progress: string[] = []) =>
  runFindChapters({ store, recorded: NO_INPUT, options, signal, requestId: `find-chapters-${ids}`, onProgress: (t) => progress.push(t) })

/** Speech (power 0.1) for `seconds` from 1 s, quiet (1e-9) elsewhere, over `length` s, in 50 ms windows; with `detector`, the speech detector's ranges. */
function levels(seconds: number, length = 120, detector = false): AudioLevels {
  const window = 0.05
  const power = new Float32Array(Math.round(length / window)).fill(1e-9)
  for (let i = Math.round(1 / window); i < Math.round((1 + seconds) / window); i++) power[i] = 0.1
  return { window, power, ...(detector ? { speech: [{ start: 1, end: 1 + seconds }] } : {}) }
}

beforeEach(() => {
  fake.scan = null
  fake.scanFails = false
  fake.scanGate = null
  fake.scans.length = 0
  fake.levels = {}
  fake.ai.length = 0
  fake.answer = null
  fake.cancelled.length = 0
  fake.prefs.clear()
  fake.commands.length = 0
  unmountAll()
})

describe('Find chapters runs (test 118: the first weak chapter for the focus)', () => {
  it('a silent recording with page changes: Intro, Part 2, Part 3, found and pending; the focus goes to the first weak name', async () => {
    expect(FIND_CHAPTERS_BUILT).toBe(true)
    fake.scan = scanOf(120, { 40: 62, 80: 73 })
    const store = new EditStore<Project>(projectOf(120))
    const progress: string[] = []
    const out = await run(store, OPTIONS, new AbortController().signal, progress)
    expect(out).toEqual({ notice: 'Found 3 chapters. Review lists them: keep or remove each one.', weak: expect.any(String) })
    const chapters = store.state.chapters!
    expect(chapters.map((c) => [c.t, c.title, c.auto?.by, c.auto?.name])).toEqual([
      [0, 'Intro', 'find', 'number'],
      [40, 'Part 2', 'find', 'number'],
      [80, 'Part 3', 'find', 'number']
    ])
    expect((out as { weak: string }).weak).toBe(chapters[0].id)
    // The screen was read inside the crop, with its progress shown.
    expect(fake.scans).toEqual([{ id: store.state.id, crop: null }])
    expect(progress).toContain(`${FIND_WORDS.looking} 40%`)
    // One undo step.
    store.undo()
    expect(store.state.chapters).toEqual([])
  })

  it('no weak name: no focus; a run again keeps the same chapters', async () => {
    fake.scan = scanOf(180, { 60.5: 62, 120.5: 70 })
    const said = [
      { t: 1, text: 'Welcome to the billing tour.' },
      { t: 61, text: "Now let's set up billing, which takes a minute." },
      { t: 121, text: 'Finally we export the report.' }
    ]
    const store = new EditStore<Project>(projectOf(180, said))
    const out = await run(store)
    expect(out).toMatchObject({ weak: null })
    expect(store.state.chapters!.map((c) => c.title)).toEqual(['Welcome to the billing tour', 'Set up billing', 'Export the report'])
    const before = store.state
    await run(store)
    expect(store.state).toBe(before)
  })

  it('the honest notices: too short, nothing, already, two chapters, the first not at 0:00', async () => {
    fake.scan = scanOf(29, { 15: 60 })
    expect(await run(new EditStore<Project>(projectOf(29)))).toEqual({ notice: FIND_WORDS.tooShort, weak: null })
    fake.scan = scanOf(120)
    expect(await run(new EditStore<Project>(projectOf(120)))).toEqual({ notice: FIND_WORDS.nothing, weak: null })
    const every40 = Array.from({ length: 15 }, (_, i) => ({ id: `u${i}`, t: i * 40, title: `Mine ${i}` }))
    fake.scan = scanOf(600, { 20: 60, 300: 60 })
    expect(await run(new EditStore<Project>(projectOf(600, undefined, every40)))).toEqual({ notice: FIND_WORDS.already, weak: null })
    fake.scan = scanOf(60, { 30: 60 })
    expect(await run(new EditStore<Project>(projectOf(60)))).toMatchObject({ notice: 'Found 2 chapters. YouTube needs at least 3: add one by hand to use them there.' })
    fake.scan = scanOf(600, { 180: 62, 360: 70 })
    expect(await run(new EditStore<Project>(projectOf(600, undefined, [{ id: 'u', t: 3, title: 'Mine' }])))).toMatchObject({
      notice: 'Found 2 chapters. Review lists them: keep or remove each one. YouTube needs the first chapter at 0:00.'
    })
  })

  it('a failed scan is not fatal: chapters come from pauses and what is said, and the notice says so', async () => {
    fake.scanFails = true
    const said: Said[] = [
      { t: 1, text: 'Welcome to the tour.' },
      { t: 50, text: 'Moving on, the billing page.' },
      { t: 100, text: 'Finally, the export.' }
    ]
    const store = new EditStore<Project>(projectOf(150, said))
    const out = (await run(store)) as { notice: string }
    expect(out.notice).toBe(`Found 3 chapters. Review lists them: keep or remove each one. ${FIND_WORDS.noScreen}`)
    // With Screen changes off, the screen is not read.
    fake.scanFails = false
    await run(new EditStore<Project>(projectOf(150, said)), { ...OPTIONS, use: { screen: false, pauses: true, words: true } })
    expect(fake.scans).toHaveLength(1)
  })

  it('Stop while the screen is read: the run stops, nothing changes, and its AI request is cancelled', async () => {
    let open!: () => void
    fake.scanGate = new Promise((r) => (open = r))
    fake.scan = scanOf(120, { 40: 62, 80: 73 })
    const store = new EditStore<Project>(projectOf(120))
    const before = store.state
    const ctrl = new AbortController()
    const pending = run(store, OPTIONS, ctrl.signal)
    await new Promise((r) => setTimeout(r, 0))
    ctrl.abort()
    await expect(pending).rejects.toMatchObject({ name: 'AbortError' })
    open()
    expect(store.state).toBe(before)
    expect(fake.cancelled).toEqual([`find-chapters-${ids}`])
  })

  it('names written on this PC: the chapters with words are sent, by index; the origin says on this PC', async () => {
    fake.scan = scanOf(180, { 60.5: 62, 120.5: 70 })
    const said = [
      { t: 61, text: 'Open the quarterly billing report for the team now.' },
      { t: 121, text: 'Finally we export the report.' }
    ]
    fake.answer = (request) => {
      const names = request.names as { items: { id: string }[] }
      return { task: 'names', names: names.items.map((i) => ({ id: i.id, name: i.id === '1' ? 'Billing report' : 'See example.com' })) }
    }
    const store = new EditStore<Project>(projectOf(180, said))
    await run(store, { ...OPTIONS, names: 'local' })
    expect(fake.ai).toHaveLength(1)
    expect(fake.ai[0].provider).toBe('local')
    expect(fake.ai[0].requestId).toBe(`find-chapters-${ids}`)
    const request = fake.ai[0].request as { task: string; names: { kind: string; items: { id: string }[] }; segments: unknown[] }
    expect(request.task).toBe('names')
    // The first part has no words: not sent.
    expect(request.names.items.map((i) => i.id)).toEqual(['1', '2'])
    const chapters = store.state.chapters!
    expect(chapters[1]).toMatchObject({ title: 'Billing report', auto: { name: 'ai', via: 'local' } })
    // A name with a link keeps the offline one.
    expect(chapters[2]).toMatchObject({ title: 'Export the report', auto: { name: 'sentence' } })
    expect(chapters[2].auto!.via).toBeUndefined()
    expect(chapterReviewItems(store.state).find((r) => r.key === `chapter:${chapters[1].id}`)!.detail).toBe('Find chapters · page change · named on this PC')
  })
})

describe('words or not (test 120)', () => {
  const p = (): Project => projectOf(120)

  it("speechHeard: captions; 12 s of detected speech without them; 8 s; no sound; without the detector, activity minus typing", () => {
    const withCaptions = projectOf(120, [{ t: 1, text: 'Hello there.' }])
    expect(speechHeard(withCaptions, null, null)).toBe('captions')
    expect(speechHeard(p(), { mix: levels(12, 120, true) }, null)).toBe('speech')
    expect(speechHeard(p(), { mix: levels(8, 120, true) }, null)).toBe('none')
    expect(speechHeard(p(), null, null)).toBe('none')
    // Without the detector: the sound level, the typing under it taken out.
    expect(speechHeard(p(), { mix: levels(12) }, null)).toBe('speech')
    const typing: CursorTrack = { samples: [], clicks: [], keys: [], typing: [{ t: 0.5, end: 13.5 }], valid: true }
    expect(speechHeard(p(), { mix: levels(12) }, typing)).toBe('none')
  })

  it('Find chapters asks for captions when speech is heard; runs without words when there is none, or when words are not wanted', async () => {
    fake.scan = scanOf(120, { 40: 62, 80: 73 })
    fake.levels = { mix: levels(12, 120, true) }
    let store = new EditStore<Project>(p())
    expect(await run(store)).toEqual({ needsCaptions: true })
    expect(store.state.chapters).toEqual([])
    // Split without words.
    expect(await run(store, { ...OPTIONS, use: { screen: true, pauses: true, words: false } })).toMatchObject({ notice: expect.stringMatching(/^Found 3 chapters/) })
    fake.levels = { mix: levels(8, 120, true) }
    store = new EditStore<Project>(p())
    expect(await run(store)).toMatchObject({ notice: expect.stringMatching(/^Found 3 chapters/) })
    expect(FIND_WORDS.needsCaptions).toBe('Make captions first: chapter names come from what you say.')
  })

  it("the speech detector's ranges give pauses to a recording without captions", async () => {
    // Speech 1-20 s, 25-60 s and 64-110 s heard by the detector; screen changes of 15% at 25 and 64 s.
    const heard: AudioLevels = { window: 0.05, power: new Float32Array(2400).fill(1e-9), speech: [{ start: 1, end: 20 }, { start: 25, end: 60 }, { start: 64, end: 110 }] }
    fake.levels = { mix: heard }
    fake.scan = scanOf(120, { 25: 15, 64: 15 })
    const store = new EditStore<Project>(p())
    // Pause (1.5) and screen change (1.5): 3, not above Normal's cost; at More, two splits.
    expect(await run(store, { ...OPTIONS, use: { screen: true, pauses: true, words: false } })).toEqual({ notice: FIND_WORDS.nothing, weak: null })
    expect(await run(store, { ...OPTIONS, density: 'more', use: { screen: true, pauses: true, words: false } })).toMatchObject({ notice: expect.stringMatching(/^Found 3 chapters/) })
    expect(store.state.chapters!.map((c) => [c.t, c.auto!.from])).toEqual([
      [0, ['start']],
      [25, ['screen', 'pause']],
      [64, ['screen', 'pause']]
    ])
  })
})

/* ---------- the panel ---------- */

describe('the Find chapters panel (§2.3)', () => {
  let store: EditStore<Project>
  const notices: string[] = []
  const panel = (): unknown => ({ type: FindChapters, props: { project: store.state, cursor: NO_INPUT, onNotice: (m: string) => notices.push(m) } })
  const SKIP = ['LocalProgress', 'CostLine']
  const click = (el: El | undefined): void => (el!.props.onClick as () => void)()

  beforeEach(() => {
    store = new EditStore<Project>(projectOf(120))
    contexts.editor = { store, player: {} }
    contexts.group = { command: (id: string) => fake.commands.push(id) }
    notices.length = 0
  })

  it('the button names its hint; the Options are closed, with how many, what to split at and where names come from', async () => {
    const els = await settle(panel(), SKIP)
    const find = byTestId(els, 'find-chapters')!
    expect(textOf(find).trim()).toBe('Find chapters')
    const hint = els.find((e) => e.props.id === find.props['aria-describedby'])!
    expect(textOf(hint)).toBe(FIND_HINT)
    const options = els.find((e) => e.type === 'details')!
    expect(options.props.open).toBeUndefined()
    expect(els.filter((e) => e.type === 'legend').map(textOf)).toEqual(['How many', 'Split at', 'Names'])
    const radios = els.filter((e) => e.type === 'input' && e.props.type === 'radio')
    expect(radios.filter((r) => r.props.checked).length).toBe(2)
    expect(els.filter((e) => e.type === 'input' && e.props.type === 'checkbox').every((c) => c.props.checked)).toBe(true)
    // With a provider, the names can be written with it.
    expect(els.filter((e) => e.type === 'option').map(textOf)).toContain('My OpenAI')
  })

  it('with names from an AI the button also reads its cost sentence (§11.5); offline only its hint', async () => {
    fake.prefs.set('findChapters', { density: 'normal', use: { screen: true, pauses: true, words: true }, names: 'o1' })
    const els = await settle(panel(), SKIP)
    const find = byTestId(els, 'find-chapters')!
    const cost = els.find((e) => (e.type as { name?: string }).name === 'CostLine')!
    const ids = String(find.props['aria-describedby']).split(/\s+/)
    expect(ids).toHaveLength(2)
    expect(textOf(els.find((e) => e.props.id === ids[0])!)).toBe(FIND_HINT)
    expect(ids[1]).toBe(`${cost.props.id}-names`)
    unmountAll()
    fake.prefs.delete('findChapters')
    const offline = byTestId(await settle(panel(), SKIP), 'find-chapters')!
    expect(String(offline.props['aria-describedby']).split(/\s+/)).toHaveLength(1)
  })

  it('a run: the notice, and the chapters found; the options are remembered', async () => {
    fake.scan = scanOf(120, { 40: 62, 80: 73 })
    let els = await settle(panel(), SKIP)
    // More: remembered.
    const more = els.find((e) => e.type === 'input' && e.props.value === 'more')!
    ;(more.props.onChange as () => void)()
    els = await settle(panel(), SKIP)
    expect(fake.prefs.get('findChapters')).toMatchObject({ density: 'more' })
    click(byTestId(els, 'find-chapters'))
    els = await settle(panel(), SKIP)
    expect(notices).toEqual(['Found 3 chapters. Review lists them: keep or remove each one.'])
    expect(store.state.chapters).toHaveLength(3)
    expect(byTestId(els, 'find-chapters-progress')).toBeUndefined()
  })

  it('while it runs: the progress and Stop; Stop changes nothing', async () => {
    let open!: () => void
    fake.scanGate = new Promise((r) => (open = r))
    fake.scan = scanOf(120, { 40: 62, 80: 73 })
    let els = await settle(panel(), SKIP)
    click(byTestId(els, 'find-chapters'))
    els = await settle(panel(), SKIP)
    expect(textOf(byTestId(els, 'find-chapters-progress')!)).toBe(`${FIND_WORDS.looking} 40%`)
    expect(byTestId(els, 'find-chapters')!.props.disabled).toBe(true)
    click(byTestId(els, 'find-chapters-stop'))
    open()
    els = await settle(panel(), SKIP)
    expect(store.state.chapters).toEqual([])
    expect(notices).toEqual([])
    expect(byTestId(els, 'find-chapters-stop')).toBeUndefined()
  })

  it('speech without captions: "Make captions first" with Make captions and Split without words', async () => {
    fake.scan = scanOf(120, { 40: 62, 80: 73 })
    fake.levels = { mix: levels(12, 120, true) }
    let els = await settle(panel(), SKIP)
    click(byTestId(els, 'find-chapters'))
    els = await settle(panel(), SKIP)
    const note = byTestId(els, 'find-chapters-needs-captions')!
    expect(textOf(note)).toContain('Make captions first: chapter names come from what you say.')
    click(button(els, 'Split without words'))
    els = await settle(panel(), SKIP)
    expect(store.state.chapters!.map((c) => c.title)).toEqual(['Intro', 'Part 2', 'Part 3'])
    click(byTestId(els, 'find-chapters'))
    els = await settle(panel(), SKIP)
    click(button(els, 'Make captions'))
    expect(fake.commands).toEqual(['generateCaptions'])
  })

  it("the palette's Find chapters presses the button: with names from an AI and Always ask, the cost question comes first (§11.5)", async () => {
    // The page: its click listeners (the cost line's), and the name fields the focus goes to.
    const listeners: ((e: unknown) => void)[] = []
    const page = {
      addEventListener: (type: string, fn: (e: unknown) => void) => void (type === 'click' && listeners.push(fn)),
      removeEventListener: (_type: string, fn: (e: unknown) => void) => void listeners.splice(listeners.indexOf(fn) >>> 0, 1),
      dispatchEvent: (e: unknown) => {
        for (const l of [...listeners]) l(e)
        return true
      },
      getElementById: () => ({ focus: () => undefined })
    }
    Object.defineProperty(globalThis, 'document', { configurable: true, value: page })
    onTestFinished(() => {
      unmountAll()
      delete (globalThis as { document?: unknown }).document
    })
    fake.scan = scanOf(180, { 60.5: 62, 120.5: 70 })
    store = new EditStore<Project>(projectOf(180, [{ t: 61, text: 'Open the quarterly billing report for the team now.' }, { t: 121, text: 'Finally we export the report.' }]))
    contexts.editor = { store, player: {} }
    fake.answer = (request) => ({ task: 'names', names: (request.names as { items: { id: string }[] }).items.map((i) => ({ id: i.id, name: 'Billing report' })) })
    fake.prefs.set('findChapters', { density: 'normal', use: { screen: true, pauses: true, words: true }, names: 'o1' })
    fake.prefs.set('aiConfirm', 'always')
    await refreshCostData()
    // The Text tab shows the panel (its cost line listening), then the palette asks; Cancel: nothing is sent.
    question.asked = 0
    question.answer = false
    await settle(panel(), ['LocalProgress'])
    requestFindChapters()
    await settle(panel(), ['LocalProgress'])
    expect(question.asked).toBe(1)
    expect(fake.ai).toEqual([])
    expect(store.state.chapters).toEqual([])
    // Run: the names are sent.
    question.answer = true
    requestFindChapters()
    await settle(panel(), ['LocalProgress'])
    await settle(panel(), ['LocalProgress'])
    expect(question.asked).toBe(2)
    expect(fake.ai.map((a) => [a.provider, a.request.task])).toEqual([['o1', 'names']])
    expect(store.state.chapters!.length).toBeGreaterThan(0)
  })

  it("the palette's Find chapters runs it once the Text tab shows it", async () => {
    fake.scan = scanOf(120, { 40: 62, 80: 73 })
    requestFindChapters()
    await settle(panel(), SKIP)
    await settle(panel(), SKIP)
    expect(store.state.chapters).toHaveLength(3)
    expect(notices).toEqual(['Found 3 chapters. Review lists them: keep or remove each one.'])
  })
})
