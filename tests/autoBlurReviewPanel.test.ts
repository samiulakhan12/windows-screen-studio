import { beforeEach, describe, expect, it, vi } from 'vitest'
import { EditStore } from '../src/shared/editor/editStore'
import { DEFAULT_KEYMAP } from '../src/shared/editor/shortcuts'
import { doneCounts, doneReviewing, privacyPendingCount } from '../src/shared/review/privacyReview'
import { privateBleepWord } from '../src/shared/privacy/coverData'
import type { Bleep, Cover, PrivateKind, Project } from '../src/shared/types'
import { allByTestId, byTestId, contexts, focused, key, mockReact, render, textOf, unmountAll, useEditorContexts, type El } from './studioHarness'
import { base, coverOf, key as boxKey, words } from './autoBlurFixtures'

/*
 * Review's private items in the panel (docs/design/auto-blur.md §2.7, §2.8, §11; §17.1 tests 164-167,
 * 181, 182, 241, 242, 244-246 and 258): the Private filter and its kind filter, the verbs *Keep
 * covered* and *Uncover*, places as parts, Peek, Listen and *Select on the timeline*, *Peek while
 * reviewing* with V, the confirms that start on Cancel, Done reviewing, Find's progress and the
 * unfinished line. Rendered without a DOM (tests/studioHarness.ts).
 */

vi.stubGlobal('document', { activeElement: null, body: {}, querySelector: () => null })
const posted: (() => void)[] = []
vi.stubGlobal('window', {
  setTimeout: (fn: () => void) => setTimeout(fn, 0),
  clearTimeout: (id: number) => clearTimeout(id),
  requestAnimationFrame: () => 0,
  cancelAnimationFrame: () => undefined,
  api: { copies: async () => [] }
})
vi.stubGlobal('CSS', { escape: (s: string) => s })
vi.stubGlobal('HTMLElement', class {})
vi.stubGlobal('HTMLButtonElement', class {})
void posted

mockReact()
// What a row's preview stretch plays (Review plays it on the editor's animation frames).
const stretches: { from: number; until: number }[] = []
vi.doMock('../src/renderer/src/review/playStretch', () => ({
  playStretch: (_player: unknown, _clips: unknown, s: { from: number; until: number }) => {
    stretches.push(s)
    return () => undefined
  }
}))
// Uncover all keeps the edit before it as a version (E-12): recorded here.
const versions: { reason: string }[] = []
vi.doMock('../src/renderer/src/versions/autoVersion', () => ({ keepVersionBefore: async (_p: unknown, reason: string) => void versions.push({ reason }) }))

// Renderer code: imported at run time so the Node typecheck of tests/ does not follow it.
const load = async <T>(file: string): Promise<T> => (await import(/* @vite-ignore */ `../src/renderer/src/${file}`)) as T
const { ReviewPanel } = await load<{ ReviewPanel: (p: unknown) => unknown }>('review/ReviewPanel')
const peek = await load<{ peekNow(): { ids: readonly string[] | 'all' | null; review: boolean; listen: string | null }; clearPeek(): void }>('privacy/peek')
const request = await load<{ requestPrivateReview(): void; takePrivateReview(): boolean }>('privacy/reviewRequest')
const runs = await load<{ beginRun(r: unknown): boolean; endRun(id: string, o: unknown): void; resetRuns(): void }>('privacy/findRuns')
await useEditorContexts()

const found = (id: string, start: number, end: number, kind: PrivateKind, group: string, over: Partial<Cover> = {}): Cover =>
  coverOf(id, start, end, [boxKey(start, 0.7, 0.05, 0.2, 0.05)], { found: 'auto', kind, group, ...over })
const said = (id: string, start: number, end: number, kind: PrivateKind, group: string): Bleep => ({ id, start, end, word: privateBleepWord(kind, group), sound: 'tone', auto: true })

let store: EditStore<Project>
const group = { selects: [] as { keys: readonly string[]; anchor: string | null }[], commands: [] as string[], notices: [] as string[] }
const panel = (): unknown => ({ type: ReviewPanel, props: { onClose: () => undefined } })
const press = (el: El | undefined): void => (el!.props.onClick as () => void)()
const rowOf = (els: El[], k: string): El => els.find((e) => e.type === 'li' && e.props['data-key'] === k)!
/** The host elements inside `el`. */
const inside = (el: El): El[] => {
  const out: El[] = []
  const visit = (n: unknown): void => {
    if (Array.isArray(n)) return n.forEach(visit)
    if (!n || typeof n !== 'object' || !('props' in n)) return
    const c = n as El
    if (typeof c.type === 'string') out.push(c)
    else if (typeof c.type === 'function') return visit((c.type as (p: unknown) => unknown)(c.props))
    visit(c.props.children)
  }
  visit(el.props.children)
  return out
}
const inRow = (els: El[], k: string, id: string): El | undefined => inside(rowOf(els, k)).find((e) => e.props['data-testid'] === id)
const list = (els: El[]): El => els.find((e) => e.type === 'ul' && String(e.props.className).startsWith('review-list'))!
const keyDown = (els: El[], k: string): ReturnType<typeof key> => {
  const e = key(k)
  ;(list(els).props.onKeyDown as (e: unknown) => void)(e)
  return e
}
const said$ = (els: El[]): string => textOf(byTestId(els, 'review-said'))
const steps = (s: EditStore<Project>): number => {
  let n = 0
  while (s.undo()) n++
  return n
}
/** Lets Review's work in slices run (its tasks are messages and timers). */
const slices = async (): Promise<void> => {
  for (let i = 0; i < 20; i++) await new Promise((r) => setTimeout(r, 5))
}

function open(p: Project, privateOnly = true): El[] {
  unmountAll()
  store = new EditStore(p)
  contexts.editor = { store, player: { time: 0, moving: false, subscribe: () => () => undefined, play: () => undefined, pause: () => undefined, seek: () => undefined } }
  if (privateOnly) request.requestPrivateReview()
  else request.takePrivateReview()
  return render(panel())
}

beforeEach(() => {
  stretches.length = 0
  versions.length = 0
  group.selects.length = 0
  group.commands.length = 0
  peek.clearPeek()
  runs.resetRuns()
  contexts.keymap = DEFAULT_KEYMAP
  contexts.group = {
    group: { kind: 'none' },
    keys: new Set(),
    single: null,
    select: (keys: readonly string[], anchor: string | null) => void group.selects.push({ keys, anchor }),
    notice: (m: string) => void group.notices.push(m),
    command: (id: string) => void group.commands.push(id)
  }
})

describe('auto-blur P5: Review panel', () => {
  it('164. Keep all … covered and Uncover all … of a kind are one undo step through heldInSlices; Uncover all asks first (focus on Cancel) and keeps a version first', async () => {
    const p: Project = { ...base('rv', 300), covers: [found('e1', 10, 12, 'email', 'ga'), found('e2', 20, 22, 'email', 'gb'), found('e3', 30, 32, 'email', 'gc'), found('k1', 40, 42, 'key', 'gd'), found('k2', 50, 52, 'key', 'ge')] }
    let els = open(p)
    const filter = byTestId(els, 'review-kind-filter')!
    expect(inside({ type: 'x', props: { children: filter.props.children } }).filter((e) => e.type === 'option').map((o) => textOf(o))).toEqual(['All kinds', 'Key or token', 'Email address'])
    ;(filter.props.onChange as (e: unknown) => void)({ target: { value: 'email' } })
    els = render(panel())
    expect(allByTestId(els, 'review-row')).toHaveLength(3)
    // Keep all email addresses covered: one edit, made in slices while the store is held.
    const keepAll = byTestId(els, 'review-keep-kind')!
    expect(textOf(keepAll)).toBe('Keep all email addresses covered')
    press(keepAll)
    // Held while it works: nothing is changed yet.
    expect(store.held).toBe(true)
    expect(store.state.covers!.filter((c) => c.kind === 'email').every((c) => c.found)).toBe(true)
    await slices()
    expect(store.held).toBe(false)
    expect(store.state.covers!.filter((c) => c.kind === 'email').every((c) => !c.found)).toBe(true)
    expect(store.state.covers!.filter((c) => c.kind === 'key').every((c) => c.found)).toBe(true)
    expect(versions).toEqual([])
    expect(steps(store)).toBe(1)

    // Uncover all keys: asked first, its focus on Cancel; Cancel changes nothing.
    els = open(p)
    ;(byTestId(els, 'review-kind-filter')!.props.onChange as (e: unknown) => void)({ target: { value: 'key' } })
    els = render(panel())
    focused.length = 0
    press(byTestId(els, 'review-uncover-kind'))
    els = render(panel())
    const ask = byTestId(els, 'review-confirm')!
    expect(ask.props.role).toBe('alertdialog')
    expect(textOf(ask)).toContain('Uncover 2 private items? They will show in every export.')
    expect(focused.map((e) => e.props['data-testid'])).toEqual(['review-confirm-cancel'])
    press(byTestId(els, 'review-confirm-cancel'))
    els = render(panel())
    expect(byTestId(els, 'review-confirm')).toBeUndefined()
    expect(store.state).toBe(p)
    // Confirmed: one edit through heldInSlices, the version kept first (as Remove all does).
    press(byTestId(els, 'review-uncover-kind'))
    els = render(panel())
    press(byTestId(els, 'review-confirm-go'))
    expect(store.held).toBe(true)
    await slices()
    expect(store.state.covers!.map((c) => c.id)).toEqual(['e1', 'e2', 'e3'])
    expect(store.state.privacy!.rejected!.map((r) => r.kind)).toEqual(['key', 'key'])
    expect(versions).toEqual([{ reason: 'review' }])
    expect(steps(store)).toBe(1)
  })

  it('165. doneReviewing keeps every waiting suggestion in one step; its confirm names the Check rows and starts on Cancel', async () => {
    const p: Project = { ...base('rv', 300), covers: [found('a', 10, 12, 'email', 'ga'), found('b', 20, 22, 'key', 'gb', { found: 'check' }), coverOf('mine', 40, 41, [boxKey(40, 0.1, 0.1, 0.1, 0.1)])], bleeps: [said('s', 30, 31, 'phone', 'gs'), { id: 'plain', start: 50, end: 51, word: 'darn', sound: 'tone', auto: true }] }
    expect(doneCounts(p)).toEqual({ waiting: 3, check: 1 })
    let els = open(p)
    focused.length = 0
    press(byTestId(els, 'review-done'))
    els = render(panel())
    const ask = byTestId(els, 'review-confirm')!
    expect(textOf(ask)).toContain('Keep the 3 covers still waiting?')
    expect(textOf(ask)).toContain('1 of them is to check and has not been looked at.')
    expect(textOf(byTestId(els, 'review-confirm-go'))).toBe('Keep them')
    expect(focused.map((e) => e.props['data-testid'])).toEqual(['review-confirm-cancel'])
    press(byTestId(els, 'review-confirm-go'))
    await slices()
    const done = store.state
    expect(done.covers!.every((c) => !c.found)).toBe(true)
    expect(done.bleeps!.find((b) => b.id === 's')!.auto).toBeUndefined()
    // An ordinary bleep (a swear word) is not a private item: left as it was.
    expect(done.bleeps!.find((b) => b.id === 'plain')!.auto).toBe(true)
    expect(privacyPendingCount(done)).toBe(0)
    expect(doneReviewing(done)).toBe(done)
    els = render(panel())
    expect(byTestId(els, 'review-done')).toBeUndefined()
    expect(steps(store)).toBe(1)
  })

  it('166. The kind filter; with nothing left of a kind, privacy.review.emptyKind and focus on the filter (finding 34); Show all changes keeps focus (finding 32)', () => {
    const p: Project = { ...base('rv', 300), zooms: [{ id: 'z1', start: 5, end: 7, scale: 2, focus: { mode: 'cursor' }, auto: true } as Project['zooms'][number]], covers: [found('e1', 10, 12, 'email', 'ga'), found('k1', 40, 42, 'key', 'gd')] }
    let els = open(p)
    // The Private filter: private rows only.
    expect(allByTestId(els, 'review-row').map((r) => r.props['data-key'])).toEqual(['private:email:ga', 'private:key:gd'])
    // Show all changes is a checkbox that stays where it is (its focus too) and lists every change.
    const showAll = byTestId(els, 'review-show-all')!
    expect(showAll.props.checked).toBe(false)
    focused.length = 0
    ;(showAll.props.onChange as (e: unknown) => void)({ target: { checked: true } })
    els = render(panel())
    expect(byTestId(els, 'review-show-all')!.props.checked).toBe(true)
    expect(allByTestId(els, 'review-row').map((r) => r.props['data-key'])).toEqual(['zoom:z1', 'private:email:ga', 'private:key:gd'])
    expect(focused).toEqual([])
    ;(byTestId(els, 'review-show-all')!.props.onChange as (e: unknown) => void)({ target: { checked: false } })
    els = render(panel())
    // The kind filter narrows to one kind and keeps the focus where it was.
    ;(byTestId(els, 'review-kind-filter')!.props.onChange as (e: unknown) => void)({ target: { value: 'key' } })
    els = render(panel())
    expect(allByTestId(els, 'review-row').map((r) => r.props['data-key'])).toEqual(['private:key:gd'])
    expect(focused).toEqual([])
    // Uncover the last key: the list says nothing of this kind waits, and the focus goes to the filter.
    keyDown(els, 'Delete')
    els = render(panel())
    expect(textOf(byTestId(els, 'review-empty-kind'))).toBe('Nothing of this kind is waiting.')
    expect(focused.map((e) => e.props['data-testid'])).toEqual(['review-kind-filter'])
  })

  it('167. Peek and Listen are toggle buttons whose names include the row’s title (finding 33)', () => {
    const p: Project = { ...base('rv', 300), covers: [found('e1', 42, 50, 'email', 'ga')], bleeps: [said('s1', 70, 72, 'card', 'gs')] }
    let els = open(p)
    const peekButton = inRow(els, 'private:email:ga', 'review-peek')!
    expect(peekButton.props['aria-label']).toBe('Peek: Email address · 0:42.0–0:50.0')
    expect(peekButton.props['aria-pressed']).toBe(false)
    expect(textOf(peekButton)).toBe('Peek')
    press(peekButton)
    expect(peek.peekNow().ids).toEqual(['e1'])
    els = render(panel())
    expect(inRow(els, 'private:email:ga', 'review-peek')!.props['aria-pressed']).toBe(true)
    press(inRow(els, 'private:email:ga', 'review-peek'))
    expect(peek.peekNow().ids).toBeNull()
    // Listen: on the said row, its private bleep's own sound in the preview.
    const listen = inRow(els, 'private:card:gs', 'review-listen')!
    expect(listen.props['aria-label']).toBe('Listen: Card or bank number · 1:10.0–1:12.0')
    expect(listen.props['aria-pressed']).toBe(false)
    press(listen)
    expect(peek.peekNow().listen).toBe('s1')
    els = render(panel())
    expect(inRow(els, 'private:card:gs', 'review-listen')!.props['aria-pressed']).toBe(true)
    // A cover row has no Listen; a said row no Peek.
    expect(inRow(els, 'private:email:ga', 'review-listen')).toBeUndefined()
    expect(inRow(els, 'private:card:gs', 'review-peek')).toBeUndefined()
  })

  it('181. Review’s header shows Find’s progress while it runs and Find again… after', () => {
    const p: Project = { ...base('rv', 300) }
    expect(runs.beginRun({ projectId: 'rv', requestId: 'find-1', by: 'find', stop: async () => undefined })).toBe(true)
    let els = open(p)
    const line = byTestId(els, 'find-progress')!
    expect(textOf(line)).toContain('Looking for changes on screen… 0%')
    expect(byTestId(els, 'find-stop')).toBeDefined()
    expect(byTestId(els, 'review-find-again')).toBeUndefined()
    // It ends: its result line, and Find again… now that the project has a record.
    runs.endRun('find-1', { ok: true, found: 0, check: 0, said: 0, failedReads: 0, thinned: null, suppressed: 0, saidFull: false, stopped: false, crashed: false })
    store.update((q) => ({ ...q, privacy: { find: { at: '2026-11-23T10:00:00.000Z', kinds: ['email'], listened: false, reader: 'pp-ocrv6-tiny+small-careful-long' } } }))
    els = render(panel())
    expect(byTestId(els, 'find-progress')).toBeUndefined()
    expect(textOf(byTestId(els, 'find-result'))).toContain('Find private info found nothing private.')
    const again = byTestId(els, 'review-find-again')!
    expect(textOf(again)).toBe('Find again…')
    press(again)
    expect(group.commands).toEqual(['findPrivate'])
  })

  it('182. The said rows: Said aloud badge and Listen; their titles never hold a word', () => {
    const p: Project = {
      ...base('rv', 300),
      transcript: { language: 'en', provider: 'local', model: 'm', createdAt: '2026-11-20T10:00:00.000Z', segments: [words('c1', 69, 'my card is 4917 6123 4567 8904 thanks')] },
      bleeps: [said('s1', 71, 75, 'card', 'gs')]
    }
    const els = open(p)
    const row = rowOf(els, 'private:card:gs')
    const all = inside(row)
    const title = textOf(all.find((e) => e.props.className === 'review-title'))
    expect(title).toBe('Card or bank number · 1:11.0–1:15.0')
    for (const w of ['4917', '6123', '4567', '8904', 'card is', 'thanks']) expect(textOf(row)).not.toContain(w)
    expect(all.filter((e) => e.props['data-testid'] === 'review-badge').map((b) => textOf(b))).toEqual(['Said aloud'])
    expect(textOf(inRow(els, 'private:card:gs', 'review-listen'))).toBe('Listen')
  })

  it('241. Places as parts: a group with three places shows Show the 3 items (Review’s parts); each part has its own preview stretch, Keep covered and Uncover; uncovering one part leaves the others', () => {
    const p: Project = { ...base('rv', 300), covers: [found('a', 10, 12, 'email', 'ga'), found('b', 60, 62, 'email', 'ga'), found('c', 120, 122, 'email', 'ga')] }
    let els = open(p)
    const k = 'private:email:ga'
    const toggle = inRow(els, k, 'review-toggle')!
    expect(toggle.props['aria-label']).toBe('Show the 3 items: Email address · 0:10.0–2:02.0')
    press(toggle)
    els = render(panel())
    const parts = allByTestId(els, 'review-part')
    expect(parts).toHaveLength(3)
    // Each place plays its own stretch.
    stretches.length = 0
    press(inside(parts[1]).find((e) => e.props['data-testid'] === 'review-part-play'))
    expect(stretches).toHaveLength(1)
    expect(stretches[0].from).toBeCloseTo(58.5, 5)
    // Each has Keep covered and Uncover, named by its title.
    const uncover = inside(parts[1]).find((e) => e.props['data-testid'] === 'review-part-remove')!
    expect(textOf(uncover)).toBe('Uncover')
    expect(uncover.props['aria-label']).toBe('Uncover: Top right of the screen · 1:00.0–1:02.0')
    expect(textOf(inside(parts[0]).find((e) => e.props['data-testid'] === 'review-part-keep'))).toBe('Keep covered')
    press(uncover)
    expect(store.state.covers!.map((c) => c.id)).toEqual(['a', 'c'])
    els = render(panel())
    expect(allByTestId(els, 'review-part').map((x) => x.props['data-status'])).toEqual(['pending', 'removed', 'pending'])
    expect(rowOf(els, k).props['data-status']).toBe('pending')
    expect(said$(els)).toBe('Uncovered. It will show in exports.')
  })

  it('242. The verbs: private rows’ buttons read Keep covered and Uncover, with the names privacy.review.keepRow and uncoverRow; every other kind’s buttons are unchanged; Uncover says privacy.review.uncovered', () => {
    const p: Project = { ...base('rv', 300), zooms: [{ id: 'z1', start: 5, end: 7, scale: 2, focus: { mode: 'cursor' }, auto: true } as Project['zooms'][number]], covers: [found('e1', 10, 12, 'email', 'ga'), found('e2', 20, 22, 'email', 'gb')] }
    let els = open(p, false)
    const keep = inRow(els, 'private:email:ga', 'review-keep')!
    const remove = inRow(els, 'private:email:ga', 'review-remove')!
    expect(textOf(keep)).toBe('Keep covered')
    expect(textOf(remove)).toBe('Uncover')
    expect(keep.props['aria-label']).toBe('Keep covered: Email address · 0:10.0–0:12.0')
    expect(remove.props['aria-label']).toBe('Uncover: Email address · 0:10.0–0:12.0')
    // Every other kind as before.
    expect(textOf(inRow(els, 'zoom:z1', 'review-keep'))).toBe('Keep')
    expect(textOf(inRow(els, 'zoom:z1', 'review-remove'))).toBe('Remove')
    expect(inRow(els, 'zoom:z1', 'review-remove')!.props['aria-label']).toMatch(/^Remove: /)
    press(remove)
    els = render(panel())
    expect(said$(els)).toBe('Uncovered. It will show in exports.')
    press(inRow(els, 'private:email:gb', 'review-keep'))
    els = render(panel())
    expect(said$(els)).toBe('Kept. 2 of 3 reviewed.')
  })

  it('244. Select on the timeline selects every cover of the row', () => {
    const p: Project = { ...base('rv', 300), covers: [found('a', 10, 12, 'email', 'ga'), found('b', 60, 62, 'email', 'ga'), found('x', 70, 72, 'key', 'gx')] }
    const els = open(p)
    const select = inRow(els, 'private:email:ga', 'review-select')!
    expect(textOf(select)).toBe('Select on the timeline')
    press(select)
    expect(group.selects).toEqual([{ keys: ['cover:a', 'cover:b'], anchor: 'cover:a' }])
  })

  it('245. Peek while reviewing: with it on, moving with N peeks the next row and stops peeking the last; V turns it on and off on private rows; on a row of another kind V goes on to the editor', () => {
    const p: Project = { ...base('rv', 300), zooms: [{ id: 'z1', start: 200, end: 202, scale: 2, focus: { mode: 'cursor' }, auto: true } as Project['zooms'][number]], covers: [found('a', 10, 12, 'email', 'ga'), found('b', 60, 62, 'key', 'gb')] }
    let els = open(p, false)
    // V on a private row turns it on: the selected row is peeked.
    let e = keyDown(els, 'v')
    expect(e.prevented).toBe(true)
    els = render(panel())
    expect(peek.peekNow().review).toBe(true)
    expect(peek.peekNow().ids).toEqual(['a'])
    const toggle = byTestId(els, 'review-peek-all')!
    expect(toggle.props['aria-pressed']).toBe(true)
    expect(toggle.props.title).toBe("Shows what is under the selected row's covers, magnified, in the preview only. Key: V.")
    // N: the next row is peeked, the last one no longer.
    keyDown(els, 'n')
    els = render(panel())
    expect(peek.peekNow().ids).toEqual(['b'])
    // On a row of another kind nothing is peeked, and V goes on to the editor.
    keyDown(els, 'n')
    els = render(panel())
    expect(peek.peekNow().ids).toBeNull()
    e = keyDown(els, 'v')
    expect(e.prevented).toBe(false)
    expect(e.stopped).toBe(false)
    expect(peek.peekNow().review).toBe(true)
    // Back on a private row, V turns it off.
    keyDown(els, 'p')
    els = render(panel())
    expect(peek.peekNow().ids).toEqual(['b'])
    keyDown(els, 'v')
    els = render(panel())
    expect(peek.peekNow().review).toBe(false)
    expect(peek.peekNow().ids).toBeNull()
    // Review closing stops Peek and Listen.
    keyDown(els, 'v')
    expect(peek.peekNow().review).toBe(true)
    unmountAll()
    expect(peek.peekNow().review).toBe(false)
  })

  it('246. A keyboard pass: 200 private rows are reviewed with N, V, K and Delete only; no mouse event and no second press of Peek are needed, and every row ends kept or uncovered', () => {
    const covers: Cover[] = []
    for (let i = 0; i < 200; i++) covers.push(found(`c${i}`, 1 + i, 1.5 + i, i % 2 ? 'email' : 'phone', `g${i}`))
    let els = open({ ...base('rv', 300), covers })
    keyDown(els, 'v')
    els = render(panel())
    let peeked = 0
    for (let i = 0; i < 200; i++) {
      // Peek follows the row reviewed, with no second press of Peek.
      const ids = peek.peekNow().ids
      if (Array.isArray(ids) && ids.length === 1) peeked++
      keyDown(els, i % 3 === 0 ? 'Delete' : 'k')
      els = render(panel())
    }
    expect(peeked).toBe(200)
    const statuses = allByTestId(els, 'review-row').map((r) => r.props['data-status'])
    expect(statuses).toHaveLength(200)
    expect(statuses.every((s) => s === 'kept' || s === 'removed')).toBe(true)
    expect(statuses.filter((s) => s === 'removed')).toHaveLength(67)
    expect(store.state.covers!.every((c) => !c.found)).toBe(true)
    // N moves without reviewing.
    keyDown(els, 'n')
    expect(store.state.covers).toHaveLength(133)
  })

  it('258. Review’s unfinished line: after a stopped Find, Review’s header shows privacy.review.unfinished with Find again…', () => {
    const p: Project = {
      ...base('rv', 300),
      covers: [found('a', 10, 12, 'email', 'ga')],
      privacy: { find: { at: '2026-11-23T10:00:00.000Z', kinds: ['email'], listened: false, reader: 'pp-ocrv6-tiny+small-careful-long', stopped: true, readTo: 95 } }
    }
    const els = open(p)
    const line = byTestId(els, 'review-unfinished')!
    expect(textOf(line)).toContain('Find private info did not finish: it read this video up to 1:35.0.')
    const again = inside(line).find((e) => e.props['data-testid'] === 'review-find-again')!
    expect(textOf(again)).toBe('Find again…')
    press(again)
    expect(group.commands).toEqual(['findPrivate'])
    // A finished Find: no such line.
    const done = open({ ...p, privacy: { find: { at: '2026-11-23T10:00:00.000Z', kinds: ['email'], listened: false, reader: 'pp-ocrv6-tiny+small-careful-long' } } })
    expect(byTestId(done, 'review-unfinished')).toBeUndefined()
  })
})

const { insetCover } = await load<{ insetCover(p: Pick<Project, 'covers'>, peek: { ids: readonly string[] | 'all' | null }, selected: string | null, t: number): Cover | null }>('privacy/PeekInset')
const { displayTime } = await import('../src/shared/editor/clips')
const { peekStill } = await import('../src/shared/review/privacyReview')

describe('auto-blur: the magnified view while reviewing (§2.8)', () => {

  /** The panel with a player that keeps its time and says what was asked of it. */
  function openWith(p: Project): { els: El[]; player: { time: number; moving: boolean; seeks: number[] } } {
    unmountAll()
    store = new EditStore(p)
    const player = {
      time: 0,
      moving: false,
      seeks: [] as number[],
      subscribe: () => () => undefined,
      play(): void {
        player.moving = true
      },
      pause(): void {
        player.moving = false
      },
      seek(t: number): void {
        player.seeks.push(t)
        player.time = t
      }
    }
    contexts.editor = { store, player }
    request.requestPrivateReview()
    return { els: render(panel()), player }
  }
  /** The cover the magnified view shows now: one of the peeked covers active at the playhead, while it stands still. */
  const shown = (player: { time: number; moving: boolean }): string | null => (player.moving ? null : (insetCover(store.state, peek.peekNow(), null, displayTime(store.state.clips, player.time))?.id ?? null))

  it('K, Delete, N and V move on with the playhead held inside the selected row, so its magnified view shows; Space plays the row', () => {
    const covers = [found('a', 10, 10.4, 'email', 'ga'), found('b', 20, 20.4, 'email', 'gb'), found('c', 30, 30.4, 'email', 'gc'), found('d', 40, 40.4, 'email', 'gd')]
    const { player } = openWith({ ...base('rv', 300), covers })
    let els = render(panel())
    // V: the first row is peeked and held at its cover.
    keyDown(els, 'v')
    els = render(panel())
    expect(peek.peekNow().ids).toEqual(['a'])
    expect(shown(player)).toBe('a')
    // K keeps it and moves on without playing: the next row is shown.
    keyDown(els, 'k')
    els = render(panel())
    expect(peek.peekNow().ids).toEqual(['b'])
    expect(shown(player)).toBe('b')
    // Delete uncovers it and moves on.
    keyDown(els, 'Delete')
    els = render(panel())
    expect(shown(player)).toBe('c')
    // N moves on: held still too, no stretch played over the cover.
    keyDown(els, 'n')
    els = render(panel())
    expect(shown(player)).toBe('d')
    expect(stretches).toEqual([])
    // Space on the row plays its stretch.
    const e = Object.assign(key(' '), { target: Object.assign(new (globalThis as unknown as { HTMLElement: new () => object }).HTMLElement(), { classList: { contains: (c: string) => c === 'review-item' } }) })
    ;(els.find((x) => x.type === 'aside')!.props.onKeyDown as (e: unknown) => void)(e)
    expect(stretches).toHaveLength(1)
    // Without Peek while reviewing, N plays the stretch as Review does.
    keyDown(els, 'v')
    els = render(panel())
    keyDown(els, 'p')
    expect(stretches).toHaveLength(2)
  })

  it('a row Peek pressed holds the playhead inside that row', () => {
    const { els, player } = openWith({ ...base('rv', 300), covers: [found('a', 10, 10.4, 'email', 'ga'), found('b', 60, 60.4, 'key', 'gb')] })
    press(inRow(els, 'private:key:gb', 'review-peek'))
    expect(peek.peekNow().ids).toEqual(['b'])
    expect(shown(player)).toBe('b')
  })

  it('peekStill: inside the earliest cover of the row the edit shows, half a frame in; null when every cover is cut away', () => {
    const p: Project = { ...base('rv', 300, { fps: 60 }), clips: [{ id: 'k1', start: 0, end: 50, speed: 1 }, { id: 'k2', start: 100, end: 300, speed: 1 }], covers: [found('a', 60, 70, 'email', 'ga'), found('b', 45, 120, 'email', 'ga'), found('c', 20, 21, 'email', 'gc')] }
    // 'a' is cut away; 'b' starts at 45, inside the first clip.
    expect(peekStill(p, ['a', 'b'])).toBeCloseTo(45 + 0.5 / 60, 6)
    expect(peekStill(p, ['a'])).toBeNull()
    expect(peekStill(p, ['c', 'b'])).toBeCloseTo(20 + 0.5 / 60, 6)
    expect(peekStill({ ...p, capture: { ...p.capture, fps: 30 } }, ['c'])).toBeCloseTo(20 + 0.5 / 30, 6)
    expect(peekStill(p, [])).toBeNull()
  })
})
