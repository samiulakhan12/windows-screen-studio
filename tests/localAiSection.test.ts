/**
 * Settings › AI on this PC and the text tools' side of it (docs/design/smart-tools.md §2.5, §14,
 * §22 tests 76 and 77): the PC's line, one row per model with Download, its progress with Cancel,
 * then Remove; a row the PC cannot use says why and has no Download; the suggestion by memory; Use;
 * the measured-speed line; "Flown could not check this PC's processor"; a finished download
 * announced; the AI providers' row; On this PC offered only when a model is ready and usable, with
 * the catalogue's note beside it; the progress beside a busy button with its value text and Stop.
 * window.api is a fake (React's hooks swapped, tests/studioHarness.ts); nothing leaves the test.
 */
import { readFileSync } from 'node:fs'
import path from 'node:path'
import { createElement } from 'react'

/** createElement for the components imported at run time. */
const h = (type: unknown, props: Record<string, unknown>): unknown => createElement(type as never, props as never)
import { beforeEach, describe, expect, it, vi } from 'vitest'
import type { LocalAiProgress, LocalAiState, LocalModelId, LocalModelState } from '../src/shared/api/localAi'
import type { AiProviderInfo } from '../src/shared/api/ai'
import { byLabel, byTestId, button, mockReact, render, settle, textOf, unmountAll, type El } from './studioHarness'

const GIB = 2 ** 30
const fake = vi.hoisted(() => ({
  calls: [] as unknown[][],
  state: null as unknown,
  stateListener: null as ((s: unknown) => void) | null,
  progressListeners: [] as ((p: unknown) => void)[]
}))
vi.stubGlobal('window', {
  api: {
    localAiState: async () => fake.state,
    onLocalAiState: (l: (s: unknown) => void) => {
      fake.stateListener = l
      return () => undefined
    },
    onLocalAiProgress: (l: (p: unknown) => void) => {
      fake.progressListeners.push(l)
      return () => {
        fake.progressListeners = fake.progressListeners.filter((x) => x !== l)
      }
    },
    downloadLocalModel: (id: string) => {
      fake.calls.push(['download', id])
      return new Promise(() => undefined)
    },
    cancelLocalDownload: async (id: string) => void fake.calls.push(['cancel', id]),
    removeLocalModel: async (id: string) => {
      fake.calls.push(['remove', id])
      return fake.state
    },
    setLocalModelUse: async (use: string) => {
      fake.calls.push(['use', use])
      return { ...(fake.state as LocalAiState), use }
    }
  },
  addEventListener: () => undefined,
  removeEventListener: () => undefined
})
vi.stubGlobal('document', { body: {}, activeElement: {}, querySelector: () => null })
// Whether the last input was a key (focus.ts keeps it from the window's events, which these tests have not).
const keys = vi.hoisted(() => ({ last: false }))
vi.mock('../src/renderer/src/editor/focus', async (importOriginal) => ({ ...(await importOriginal<Record<string, unknown>>()), lastInputWasKey: () => keys.last }))
mockReact()

// Renderer code: imported at run time so the Node typecheck of tests/ does not follow it.
const SECTION = '../src/renderer/src/settings/LocalAiSection'
const PROGRESS = '../src/renderer/src/ai/LocalProgress'
const STATE = '../src/renderer/src/ai/localAiState'
const CHOICES = '../src/renderer/src/ai/textChoices'
type Component = (props: never) => unknown
type Choice = { id: string; label: string; kind: string }
const { LocalAiRow, LocalAiSection, readyAnnouncement } = (await import(/* @vite-ignore */ SECTION)) as {
  LocalAiRow: Component
  LocalAiSection: Component
  readyAnnouncement(before: LocalAiState | null, after: LocalAiState): string
}
const { LocalNote, LocalProgress, LocalWritten, localNotesFor, progressValueText } = (await import(/* @vite-ignore */ PROGRESS)) as {
  LocalNote: Component
  LocalProgress: Component
  LocalWritten: Component
  localNotesFor(state: LocalAiState | null, choice: { kind: string } | null, tasks: readonly string[], kind?: string): string[]
  progressValueText(p: LocalAiProgress): string
}
const { localReady, setLocalAiState } = (await import(/* @vite-ignore */ STATE)) as { localReady(state: LocalAiState): boolean; setLocalAiState(state: LocalAiState): void }
const { textChoicesOf, LOCAL_CHOICE } = (await import(/* @vite-ignore */ CHOICES)) as {
  textChoicesOf(providers: readonly AiProviderInfo[], task: string, localReady: boolean): Choice[]
  LOCAL_CHOICE: Choice
}

const model = (id: LocalModelId, state: LocalModelState['state'], over: Partial<LocalModelState> = {}): LocalModelState => ({
  id,
  state,
  bytes: id === 'gemma4-e2b' ? 3_106_738_272 : 1_280_835_840,
  block: null,
  ...over
})
const pcOf = (over: Partial<LocalAiState['pc']> = {}): LocalAiState['pc'] => ({ totalMemBytes: 16 * GIB, freeMemBytes: 9 * GIB, avx2: true, helper: true, ...over })
const stateOf = (models: LocalModelState[], over: Partial<LocalAiState> = {}): LocalAiState => ({ models, use: 'auto', active: null, pc: pcOf(), speeds: {}, ...over })

beforeEach(() => {
  unmountAll()
  fake.calls.length = 0
  fake.progressListeners = []
})

/** Shows `state` in the section (as main's answer and the changed event put it in place). */
async function section(state: LocalAiState): Promise<{ out: () => Promise<El[]>; root: unknown }> {
  fake.state = state
  setLocalAiState(state)
  const root = h(LocalAiSection, { reveal: false })
  return { root, out: () => settle(root) }
}
const rows = (out: El[]): El[] => out.filter((e) => e.props.className === 'local-ai-model')
const rowOf = (out: El[], id: LocalModelId): El => rows(out).find((r) => r.props['data-model'] === id)!
const inRow = (row: El): El[] => {
  const found: El[] = []
  const visit = (n: unknown): void => {
    if (Array.isArray(n)) return n.forEach(visit)
    if (!n || typeof n !== 'object' || !('props' in n)) return
    const el = n as El
    if (typeof el.type === 'string') found.push(el)
    visit(el.props.children)
  }
  visit(row.props.children)
  return found
}

describe('Settings › AI on this PC (test 76)', () => {
  it('the PC’s line and one row per model: name, size, hint, licence and a Download that says its size; Recommended suggested on a 16 GB PC', async () => {
    const { out } = await section(stateOf([model('gemma4-e2b', 'missing'), model('qwen3.5-2b', 'missing')]))
    const els = await out()
    expect(textOf(byTestId(els, 'local-ai-pc'))).toBe('This PC: 16 GB of memory · processor OK')
    expect(rows(els)).toHaveLength(2)
    const rec = inRow(rowOf(els, 'gemma4-e2b'))
    expect(textOf(rec.find((e) => e.props.className === 'local-ai-head'))).toBe('Recommended · Gemma 4 E2B · 3.1 GBSuggested for this PC')
    expect(textOf(rec.find((e) => e.props.className === 'local-ai-hint'))).toBe('Every language, including Bangla. Needs 12 GB of memory.')
    expect(textOf(rec.find((e) => e.props.className === 'local-ai-licence'))).toBe('Apache-2.0 · Google')
    expect(byLabel(els, 'Download Recommended, 3.1 gigabytes')).toBeDefined()
    const small = inRow(rowOf(els, 'qwen3.5-2b'))
    expect(textOf(small.find((e) => e.props.className === 'local-ai-licence'))).toBe('Apache-2.0 · Alibaba Cloud')
    expect(byLabel(els, 'Download Small, 1.3 gigabytes')).toBeDefined()
    // No Use before a model is downloaded.
    expect(els.some((e) => e.props.role === 'radiogroup')).toBe(false)
  })

  it('a row the PC cannot use says why and has no Download; Small is suggested on an 8 GB PC', async () => {
    const { out } = await section(stateOf([model('gemma4-e2b', 'missing', { block: 'memory' }), model('qwen3.5-2b', 'missing')], { pc: pcOf({ totalMemBytes: 8 * GIB }) }))
    const els = await out()
    const rec = inRow(rowOf(els, 'gemma4-e2b'))
    expect(textOf(rec.find((e) => e.props.className === 'local-ai-why'))).toBe('Needs 12 GB of memory; this PC has 8 GB')
    expect(byLabel(els, 'Download Recommended, 3.1 gigabytes')).toBeUndefined()
    expect(textOf(inRow(rowOf(els, 'qwen3.5-2b')).find((e) => e.props.className === 'local-ai-head'))).toContain('Suggested for this PC')
  })

  it('"Flown could not check this PC’s processor": the line and the rows say so, with no Download', async () => {
    const { out } = await section(stateOf([model('gemma4-e2b', 'missing', { block: 'processor' }), model('qwen3.5-2b', 'missing', { block: 'processor' })], { pc: pcOf({ avx2: null }) }))
    const els = await out()
    expect(textOf(byTestId(els, 'local-ai-pc'))).toBe("Flown could not check this PC's processor.")
    for (const id of ['gemma4-e2b', 'qwen3.5-2b'] as const) expect(textOf(inRow(rowOf(els, id)).find((e) => e.props.className === 'local-ai-why'))).toBe("Flown could not check this PC's processor.")
    expect(els.some((e) => e.type === 'button' && String(e.props['aria-label']).startsWith('Download'))).toBe(false)
    // A processor without AVX2, and a build without the helper.
    const old = await section(stateOf([model('qwen3.5-2b', 'missing', { block: 'processor' })], { pc: pcOf({ avx2: false }) }))
    expect(textOf(byTestId(await old.out(), 'local-ai-pc'))).toBe("This PC's processor is too old for AI on this PC (it needs AVX2).")
    const none = await section(stateOf([model('qwen3.5-2b', 'missing', { block: 'helper' })], { pc: pcOf({ helper: false }) }))
    expect(textOf(byTestId(await none.out(), 'local-ai-pc'))).toBe('AI on this PC is not part of this build.')
  })

  it('Download → progress with Cancel → ready, announced → Use → Remove after asking', async () => {
    const { out } = await section(stateOf([model('gemma4-e2b', 'missing'), model('qwen3.5-2b', 'missing')]))
    let els = await out()
    ;(byLabel(els, 'Download Recommended, 3.1 gigabytes')!.props.onClick as () => void)()
    expect(fake.calls).toEqual([['download', 'gemma4-e2b']])
    // Main's changed event: downloading, 1.2 GB so far.
    fake.state = stateOf([model('gemma4-e2b', 'downloading', { done: 1.2e9 }), model('qwen3.5-2b', 'missing')])
    setLocalAiState(fake.state as LocalAiState)
    els = await out()
    const bar = els.find((e) => e.type === 'progress' && e.props['aria-label'] === 'Downloading Recommended')!
    expect(bar.props).toMatchObject({ max: 3_106_738_272, value: 1.2e9, 'aria-valuetext': '1.2 of 3.1 gigabytes' })
    expect(textOf(inRow(rowOf(els, 'gemma4-e2b')).find((e) => e.props.className === 'local-ai-progress'))).toContain('1.2 of 3.1 GB')
    ;(byLabel(els, 'Cancel the download of Recommended')!.props.onClick as () => void)()
    expect(fake.calls[1]).toEqual(['cancel', 'gemma4-e2b'])
    // Ready: announced once, politely.
    const ready = stateOf([model('gemma4-e2b', 'ready'), model('qwen3.5-2b', 'missing')], { active: 'gemma4-e2b' })
    fake.state = ready
    setLocalAiState(ready)
    els = await out()
    expect(byTestId(els, 'local-ai-announce')!.props).toMatchObject({ role: 'status', 'aria-live': 'polite' })
    expect(textOf(byTestId(els, 'local-ai-announce'))).toBe('Recommended is ready')
    // Use: Automatic, and the downloaded model.
    const group = els.find((e) => e.props.role === 'radiogroup')!
    expect(group.props['aria-label']).toBe('Model for AI on this PC')
    const radios = els.filter((e) => e.type === 'input' && e.props.type === 'radio')
    expect(radios.map((r) => [r.props.value, r.props.checked])).toEqual([
      ['auto', true],
      ['gemma4-e2b', false]
    ])
    ;(radios[1].props.onChange as () => void)()
    expect(fake.calls[2]).toEqual(['use', 'gemma4-e2b'])
    // Remove asks first.
    ;(byLabel(els, 'Remove Recommended')!.props.onClick as () => void)()
    els = await out()
    const ask = els.find((e) => e.props.className === 'ai-remove-question')!
    expect(textOf(ask)).toContain('Remove the Recommended model (3.1 GB)? AI on this PC cannot use it until it is downloaded again.')
    expect(fake.calls).toHaveLength(3)
    ;(inRow(ask).find((e) => e.type === 'button' && textOf(e) === 'Remove')!.props.onClick as () => void)()
    expect(fake.calls[3]).toEqual(['remove', 'gemma4-e2b'])
  })

  it('announces only a download that ends, not a model that was there', () => {
    const before = stateOf([model('gemma4-e2b', 'downloading', { done: 5 }), model('qwen3.5-2b', 'ready')])
    const after = stateOf([model('gemma4-e2b', 'ready'), model('qwen3.5-2b', 'ready')])
    expect(readyAnnouncement(before, after)).toBe('Recommended is ready')
    expect(readyAnnouncement(null, after)).toBe('')
    expect(readyAnnouncement(after, after)).toBe('')
  })

  it('after the first run: the speeds measured on this PC for the model in use', async () => {
    const { out } = await section(stateOf([model('gemma4-e2b', 'ready')], { active: 'gemma4-e2b', speeds: { 'gemma4-e2b': { read: 400, write: 5.4 } } }))
    expect(textOf(byTestId(await out(), 'local-ai-speed'))).toBe('Measured on this PC: reads about 300 words a second and writes about 4.')
    const none = await section(stateOf([model('gemma4-e2b', 'ready')], { active: 'gemma4-e2b' }))
    expect(byTestId(await none.out(), 'local-ai-speed')).toBeUndefined()
  })

  it('Settings › AI providers’ first row: Set up opens the section; "Using Recommended" once a model is there', async () => {
    let opened = 0
    const row = h(LocalAiRow, { onOpen: () => opened++ })
    setLocalAiState(stateOf([model('gemma4-e2b', 'missing')]))
    let els = render(row)
    expect(textOf(els.find((e) => e.props.className === 'ai-provider-title'))).toBe('On this PCno key · good for drafts')
    ;(button(els, 'Set up')!.props.onClick as () => void)()
    expect(opened).toBe(1)
    setLocalAiState(stateOf([model('gemma4-e2b', 'ready')], { active: 'gemma4-e2b' }))
    els = render(row)
    expect(button(els, 'Set up')).toBeUndefined()
    expect(textOf(els.find((e) => e.props.className === 'local-ai-using'))).toBe('Using Recommended')
  })
})

const SERVICE: AiProviderInfo = { id: 'p1', kind: 'openai', label: 'My OpenAI', model: 'gpt', maskedKey: '…1234', createdAt: '' } as AiProviderInfo

describe('On this PC in the text tools (test 77)', () => {
  it('is offered only when a model is ready and this PC can use it', () => {
    expect(localReady(stateOf([model('gemma4-e2b', 'missing'), model('qwen3.5-2b', 'downloading', { done: 1 })]))).toBe(false)
    expect(localReady(stateOf([model('gemma4-e2b', 'ready', { block: 'memory' })]))).toBe(false)
    expect(localReady(stateOf([model('qwen3.5-2b', 'damaged')]))).toBe(false)
    expect(localReady(stateOf([model('qwen3.5-2b', 'ready')]))).toBe(true)
    // A pinned Use names a model that is not there: not offered.
    expect(localReady(stateOf([model('qwen3.5-2b', 'ready')], { use: 'gemma4-e2b' }))).toBe(false)
    expect(textChoicesOf([SERVICE], 'title', true).map((c) => c.label)).toEqual(['My OpenAI', 'On this PC (good for drafts)'])
    expect(textChoicesOf([SERVICE], 'title', false).map((c) => c.label)).toEqual(['My OpenAI'])
    // Never for the tasks it does not run (§9.7).
    for (const task of ['chapters', 'marks'] as const) expect(textChoicesOf([SERVICE], task, true).map((c) => c.id)).toEqual(['p1'])
  })

  it('the catalogue’s note for the task shows beside it, for the model a run would use', () => {
    const small = stateOf([model('qwen3.5-2b', 'ready')], { active: 'qwen3.5-2b' })
    expect(localNotesFor(small, LOCAL_CHOICE, ['title'])).toEqual(['Small: titles often repeat the first sentence'])
    expect(localNotesFor(small, LOCAL_CHOICE, ['title', 'summary'])).toEqual(['Small: titles often repeat the first sentence', 'Small: Bangla summaries are short'])
    // Step titles and chapter names are titles too.
    expect(localNotesFor(small, LOCAL_CHOICE, ['names'], 'step')).toEqual(['Small: titles often repeat the first sentence'])
    expect(localNotesFor(small, { kind: 'openai' }, ['title'])).toEqual([])
    const rec = stateOf([model('gemma4-e2b', 'ready')], { active: 'gemma4-e2b' })
    expect(localNotesFor(rec, LOCAL_CHOICE, ['title', 'summary'])).toEqual([])
    setLocalAiState(small)
    const els = render(h(LocalNote, { choice: LOCAL_CHOICE, tasks: ['title'] }))
    expect(textOf(byTestId(els, 'local-note'))).toBe('Small: titles often repeat the first sentence')
    expect(render(h(LocalNote, { choice: { kind: 'openai' }, tasks: ['title'] }))).toEqual([])
    expect(textOf(byTestId(render(h(LocalWritten, { show: true })), 'local-written'))).toBe('Written on this PC: check it before you use it.')
    expect(render(h(LocalWritten, { show: false }))).toEqual([])
  })
})

describe('the Captions tab’s AI tools with On this PC (§2.5)', () => {
  it('show the catalogue’s notes for a title and a summary beside the choice, and say a result was written on this PC', () => {
    const panel = readFileSync(path.resolve(__dirname, '../src/renderer/src/editor/panels/CaptionsPanel.tsx'), 'utf8')
    expect(panel).toContain("<LocalNote choice={choice} tasks={['title', 'summary']} />")
    expect(panel).toContain("setWrittenHere(chosen.kind === 'local')")
    expect(panel.split('<LocalWritten show={writtenHere} />')).toHaveLength(3)
  })
})

describe('the progress beside a busy button (§2.5, §14)', () => {
  const send = (p: LocalAiProgress): void => {
    for (const l of fake.progressListeners) l(p)
  }

  it('shows nothing until progress is heard for its request; then the phase, a bar named AI on this PC with its value text, and Stop', async () => {
    setLocalAiState(stateOf([model('qwen3.5-2b', 'ready')], { active: 'qwen3.5-2b' }))
    let stopped = 0
    const root = h(LocalProgress, { requestId: 'req-1', onStop: () => stopped++ })
    expect(render(root)).toEqual([])
    send({ requestId: 'other', phase: 'reading', done: 1, total: 2 })
    expect(await settle(root)).toEqual([])
    send({ requestId: 'req-1', phase: 'reading', done: 288, total: 640, secondsLeft: 30 })
    let els = await settle(root)
    expect(byTestId(els, 'local-progress')!.props['data-phase']).toBe('reading')
    expect(textOf(els.find((e) => e.props.className === 'local-progress-text'))).toBe('On this PC: reading the text… 45%')
    expect(els.find((e) => e.type === 'progress')!.props).toMatchObject({ 'aria-label': 'AI on this PC', 'aria-valuetext': 'Reading, 45 percent', value: 0.45 })
    expect(textOf(els.find((e) => e.props.role === 'status'))).toBe('On this PC: reading the text')
    send({ requestId: 'req-1', phase: 'writing', done: 16, total: 400, secondsLeft: 125 })
    els = await settle(root)
    expect(els.find((e) => e.type === 'progress')!.props['aria-valuetext']).toBe('Writing, about 2 minutes left')
    ;(byLabel(els, 'Stop AI on this PC')!.props.onClick as () => void)()
    expect(stopped).toBe(1)
  })

  it("Stop pressed with the keyboard, or the run ending while the keyboard is on it, gives the focus to the tool's button, never the page", async () => {
    setLocalAiState(stateOf([model('qwen3.5-2b', 'ready')], { active: 'qwen3.5-2b' }))
    const page = (globalThis as unknown as { document: { body: unknown; activeElement: unknown; getElementById?: (id: string) => unknown } }).document
    const focusedIds: string[] = []
    page.getElementById = (id: string) => ({ focus: () => void focusedIds.push(id) })
    const shown = async (requestId: string | null): Promise<El[]> => {
      const els = await settle(h(LocalProgress, { requestId, onStop: () => undefined, returnFocus: 'cleanup-run' }))
      if (requestId) send({ requestId, phase: 'writing', done: 16, total: 400, secondsLeft: 30 })
      return requestId ? settle(h(LocalProgress, { requestId, onStop: () => undefined, returnFocus: 'cleanup-run' })) : els
    }
    const stopOf = (els: El[]): El => byLabel(els, 'Stop AI on this PC')!
    try {
      // Tab to Stop, Enter: Stop goes with the line, and the focus that fell to the page goes to the tool's button.
      keys.last = true
      let els = await shown('req-3')
      ;(stopOf(els).props.onFocus as () => void)()
      page.activeElement = page.body
      await shown(null)
      expect(focusedIds).toEqual(['cleanup-run'])
      // A click on Stop: the focus stays where clicks leave it.
      unmountAll()
      focusedIds.length = 0
      keys.last = false
      els = await shown('req-4')
      ;(stopOf(els).props.onFocus as () => void)()
      await shown(null)
      expect(focusedIds).toEqual([])
      // The keyboard moved on from Stop before the run ended: nothing moves.
      unmountAll()
      keys.last = true
      els = await shown('req-5')
      ;(stopOf(els).props.onFocus as () => void)()
      ;(stopOf(els).props.onBlur as (e: unknown) => void)({ currentTarget: { isConnected: true } })
      await new Promise((r) => setTimeout(r, 0))
      await shown(null)
      expect(focusedIds).toEqual([])
      // Focus somewhere else when the line goes (not the page): it stays there.
      unmountAll()
      els = await shown('req-6')
      ;(stopOf(els).props.onFocus as () => void)()
      page.activeElement = {}
      await shown(null)
      expect(focusedIds).toEqual([])
    } finally {
      delete page.getElementById
      page.activeElement = {}
      keys.last = false
    }
  })

  it('waiting and loading: an indeterminate bar; low memory says so', async () => {
    setLocalAiState(stateOf([model('gemma4-e2b', 'ready')], { active: 'gemma4-e2b', pc: pcOf({ freeMemBytes: 4 * GIB }) }))
    const root = h(LocalProgress, { requestId: 'req-2', onStop: () => undefined })
    render(root)
    send({ requestId: 'req-2', phase: 'loading', done: 0, total: 0, secondsLeft: 12 })
    const els = await settle(root)
    const bar = els.find((e) => e.type === 'progress')!
    expect(bar.props.value).toBeUndefined()
    expect(bar.props['aria-valuetext']).toBe('Loading the model')
    expect(textOf(els.find((e) => e.props.className === 'local-progress-text'))).toBe('On this PC: loading the model… · Memory is low: this may be slow')
    expect(progressValueText({ phase: 'waiting', done: 0, total: 0 })).toBe('Waiting for AI on this PC')
  })
})
