/**
 * Captions Studio test 47 (docs/design/captions-studio.md §11.9, §11.10): translated tracks, the
 * burned-in captions, cues of partly cut captions, the ISO map and names in VTT.
 */
import { describe, expect, it } from 'vitest'
import {
  burnedSegments,
  burnedTrackNote,
  captionsToTranslate,
  defaultExportLanguages,
  exportLanguages,
  iso6392,
  ISO_639_2,
  languageName,
  languagesToAdd,
  missingTranslations,
  outOfDate,
  placeOf,
  textHash,
  tickedExportLanguages,
  TRACK_LANGUAGES,
  trackRows,
  withoutTrack,
  withShownTrack,
  withTrack,
  withTranslation
} from '../src/shared/captions/captionTracks'
import { DEFAULT_CAPTIONS } from '../src/shared/captions/settings'
import { readCaptionTracks } from '../src/shared/captions/studioData'
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

describe('translating into a track with an AI provider (§11.9, §2.10)', () => {
  const answer = (sent: readonly CaptionSegment[], texts: string[]): CaptionSegment[] => sent.map((s, i) => ({ id: s.id, start: s.start, end: s.end, text: texts[i] }))
  const base = { by: 'gemini' as const, model: 'gemini-x', createdAt: '2026-10-31T00:00:00Z' }

  it('a new track gets every caption, with the hash of the text it was made from; the captions keep their text', () => {
    const p = project()
    const sent = captionsToTranslate(p, 'bn')
    expect(sent.map((s) => s.id)).toEqual(['a', 'b', 'c'])
    const next = withTranslation(p, { ...base, language: 'bn', sent, answer: answer(sent, ['এক', 'দুই', 'তিন']) })!
    expect(next.transcript).toBe(p.transcript)
    expect(next.captionTracks).toEqual([{ language: 'bn', ...base, segments: [{ id: 'a', text: 'এক', src: textHash('Hello there') }, { id: 'b', text: 'দুই', src: textHash('Second caption') }, { id: 'c', text: 'তিন', src: textHash('Third one') }] }])
    expect(outOfDate(next, 'bn')).toEqual([])
  })

  it('Translate again sends only changed and missing captions and keeps the rest', () => {
    const p = project({ captionTracks: [bn] })
    const sent = captionsToTranslate(p, 'bn')
    expect(sent.map((s) => s.id)).toEqual(['b', 'c'])
    const next = withTranslation(p, { ...base, language: 'bn', sent, answer: answer(sent, ['দ্বিতীয় নতুন', 'তৃতীয়']) })!
    expect(next.captionTracks![0].segments.map((s) => s.text)).toEqual(['নমস্কার', 'দ্বিতীয় নতুন', 'তৃতীয়'])
    expect(outOfDate(next, 'bn')).toEqual([])
  })

  it('a caption edited while the provider worked stays out of date', () => {
    const p = project({ captionTracks: [bn] })
    const sent = captionsToTranslate(p, 'bn')
    const edited = { ...p, transcript: { ...p.transcript!, segments: p.transcript!.segments.map((s) => (s.id === 'b' ? { ...s, text: 'Edited meanwhile' } : s)) } }
    const next = withTranslation(edited, { ...base, language: 'bn', sent, answer: answer(sent, ['দ্বিতীয় নতুন', 'তৃতীয়']) })!
    expect(next.captionTracks![0].segments.find((s) => s.id === 'b')?.text).toBe('দ্বিতীয়')
    expect(outOfDate(next, 'bn')).toEqual(['b'])
  })

  it('an answer that changed the timing or left captions out is not used; nor is the spoken language', () => {
    const p = project()
    const sent = captionsToTranslate(p, 'bn')
    expect(withTranslation(p, { ...base, language: 'bn', sent, answer: answer(sent, ['এক', 'দুই', 'তিন']).slice(1) })).toBeNull()
    expect(withTranslation(p, { ...base, language: 'bn', sent, answer: answer(sent, ['এক', 'দুই', 'তিন']).map((s) => ({ ...s, start: s.start + 1 })) })).toBeNull()
    expect(withTranslation(p, { ...base, language: 'EN', sent, answer: answer(sent, ['a', 'b', 'c']) })).toBeNull()
  })

  it('reads back unchanged through the project reader', () => {
    const p = project()
    const sent = captionsToTranslate(p, 'bn')
    const next = withTranslation(p, { ...base, language: 'bn', sent, answer: answer(sent, ['এক', 'দুই', 'তিন']) })!
    expect(readCaptionTracks(JSON.parse(JSON.stringify(next.captionTracks)), next.transcript)).toEqual(next.captionTracks)
  })

  it('the shown track: one value, cleared when the spoken captions are chosen or the track is unknown', () => {
    const p = project({ captionTracks: [bn], captions: { ...DEFAULT_CAPTIONS, show: true } })
    const shown = withShownTrack(p, 'bn')
    expect(shown.captions?.track).toBe('bn')
    expect(withShownTrack(shown, 'bn')).toBe(shown)
    expect(withShownTrack(shown, null).captions).toEqual({ ...DEFAULT_CAPTIONS, show: true })
    expect(withShownTrack(p, 'hi')).toBe(p)
  })

  it('offers the caption languages without the spoken one and those with a track; names them', () => {
    const offered = languagesToAdd(project({ captionTracks: [bn] })).map((l) => l.code)
    expect(offered).toHaveLength(23)
    expect(offered).not.toContain('en')
    expect(offered).not.toContain('bn')
    expect(TRACK_LANGUAGES.map((l) => l.code).sort()).toEqual(Object.keys(ISO_639_2).sort())
    expect(languageName('bn-BD')).toBe('Bengali')
    expect(languageName('xx')).toBe('xx')
  })
})

describe('the Languages rows and the export languages (§2.10, §2.13)', () => {
  it('lists the spoken captions first, then each track with what is out of date or missing', () => {
    const p = project({ captionTracks: [bn], captions: { ...DEFAULT_CAPTIONS, track: 'bn' } })
    expect(trackRows(p)).toEqual([
      { language: null, label: 'English · spoken', changed: 0, missing: 0, shown: false, notes: [] },
      { language: 'bn', label: 'Bengali · translated with Gemini', changed: 1, missing: 1, shown: true, notes: ['1 caption changed since', '1 caption is not translated: it shows in English'] }
    ])
    const local: CaptionTrack = { ...bn, language: 'hi', by: 'local', segments: [] }
    const rows = trackRows(project({ captionTracks: [local], bleeps: [{ id: 'x', start: 1, end: 1.5, word: 'damn', sound: 'tone' }] }))
    expect(rows[0].shown).toBe(true)
    expect(rows[1]).toMatchObject({ label: 'Hindi · translated on this PC', changed: 0, missing: 3, notes: ['3 captions are not translated: they show in English', 'Bleeped words are not masked in translations'] })
  })

  it('the export notes captions the burned-in track lacks, and ticks the spoken and burned-in languages', () => {
    const p = project({ captionTracks: [bn], captions: { ...DEFAULT_CAPTIONS, show: true, track: 'bn' } })
    expect(burnedTrackNote(p)).toBe('1 caption is not translated into Bengali: it shows in English.')
    expect(burnedTrackNote(project({ captionTracks: [bn] }))).toBeNull()
    expect(exportLanguages(p)).toEqual([
      { code: 'en', name: 'English', spoken: true },
      { code: 'bn', name: 'Bengali', spoken: false }
    ])
    expect(defaultExportLanguages(p)).toEqual(['en', 'bn'])
    expect(defaultExportLanguages(project({ captionTracks: [bn] }))).toEqual(['en'])
    expect(defaultExportLanguages(project({ captionTracks: [bn], captions: { ...DEFAULT_CAPTIONS, show: false, track: 'bn' } }))).toEqual(['en'])
  })
})

describe("the export's ticked languages (§2.13)", () => {
  it('the choice made, in the export order, else the defaults; never a language the project lacks; never none', () => {
    const p = project({ captionTracks: [bn, { ...bn, language: 'hi' }], captions: { ...DEFAULT_CAPTIONS, show: true, track: 'bn' } })
    expect(tickedExportLanguages(p, undefined)).toEqual(['en', 'bn'])
    expect(tickedExportLanguages(p, ['hi', 'en'])).toEqual(['en', 'hi'])
    expect(tickedExportLanguages(p, ['fr'])).toEqual(['en'])
    expect(tickedExportLanguages(project(), ['bn'])).toEqual(['en'])
  })
})
