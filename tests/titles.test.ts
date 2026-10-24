import { describe, expect, it } from 'vitest'
import { setLayoutAt } from '../src/shared/editor/layoutCommands'
import { createLayoutSegment } from '../src/shared/editor/layouts'
import {
  backgroundIsLight,
  CHAPTER_BACK_WINDOW,
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

  it("reads the project's background for a card showing it", () => {
    const peach = { type: 'gradient', preset: 'peach' } as const
    expect(backgroundIsLight(peach)).toBe(true)
    expect(backgroundIsLight({ type: 'gradient', preset: 'midnight' })).toBe(false)
    expect(backgroundIsLight({ type: 'color', color: '#ffffff' })).toBe(true)
    expect(backgroundIsLight({ type: 'color', color: '#00a040' })).toBe(false)
    expect(backgroundIsLight({ type: 'color', color: 'white' })).toBeNull()
    expect(backgroundIsLight({ type: 'animated', preset: 'ocean' })).toBe(false)
    expect(backgroundIsLight({ type: 'wallpaper', id: 'peach-mesh' })).toBe(true)
    expect(backgroundIsLight({ type: 'wallpaper', id: 'violet-mesh' })).toBe(false)
    expect(backgroundIsLight({ type: 'wallpaper', id: 'gone' })).toBeNull()
    // A picture's brightness is unknown: white text (the renderer darkens the picture under it).
    expect(backgroundIsLight({ type: 'image', path: 'background.png' })).toBeNull()

    // Dark text on a light project background, white on a dark one; the card's own choice wins.
    expect(titleTextColorOf({ background: 'style' }, peach)).toBe('#14141c')
    expect(titleTextColorOf({ background: 'style' }, { type: 'color', color: '#f8fafc' })).toBe('#14141c')
    expect(titleTextColorOf({ background: 'style' }, { type: 'gradient', preset: 'midnight' })).toBe('#ffffff')
    expect(titleTextColorOf({ background: 'style' }, { type: 'image', path: 'background.png' })).toBe('#ffffff')
    expect(titleTextColorOf({ background: 'style', textColor: '#facc15' }, peach)).toBe('#facc15')
    // Only cards showing the project's background read it.
    expect(titleTextColorOf({ background: 'blur' }, peach)).toBe('#ffffff')
    expect(titleTextColorOf({ background: 'style' })).toBe('#ffffff')
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
    // Well into a chapter, "previous" goes back to its start; just past its start, to the one before.
    expect(previousChapter(list, 20 + CHAPTER_BACK_WINDOW + 0.1)?.id).toBe('b')
    expect(previousChapter(list, 21)?.id).toBe('a')
    expect(nextChapter(list, 45)).toBeNull()
    expect(previousChapter(list, 0)).toBeNull()
    // Just past the first chapter: back to its start.
    expect(previousChapter(list, 0.5)?.id).toBe('a')
    expect(nextChapter([], 0)).toBeNull()
    expect(previousChapter([], 5)).toBeNull()
  })

  it('"previous" keeps going back while the video plays on between presses', () => {
    // Intro 0:00, Setup 0:30, Demo 1:00; playing from 1:05, each press then 16 ms (a frame) of playback.
    const chapters = [chapter('intro', 0), chapter('setup', 30), chapter('demo', 60)]
    const clips = [clip(0, 90)]
    let t = 65
    const visited: string[] = []
    for (let i = 0; i < 3; i++) {
      const c = previousChapter(chapters, t, clips)
      if (!c) break
      visited.push(c.id)
      t = c.t + 0.016
    }
    expect(visited).toEqual(['demo', 'setup', 'intro'])
    // Holding the key at the first chapter stays there.
    expect(previousChapter(chapters, 0.016, clips)?.id).toBe('intro')
  })

  it('goes by the edited video: chapters in a cut are where the video goes on, and count once', () => {
    // Kept: 0-20 and 40-60 (the cut 20-40 holds two chapters, both shown at output 20).
    const clips = [clip(0, 20), clip(40, 60)]
    const chapters = [chapter('a', 5), chapter('cut1', 25), chapter('cut2', 30), chapter('b', 50)]
    // Playing after a jump to a chapter in the cut: the playhead is at the next clip's start (source 40).
    expect(previousChapter(chapters, 40.016, clips)?.id).toBe('a')
    // Paused on it (source 30, in the cut): the same place.
    expect(previousChapter(chapters, 30, clips)?.id).toBe('a')
    expect(previousChapter(chapters, 25, clips)?.id).toBe('a')
    // "Next" from the first of the two in the cut skips the other one (the same frame).
    expect(nextChapter(chapters, 25, clips)?.id).toBe('b')
    expect(nextChapter(chapters, 5, clips)?.id).toBe('cut1')
    // Speed counts in output seconds: 1 source second at 4x is 0.25 s, within the window.
    const fast = [clip(0, 100, 4)]
    expect(previousChapter([chapter('x', 10), chapter('y', 50)], 54, fast)?.id).toBe('x')
    expect(previousChapter([chapter('x', 10), chapter('y', 50)], 50 + 4 * (CHAPTER_BACK_WINDOW + 0.1), fast)?.id).toBe('y')
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

  it('at the very end of the video, the new segment ends with it and starts earlier', () => {
    const len = createLayoutSegment('default', 0, 100).end
    for (const t of [12, 11.95, 11.8]) {
      const r = setLayoutAt({ layouts: [], duration: 12 }, 'side-by-side', t)
      expect(r.ok, `at ${t}`).toBe(true)
      if (r.ok) expect(r.layouts[0]).toMatchObject({ start: 12 - len, end: 12, layout: 'side-by-side' })
    }
    // Pressing again at the end finds that segment: the playhead at the end shows the last frame.
    const r = setLayoutAt({ layouts: [], duration: 12 }, 'side-by-side', 12)
    if (r.ok) expect(setLayoutAt({ layouts: r.layouts, duration: 12 }, 'side-by-side', 12)).toEqual({ ok: false, reason: 'same', id: r.id })
    // Never over the segment before it.
    const after = setLayoutAt({ layouts: [seg('a', 2, 9)], duration: 12 }, 'camera-large', 12)
    expect(after.ok && after.layouts.find((s) => s.id === after.id)).toMatchObject({ start: 9, end: 12 })
    // A trimmed end is the end of the video.
    const trimmed = setLayoutAt({ layouts: [], duration: 20, clips: [clip(0, 12)] }, 'camera-only', 12)
    expect(trimmed.ok && trimmed.layouts[0]).toMatchObject({ start: 12 - len, end: 12 })
    // No room between the one before and the end: says so (not "another starts right after") and points at it.
    expect(setLayoutAt({ layouts: [seg('a', 2, 11.9)], duration: 12 }, 'camera-large', 11.95)).toEqual({ ok: false, reason: 'end', id: 'a' })
  })
})
