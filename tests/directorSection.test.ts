import { beforeEach, describe, expect, it, vi } from 'vitest'
import type { DirectorSpeech } from '../src/shared/audio/speech'
import { applyDirectorPlan, planDirector } from '../src/shared/editor/cameraDirector'
import { setClicksIgnored } from '../src/shared/editor/inputEdits'
import { DEFAULT_KEYMAP } from '../src/shared/editor/shortcuts'
import { directorSettingsOf } from '../src/shared/engine/directorData'
import { effectiveTrack } from '../src/shared/engine/inputTrack'
import { createProject } from '../src/shared/engine/project'
import type { FramingOutcome } from '../src/shared/render/faceFraming'
import type { CursorSample, CursorTrack, Project } from '../src/shared/types'

/*
 * The Camera tab's "Auto director" section (docs/design/camera-director.md, section 2) without a
 * DOM, as tests/captionsPanel.test.ts renders the Captions tab: React's hooks are swapped for a few
 * lines that keep the section's state by its place in the tree, so DirectorSection is called as a
 * function and its elements read. The sound and the face measurements are stubbed and answered by
 * each test; the planner is the real one. The fixture is the e2e recording of cameraDirector.test.ts.
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

// Every cursor or focus path built (the planner's and the section's alike).
const built = vi.hoisted(() => ({ paths: 0 }))
vi.mock('../src/shared/engine/cursor', async (importOriginal) => {
  const m = await importOriginal<typeof import('../src/shared/engine/cursor')>()
  class SmoothedTrack extends m.SmoothedTrack {
    constructor(...args: ConstructorParameters<typeof m.SmoothedTrack>) {
      super(...args)
      built.paths++
    }
  }
  return { ...m, SmoothedTrack }
})

const cells = new Map<string, Cell[]>()
let hooks: { cells: Cell[]; i: number } | null = null
let effects: (() => void)[] = []
let dirty = false
const cell = (): Cell => (hooks!.cells[hooks!.i++] ??= {})
const changed = (a: readonly unknown[] | undefined, b: readonly unknown[] | undefined): boolean => !a || !b || a.length !== b.length || a.some((v, i) => !Object.is(v, b[i]))

function deferred<T>(): { promise: Promise<T>; resolve: (v: T) => void } {
  let resolve!: (v: T) => void
  const promise = new Promise<T>((a) => (resolve = a))
  return { promise, resolve }
}

// The section's debounce, run by render() when it settles.
const timers = new Map<number, () => void>()
let timerId = 0
vi.stubGlobal('window', {
  setTimeout: (f: () => void) => {
    timers.set(++timerId, f)
    return timerId
  },
  clearTimeout: (id: number) => void timers.delete(id)
})

interface SpeechResult {
  speech: DirectorSpeech | null
  failed: boolean
}
let speechReply: () => Promise<SpeechResult>
let framingReply: () => Promise<FramingOutcome>
vi.doMock('../src/renderer/src/editor/directorAnalysis', () => ({
  loadDirectorSpeech: () => speechReply(),
  measureFraming: () => framingReply()
}))

let store: { state: Project; update: (fn: (p: Project) => Project) => void }
let player: { webcam: { duration: number; currentSrc: string; src: string } | null; seek: () => void }
let keymapContext: unknown = null

vi.doMock('react', async (importOriginal) => ({
  ...(await importOriginal<Record<string, unknown>>()),
  useState: (init: unknown) => {
    const c = cell()
    if (!('value' in c)) c.value = typeof init === 'function' ? (init as () => unknown)() : init
    const set = (v: unknown): void => {
      c.value = typeof v === 'function' ? (v as (x: unknown) => unknown)(c.value) : v
      dirty = true
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
  // The session's changes (speech measured, Apply progress) render again.
  useSyncExternalStore: (subscribe: (l: () => void) => () => void, get: () => unknown) => {
    const c = cell()
    if (!c.current) c.current = subscribe(() => (dirty = true))
    return get()
  },
  // useEditor() and useKeymap() are the contexts the section reads.
  useContext: (ctx: unknown) => (ctx === keymapContext ? DEFAULT_KEYMAP : { store, player })
}))

// Renderer code: imported at run time so the Node typecheck of tests/ does not follow it.
const SECTION = '../src/renderer/src/editor/panels/DirectorSection'
const KEYMAP = '../src/renderer/src/editor/keymapContext'
keymapContext = ((await import(/* @vite-ignore */ KEYMAP)) as { KeymapContext: unknown }).KeymapContext
const { DirectorSection } = (await import(/* @vite-ignore */ SECTION)) as { DirectorSection: (props: unknown) => unknown }

/** Calls DirectorSection (hooks kept by `path`) and lists every other element under it. */
function walk(node: unknown, path: string, out: El[]): void {
  if (Array.isArray(node)) return node.forEach((n, i) => walk(n, `${path}.${i}`, out))
  if (!node || typeof node !== 'object' || !('props' in node)) return
  const el = node as El
  if (el.type === DirectorSection) {
    if (!cells.has(path)) cells.set(path, [])
    hooks = { cells: cells.get(path)!, i: 0 }
    const child = DirectorSection(el.props)
    hooks = null
    return walk(child, `${path}/DirectorSection`, out)
  }
  out.push(el)
  walk(el.props.children, path, out)
}

let recorded: CursorTrack
let notices: string[] = []
let directorRequest = 0
// The editor's callbacks are stable.
const onSelect = (): void => undefined
const onNotice = (m: string): void => void notices.push(m)

/** The section for the project in the store (as the editor passes it), rendered until its state, effects and debounce settle. */
function render(): El[] {
  for (let pass = 0; pass < 30; pass++) {
    dirty = false
    const out: El[] = []
    const project = store.state
    const props = { project, cursor: effectiveTrack(recorded, project), recorded, onSelect, onNotice, directorRequest }
    walk({ type: DirectorSection, props }, 'root', out)
    const run = effects
    effects = []
    run.forEach((e) => e())
    const due = [...timers.values()]
    timers.clear()
    due.forEach((f) => f())
    if (!dirty && !run.length && !due.length) return out
  }
  throw new Error('The section keeps rendering')
}

/** The section taken off (another tab opened): its effects cleaned up, its hook state gone. */
function unmount(): void {
  for (const list of cells.values()) for (const c of list) c.cleanup?.()
  cells.clear()
}

const flush = async (): Promise<void> => {
  for (let i = 0; i < 5; i++) await new Promise((r) => setTimeout(r, 0))
}
const textOf = (node: unknown): string =>
  Array.isArray(node) ? node.map(textOf).join('') : typeof node === 'string' || typeof node === 'number' ? String(node) : node && typeof node === 'object' && 'props' in node ? textOf((node as El).props.children) : ''
const byId = (out: El[], id: string): El[] => out.filter((e) => e.props['data-testid'] === id)
const one = (out: El[], id: string): El | undefined => byId(out, id)[0]
const notesOf = (out: El[]): unknown[] => byId(out, 'director-note').map((e) => e.props['data-note'])
const apply = (out: El[]): El => one(out, 'director-apply')!
const control = (out: El[], label: string): El => out.find((e) => e.props.label === label && typeof e.props.onChange === 'function')!

/* ---------- the e2e fixture ---------- */

function e2eProject(over: Partial<Project> = {}): Project {
  const p = createProject({
    id: 'p',
    name: 'p',
    duration: 48,
    width: 1280,
    height: 720,
    hasWebcam: true,
    hasAudio: true,
    webcamOffset: 0,
    zooms: [],
    cursorValid: true,
    capture: { method: 'chromium', cursorInVideo: true, region: null }
  })
  p.style = { ...p.style, padding: 0 }
  p.webcam = { show: true, corner: 'bottom-right', size: 0.24, shape: 'circle' }
  return { ...p, ...over }
}

/** At (0.5, 0.5) until 8.0, to (0.92, 0.9) by 8.5, held; left clicks at 13, 16, 19, 22, 25 (and `extra`). */
function e2eCursor(extra: number[] = []): CursorTrack {
  const samples: CursorSample[] = []
  for (let i = 0; i <= 480; i++) {
    const t = i / 10
    const k = Math.min(1, Math.max(0, (t - 8) / 0.5))
    samples.push({ t, x: 0.5 + 0.42 * k, y: 0.5 + 0.4 * k })
  }
  const clicks = [...extra.map((t) => ({ t, x: 0.5, y: 0.5, button: 'left' as const })), ...[13, 16, 19, 22, 25].map((t) => ({ t, x: 0.92, y: 0.9, button: 'left' as const }))]
  return { samples, clicks, valid: true }
}
const CURSOR = e2eCursor()
/** A cursor that never moves or clicks: nothing on screen for the director. */
const STILL: CursorTrack = { samples: CURSOR.samples.map((s) => ({ ...s, x: 0.5, y: 0.5 })), clicks: [], valid: true }

const SPEECH: DirectorSpeech = {
  source: 'mic',
  refined: false,
  ranges: [
    { start: 0.5, end: 6 },
    { start: 17, end: 22 },
    { start: 34, end: 46.5 }
  ]
}
const HEARD: SpeechResult = { speech: SPEECH, failed: false }
const CAMERA = { duration: 48, currentSrc: 'camera.webm', src: 'camera.webm' }
const FRAMED: FramingOutcome = { status: 'framed', zoom: 1.25, cropX: 0.62, cropY: 0.4, found: 12, sampled: 12, steady: true }

beforeEach(() => {
  unmount()
  effects = []
  timers.clear()
  notices = []
  directorRequest = 0
  recorded = CURSOR
  speechReply = () => Promise.resolve(HEARD)
  framingReply = () => Promise.resolve({ status: 'skipped' })
  player = { webcam: null, seek: () => undefined }
  // A new store each test: a new editor session for the section.
  store = {
    state: e2eProject(),
    update(fn) {
      store.state = fn(store.state)
    }
  }
})

/* ---------- the sound ---------- */

describe('the notes while the sound is measured or could not be (ui-dir-1, dir-plan-6)', () => {
  it('while measuring: no "no sound was recorded" and no "nothing to change"', async () => {
    recorded = STILL
    const pending = deferred<SpeechResult>()
    speechReply = () => pending.promise
    let out = render()
    expect(one(out, 'director-source')?.props['data-source']).toBe('measuring')
    expect(notesOf(out)).toEqual(['no-demo'])
    pending.resolve({ speech: null, failed: false })
    await flush()
    out = render()
    expect(notesOf(out)).toEqual(['no-sound', 'no-demo', 'nothing'])
  })

  it('a recording with sound that could not be measured: the callout only, not "no sound was recorded"', async () => {
    speechReply = () => Promise.resolve({ speech: null, failed: true })
    render()
    await flush()
    const out = render()
    expect(textOf(one(out, 'director-sound-failed')?.props.children)).toContain('The sound could not be measured: the plan uses the mouse and keyboard only.')
    expect(notesOf(out)).not.toContain('no-sound')
  })

  it('could not be measured, but the captions gave the speech: the callout says the plan uses them', async () => {
    speechReply = () => Promise.resolve({ speech: { ...SPEECH, source: 'transcript', refined: true }, failed: true })
    render()
    await flush()
    const out = render()
    expect(one(out, 'director-source')?.props['data-source']).toBe('transcript')
    expect(textOf(one(out, 'director-sound-failed')?.props.children)).toContain("The sound could not be measured: the plan uses your captions' word timings.")
  })

  it('a recording without sound: the no-sound note, no callout', async () => {
    store.state = e2eProject({ hasAudio: false })
    speechReply = () => Promise.resolve({ speech: null, failed: false })
    render()
    await flush()
    const out = render()
    expect(notesOf(out)).toContain('no-sound')
    expect(one(out, 'director-sound-failed')).toBeUndefined()
  })
})

/* ---------- options that remove everything ---------- */

describe('options that leave nothing to direct on a directed project (ui-dir-2, dir-plan-5)', () => {
  it('shows the summary with the diff and says the options are off, not "nothing to change"', async () => {
    const p = e2eProject()
    store.state = applyDirectorPlan(p, planDirector({ project: p, cursor: CURSOR, speech: SPEECH }, directorSettingsOf(p)), { status: 'skipped' })
    render()
    await flush()
    let out = render()
    ;(control(out, 'Intro and outro').props.onChange as (v: string) => void)('off')
    out = render()
    ;(control(out, 'Hide the camera when silent for').props.onChange as (v: number) => void)(0)
    out = render()
    ;(control(out, 'Move the bubble away from the cursor').props.onChange as (v: boolean) => void)(false)
    out = render()
    expect(byId(out, 'director-part')).toEqual([])
    const summary = one(out, 'director-summary')!
    expect(summary.props.hidden).toBeUndefined()
    expect(textOf(summary.props.children)).toContain('+0 new · 5 removed · 0 unchanged')
    expect(notesOf(out)).toEqual(['options-off'])
    expect(apply(out).props.disabled).toBe(false)
    expect(textOf(apply(out).props.children)).toContain('Direct again')
  })
})

describe('options that leave some changes possible, nothing to change (ui-dir-6)', () => {
  // The clicks of the e2e recording, made mid-screen: the cursor never goes near the camera (bottom right).
  const MIDDLE: CursorTrack = { ...STILL, clicks: CURSOR.clicks.map((c) => ({ ...c, x: 0.5, y: 0.5 })) }

  it('gives only the reasons of the options that are on', async () => {
    recorded = MIDDLE
    // The talking before and after the demo and the long silences give an intro, an outro and hidden parts...
    store.state = e2eProject({ director: { intro: 'camera-only', hideAfter: 10, corners: 'auto', frameFace: false } })
    render()
    await flush()
    let out = render()
    expect(byId(out, 'director-part').map((e) => e.props['data-kind'])).toEqual(['intro', 'hidden', 'hidden', 'outro'])
    // ...but Intro Off and Hide Never leave only the bubble moves, and the cursor gives none.
    store.state = e2eProject({ director: { intro: 'off', hideAfter: 0, corners: 'auto', frameFace: false } })
    out = render()
    expect(byId(out, 'director-part')).toEqual([])
    expect(notesOf(out)).toEqual(['nothing'])
    const note = one(out, 'director-note')!
    expect(textOf(note.props.children)).toBe('Nothing to change: the cursor never came near the camera.')
  })
})

/* ---------- never directed, nothing to do ---------- */

describe('a project never directed with nothing to do (ui-dir-3)', () => {
  // The user framed the camera (Centre my face starts off); no sound; nothing happens on screen.
  const handFramed = (): Project => {
    const p = e2eProject({ hasAudio: false })
    p.webcam = { ...p.webcam, zoom: 1.2 }
    return p
  }

  it('reads "Up to date", disabled', async () => {
    recorded = STILL
    store.state = handFramed()
    speechReply = () => Promise.resolve({ speech: null, failed: false })
    render()
    await flush()
    const out = render()
    expect(byId(out, 'director-part')).toEqual([])
    expect(apply(out).props.disabled).toBe(true)
    expect(textOf(apply(out).props.children)).toContain('Up to date')
    expect(one(out, 'director-summary')?.props['data-state']).toBe('up-to-date')
  })

  it('the palette command then saves the options and says so, not "earlier automatic changes removed"', async () => {
    recorded = STILL
    store.state = handFramed()
    speechReply = () => Promise.resolve({ speech: null, failed: false })
    render()
    await flush()
    directorRequest = 1
    render()
    await flush()
    render()
    expect(store.state.director).toBeDefined()
    expect(notices).toHaveLength(1)
    expect(notices[0]).toMatch(/^Camera directed: options saved/)
  })
})

/* ---------- the framing outcome ---------- */

describe('the framing outcome follows the project (ui-dir-4)', () => {
  it('"Face centred" after Apply, gone after undo, back after redo', async () => {
    player.webcam = CAMERA
    framingReply = () => Promise.resolve(FRAMED)
    const before = store.state
    render()
    await flush()
    let out = render()
    ;(apply(out).props.onClick as () => void)()
    await flush()
    out = render()
    const after = store.state
    expect(after.webcam.zoom).toBe(1.25)
    expect(textOf(one(out, 'director-framing')?.props.children)).toBe('Face centred (1.25×).')
    // Ctrl+Z
    store.state = before
    out = render()
    expect(one(out, 'director-framing')).toBeUndefined()
    expect(textOf(one(out, 'director-face')?.props.children)).toBe('Face centred · measured when you direct')
    // Ctrl+Y
    store.state = after
    out = render()
    expect(textOf(one(out, 'director-framing')?.props.children)).toBe('Face centred (1.25×).')
  })

  it('the "unavailable" callout goes with an undo', async () => {
    player.webcam = CAMERA
    framingReply = () => Promise.resolve({ status: 'unavailable', reason: 'WebGL is not available' })
    const before = store.state
    render()
    await flush()
    let out = render()
    ;(apply(out).props.onClick as () => void)()
    await flush()
    out = render()
    expect(one(out, 'director-framing-unavailable')).toBeDefined()
    store.state = before
    out = render()
    expect(one(out, 'director-framing-unavailable')).toBeUndefined()
  })

  it('a Direct again that wrote only the layouts: an undo shows the outcome of the Apply before, a redo its own', async () => {
    player.webcam = CAMERA
    framingReply = () => Promise.resolve(FRAMED)
    render()
    await flush()
    let out = render()
    ;(apply(out).props.onClick as () => void)()
    await flush()
    out = render()
    expect(textOf(one(out, 'director-framing')?.props.children)).toBe('Face centred (1.25×).')
    // One automatic segment deleted by hand: the framing is still the one that Apply measured.
    const gone = store.state.layouts!.find((s) => s.auto)!.id
    store.update((p) => ({ ...p, layouts: p.layouts!.filter((s) => s.id !== gone) }))
    const deleted = store.state
    out = render()
    expect(textOf(one(out, 'director-framing')?.props.children)).toBe('Face centred (1.25×).')
    // Direct again while face framing is unavailable: the segment is back, the options and the framing are the same.
    framingReply = () => Promise.resolve({ status: 'unavailable', reason: 'WebGL is not available' })
    ;(apply(out).props.onClick as () => void)()
    await flush()
    out = render()
    const again = store.state
    expect(again.layouts).not.toBe(deleted.layouts)
    expect(again.webcam).toBe(deleted.webcam)
    expect(again.director).toEqual(deleted.director)
    expect(one(out, 'director-framing-unavailable')).toBeDefined()
    // Ctrl+Z: the project before that Apply, with the first Apply's line.
    store.state = deleted
    out = render()
    expect(one(out, 'director-framing-unavailable')).toBeUndefined()
    expect(textOf(one(out, 'director-framing')?.props.children)).toBe('Face centred (1.25×).')
    // Ctrl+Y
    store.state = again
    out = render()
    expect(one(out, 'director-framing-unavailable')).toBeDefined()
    expect(textOf(one(out, 'director-framing')?.props.children)).toBe('Face framing is unavailable: WebGL is not available. The rest of the camera track was directed.')
  })
})

describe('a measured framing the camera already shows (ui-dir-5)', () => {
  it('leaves no framing to do: "Up to date", and the face row names it', async () => {
    player.webcam = CAMERA
    // Within FACE.nearZoom / nearCrop of the untouched framing: Apply leaves the camera as it is.
    framingReply = () => Promise.resolve({ status: 'framed', zoom: 1, cropX: 0.505, cropY: 0.5, found: 12, sampled: 12, steady: true })
    render()
    await flush()
    let out = render()
    ;(apply(out).props.onClick as () => void)()
    await flush()
    out = render()
    expect(store.state.webcam.zoom).toBeUndefined()
    expect(store.state.director?.framed).toBeUndefined()
    expect(apply(out).props.disabled).toBe(true)
    expect(textOf(apply(out).props.children)).toContain('Up to date')
    expect(textOf(one(out, 'director-face')?.props.children)).toBe('Face centred · 1×')
    expect(textOf(one(out, 'director-framing')?.props.children)).toBe('Face centred (1×).')
  })
})

/* ---------- applying ---------- */

describe('Apply plans with the input as it is when it writes (INT-03)', () => {
  it('a click ignored while the face is measured counts: the intro is written', async () => {
    // A stray click at 3 s, while the person talks before the demo, starts the demo early.
    recorded = e2eCursor([3])
    player.webcam = CAMERA
    const face = deferred<FramingOutcome>()
    framingReply = () => face.promise
    render()
    await flush()
    const out = render()
    expect(byId(out, 'director-part').map((e) => e.props['data-kind'])).not.toContain('intro')
    ;(apply(out).props.onClick as () => void)()
    await flush()
    // "Ignore the click at the playhead", from the palette while Apply measures the face.
    store.update((p) => setClicksIgnored(p, recorded, { ignore: [{ ms: 3000 }] }))
    face.resolve({ status: 'not-found', found: 0, sampled: 12 })
    await flush()
    expect(store.state.layouts?.[0]).toMatchObject({ layout: 'camera-only', start: 0, auto: true })
    expect(store.state.layouts?.[0].end).toBeCloseTo(6.5, 6)
    // What was written is the live plan: nothing left to add or remove.
    const after = render()
    expect(textOf(one(after, 'director-summary')?.props.children)).toContain('+0 new · 0 removed · 5 unchanged')
  })
})

/* ---------- the paths ---------- */

describe('opening the Camera tab again (perf-parity-2)', () => {
  it('builds no new cursor or focus path: the planner\'s cached ones (and their corner costs) serve', async () => {
    render()
    await flush()
    render()
    const first = built.paths
    unmount()
    render()
    await flush()
    const out = render()
    expect(byId(out, 'director-part').length).toBe(5)
    expect(built.paths).toBe(first)
  })
})
