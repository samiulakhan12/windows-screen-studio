/**
 * Make my captions great's runner (docs/design/captions-studio.md §11.8, §2.8; greatRun.ts): the AI
 * marks first, then the plan a step at a time (§9.8) and one sealed update (one undo step); AI marks
 * of a caption edited while the provider worked are dropped; an edit made while it plans is kept; a
 * provider that fails leaves the offline picks and says so; Cancel changes nothing; a second run
 * with the same result adds no undo step.
 */
import { beforeEach, describe, expect, it, vi } from 'vitest'
import type { AiProviderInfo, AiTextRequest, AiTextResult, MarksAnswer } from '../src/shared/api/ai'
import { DEFAULT_GREAT_OPTIONS, type GreatOptions } from '../src/shared/captions/great'
import { EditStore } from '../src/shared/editor/editStore'
import type { Project } from '../src/shared/types'
import { captions, studioProject, TALL } from './p4Fixtures'

vi.mock('../src/shared/captions/words', async (o) => (await import('./p1Fillins')).fillWords(await o()))
vi.mock('../src/shared/captions/studioLayout', async (o) => (await import('./p1Fillins')).fillLayout(await o(), await import('../src/shared/captions/words')))
vi.mock('../src/shared/captions/studioEdit', async (o) => (await import('./p1Fillins')).fillEdit(await o()))

function deferred<T>(): { promise: Promise<T>; resolve: (v: T) => void; reject: (e: unknown) => void } {
  let resolve!: (v: T) => void
  let reject!: (e: unknown) => void
  const promise = new Promise<T>((a, b) => {
    resolve = a
    reject = b
  })
  return { promise, resolve, reject }
}

const asked: { provider: string; request: AiTextRequest; id?: string; answer: ReturnType<typeof deferred<AiTextResult>> }[] = []
/** The request ids cancelAiText was asked to stop. */
const stopped: string[] = []
const prefs: Record<string, unknown> = {}
vi.stubGlobal('window', {
  api: {
    getPref: (key: string) => Promise.resolve(prefs[key] ?? null),
    setPref: (key: string, value: unknown) => {
      prefs[key] = value
      return Promise.resolve()
    },
    getBrandKit: () => Promise.resolve({}),
    listAiProviders: () => Promise.resolve([{ id: 'g1', kind: 'gemini', label: 'Gemini' }] as AiProviderInfo[]),
    aiText: (provider: string, request: AiTextRequest, id?: string) => {
      const answer = deferred<AiTextResult>()
      asked.push({ provider, request, id, answer })
      return answer.promise
    },
    cancelAiText: (id: string) => {
      stopped.push(id)
      return Promise.resolve()
    }
  }
})

interface Runner {
  loadGreatOptions(): Promise<GreatOptions>
  currentGreatOptions(): GreatOptions
  onGreatOptions(listener: () => void): () => void
  saveGreatOptions(next: GreatOptions): Promise<void>
  runCaptionsGreat(deps: { store: EditStore<Project>; frame: { w: number; h: number }; options: GreatOptions; signal: AbortSignal; undo?: string }): Promise<{ notice: string } | null>
}
// Renderer code: imported at run time so the Node typecheck of tests/ does not follow it.
const RUN = '../src/renderer/src/editor/greatRun'
const runner = (await import(/* @vite-ignore */ RUN)) as Runner
const { runCaptionsGreat } = runner

const flush = (): Promise<void> => new Promise((r) => setTimeout(r, 0))
const TEXTS = ['First, open the Settings page and click Export.', 'Second, turn on Auto Save so you never lose work.', 'Click Save and you are done.']
const OFFLINE: GreatOptions = { ...DEFAULT_GREAT_OPTIONS, counters: false, lists: false, emoji: false, keywords: false }
const AI: GreatOptions = { ...OFFLINE, provider: 'g1' }
/** Emphasis on word 3 of the first two captions ("Settings", "Auto"). */
const MARKS: MarksAnswer = {
  captions: [
    { id: 'c0', emphasis: [3], emoji: '', emojiWord: -1 },
    { id: 'c1', emphasis: [3, 4], emoji: '', emojiWord: -1 }
  ],
  numbers: [],
  lists: [],
  quotes: []
}

const storeOf = (p: Project): EditStore<Project> => new EditStore(p)
const undoSteps = (s: EditStore<Project>): number => {
  let n = 0
  while (s.undo()) n++
  return n
}

beforeEach(() => {
  asked.length = 0
  stopped.length = 0
})

describe('runCaptionsGreat', () => {
  it('on this PC: one undo step, and the notice of what changed', async () => {
    const start = studioProject({ segments: captions(TEXTS) })
    const store = storeOf(start)
    const out = await runCaptionsGreat({ store, frame: TALL, options: OFFLINE, signal: new AbortController().signal, undo: ' · Ctrl + Z to undo' })
    expect(asked).toHaveLength(0)
    expect(out?.notice).toMatch(/^Captions: Clean Short, \d+ words? emphasised.* · Ctrl \+ Z to undo$/)
    expect(store.state.captionMarks?.length).toBeGreaterThan(0)
    expect(undoSteps(store)).toBe(1)
    expect(store.state).toBe(start)
  })

  it('a second run with the same result adds no undo step and says so', async () => {
    const store = storeOf(studioProject({ segments: captions(TEXTS) }))
    await runCaptionsGreat({ store, frame: TALL, options: OFFLINE, signal: new AbortController().signal })
    const once = store.state
    const out = await runCaptionsGreat({ store, frame: TALL, options: OFFLINE, signal: new AbortController().signal })
    expect(store.state).toBe(once)
    expect(out?.notice).toBe('Your captions already have all of this.')
    expect(undoSteps(store)).toBe(1)
  })

  it("uses the provider's checked marks, and drops those of a caption edited while it worked", async () => {
    const store = storeOf(studioProject({ segments: captions(TEXTS) }))
    const run = runCaptionsGreat({ store, frame: TALL, options: AI, signal: new AbortController().signal })
    await flush()
    expect(asked).toHaveLength(1)
    expect(asked[0].provider).toBe('g1')
    expect(asked[0].request.task).toBe('marks')
    // No times or text beyond the captions' own go to the provider from here: main makes the words.
    expect(asked[0].request.marks).toEqual({ language: 'en', captions: [] })
    // The user edits the second caption meanwhile (its own undo step).
    store.update((p) => ({ ...p, transcript: { ...p.transcript!, segments: p.transcript!.segments.map((s) => (s.id === 'c1' ? { ...s, text: 'Second, turn on autosave.' } : s)) } }))
    asked[0].answer.resolve({ task: 'marks', answer: MARKS })
    await run
    const marks = store.state.captionMarks ?? []
    expect(marks.find((m) => m.caption === 'c0')).toMatchObject({ from: 3, to: 3, text: 'Settings', auto: true })
    expect(marks.some((m) => m.caption === 'c1')).toBe(false)
    expect(undoSteps(store)).toBe(2)
  })

  it('asks the provider on the captions as the tidy step leaves them, so its word indexes name the words marked', async () => {
    const store = storeOf(studioProject({ segments: captions(['we grew one hundred and twenty users and our Revenue increased', 'Click Save and you are done.']) }))
    const run = runCaptionsGreat({ store, frame: TALL, options: AI, signal: new AbortController().signal })
    await flush()
    expect(asked[0].request.segments[0].text).toBe('We grew 120 users and our Revenue increased')
    // "Revenue" is word 6 of the caption sent (word 9 before the tidy).
    asked[0].answer.resolve({ task: 'marks', answer: { captions: [{ id: 'c0', emphasis: [6], emoji: '', emojiWord: -1 }], numbers: [], lists: [], quotes: [] } })
    await run
    expect(store.state.captionMarks?.filter((m) => m.caption === 'c0')).toEqual([expect.objectContaining({ from: 6, to: 6, text: 'Revenue', auto: true })])
  })

  it('a provider that fails leaves the picks made on this PC, and the notice says so', async () => {
    const store = storeOf(studioProject({ segments: captions(TEXTS) }))
    const run = runCaptionsGreat({ store, frame: TALL, options: AI, signal: new AbortController().signal })
    await flush()
    asked[0].answer.reject(new Error('offline'))
    const out = await run
    expect(store.state.captionMarks?.length).toBeGreaterThan(0)
    expect(out?.notice).toMatch(/The AI provider could not be reached, so Flown picked on this PC\.$/)
  })

  it('Cancel while the provider works changes nothing', async () => {
    const start = studioProject({ segments: captions(TEXTS) })
    const store = storeOf(start)
    const cancel = new AbortController()
    const run = runCaptionsGreat({ store, frame: TALL, options: AI, signal: cancel.signal })
    await flush()
    expect(stopped).toEqual([])
    cancel.abort()
    // Cancel also stops the provider's own request, by the id it was sent with.
    expect(asked[0].id).toMatch(/^[A-Za-z0-9_-]{1,64}$/)
    expect(stopped).toEqual([asked[0].id])
    asked[0].answer.resolve({ task: 'marks', answer: MARKS })
    expect(await run).toBeNull()
    expect(store.state).toBe(start)
    expect(store.canUndo).toBe(false)
  })

  it('a run that ends by itself stops no request; each run has its own id', async () => {
    const store = storeOf(studioProject({ segments: captions(TEXTS) }))
    const cancel = new AbortController()
    for (let i = 0; i < 2; i++) {
      const run = runCaptionsGreat({ store, frame: TALL, options: AI, signal: cancel.signal })
      await flush()
      asked[i].answer.resolve({ task: 'marks', answer: MARKS })
      await run
    }
    expect(asked[1].id).not.toBe(asked[0].id)
    // Aborting after the runs ended stops nothing (their listeners are gone).
    cancel.abort()
    expect(stopped).toEqual([])
  })

  it('plans with the editor free between its steps, and Cancel then changes nothing (§9.8)', async () => {
    const start = studioProject({ segments: captions(TEXTS) })
    const store = storeOf(start)
    const cancel = new AbortController()
    const pause = vi.spyOn(globalThis, 'setTimeout')
    const run = runCaptionsGreat({ store, frame: TALL, options: OFFLINE, signal: cancel.signal })
    // The planner has made its first step and lets the editor go on before the next.
    for (let i = 0; i < 100 && !pause.mock.calls.length; i++) await Promise.resolve()
    pause.mockRestore()
    expect(store.state).toBe(start)
    cancel.abort()
    expect(await run).toBeNull()
    expect(store.state).toBe(start)
    expect(store.canUndo).toBe(false)
  })

  it('keeps an edit made while it plans: the plan is made again from it (§9.8)', async () => {
    const store = storeOf(studioProject({ segments: captions(TEXTS) }))
    const pause = vi.spyOn(globalThis, 'setTimeout')
    const run = runCaptionsGreat({ store, frame: TALL, options: OFFLINE, signal: new AbortController().signal })
    for (let i = 0; i < 100 && !pause.mock.calls.length; i++) await Promise.resolve()
    pause.mockRestore()
    store.update((p) => ({ ...p, transcript: { ...p.transcript!, segments: p.transcript!.segments.map((s) => (s.id === 'c2' ? { ...s, text: 'click Save and you are finished' } : s)) } }))
    expect((await run)?.notice).toMatch(/^Captions: /)
    // The edit, tidied by the plan made from it (a capital at the start).
    expect(store.state.transcript!.segments[2].text).toMatch(/^Click Save and you are finished/)
    expect(store.state.captionMarks?.length).toBeGreaterThan(0)
    expect(undoSteps(store)).toBe(2)
  })

  it('reads the saved Clean up choices for its tidy step', async () => {
    prefs.captionCleanup = { caps: false, punct: false, digits: 'off' }
    try {
      const store = storeOf(studioProject({ segments: captions(['today i open the settings']) }))
      await runCaptionsGreat({ store, frame: TALL, options: OFFLINE, signal: new AbortController().signal })
      expect(store.state.transcript!.segments[0].text).toBe('today i open the settings')
    } finally {
      delete prefs.captionCleanup
    }
  })
})

describe('the saved options (prefs captionsGreat, §2.8)', () => {
  it('are read once, used at once when saved, and kept through readGreatOptions', async () => {
    prefs.captionsGreat = { emoji: true, sound: 'ding', bogus: 1 }
    try {
      expect(await runner.loadGreatOptions()).toEqual({ ...DEFAULT_GREAT_OPTIONS, emoji: true, sound: 'ding' })
      let heard = 0
      const off = runner.onGreatOptions(() => heard++)
      await runner.saveGreatOptions({ ...runner.currentGreatOptions(), counters: false, provider: '../bad' })
      expect(heard).toBe(1)
      expect(runner.currentGreatOptions()).toMatchObject({ emoji: true, counters: false, provider: null })
      expect(prefs.captionsGreat).toEqual(runner.currentGreatOptions())
      off()
    } finally {
      delete prefs.captionsGreat
    }
  })
})
