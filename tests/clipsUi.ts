/**
 * The Short clips panel's and the shorter version dialog's test bench (docs/design/smart-tools.md
 * §2.4): window.api and the preview player as fakes, React's hooks swapped (studioHarness), the
 * copy menu's portal and the dialogs' focus trap left out. Nothing leaves the test.
 */
import { expect, vi } from 'vitest'
import { EditStore } from '../src/shared/editor/editStore'
import type { Project } from '../src/shared/types'
import { clipProject, NO_TRACK, steadyTalk } from './clipFixtures'
import { contexts, mockReact, unmountAll, useEditorContexts, type El } from './studioHarness'

export const fake = {
  prefs: new Map<string, unknown>(),
  copies: [] as { sourceId: string; copy: Record<string, unknown> }[],
  projects: [] as { id: string; name: string; copyOf?: { id: string; name: string }; clip?: true }[],
  cost: { linked: true, bytes: 1000, free: 1e12 },
  frames: [] as (() => void)[],
  commands: [] as string[],
  levels: {} as Record<string, unknown>,
  providers: [] as unknown[],
  ai: [] as { provider: string; request: Record<string, unknown>; requestId: unknown }[],
  answer: (request: Record<string, unknown>): Promise<unknown> => Promise.resolve({ task: 'names', names: [] as unknown[], request }),
  cancelled: [] as unknown[],
  /** Keydown listeners on the window, as added. */
  keys: [] as ((e: unknown) => void)[]
}
vi.stubGlobal('window', {
  api: {
    getPref: async (key: string) => fake.prefs.get(key) ?? null,
    setPref: async (key: string, value: unknown) => void fake.prefs.set(key, value),
    copyCost: async () => fake.cost,
    listProjects: async () => fake.projects,
    detectScenes: async () => ({ step: 0.25, t: [], changed: [], stills: [] }),
    onSceneProgress: () => () => undefined,
    analyzeAudio: async (_id: string, sources: string[]) => Object.fromEntries(sources.filter((s) => fake.levels[s]).map((s) => [s, fake.levels[s]])),
    listAiProviders: async () => fake.providers,
    localAiState: async () => ({ models: [], use: 'auto', active: null, pc: {}, speeds: {} }),
    onLocalAiState: () => () => undefined,
    onLocalAiProgress: () => () => undefined,
    aiText: (provider: string, request: Record<string, unknown>, requestId: unknown) => {
      fake.ai.push({ provider, request, requestId })
      return fake.answer(request)
    },
    cancelAiText: async (id: unknown) => void fake.cancelled.push(id),
    duplicateProject: async (sourceId: string, copy: Record<string, unknown>) => {
      fake.copies.push({ sourceId, copy })
      return { id: `made-${fake.copies.length}`, name: String(copy.name), linked: true }
    },
    onDuplicateProgress: () => () => undefined,
    cancelDuplicate: () => undefined,
    deleteProject: async () => undefined
  },
  requestAnimationFrame: (cb: () => void) => fake.frames.push(cb),
  cancelAnimationFrame: () => undefined,
  addEventListener: (type: string, fn: (e: unknown) => void) => void (type === 'keydown' && fake.keys.push(fn)),
  removeEventListener: (type: string, fn: (e: unknown) => void) => {
    if (type === 'keydown') fake.keys = fake.keys.filter((f) => f !== fn)
  },
  dispatchEvent: () => true
})
// The copy menu listens for presses on the page while it is open; the copies measure text on a canvas.
vi.stubGlobal('document', { addEventListener: () => undefined, removeEventListener: () => undefined, activeElement: null, body: {}, createElement: () => ({ getContext: () => null }) })
vi.doMock('react-dom', async (importOriginal) => ({ ...(await importOriginal<Record<string, unknown>>()), createPortal: (child: unknown) => child }))
/** What the dialog asked of useModalFocus: its Esc action. */
export const modal = { onClose: null as (() => void) | null }
vi.doMock('../src/renderer/src/editor/modalFocus', () => ({ useModalFocus: (_ref: unknown, onClose: () => void) => void (modal.onClose = onClose) }))

mockReact()
// Renderer code: imported at run time so the Node typecheck of tests/ does not follow it.
const PANEL = '../src/renderer/src/clips/ShortClipsPanel'
const DIALOG = '../src/renderer/src/clips/ShortVersionDialog'
const MENU = '../src/renderer/src/editor/CopyMenu'
export type Props = { project: Project; cursor: typeof NO_TRACK; vw: number; vh: number; onClose(): void; onOpen(id: string): void }
export const { ShortClipsPanel } = (await import(/* @vite-ignore */ PANEL)) as { ShortClipsPanel: (p: Props) => unknown }
export const { ShortVersionDialog } = (await import(/* @vite-ignore */ DIALOG)) as { ShortVersionDialog: (p: Props) => unknown }
export const { CopyMenu, SHORT_NEEDS_CAPTIONS } = (await import(/* @vite-ignore */ MENU)) as { CopyMenu: (p: Record<string, unknown>) => unknown; SHORT_NEEDS_CAPTIONS: string }
await useEditorContexts()

/** The preview player: seek, play and pause, its time moved by the test. */
export const player = {
  time: 0,
  playing: false,
  pauses: 0,
  get moving(): boolean {
    return this.playing
  },
  seek(t: number) {
    this.time = t
  },
  play() {
    this.playing = true
  },
  pause() {
    this.playing = false
    this.pauses++
  }
}
/** Runs the animation frames asked for so far. */
export const frame = (): void => {
  const run = fake.frames.splice(0)
  run.forEach((f) => f())
}

export const bench = { store: null as unknown as EditStore<Project> }
export const closes: number[] = []
export const opened: string[] = []
export const el = (Component: (p: Props) => unknown, project: Project, vw = 1920, vh = 1080) => ({ type: Component, props: { project, cursor: NO_TRACK, vw, vh, onClose: () => closes.push(1), onOpen: (id: string) => opened.push(id) } })
export const press = (e: El | undefined): void => {
  expect(e, 'element').toBeDefined()
  ;(e!.props.onClick as () => void)()
}
export const change = (e: El | undefined, value: unknown): void => {
  expect(e, 'element').toBeDefined()
  ;(e!.props.onChange as (ev: unknown) => void)({ target: { value, checked: value } })
}

/** A narrated 3-minute project. */
export function narrated(over: Partial<Project> = {}): Project {
  return clipProject({ said: steadyTalk(36, { every: 5 }), duration: 185, ...over })
}

/** A fresh mount: every fake as new. */
export function reset(): void {
  unmountAll()
  fake.prefs.clear()
  fake.copies.length = 0
  fake.projects = []
  fake.cost = { linked: true, bytes: 1000, free: 1e12 }
  fake.frames.length = 0
  fake.commands.length = 0
  fake.levels = {}
  fake.providers = []
  fake.ai.length = 0
  fake.answer = (request) => Promise.resolve({ task: 'names', names: [], request })
  fake.cancelled.length = 0
  fake.keys = []
  closes.length = 0
  opened.length = 0
  Object.assign(player, { time: 0, playing: false, pauses: 0 })
  modal.onClose = null
}

/** The editor's store and group for `project`. */
export function editing(project: Project): EditStore<Project> {
  bench.store = new EditStore<Project>(project)
  contexts.editor = { store: bench.store, player }
  contexts.group = { group: { keys: [] }, keys: new Set(), single: null, select: () => undefined, notice: () => undefined, command: (id: string) => fake.commands.push(id) }
  return bench.store
}

/** The panel over `project`, rendered from the store's state each time. */
export function mount(project: Project): () => unknown {
  const store = editing(project)
  return () => el(ShortClipsPanel, store.state)
}
