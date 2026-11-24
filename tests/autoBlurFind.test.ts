import fs from 'node:fs'
import path from 'node:path'
import { beforeEach, describe, expect, it, vi } from 'vitest'
import type { FindProgress, FindRequest, FindResult, FoundCover, ReaderState } from '../src/shared/api/privacy'
import { EditStore } from '../src/shared/editor/editStore'
import { DEFAULT_KEYMAP } from '../src/shared/editor/shortcuts'
import { PALETTE_COMMANDS, WAITING_COMMANDS, commandInfo } from '../src/shared/editor/commands'
import { captionsSig } from '../src/shared/privacy/findState'
import { isPrivateBleep } from '../src/shared/privacy/coverData'
import type { Project, Transcript } from '../src/shared/types'
import { allByTestId, byTestId, contexts, focused, mockReact, render, settle, textOf, unmountAll, useEditorContexts, type El } from './studioHarness'
import { base, words } from './autoBlurFixtures'

/*
 * Running Find from the editor (docs/design/auto-blur.md §2.5, §2.6, §5.1, §14.1, §14.5; §17.1 tests
 * 168-172, 180, 184, 247, 248, 251, 254 and 257; 256 is in autoBlurFindDone.test.ts): the dialog, the regions, startFind and its one
 * update, the progress and result lines, Polish's gather, the shared reader state, results that
 * land only where they belong and leaving during Find. Main and the
 * reader are fakes; nothing leaves the test.
 */

const api = {
  prefs: new Map<string, unknown>(),
  reader: { status: 'ready', bytes: 1, decodeMs: null } as ReaderState,
  readerListeners: [] as ((s: ReaderState) => void)[],
  progress: [] as ((p: FindProgress) => void)[],
  find: null as null | ((req: FindRequest) => Promise<FindResult>),
  requests: [] as FindRequest[],
  stops: [] as string[],
  downloads: 0,
  confirm: true,
  follow: null as null | ((req: Record<string, unknown>) => Promise<unknown>),
  everywhere: null as null | ((req: Record<string, unknown>) => Promise<unknown>),
  under: null as null | ((req: Record<string, unknown>) => Promise<unknown>)
}
let lineEl: { focus: () => void } | null = null
let lineFocused = 0
vi.stubGlobal('document', {
  activeElement: null,
  body: {},
  querySelector: (sel: string) => (sel.startsWith('[data-find-line=') ? lineEl : null)
})
vi.stubGlobal('window', {
  setTimeout: (fn: () => void) => setTimeout(fn, 0),
  clearTimeout: (id: number) => clearTimeout(id),
  requestAnimationFrame: () => 0,
  confirm: () => api.confirm,
  api: {
    getPref: async (k: string) => api.prefs.get(k) ?? null,
    setPref: async (k: string, v: unknown) => void api.prefs.set(k, v),
    readerState: async () => api.reader,
    onReaderState: (l: (s: ReaderState) => void) => {
      api.readerListeners.push(l)
      return () => undefined
    },
    downloadReader: async () => {
      api.downloads++
      return { status: 'downloading', done: 0, total: 100 }
    },
    onFindProgress: (l: (p: FindProgress) => void) => {
      api.progress.push(l)
      return () => {
        api.progress = api.progress.filter((x) => x !== l)
      }
    },
    findPrivate: (req: FindRequest) => {
      api.requests.push(req)
      return api.find!(req)
    },
    stopFind: async (id: string) => void api.stops.push(id),
    setPrivateNames: async () => undefined,
    copies: async () => [],
    followCover: (req: Record<string, unknown>) => api.follow!(req),
    underCover: (req: Record<string, unknown>) => api.under!(req),
    coverEverywhere: (req: Record<string, unknown>) => api.everywhere!(req)
  }
})
vi.stubGlobal('CSS', { escape: (s: string) => s })
for (const name of ['HTMLElement', 'HTMLButtonElement', 'HTMLInputElement']) vi.stubGlobal(name, class {})
mockReact()
const modal: { closes: (() => void)[] } = { closes: [] }
vi.doMock('../src/renderer/src/editor/modalFocus', () => ({ useModalFocus: (_ref: unknown, onClose: () => void) => void modal.closes.push(onClose) }))

// Renderer code: imported at run time so the Node typecheck of tests/ does not follow it.
type Comp = (p: Record<string, unknown>) => unknown
const load = async <T>(file: string): Promise<T> => (await import(/* @vite-ignore */ `../src/renderer/src/${file}`)) as T
const { FindDialog } = await load<{ FindDialog: Comp }>('privacy/FindDialog')
const { RegionsDialog } = await load<{ RegionsDialog: Comp }>('privacy/RegionsDialog')
const { FindResultLine } = await load<{ FindResultLine: Comp }>('privacy/FindLine')
const reader = await load<{ FindProgressLine: Comp; confirmLeaveFind(s: unknown): Promise<boolean>; resetReaderState(): void; subscribeReader(l: () => void): () => void; readerNow(): ReaderState | null; startReaderState(): void }>('privacy/readerState')
const run = await load<{ startFind(s: unknown, c: unknown): Promise<string>; stopAndApply(s: unknown): Promise<void>; gatherPrivacy(p: Project, c: Transcript | null, s: AbortSignal): Promise<Record<string, unknown> | null> }>('privacy/privacyRun')
const runs = await load<{ beginRun(r: unknown): boolean; endRun(id: string, o: unknown): void; resetRuns(): void; currentRun(): { requestId: string; progress: FindProgress } | null }>('privacy/findRuns')
const follow = await load<{ runFollow(s: unknown, id: string, signal: AbortSignal): Promise<string>; readUnderCover(s: unknown, id: string): Promise<unknown>; runEverywhere(s: unknown, id: string, r: string, signal: AbortSignal): Promise<unknown> }>('privacy/followRun')
const { PrivacySettings } = await load<{ PrivacySettings: Comp }>('privacy/PrivacySettings')
await useEditorContexts()

const READER = 'pp-ocrv6-tiny+small-careful-long'
const cover = (group: string, start: number, over: Partial<FoundCover> = {}): FoundCover => ({ kind: 'email', score: 0.9, group, start, end: start + 2, path: `${start} 0.1 0.1 0.2 0.05`, color: '#202020', ...over })
const ok = (req: FindRequest, over: Partial<Extract<FindResult, { ok: true }>> = {}): FindResult => ({ ok: true, projectId: req.projectId, requestId: req.requestId, found: [cover('g1', 1), cover('g2', 5, { score: 0.6, kind: 'key' })], failedReads: 0, thinSpans: '', stopped: false, readTo: null, reader: READER, ...over })
const captions = (text: string, start = 10): Transcript => ({ language: 'en', provider: 'local', model: 'm', createdAt: '2026-11-20T10:00:00.000Z', segments: [words('c1', start, text)] })
const choices = (over: Record<string, unknown> = {}): Record<string, unknown> => ({ kinds: ['email', 'key', 'card', 'phone'], regions: [], names: [], neverHide: [], listen: true, ...over })
/** A promise and its resolver. */
function deferred<T>(): { promise: Promise<T>; resolve: (v: T) => void } {
  let resolve!: (v: T) => void
  const promise = new Promise<T>((r) => (resolve = r))
  return { promise, resolve }
}
const flush = async (): Promise<void> => {
  for (let i = 0; i < 10; i++) await Promise.resolve()
  await new Promise((r) => setTimeout(r, 0))
}
const press = (el: El | undefined): void => (el!.props.onClick as () => void)()
const steps = (s: EditStore<Project>): number => {
  let n = 0
  while (s.undo()) n++
  return n
}

let store: EditStore<Project>
let services: { store: EditStore<Project>; player: Record<string, unknown> }
const group = { commands: [] as string[], notices: [] as string[] }
function editor(p: Project): void {
  store = new EditStore(p)
  services = { store, player: { time: 0, moving: false, screen: null } }
  contexts.editor = services
}

beforeEach(() => {
  unmountAll()
  runs.resetRuns()
  reader.resetReaderState()
  api.prefs.clear()
  api.reader = { status: 'ready', bytes: 1, decodeMs: null }
  api.requests.length = 0
  api.stops.length = 0
  api.downloads = 0
  api.confirm = true
  api.find = async (req) => ok(req)
  api.readerListeners.length = 0
  modal.closes.length = 0
  lineEl = null
  lineFocused = 0
  group.commands.length = 0
  group.notices.length = 0
  contexts.keymap = DEFAULT_KEYMAP
  contexts.group = { group: { kind: 'none' }, keys: new Set(), single: null, select: () => undefined, notice: (m: string) => void group.notices.push(m), command: (id: string) => void group.commands.push(id) }
})

const dialog = (mode = 'find'): unknown => ({ type: FindDialog, props: { services, onClose: () => undefined, mode } })
const kindBoxes = (els: El[]): El[] => els.filter((e) => e.type === 'input' && e.props['data-kind'])

describe('auto-blur P5: Find', () => {
  it('168. FindDialog: defaults from Settings and the project; listen on with captions, off when unticked for this project, unchecked and disabled without captions; the reader line, download and retry; the estimate; focus in and back (finding 31)', async () => {
    // Settings' kinds when the project has none.
    api.prefs.set('privacy', { kinds: ['email', 'card'] })
    editor({ ...base('fd', 30), transcript: captions('hello there') })
    reader.startReaderState()
    let els = await settle(dialog())
    expect(kindBoxes(els).filter((e) => e.props.checked).map((e) => e.props['data-kind'])).toEqual(['email', 'card'])
    // Focus in: the first checkbox (finding 31); focus back is useModalFocus's, with the dialog's Cancel as its close.
    expect(focused.at(-1)!.props['data-kind']).toBe('password')
    expect(modal.closes.length).toBeGreaterThan(0)
    const listen = byTestId(els, 'find-listen')!
    expect(listen.props.checked).toBe(true)
    expect(listen.props.disabled).toBe(false)
    expect(textOf(els.find((e) => e.props.id === listen.props['aria-describedby']))).toBe('Uses the captions. Secrets said aloud are bleeped and masked in captions and translations.')
    // The estimate (§5.11's first one) with the reader downloaded.
    expect(textOf(byTestId(els, 'find-estimate'))).toBe('Less than a minute on this PC. You can keep editing; keep this video open until Find ends.')
    // The project's own kinds win; listen unticked for this project stays off.
    unmountAll()
    editor({ ...base('fd', 30), transcript: captions('hello there'), privacy: { kinds: ['password'], listen: false } })
    els = await settle(dialog())
    expect(kindBoxes(els).filter((e) => e.props.checked).map((e) => e.props['data-kind'])).toEqual(['password'])
    expect(byTestId(els, 'find-listen')!.props.checked).toBe(false)
    // Without captions: unchecked and disabled, with its reason.
    unmountAll()
    editor(base('fd', 30))
    els = await settle(dialog())
    const none = byTestId(els, 'find-listen')!
    expect([none.props.checked, none.props.disabled]).toEqual([false, true])
    expect(textOf(els.find((e) => e.props.id === none.props['aria-describedby']))).toBe('Make captions first to listen for secrets said aloud.')
    // The reader not downloaded: its line and Download; Find only with something to listen to.
    unmountAll()
    api.reader = { status: 'none' }
    reader.resetReaderState()
    reader.startReaderState()
    await flush()
    els = await settle(dialog())
    expect(textOf(byTestId(els, 'find-reader'))).toContain('Find needs the text reader, a 27.6 MB download from Hugging Face. It runs on this PC.')
    expect(byTestId(els, 'find-start')!.props.disabled).toBe(true)
    expect(byTestId(els, 'find-estimate')).toBeUndefined()
    press(byTestId(els, 'find-download'))
    await flush()
    expect(api.downloads).toBe(1)
    els = render(dialog())
    expect(textOf(byTestId(els, 'find-reader-progress'))).toBe('Downloading the text reader… 0%')
    // A failed download says why, with Try again.
    for (const l of api.readerListeners) l({ status: 'failed', reason: 'The connection was lost.' })
    els = render(dialog())
    expect(textOf(byTestId(els, 'find-reader'))).toContain('The text reader could not be downloaded. The connection was lost.')
    expect(textOf(byTestId(els, 'find-download'))).toBe('Try again')
    // A Find before (Find again): its line and button.
    unmountAll()
    api.reader = { status: 'ready', bytes: 1, decodeMs: null }
    for (const l of api.readerListeners) l(api.reader)
    editor({ ...base('fd', 30), privacy: { find: { at: '2026-11-23T10:00:00.000Z', kinds: ['email'], listened: false, reader: READER } } })
    els = await settle(dialog())
    expect(textOf(byTestId(els, 'find-again'))).toBe('Find again keeps every cover you have and adds what is new.')
    expect(textOf(byTestId(els, 'find-start'))).toBe('Find again')
    // Find: the dialog closes and the focus goes to the section's progress line once the run shows (finding 31).
    lineEl = { focus: () => void lineFocused++ }
    const gate = deferred<FindResult>()
    api.find = () => gate.promise
    press(byTestId(els, 'find-start'))
    await flush()
    await flush()
    expect(lineFocused).toBe(1)
    gate.resolve(ok(api.requests[0]))
    await flush()
    // The result is said once, in the editor's notice.
    expect(group.notices).toEqual(['Found 2 private items. 1 of them is to check.'])
  })

  it('169. RegionsDialog: at most 5 added; the PC’s and the UI language’s regions always on', () => {
    let done: string[] | null = null
    const view = (): unknown => ({ type: RegionsDialog, props: { regions: ['BD'], onDone: (r: string[]) => (done = r), onCancel: () => undefined } })
    let els = render(view())
    const boxes = (all: El[]): El[] => all.filter((e) => e.type === 'input' && e.props['data-region'])
    // The PC's region (en-US here) is always on: checked, disabled, first.
    const first = boxes(els)[0]
    expect([first.props['data-region'], first.props.checked, first.props.disabled]).toEqual(['US', true, true])
    expect(boxes(els).filter((e) => e.props.checked).map((e) => e.props['data-region'])).toEqual(['US', 'BD'])
    // Up to 5 added: then every other box is disabled.
    for (const r of ['IN', 'ES', 'GB', 'FR']) {
      const b = boxes(els).find((e) => e.props['data-region'] === r)!
      ;(b.props.onChange as (e: unknown) => void)({ target: { checked: true } })
      els = render(view())
    }
    const added = boxes(els).filter((e) => e.props.checked && !e.props.disabled).map((e) => e.props['data-region'])
    expect(added).toHaveLength(5)
    expect(boxes(els).find((e) => e.props['data-region'] === 'DE')!.props.disabled).toBe(true)
    ;(boxes(els).find((e) => e.props['data-region'] === 'DE')!.props.onChange as (e: unknown) => void)({ target: { checked: true } })
    els = render(view())
    press(byTestId(els, 'regions-done'))
    // Done gives the regions added; the PC's is added at each run.
    expect(done).toEqual(['BD', 'IN', 'ES', 'GB', 'FR'])
    expect(textOf(els.find((e) => e.type === 'h2'))).toBe('Phone numbers from')
  })

  it('170. startFind saves first, runs detectSaid on the captions, applies one update through afterGestures, and records captionsSig at the start (finding 14)', async () => {
    const said = captions('my card number is 4917 6123 4567 8904 thanks')
    editor({ ...base('sf', 60), transcript: said })
    const gate = deferred<FindResult>()
    let savedFirst: Project | null = null
    api.find = (req) => {
      savedFirst = store.state
      return gate.promise.then(() => ok(req))
    }
    const done = run.startFind(services, choices({ names: ['Ada Lovelace'] }))
    await flush()
    // Saved first: the choices are in the project before main is asked.
    expect(savedFirst!.privacy!.kinds).toEqual(['key', 'email', 'card', 'phone'])
    expect(savedFirst!.privacy!.names).toEqual(['Ada Lovelace'])
    expect(api.requests[0]).toMatchObject({ projectId: 'sf', kinds: ['key', 'email', 'card', 'phone'], names: ['Ada Lovelace'], regions: ['US'] })
    // The captions change while Find runs: the record keeps the signature of those it listened to.
    store.update((p) => ({ ...p, transcript: captions('something else entirely') }))
    // A drag is open as the answer comes: the results wait for it to end (finding 16).
    store.beginGesture()
    gate.resolve(null as never)
    await flush()
    expect(store.state.covers).toBeUndefined()
    store.endGesture()
    expect(await done).toBe('done')
    const p = store.state
    expect(p.covers!.map((c) => c.group).sort()).toEqual(['g1', 'g2'])
    // The card said aloud is a private bleep (P3's detectSaid on the captions at the start).
    expect(p.bleeps!.filter(isPrivateBleep).map((b) => b.word.split(':')[1])).toEqual(['card'])
    const record = p.privacy!.find!
    expect(record.captionsSig).toBe(captionsSig(said))
    expect(record.captionsSig).not.toBe(captionsSig(p.transcript))
    expect(record).toMatchObject({ kinds: ['key', 'email', 'card', 'phone'], listened: true, reader: READER, saidIds: [p.bleeps!.find(isPrivateBleep)!.id] })
    // One step for the results, one for the choices saved first, one for the captions' change.
    expect(steps(store)).toBe(3)
  })

  it('171. The progress line: phases, the second estimate, announcements at most every 10%', () => {
    editor(base('pl', 60))
    runs.beginRun({ projectId: 'pl', requestId: 'find-x', by: 'find', stop: async () => undefined })
    const line = (): El[] => render({ type: reader.FindProgressLine, props: { projectId: 'pl' } })
    const send = (p: Partial<FindProgress>): void => {
      for (const l of api.progress) l({ projectId: 'pl', requestId: 'find-x', phase: 'look', done: 0, total: 100, secondsLeft: null, ...p })
    }
    let els = line()
    const spoken: string[] = []
    const visible: string[] = []
    for (let pct = 1; pct <= 25; pct++) {
      send({ done: pct })
      els = line()
      visible.push(textOf(els.find((e) => e.props.className === 'find-line-text')))
      spoken.push(textOf(byTestId(els, 'find-said')))
    }
    // The visible text follows every step; the live region speaks at 10% steps only.
    expect(new Set(visible).size).toBe(25)
    expect([...new Set(spoken)]).toEqual(['Looking for changes on screen… 0%', 'Looking for changes on screen… 10%', 'Looking for changes on screen… 20%'])
    // A phase change is spoken at once; the second estimate shows as the time left.
    send({ phase: 'read', done: 3, total: 40, secondsLeft: 300 })
    els = line()
    expect(textOf(byTestId(els, 'find-said'))).toBe('Reading text… 3 of 40')
    expect(textOf(byTestId(els, 'find-left'))).toBe('About 5 minutes left.')
    // Another request's events (another run's) are not this run's.
    for (const l of api.progress) l({ projectId: 'pl', requestId: 'other', phase: 'follow', done: 0, total: 0, secondsLeft: null })
    expect(textOf(byTestId(line(), 'find-said'))).toBe('Reading text… 3 of 40')
  })

  it('172. gatherPrivacy runs on the run’s captions and returns covers and bleeps for Polish', async () => {
    const own = captions('nothing to hear here')
    const fresh = captions('my card number is 4917 6123 4567 8904 thanks')
    const p: Project = { ...base('gp', 60), transcript: own }
    const g = (await run.gatherPrivacy(p, fresh, new AbortController().signal))!
    expect(api.requests).toHaveLength(1)
    expect((g.covers as { group: string }[]).map((c) => c.group).sort()).toEqual(['g1', 'g2'])
    // Said in the run's captions, not in the project's.
    expect((g.said as { word: string }[]).map((b) => b.word.split(':')[1])).toEqual(['card'])
    expect(g).toMatchObject({ found: 3, check: 1, listenedOnly: false, unfinished: false })
    expect((g.privacy as { find: { captionsSig: string; reader: string } }).find).toMatchObject({ captionsSig: captionsSig(fresh), reader: READER })
    // Without the reader: nothing (the step is skipped).
    reader.resetReaderState()
    api.reader = { status: 'none' }
    expect(await run.gatherPrivacy(p, fresh, new AbortController().signal)).toBeNull()
  })

  it('180. Find private info… runs from the palette and is off WAITING_COMMANDS', () => {
    expect(WAITING_COMMANDS).not.toContain('findPrivate')
    expect(PALETTE_COMMANDS.map((c) => c.id)).toContain('findPrivate')
    expect(commandInfo('findPrivate')?.title).toBe('Find private info…')
    // The runner opens the dialog (its one case in Editor.tsx).
    const editorSource = fs.readFileSync(path.join(__dirname, '../src/renderer/src/views/Editor.tsx'), 'utf8')
    expect(editorSource).toContain("findPrivate: () => setDialog('findPrivate')")
    expect(editorSource).toContain("dialog === 'findPrivate' && <FindDialog")
  })

  it('184. useReaderState updates every mounted user on one event', async () => {
    api.reader = { status: 'none' }
    editor(base('rs', 30))
    const heard: string[] = []
    const a = reader.subscribeReader(() => heard.push('a'))
    const b = reader.subscribeReader(() => heard.push('b'))
    await flush()
    expect(reader.readerNow()).toEqual({ status: 'none' })
    heard.length = 0
    // One event from main: every user hears it, and each renders the new state.
    for (const l of api.readerListeners) l({ status: 'downloading', done: 50, total: 100 })
    expect(heard).toEqual(['a', 'b'])
    const els = render({ type: 'div', props: { children: [{ type: FindDialog, props: { services, onClose: () => undefined, mode: 'find' } }, { type: PrivacySettings, props: { reveal: false } }] } })
    expect(textOf(byTestId(els, 'find-reader-progress'))).toBe('Downloading the text reader… 50%')
    expect(textOf(byTestId(els, 'privacy-settings-reader'))).toContain('Downloading the text reader… 50%')
    // Main asked once for the whole window.
    expect(api.readerListeners).toHaveLength(1)
    a()
    b()
  })

  it('247. Results land only where they belong: a FindResult, FollowResult or EverywhereResult whose projectId or requestId is not the open project’s current request changes nothing', async () => {
    editor(base('rl', 60))
    // Find: an answer for another request.
    api.find = async (req) => ok({ ...req, requestId: 'someone-else' })
    expect(await run.startFind(services, choices({ listen: false }))).toBe('failed')
    expect(store.state.covers).toBeUndefined()
    expect(store.state.privacy?.find).toBeUndefined()
    // Another project's answer.
    api.find = async (req) => ok({ ...req, projectId: 'other' })
    expect(await run.startFind(services, choices({ listen: false }))).toBe('failed')
    expect(store.state.covers).toBeUndefined()
    // The editor moved to another project while Find ran: nothing lands on it.
    const gate = deferred<void>()
    api.find = async (req) => gate.promise.then(() => ok(req))
    const pending = run.startFind(services, choices({ listen: false }))
    await flush()
    store.replace(() => ({ ...base('another', 60) }))
    gate.resolve()
    await pending
    expect(store.state.covers).toBeUndefined()
    // Follow and Cover this text everywhere: answers for another request change nothing.
    const withCover: Project = { ...base('rl', 60), covers: [{ id: 'c1', start: 1, end: 5, path: '1 0.1 0.1 0.2 0.05', color: '#202020' }] }
    editor(withCover)
    api.follow = async (req) => ({ ok: true, projectId: req.projectId, requestId: 'not-mine', path: '1 0.5 0.5 0.2 0.05', start: 1, end: 5, walked: { start: 1, end: 5 }, lostSpans: '', thin: false })
    expect(await follow.runFollow(services, 'c1', new AbortController().signal)).toBe('failed')
    expect(store.state).toBe(withCover)
    api.under = async () => ({ ok: true, nameLike: false })
    await follow.readUnderCover(services, 'c1')
    api.everywhere = async (req) => ({ ok: true, projectId: req.projectId, requestId: 'not-mine', found: [cover('gx', 20)], failedReads: 0, thinSpans: '', stopped: false, readTo: null, reader: READER })
    expect(await follow.runEverywhere(services, 'c1', 'no', new AbortController().signal)).toBeNull()
    expect(store.state).toBe(withCover)
  })

  it('248. Leaving during Find: confirming stops Find, applies what it found (one undo step) and only then saves and leaves; declining keeps the editor and Find running', async () => {
    editor(base('lv', 60))
    const gate = deferred<FindResult>()
    api.find = () => gate.promise
    const pending = run.startFind(services, choices({ listen: false }))
    await flush()
    // Declined: the editor stays, Find goes on.
    api.confirm = false
    expect(await reader.confirmLeaveFind(services)).toBe(false)
    expect(api.stops).toEqual([])
    expect(runs.currentRun()).not.toBeNull()
    // Confirmed: Find stops; what it found so far is applied before the editor may leave.
    api.confirm = true
    const before = store.state
    let left = false
    const leaving = reader.confirmLeaveFind(services).then((r) => (left = r))
    await flush()
    expect(api.stops).toEqual(['lv'])
    expect(left).toBe(false)
    gate.resolve(ok(api.requests[0], { stopped: true, readTo: 20, found: [cover('g1', 1)] }))
    await leaving
    expect(left).toBe(true)
    expect(await pending).toBe('stopped')
    expect(store.state.covers!.map((c) => c.group)).toEqual(['g1'])
    expect(store.state.privacy!.find).toMatchObject({ stopped: true, readTo: 20 })
    // One undo step for what was found (and one for the choices saved before it).
    store.undo()
    expect(store.state.covers).toBeUndefined()
    expect(store.state.privacy!.kinds).toEqual(before.privacy!.kinds)
    // With no Find running, leaving is not asked.
    api.confirm = false
    expect(await reader.confirmLeaveFind(services)).toBe(true)
  })

  it('251. Find dialog choices: Find is disabled with privacy.run.busy while another Find runs; the Notifications box is hidden for area, window and imported recordings', async () => {
    editor(base('bz', 30))
    reader.startReaderState()
    await flush()
    runs.beginRun({ projectId: 'elsewhere', requestId: 'find-y', by: 'find', stop: async () => undefined })
    let els = await settle(dialog())
    const start = byTestId(els, 'find-start')!
    expect(start.props.disabled).toBe(true)
    const why = els.find((e) => e.props.id === start.props['aria-describedby'])!
    expect(textOf(why)).toBe('Find private info is already running for a video. Wait for it, or stop it there.')
    runs.resetRuns()
    els = render(dialog())
    expect(byTestId(els, 'find-start')!.props.disabled).toBe(false)
    expect(kindBoxes(els).map((e) => e.props['data-kind'])).toContain('notice')
    const notice = async (p: Project): Promise<boolean> => {
      unmountAll()
      editor(p)
      return kindBoxes(await settle(dialog())).some((e) => e.props['data-kind'] === 'notice')
    }
    const b = base('bz', 30)
    expect(await notice({ ...b, capture: { ...b.capture!, region: { x: 0, y: 0, w: 0.5, h: 0.5 } } as Project['capture'] })).toBe(false)
    expect(await notice({ ...b, capture: { ...b.capture!, target: 'window' } as Project['capture'] })).toBe(false)
    expect(await notice({ ...b, source: { kind: 'import' } } as unknown as Project)).toBe(false)
    expect(await notice(b)).toBe(true)
  })

  it('254. The progress line: phases, waiting while recording, the second estimate, Stop', async () => {
    editor(base('pg', 60))
    const gate = deferred<FindResult>()
    api.find = () => gate.promise
    const pending = run.startFind(services, choices({ listen: false }))
    await flush()
    const requestId = runs.currentRun()!.requestId
    const line = (): El[] => render({ type: reader.FindProgressLine, props: { projectId: 'pg' } })
    const send = (p: Partial<FindProgress>): void => {
      for (const l of api.progress) l({ projectId: 'pg', requestId, phase: 'look', done: 0, total: 100, secondsLeft: null, ...p })
    }
    const text = (): string => textOf(line().find((e) => e.props.className === 'find-line-text'))
    send({ phase: 'look', done: 40 })
    expect(text()).toBe('Looking for changes on screen… 40%')
    send({ phase: 'waiting' })
    expect(text()).toBe('Find waits while Flown records.')
    expect(byTestId(line(), 'find-left')).toBeUndefined()
    send({ phase: 'read', done: 7, total: 30, secondsLeft: 30 })
    expect(text()).toBe('Reading text… 7 of 30')
    expect(textOf(byTestId(line(), 'find-left'))).toBe('Less than a minute left.')
    send({ phase: 'follow', done: 1, total: 2, secondsLeft: 125 })
    expect(text()).toBe('Following text…')
    expect(textOf(byTestId(line(), 'find-left'))).toBe('About 2 minutes left.')
    // Stop: main stops, what was found lands, and the line goes.
    const stop = byTestId(line(), 'find-stop')!
    expect(textOf(stop)).toBe('Stop')
    press(stop)
    await flush()
    expect(api.stops).toEqual(['pg'])
    gate.resolve(ok(api.requests[0], { stopped: true, readTo: 12 }))
    expect(await pending).toBe('stopped')
    await flush()
    expect(line()).toEqual([])
  })

  it('257. Find’s result line: foundNone with the What Find does not see link; thinned, suppressed, saidFull and stopped as separate sentences when they apply', () => {
    const view = (): El[] => render({ type: FindResultLine, props: { projectId: 'rl', onReview: () => group.commands.push('review') } })
    const end = (outcome: Record<string, unknown>): void => {
      runs.beginRun({ projectId: 'rl', requestId: `r${Math.random().toString(36).slice(2)}`, by: 'find', stop: async () => undefined })
      runs.endRun(runs.currentRun()!.requestId, { ok: true, found: 0, check: 0, said: 0, failedReads: 0, thinned: null, suppressed: 0, saidFull: false, stopped: false, crashed: false, ...outcome })
    }
    end({})
    let els = view()
    expect(allByTestId(els, 'find-sentence').map((s) => textOf(s).trim())).toEqual(['Find private info found nothing private.'])
    const link = byTestId(els, 'find-not-see')!
    expect(textOf(link)).toBe('What Find does not see')
    expect(link.props['aria-expanded']).toBe(false)
    press(link)
    els = view()
    expect(allByTestId(els, 'find-not-see-list')[0]).toBeDefined()
    expect(byTestId(els, 'find-review')).toBeUndefined()
    unmountAll()
    end({ found: 4, check: 1, said: 1, failedReads: 2, thinned: 3, suppressed: 2, saidFull: true, stopped: true })
    els = view()
    expect(allByTestId(els, 'find-sentence').map((s) => textOf(s).trim())).toEqual([
      'Found 4 private items.',
      '1 of them is to check.',
      '1 was said aloud and is bleeped.',
      'Flown could not read 2 parts of the video. They are covered until you check them.',
      'Flown read 3 minutes of this video less often, so it may have missed text there.',
      '2 were not suggested again, because you uncovered the same kind there before.',
      'Too many bleeps: some secrets said aloud could not be bleeped. Remove bleeps you do not need and find again.',
      'Find stopped. What it found so far stays covered to the end of the video, because Flown did not finish following it. Review to trim them.'
    ])
    expect(byTestId(els, 'find-not-see')).toBeUndefined()
    press(byTestId(els, 'find-review'))
    expect(group.commands).toEqual(['review'])
    // A failure names its cause in one sentence.
    unmountAll()
    runs.beginRun({ projectId: 'rl', requestId: 'rf', by: 'find', stop: async () => undefined })
    runs.endRun('rf', { ok: false, reason: 'tooLarge' })
    expect(allByTestId(view(), 'find-sentence').map((s) => textOf(s).trim())).toEqual(['This recording is too large for Find to read: more than 7680 × 4320 pixels.'])
  })
})
