/**
 * Captions Studio test 44 (docs/design/captions-studio.md §11.8, §2.8): Review mode lists the
 * automatic caption changes: titles, statuses, Keep and Remove per kind; the emphasis and text
 * group rows (one row each, their items listed, Keep and Remove on the row and on one item, each
 * one undo step); "n of N" counts a group once; statuses follow undo and redo.
 */
import { describe, expect, it } from 'vitest'
import { settleCaptionAuto } from '../src/shared/captions/captionAutoSettle'
import { DEFAULT_CLEANUP } from '../src/shared/captions/cleanup'
import { DEFAULT_GREAT_OPTIONS, planCaptionsGreat } from '../src/shared/captions/great'
import { DEFAULT_CAPTIONS } from '../src/shared/captions/settings'
import { legacyTwin } from '../src/shared/captions/studioEdit'
import { EditStore } from '../src/shared/editor/editStore'
import { settleDeletedWords } from '../src/shared/editor/transcript'
import { settleAutoCuts } from '../src/shared/review/autoCuts'
import { EMPHASIS_GROUP, lookName, STYLE_KEY, TEXT_GROUP, textFixTitle } from '../src/shared/review/captionReview'
import { itemAccessibleName, KIND_WORDS, REVIEW_KINDS } from '../src/shared/review/copy'
import { keepItems, mergeSnapshot, pendingCount, removeItems, reviewItems, reviewProgress, reviewStatus, type ReviewItem } from '../src/shared/review/review'
import type { Graphic, Project, TitleCard } from '../src/shared/types'
import { captions, studioProject, TALL, WIDE } from './p4Fixtures'

const TEXTS = [
  'today i will show you three ways to make reports faster',
  'First, open the Settings page and click Export.',
  'Second, turn on Auto Save so you never lose work.',
  'Finally, use the Search box to find any report.',
  'Last quarter our sign-ups grew 300% and revenue hit $1.2M.',
  'Click Save and you are done.'
]

/** A tall screen recording before Make my captions great, and after it (offline, the defaults). */
const before = studioProject({ segments: captions(TEXTS) })
const great = planCaptionsGreat({ project: before, frame: TALL, cleanup: DEFAULT_CLEANUP, words: [], by: 'great' }, DEFAULT_GREAT_OPTIONS).project

/** The editor's store: its settle chain (Editor.tsx), so every update ends as saving and reopening would give. */
const storeOf = (p: Project): EditStore<Project> => new EditStore(p, undefined, undefined, undefined, (next, prev) => settleAutoCuts(settleCaptionAuto(settleDeletedWords(next, prev), prev), prev))
const row = (items: readonly ReviewItem[], key: string): ReviewItem => {
  const i = items.find((x) => x.key === key)
  if (!i) throw new Error(`no row ${key} in ${items.map((x) => x.key).join(', ')}`)
  return i
}
const undoSteps = (s: EditStore<Project>): number => {
  let n = 0
  while (s.undo()) n++
  return n
}

const counter = (id: string, auto = true): Graphic => ({
  id,
  kind: 'counter',
  start: 10,
  end: 13,
  place: 'auto',
  size: 0.1,
  enter: { kind: 'pop', duration: 0.3, strength: 1 },
  exit: { kind: 'fade', duration: 0.3, strength: 1 },
  from: 0,
  to: 300,
  decimals: 0,
  prefix: '',
  suffix: '%',
  locale: 'en',
  countFor: 1.5,
  ...(auto ? { auto: { by: 'number', via: 'rules', caption: 'c4' } } : {})
})
const emoji = (id: string): Graphic => ({ ...counter(id), kind: 'emoji', emoji: '1f4a1', anchor: { caption: 'c1', from: 2, to: 2, text: 'tip' }, auto: { by: 'emoji', via: 'gemini', caption: 'c1' } }) as Graphic
const keyword = (id: string, text: string): Graphic => ({ ...counter(id), kind: 'keyword', text, look: 'card', auto: { by: 'keyword', via: 'rules', caption: 'c2' } }) as Graphic
const card = (id: string, by: 'speaker' | 'chapter' | 'quote', title: string, start: number): TitleCard => ({ id, start, end: start + 2.5, title, style: 'lower-third', background: 'blur', auto: { by, via: 'rules' } })

describe('the rows (titles and statuses)', () => {
  it('lists the look, one emphasis group, one text group and a row per graphic, in time order after the other kinds', () => {
    const items = reviewItems(great)
    const style = row(items, STYLE_KEY)
    expect(style).toMatchObject({ kind: 'style', title: 'Caption style: Clean Short (was Clean)', detail: 'Make my captions great', start: 0 })
    const emphasis = row(items, EMPHASIS_GROUP)
    const marks = great.captionMarks!.filter((m) => m.auto)
    const words = marks.reduce((n, m) => n + m.to - m.from + 1, 0)
    expect(emphasis.title).toBe(`Emphasis: ${words} ${words === 1 ? 'word' : 'words'}`)
    expect(emphasis.members).toEqual(emphasis.parts!.map((p) => p.key))
    expect(emphasis.members!.sort()).toEqual(marks.map((m) => `emphasis:${m.id}`).sort())
    expect(emphasis.parts!.every((p) => p.kind === 'emphasis' && /^Emphasis on “.+”$/.test(p.title))).toBe(true)
    const text = row(items, TEXT_GROUP)
    expect(text).toMatchObject({ kind: 'text', title: 'Text: 1 caption tidied', members: ['text:c0'] })
    expect(text.parts![0].title).toBe('Fixed “today i” → “Today I”')
    // One row each for the counter and the list; nothing else (screen-led: no emoji or keyword pop-ups).
    const graphics = items.filter((i) => i.kind === 'graphic')
    expect(graphics.map((g) => g.title).sort()).toEqual(['Counter 300%', 'List: Three ways to make reports'])
    expect(items.filter((i) => i.kind === 'emoji')).toEqual([])
    // Each row pending; the Review button counts what is listed.
    expect(items.every((i) => reviewStatus(great, i) === 'pending')).toBe(true)
    expect(pendingCount(great)).toBe(items.length)
    // Time order, Captions Studio's kinds after the others at equal times.
    expect(items.map((i) => i.start)).toEqual([...items.map((i) => i.start)].sort((a, b) => a - b))
    expect(REVIEW_KINDS.slice(-6)).toEqual(['style', 'emphasis', 'text', 'emoji', 'graphic', 'bleep'])
  })

  it('names emoji, pop-ups, lower thirds, chapter titles, quotes and bleeps; a bleeped word is masked in the row and its accessible name', () => {
    const p: Project = {
      ...before,
      graphics: [emoji('e1'), keyword('k1', 'Auto Save'), keyword('k2', 'damn it'), counter('n1', false)],
      titles: [card('t1', 'speaker', 'Priya', 1), card('t2', 'chapter', 'Export settings', 8), card('t3', 'quote', 'Ship it today', 12)],
      bleeps: [{ id: 'b1', start: 4.2, end: 4.6, word: 'damn', sound: 'tone', auto: true }]
    }
    const items = reviewItems(p)
    expect(items.map((i) => [i.kind, i.title])).toEqual(
      expect.arrayContaining([
        ['emoji', 'Emoji 💡 on “tip”'],
        ['graphic', 'Pop-up “Auto Save”'],
        ['graphic', 'Pop-up “d*** it”'],
        ['graphic', 'Lower third: Priya'],
        ['graphic', 'Chapter title: Export settings'],
        ['graphic', 'Quote: “Ship it today”'],
        ['bleep', 'Bleeped “d***”']
      ])
    )
    // The user's own counter is not listed.
    expect(items.some((i) => i.key === 'graphic:n1')).toBe(false)
    expect(row(items, 'graphic:e1').detail).toBe('Captions Studio, with Gemini')
    const bleep = row(items, 'bleep:b1')
    expect(itemAccessibleName(bleep, '0:04.2', 'pending')).toBe('Bleeped “d***”, bleep, at 0:04.2, Captions Studio, not reviewed')
    expect(itemAccessibleName(bleep, '0:04.2', 'pending')).not.toMatch(/damn/)
    expect(pendingCount(p)).toBe(items.length)
  })

  it('a project without automatic caption changes lists none of them', () => {
    expect(reviewItems(before)).toEqual([])
    expect(pendingCount(before)).toBe(0)
    const own: Project = { ...before, graphics: [counter('n1', false)], captionMarks: [{ id: 'm1', caption: 'c1', from: 0, to: 0, text: 'First,' }] }
    expect(reviewItems(own)).toEqual([])
  })

  it('names the look it replaced: a Classic look, a gallery look, the user’s own, none', () => {
    expect(lookName(null)).toBe('Clean')
    expect(lookName({ ...before.captions!, preset: 'boxed' } as never)).toBe('Boxed')
    expect(lookName(great.captions)).toBe('Clean Short')
    expect(lookName({ ...great.captions!, studio: { ...great.captions!.studio!, from: 'mine:abc' } })).toBe('your style')
    // A Classic look drawn through its Studio twin (emphasis, Ctrl+B or the Digits choice made it) by its Classic name.
    const boxed = { ...DEFAULT_CAPTIONS, preset: 'boxed' as const, background: 'box' as const }
    expect(lookName({ ...DEFAULT_CAPTIONS, studio: legacyTwin(DEFAULT_CAPTIONS) })).toBe('Clean')
    expect(lookName({ ...boxed, studio: legacyTwin(boxed) })).toBe('Boxed')
  })

  it('a run after the style was removed with the emphasis kept names the Classic look it replaced', () => {
    const items = reviewItems(great)
    const reviewed = removeItems(keepItems(great, [row(items, EMPHASIS_GROUP)]), [row(items, STYLE_KEY)])
    expect(reviewed.captions?.studio?.from).toBe('clean')
    const again = planCaptionsGreat({ project: reviewed, frame: TALL, cleanup: DEFAULT_CLEANUP, words: [], by: 'polish' }, DEFAULT_GREAT_OPTIONS).project
    const style = row(reviewItems(again), STYLE_KEY)
    expect(style.title).toBe('Caption style: Clean Short (was Clean)')
    expect(itemAccessibleName(style, '0:00.0', 'pending')).toContain('(was Clean)')
  })

  it('a text fix names the words that changed', () => {
    expect(textFixTitle('today i will', 'Today I will', undefined)).toBe('Fixed “today i” → “Today I”')
    expect(textFixTitle('we have twenty five reports', 'We have 25 reports.', undefined)).toBe('Fixed “we have twenty five reports” → “We have 25 reports.”')
    expect(textFixTitle('oh damn it', 'Oh damn it.', [{ id: 'b', start: 0, end: 1, word: 'damn', sound: 'tone' }])).toBe('Fixed “oh d*** it” → “Oh d*** it.”')
  })
})

describe('Keep and Remove, per kind', () => {
  it('Keep makes each change the user’s: records dropped, auto cleared; statuses kept', () => {
    const items = reviewItems(great)
    const kept = keepItems(great, items)
    expect(kept.captionAuto).toBeUndefined()
    expect(kept.captionMarks!.some((m) => m.auto)).toBe(false)
    expect(kept.graphics!.some((g) => g.auto)).toBe(false)
    // The look, the text and the items stay.
    expect(kept.captions).toBe(great.captions)
    expect(kept.transcript).toBe(great.transcript)
    expect(kept.captionMarks).toHaveLength(great.captionMarks!.length)
    expect(items.map((i) => reviewStatus(kept, i))).toEqual(items.map(() => 'kept'))
    expect(reviewItems(kept)).toEqual([])
    expect(pendingCount(kept)).toBe(0)
  })

  it('Remove takes each change back: Remove on every row gives the project from before Make my captions great', () => {
    const items = reviewItems(great)
    const removed = removeItems(great, items)
    expect(removed).toEqual(before)
    expect(items.map((i) => reviewStatus(removed, i))).toEqual(items.map(() => 'removed'))
  })

  it('the style row puts back the look from before; Keep drops only its record', () => {
    const only = { ...DEFAULT_GREAT_OPTIONS, emphasis: false, tidy: false, counters: false, lists: false }
    // Subtitle picked for the wide frame and kept, then Polish picks Clean Short for the tall one.
    const wide = planCaptionsGreat({ project: before, frame: WIDE, cleanup: DEFAULT_CLEANUP, words: [], by: 'great' }, only).project
    const mine = keepItems(wide, [row(reviewItems(wide), STYLE_KEY)])
    const was = mine.captions
    const p = planCaptionsGreat({ project: mine, frame: TALL, cleanup: DEFAULT_CLEANUP, words: [], by: 'polish' }, only).project
    const style = row(reviewItems(p), STYLE_KEY)
    expect(style).toMatchObject({ title: 'Caption style: Clean Short (was Subtitle)', detail: 'Polish' })
    const removed = removeItems(p, [style])
    expect(removed.captions).toEqual(was)
    expect(removed.captionAuto).toBeUndefined()
    expect(reviewStatus(removed, style)).toBe('removed')
    const kept = keepItems(p, [style])
    expect(kept.captions).toBe(p.captions)
    expect(reviewStatus(kept, style)).toBe('kept')
  })

  it('Remove on the style row puts back only the look: hidden captions, the track, speaker names and a dragged place stay', () => {
    const store = storeOf(great)
    const place = { x: 0.5, y: 0.3 }
    // None of these is a look change: the settle rule keeps the record through them (§11.8 rule 1).
    store.update((p) => ({ ...p, captions: { ...p.captions!, show: false, track: 'bn', showSpeaker: true, digits: 'western', studio: { ...p.captions!.studio!, layout: { ...p.captions!.studio!.layout, place } } } }))
    expect(store.state.captionAuto?.style).toBeDefined()
    const style = row(reviewItems(store.state), STYLE_KEY)
    expect(reviewStatus(store.state, style)).toBe('pending')
    store.update((p) => removeItems(p, [style]))
    const c = store.state.captions!
    expect(c).toMatchObject({ show: false, track: 'bn', showSpeaker: true, digits: 'western', preset: 'clean', color: DEFAULT_CAPTIONS.color, background: DEFAULT_CAPTIONS.background })
    // The emphasis still pending draws on the Classic look's twin, which keeps the dragged place.
    const twin = legacyTwin({ ...c, studio: undefined })
    expect(c.studio).toEqual({ ...twin, layout: { ...twin.layout, place } })
    expect(store.state.captionAuto?.style).toBeUndefined()
    expect(reviewStatus(store.state, style)).toBe('removed')
    // Without later changes and without marks, the settings from before come back: none at all here.
    const plain = removeItems(great, [row(reviewItems(great), STYLE_KEY), row(reviewItems(great), EMPHASIS_GROUP)])
    expect(plain.captions).toBeUndefined()
  })

  it('kept or pending emphasis still draws after Remove on the style row: the old look gets its Studio twin', () => {
    const items = reviewItems(great)
    const style = row(items, STYLE_KEY)
    const emphasis = row(items, EMPHASIS_GROUP)
    const kept = removeItems(keepItems(great, [emphasis]), [style])
    expect(kept.captionMarks!.length).toBe(great.captionMarks!.length)
    // Only Studio looks draw marks (captionsLayer): the default Clean look as its twin.
    expect(kept.captions).toEqual({ ...DEFAULT_CAPTIONS, studio: legacyTwin(DEFAULT_CAPTIONS) })
    expect(reviewStatus(kept, style)).toBe('removed')
    expect(reviewStatus(kept, emphasis)).toBe('kept')
    // Still pending: the same, and removing the emphasis afterwards takes the twin away again.
    const pending = removeItems(great, [style])
    expect(pending.captions?.studio).toEqual(legacyTwin(DEFAULT_CAPTIONS))
    const after = removeItems(pending, [emphasis])
    expect(after.captionMarks).toBeUndefined()
    expect(after.captions?.studio).toBeUndefined()
    expect(reviewStatus(after, style)).toBe('removed')
  })

  it('Remove on every row gives back a Classic look the run turned into its twin for emphasis (no style row)', () => {
    const boxed: Project = { ...before, captions: { ...DEFAULT_CAPTIONS, preset: 'boxed', background: 'box', picked: true } }
    const clean: Project = { ...before, captions: { ...DEFAULT_CAPTIONS } }
    for (const [start, frame, options] of [
      [boxed, TALL, DEFAULT_GREAT_OPTIONS],
      [clean, WIDE, { ...DEFAULT_GREAT_OPTIONS, style: false }]
    ] as const) {
      const run = planCaptionsGreat({ project: start, frame, cleanup: DEFAULT_CLEANUP, words: [], by: 'great' }, options).project
      expect(run.captions!.studio!.from).toBe(start.captions!.preset)
      const items = reviewItems(run)
      expect(items.some((i) => i.key === STYLE_KEY)).toBe(false)
      expect(removeItems(run, items)).toEqual(start)
      // Removing only the emphasis does it too; a twin the user edited (here dragged) stays.
      expect(removeItems(run, [row(items, EMPHASIS_GROUP)]).captions).toEqual(start.captions)
      const dragged: Project = { ...run, captions: { ...run.captions!, studio: { ...run.captions!.studio!, layout: { ...run.captions!.studio!.layout, place: { x: 0.4, y: 0.2 } } } } }
      expect(removeItems(dragged, [row(items, EMPHASIS_GROUP)]).captions).toBe(dragged.captions)
    }
  })

  it('speaker names the run turned on with its look go on Remove of the style row; names the user had stay', () => {
    const named = captions(['Hi, I am Priya and today we look at reports.', 'Thanks Priya, I am Sam. First open Settings.', 'Then click Export and pick a folder.', 'And that is all, thanks Sam.']).map((c, i) => ({ ...c, speaker: i % 2 ? 'Sam' : 'Priya' }))
    const start = studioProject({ segments: named })
    // Two speakers in a wide frame: Subtitle with a colour for each speaker and their names (§11.6).
    const run = planCaptionsGreat({ project: start, frame: WIDE, cleanup: DEFAULT_CLEANUP, words: [], by: 'great' }, DEFAULT_GREAT_OPTIONS).project
    expect(run.captions).toMatchObject({ showSpeaker: true, studio: { from: 'subtitle', speakerColors: true } })
    expect(run.captionAuto?.style?.names).toBe(true)
    const style = row(reviewItems(run), STYLE_KEY)
    const r = removeItems(run, [style])
    expect(r.captions?.showSpeaker).toBeUndefined()
    expect(reviewStatus(r, style)).toBe('removed')
    expect(removeItems(run, reviewItems(run))).toEqual(start)
    // Names on before the run are the user's: they stay, and the run records none.
    const had: Project = { ...start, captions: { ...DEFAULT_CAPTIONS, showSpeaker: true } }
    const run2 = planCaptionsGreat({ project: had, frame: WIDE, cleanup: DEFAULT_CLEANUP, words: [], by: 'great' }, DEFAULT_GREAT_OPTIONS).project
    expect(run2.captionAuto?.style).toBeDefined()
    expect(run2.captionAuto?.style?.names).toBeUndefined()
    expect(removeItems(run2, [row(reviewItems(run2), STYLE_KEY)]).captions?.showSpeaker).toBe(true)
    expect(removeItems(run2, reviewItems(run2))).toEqual(had)
  })

  it('graphics, title cards and bleeps: Keep clears auto, Remove deletes; others are left alone', () => {
    const p: Project = {
      ...before,
      graphics: [emoji('e1'), keyword('k1', 'Auto Save'), counter('n1', false)],
      titles: [card('t1', 'chapter', 'Export settings', 8)],
      bleeps: [{ id: 'b1', start: 4.2, end: 4.6, word: 'damn', sound: 'tone', auto: true }]
    }
    const items = reviewItems(p)
    const kept = keepItems(p, items)
    expect(kept.graphics!.map((g) => [g.id, !!g.auto])).toEqual([['e1', false], ['k1', false], ['n1', false]])
    expect(kept.titles![0].auto).toBeUndefined()
    expect(kept.bleeps![0].auto).toBeUndefined()
    const removed = removeItems(p, items)
    expect(removed.graphics!.map((g) => g.id)).toEqual(['n1'])
    expect(removed.titles).toEqual([])
    expect(removed.bleeps).toBeUndefined()
    for (const i of items) {
      expect(reviewStatus(kept, i)).toBe('kept')
      expect(reviewStatus(removed, i)).toBe('removed')
    }
    // Nothing pending: the same project.
    expect(keepItems(kept, items)).toBe(kept)
    expect(removeItems(removed, items)).toBe(removed)
  })
})

describe('the emphasis and text group rows', () => {
  it('Keep and Remove on a group do all its items; on one item, only that one', () => {
    const items = reviewItems(great)
    const emphasis = row(items, EMPHASIS_GROUP)
    const [first, ...rest] = emphasis.parts!
    expect(rest.length).toBeGreaterThan(0)
    const one = removeItems(great, [first])
    expect(one.captionMarks!.map((m) => `emphasis:${m.id}`)).toEqual(great.captionMarks!.map((m) => `emphasis:${m.id}`).filter((k) => k !== first.key))
    expect(reviewStatus(one, first)).toBe('removed')
    expect(reviewStatus(one, emphasis)).toBe('pending')
    // The group's Keep keeps what is still pending: a mixed group reads kept.
    const all = keepItems(one, [emphasis])
    expect(all.captionMarks!.every((m) => !m.auto)).toBe(true)
    expect(rest.every((r) => reviewStatus(all, r) === 'kept')).toBe(true)
    expect(reviewStatus(all, emphasis)).toBe('kept')
    // All removed: the group reads removed, and the marks are gone with their key.
    const gone = removeItems(great, [emphasis])
    expect(gone.captionMarks).toBeUndefined()
    expect(reviewStatus(gone, emphasis)).toBe('removed')
  })

  it('the text group: Remove puts the text and words back, Keep keeps the tidied text', () => {
    const text = row(reviewItems(great), TEXT_GROUP)
    const removed = removeItems(great, [text])
    expect(removed.transcript!.segments[0].text).toBe(TEXTS[0])
    expect(removed.transcript!.segments[0].words).toBeUndefined()
    expect(removed.captionAuto?.text).toBeUndefined()
    expect(reviewStatus(removed, text)).toBe('removed')
    expect(reviewStatus(removed, text.parts![0])).toBe('removed')
    const kept = keepItems(great, [text.parts![0]])
    expect(kept.transcript).toBe(great.transcript)
    expect(kept.captionAuto?.text).toBeUndefined()
    expect(reviewStatus(kept, text)).toBe('kept')
  })

  it('"n of N reviewed" counts a group once', () => {
    const items = reviewItems(great)
    const emphasis = row(items, EMPHASIS_GROUP)
    const after = removeItems(great, [emphasis.parts![0]])
    // One item inside the group reviewed: no row is reviewed yet.
    expect(reviewProgress(items.map((i) => reviewStatus(after, i)))).toEqual({ reviewed: 0, total: items.length })
    const done = keepItems(after, [emphasis])
    expect(reviewProgress(items.map((i) => reviewStatus(done, i)))).toEqual({ reviewed: 1, total: items.length })
  })

  it('the panel keeps a group’s reviewed items listed, marked, and takes in items pending later', () => {
    const shown = reviewItems(great)
    const group = row(shown, EMPHASIS_GROUP)
    const [first] = group.parts!
    const p = keepItems(great, [first])
    const merged = row(mergeSnapshot(shown, p), EMPHASIS_GROUP)
    expect(merged.members).toEqual(group.members)
    expect(merged.title).toBe(group.title)
    expect(reviewStatus(p, merged.parts![0])).toBe('kept')
    // Every item reviewed: the group (gone from the project's pending list) stays as it was listed.
    const done = keepItems(p, [merged])
    const last = row(mergeSnapshot(mergeSnapshot(shown, p), done), EMPHASIS_GROUP)
    expect(last.members).toEqual(group.members)
    expect(reviewStatus(done, last)).toBe('kept')
    // A new automatic mark later joins the group.
    const more: Project = { ...done, captionMarks: [...done.captionMarks!, { id: 'new', caption: 'c5', from: 0, to: 0, text: 'Click', auto: true }] }
    const grown = row(mergeSnapshot(mergeSnapshot(shown, done), more), EMPHASIS_GROUP)
    expect(grown.members).toEqual([...group.members!, 'emphasis:new'])
    expect(reviewStatus(more, grown)).toBe('pending')
  })
})

describe('undo: one step per press, statuses follow', () => {
  it('Keep and Remove on a group row, on one of its items and on a row are each one undo step', () => {
    const store = storeOf(great)
    const items = reviewItems(great)
    const emphasis = row(items, EMPHASIS_GROUP)
    const text = row(items, TEXT_GROUP)
    const style = row(items, STYLE_KEY)
    store.update((p) => removeItems(p, [emphasis.parts![0]]))
    store.update((p) => keepItems(p, [emphasis]))
    store.update((p) => removeItems(p, [text]))
    store.update((p) => removeItems(p, [style]))
    expect(reviewStatus(store.state, emphasis)).toBe('kept')
    expect(reviewStatus(store.state, text)).toBe('removed')
    expect(reviewStatus(store.state, style)).toBe('removed')
    // The settle chain keeps what Review did: no record or mark comes back, none is dropped twice.
    expect(store.state.captionAuto).toBeUndefined()
    expect(store.state.transcript!.segments[0].text).toBe(TEXTS[0])
    store.undo()
    expect(reviewStatus(store.state, style)).toBe('pending')
    store.undo()
    expect(reviewStatus(store.state, text)).toBe('pending')
    store.undo()
    expect(reviewStatus(store.state, emphasis)).toBe('pending')
    expect(reviewStatus(store.state, emphasis.parts![0])).toBe('removed')
    store.redo()
    expect(reviewStatus(store.state, emphasis)).toBe('kept')
    expect(undoSteps(store)).toBe(2)
    expect(store.state).toBe(great)
  })
})

describe('the words of the new kinds', () => {
  it('a lower third or chapter title row names its kind for what Remove all takes: every automatic graphic, title cards with pop-ups', () => {
    const p: Project = { ...before, graphics: [keyword('k1', 'Auto Save')], titles: [card('t1', 'speaker', 'Priya', 1), card('t2', 'chapter', 'Export settings', 8)] }
    const items = reviewItems(p)
    const lower = row(items, 'card:t1')
    expect(itemAccessibleName(lower, '0:01.0', 'pending')).toBe('Lower third: Priya, graphic, at 0:01.0, Captions Studio, not reviewed')
    // The footer's Remove all on that row (ReviewPanel's removeKind: every pending row of its kind).
    const all = items.filter((i) => i.kind === lower.kind)
    expect(all.map((i) => i.title)).toEqual(['Lower third: Priya', 'Chapter title: Export settings', 'Pop-up “Auto Save”'])
    expect(KIND_WORDS[lower.kind]).toMatchObject({ chip: 'Graphic', all: 'Remove all graphics' })
    expect(removeItems(p, all)).toMatchObject({ titles: [] })
  })

  it('have chips, names and Remove all', () => {
    expect(KIND_WORDS.style.all).toBe('Remove all caption style changes')
    expect(KIND_WORDS.emoji.all).toBe('Remove all emoji')
    expect(KIND_WORDS.graphic.all).toBe('Remove all graphics')
    expect(KIND_WORDS.bleep.all).toBe('Remove all bleeps')
  })
})
