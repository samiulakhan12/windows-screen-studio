/**
 * Captions Studio test 47 (docs/design/captions-studio.md §11.9, §11.10): translated tracks, the
 * burned-in captions, cues of partly cut captions, the ISO map and names in VTT.
 */
import { describe, expect, it } from 'vitest'
import { burnedSegments, iso6392, ISO_639_2, missingTranslations, outOfDate, placeOf, textHash, withoutTrack, withTrack } from '../src/shared/captions/captionTracks'
import { trackCues, trackVtt } from '../src/shared/captions/trackCues'
import type { CaptionSegment, CaptionTrack, Project } from '../src/shared/types'

const segs: CaptionSegment[] = [
  { id: 'a', start: 1, end: 3, text: 'Hello there', words: [{ text: 'Hello', start: 1, end: 1.8 }, { text: 'there', start: 2, end: 2.8 }], speaker: 'Priya' },
  { id: 'b', start: 4, end: 6, text: 'Second caption' },
  { id: 'c', start: 7, end: 9, text: 'Third one' }
]
const bn: CaptionTrack = {
  language: 'bn',
  by: 'gemini',
  model: 'm',
  createdAt: '2026-10-31',
  segments: [
    { id: 'a', text: 'নমস্কার', src: textHash('Hello there') },
    { id: 'b', text: 'দ্বিতীয়', src: textHash('Old text') }
  ]
}
const project = (extra: Partial<Project> = {}): Project =>
  ({ duration: 20, clips: [{ start: 0, end: 20, speed: 1 }], transcript: { language: 'en', provider: 'local', model: 'm', createdAt: '', segments: segs }, ...extra }) as unknown as Project

describe('caption tracks (test 47)', () => {
  it('textHash is FNV-1a 32 bits in hex', () => {
    expect(textHash('')).toBe('811c9dc5')
    expect(textHash('a')).toBe('e40c292c')
    expect(textHash('foobar')).toBe('bf9cf968')
  })

  it('finds out-of-date and missing translations; Translate again redoes only those', () => {
    const p = project({ captionTracks: [bn] })
    expect(outOfDate(p, 'bn')).toEqual(['b', 'c'])
    expect(missingTranslations(p, 'bn')).toBe(1)
    expect(outOfDate(p, 'hi')).toEqual(['a', 'b', 'c'])
  })

  it('adds, replaces and removes tracks; removing the shown one shows the spoken text again', () => {
    const p = withTrack(project(), bn)
    expect(p.captionTracks).toEqual([bn])
    const again = withTrack(p, { ...bn, model: 'n' })
    expect(again.captionTracks).toHaveLength(1)
    expect(again.captionTracks![0].model).toBe('n')
    const shown = { ...again, captions: { show: true, preset: 'clean', position: 'bottom', size: 0.05, color: '#ffffff', highlightColor: '#facc15', background: 'shadow', maxLines: 2, track: 'bn' } } as Project
    const gone = withoutTrack(shown, 'bn')
    expect(gone.captionTracks).toBeUndefined()
    expect(gone.captions?.track).toBeUndefined()
    expect(withoutTrack(project(), 'bn')).toEqual(project())
  })

  it('burnedSegments: the same array and objects without a track or bleeps', () => {
    const p = project({ captionTracks: [bn] })
    expect(burnedSegments(p)).toBe(p.transcript!.segments)
  })

  it('burnedSegments: the shown track’s text without word times; a caption without a translation keeps its spoken text', () => {
    const p = project({ captionTracks: [bn], captions: { show: true, track: 'bn' } as Project['captions'] })
    const out = burnedSegments(p)
    expect(out.map((s) => s.text)).toEqual(['নমস্কার', 'দ্বিতীয়', 'Third one'])
    expect(out[0].words).toBeUndefined()
    expect(out[0].speaker).toBe('Priya')
    expect(out[2]).toBe(segs[2])
    // Memoised on the same inputs.
    expect(burnedSegments(p)).toBe(out)
  })

  it('burnedSegments masks bleeped words in the spoken text', () => {
    const p = project({ bleeps: [{ id: 'x', start: 1.95, end: 2.85, word: 'there', sound: 'tone' }] })
    expect(burnedSegments(p)[0].text).toBe('Hello t****')
  })

  it('placeOf: a caption placed by hand, else the position', () => {
    expect(placeOf(project(), 'a', 'bottom')).toBe('bottom')
    expect(placeOf(project({ captionPlaces: [{ caption: 'a', position: 'top' }] }), 'a', 'bottom')).toBe('top')
    expect(placeOf(project({ captionPlaces: [{ caption: 'a', position: 'top' }] }), 'b', 'middle')).toBe('middle')
  })

  it('maps languages to ISO 639-2 and others to und', () => {
    expect(ISO_639_2.bn).toBe('ben')
    expect(iso6392('pt-BR')).toBe('por')
    expect(iso6392('xx')).toBe('und')
    expect(Object.keys(ISO_639_2)).toHaveLength(25)
  })

  it('cues: each spoken cue’s output times with the track’s text; all-cut captions left out, partly cut ones keep the whole translation', () => {
    // A cut from 2.5 to 7.5: caption a partly cut, b all cut, c partly cut.
    const p = project({ captionTracks: [bn], clips: [{ start: 0, end: 2.5, speed: 1 }, { start: 7.5, end: 20, speed: 1 }] as Project['clips'] })
    const cues = trackCues(p, 'bn')
    expect(cues.map((c) => c.text)).toEqual(['নমস্কার', 'Third one'])
    expect(cues[0]).toMatchObject({ start: 1, end: 2.5, speaker: 'Priya' })
    expect(cues[1].start).toBeCloseTo(2.5)
    // The spoken language gives today's cues.
    expect(trackCues(project(), 'en').map((c) => c.text)).toEqual(['Hello there', 'Second caption', 'Third one'])
  })

  it('VTT: names as "Name: " in the text (mov_text drops voice tags), or none', () => {
    const p = project({ captionTracks: [bn] })
    expect(trackVtt(p, 'bn', true)).toContain('Priya: নমস্কার')
    expect(trackVtt(p, 'bn', false)).not.toContain('Priya')
    expect(trackVtt(p, 'bn', true)).not.toContain('<v ')
    expect(trackVtt(p, 'bn', true).startsWith('WEBVTT\n')).toBe(true)
  })
})
