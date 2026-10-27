import { beforeEach, describe, expect, it, vi } from 'vitest'
import type { SpeechState } from '../src/shared/api/speech'
import { createProject } from '../src/shared/engine/project'
import { SPEECH_MODELS, type SpeechModelId } from '../src/shared/speech/catalog'
import type { CursorTrack, Project } from '../src/shared/types'

/*
 * Where the Polish dialog puts the focus when it opens (E-01-2), without a DOM: React's hooks are
 * swapped for a few lines that keep the dialog's state (as in notesCard.test.ts), each ref is
 * pointed at a stand-in for its element before the effects run (a disabled button ignores
 * focus(), as in a browser), and window.api answers the dialog's reads once a test lets it.
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
  ref?: unknown
}

let cells: Cell[] = []
let at = 0
let effects: (() => void)[] = []
let dirty = false
const cell = (): Cell => (cells[at++] ??= {})
const changed = (a: readonly unknown[] | undefined, b: readonly unknown[] | undefined): boolean => !a || !b || a.length !== b.length || a.some((v, i) => !Object.is(v, b[i]))

function deferred(): { promise: Promise<void>; resolve: () => void } {
  let resolve!: () => void
  const promise = new Promise<void>((a) => (resolve = a))
  return { promise, resolve }
}

/** The dialog's reads (options, presets, providers) wait for this; `remembered` is the 'polish' preference. */
let gate = deferred()
let remembered: unknown = null
/** The speech state the main process answers; null: no handler (On this PC unavailable, as in the focus tests). */
let speechReply: SpeechState | null = null
vi.stubGlobal('window', {
  api: {
    getPref: (key: string) => gate.promise.then(() => (key === 'polish' ? remembered : null)),
    setPref: () => Promise.resolve(),
    listAiProviders: () => gate.promise.then(() => []),
    getSpeechState: () => (speechReply ? Promise.resolve(speechReply) : Promise.reject(new Error('No handler registered for speech:state'))),
    onSpeechState: () => () => undefined
  },
  addEventListener: () => undefined,
  removeEventListener: () => undefined
})
vi.stubGlobal('document', { body: {} })

/** A silent recording without camera or clicks: no step but Style can run. */
const project: Project = createProject({
  id: 'p1',
  name: 'p1',
  duration: 12,
  width: 1280,
  height: 720,
  hasWebcam: false,
  hasAudio: false,
  webcamOffset: 0,
  zooms: [],
  cursorValid: false,
  capture: { method: 'chromium', cursorInVideo: false, region: null }
})
/** The project the dialog polishes (a test may give it sound). */
let current: Project = project
const store = {
  get state() {
    return current
  },
  subscribe: () => () => undefined,
  getSnapshot: () => current
}

vi.doMock('react', async (importOriginal) => ({
  ...(await importOriginal<Record<string, unknown>>()),
  useState: (init: unknown) => {
    const c = cell()
    if (!('value' in c)) c.value = typeof init === 'function' ? (init as () => unknown)() : init
    const set = (v: unknown): void => {
      const next = typeof v === 'function' ? (v as (x: unknown) => unknown)(c.value) : v
      if (Object.is(next, c.value)) return
      c.value = next
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
  useSyncExternalStore: (_subscribe: unknown, get: () => unknown) => get(),
  // useEditor() is the only context the dialog reads.
  useContext: () => ({ store, player: {} })
}))
// Tab and Esc are not what is tested, and the hook reads the real document.
vi.doMock('../src/renderer/src/editor/modalFocus', () => ({ useModalFocus: () => undefined }))

// Renderer code: imported at run time so the Node typecheck of tests/ does not follow it.
const DIALOG = '../src/renderer/src/editor/PolishDialog'
const SPEECH_STATE = '../src/renderer/src/editor/speechState'
const { PolishDialog } = (await import(/* @vite-ignore */ DIALOG)) as { PolishDialog: (props: unknown) => unknown }

const NO_INPUT: CursorTrack = { samples: [], clicks: [], keys: [], valid: false }

const textOf = (node: unknown): string =>
  Array.isArray(node) ? node.map(textOf).join('') : typeof node === 'string' || typeof node === 'number' ? String(node) : node && typeof node === 'object' && 'props' in node ? textOf((node as El).props.children) : ''

/** Every element in the tree (child components are not called). */
function walk(node: unknown, out: El[]): El[] {
  if (Array.isArray(node)) {
    node.forEach((n) => walk(n, out))
    return out
  }
  if (!node || typeof node !== 'object' || !('props' in node)) return out
  const el = node as El
  out.push(el)
  walk(el.props.children, out)
  return out
}

/** What has the focus: a button's text, 'panel' for the dialog itself, null while it is still behind the modal. */
let focused: string | null = null

/** A stand-in for the element a ref is on: a disabled button does not take the focus. */
function standIn(el: El): { disabled?: boolean; focus(): void } {
  const name = el.type === 'button' ? textOf(el.props.children).trim() : el.props.role === 'dialog' ? 'panel' : String(el.type)
  const disabled = el.type === 'button' ? el.props.disabled === true : undefined
  return {
    disabled,
    focus: () => {
      if (!disabled) focused = name
    }
  }
}

/** The dialog, rendered until its state and effects settle; the refs are attached before the effects run, as React does. */
function render(): El[] {
  for (let pass = 0; pass < 20; pass++) {
    dirty = false
    at = 0
    const out = walk(PolishDialog({ recorded: NO_INPUT, hasCameraFile: false, onClose: () => undefined, onDone: () => undefined }), [])
    for (const el of out) if (el.ref && typeof el.ref === 'object') (el.ref as { current: unknown }).current = standIn(el)
    const run = effects
    effects = []
    run.forEach((e) => e())
    if (!dirty) return out
  }
  throw new Error('The dialog keeps rendering')
}

const flush = (): Promise<void> => new Promise((r) => setTimeout(r, 0))
const polishButton = (out: El[]): El | undefined => out.find((e) => e.type === 'button' && textOf(e.props.children).trim() === 'Polish')

beforeEach(() => {
  for (const c of cells) c.cleanup?.()
  cells = []
  effects = []
  focused = null
  gate = deferred()
  remembered = null
  speechReply = null
  current = project
})

describe('Polish dialog: the focus when it opens (E-01-2)', () => {
  it('is on the panel while the options are read, then on Polish', async () => {
    remembered = { styleId: 'studio' }
    expect(polishButton(render())?.props.disabled).toBe(true)
    expect(focused).toBe('panel')
    gate.resolve()
    await flush()
    expect(polishButton(render())?.props.disabled).toBe(false)
    expect(focused).toBe('Polish')
  })

  it('stays on the panel when no step can run, so Enter cannot reach a button behind the dialog', async () => {
    gate.resolve()
    render()
    await flush()
    const button = polishButton(render())
    expect(button?.props.disabled).toBe(true)
    expect(button?.props.title).toBe('Choose at least one step')
    expect(focused).toBe('panel')
  })
})

describe('Polish dialog: the Bangla model (docs/design/offline-captions.md §14.4)', () => {
  const state = (installed: SpeechModelId[]): SpeechState => ({
    engine: { available: true, build: 'standard', threads: 3 },
    detector: { available: true },
    models: SPEECH_MODELS.map((m) => ({
      id: m.id,
      tier: m.tier,
      name: m.name,
      bytes: m.bytes,
      rtf4: m.rtf4,
      ramMB: m.ramMB,
      wer: m.wer,
      partSeconds: m.partSeconds,
      license: m.license,
      status: { state: installed.includes(m.id) ? 'installed' : 'missing' },
      inUse: false,
      allowed: true
    })),
    defaultModel: 'whisper-base',
    disk: { free: 1e11, used: 0 },
    memory: { total: 16e9, free: 8e9 },
    cores: 4
  })
  const captionsHint = (out: El[]): string => textOf(out.find((e) => e.props['data-testid'] === 'polish-row-captions')?.props.children)

  it('with Bengali chosen in the Captions tab and the Bangla model downloaded, the Captions row says it uses it', async () => {
    const speech = (await import(/* @vite-ignore */ SPEECH_STATE)) as { setSpokenLanguage(code: string): void; loadSpeechState(force?: boolean): void }
    current = { ...project, hasAudio: true }
    speechReply = state(['whisper-base', 'whisper-bn-medium'])
    speech.loadSpeechState(true)
    gate.resolve()
    speech.setSpokenLanguage('bn')
    render()
    await flush()
    await flush()
    expect(captionsHint(render())).toContain('Runs on this PC with the Bangla model: nothing is uploaded and it costs nothing.')
    speech.setSpokenLanguage('en')
    expect(captionsHint(render())).toContain('Runs on this PC: nothing is uploaded and it costs nothing.')
    speech.setSpokenLanguage('')
  })
})
