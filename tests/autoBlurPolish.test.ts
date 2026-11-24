import { beforeEach, describe, expect, it, vi } from 'vitest'
import type { FindRequest, FindResult, PrivacyGathered, ReaderState } from '../src/shared/api/privacy'
import { DEFAULT_POLISH_OPTIONS, planPolish, type PolishInput } from '../src/shared/editor/polish'
import { polishResultLines } from '../src/shared/editor/polishCopy'
import { firstEstimate } from '../src/shared/privacy/plan'
import { minutesOf } from '../src/shared/privacy/findState'
import type { Project, Transcript } from '../src/shared/types'
import { byTestId, contexts, mockReact, settle, textOf, unmountAll, useEditorContexts, type El } from './studioHarness'
import { base, words } from './autoBlurFixtures'

/*
 * Polish's *Find private info* step (docs/design/auto-blur.md §2.10, §14.5; §17.1 tests 173 and 252):
 * the row only with the reader downloaded, on for new options and off for saved ones, its hint with
 * the first estimate or *already checked*, listening only when the screen was read with the same
 * choices, and the result lines. The dialog is rendered without a DOM; main is a fake.
 */

const api = {
  prefs: new Map<string, unknown>(),
  reader: { status: 'ready', bytes: 1, decodeMs: 2.5 } as ReaderState,
  find: null as null | ((req: FindRequest) => Promise<FindResult>),
  requests: [] as FindRequest[]
}
vi.stubGlobal('document', { activeElement: null, body: {}, querySelector: () => null })
vi.stubGlobal('window', {
  setTimeout: (fn: () => void) => setTimeout(fn, 0),
  clearTimeout: (id: number) => clearTimeout(id),
  addEventListener: () => undefined,
  removeEventListener: () => undefined,
  dispatchEvent: () => true,
  api: {
    getPref: async (k: string) => api.prefs.get(k) ?? null,
    setPref: async (k: string, v: unknown) => void api.prefs.set(k, v),
    listAiProviders: async () => [],
    getSpeechState: () => Promise.reject(new Error('No handler registered for speech:state')),
    onSpeechState: () => () => undefined,
    readerState: async () => api.reader,
    onReaderState: () => () => undefined,
    onFindProgress: () => () => undefined,
    findPrivate: (req: FindRequest) => {
      api.requests.push(req)
      return api.find!(req)
    },
    stopFind: async () => undefined
  }
})
for (const name of ['HTMLElement', 'HTMLButtonElement']) vi.stubGlobal(name, class {})
// Captions on this PC are not what is tested: their state is never read here, which the dialog logs.
vi.spyOn(console, 'warn').mockImplementation(() => undefined)
mockReact()
vi.doMock('../src/renderer/src/editor/modalFocus', () => ({ useModalFocus: () => undefined }))

// Renderer code: imported at run time so the Node typecheck of tests/ does not follow it.
const load = async <T>(file: string): Promise<T> => (await import(/* @vite-ignore */ `../src/renderer/src/${file}`)) as T
const { PolishDialog } = await load<{ PolishDialog: (p: unknown) => unknown }>('editor/PolishDialog')
const reader = await load<{ resetReaderState(): void; startReaderState(): void }>('privacy/readerState')
const run = await load<{ gatherPrivacy(p: Project, c: Transcript | null, s: AbortSignal): Promise<PrivacyGathered | null> }>('privacy/privacyRun')
const runs = await load<{ resetRuns(): void }>('privacy/findRuns')
await useEditorContexts()

const READER = 'pp-ocrv6-tiny+small-careful-long'
const SKIP = ['CostLine', 'Chips', 'EditorIcon']
const NO_INPUT = { samples: [], clicks: [], keys: [], valid: false }
const flush = async (): Promise<void> => {
  for (let i = 0; i < 10; i++) await Promise.resolve()
  await new Promise((r) => setTimeout(r, 0))
}
const captions = (text: string): Transcript => ({ language: 'en', provider: 'local', model: 'm', createdAt: '2026-11-20T10:00:00.000Z', segments: [words('c1', 10, text)] })
const ok = (req: FindRequest, over: Partial<Extract<FindResult, { ok: true }>> = {}): FindResult => ({ ok: true, projectId: req.projectId, requestId: req.requestId, found: [{ kind: 'email', score: 0.6, group: 'g1', start: 1, end: 3, path: '1 0.1 0.1 0.2 0.05', color: '#202020' }], failedReads: 0, thinSpans: '', stopped: false, readTo: null, reader: READER, ...over })

async function readerIs(state: ReaderState | null): Promise<void> {
  reader.resetReaderState()
  if (!state) return
  api.reader = state
  reader.startReaderState()
  await flush()
}
async function dialog(p: Project): Promise<El[]> {
  unmountAll()
  contexts.editor = { store: { state: p, subscribe: () => () => undefined, getSnapshot: () => p }, player: {} }
  return settle({ type: PolishDialog, props: { recorded: NO_INPUT, hasCameraFile: false, onClose: () => undefined, onDone: () => undefined } }, SKIP)
}
const row = (els: El[]): El | undefined => byTestId(els, 'polish-row-privacy')
const box = (els: El[]): El | undefined => els.find((e) => e.type === 'input' && e.props.id === 'polish-step-privacy')
/** The plan of a Polish that runs only Find private info, from what was gathered. */
const planned = (p: Project, privacy: PrivacyGathered | null): ReturnType<typeof planPolish> => {
  const input: PolishInput = { project: p, recorded: NO_INPUT as never, sound: null, transcript: null, speech: null, framing: { status: 'skipped' } as never, preset: null, privacy }
  return planPolish(input, { ...DEFAULT_POLISH_OPTIONS, zoom: false, silences: false, smoothCuts: false, captions: false, chapters: false, captionLook: false, director: false })
}
const privacyLine = (r: ReturnType<typeof planPolish>): string => polishResultLines(r.summary).find((l) => l.step === 'privacy')!.text

beforeEach(() => {
  api.prefs.clear()
  api.requests.length = 0
  api.find = async (req) => ok(req)
  runs.resetRuns()
  contexts.keymap = null
  contexts.group = null
})

describe('auto-blur P5: Polish', () => {
  it('173. Polish: the row shows only with the reader; on for new options, off for saved ones; the result lines', async () => {
    const p = base('po', 30)
    // Not known, or not downloaded: no row, as before.
    await readerIs(null)
    expect(row(await dialog(p))).toBeUndefined()
    await readerIs({ status: 'none' })
    expect(row(await dialog(p))).toBeUndefined()
    await readerIs({ status: 'unavailable', reason: 'helper' })
    expect(row(await dialog(p))).toBeUndefined()
    // Downloaded: the row, last, on for new options.
    await readerIs({ status: 'ready', bytes: 1, decodeMs: null })
    let els = await dialog(p)
    expect(row(els)).toBeDefined()
    expect(els.filter((e) => String(e.props['data-testid'] ?? '').startsWith('polish-row-')).at(-1)!.props['data-testid']).toBe('polish-row-privacy')
    expect(textOf(els.find((e) => e.type === 'label' && textOf(e).startsWith('Find private info')))).toContain('Find private info')
    expect(box(els)!.props.checked).toBe(true)
    // Options saved before the step existed: off.
    api.prefs.set('polish', { zoom: true })
    els = await dialog(p)
    expect(box(els)!.props.checked).toBe(false)
    // The result lines.
    const g = (over: Partial<PrivacyGathered>): PrivacyGathered => ({ covers: undefined, said: [], privacy: {}, found: 0, check: 0, listenedOnly: false, unfinished: false, ...over })
    expect(privacyLine(planned(p, g({ found: 0 })))).toBe('Find private info: nothing private found')
    expect(privacyLine(planned(p, g({ found: 1 })))).toBe('Find private info: 1 private item')
    expect(privacyLine(planned(p, g({ found: 3, check: 1 })))).toBe('Find private info: 3 private items · 1 to check in Review')
    // Without the reader the step is skipped with its reason.
    expect(privacyLine(planned(p, null))).toBe('Find private info: the text reader is not downloaded.')
  })

  it('252. Polish: the hint names the first estimate; with a valid screen pass the step only listens and the result line is privacyListened; a stopped run gives privacyUnfinished', async () => {
    await readerIs({ status: 'ready', bytes: 1, decodeMs: 2.5 })
    const p: Project = { ...base('pe', 1800, { fps: 60 }), transcript: captions('hello') }
    const minutes = minutesOf(firstEstimate(p.duration, 60, { width: 1920, height: 1080 }, 2.5))
    expect(minutes).toBeGreaterThan(1)
    let els = await dialog(p)
    expect(textOf(row(els)!.props.children)).toContain(`Covers passwords, keys, codes and other private text, and bleeps secrets said aloud. About ${minutes} minutes on this PC.`)
    // This project's screen was read with these kinds and this reader, and the run finished: only the new captions are listened to.
    const checked: Project = { ...p, privacy: { find: { at: '2026-11-22T10:00:00.000Z', kinds: ['password', 'code', 'qr', 'key', 'link', 'email', 'card', 'phone', 'id', 'name', 'notice'], listened: true, captionsSig: 'old', reader: READER } } }
    els = await dialog(checked)
    expect(textOf(row(els)!.props.children)).toContain('Already checked on screen. Listens to the new captions for secrets said aloud.')
    const fresh = captions('my card number is 4917 6123 4567 8904 thanks')
    const listened = (await run.gatherPrivacy(checked, fresh, new AbortController().signal))!
    expect(api.requests).toEqual([])
    expect(listened).toMatchObject({ listenedOnly: true, unfinished: false, found: 1 })
    expect(listened.said.map((b) => b.word.split(':')[1])).toEqual(['card'])
    // Nothing new said: the line says it only listened.
    const quiet = (await run.gatherPrivacy(checked, captions('hello there'), new AbortController().signal))!
    expect(privacyLine(planned(checked, quiet))).toBe('Find private info: already checked on screen; listened to the new captions')
    // A Find that stopped: the summary says to find again.
    api.find = async (req) => ok(req, { stopped: true, readTo: 600 })
    const stopped = (await run.gatherPrivacy(p, fresh, new AbortController().signal))!
    expect(api.requests).toHaveLength(1)
    expect(stopped.unfinished).toBe(true)
    expect(privacyLine(planned(p, stopped))).toBe('Find private info did not finish. Find again before you share the video.')
  })
})
