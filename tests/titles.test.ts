import { describe, expect, it } from 'vitest'
import { setLayoutAt } from '../src/shared/editor/layoutCommands'
import { createLayoutSegment } from '../src/shared/editor/layouts'
import {
  chapterNear,
  cleanChapterName,
  createChapter,
  createTitleCard,
  DEFAULT_TITLE_LENGTH,
  dragTitleTimes,
  MIN_TITLE_LENGTH,
  nextChapter,
  nextChapterName,
  previousChapter,
  readChapter,
  readTitleCard,
  sortedChapters,
  TITLE_MAX_CHARS,
  titleColorOf,
  titleTextColorOf,
  titleTimesAt
} from '../src/shared/editor/titles'
import { createProject, migrateProject } from '../src/shared/engine/project'
import type { Chapter, Clip, LayoutSegment } from '../src/shared/types'

const clip = (start: number, end: number, speed = 1): Clip => ({ id: `${start}`, start, end, speed })
const chapter = (id: string, t: number, title = id): Chapter => ({ id, t, title })

describe('title cards: creating and timing', () => {
  it('starts a new card at t, DEFAULT_TITLE_LENGTH long, and keeps the factory signature', () => {
    const c = createTitleCard(2, 10)
    expect(c).toMatchObject({ start: 2, end: 2 + DEFAULT_TITLE_LENGTH, title: 'Title', style: 'centered', background: 'blur' })
    expect(c.id).toMatch(/^c/)
    expect(createTitleCard(2, 10).id).not.toBe(c.id)
    expect(createTitleCard(1, 10, { style: 'lower-third', title: 'Hi' })).toMatchObject({ style: 'lower-third', title: 'Hi', start: 1 })
  })

  it('ends at the recording end instead of getting cut short near it', () => {
    expect(createTitleCard(9.5, 10)).toMatchObject({ start: 7, end: 10 })
    // A recording shorter than a card: the card is the whole recording.
    expect(createTitleCard(1, 2)).toMatchObject({ start: 0, end: 2 })
    expect(createTitleCard(-3, 10).start).toBe(0)
  })

  it('places a card for the playhead inside the kept part of the recording', () => {
    const project = { duration: 12, clips: [clip(1, 8)] }
    expect(titleTimesAt(3, project)).toEqual({ start: 3, end: 6 })
    // At the end of the trimmed video, it starts earlier so all of it is kept.
    expect(titleTimesAt(8, project)).toEqual({ start: 5, end: 8 })
    expect(titleTimesAt(0, project)).toEqual({ start: 1, end: 4 })
    // A kept part shorter than a card: the card is that part.
    expect(titleTimesAt(5, { duration: 12, clips: [clip(4, 6)] })).toEqual({ start: 4, end: 6 })
    expect(titleTimesAt(5, { duration: 12 })).toEqual({ start: 5, end: 8 })
  })

  it('moves and trims on the timeline within the recording, never shorter than the minimum', () => {
    const c = { start: 2, end: 5 }
    expect(dragTitleTimes(c, 'move', 1, 10)).toEqual({ start: 3, end: 6 })
    expect(dragTitleTimes(c, 'move', 9, 10)).toEqual({ start: 7, end: 10 })
    expect(dragTitleTimes(c, 'move', -9, 10)).toEqual({ start: 0, end: 3 })
    expect(dragTitleTimes(c, 'start', 5, 10)).toEqual({ start: 5 - MIN_TITLE_LENGTH, end: 5 })
    expect(dragTitleTimes(c, 'end', -5, 10)).toEqual({ start: 2, end: 2 + MIN_TITLE_LENGTH })
    expect(dragTitleTimes(c, 'end', 9, 10)).toEqual({ start: 2, end: 10 })
    expect(dragTitleTimes(c, 'start', -9, 10)).toEqual({ start: 0, end: 5 })
  })

  it('picks a readable text colour for the background', () => {
    expect(titleColorOf({})).toBe('#14141c')
    expect(titleColorOf({ color: 'red' })).toBe('#14141c')
    expect(titleTextColorOf({ background: 'blur' })).toBe('#ffffff')
    expect(titleTextColorOf({ background: 'solid', color: '#ffffff' })).toBe('#14141c')
    expect(titleTextColorOf({ background: 'solid', color: '#2563eb' })).toBe('#ffffff')
    expect(titleTextColorOf({ background: 'solid', color: '#ffffff', textColor: '#ff0000' })).toBe('#ff0000')
  })
})

describe('chapters', () => {
  const list = [chapter('b', 20, 'Setup'), chapter('a', 0, 'Intro'), chapter('c', 45, 'Demo')]

  it('creates, sorts, names and finds them', () => {
    expect(createChapter(-1).t).toBe(0)
    expect(createChapter(3, 'Intro')).toMatchObject({ t: 3, title: 'Intro' })
    expect(sortedChapters(list).map((c) => c.id)).toEqual(['a', 'b', 'c'])
    expect(nextChapterName([])).toBe('Chapter 1')
    expect(nextChapterName([chapter('x', 0, 'Chapter 2')])).toBe('Chapter 3')
    expect(chapterNear(list, 20.05)?.id).toBe('b')
    expect(chapterNear(list, 20.2)).toBeNull()
  })

  it('finds the next and previous chapter from the playhead', () => {
    expect(nextChapter(list, 0)?.id).toBe('b')
    expect(nextChapter(list, 19.9)?.id).toBe('b')
    // Standing on a chapter, "next" moves on and "previous" goes back.
    expect(nextChapter(list, 20)?.id).toBe('c')
    expect(previousChapter(list, 20)?.id).toBe('a')
    expect(previousChapter(list, 21)?.id).toBe('b')
    expect(nextChapter(list, 45)).toBeNull()
    expect(previousChapter(list, 0)).toBeNull()
    expect(nextChapter([], 0)).toBeNull()
  })

  it('keeps names on one line and short', () => {
    expect(cleanChapterName('Intro\nand\tsetup')).toBe('Intro and setup')
    expect(cleanChapterName('x'.repeat(300))).toHaveLength(100)
  })
})

describe('reading stored title cards and chapters', () => {
  it('keeps good ones exactly', () => {
    const card = { ...createTitleCard(1, 10, { subtitle: 'Sub', color: '#112233', textColor: '#ffffff', background: 'solid' as const }) }
    expect(readTitleCard(card, 10)).toEqual(card)
    const ch = createChapter(4, 'Intro')
    expect(readChapter(ch, 10)).toEqual(ch)
  })

  it('repairs or rejects damaged ones', () => {
    expect(readTitleCard(null)).toBeNull()
    expect(readTitleCard({ id: 'x', start: 2, end: 1 } as never)).toBeNull()
    expect(readTitleCard({ id: 'x', start: 'a', end: 1 } as never)).toBeNull()
    expect(readTitleCard({ id: 'x', start: 11, end: 12 } as never, 10)).toBeNull()
    const fixed = readTitleCard({ id: 'x', start: -1, end: 20, title: 'T'.repeat(500), style: 'huge', background: 'video', color: 'red', textColor: 7 } as never, 10)
    expect(fixed).toEqual({ id: 'x', start: 0, end: 10, title: 'T'.repeat(TITLE_MAX_CHARS), style: 'centered', background: 'blur' })
    expect(readTitleCard({ id: 'x', start: 1, end: 2 } as never)?.title).toBe('')
    expect(readChapter({ id: 'h', t: Number.NaN } as never)).toBeNull()
    expect(readChapter({ id: 'h', t: 50, title: 'A\nB' } as never, 10)).toEqual({ id: 'h', t: 10, title: 'A B' })
    expect(readChapter({ id: 'h', t: -2 } as never)).toEqual({ id: 'h', t: 0, title: 'Chapter' })
  })

  it('migrateProject drops malformed entries, duplicates and ids, and old projects get empty lists', () => {
    const base = createProject({
      id: 'p',
      name: 'P',
      duration: 10,
      width: 1280,
      height: 720,
      hasWebcam: false,
      hasAudio: false,
      webcamOffset: 0,
      zooms: [],
      cursorValid: false,
      capture: { method: 'chromium', cursorInVideo: true, region: null }
    })
    const stored = JSON.parse(JSON.stringify(base)) as Record<string, unknown>
    delete stored.titles
    delete stored.chapters
    const old = migrateProject(stored)
    expect(old.titles).toEqual([])
    expect(old.chapters).toEqual([])
    const good = createTitleCard(1, 10)
    const p = migrateProject({
      ...stored,
      titles: [good, { ...good }, null, 3, { id: '', start: 1, end: 2 }, { start: 1, end: 2 }, { id: 'bad', start: 3, end: 2 }],
      chapters: [{ id: 'h1', t: 1, title: 'One' }, { id: 'h1', t: 2 }, { id: 'h2', t: 'x' }, 'h3', { id: 'h4', t: 99, title: 'Late' }]
    })
    expect(p.titles).toEqual([good])
    expect(p.chapters).toEqual([
      { id: 'h1', t: 1, title: 'One' },
      { id: 'h4', t: 10, title: 'Late' }
    ])
  })
})

describe('camera layout at the playhead', () => {
  const seg = (id: string, start: number, end: number, layout: LayoutSegment['layout'] = 'camera-only'): LayoutSegment => ({ id, start, end, layout })

  it('adds a segment at the playhead', () => {
    const r = setLayoutAt({ layouts: [], duration: 20 }, 'side-by-side', 3)
    expect(r.ok).toBe(true)
    if (!r.ok) return
    expect(r.added).toBe(true)
    expect(r.layouts).toHaveLength(1)
    expect(r.layouts[0]).toMatchObject({ id: r.id, start: 3, end: 3 + (createLayoutSegment('default', 0, 100).end - 0), layout: 'side-by-side' })
  })

  it('changes the segment under the playhead instead of stacking another', () => {
    const r = setLayoutAt({ layouts: [seg('a', 2, 6)], duration: 20 }, 'screen-only', 4)
    expect(r).toMatchObject({ ok: true, id: 'a', added: false })
    if (r.ok) expect(r.layouts).toEqual([seg('a', 2, 6, 'screen-only')])
    expect(setLayoutAt({ layouts: [seg('a', 2, 6)], duration: 20 }, 'camera-only', 4)).toEqual({ ok: false, reason: 'same', id: 'a' })
    // Outside every segment the layout already is the default one.
    expect(setLayoutAt({ layouts: [seg('a', 2, 6)], duration: 20 }, 'default', 10)).toEqual({ ok: false, reason: 'same', id: null })
  })

  it('never overlaps the next segment, and says when there is no room', () => {
    const r = setLayoutAt({ layouts: [seg('a', 5, 9)], duration: 20 }, 'camera-large', 3)
    expect(r.ok && r.layouts.find((s) => s.id === r.id)).toMatchObject({ start: 3, end: 5 })
    expect(setLayoutAt({ layouts: [seg('a', 5, 9)], duration: 20 }, 'camera-large', 4.9)).toEqual({ ok: false, reason: 'no-room', id: null })
    // Near the end of the recording: still inside it.
    const end = setLayoutAt({ layouts: [], duration: 20 }, 'camera-only', 19)
    expect(end.ok && end.layouts[0].end).toBe(20)
  })
})
