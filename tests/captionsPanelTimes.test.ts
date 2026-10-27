import { beforeEach, describe, expect, it, vi } from 'vitest'
import { MAX_CAPTIONS } from '../src/shared/captions/captionData'

/*
 * The times the Captions tab shows are video time (docs/design/freeze-frame.md §4.7): a pause
 * freeze before a caption moves its row time and the "captions after X were left out" notice, as
 * it moves the Transport and the subtitle files. The tab is rendered once without a DOM: React's
 * hooks give their first value and run no effects, which is all the rows need.
 */

interface El {
  type: unknown
  props: Record<string, unknown>
}

const player = { time: 0, subscribe: () => () => undefined, getPlaying: () => false, seek: () => undefined }
let store: { state: Record<string, unknown>; update: (fn: (p: Record<string, unknown>) => Record<string, unknown>) => void }

let reply: unknown = null
vi.stubGlobal('window', {
  api: {
    transcribe: () => Promise.resolve(reply),
    onTranscribeProgress: () => () => undefined
  }
})

vi.doMock('react', async (importOriginal) => ({
  ...(await importOriginal<Record<string, unknown>>()),
  useState: (init: unknown) => [typeof init === 'function' ? (init as () => unknown)() : init, () => undefined],
  useRef: (current: unknown) => ({ current }),
  useMemo: (fn: () => unknown) => fn(),
  useCallback: (fn: unknown) => fn,
  useEffect: () => undefined,
  useSyncExternalStore: (_subscribe: unknown, get: () => unknown) => get(),
  // useEditor() is the context the rows read (the keymap's shortcuts are left out of the tooltips).
  useContext: () => ({ store, player })
}))

// Renderer code: imported at run time so the Node typecheck of tests/ does not follow it.
const PANEL = '../src/renderer/src/editor/panels/CaptionsPanel'
const ITEMS = '../src/renderer/src/editor/captionItems'
const { CaptionsPanel } = (await import(/* @vite-ignore */ PANEL)) as { CaptionsPanel: (props: unknown) => El }
const items = (await import(/* @vite-ignore */ ITEMS)) as {
  transcribe(services: unknown, options: { providerId: string }): Promise<boolean>
  transcriptionJob(): { notice?: string } | null
  clearTranscriptionError(): void
}

/** Every element under `node`; the transcript section is called (its rows are what is read). */
function walk(node: unknown, out: El[]): El[] {
  if (Array.isArray(node)) node.forEach((n) => walk(n, out))
  else if (node && typeof node === 'object' && 'props' in node) {
    const el = node as El
    if (typeof el.type === 'function' && el.type.name === 'TranscriptSection') return walk((el.type as (p: unknown) => unknown)(el.props), out)
    out.push(el)
    walk(el.props.children, out)
  }
  return out
}

const textOf = (node: unknown): string =>
  Array.isArray(node) ? node.map(textOf).join('') : typeof node === 'string' || typeof node === 'number' ? String(node) : node && typeof node === 'object' && 'props' in node ? textOf((node as El).props.children) : ''

/** The time buttons and the text fields' labels of the caption rows. */
function rows(): { times: string[]; labels: string[] } {
  const out = walk(CaptionsPanel({ project: store.state, selection: null, onSelect: () => undefined, onNotice: () => undefined }), [])
  return {
    times: out.filter((e) => e.props.className === 'caption-time').map((e) => textOf(e.props.children)),
    labels: out.filter((e) => e.props.className === 'caption-text').map((e) => e.props['aria-label'] as string)
  }
}

/** A 3 s pause freeze at 2 s of the recording. */
const PAUSE = [{ id: 'f', at: 2, length: 3, sound: 'pause' }]

beforeEach(() => {
  items.clearTranscriptionError()
  const state: Record<string, unknown> = { id: 'p1', duration: 100000, clips: [{ id: 'c', start: 0, end: 100000, speed: 1 }], hasAudio: true }
  store = {
    state,
    update(fn) {
      store.state = fn(store.state)
    }
  }
})

describe('Captions tab: caption row times are video time', () => {
  const transcript = { provider: 'openai', model: 'm', createdAt: '', segments: [{ id: 'a', start: 5, end: 6, text: 'hi' }] }

  it('without freezes: the recording time, as before', () => {
    store.state = { ...store.state, transcript }
    expect(rows()).toEqual({ times: ['0:05.0'], labels: ['Caption at 0:05.0'] })
  })

  it('past a pause freeze before it: where the Transport and the exported SRT put it', () => {
    store.state = { ...store.state, transcript, freezes: PAUSE }
    expect(rows()).toEqual({ times: ['0:08.0'], labels: ['Caption at 0:08.0'] })
  })
})

describe('Captions tab: "the captions after X were left out" is video time', () => {
  // More captions than a project keeps; the last kept one ends at (5000 - 1) * 3 + 2 = 14999 s.
  const tooMany = { provider: 'openai', model: 'm', createdAt: '', segments: Array.from({ length: MAX_CAPTIONS + 10 }, (_, i) => ({ id: `s${i}`, start: i * 3, end: i * 3 + 2, text: `caption ${i}` })) }

  it('without freezes: 249:59', async () => {
    reply = tooMany
    expect(await items.transcribe({ store }, { providerId: 'x' })).toBe(true)
    expect(items.transcriptionJob()?.notice).toContain('the captions after 249:59 were left out')
  })

  it('past a pause freeze: 3 s later', async () => {
    reply = tooMany
    store.state = { ...store.state, freezes: PAUSE }
    expect(await items.transcribe({ store }, { providerId: 'x' })).toBe(true)
    expect(items.transcriptionJob()?.notice).toContain('the captions after 250:02 were left out')
  })
})
