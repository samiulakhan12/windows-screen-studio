import { beforeEach, describe, expect, it, vi } from 'vitest'
import { createProject } from '../src/shared/engine/project'
import { VOICE_COPY } from '../src/shared/audio/voiceCopy'
import type { Project } from '../src/shared/types'

/*
 * Audio › Voice (editor/panels/VoiceSection.tsx, docs/design/clean-voice.md §5) without a DOM, in
 * speechModelsSection.test.ts's way: React's hooks are swapped for a few lines that keep each
 * component's state by its place in the tree, and an element keeps its identity (React keeps
 * the DOM node, and its focus) while the same type stays at the same place. The stems store is
 * a stand-in whose state the tests set.
 */

interface Cell {
  value?: unknown
  current?: unknown
}
interface El {
  type: unknown
  props: Record<string, unknown>
  /** Its place in the tree: the same place across renders is the same DOM node. */
  at: string
}

const cells = new Map<string, Cell[]>()
let hooks: { cells: Cell[]; i: number } | null = null
const cell = (): Cell => (hooks!.cells[hooks!.i++] ??= {})

vi.doMock('react', async (importOriginal) => ({
  ...(await importOriginal<Record<string, unknown>>()),
  useRef: (init: unknown) => {
    const c = cell()
    if (!('current' in c)) c.current = init
    return c
  },
  useSyncExternalStore: (_subscribe: unknown, get: () => unknown) => get()
}))

type State = { state: string; progress?: number; file?: string; message?: string }
const stems = {
  state: { state: 'checking' } as State,
  original: false,
  calls: { cancel: 0, prepare: 0, original: [] as boolean[] },
  subscribe: () => () => undefined,
  getVersion: () => 0,
  get: () => stems.state,
  isOriginal: () => stems.original,
  setOriginal: (_id: string, on: boolean) => void stems.calls.original.push(on),
  prepare: () => {
    stems.calls.prepare++
    return Promise.resolve('voice-0123456789abcdef.m4a')
  },
  cancel: () => {
    stems.calls.cancel++
    return Promise.resolve()
  }
}
vi.doMock('../src/renderer/src/editor/voiceStems', () => ({ voiceStems: () => stems }))
vi.doMock('../src/renderer/src/editor/context', () => ({
  useEditor: () => ({ store: { update: () => undefined } }),
  holdGesture: () => undefined
}))

// Renderer code: imported at run time so the Node typecheck of tests/ does not follow it.
const SECTION = '../src/renderer/src/editor/panels/VoiceSection'
const { VoiceSection } = (await import(/* @vite-ignore */ SECTION)) as { VoiceSection: (props: { project: Project }) => unknown }

const RENDERED = new Set(['VoiceSection', 'VoiceStatus'])

function walk(node: unknown, path: string, out: El[]): void {
  if (Array.isArray(node)) return node.forEach((n, i) => walk(n, `${path}.${i}`, out))
  if (!node || typeof node !== 'object' || !('props' in node)) return
  const el = node as Omit<El, 'at'>
  const name = typeof el.type === 'function' ? el.type.name : String(el.type)
  if (typeof el.type === 'function' && RENDERED.has(name)) {
    if (!cells.has(path)) cells.set(path, [])
    hooks = { cells: cells.get(path)!, i: 0 }
    const child = (el.type as (p: unknown) => unknown)(el.props)
    hooks = null
    return walk(child, `${path}/${name}`, out)
  }
  const at = `${path}/${name}`
  out.push({ ...el, at })
  walk(el.props.children, at, out)
}

function render(project: Project): El[] {
  const out: El[] = []
  walk({ type: VoiceSection, props: { project } }, 'root', out)
  return out
}

const textOf = (node: unknown): string =>
  Array.isArray(node) ? node.map(textOf).join('') : typeof node === 'string' || typeof node === 'number' ? String(node) : node && typeof node === 'object' && 'props' in node ? textOf((node as El).props.children) : ''
const button = (out: El[]): El | undefined => out.find((e) => e.type === 'button' && String(e.props.className).includes('voice-action'))
/** A keyboard press (Enter) on `el`. */
const press = (el: El): void => (el.props.onClick as (e: { detail: number }) => void)({ detail: 0 })

function project(on: boolean): Project {
  const p = createProject({
    id: 'p',
    name: 'p',
    duration: 60,
    width: 1920,
    height: 1080,
    hasWebcam: false,
    hasAudio: true,
    webcamOffset: 0,
    zooms: [],
    cursorValid: false,
    capture: { method: 'native', cursorInVideo: false, region: null, fps: 60 }
  })
  p.audio = { ...p.audio, voice: { on, strength: 'normal' } }
  return p
}

beforeEach(() => {
  cells.clear()
  stems.state = { state: 'checking' }
  stems.original = false
  stems.calls = { cancel: 0, prepare: 0, original: [] }
})

describe('the Voice section', () => {
  it('keeps the status button (and its focus) while the stem is checked again', () => {
    stems.state = { state: 'ready', file: 'voice-0123456789abcdef.m4a' }
    const ready = button(render(project(true)))!
    expect(textOf(ready.props.children)).toBe(VOICE_COPY.original)
    // Undo back to a strength whose render was replaced: the store checks it again.
    stems.state = { state: 'checking' }
    const checking = button(render(project(true)))
    expect(checking?.at).toBe(ready.at)
    expect(checking?.props['aria-disabled']).toBe(true)
    press(checking!)
    expect(stems.calls.original).toEqual([])
    // It turns out to be missing and is made: the same button is Cancel.
    stems.state = { state: 'working', progress: 0 }
    const working = button(render(project(true)))!
    expect(working.at).toBe(ready.at)
    expect(textOf(working.props.children)).toBe(VOICE_COPY.cancel)
    expect(working.props['aria-disabled']).toBeUndefined()
    press(working)
    expect(stems.calls.cancel).toBe(1)
  })

  it('shows no button while the stem is first checked', () => {
    stems.state = { state: 'checking' }
    expect(button(render(project(true)))).toBeUndefined()
  })
})
