/**
 * Review mode's panel with Captions Studio's group rows (docs/design/captions-studio.md §11.8,
 * test 44's panel part) without a DOM: a group row lists its items under a disclosure
 * (aria-expanded, aria-controls), each with its own Keep and Remove; a press on one item changes
 * only that item, in one undo step, and the group's Keep does the rest in one more; the row's
 * status and "n of N reviewed" count the group once.
 */
import { beforeEach, describe, expect, it, vi } from 'vitest'
import { settleCaptionAuto } from '../src/shared/captions/captionAutoSettle'
import { DEFAULT_CLEANUP } from '../src/shared/captions/cleanup'
import { DEFAULT_GREAT_OPTIONS, planCaptionsGreat } from '../src/shared/captions/great'
import { EditStore } from '../src/shared/editor/editStore'
import { DEFAULT_KEYMAP } from '../src/shared/editor/shortcuts'
import { EMPHASIS_GROUP } from '../src/shared/review/captionReview'
import type { Project } from '../src/shared/types'
import { allByTestId, byTestId, contexts, mockReact, render, textOf, unmountAll, useEditorContexts, type El } from './studioHarness'
import { captions, studioProject, TALL } from './p4Fixtures'

vi.stubGlobal('document', { activeElement: null, body: {}, querySelector: () => null })
vi.stubGlobal('window', { setTimeout: (fn: () => void) => setTimeout(fn, 0), requestAnimationFrame: () => 0, cancelAnimationFrame: () => undefined })
vi.stubGlobal('CSS', { escape: (s: string) => s })
vi.stubGlobal('HTMLElement', class {})
vi.stubGlobal('HTMLButtonElement', class {})

mockReact()
// Renderer code: imported at run time so the Node typecheck of tests/ does not follow it.
const PANEL = '../src/renderer/src/review/ReviewPanel'
const { ReviewPanel } = (await import(/* @vite-ignore */ PANEL)) as { ReviewPanel: (p: unknown) => unknown }
await useEditorContexts()

const TEXTS = ['today i will show you three ways to make reports faster', 'First, open the Settings page and click Export.', 'Second, turn on Auto Save so you never lose work.', 'Last quarter our sign-ups grew 300% and revenue hit $1.2M.']
const before = studioProject({ segments: captions(TEXTS) })
const great = planCaptionsGreat({ project: before, frame: TALL, cleanup: DEFAULT_CLEANUP, words: [], by: 'great' }, DEFAULT_GREAT_OPTIONS).project

let store: EditStore<Project>
const panel = (): unknown => ({ type: ReviewPanel, props: { onClose: () => undefined } })
const rowOf = (els: El[], key: string): El => els.find((e) => e.type === 'li' && e.props['data-key'] === key)!
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
const press = (el: El | undefined): void => (el!.props.onClick as () => void)()
const undoSteps = (s: EditStore<Project>): number => {
  let n = 0
  while (s.undo()) n++
  return n
}

beforeEach(() => {
  unmountAll()
  store = new EditStore(great, undefined, undefined, undefined, (next, prev) => settleCaptionAuto(next, prev))
  contexts.editor = { store, player: { time: 0, moving: false, subscribe: () => () => undefined, pause: () => undefined, seek: () => undefined } }
  contexts.keymap = DEFAULT_KEYMAP
})

describe('a group row in the Review panel', () => {
  it('shows its items under a disclosure; Remove on one item changes only it, Keep on the row the rest', () => {
    let els = render(panel())
    const group = rowOf(els, EMPHASIS_GROUP)
    const marks = great.captionMarks!.filter((m) => m.auto)
    const toggle = inside(group).find((e) => e.props['data-testid'] === 'review-toggle')!
    expect(toggle.props['aria-expanded']).toBe(false)
    expect(toggle.props['aria-label']).toBe(`Show the ${marks.length} ${marks.length === 1 ? 'item' : 'items'}: ${textOf(inside(group).find((e) => e.props.className === 'review-title'))}`)
    expect(allByTestId(els, 'review-part')).toHaveLength(0)
    press(toggle)
    els = render(panel())
    const opened = rowOf(els, EMPHASIS_GROUP)
    const shownToggle = inside(opened).find((e) => e.props['data-testid'] === 'review-toggle')!
    expect(shownToggle.props['aria-expanded']).toBe(true)
    const list = inside(opened).find((e) => e.type === 'ul')!
    expect(list.props.id).toBe(shownToggle.props['aria-controls'])
    const parts = allByTestId(els, 'review-part')
    expect(parts.map((p) => p.props['data-member-key'])).toEqual(expect.arrayContaining(marks.map((m) => `emphasis:${m.id}`)))
    expect(parts.every((p) => p.props['data-status'] === 'pending')).toBe(true)
    const progress = (): string => textOf(byTestId(render(panel()), 'review-progress'))
    const total = progress().match(/of (\d+)/)![1]

    // Remove on the first item: that mark only, one undo step; the group is still to review.
    const first = parts[0]
    press(inside(first).find((e) => e.props['data-testid'] === 'review-part-remove'))
    expect(store.state.captionMarks!.map((m) => `emphasis:${m.id}`)).not.toContain(first.props['data-member-key'])
    expect(store.state.captionMarks!.filter((m) => m.auto)).toHaveLength(marks.length - 1)
    els = render(panel())
    expect(allByTestId(els, 'review-part')[0].props['data-status']).toBe('removed')
    expect(rowOf(els, EMPHASIS_GROUP).props['data-status']).toBe('pending')
    expect(progress()).toBe(`0 of ${total} reviewed`)
    expect(textOf(byTestId(els, 'review-said'))).toBe(`Removed. 0 of ${total} reviewed.`)

    // Keep on the row keeps the rest; the group counts once.
    press(inside(rowOf(els, EMPHASIS_GROUP)).find((e) => e.props['data-testid'] === 'review-keep'))
    expect(store.state.captionMarks!.some((m) => m.auto)).toBe(false)
    els = render(panel())
    expect(rowOf(els, EMPHASIS_GROUP).props['data-status']).toBe('kept')
    expect(allByTestId(els, 'review-part').slice(1).every((p) => p.props['data-status'] === 'kept')).toBe(true)
    expect(progress()).toBe(`1 of ${total} reviewed`)
    expect(undoSteps(store)).toBe(2)
  })
})
