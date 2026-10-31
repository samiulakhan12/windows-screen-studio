import { describe, expect, it } from 'vitest'
import { mergeWithNext, splitCaption, withCaptionText } from '../src/shared/captions/edit'
import { clearEmphasis, marksByCaption, remapAnchors, toggleEmphasis, withCaptionPlace } from '../src/shared/captions/marks'
import { readCaptionMarks, readGraphics } from '../src/shared/captions/studioData'
import { legacyTwin } from '../src/shared/captions/studioEdit'
import { DEFAULT_CAPTIONS } from '../src/shared/captions/settings'
import { createProject, migrateProject } from '../src/shared/engine/project'
import type { CaptionSegment, CaptionWord, Graphic, Project, Transcript } from '../src/shared/types'

/* Tests 20 and 49 (docs/design/captions-studio.md §16.1): emphasis marks, and records that follow their words (§2.7, §11.1). */

function caption(id: string, text: string, start: number, step = 0.5): CaptionSegment {
  const words: CaptionWord[] = text.split(' ').map((w, i) => ({ text: w, start: start + i * step, end: start + i * step + step * 0.8 }))
  return { id, start, end: start + words.length * step, text, words }
}

function project(segments: CaptionSegment[], extra: Partial<Project> = {}): Project {
  const p = createProject({ id: 'p', name: 'p', duration: 20, width: 1920, height: 1080, hasWebcam: false, hasAudio: true, webcamOffset: 0, zooms: [], cursorValid: true, capture: { method: 'native', cursorInVideo: false, region: null } as Project['capture'] })
  return { ...p, transcript: { language: 'en', provider: 'local', model: 'm', createdAt: '2026-10-31T00:00:00Z', segments }, ...extra }
}

const withSegments = (p: Project, segments: CaptionSegment[]): Project => ({ ...p, transcript: { ...(p.transcript as Transcript), segments } })

/** The fields records live in, as saving and reopening the project gives them. */
const reread = (p: Project): Pick<Project, 'captionMarks' | 'captionPlaces' | 'graphics'> => {
  const m = migrateProject(JSON.parse(JSON.stringify(p)))
  return { captionMarks: m.captionMarks, captionPlaces: m.captionPlaces, graphics: m.graphics }
}
const fields = (p: Project): Pick<Project, 'captionMarks' | 'captionPlaces' | 'graphics'> => ({ captionMarks: p.captionMarks, captionPlaces: p.captionPlaces, graphics: p.graphics })

describe('emphasis marks (test 20)', () => {
  const base = project([caption('c1', 'Make every word count today', 0), caption('c2', 'Then open the settings', 3)], { captions: { ...DEFAULT_CAPTIONS, studio: legacyTwin(DEFAULT_CAPTIONS) } })

  it('Ctrl+B adds a mark, and removes it when every selected word is emphasised', () => {
    const on = toggleEmphasis(base, [{ caption: 'c1', from: 1, to: 2 }])
    expect(on.captionMarks).toEqual([{ id: expect.any(String), caption: 'c1', from: 1, to: 2, text: 'every word' }])
    expect(toggleEmphasis(on, [{ caption: 'c1', from: 1, to: 2 }]).captionMarks).toBeUndefined()
    // Part of a mark selected: only those words lose it.
    const part = toggleEmphasis(on, [{ caption: 'c1', from: 2, to: 2 }])
    expect(part.captionMarks!.map((m) => [m.from, m.to, m.text])).toEqual([[1, 1, 'every']])
    // A selection over two captions emphasises the words in each.
    const both = toggleEmphasis(base, [
      { caption: 'c1', from: 4, to: 4 },
      { caption: 'c2', from: 0, to: 1 }
    ])
    expect(both.captionMarks!.map((m) => `${m.caption}:${m.text}`)).toEqual(['c1:today', 'c2:Then open'])
    expect(marksByCaption(both.captionMarks).get('c2')!.length).toBe(1)
    expect(clearEmphasis(both).captionMarks).toBeUndefined()
    expect(clearEmphasis(base)).toBe(base)
  })

  it('Ctrl+Shift+B writes tone 2, and Ctrl+B on those words gives them the first colour', () => {
    const two = toggleEmphasis(base, [{ caption: 'c1', from: 3, to: 3 }], 2)
    expect(two.captionMarks![0]).toMatchObject({ from: 3, to: 3, tone: 2, text: 'count' })
    const one = toggleEmphasis(two, [{ caption: 'c1', from: 3, to: 3 }])
    expect(one.captionMarks).toEqual([expect.objectContaining({ from: 3, to: 3 })])
    expect(one.captionMarks![0].tone).toBeUndefined()
  })

  it('reads back as it was written', () => {
    const on = toggleEmphasis(toggleEmphasis(base, [{ caption: 'c1', from: 0, to: 0 }]), [{ caption: 'c2', from: 2, to: 3 }], 2)
    expect(readCaptionMarks(JSON.parse(JSON.stringify(on.captionMarks)), on.transcript)).toEqual(on.captionMarks)
  })

  it('a word inserted before a mark moves it; a changed word drops it', () => {
    const on = toggleEmphasis(base, [{ caption: 'c1', from: 2, to: 2 }])
    const inserted = withSegments(on, [withCaptionText(on.transcript!.segments[0], 'Make sure every word count today'), on.transcript!.segments[1]])
    expect(remapAnchors(inserted, on).captionMarks).toEqual([expect.objectContaining({ caption: 'c1', from: 3, to: 3, text: 'word' })])
    const changed = withSegments(on, [withCaptionText(on.transcript!.segments[0], 'Make every phrase count today'), on.transcript!.segments[1]])
    expect(remapAnchors(changed, on).captionMarks).toBeUndefined()
    // Nothing about the captions changed: the very same project.
    const moved = { ...on, zooms: [] }
    expect(remapAnchors(moved, on)).toBe(moved)
  })

  it('emphasis on a legacy look makes its Studio twin in the same update, without picking the look', () => {
    const legacy = project([caption('c1', 'Make every word count today', 0)], { captions: { ...DEFAULT_CAPTIONS, preset: 'boxed', background: 'box' } })
    const on = toggleEmphasis(legacy, [{ caption: 'c1', from: 1, to: 1 }])
    expect(on.captions!.studio).toEqual(legacyTwin(legacy.captions!))
    expect(on.captions!.picked).toBeUndefined()
    expect(on.captionMarks!.length).toBe(1)
    // A project that never set captions gets the twin of the defaults.
    const bare = project([caption('c1', 'Make every word', 0)])
    expect(toggleEmphasis(bare, [{ caption: 'c1', from: 0, to: 0 }]).captions!.studio).toEqual(legacyTwin(DEFAULT_CAPTIONS))
    // Removing emphasis never makes a twin.
    expect(toggleEmphasis(on, [{ caption: 'c1', from: 1, to: 1 }]).captions).toBe(on.captions)
  })

  it('places one caption at the top or the bottom, and back', () => {
    const top = withCaptionPlace(base, 'c2', 'top')
    expect(top.captionPlaces).toEqual([{ caption: 'c2', position: 'top' }])
    const both = withCaptionPlace(top, 'c1', 'bottom')
    expect(both.captionPlaces).toEqual([
      { caption: 'c1', position: 'bottom' },
      { caption: 'c2', position: 'top' }
    ])
    expect(withCaptionPlace(both, 'c1', 'bottom')).toBe(both)
    expect(withCaptionPlace(withCaptionPlace(top, 'c2', null), 'nope', 'top').captionPlaces).toBeUndefined()
  })
})

describe('records across edits (test 49)', () => {
  const pop = { kind: 'pop', duration: 0.24, strength: 1 } as const
  const fade = { kind: 'fade', duration: 0.18, strength: 1 } as const
  /** A mark, a keyword anchor and an emoji anchor on the second half of c1, and c1 placed at the top. */
  function withRecords(): Project {
    const p = project([caption('c1', 'Make every word count today', 0), caption('c2', 'Then open the settings', 3)])
    const graphics: Graphic[] = [
      { id: 'g-key', kind: 'keyword', start: 1.5, end: 2.5, place: 'auto', size: 0.09, enter: { ...pop }, exit: { ...fade }, text: 'today', look: 'card', anchor: { caption: 'c1', from: 4, to: 4, text: 'today' } },
      { id: 'g-emo', kind: 'emoji', start: 1.4, end: 2.4, place: 'auto', size: 0.12, enter: { ...pop }, exit: { ...fade }, emoji: '1f525', anchor: { caption: 'c1', from: 3, to: 3, text: 'count' } }
    ]
    return {
      ...p,
      captionMarks: [{ id: 'm1', caption: 'c1', from: 3, to: 4, text: 'count today' }],
      captionPlaces: [{ caption: 'c1', position: 'top' }],
      graphics: readGraphics(graphics, 20, p.transcript)
    }
  }
  const anchors = (p: Project): string[] => (p.graphics ?? []).map((g) => (g.kind === 'keyword' || g.kind === 'emoji') && g.anchor ? `${g.anchor.caption}:${g.anchor.from}-${g.anchor.to}` : 'free')

  it('survive a split, on the second half, and both halves keep the place', () => {
    const prev = withRecords()
    const segs = splitCaption(prev.transcript!.segments, 'c1', 1.45)!
    const second = segs[1]
    expect(second.text).toBe('count today')
    const next = remapAnchors(withSegments(prev, segs), prev)
    expect(next.captionMarks).toEqual([{ id: 'm1', caption: second.id, from: 0, to: 1, text: 'count today' }])
    expect(anchors(next).sort()).toEqual([`${second.id}:0-0`, `${second.id}:1-1`].sort())
    expect(next.captionPlaces).toEqual([
      { caption: 'c1', position: 'top' },
      { caption: second.id, position: 'top' }
    ])
    expect(fields(next)).toEqual(reread(next))
  })

  it('survive a merge, on the merged caption, which keeps the first one’s place', () => {
    const prev = withRecords()
    const onC2: Project = { ...prev, captionMarks: [...prev.captionMarks!, { id: 'm2', caption: 'c2', from: 1, to: 1, text: 'open' }], captionPlaces: [{ caption: 'c2', position: 'bottom' }] }
    const segs = mergeWithNext(onC2.transcript!.segments, 'c1')!
    const next = remapAnchors(withSegments(onC2, segs), onC2)
    expect(next.captionMarks!.map((m) => `${m.id} ${m.caption}:${m.from}-${m.to} ${m.text}`)).toEqual(['m1 c1:3-4 count today', 'm2 c1:6-6 open'])
    expect(anchors(next).sort()).toEqual(['c1:3-3', 'c1:4-4'])
    // c2 is gone: its place goes with it; c1 had none.
    expect(next.captionPlaces).toBeUndefined()
    expect(fields(next)).toEqual(reread(next))
  })

  it('survive Generate captions again with the same words', () => {
    const prev = withRecords()
    const again = [caption('n1', 'Make every word count today', 0), caption('n2', 'Then open the settings', 3)]
    const next = remapAnchors(withSegments(prev, again), prev)
    expect(next.captionMarks).toEqual([{ id: 'm1', caption: 'n1', from: 3, to: 4, text: 'count today' }])
    expect(anchors(next).sort()).toEqual(['n1:3-3', 'n1:4-4'])
    // A caption that is gone loses its place.
    expect(next.captionPlaces).toBeUndefined()
    expect(fields(next)).toEqual(reread(next))
  })

  it('drop what is gone: the graphic stays, free', () => {
    const prev = withRecords()
    const next = remapAnchors(withSegments(prev, [caption('c1', 'Something else entirely', 0), prev.transcript!.segments[1]]), prev)
    expect(next.captionMarks).toBeUndefined()
    expect(anchors(next)).toEqual(['free', 'free'])
    expect(next.graphics!.length).toBe(2)
    expect(fields(next)).toEqual(reread(next))
  })

  it('a mark whose stored index points at other words (as after an ICU change) is found again by its text', () => {
    const p = withRecords()
    const stale = { ...p, captionMarks: [{ id: 'm1', caption: 'c1', from: 0, to: 1, text: 'count today' }] }
    expect(reread(stale).captionMarks).toEqual([{ id: 'm1', caption: 'c1', from: 3, to: 4, text: 'count today' }])
  })
})
