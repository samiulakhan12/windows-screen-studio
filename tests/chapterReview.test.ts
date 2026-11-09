/**
 * Found chapters in Review mode, the link check and the export note (docs/design/smart-tools.md
 * §7.7, §13.1; §22.1 tests 43, 44 and 46).
 */
import { describe, expect, it } from 'vitest'
import { chapterDetail, chapterReviewItems } from '../src/shared/review/chapterReview'
import { keepItems, pendingCount, removeItems, reviewItems, reviewStatus } from '../src/shared/review/review'
import { EditStore } from '../src/shared/editor/editStore'
import { notedPieces } from '../src/shared/publish/check'
import type { Annotation, Chapter, ChapterOrigin, Project, TitleCard } from '../src/shared/types'
import { chapterProject } from './chapterFixtures'
import { render, textOf, unmountAll } from './studioHarness'

const origin = (extra: Partial<ChapterOrigin> = {}): ChapterOrigin => ({ by: 'find', from: ['screen', 'pause'], name: 'sentence', ...extra })
const found = (id: string, t: number, title: string, o: ChapterOrigin = origin()): Chapter => ({ id, t, title, auto: o })
const chapterCard = (id: string, chapter: string, t: number): TitleCard => ({ id, start: t, end: t + 3, title: 'Card', style: 'lower-third', background: 'blur', auto: { by: 'chapter', via: 'rules', chapter } })
const badge = (i: number) => ({ id: `b${i}`, start: 5 + i * 10, end: 8 + i * 10, text: '', x: 0.5, y: 0.5, size: 0.045, style: 'badge' as const, number: 'auto' as const }) as unknown as Annotation

/** 3 minutes with 10 s cut from 20 s: a chapter at 75 s is at 1:05 in the video. */
function project(): Project {
  const p = chapterProject({ duration: 180 })
  return {
    ...p,
    clips: [
      { id: 'a', start: 0, end: 20, speed: 1 },
      { id: 'b', start: 30, end: 180, speed: 1 }
    ],
    chapters: [found('f0', 0, 'Intro', origin({ from: ['start'], name: 'number' })), found('f1', 75, 'Set up billing'), { id: 'u', t: 150, title: 'Mine' }],
    titles: [chapterCard('k1', 'f1', 75)]
  }
}

describe('Review rows of found chapters (test 43)', () => {
  it('"Chapter “Set up billing” at 1:05" in video time, with what found it', () => {
    const rows = chapterReviewItems(project())
    expect(rows.map((r) => [r.key, r.kind, r.title, r.detail, r.start])).toEqual([
      ['chapter:f0', 'chapter', 'Chapter “Intro” at 0:00', 'Find chapters · start of the video', 0],
      ['chapter:f1', 'chapter', 'Chapter “Set up billing” at 1:05', 'Find chapters · screen change and pause', 75]
    ])
    // Listed by Review with the others.
    expect(reviewItems(project()).filter((i) => i.kind === 'chapter')).toHaveLength(2)
    // Two found chapters, and the chapter-title card Captions Studio made from one.
    expect(pendingCount(project())).toBe(3)
  })

  it('the detail words: Polish, Suggest chapters with a provider or a service, AI names, and step numbers', () => {
    expect(chapterDetail(origin({ by: 'polish', from: ['page', 'section', 'pause'] }), false)).toBe('Polish · page change, new section and pause')
    expect(chapterDetail(origin({ from: ['ai', 'page'], name: 'ai', via: 'openai' }), false)).toBe('Suggest chapters with OpenAI · page change · named by OpenAI')
    expect(chapterDetail(origin({ from: ['ai'], name: 'ai', via: 'openai', host: '127.0.0.1' }), false)).toBe('Suggest chapters with 127.0.0.1 · named by 127.0.0.1')
    expect(chapterDetail(origin({ from: ['topic', 'card'], name: 'ai', via: 'local' }), false)).toBe('Find chapters · new topic and title card · named on this PC')
    expect(chapterDetail(origin({ from: ['idle', 'cue'] }), true)).toBe('Find chapters · no input and cue word · keeping it restarts step numbers here')
    // With automatically numbered badges (by chapter, as is the default), the rows say so; turned off, not.
    const badges = { ...project(), annotations: [badge(0), badge(1)] }
    expect(chapterReviewItems(badges)[1].detail).toBe('Find chapters · screen change and pause · keeping it restarts step numbers here')
    expect(chapterReviewItems({ ...badges, effects: { ...badges.effects, badgesByChapter: false } })[1].detail).toBe('Find chapters · screen change and pause')
  })

  it('Keep drops auto; Remove deletes the chapter and its pending card; each one undo step, the status following undo and redo', () => {
    const store = new EditStore<Project>(project())
    const row = (key: string) => reviewItems(store.state).find((i) => i.key === key)!
    const billing = row('chapter:f1')
    const intro = row('chapter:f0')
    store.update((p) => keepItems(p, [intro]))
    expect(store.state.chapters!.find((c) => c.id === 'f0')).toEqual({ id: 'f0', t: 0, title: 'Intro' })
    expect(reviewStatus(store.state, intro)).toBe('kept')
    store.update((p) => removeItems(p, [billing]))
    expect(store.state.chapters!.map((c) => c.id)).toEqual(['f0', 'u'])
    expect(store.state.titles).toEqual([])
    expect(reviewStatus(store.state, billing)).toBe('removed')
    store.undo()
    expect(reviewStatus(store.state, billing)).toBe('pending')
    expect(store.state.titles!.map((c) => c.id)).toEqual(['k1'])
    store.undo()
    expect(reviewStatus(store.state, intro)).toBe('pending')
    store.redo()
    expect(reviewStatus(store.state, intro)).toBe('kept')
    store.redo()
    expect(reviewStatus(store.state, billing)).toBe('removed')
  })

  it('Remove all found chapters removes every pending one and leaves the user\'s', () => {
    const p = project()
    const rows = reviewItems(p).filter((i) => i.kind === 'chapter')
    const next = removeItems(p, rows)
    expect(next.chapters).toEqual([{ id: 'u', t: 150, title: 'Mine' }])
    expect(next.titles).toEqual([])
    expect(pendingCount(next)).toBe(0)
    // Keep all: every one becomes the user's.
    expect(keepItems(p, rows).chapters!.every((c) => !c.auto)).toBe(true)
    // A row for a chapter that is no longer pending changes nothing.
    const kept = keepItems(p, rows)
    expect(removeItems(kept, rows)).toBe(kept)
  })
})

describe('the link check (test 44)', () => {
  it('a pending chapter named "see example.com" is not said; after Keep it is', async () => {
    const CHECK_NOTE = '../src/renderer/src/publish/checkNote'
    const { projectSaid } = (await import(/* @vite-ignore */ CHECK_NOTE)) as { projectSaid(p: Project): import('../src/shared/publish/check').Said }
    const p = { ...project(), chapters: [found('f0', 0, 'Intro'), found('f1', 75, 'see example.com'), { id: 'u', t: 150, title: 'Mine' }] }
    expect(notedPieces('Read example.com first', projectSaid(p))).toHaveLength(1)
    const rows = reviewItems(p).filter((i) => i.key === 'chapter:f1')
    const kept = keepItems(p, rows)
    expect(notedPieces('Read example.com first', projectSaid(kept))).toHaveLength(0)
  })
})

describe('the export note (test 46)', () => {
  it('counts the pending chapters; with none, no note', async () => {
    const MOD = '../src/renderer/src/editor/ExportBundleOptions'
    const { ExportBundleOptions } = (await import(/* @vite-ignore */ MOD)) as { ExportBundleOptions: (props: Record<string, unknown>) => unknown }
    const { pendingChapters } = await import('../src/shared/chapters/pending')
    const value = { srt: false, vtt: false, chapters: true, thumbnail: false, description: false, perChapter: false }
    const base = { value, onChange: () => undefined, format: 'mp4', has: { captions: false, chapters: true }, mode: 'single', chapterCount: 3 }
    const note = (count: number): string => render({ type: ExportBundleOptions, props: { ...base, pendingChapters: count } }).map((e) => (e.type === 'p' ? textOf(e) : '')).join(' ')
    expect(pendingChapters(project())).toHaveLength(2)
    expect(note(pendingChapters(project()).length)).toContain('2 of them not reviewed yet: Review lists them.')
    expect(note(0)).not.toContain('not reviewed yet')
    unmountAll()
  })
})
