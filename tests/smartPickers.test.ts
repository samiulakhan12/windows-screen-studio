import { readdirSync, readFileSync, statSync } from 'node:fs'
import path from 'node:path'
import { beforeEach, describe, expect, it, vi } from 'vitest'
import type { Project } from '../src/shared/types'
import { byTestId, contexts, mockReact, settle, testStore, textOf, unmountAll, useEditorContexts, type El } from './studioHarness'

/*
 * Every text tool can be followed and stopped, and says where its text goes (docs/design/smart-tools.md
 * §20.0, §22.1 tests 102 and 103), without a DOM. Each call of aiText and draftScript in the
 * renderer sends a request id; the pickers mount LocalProgress beside their busy button with that id,
 * and its Stop reaches cancelAiText with it, Draft script's too. With a Groq service chosen no text
 * of Languages, Clean up, Draft script, the Captions tab or Publish says "OpenAI"; with On this PC
 * none says "undefined". LocalProgress and CostLine are listed, not called (their stubs show nothing).
 */

const ROOT = path.resolve(__dirname, '..')
const RENDERER = path.join(ROOT, 'src', 'renderer', 'src')

/** Whether AI on this PC has a model ready (part P4's hook, answered by the test). */
const local = vi.hoisted(() => ({ ready: false }))
vi.mock('../src/renderer/src/ai/localAiState', () => ({ useLocalAiReady: () => local.ready, useLocalAiProgress: () => null, useLocalNote: () => null }))

const GROQ = {
  id: 'svc1',
  kind: 'openai',
  label: '',
  model: 'llama-4-scout',
  maskedKey: '',
  createdAt: '',
  service: { preset: 'groq', baseUrl: 'https://api.groq.com/openai/v1', host: 'api.groq.com', loopback: false, json: 'schema' }
}
const GEMINI = { id: 'g1', kind: 'gemini', label: '', model: 'gemini-x', maskedKey: '', createdAt: '' }
const providers: { list: unknown[] } = { list: [GROQ] }
/** What each request was sent with; `release` lets the waiting answers come. */
const calls: { kind: 'aiText' | 'draftScript'; providerId: string; requestId: unknown; request: Record<string, unknown> }[] = []
const stopped: unknown[] = []
let release: () => void = () => undefined
let gate: Promise<void> = Promise.resolve()
const hold = (): void => {
  gate = new Promise((r) => (release = r))
}

vi.stubGlobal('document', { activeElement: null, body: {} })
vi.stubGlobal(
  'MutationObserver',
  class {
    observe(): void {}
    disconnect(): void {}
  }
)
vi.stubGlobal('window', {
  api: {
    getPref: async (key: string) => (key === 'captionCleanup' ? { ai: true } : null),
    setPref: async () => undefined,
    listAiProviders: async () => providers.list,
    localAiState: async () => ({ active: 'qwen3.5-2b' }),
    aiText: async (providerId: string, request: Record<string, unknown>, requestId?: string) => {
      calls.push({ kind: 'aiText', providerId, requestId, request })
      await gate
      // On this PC, main says which model ran (read again after the run, the state may name another).
      if (request.task === 'translate') return { task: 'translate', segments: (request.segments as { id: string; start: number; end: number; text: string }[]).map((s) => ({ ...s, text: `bn ${s.text}` })), ...(providerId === 'local' ? { model: 'gemma4-e2b' } : {}) }
      return { task: request.task, segments: request.segments }
    },
    draftScript: async (providerId: string, request: Record<string, unknown>) => {
      calls.push({ kind: 'draftScript', providerId, requestId: request.requestId, request })
      await gate
      return { text: 'A script to read aloud.' }
    },
    cancelAiText: async (requestId: string) => void stopped.push(requestId),
    cancelScriptDraft: async () => undefined
  },
  addEventListener: () => undefined,
  removeEventListener: () => undefined,
  dispatchEvent: () => true
})

mockReact()
// Renderer code: imported at run time so the Node typecheck of tests/ does not follow it.
const LANGUAGES = '../src/renderer/src/editor/panels/LanguagesSection'
const CLEANUP = '../src/renderer/src/editor/panels/CleanupSection'
const DRAFT = '../src/renderer/src/notes/DraftScript'
const CHOICES = '../src/renderer/src/ai/textChoices'
const { LanguagesSection } = (await import(/* @vite-ignore */ LANGUAGES)) as { LanguagesSection: (p: unknown) => unknown }
const { CleanupSection } = (await import(/* @vite-ignore */ CLEANUP)) as { CleanupSection: (p: unknown) => unknown }
const { DraftScript } = (await import(/* @vite-ignore */ DRAFT)) as { DraftScript: (p: unknown) => unknown }
const { sentHint, choiceOf, LOCAL_CHOICE } = (await import(/* @vite-ignore */ CHOICES)) as {
  sentHint: (c: unknown, what: string, rest?: string, plural?: boolean) => string
  choiceOf: (info: unknown) => { place: string; label: string }
  LOCAL_CHOICE: unknown
}
await useEditorContexts()
const { createProject } = await import('../src/shared/engine/project')

const base = (): Project => ({
  ...createProject({ id: 'p', name: 'p', duration: 10, width: 1920, height: 1080, hasWebcam: false, hasAudio: true, webcamOffset: 0, zooms: [], cursorValid: true, capture: { method: 'native', cursorInVideo: false, region: null } }),
  transcript: { language: 'en', segments: [{ id: 'c1', start: 0, end: 2, text: 'Make every word count' }] } as Project['transcript']
})
let store: ReturnType<typeof testStore<Project>>
const SKIP = ['LocalProgress', 'CostLine']
const languages = (): unknown => ({ type: LanguagesSection, props: { project: store.state } })
const cleanup = (): unknown => ({ type: CleanupSection, props: { project: store.state } })
const draft = (): unknown => ({ type: DraftScript, props: { text: '- point one\n- point two', onReplace: () => undefined } })
const progressOf = (els: El[]): El | undefined => els.find((e) => (e.type as { name?: string }).name === 'LocalProgress')
const allText = (els: El[]): string => els.map((e) => (typeof e.type === 'string' ? textOf(e) : '')).join(' ')
const click = (el: El | undefined): void => (el!.props.onClick as () => void)()
/** Lets window.api answer. */
const answer = (): Promise<void> => new Promise((r) => setTimeout(r, 0))

beforeEach(() => {
  unmountAll()
  local.ready = false
  providers.list = [GROQ]
  calls.length = 0
  stopped.length = 0
  gate = Promise.resolve()
  store = testStore(base())
  contexts.editor = { store, player: { time: 0, subscribe: () => () => undefined } }
})

/* ---------- test 102: every text tool can be followed and stopped ---------- */

/** Every .ts and .tsx file under `dir`. */
function sources(dir: string): string[] {
  return readdirSync(dir).flatMap((name) => {
    const full = path.join(dir, name)
    return statSync(full).isDirectory() ? sources(full) : /\.tsx?$/.test(name) ? [full] : []
  })
}

/** The arguments of each call of `callee` in `text`, split at their top-level commas. */
function callArgs(text: string, callee: string): string[][] {
  const out: string[][] = []
  let at = text.indexOf(callee)
  while (at >= 0) {
    let depth = 0
    let piece = ''
    const args: string[] = []
    for (let i = at + callee.length; i < text.length; i++) {
      const ch = text[i]
      if ('([{'.includes(ch)) depth++
      if (')]}'.includes(ch)) {
        if (depth === 0) break
        depth--
      }
      if (ch === ',' && depth === 0) {
        args.push(piece.trim())
        piece = ''
      } else piece += ch
    }
    if (piece.trim()) args.push(piece.trim())
    out.push(args)
    at = text.indexOf(callee, at + callee.length)
  }
  return out
}

describe('every text tool can be followed and stopped (test 102)', () => {
  it('each call of aiText in the renderer sends a request id, and each call of draftScript one in its request', () => {
    const found: string[] = []
    for (const file of sources(RENDERER)) {
      const text = readFileSync(file, 'utf8')
      for (const args of callArgs(text, 'window.api.aiText(')) {
        found.push(path.relative(ROOT, file))
        expect(args.length, `${path.relative(ROOT, file)}: aiText(${args.join(', ')})`).toBe(3)
        expect(args[2], path.relative(ROOT, file)).not.toMatch(/^(undefined|null)$/)
      }
      for (const args of callArgs(text, 'window.api.draftScript(')) {
        found.push(path.relative(ROOT, file))
        expect(args[1], path.relative(ROOT, file)).toMatch(/requestId/)
      }
    }
    // The Captions tab's tools, Clean up, Languages, Make my captions great, Publish, Draft script, Find chapters, the guide's Write titles and Tidy notes, and Short clips' names.
    expect(new Set(found)).toEqual(
      new Set([
        'src/renderer/src/clips/ShortClipsPanel.tsx',
        'src/renderer/src/editor/chaptersRun.ts',
        'src/renderer/src/editor/panels/CaptionsPanel.tsx',
        'src/renderer/src/editor/panels/CleanupSection.tsx',
        'src/renderer/src/editor/panels/LanguagesSection.tsx',
        'src/renderer/src/editor/greatRun.ts',
        'src/renderer/src/publish/publishRun.ts',
        'src/renderer/src/notes/DraftScript.tsx',
        'src/renderer/src/guide/guideRun.ts'
      ])
    )
  })

  it('LocalProgress is mounted beside the busy buttons of every picker that offers On this PC', () => {
    for (const file of ['editor/panels/CaptionsPanel.tsx', 'editor/panels/CleanupSection.tsx', 'editor/panels/LanguagesSection.tsx', 'publish/PublishDialog.tsx', 'notes/DraftScript.tsx', 'guide/GuidePanel.tsx']) {
      expect(readFileSync(path.join(RENDERER, file), 'utf8'), file).toMatch(/<LocalProgress requestId=\{[^}]+\} onStop=\{/)
    }
  })

  it('Clean up: its AI fix is followed by its id, and Stop reaches cancelAiText with it', async () => {
    hold()
    let els = await settle(cleanup(), SKIP)
    expect(progressOf(els)?.props.requestId).toBeNull()
    click(byTestId(els, 'cleanup-run'))
    els = await settle(cleanup(), SKIP)
    expect(calls).toHaveLength(1)
    const id = calls[0].requestId
    expect(id).toMatch(/^captions-cleanup-\d+$/)
    const progress = progressOf(els)!
    expect(progress.props.requestId).toBe(id)
    ;(progress.props.onStop as () => void)()
    expect(stopped).toEqual([id])
    release()
  })

  it('Languages: a translation is followed by its id, and Stop reaches cancelAiText with it', async () => {
    hold()
    let els = await settle(languages(), SKIP)
    click(byTestId(els, 'track-add'))
    els = await settle(languages(), SKIP)
    click(byTestId(els, 'track-translate'))
    els = await settle(languages(), SKIP)
    expect(calls).toHaveLength(1)
    const id = calls[0].requestId
    expect(id).toMatch(/^captions-translate-\d+$/)
    const progress = progressOf(els)!
    expect(progress.props.requestId).toBe(id)
    ;(progress.props.onStop as () => void)()
    expect(stopped).toEqual([id])
    release()
  })

  it('Draft script: its draft is followed by its id, and Stop reaches cancelAiText with it', async () => {
    hold()
    let els = await settle(draft(), SKIP)
    click(els.find((e) => e.props.id === 'notes-draft'))
    els = await settle(draft(), SKIP)
    expect(calls).toHaveLength(1)
    expect(calls[0].kind).toBe('draftScript')
    const id = calls[0].requestId
    expect(id).toMatch(/^draft-script-\d+$/)
    const progress = progressOf(els)!
    expect(progress.props.requestId).toBe(id)
    ;(progress.props.onStop as () => void)()
    expect(stopped).toEqual([id])
    release()
  })
})

describe('Publish runs one request at a time on this PC (§20.0)', () => {
  const PUBLISH_RUN = '../src/renderer/src/publish/publishRun'
  const ctx = (providerId: string): Record<string, unknown> => ({ providerId, segments: base().transcript!.segments, tone: 'neutral', length: 'short', key: 'k' })

  it('two cards with On this PC: the second waits for the first; with a service both go out', async () => {
    const { writeItem, itemRequestId, stopAll } = (await import(/* @vite-ignore */ PUBLISH_RUN)) as {
      writeItem: (projectId: string, kind: string, ctx: unknown) => Promise<void>
      itemRequestId: (projectId: string, kind: string) => string | null
      stopAll: (projectId: string) => void
    }
    hold()
    const local1 = writeItem('pl', 'title', ctx('local'))
    const local2 = writeItem('pl', 'summary', ctx('local'))
    await answer()
    expect(calls.map((c) => c.requestId)).toEqual([itemRequestId('pl', 'title')])
    expect(itemRequestId('pl', 'summary')).toMatch(/^pub-\d+$/)
    release()
    await Promise.all([local1, local2])
    expect(calls).toHaveLength(2)
    calls.length = 0
    hold()
    const svc = [writeItem('ps', 'title', ctx('svc1')), writeItem('ps', 'summary', ctx('svc1'))]
    await answer()
    expect(calls).toHaveLength(2)
    release()
    await Promise.all(svc)
    stopAll('pl')
    stopAll('ps')
  })
})

/* ---------- test 103: destinations ---------- */

describe('the hints name the place the text goes (test 103)', () => {
  it('with a Groq service, Languages, Clean up and Draft script name api.groq.com and never OpenAI', async () => {
    let els = await settle(languages(), SKIP)
    click(byTestId(els, 'track-add'))
    els = await settle(languages(), SKIP)
    expect(allText(els)).toContain('api.groq.com')
    for (const view of [els, await settle(cleanup(), SKIP), await settle(draft(), SKIP)]) {
      expect(allText(view)).not.toContain('OpenAI')
      expect(allText(view)).not.toContain('undefined')
    }
    expect(allText(await settle(draft(), SKIP))).toContain('api.groq.com')
  })

  it('with On this PC alone, nothing says undefined, and the hints say the text stays on this PC', async () => {
    providers.list = []
    local.ready = true
    let els = await settle(languages(), SKIP)
    click(byTestId(els, 'track-add'))
    els = await settle(languages(), SKIP)
    expect(allText(els)).toContain('stays on this PC')
    const drafted = await settle(draft(), SKIP)
    expect(allText(drafted)).toContain('on this PC: nothing is sent')
    for (const view of [els, drafted, await settle(cleanup(), SKIP)]) expect(allText(view)).not.toMatch(/undefined|OpenAI/)
  })

  it('a translation made on this PC says so, with the model AI on this PC used', async () => {
    providers.list = []
    local.ready = true
    let els = await settle(languages(), SKIP)
    click(byTestId(els, 'track-add'))
    els = await settle(languages(), SKIP)
    click(byTestId(els, 'track-translate'))
    await settle(languages(), SKIP)
    expect(calls[0].providerId).toBe('local')
    expect(store.state.captionTracks).toMatchObject([{ by: 'local', model: 'gemma4-e2b' }])
    expect(store.state.captionTracks?.[0].host).toBeUndefined()
  })

  it('a translation through a service keeps its host; through a provider none', async () => {
    let els = await settle(languages(), SKIP)
    click(byTestId(els, 'track-add'))
    els = await settle(languages(), SKIP)
    click(byTestId(els, 'track-translate'))
    await settle(languages(), SKIP)
    expect(store.state.captionTracks).toMatchObject([{ by: 'openai', model: 'llama-4-scout', host: 'api.groq.com' }])
    unmountAll()
    providers.list = [GEMINI]
    store.state = base()
    calls.length = 0
    els = await settle(languages(), SKIP)
    click(byTestId(els, 'track-add'))
    els = await settle(languages(), SKIP)
    click(byTestId(els, 'track-translate'))
    await settle(languages(), SKIP)
    expect(store.state.captionTracks?.[0]).toMatchObject({ by: 'gemini', model: 'gemini-x' })
    expect(store.state.captionTracks?.[0].host).toBeUndefined()
  })

  it('the Captions tab and Publish name the chosen place, never KIND_NAMES, in what they send', () => {
    const groq = choiceOf(GROQ)
    expect(groq.place).toBe('api.groq.com')
    expect(sentHint(groq, "The captions' text")).toBe("The captions' text is sent to api.groq.com with your key.")
    expect(sentHint(LOCAL_CHOICE, "The captions' words", '', true)).toBe("The captions' words stay on this PC: nothing is sent.")
    // What the Captions tab and Publish say goes where (Languages and Draft script are rendered above): the choice's
    // place (or this PC), never a kind's name.
    for (const file of ['editor/panels/CaptionsPanel.tsx', 'publish/PublishDialog.tsx']) {
      const text = readFileSync(path.join(RENDERER, file), 'utf8')
      const hints = text.split('\n').filter((l) => /sent to|[Ss]ends the|sends your/.test(l))
      expect(hints.length, file).toBeGreaterThan(0)
      for (const line of hints) expect(line, file).not.toMatch(/KIND_NAMES\[/)
    }
  })
})
