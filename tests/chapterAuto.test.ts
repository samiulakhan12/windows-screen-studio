/**
 * Applying and settling found chapters (docs/design/smart-tools.md §7.7; §22.1 tests 41 and 42).
 */
import { describe, expect, it } from 'vitest'
import { settleChapters, withFoundChapters, withoutPendingChapters } from '../src/shared/chapters/chapterAuto'
import { EditStore } from '../src/shared/editor/editStore'
import type { Chapter, ChapterOrigin, Project, TitleCard } from '../src/shared/types'
import { chapterProject } from './chapterFixtures'

const origin = (extra: Partial<ChapterOrigin> = {}): ChapterOrigin => ({ by: 'find', from: ['page'], name: 'sentence', ...extra })
const found = (id: string, t: number, title: string, o: ChapterOrigin = origin()): Chapter => ({ id, t, title, auto: o })
const chapterCard = (id: string, chapter: string, t: number): TitleCard => ({ id, start: t, end: t + 3, title: 'x', style: 'lower-third', background: 'blur', auto: { by: 'chapter', via: 'rules', chapter } })

describe('withFoundChapters (test 41)', () => {
  const user: Chapter = { id: 'u1', t: 90, title: 'Mine' }
  const base = (): Project => ({
    ...chapterProject({ duration: 180 }),
    chapters: [found('f1', 0, 'Intro', origin({ from: ['start'], name: 'number' })), user, found('f2', 40, 'Set up billing')],
    titles: [chapterCard('k2', 'f2', 40), chapterCard('ku', 'u1', 90), { id: 'mine', start: 10, end: 13, title: 'Hello', style: 'centered', background: 'blur' }]
  })

  it('removes the pending found chapters and their pending chapter-title cards, keeps the user chapters, adds the new ones', () => {
    const p = base()
    const next = withFoundChapters(p, [
      { t: 0, title: 'Intro', origin: origin({ from: ['start'], name: 'number' }) },
      { t: 120, title: 'Export', origin: origin({ from: ['page', 'pause'] }) }
    ])
    // Intro found again: the same chapter object.
    expect(next.chapters![0]).toBe(p.chapters![0])
    expect(next.chapters!.map((c) => c.id).slice(0, 2)).toEqual(['f1', 'u1'])
    expect(next.chapters).toHaveLength(3)
    const added = next.chapters![2]
    expect(added).toMatchObject({ t: 120, title: 'Export', auto: { by: 'find', from: ['page', 'pause'], name: 'sentence' } })
    expect(added.id).not.toMatch(/^f/)
    // Set up billing went, with its pending card; the user's chapter card and the user's own card stay.
    expect(next.titles!.map((c) => c.id)).toEqual(['ku', 'mine'])
  })

  it('in one update: one undo step brings everything back', () => {
    const store = new EditStore<Project>(base())
    const before = store.state
    store.update((p) => withFoundChapters(p, [{ t: 70, title: 'New', origin: origin() }]))
    expect(store.state.chapters!.some((c) => c.title === 'New')).toBe(true)
    store.undo()
    expect(store.state).toBe(before)
  })

  it('a second identical run returns the input project itself, ids and auto objects unchanged', () => {
    const run = [
      { t: 0, title: 'Intro', origin: origin({ from: ['start'], name: 'number' }) },
      { t: 120, title: 'Export', origin: origin({ from: ['page', 'pause'] }) }
    ]
    const once = withFoundChapters(base(), run)
    const twice = withFoundChapters(
      once,
      run.map((r) => ({ ...r, t: r.t + 0.04, origin: { ...r.origin, from: [...r.origin.from] } }))
    )
    expect(twice).toBe(once)
    // A changed title or origin, or 0.06 s away, is a new chapter.
    expect(withFoundChapters(once, [run[0], { ...run[1], title: 'Export it' }])).not.toBe(once)
    expect(withFoundChapters(once, [run[0], { ...run[1], origin: origin({ by: 'polish', from: ['page', 'pause'] }) }])).not.toBe(once)
    expect(withFoundChapters(once, [run[0], { ...run[1], t: 120.06 }])).not.toBe(once)
  })

  it('a new found chapter gets its own origin object; nothing found removes the pending ones', () => {
    const o = origin()
    const next = withFoundChapters(chapterProject({ duration: 60 }), [{ t: 5, title: 'A', origin: o }])
    expect(next.chapters![0].auto).toEqual(o)
    expect(next.chapters![0].auto).not.toBe(o)
    expect(withFoundChapters(base(), []).chapters).toEqual([{ id: 'u1', t: 90, title: 'Mine' }])
    expect(withoutPendingChapters(base()).chapters).toEqual([{ id: 'u1', t: 90, title: 'Mine' }])
    const none = chapterProject({ duration: 60 })
    expect(withoutPendingChapters(none)).toBe(none)
  })
})

describe('settleChapters (test 42)', () => {
  const p: Project = { ...chapterProject({ duration: 180 }), chapters: [found('f1', 0, 'Intro'), found('f2', 40, 'Billing'), { id: 'u', t: 90, title: 'Mine' }] }

  it('renaming or moving a found chapter by hand drops auto in the same update', () => {
    const renamed = { ...p, chapters: p.chapters!.map((c) => (c.id === 'f2' ? { ...c, title: 'Set up billing' } : c)) }
    const settled = settleChapters(renamed, p)
    expect(settled.chapters!.find((c) => c.id === 'f2')).toEqual({ id: 'f2', t: 40, title: 'Set up billing' })
    expect(settled.chapters!.find((c) => c.id === 'f1')!.auto).toBe(p.chapters![0].auto)
    const moved = { ...p, chapters: p.chapters!.map((c) => (c.id === 'f1' ? { ...c, t: 2 } : c)) }
    expect(settleChapters(moved, p).chapters![0]).toEqual({ id: 'f1', t: 2, title: 'Intro' })
  })

  it("automation's updates (new auto objects) keep it", () => {
    const rerun = { ...p, chapters: p.chapters!.map((c) => (c.id === 'f2' ? { ...c, title: 'Billing again', auto: { ...c.auto! } } : c)) }
    expect(settleChapters(rerun, p)).toBe(rerun)
  })

  it('returns next itself without found chapters, or when the chapters did not change', () => {
    const old = { ...chapterProject({ duration: 60 }), chapters: [{ id: 'u', t: 0, title: 'Mine' }] }
    const edited = { ...old, chapters: [{ id: 'u', t: 1, title: 'Mine' }] }
    expect(settleChapters(edited, old)).toBe(edited)
    const zoomed = { ...p, zooms: [] }
    expect(settleChapters(zoomed, p)).toBe(zoomed)
  })

  it('in the editor: a rename by hand is one undo step and makes the chapter the user\'s', () => {
    const store = new EditStore<Project>(p, 200, 800, Date.now, settleChapters)
    store.update((s) => ({ ...s, chapters: s.chapters!.map((c) => (c.id === 'f2' ? { ...c, title: 'Set up billing' } : c)) }))
    expect(store.state.chapters!.find((c) => c.id === 'f2')!.auto).toBeUndefined()
    store.undo()
    expect(store.state.chapters!.find((c) => c.id === 'f2')!.auto).toBeDefined()
  })
})
