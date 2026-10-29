import { describe, expect, it } from 'vitest'
import { subtitleFile } from '../src/shared/captions/subtitles'
import { planOf, videoDuration, videoFrames } from '../src/shared/engine/freeze'
import { outputChapters } from '../src/shared/render/chapters'
import {
  bundleKinds,
  chapterListText,
  chapterParts,
  clipsBetween,
  descriptionText,
  normalizeBundle,
  NO_BUNDLE,
  partFileNames,
  partProject,
  perChapterBlocked,
  sidecarBlocked,
  sidecarName,
  stillAcrossChapters
} from '../src/shared/render/exportBundle'
import type { Chapter, Clip, Freeze } from '../src/shared/types'

const clip = (id: string, start: number, end: number, speed = 1): Clip => ({ id, start, end, speed })
const ch = (t: number, title: string): Chapter => ({ id: `k${t}`, t, title })
const ALL = { srt: true, vtt: true, chapters: true, thumbnail: true, description: true, perChapter: false }

describe('bundle options', () => {
  it('keeps only known true flags', () => {
    expect(normalizeBundle(null)).toEqual(NO_BUNDLE)
    expect(normalizeBundle({ srt: true, vtt: 'yes', perChapter: true, other: true })).toEqual({ ...NO_BUNDLE, srt: true, perChapter: true })
  })

  it('saves what each format and video can hold', () => {
    const has = { captions: true, chapters: true }
    expect(bundleKinds(ALL, 'mp4', has)).toEqual(['srt', 'vtt', 'chapters', 'thumbnail', 'description'])
    expect(bundleKinds(ALL, 'm4a', has)).toEqual(['srt', 'vtt', 'chapters', 'description'])
    expect(bundleKinds(ALL, 'gif', has)).toEqual([])
    expect(bundleKinds(ALL, 'mp4', { captions: false, chapters: false })).toEqual(['thumbnail', 'description'])
    expect(bundleKinds(ALL, 'mp4', has, true)).toEqual(['srt', 'vtt', 'thumbnail', 'description'])
    expect(sidecarBlocked('srt', 'mp4', { captions: false, chapters: true })).toBe('This video has no captions yet')
    expect(perChapterBlocked({ captions: false, chapters: false }, 'single')).toBe('Add chapters first')
    expect(perChapterBlocked(has, 'batch')).toBe('One file per chapter works with One file')
  })

  it('names the files after the video', () => {
    expect(sidecarName('Demo.mp4', 'srt')).toBe('Demo.srt')
    expect(sidecarName('Demo v1.2.mp4', 'vtt')).toBe('Demo v1.2.vtt')
    expect(sidecarName('Demo.mp4', 'chapters')).toBe('Demo - chapters.txt')
    expect(sidecarName('Demo.mp4', 'thumbnail')).toBe('Demo - thumbnail.png')
    expect(sidecarName('Demo.mp4', 'description')).toBe('Demo - description.txt')
  })
})

describe('chapter parts', () => {
  it('cuts the clips at each chapter, the first starting at 0:00', () => {
    const clips = [clip('a', 0, 10)]
    const parts = chapterParts({ clips, chapters: [ch(1, 'Intro'), ch(4, 'Billing'), ch(8, 'End')] })
    expect(parts.map((p) => [p.title, p.start, p.end])).toEqual([
      ['Intro', 0, 4],
      ['Billing', 4, 8],
      ['End', 8, 10]
    ])
    expect(parts.map((p) => p.clips.map((c) => [c.start, c.end]))).toEqual([[[0, 4]], [[4, 8]], [[8, 10]]])
  })

  it('follows cuts and speed changes', () => {
    // 0-2 at 1x (2 s), 5-9 at 2x (2 s): a chapter at source 7 starts at output 3.
    const clips = [clip('a', 0, 2), clip('b', 5, 9, 2)]
    const parts = chapterParts({ clips, chapters: [ch(0, 'One'), ch(7, 'Two')] })
    expect(parts.map((p) => p.clips.map((c) => [c.id, c.start, c.end, c.speed]))).toEqual([
      [
        ['a', 0, 2, 1],
        ['b', 5, 7, 2]
      ],
      [['b', 7, 9, 2]]
    ])
    // Every frame of the whole export is in exactly one part, in order.
    const fps = 30
    const whole = videoFrames(clips, planOf({ clips }), fps).times
    const pieces = parts.flatMap((p) => videoFrames(p.clips, planOf({ clips: p.clips }), fps).times)
    const ms = (t: number[]): number[] => t.map((v) => Math.round(v * 1e6))
    expect(ms(pieces)).toEqual(ms(whole))
  })

  it('puts a pause freeze at a chapter start into the part it starts', () => {
    const clips = [clip('a', 0, 10)]
    const freezes: Freeze[] = [{ id: 'f', at: 4, length: 2, sound: 'pause' } as Freeze]
    const project = { clips, freezes, chapters: [ch(0, 'One'), ch(4, 'Two')] }
    const parts = chapterParts(project)
    expect(parts.map((p) => [p.start, p.end])).toEqual([
      [0, 4],
      [4, 12]
    ])
    const first = partProject(project, parts[0], false)
    const second = partProject(project, parts[1], true)
    expect(first.freezes).toBeUndefined()
    expect(second.freezes?.map((f) => f.id)).toEqual(['f'])
    expect(videoDuration(first.clips, planOf(first)) + videoDuration(second.clips, planOf(second))).toBeCloseTo(12)
    expect('chapters' in second).toBe(false)
  })

  it('refuses to split inside a still that keeps the sound playing', () => {
    const clips = [clip('a', 0, 20)]
    const still: Freeze = { id: 's', at: 8, length: 5, sound: 'continue' } as Freeze
    const across = { clips, freezes: [still], chapters: [ch(0, 'A'), ch(10, 'B'), ch(15, 'C')] }
    expect(stillAcrossChapters(across, chapterParts(across))).toBe(true)
    expect(perChapterBlocked({ captions: false, chapters: true, stillAcross: true }, 'single')).toMatch(/freeze frame/)
    const clear = { ...across, chapters: [ch(0, 'A'), ch(14, 'B')] }
    expect(stillAcrossChapters(clear, chapterParts(clear))).toBe(false)
  })

  it('keeps captions in each part in its own time', () => {
    const clips = [clip('a', 0, 10)]
    const parts = chapterParts({ clips, chapters: [ch(0, 'One'), ch(5, 'Two')] })
    const segs = [{ id: 's', start: 6, end: 7, text: 'Later' }]
    expect(subtitleFile(segs, parts[1].clips, 'srt')).toBe('1\n00:00:01,000 --> 00:00:02,000\nLater\n')
    expect(subtitleFile(segs, parts[0].clips, 'srt')).toBe('')
  })

  it('has no parts without chapters, and slices clips by output time', () => {
    expect(chapterParts({ clips: [clip('a', 0, 5)] })).toEqual([])
    expect(clipsBetween([clip('a', 0, 4, 2)], 0.5, 1)).toEqual([clip('a', 1, 2, 2)])
  })
})

describe('file names and texts', () => {
  it('numbers the parts and makes names Windows accepts', () => {
    expect(partFileNames([{ title: 'Intro' }, { title: 'Billing: part/1' }, { title: '  ' }], 'mp4')).toEqual(['01 Intro.mp4', '02 Billing- part-1.mp4', '03 Chapter 3.mp4'])
    expect(partFileNames(Array.from({ length: 100 }, () => ({ title: 'Same' })), 'mp4').slice(0, 2)).toEqual(['001 Same.mp4', '002 Same.mp4'])
    expect(partFileNames([{ title: 'Ends with dots...' }], 'mov')).toEqual(['01 Ends with dots.mov'])
    expect(partFileNames([{ title: 'x'.repeat(400) }], 'mp4')[0].length).toBeLessThanOrEqual(200)
  })

  it('writes the chapter list and the description', () => {
    const clips = [clip('a', 0, 75)]
    const chapters = outputChapters([ch(0, 'Intro'), ch(30, 'Billing')], clips)
    expect(chapterListText(chapters, 75)).toBe('0:00 Intro\n0:30 Billing\n')
    expect(descriptionText('Demo', 75, chapters)).toBe('Demo\n\nLength: 1 min 15 s\n\nChapters\n0:00 Intro\n0:30 Billing\n')
    expect(descriptionText('01 Intro', 30, [], { index: 0, count: 2, of: 'Demo' })).toBe('01 Intro\n\nPart 1 of 2 of Demo\nLength: 30 s\n')
    expect(descriptionText('Long', 3725.9, [])).toBe('Long\n\nLength: 1 h 2 min 5 s\n')
    expect(descriptionText('Two', 120, [])).toBe('Two\n\nLength: 2 min\n')
    expect(descriptionText('Blank', 0.4, [])).toBe('Blank\n\nLength: 0 s\n')
  })

  it('puts no timestamp before the chapters, so YouTube reads 0:00 as the first one', () => {
    const clips = [clip('a', 0, 52)]
    const chapters = outputChapters([ch(0, 'Intro'), ch(19, 'Billing'), ch(39, 'End')], clips)
    const text = descriptionText('Demo', 52, chapters)
    expect(text.match(/\b\d+:\d{2}\b/g)).toEqual(['0:00', '0:19', '0:39'])
    expect(chapterListText([], 10)).toBe('')
  })
})
