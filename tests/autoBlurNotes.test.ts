import fs from 'node:fs'
import path from 'node:path'
import { beforeEach, describe, expect, it, vi } from 'vitest'
import type { FindProgress, FindRequest, FindResult, FoundCover, OriginCovers, ReaderState, CopyInfo } from '../src/shared/api/privacy'
import { EditStore } from '../src/shared/editor/editStore'
import { DEFAULT_KEYMAP } from '../src/shared/editor/shortcuts'
import { hidesSomething, privateBleepWord, privateItems } from '../src/shared/privacy/coverData'
import { captionsSig } from '../src/shared/privacy/findState'
import { privacyKeep, privacyReviewItems } from '../src/shared/review/privacyReview'
import type { Bleep, CaptionSegment, Cover, Project, Shape, Transcript } from '../src/shared/types'
import { allByTestId, byTestId, contexts, focused, mockReact, render, settle, textOf, unmountAll, useEditorContexts, type El } from './studioHarness'
import { base, coverOf, key, oldFixtures, words } from './autoBlurFixtures'
import { migrateProject } from '../src/shared/engine/project'

/*
 * What part P5 says about privacy outside the Private info section (docs/design/auto-blur.md §2.10-2.14;
 * §17.1 tests 174-179, 183, 185, 249, 250, 253 and 255): the export dialog's note, the notes of the
 * transcription choices, the translations, the guide and the publishing pack, the copies offer,
 * Settings › Private info and its place in Settings. Rendered without a DOM; main is a fake.
 */

const api = {
  prefs: new Map<string, unknown>(),
  reader: { status: 'none' } as ReaderState,
  readerListeners: [] as ((s: ReaderState) => void)[],
  progress: [] as ((p: FindProgress) => void)[],
  find: null as null | ((req: FindRequest) => Promise<FindResult>),
  requests: [] as FindRequest[],
  stops: [] as string[],
  calls: [] as string[],
  names: [] as string[][],
  copies: [] as CopyInfo[],
  covered: [] as string[][],
  origin: { missing: 0, covers: [], bleeps: [] } as OriginCovers
}
let clipboardText = ''
/** The AI providers set up: one for the publishing pack's cards (test 255). */
let providers: unknown[] = []
vi.stubGlobal('document', { activeElement: null, body: {}, querySelector: () => null, getElementById: () => null })
vi.stubGlobal('navigator', { clipboard: { writeText: async (text: string) => void (clipboardText = text) } })
vi.stubGlobal('MutationObserver', class {
  observe(): void {}
  disconnect(): void {}
})
const windowListeners = new Map<string, ((e: unknown) => void)[]>()
vi.stubGlobal('window', {
  setTimeout: (fn: () => void) => setTimeout(fn, 0),
  clearTimeout: (id: number) => clearTimeout(id),
  requestAnimationFrame: () => 0,
  confirm: () => true,
  addEventListener: (type: string, fn: (e: unknown) => void) => windowListeners.set(type, [...(windowListeners.get(type) ?? []), fn]),
  removeEventListener: (type: string, fn: (e: unknown) => void) => windowListeners.set(type, (windowListeners.get(type) ?? []).filter((f) => f !== fn)),
  dispatchEvent: (e: { type: string }) => {
    for (const f of windowListeners.get(e.type) ?? []) f(e)
    return true
  },
  api: {
    getPref: async (k: string) => api.prefs.get(k) ?? null,
    setPref: async (k: string, v: unknown) => void api.prefs.set(k, v),
    readerState: async () => api.reader,
    onReaderState: (l: (s: ReaderState) => void) => {
      api.readerListeners.push(l)
      return () => undefined
    },
    downloadReader: async () => {
      api.calls.push('download')
      return { status: 'downloading', done: 0, total: 100 }
    },
    cancelReaderDownload: async () => void api.calls.push('cancel'),
    removeReader: async () => {
      api.calls.push('remove')
      return { status: 'none' }
    },
    onFindProgress: (l: (p: FindProgress) => void) => {
      api.progress.push(l)
      return () => undefined
    },
    findPrivate: (req: FindRequest) => {
      api.requests.push(req)
      return api.find!(req)
    },
    stopFind: async (id: string) => void api.stops.push(id),
    setPrivateNames: async (names: string[]) => void api.names.push(names),
    copies: async () => api.copies,
    coverCopies: async (_id: string, ids: string[]) => {
      api.covered.push(ids)
      return { covered: ids.length, skipped: [] }
    },
    originCovers: async () => api.origin,
    listAiProviders: async () => providers,
    cancelAiText: async () => undefined
  }
})
vi.stubGlobal('CSS', { escape: (s: string) => s })
for (const name of ['HTMLElement', 'HTMLButtonElement', 'HTMLInputElement', 'HTMLTextAreaElement']) vi.stubGlobal(name, class {})
mockReact()
vi.doMock('../src/renderer/src/editor/modalFocus', () => ({ useModalFocus: () => undefined }))
// A new cover's colour is read from the recording: answered here.
vi.doMock('../src/renderer/src/privacy/coverPick', () => ({ ringColourAt: async () => '#123456', coverColourNow: async () => '#654321' }))

// Renderer code: imported at run time so the Node typecheck of tests/ does not follow it.
type Comp = (p: Record<string, unknown>) => unknown
const load = async <T>(file: string): Promise<T> => (await import(/* @vite-ignore */ `../src/renderer/src/${file}`)) as T
const { PrivacyExportNote } = await load<{ PrivacyExportNote: Comp }>('privacy/PrivacyExportNote')
const { TranscribeNote } = await load<{ TranscribeNote: Comp }>('privacy/TranscribeNote')
const { TranslatedNote } = await load<{ TranslatedNote: Comp }>('privacy/TranslatedNote')
const { NotCheckedNote } = await load<{ NotCheckedNote: Comp }>('privacy/NotCheckedNote')
const { PublishMaskedNote } = await load<{ PublishMaskedNote: Comp }>('privacy/PublishMaskedNote')
const { CopiesOffer } = await load<{ CopiesOffer: Comp }>('privacy/CopiesOffer')
const { PrivacySettings } = await load<{ PrivacySettings: Comp }>('privacy/PrivacySettings')
const { FindDialog } = await load<{ FindDialog: Comp }>('privacy/FindDialog')
const { SettingsDialog } = await load<{ SettingsDialog: Comp }>('settings/SettingsDialog')
const { PublishDialog } = await load<{ PublishDialog: Comp }>('publish/PublishDialog')
const reader = await load<{ resetReaderState(): void; startReaderState(): void; readerNow(): ReaderState | null }>('privacy/readerState')
const runs = await load<{ beginRun(r: unknown): boolean; endRun(id: string, o: unknown): void; resetRuns(): void; currentRun(): { requestId: string } | null }>('privacy/findRuns')
const run = await load<{ startFind(s: unknown, c: unknown): Promise<string> }>('privacy/privacyRun')
const peek = await load<{ peekNow(): { marks: boolean }; showCoverMarks(on: boolean): void }>('privacy/peek')
await useEditorContexts()

const READER = 'pp-ocrv6-tiny+small-careful-long'
const found = (id: string, start: number, over: Partial<Cover> = {}): Cover => coverOf(id, start, start + 2, [key(start, 0.6, 0.1, 0.2, 0.05)], { found: 'auto', kind: 'email', group: `g${id}`, ...over })
const blur = (id: string): Shape => ({ id, kind: 'blur', start: 2, end: 6, x: 0.1, y: 0.1, w: 0.2, h: 0.1, color: '#000000', strokeWidth: 4, fill: true, opacity: 1, strength: 0.6 })
const cardSegment = (): CaptionSegment => words('c1', 10, 'my card is 4917 6123 4567 8904 thanks')
/** A project whose captions said a card number aloud, bleeped privately. */
function cardProject(id = 'cp'): Project {
  const seg = cardSegment()
  const w = seg.words!
  const b: Bleep = { id: 'pb1', start: w[3].start - 0.05, end: w[6].end + 0.05, word: privateBleepWord('card', 'gcard'), sound: 'tone', auto: true }
  const transcript: Transcript = { language: 'en', provider: 'local', model: 'm', createdAt: '2026-11-20T10:00:00.000Z', segments: [seg] }
  return { ...base(id, 60), transcript, bleeps: [b] }
}
const flush = async (): Promise<void> => {
  for (let i = 0; i < 10; i++) await Promise.resolve()
  await new Promise((r) => setTimeout(r, 0))
}
const press = (el: El | undefined): void => (el!.props.onClick as () => void)()
const text = (els: El[], id: string): string => textOf(byTestId(els, id))

let store: EditStore<Project>
const group = { commands: [] as string[] }
const note = { waits: [] as boolean[], reviews: 0, finds: 0, exports: 0 }
function editor(p: Project): void {
  store = new EditStore(p)
  contexts.editor = { store, player: { time: 0, moving: false, screen: null } }
}
const exportNote = (p: Project): unknown => ({
  type: PrivacyExportNote,
  props: { project: p, onReview: () => note.reviews++, onFind: () => note.finds++, onWait: (w: boolean) => note.waits.push(w), onStopAndExport: () => note.exports++ }
})
/** The reader's state as main says it, heard by every user. */
async function readerIs(state: ReaderState): Promise<void> {
  api.reader = state
  reader.resetReaderState()
  reader.startReaderState()
  await flush()
}

beforeEach(async () => {
  unmountAll()
  runs.resetRuns()
  api.prefs.clear()
  api.calls.length = 0
  api.names.length = 0
  api.requests.length = 0
  api.stops.length = 0
  api.copies = []
  api.covered.length = 0
  api.origin = { missing: 0, covers: [], bleeps: [] }
  api.find = async (req) => ({ ok: true, projectId: req.projectId, requestId: req.requestId, found: [], failedReads: 0, thinSpans: '', stopped: false, readTo: null, reader: READER })
  note.waits.length = 0
  note.reviews = 0
  note.finds = 0
  note.exports = 0
  group.commands.length = 0
  clipboardText = ''
  contexts.keymap = DEFAULT_KEYMAP
  contexts.group = { group: { kind: 'none' }, keys: new Set(), single: null, select: () => undefined, notice: () => undefined, command: (id: string) => void group.commands.push(id) }
  await readerIs({ status: 'none' })
})

describe('auto-blur P5: notes, copies and Settings', () => {
  it('174. PrivacyExportNote: the hides, to-check and captions-changed lines; absent for a project hiding nothing when the reader is not downloaded; its buttons close the dialog first (finding 30)', async () => {
    // A project hiding nothing, the reader not downloaded: nothing at all.
    editor(base('en', 60))
    expect(await settle(exportNote(base('en', 60)))).toEqual([])
    // Private items, some still to check, and captions changed since Find listened.
    const p: Project = { ...cardProject('ex'), covers: [found('a', 1, { found: 'check' }), found('b', 5), coverOf('mine', 9, 10, [key(9, 0.1, 0.1, 0.1, 0.1)])], privacy: { find: { at: '2026-11-23T10:00:00.000Z', kinds: ['email'], listened: true, captionsSig: captionsSig({ language: 'en', provider: 'local', model: 'm', createdAt: 'x', segments: [] }), reader: READER } } }
    editor(p)
    const els = await settle(exportNote(p))
    expect(text(els, 'export-note-hides')).toBe('This video hides 4 private items. 3 are still to check. Review')
    expect(text(els, 'export-note-captions-changed')).toBe('The captions changed after Find listened to them. Find again to check what is said. Find again…')
    // The buttons are the dialog's: it closes itself first, then opens Review or the Find dialog.
    press(byTestId(els, 'export-note-review'))
    press(byTestId(els, 'export-note-captions-find'))
    expect([note.reviews, note.finds]).toEqual([1, 1])
    const dialog = fs.readFileSync(path.join(__dirname, '../src/renderer/src/editor/ExportDialog.tsx'), 'utf8')
    expect(dialog).toMatch(/onReview=\{\(\) => \{\s*props\.onClose\(\)\s*openPrivateReview\(group\.command\)\s*\}\}/)
    expect(dialog).toMatch(/onFind=\{\(\) => \{\s*props\.onClose\(\)\s*group\.command\('findPrivate'\)\s*\}\}/)
  })

  it('175. The export dialog of a project hiding nothing renders exactly as before (snapshot)', async () => {
    // Every old project, as it loads, with the reader unknown, not downloaded or unusable: the note
    // draws nothing and never holds Export, so the dialog is what it was.
    for (const state of [null, { status: 'none' }, { status: 'unavailable', reason: 'helper' }] as (ReaderState | null)[]) {
      if (state) await readerIs(state)
      else reader.resetReaderState()
      for (const f of oldFixtures()) {
        const p = migrateProject(f.raw)
        if (hidesSomething(p) || (p.shapes ?? []).some((s) => s.kind === 'blur' || s.kind === 'pixelate')) continue
        unmountAll()
        editor(p)
        expect(await settle(exportNote(p)), f.name).toEqual([])
      }
    }
    expect(note.waits.filter(Boolean)).toEqual([])
    // The dialog's Export is held only by a Find running for the video (findHold, false otherwise).
    const dialog = fs.readFileSync(path.join(__dirname, '../src/renderer/src/editor/ExportDialog.tsx'), 'utf8')
    expect(dialog).toContain("const canExport = (mode === 'single' ? !(audioOnly && !hasSound) : items.length > 0) && !findHold")
    expect(dialog).toContain('const [findHold, setFindHold] = useState(false)')
  })

  it('176. TranscribeNote shows for a service when Find listened or private bleeps exist', () => {
    const say = (p: Project, place: string): string => textOf(render({ type: TranscribeNote, props: { project: p, place } }))
    const hears = 'The service hears everything said in the video, secrets too. Bleeps apply only to what Flown makes from it.'
    expect(say(cardProject(), 'service')).toBe(hears)
    expect(say({ ...base('t', 30), privacy: { find: { at: 'x', kinds: [], listened: true } } }, 'service')).toBe(hears)
    // On this PC, or with nothing private said: nothing.
    expect(say(cardProject(), 'local')).toBe('')
    expect(say({ ...base('t', 30), bleeps: [{ id: 'o', start: 1, end: 2, word: 'darn', sound: 'tone' }] }, 'service')).toBe('')
    expect(say({ ...base('t', 30), privacy: { find: { at: 'x', kinds: ['email'], listened: false } } }, 'service')).toBe('')
  })

  it('177. TranslatedNote shows for a translation not translated again since a private bleep', () => {
    const p = cardProject()
    const track = (maskedFor?: string): Project => ({ ...p, captionTracks: [{ language: 'es', by: 'local', model: 'm', createdAt: 'x', segments: [{ id: 'c1', text: 'mi tarjeta es 4917 6123 4567 8904', src: 'h', ...(maskedFor !== undefined ? { maskedFor } : {}) }] }] })
    const say = (q: Project, language: string): string => textOf(render({ type: TranslatedNote, props: { project: q, language } }))
    expect(say(track(), 'es')).toContain('Captions over secrets said aloud show as •••• in this language until you translate it again.')
    // Translated again from the masked text: shown as it is, and no note.
    expect(say(track('pb1'), 'es')).toBe('')
    // Another language, or no private bleep over its captions: nothing.
    expect(say(track(), 'fr')).toBe('')
    expect(say({ ...track(), bleeps: [] }, 'es')).toBe('')
  })

  it('178. NotCheckedNote shows in ShotViewer with Also send the screenshots and no Find, shows privacy.guide.unfinished after a stopped Find, and shows in the guide’s save and copy area when the reader is downloaded', async () => {
    const say = (p: Project, place: string): El[] => render({ type: NotCheckedNote, props: { project: p, place } })
    const line = (els: El[]): string => (els.length ? textOf(els[0]) : '')
    const plain = base('g', 30)
    expect(line(say(plain, 'send'))).toBe('Find private info has not checked this video.')
    const stopped: Project = { ...plain, privacy: { find: { at: 'x', kinds: ['email'], listened: false, reader: READER, stopped: true, readTo: 12 } } }
    expect(line(say(stopped, 'send'))).toBe('Find private info did not finish on this video. Find again before you send the screenshots.')
    const done: Project = { ...plain, privacy: { find: { at: 'x', kinds: ['email'], listened: false, reader: READER } } }
    expect(say(done, 'send')).toEqual([])
    // The save and copy area: only once the reader is downloaded, each line with Find….
    expect(say(plain, 'save')).toEqual([])
    await readerIs({ status: 'ready', bytes: 1, decodeMs: null })
    const els = say(plain, 'save')
    expect(line(els)).toBe('Find private info has not checked this video. Find…')
    press(byTestId(els, 'privacy-guide-find'))
    expect(group.commands).toEqual(['findPrivate'])
    expect(line(say(stopped, 'save'))).toContain('did not finish on this video')
    // Mounted where §2.11 puts them.
    const viewer = fs.readFileSync(path.join(__dirname, '../src/renderer/src/guide/ShotViewer.tsx'), 'utf8')
    expect(viewer).toContain('<NotCheckedNote project={props.project} place="send" />')
  })

  it('179. PrivacySettings: the reader’s states and buttons; the lists; regions; colour; one shared state with the dialog (finding 29)', async () => {
    editor(base('st', 30))
    const view = (): unknown => ({ type: PrivacySettings, props: { reveal: false } })
    let els = await settle(view())
    expect(textOf(els.find((e) => e.type === 'h3'))).toBe('Private info')
    expect(text(els, 'privacy-settings-reader')).toBe('Not downloaded.Download')
    // Download: main's answer is the state every user shows, the Find dialog too.
    press(byTestId(els, 'privacy-settings-download'))
    await flush()
    expect(api.calls).toEqual(['download'])
    els = render(view())
    expect(text(els, 'privacy-settings-reader')).toBe('Downloading the text reader… 0%Cancel')
    const find = await settle({ type: FindDialog, props: { services: contexts.editor, onClose: () => undefined, mode: 'find' } })
    expect(text(find, 'find-reader-progress')).toBe('Downloading the text reader… 0%')
    press(byTestId(render(view()), 'privacy-settings-cancel'))
    await flush()
    expect(api.calls).toEqual(['download', 'cancel'])
    for (const l of api.readerListeners) l({ status: 'ready', bytes: 27608757, decodeMs: 1.2 })
    els = render(view())
    expect(text(els, 'privacy-settings-reader')).toBe('Downloaded.Remove')
    press(byTestId(els, 'privacy-settings-remove'))
    await flush()
    expect(api.calls).toEqual(['download', 'cancel', 'remove'])
    for (const l of api.readerListeners) l({ status: 'damaged' })
    expect(text(render(view()), 'privacy-settings-reader')).toBe('The downloaded files are damaged. Download them again.Download')
    for (const l of api.readerListeners) l({ status: 'failed', reason: 'The connection was lost.' })
    expect(text(render(view()), 'privacy-settings-reader')).toBe('The text reader could not be downloaded. The connection was lost.Try again')
    // The lists: saved when the field is left, and the names given to main for its logs.
    els = render(view())
    const names = byTestId(els, 'privacy-settings-names')!
    ;(names.props.onChange as (e: unknown) => void)({ target: { value: 'Ada Lovelace\n\nAcme*' } })
    els = render(view())
    ;(byTestId(els, 'privacy-settings-names')!.props.onBlur as () => void)()
    await flush()
    expect(api.prefs.get('privacy')).toMatchObject({ names: ['Ada Lovelace', 'Acme*'] })
    expect(api.names.at(-1)).toEqual(['Ada Lovelace', 'Acme*'])
    els = render(view())
    ;(byTestId(els, 'privacy-settings-never')!.props.onChange as (e: unknown) => void)({ target: { value: 'Flown' } })
    els = render(view())
    ;(byTestId(els, 'privacy-settings-never')!.props.onBlur as () => void)()
    expect(api.prefs.get('privacy')).toMatchObject({ neverHide: ['Flown'] })
    // Kinds for a new video.
    const email = els.find((e) => e.type === 'input' && e.props['data-kind'] === 'email')!
    expect(email.props.checked).toBe(true)
    ;(email.props.onChange as (e: unknown) => void)({ target: { checked: false } })
    expect((api.prefs.get('privacy') as { kinds: string[] }).kinds).not.toContain('email')
    // Regions: Change… opens the regions dialog; Done saves the regions added.
    els = render(view())
    press(byTestId(els, 'privacy-settings-regions-change'))
    els = render(view())
    expect(byTestId(els, 'regions-dialog')).toBeDefined()
    const bd = els.find((e) => e.type === 'input' && e.props['data-region'] === 'BD')!
    ;(bd.props.onChange as (e: unknown) => void)({ target: { checked: true } })
    els = render(view())
    press(byTestId(els, 'regions-done'))
    els = render(view())
    expect(byTestId(els, 'regions-dialog')).toBeUndefined()
    expect((api.prefs.get('privacy') as { regions: string[] }).regions).toEqual(['BD'])
    expect(text(els, 'privacy-settings-regions')).toBe('Phone numbers from United States and Bangladesh Change…')
    // Colour of new covers.
    const colour = byTestId(els, 'privacy-settings-colour')!
    expect(colour.props.value).toBe('ring')
    ;(colour.props.onChange as (e: unknown) => void)({ target: { value: 'black' } })
    expect((api.prefs.get('privacy') as { colour: string }).colour).toBe('black')
    expect(byTestId(render(view()), 'privacy-settings-colour')!.props.value).toBe('black')
  })

  it('183. The export note counts a Check row reviewed by Keep as done', async () => {
    const p: Project = { ...base('ck', 60), covers: [found('a', 1, { found: 'check' }), found('b', 5)] }
    editor(p)
    let els = await settle(exportNote(p))
    expect(text(els, 'export-note-hides')).toBe('This video hides 2 private items. 2 are still to check. Review')
    // Keep on the Check row (Review's Keep): it is done; it still hides its item.
    const check = privacyReviewItems(p).find((r) => r.key.endsWith(':ga'))!
    const kept = privacyKeep(p, [check])
    expect(privateItems(kept)).toMatchObject({ items: 2, waiting: 1, check: 0 })
    unmountAll()
    editor(kept)
    els = await settle(exportNote(kept))
    expect(text(els, 'export-note-hides')).toBe('This video hides 2 private items. 1 is still to check. Review')
    const all = privacyKeep(kept, privacyReviewItems(kept))
    unmountAll()
    editor(all)
    els = await settle(exportNote(all))
    expect(text(els, 'export-note-hides')).toBe('This video hides 2 private items. Review')
    expect(byTestId(els, 'export-note-to-check')).toBeUndefined()
  })

  it('185. PrivacySettings is the child of .settings-body after LocalAiSection, with its heading, and SettingsSection privacy opens Settings scrolled to it', async () => {
    const others = ['LanguageSection', 'AiProvidersSection', 'SpeechModelsSection', 'LocalAiSection', 'CaptionDownloadsSection', 'MusicDownloadsSection', 'BrandKitSection', 'ShareSection', 'HealthSections', 'AboutSection']
    const els = render({ type: SettingsDialog, props: { section: 'privacy', onClose: () => undefined } }, others)
    const body = els.find((e) => e.props.className === 'settings-body')!
    const children = (body.props.children as unknown[]).filter((c) => c && typeof c === 'object') as El[]
    const names = children.map((c) => (c.type as { name: string }).name)
    expect(names.indexOf('PrivacySettings')).toBe(names.indexOf('LocalAiSection') + 1)
    const mine = children.find((c) => (c.type as { name: string }).name === 'PrivacySettings')!
    expect(mine.props.reveal).toBe(true)
    // Its heading, and opened at 'privacy' it scrolls into view and its heading takes the focus.
    focused.length = 0
    const section = await settle({ type: PrivacySettings, props: { reveal: true } })
    const heading = section.find((e) => e.type === 'h3')!
    expect(heading.props.id).toBe('settings-privacy-title')
    expect(section.find((e) => e.type === 'section')!.props['aria-labelledby']).toBe('settings-privacy-title')
    expect(focused.map((e) => e.props.id)).toEqual(['settings-privacy-title'])
    // Settings opens there from anywhere (the palette and the reader's line).
    const button = fs.readFileSync(path.join(__dirname, '../src/renderer/src/settings/SettingsButton.tsx'), 'utf8')
    expect(button).toContain("wanted === 'privacy'")
  })

  it('249. The export note’s new lines: Wait for Find keeps Export disabled until the results are applied; Stop Find and export applies what was found, then exports; notChecked shows only with the reader; unfinished, thinned and saidRemoved follow FindRecord; weak with Turn them all into covers; hides only with a private item; recordingsOff by hidesSomething alone', async () => {
    const p = base('wf', 60)
    editor(p)
    // A Find running for this video holds Export (onWait) until what it found is applied.
    let resolve!: (r: FindResult) => void
    api.find = (req) => new Promise<FindResult>((r) => (resolve = (x) => r({ ...x, projectId: req.projectId, requestId: req.requestId })))
    await readerIs({ status: 'ready', bytes: 1, decodeMs: null })
    const pending = run.startFind(contexts.editor, { kinds: ['email'], regions: [], names: [], neverHide: [], listen: false })
    await flush()
    let els = await settle(exportNote(store.state))
    expect(note.waits).toEqual([true])
    expect(text(els, 'export-note-running')).toContain('Find private info is still running. This export does not include what it is finding.')
    const wait = byTestId(els, 'export-note-wait')!
    expect(wait.props['aria-pressed']).toBe(false)
    press(wait)
    els = render(exportNote(store.state))
    expect(byTestId(els, 'export-note-wait')!.props['aria-pressed']).toBe(true)
    // Stop Find and export: Find stops, what it found lands, and only then the export starts.
    let landedBeforeExport = false
    note.exports = 0
    const exporting = new Promise<void>((done) => {
      const watch = setInterval(() => {
        if (note.exports > 0) {
          clearInterval(watch)
          done()
        }
      }, 1)
    })
    press(byTestId(els, 'export-note-stop'))
    await flush()
    expect(api.stops).toEqual(['wf'])
    expect(note.exports).toBe(0)
    resolve({ ok: true, projectId: '', requestId: '', found: [{ kind: 'email', score: 0.9, group: 'gs', start: 1, end: 3, path: '1 0.1 0.1 0.2 0.05', color: '#202020' }], failedReads: 0, thinSpans: '', stopped: true, readTo: 20, reader: READER })
    await pending
    landedBeforeExport = !!store.state.covers?.length
    await exporting
    expect(landedBeforeExport).toBe(true)
    els = render(exportNote(store.state))
    expect(note.waits).toEqual([true, false])
    // notChecked: only once the reader is downloaded.
    unmountAll()
    editor(base('nc', 60))
    expect(text(await settle(exportNote(base('nc', 60))), 'export-note-not-checked')).toBe('Find private info has not checked this video. Find…')
    await readerIs({ status: 'none' })
    unmountAll()
    expect(await settle(exportNote(base('nc', 60)))).toEqual([])
    // unfinished, thinned and saidRemoved follow the record.
    const rec: Project = { ...base('rc', 300), privacy: { find: { at: 'x', kinds: ['email'], listened: true, reader: READER, stopped: true, readTo: 95, thin: '10 100;200 250', saidIds: ['gone1', 'gone2'] } } }
    unmountAll()
    editor(rec)
    els = await settle(exportNote(rec))
    expect(text(els, 'export-note-unfinished')).toBe('Find private info did not finish: it read this video up to 1:35.0. Find again before you share it. Find again…')
    expect(text(els, 'export-note-thinned')).toBe('Find read 2 minutes of this video less often, so it may have missed text there.')
    expect(text(els, 'export-note-said-removed')).toBe('2 secrets said aloud are no longer bleeped.')
    expect(byTestId(els, 'export-note-hides')).toBeUndefined()
    // weak, with Turn them all into covers (one undo step); a blur alone hides no private item.
    const weak: Project = { ...base('wk', 60), shapes: [blur('s1'), blur('s2')] }
    unmountAll()
    editor(weak)
    els = await settle(exportNote(weak))
    expect(text(els, 'export-note-weak')).toBe('2 blurred or pixelated areas can sometimes be read back. Turn them all into covers')
    expect(byTestId(els, 'export-note-hides')).toBeUndefined()
    press(byTestId(els, 'export-note-weak-turn'))
    await flush()
    expect(store.state.shapes!.some((s) => s.kind === 'blur')).toBe(false)
    expect(store.state.covers!.map((c) => c.color)).toEqual(['#123456', '#123456'])
    store.undo()
    expect(store.state).toBe(weak)
    // recordingsOff follows hidesSomething alone: a project with only an ordinary bleep hides something and has no private item.
    const bleeped: Project = { ...base('bl', 60), bleeps: [{ id: 'o', start: 1, end: 2, word: 'darn', sound: 'tone' }] }
    expect([hidesSomething(bleeped), privateItems(bleeped).items]).toEqual([true, 0])
    const dialog = fs.readFileSync(path.join(__dirname, '../src/renderer/src/editor/ExportDialog.tsx'), 'utf8')
    expect(dialog).toContain('hides: hidesSomething(project)')
  })

  it('250. Copies: after Find on a project with two copies the offer shows and covers both closed copies; a copy’s export note shows fromOriginal, and Bring them over adds the covers in one undo step', async () => {
    const p: Project = { ...base('orig', 60), covers: [found('a', 1)], privacy: { find: { at: 'x', kinds: ['email'], listened: false, reader: READER } } }
    editor(p)
    api.copies = [
      { id: 'copy1', name: 'Short', open: false },
      { id: 'copy2', name: 'Vertical', open: false }
    ]
    const offer = (): unknown => ({ type: CopiesOffer, props: { services: contexts.editor } })
    let els = await settle(offer())
    expect(text(els, 'copies-offer')).toBe('Also cover the 2 copies made from this video')
    press(byTestId(els, 'copies-offer'))
    await flush()
    expect(api.covered).toEqual([['copy1', 'copy2']])
    els = render(offer())
    expect(text(els, 'copies-done')).toBe('Covered the 2 copies made from this video. Their covers wait in their Review.')
    // Before Find there is nothing to offer.
    unmountAll()
    editor(base('orig', 60))
    expect(await settle(offer())).toEqual([])
    // A copy made before Find: its note says what its original has, and Bring them over adds it as suggestions.
    const fc: FoundCover = { kind: 'email', score: 0.9, group: 'go', start: 4, end: 6, path: '4 0.3 0.3 0.2 0.05', color: '#303030' }
    const pb: Bleep = { id: 'pbx', start: 8, end: 9, word: privateBleepWord('phone', 'gp'), sound: 'tone' }
    api.origin = { missing: 2, covers: [fc], bleeps: [pb] }
    const copy: Project = { ...base('copy1', 60), copyOf: { id: 'orig', name: 'orig', kind: 'clip' } as Project['copyOf'] }
    unmountAll()
    editor(copy)
    els = await settle(exportNote(copy))
    expect(text(els, 'export-note-from-original')).toBe('The video this was made from has covers this copy does not have. Bring them over')
    press(byTestId(els, 'export-note-bring-over'))
    expect(store.state.covers!.map((c) => [c.kind, c.found, c.group])).toEqual([['email', 'auto', 'go']])
    expect(store.state.bleeps).toEqual([{ ...pb, auto: true }])
    store.undo()
    expect(store.state).toBe(copy)
    els = render(exportNote(copy))
    expect(byTestId(els, 'export-note-from-original')).toBeUndefined()
  })

  it('253. Settings states: the reader’s unavailable reasons show their messages; the colour of new covers and Show where covers are are remembered', async () => {
    editor(base('us', 30))
    const view = (): unknown => ({ type: PrivacySettings, props: { reveal: false } })
    await readerIs({ status: 'unavailable', reason: 'helper' })
    let els = await settle(view())
    expect(text(els, 'privacy-settings-reader')).toBe("The text reader cannot run on this PC. Flown's installation may be damaged; installing it again may help.")
    expect(byTestId(els, 'privacy-settings-download')).toBeUndefined()
    await readerIs({ status: 'unavailable', reason: 'cpu' })
    els = render(view())
    expect(text(els, 'privacy-settings-reader')).toBe("The text reader cannot run on this PC's processor.")
    // Remembered from the preference: the colour and Show where covers are.
    unmountAll()
    api.prefs.set('privacy', { colour: 'white', showCovers: false })
    els = await settle(view())
    expect(byTestId(els, 'privacy-settings-colour')!.props.value).toBe('white')
    const marks = byTestId(els, 'privacy-settings-show-covers')!
    expect(marks.props.checked).toBe(false)
    ;(marks.props.onChange as (e: unknown) => void)({ target: { checked: true } })
    expect(api.prefs.get('privacy')).toEqual({ colour: 'white' })
    expect(peek.peekNow().marks).toBe(true)
    els = render(view())
    ;(byTestId(els, 'privacy-settings-show-covers')!.props.onChange as (e: unknown) => void)({ target: { checked: false } })
    expect(api.prefs.get('privacy')).toEqual({ colour: 'white', showCovers: false })
    expect(peek.peekNow().marks).toBe(false)
    peek.showCoverMarks(true)
  })

  it('255. Publish dialog: PublishMaskedNote shows when the saved description holds a spoken form; Copy puts the masked text on the clipboard', async () => {
    const said = cardProject('pub')
    // Enough speech for the pack to write from.
    const more = words('c2', 20, 'then we open the settings page and turn on the new reports for everyone in the team so they can see the numbers every morning before the meeting starts')
    const p: Project = { ...said, transcript: { ...said.transcript!, segments: [...said.transcript!.segments, more] } }
    const say = (t: string): string => textOf(render({ type: PublishMaskedNote, props: { project: p, text: t } }))
    expect(say('Pay with 4917 6123 4567 8904 today')).toBe('Secrets said aloud show as •••• when this text is copied, saved or shared.')
    expect(say('Nothing private here')).toBe('')
    expect(textOf(render({ type: PublishMaskedNote, props: { project: base('n', 30), text: 'Pay with 4917 6123 4567 8904 today' } }))).toBe('')
    // The dialog's Copy: the text as the user wrote it stays in the card; the clipboard gets it masked.
    providers = [{ id: 'o', kind: 'openai', label: '', model: 'm', transcriptionModel: 't', maskedKey: '', createdAt: '' }]
    editor(p)
    let els = await settle({ type: PublishDialog, props: { project: p, request: null, onClose: () => undefined } })
    const card = (kind: string): El => {
      const found = els.find((e) => e.props['data-publish-card'] === kind)
      if (!found) throw new Error(`no ${kind} card: ${els.map((e) => String(e.type)).slice(0, 40).join(' ')}`)
      return found
    }
    const inCard = (kind: string): El[] => {
      const out: El[] = []
      const visit = (n: unknown): void => {
        if (Array.isArray(n)) return n.forEach(visit)
        if (!n || typeof n !== 'object' || !('props' in n)) return
        const c = n as El
        if (typeof c.type === 'string') out.push(c)
        visit(c.props.children)
      }
      visit(card(kind).props.children)
      return out
    }
    const area = inCard('xpost').find((e) => e.type === 'textarea')!
    ;(area.props.onChange as (e: unknown) => void)({ target: { value: 'My card 4917 6123 4567 8904 works' } })
    els = await settle({ type: PublishDialog, props: { project: p, request: null, onClose: () => undefined } })
    // Only the card whose text holds the secret says so.
    expect(allByTestId(els, 'privacy-publish-masked').map((e) => textOf(e))).toEqual(['Secrets said aloud show as •••• when this text is copied, saved or shared.'])
    const copy = inCard('xpost').find((e) => e.type === 'button' && textOf(e).trim() === 'Copy')!
    press(copy)
    await flush()
    expect(clipboardText).toBe('My card •••• •••• •••• •••• works')
    expect(inCard('xpost').find((e) => e.type === 'textarea')!.props.value).toBe('My card 4917 6123 4567 8904 works')
  })
})
