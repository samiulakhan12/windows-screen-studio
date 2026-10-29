import { describe, expect, it } from 'vitest'
import { formatTimestamp, outputCues, subtitleFile, subtitleLines, toPlainText, toSrt, toVtt, validSubtitle } from '../src/shared/captions/subtitles'
import { readTranscript } from '../src/shared/captions/captionData'
import { applyTextResult, mergeWithNext, retimeWords, splitCaption, withCaptionText } from '../src/shared/captions/edit'
import { validateSegmentsAnswer, validateTextRequest } from '../src/shared/captions/transcriptText'
import { EditStore } from '../src/shared/editor/editStore'
import { applySmartSpeed, planSilences } from '../src/shared/editor/smartSpeed'
import { anchorCutWords, cutFlags, cutWords, restoreWords, settleDeletedWords, transcriptWords } from '../src/shared/editor/transcript'
import { freezePlan, NO_FREEZES } from '../src/shared/engine/freeze'
import { cutRange, removeClip, setTrimStart, splitAt } from '../src/shared/engine/timeline'
import type { CaptionSegment, Clip, Project, Transcript } from '../src/shared/types'

const clip = (start: number, end: number, speed = 1): Clip => ({ id: `${start}`, start, end, speed })
const seg = (id: string, start: number, end: number, text: string, words?: CaptionSegment['words']): CaptionSegment => ({ id, start, end, text, ...(words && { words }) })

describe('formatTimestamp', () => {
  it('writes hours, minutes, seconds and milliseconds', () => {
    expect(formatTimestamp(0, ',')).toBe('00:00:00,000')
    expect(formatTimestamp(1500, ',')).toBe('00:00:01,500')
    expect(formatTimestamp(3_723_004, '.')).toBe('01:02:03.004')
    expect(formatTimestamp(-5, '.')).toBe('00:00:00.000')
  })
})

describe('outputCues: captions in output time', () => {
  it('keeps source times without edits', () => {
    expect(outputCues([seg('a', 1, 2.5, 'Hi')], [clip(0, 10)])).toEqual([{ start: 1, end: 2.5, text: 'Hi' }])
  })

  it('drops captions inside a cut and moves later ones earlier', () => {
    const clips = [clip(0, 3), clip(5, 10)]
    const cues = outputCues([seg('a', 1, 2, 'one'), seg('b', 3.2, 4.8, 'cut'), seg('c', 6, 7, 'three')], clips)
    expect(cues.map((c) => c.text)).toEqual(['one', 'three'])
    expect(cues[1].start).toBeCloseTo(4)
    expect(cues[1].end).toBeCloseTo(5)
  })

  it('clips a caption at cut boundaries (one cue across a cut, without the cut time)', () => {
    const clips = [clip(0, 3), clip(5, 10)]
    const [c] = outputCues([seg('a', 2, 6, 'across')], clips)
    expect(c.start).toBeCloseTo(2)
    expect(c.end).toBeCloseTo(4)
    // A trim at the start: a caption that starts before it begins at 0.
    const [d] = outputCues([seg('a', 0.5, 2, 'trimmed')], [clip(1, 10)])
    expect(d.start).toBeCloseTo(0)
    expect(d.end).toBeCloseTo(1)
  })

  it('scales by the clip speed', () => {
    const clips = [clip(0, 4, 2), clip(4, 10)]
    const cues = outputCues([seg('a', 1, 3, 'fast'), seg('b', 5, 6, 'normal')], clips)
    expect(cues[0].start).toBeCloseTo(0.5)
    expect(cues[0].end).toBeCloseTo(1.5)
    expect(cues[1].start).toBeCloseTo(3)
    expect(cues[1].end).toBeCloseTo(4)
  })

  it('leaves out words that were cut when the word timings match the text', () => {
    const words = [
      { text: 'keep', start: 1, end: 1.5 },
      { text: 'gone', start: 3.2, end: 3.6 },
      { text: 'kept', start: 5.2, end: 5.6 }
    ]
    const [c] = outputCues([seg('a', 1, 6, 'keep gone kept', words)], [clip(0, 3), clip(5, 10)])
    expect(c.text).toBe('keep kept')
  })

  it('leaves out a word deleted in the Transcript tab when the text no longer matches its word timings, or has none', () => {
    const timed = [
      { text: 'So', start: 0.4, end: 0.7 },
      { text: 'um,', start: 1.1, end: 1.5 },
      { text: 'I', start: 2, end: 2.1 },
      { text: 'think', start: 2.15, end: 2.5 },
      { text: 'alot', start: 2.6, end: 3 },
      { text: 'works.', start: 3.1, end: 3.6 }
    ]
    // "alot" fixed to "a lot" in the Captions tab (7 words, 6 timings); and a provider that gave no word timings.
    for (const caption of [seg('a', 0.4, 3.8, 'So um, I think a lot works.', timed), seg('a', 0.4, 3.8, 'So um, I think a lot works.')]) {
      const transcript = { provider: 'local', model: '', createdAt: '', segments: [caption] } as Transcript
      const words = transcriptWords(transcript)
      const um = words.findIndex((w) => w.text === 'um,')
      // Deleted as the Transcript tab does it (the cut, and the estimated times stored with it).
      const clips = cutWords([clip(0, 10)], words, [[um, um]], 10)
      const segments = anchorCutWords(transcript, [clip(0, 10)], clips)!.segments
      // What the tab shows after the delete: the words of the transcript it stored.
      const shown = transcriptWords({ ...transcript, segments })
      const flags = cutFlags(shown, clips)
      expect(shown.filter((_, i) => flags[i]).map((w) => w.text)).toEqual(['um,'])
      const [c] = outputCues(segments, clips)
      expect(c.text).toBe('So I think a lot works.')
      expect(subtitleFile(segments, clips, 'srt')).not.toContain('um,')
    }
  })

  it('leaves out words with guessed times deleted in the Transcript tab, in a caption with word timings', () => {
    // "alot" fixed to "a lot" in the Captions tab: "a" and "lot" have guessed times. Both deleted in the tab.
    const caption = seg('w', 0.4, 3.8, 'So um, I think a lot works.', [
      { text: 'So', start: 0.4, end: 0.7 },
      { text: 'um,', start: 1.1, end: 1.5 },
      { text: 'I', start: 2, end: 2.1 },
      { text: 'think', start: 2.15, end: 2.5 },
      { text: 'alot', start: 2.6, end: 3 },
      { text: 'works.', start: 3.1, end: 3.6 }
    ])
    const transcript = { provider: 'local', model: '', createdAt: '', segments: [caption] } as Transcript
    const words = transcriptWords(transcript)
    const a = words.findIndex((w) => w.text === 'a')
    const clips = cutWords([clip(0, 10)], words, [[a, a + 1]], 10)
    const segments = anchorCutWords(transcript, [clip(0, 10)], clips)!.segments
    expect(outputCues(segments, clips)[0].text).toBe('So um, I think works.')
  })

  it('keeps a word deleted in the Transcript tab out after the caption without word timings is edited', () => {
    const caption = seg('g', 0.4, 3.8, 'So um, I thnk it works.')
    const transcript = { provider: 'gemini', model: '', createdAt: '', segments: [caption] } as Transcript
    const words = transcriptWords(transcript)
    const um = words.findIndex((w) => w.text === 'um,')
    const clips = cutWords([clip(0, 10)], words, [[um, um]], 10)
    const [deleted] = anchorCutWords(transcript, [clip(0, 10)], clips)!.segments
    expect(outputCues([deleted], clips)[0].text).toBe('So I thnk it works.')
    // Then, in the Captions tab: a typo fixed, the full stop taken off, the end dragged earlier.
    for (const [edited, text] of [
      [withCaptionText(deleted, 'So um, I think it works.'), 'So I think it works.'],
      [withCaptionText(deleted, 'So um, I thnk it works'), 'So I thnk it works'],
      [retimeWords(deleted, { start: 0.4, end: 3.6 }), 'So I thnk it works.']
    ] as const) {
      const after = transcriptWords({ ...transcript, segments: [edited] })
      const flags = cutFlags(after, clips)
      expect(after.filter((_, i) => flags[i]).map((w) => w.text)).toEqual(['um,'])
      expect(outputCues([edited], clips)[0].text).toBe(text)
      expect(subtitleFile([edited], clips, 'srt')).not.toContain('um,')
    }
  })

  it('keeps a word deleted in the Transcript tab out after its caption is merged or split in the Captions tab', () => {
    const full = [clip(0, 30)]
    const tabDelete = (segments: CaptionSegment[], text: string): { segments: CaptionSegment[]; clips: Clip[] } => {
      const transcript = { provider: 'gemini', model: '', createdAt: '', segments } as Transcript
      const words = transcriptWords(transcript)
      const i = words.findIndex((w) => w.text === text)
      const clips = cutWords(full, words, [[i, i]], 30)
      return { segments: anchorCutWords(transcript, full, clips)!.segments, clips }
    }
    // Captions without word timings; and one with them, "alot" fixed to "a lot" before the delete.
    const untimed = tabDelete([seg('a', 0.4, 3.8, 'So um, I think it works.'), seg('b', 4, 6, 'Let me show you.')], 'um,')
    const whisper = [
      { text: 'So', start: 0.4, end: 0.7 },
      { text: 'um,', start: 1.0, end: 1.5 },
      { text: 'I', start: 1.9, end: 2.0 },
      { text: 'think', start: 2.0, end: 2.4 },
      { text: 'alot', start: 2.5, end: 2.9 },
      { text: 'works.', start: 3.0, end: 3.6 }
    ]
    const next = seg('b', 4, 5, 'Next one.', [
      { text: 'Next', start: 4, end: 4.4 },
      { text: 'one.', start: 4.5, end: 4.9 }
    ])
    const timed = tabDelete([withCaptionText(seg('a', 0.4, 3.8, 'So um, I think alot works.', whisper), 'So um, I think a lot works.'), next], 'um,')
    const cases: [CaptionSegment[], Clip[], string[]][] = [
      [mergeWithNext(untimed.segments, 'a')!, untimed.clips, ['So I think it works. Let me show you.']],
      [splitCaption(timed.segments, 'a', 2.45)!, timed.clips, ['So I think', 'a lot works.', 'Next one.']],
      [mergeWithNext(timed.segments, 'a')!, timed.clips, ['So I think a lot works. Next one.']]
    ]
    for (const [segments, clips, cues] of cases) {
      expect(outputCues(segments, clips).map((c) => c.text)).toEqual(cues)
      const words = transcriptWords({ provider: 'gemini', model: '', createdAt: '', segments })
      const flags = cutFlags(words, clips)
      expect(words.filter((_, i) => flags[i]).map((w) => w.text)).toEqual(['um,'])
    }
  })

  it('keeps a word deleted in the Transcript tab out after Fix captions changes the number of words', () => {
    const full = [clip(0, 30)]
    const whisper = [
      { text: 'So', start: 0.4, end: 0.7 },
      { text: 'um,', start: 1.0, end: 1.5 },
      { text: 'I', start: 1.9, end: 2.0 },
      { text: 'think', start: 2.0, end: 2.4 },
      { text: 'alot', start: 2.5, end: 2.9 },
      { text: 'works.', start: 3.0, end: 3.6 }
    ]
    // With word timings, and without (every time a guess).
    for (const caption of [seg('a', 0.4, 3.8, 'So um, I think alot works.', whisper), seg('a', 0.4, 3.8, 'So um, I think alot works.')]) {
      const transcript = { provider: 'local', model: '', createdAt: '', segments: [caption] } as Transcript
      const words = transcriptWords(transcript)
      const um = words.findIndex((w) => w.text === 'um,')
      const clips = cutWords(full, words, [[um, um]], 30)
      const deleted = anchorCutWords(transcript, full, clips)!.segments
      // The clean-up as it goes: the request checked in the main process, the answer checked there, then applied here.
      const request = validateTextRequest({ task: 'cleanup', segments: deleted })
      const answer = validateSegmentsAnswer('cleanup', request.segments, { segments: [{ id: 'a', text: 'So, um, I think a lot works.' }] })
      const fixed = applyTextResult(deleted, answer)!
      expect(outputCues(fixed, clips)[0].text).toBe('So, I think a lot works.')
    }
  })

  it('keeps every word of a caption without word timings across a timeline cut or trim (a guess never drops a heard word)', () => {
    // A pause cut by Smart speed > Silences, a trim at the start, and an untimed translation (CAP-6).
    const cases: [CaptionSegment, Clip[]][] = [
      [seg('a', 10, 17, 'Now open the settings and pick a folder for your recordings'), [clip(0, 11.85), clip(13.75, 20)]],
      [seg('b', 0, 5, 'Hi everyone, welcome back to the channel'), [clip(2, 10)]],
      [seg('c', 0, 3, 'el coche rojo es muy rápido'), [clip(0, 0.9), clip(1.8, 10)]]
    ]
    for (const [caption, clips] of cases) expect(outputCues([caption], clips)[0].text).toBe(caption.text)
  })

  it('keeps the guessed words of a caption without word timings across a timeline cut after one was deleted in the Transcript tab', () => {
    const transcript = { provider: 'gemini', model: '', createdAt: '', segments: [seg('g', 10, 17, 'Now open the settings and pick a folder for your recordings')] } as Transcript
    const full = [clip(0, 30)]
    const tabDelete = (clips: Clip[], text: string): { segments: CaptionSegment[]; clips: Clip[] } => {
      const words = transcriptWords(transcript)
      const i = words.findIndex((w) => w.text === text)
      const cut = cutWords(clips, words, [[i, i]], 30)
      return { segments: anchorCutWords(transcript, clips, cut)!.segments, clips: cut }
    }
    // Smart speed > Silences cuts the pause at 11.85-13.75 s, where the guesses put "settings and pick a".
    const silences = (clips: Clip[]): Clip[] => cutRange(clips, 11.85, 13.75)
    const deleted = tabDelete(full, 'Now')
    // "Now" deleted, then the pause cut; the pause cut, then "Now" deleted.
    for (const { segments, clips } of [{ ...deleted, clips: silences(deleted.clips) }, tabDelete(silences(full), 'Now')]) {
      expect(outputCues(segments, clips)[0].text).toBe('open the settings and pick a folder for your recordings')
      // Also after the project is saved and opened again.
      const reopened = readTranscript(JSON.parse(JSON.stringify({ ...transcript, segments })), 30)!
      expect(outputCues(reopened.segments, clips)[0].text).toBe('open the settings and pick a folder for your recordings')
    }
  })

  it('never overlaps and drops slivers', () => {
    const cues = outputCues([seg('a', 1, 2.02, 'a'), seg('b', 2, 3, 'b'), seg('c', 4.99, 5.02, 'tiny')], [clip(0, 5)])
    expect(cues.map((c) => c.text)).toEqual(['a', 'b'])
    expect(cues[0].end).toBeLessThanOrEqual(cues[1].start)
  })
})

describe('deleted words: the Transcript tab and the subtitle files agree (edit-by-text.md §4.2)', () => {
  const DURATION = 30
  /** An open editor's store, with the editor's own settle. */
  const open = (segments: CaptionSegment[], provider: Transcript['provider'] = 'gemini'): EditStore<Project> =>
    new EditStore({ duration: DURATION, clips: [clip(0, DURATION)], transcript: { provider, model: '', createdAt: '', segments } } as unknown as Project, undefined, undefined, undefined, settleDeletedWords)
  const wordsOf = (p: Project) => transcriptWords(p.transcript)
  /** The words the tab strikes through. */
  const struck = (p: Project): string[] => {
    const w = wordsOf(p)
    const f = cutFlags(w, p.clips)
    return w.filter((_, i) => f[i]).map((x) => x.text)
  }
  /** The cues of the subtitle file; checked against the tab: it holds exactly the words not struck through. */
  const srt = (p: Project): string[] => {
    const cues = outputCues(p.transcript!.segments, p.clips).map((c) => c.text)
    const w = wordsOf(p)
    const f = cutFlags(w, p.clips)
    expect(cues.join(' ').split(' ').filter(Boolean)).toEqual(w.filter((_, i) => !f[i]).map((x) => x.text))
    const file = subtitleFile(p.transcript!.segments, p.clips, 'srt').replace(/\n/g, ' ')
    for (const cue of cues) expect(file).toContain(cue)
    return cues
  }
  const marked = (p: Project): string[] => wordsOf(p).filter((w) => w.deleted).map((w) => w.text)
  const at = (p: Project, text: string): number => {
    const i = wordsOf(p).findIndex((w) => w.text === text)
    expect(i).toBeGreaterThanOrEqual(0)
    return i
  }
  const same = (a: Clip[], b: Clip[]): boolean => a.length === b.length && a.every((c, i) => c.start === b[i].start && c.end === b[i].end && c.speed === b[i].speed)
  /** Delete in the Transcript tab on words `from..to` (TranscriptPanel's cut): the cut and the marks in one update. */
  const tabDelete = (s: EditStore<Project>, from: string, to = from): void => {
    const w = wordsOf(s.state)
    const span = [at(s.state, from), at(s.state, to)] as const
    s.update((p) => {
      const cut = cutWords(p.clips, w, [span], p.duration)
      return { ...p, clips: same(cut, p.clips) ? p.clips : cut, transcript: anchorCutWords(p.transcript, p.clips, cut, [span]) }
    })
  }
  /** Restore in the Transcript tab (the clips only; the store's settle takes the mark off). */
  const tabRestore = (s: EditStore<Project>, text: string): void => {
    const w = wordsOf(s.state)
    const i = at(s.state, text)
    s.update((p) => ({ ...p, clips: restoreWords(p.clips, w, i, i, p.duration) }))
  }
  const restoreAll = (s: EditStore<Project>): void => s.update((p) => ({ ...p, clips: [{ ...p.clips[0], start: 0, end: p.duration, speed: 1 }] }))
  const timelineCut = (s: EditStore<Project>, from: number, to: number): void => s.update((p) => ({ ...p, clips: cutRange(p.clips, from, to) }))
  /** Clip tab > Smart speed > Silences, Cut, defaults: with speech at 10-11.6 s and 14-17 s it cuts the pause at 11.85-13.75 s. */
  const silences = (s: EditStore<Project>): void =>
    s.update((p) => {
      const heard = [{ start: 0.5, end: 9.5 }, { start: 10, end: 11.6 }, { start: 14, end: 17 }, { start: 18, end: 29 }]
      const plan = planSilences(heard, p.clips, { minLength: 1, padding: 0.25 }, 'cut')
      return { ...p, clips: applySmartSpeed(p.clips, plan.parts.flatMap((part) => part.pieces), 'cut') }
    })
  const editCaptions = (s: EditStore<Project>, fn: (segments: CaptionSegment[]) => CaptionSegment[]): void =>
    s.update((p) => ({ ...p, transcript: { ...p.transcript!, segments: fn(p.transcript!.segments) } }))

  const SENTENCE = 'Now open the settings and pick a folder for your recordings'
  const gemini = (): CaptionSegment => seg('g', 10, 17, SENTENCE)
  const whisperWords = (): NonNullable<CaptionSegment['words']> => [
    { text: 'So', start: 0.4, end: 0.7 },
    { text: 'um,', start: 1.0, end: 1.5 },
    { text: 'I', start: 1.9, end: 2.0 },
    { text: 'think', start: 2.0, end: 2.4 },
    { text: 'alot', start: 2.5, end: 2.9 },
    { text: 'works.', start: 3.0, end: 3.6 }
  ]

  it('R1: a word deleted then brought back (Restore, Restore the whole recording, the timeline) is a guess again, which a Silences cut leaves in', () => {
    const restores: ((s: EditStore<Project>) => void)[] = [(s) => tabRestore(s, 'settings'), restoreAll, (s) => s.update((p) => ({ ...p, clips: [clip(0, DURATION)] }))]
    for (const restore of restores) {
      const s = open([gemini()])
      tabDelete(s, 'settings')
      expect(struck(s.state)).toEqual(['settings'])
      expect(srt(s.state)).toEqual(['Now open the and pick a folder for your recordings'])
      const deleted = s.state
      restore(s)
      expect(marked(s.state)).toEqual([])
      expect(srt(s.state)).toEqual([SENTENCE])
      // Undo brings back the cut and the mark together (one step); redo takes both off again.
      s.undo()
      expect(s.state).toBe(deleted)
      s.redo()
      expect(marked(s.state)).toEqual([])
      silences(s)
      expect(struck(s.state)).toEqual([])
      expect(srt(s.state)).toEqual([SENTENCE])
    }
  })

  it('R2: after a Silences cut, words deleted in the tab are marked though their guessed times were already cut', () => {
    const s = open([gemini()])
    silences(s)
    expect(struck(s.state)).toEqual([])
    expect(srt(s.state)).toEqual([SENTENCE])
    tabDelete(s, 'the', 'settings')
    expect(marked(s.state)).toEqual(['the', 'settings'])
    expect(struck(s.state)).toEqual(['the', 'settings'])
    expect(srt(s.state)).toEqual(['Now open and pick a folder for your recordings'])
    // A word wholly inside the Silences cut: no clip changes, the word is marked and goes.
    const clips = s.state.clips
    tabDelete(s, 'pick')
    expect(s.state.clips).toBe(clips)
    expect(struck(s.state)).toEqual(['the', 'settings', 'pick'])
    expect(srt(s.state)).toEqual(['Now open and a folder for your recordings'])
    // The other order: deleted first, then the Silences cut.
    const t = open([gemini()])
    tabDelete(t, 'the', 'settings')
    silences(t)
    expect(srt(t.state)).toEqual(['Now open and pick a folder for your recordings'])
  })

  it('R3: an edited Whisper caption drops the guessed words between cut neighbours, and keeps them while a neighbour plays', () => {
    const edited = (): EditStore<Project> => open([withCaptionText(seg('w', 0.4, 3.8, 'So I think alot works.', whisperWords().filter((w) => w.text !== 'um,')), 'So I think a lot works.')], 'openai')
    let s = edited()
    timelineCut(s, 1.8, 3.7)
    expect(struck(s.state)).toEqual(['I', 'think', 'a', 'lot', 'works.'])
    expect(srt(s.state)).toEqual(['So'])
    s = edited()
    timelineCut(s, 2.45, 2.95)
    expect(struck(s.state)).toEqual([])
    expect(srt(s.state)).toEqual(['So I think a lot works.'])
    // Not edited: the provider's times only.
    s = open([seg('w', 0.4, 3.8, 'So I think alot works.', whisperWords().filter((w) => w.text !== 'um,'))], 'openai')
    timelineCut(s, 1.8, 3.7)
    expect(srt(s.state)).toEqual(['So'])
  })

  it('a caption cut away up to its very end, or to a sliver shorter than a cue, is struck through whole and left out', () => {
    const next = (): CaptionSegment => seg('n', 17, 20, 'Then press Start.')
    const edits: ((s: EditStore<Project>) => void)[] = [
      // A range cut on the clip track, snapped to the caption's edges or from before it.
      (s) => timelineCut(s, 10, 17),
      (s) => timelineCut(s, 9, 17),
      // The start trim dragged to the caption's end (it snaps there).
      (s) => s.update((p) => ({ ...p, clips: setTrimStart(p.clips, 17) })),
      // Split at the caption's start and end, the clip between removed.
      (s) => {
        s.update((p) => ({ ...p, clips: splitAt(splitAt(p.clips, 10), 17) }))
        s.update((p) => ({ ...p, clips: removeClip(p.clips, p.clips[1].id) }))
      },
      // The end of the sentence deleted in the tab (its cut ends where the next caption starts), then the rest cut on the timeline.
      (s) => {
        tabDelete(s, 'and', 'recordings')
        expect(s.state.clips.at(-1)!.start).toBe(17)
        timelineCut(s, 9.5, 12.6)
      },
      // 0.03 s of it left.
      (s) => timelineCut(s, 10, 16.97)
    ]
    for (const edit of edits) {
      const s = open([gemini(), next()])
      edit(s)
      expect(struck(s.state)).toEqual(SENTENCE.split(' '))
      expect(srt(s.state)).toEqual(['Then press Start.'])
    }
    // 0.1 s left: the cue and its guesses stay.
    const s = open([gemini(), next()])
    timelineCut(s, 9, 16.9)
    expect(struck(s.state)).toEqual([])
    expect(srt(s.state)).toEqual([SENTENCE, 'Then press Start.'])
    // Heard words: 0.045 s left of the words, more of the caption after them.
    const t = open([seg('y', 0.4, 1.5, 'Yes works.', [{ text: 'Yes', start: 0.4, end: 0.7 }, { text: 'works.', start: 0.9, end: 0.98 }]), next()], 'openai')
    t.update((p) => ({ ...p, clips: [clip(0.935, DURATION)] }))
    expect(struck(t.state)).toEqual(['Yes', 'works.'])
    expect(srt(t.state)).toEqual(['Then press Start.'])
  })

  it('a deleted word stays out after its caption is edited: words that no longer match their timings, or none, a typo, a full stop, the end dragged', () => {
    for (const caption of [withCaptionText(seg('a', 0.4, 3.8, 'So um, I think alot works.', whisperWords()), 'So um, I think a lot works.'), seg('a', 0.4, 3.8, 'So um, I think a lot works.')]) {
      const s = open([caption])
      tabDelete(s, 'um,')
      expect(struck(s.state)).toEqual(['um,'])
      expect(srt(s.state)).toEqual(['So I think a lot works.'])
    }
    for (const [edit, text] of [
      [(c: CaptionSegment) => withCaptionText(c, 'So um, I think it works.'), 'So I think it works.'],
      [(c: CaptionSegment) => withCaptionText(c, 'So um, I thnk it works'), 'So I thnk it works'],
      [(c: CaptionSegment) => retimeWords(c, { start: 0.4, end: 3.6 }), 'So I thnk it works.']
    ] as const) {
      const s = open([seg('g', 0.4, 3.8, 'So um, I thnk it works.')])
      tabDelete(s, 'um,')
      editCaptions(s, ([c]) => [edit(c)])
      expect(marked(s.state)).toEqual(['um,'])
      expect(struck(s.state)).toEqual(['um,'])
      expect(srt(s.state)).toEqual([text])
    }
  })

  it('a heard word with a guessed time stays in after a timeline cut, a trim or in a translation', () => {
    const cases: [CaptionSegment, (s: EditStore<Project>) => void][] = [
      [gemini(), silences],
      [seg('b', 0, 5, 'Hi everyone, welcome back to the channel'), (s) => s.update((p) => ({ ...p, clips: [clip(2, DURATION)] }))],
      [seg('c', 0, 3, 'el coche rojo es muy rápido'), (s) => timelineCut(s, 0.9, 1.8)]
    ]
    for (const [caption, edit] of cases) {
      const s = open([caption])
      edit(s)
      expect(struck(s.state)).toEqual([])
      expect(srt(s.state)).toEqual([caption.text])
    }
  })

  it('a word deleted before or after a Silences cut keeps the guesses around it in, also after a save', () => {
    for (const silencesFirst of [false, true]) {
      const s = open([gemini()])
      if (silencesFirst) silences(s)
      tabDelete(s, 'Now')
      if (!silencesFirst) silences(s)
      expect(struck(s.state)).toEqual(['Now'])
      expect(srt(s.state)).toEqual(['open the settings and pick a folder for your recordings'])
      const reopened = { ...s.state, transcript: readTranscript(JSON.parse(JSON.stringify(s.state.transcript)), DURATION) }
      expect(marked(reopened)).toEqual(['Now'])
      expect(srt(reopened)).toEqual(['open the settings and pick a folder for your recordings'])
    }
  })

  it('Merge, Split and Fix captions keep the deleted words with their marks', () => {
    // Captions without word timings: "um," deleted, then the first merged with the next.
    let s = open([seg('a', 0.4, 3.8, 'So um, I think it works.'), seg('b', 4, 6, 'Let me show you.')])
    tabDelete(s, 'um,')
    editCaptions(s, (list) => mergeWithNext(list, 'a')!)
    expect(marked(s.state)).toEqual(['um,'])
    expect(struck(s.state)).toEqual(['um,'])
    expect(srt(s.state)).toEqual(['So I think it works. Let me show you.'])
    // A Whisper caption, "alot" fixed to "a lot" and then "a" deleted: split, or merged with a timed caption.
    const next = seg('n', 4, 5, 'Next one.', [
      { text: 'Next', start: 4, end: 4.4 },
      { text: 'one.', start: 4.5, end: 4.9 }
    ])
    for (const [edit, cues] of [
      [(list: CaptionSegment[]) => splitCaption(list, 'a', 2.45)!, ['So um, I think', 'lot works.', 'Next one.']],
      [(list: CaptionSegment[]) => mergeWithNext(list, 'a')!, ['So um, I think lot works. Next one.']]
    ] as const) {
      s = open([withCaptionText(seg('a', 0.4, 3.8, 'So um, I think alot works.', whisperWords()), 'So um, I think a lot works.'), next], 'openai')
      tabDelete(s, 'a')
      expect(marked(s.state)).toEqual(['a'])
      editCaptions(s, edit)
      expect(marked(s.state)).toEqual(['a'])
      expect(struck(s.state)).toEqual(['a'])
      expect(srt(s.state)).toEqual(cues)
    }
    // Fix captions, which here changes the number of words: the request and the answer checked as in the app.
    s = open([seg('a', 0.4, 3.8, 'So um, I think alot works.')], 'gemini')
    tabDelete(s, 'um,')
    const before = s.state.transcript!.segments
    const request = validateTextRequest({ task: 'cleanup', segments: before })
    const answer = validateSegmentsAnswer('cleanup', request.segments, { segments: [{ id: 'a', text: 'So, um, I think a lot works.' }] })
    editCaptions(s, () => applyTextResult(before, answer)!)
    expect(marked(s.state)).toEqual(['um,'])
    expect(srt(s.state)).toEqual(['So, I think a lot works.'])
  })
})

describe('subtitle files', () => {
  const cues = [
    { start: 1, end: 2.5, text: 'Hello <world> & you --> there' },
    { start: 3, end: 4.0004, text: 'Second line' }
  ]

  it('writes SRT', () => {
    expect(toSrt(cues)).toBe('1\n00:00:01,000 --> 00:00:02,500\nHello <world> & you -> there\n\n2\n00:00:03,000 --> 00:00:04,000\nSecond line\n')
    expect(validSubtitle('srt', toSrt(cues))).toBe(true)
  })

  it('writes WebVTT with its header and escapes markup', () => {
    expect(toVtt(cues)).toBe('WEBVTT\n\n00:00:01.000 --> 00:00:02.500\nHello &lt;world&gt; &amp; you -&gt; there\n\n00:00:03.000 --> 00:00:04.000\nSecond line\n')
    expect(validSubtitle('vtt', toVtt(cues))).toBe(true)
  })

  it('writes plain text, one caption per line', () => {
    expect(toPlainText(cues)).toBe('Hello <world> & you --> there\nSecond line\n')
    expect(toPlainText([])).toBe('')
  })

  it('breaks long cue text into lines of at most 42 characters', () => {
    const long = 'This is a fairly long caption that will not fit on a single subtitle line at all'
    const lines = subtitleLines(long)
    expect(lines.length).toBeGreaterThan(1)
    for (const l of lines) expect(l.length).toBeLessThanOrEqual(42)
    expect(lines.join(' ')).toBe(long)
  })

  it('makes the file in output time after a cut', () => {
    const srt = subtitleFile([seg('a', 1, 2, 'one'), seg('b', 6, 7, 'two')], [clip(0, 3), clip(5, 10)], 'srt')
    expect(srt).toContain('2\n00:00:04,000 --> 00:00:05,000\ntwo\n')
  })

  it('stretches a caption across a pause freeze; one starting at it shows through it, one ending at it ends before (E-11)', () => {
    const clips = [clip(0, 10)]
    const plan = freezePlan(clips, [{ id: 'f', at: 2, length: 3, sound: 'pause' }])
    const file = (s: CaptionSegment): string => subtitleFile([s], clips, 'srt', plan)
    expect(file(seg('a', 1, 3, 'across'))).toContain('00:00:01,000 --> 00:00:06,000')
    expect(file(seg('a', 2, 2.5, 'at'))).toContain('00:00:02,000 --> 00:00:05,500')
    expect(file(seg('a', 1, 2, 'before'))).toContain('00:00:01,000 --> 00:00:02,000')
    const segments = [seg('a', 1, 2, 'one'), seg('b', 6, 7, 'two')]
    for (const f of ['srt', 'vtt', 'txt'] as const) {
      expect(subtitleFile(segments, [clip(0, 3), clip(5, 10)], f, NO_FREEZES)).toBe(subtitleFile(segments, [clip(0, 3), clip(5, 10)], f))
    }
  })

  it('leaves out empty captions (an emptied caption brought back by Undo; CAP-7)', () => {
    const words = [{ text: 'gone', start: 0, end: 1 }]
    const segments = [seg('a', 0, 2, '', words), seg('b', 2, 4, 'second'), seg('c', 4, 5, '  ')]
    expect(subtitleFile(segments, [clip(0, 10)], 'srt')).toBe('1\n00:00:02,000 --> 00:00:04,000\nsecond\n')
    expect(subtitleFile(segments, [clip(0, 10)], 'vtt')).toBe('WEBVTT\n\n00:00:02.000 --> 00:00:04.000\nsecond\n')
    expect(subtitleFile(segments, [clip(0, 10)], 'txt')).toBe('second\n')
  })

  it('validates content before it is written', () => {
    expect(validSubtitle('srt', '')).toBe(true)
    expect(validSubtitle('srt', 'hello')).toBe(false)
    expect(validSubtitle('vtt', '1\n00:00')).toBe(false)
    expect(validSubtitle('txt', 'a\u0000b')).toBe(false)
    expect(validSubtitle('exe', 'x')).toBe(false)
    expect(validSubtitle('txt', 42)).toBe(false)
  })
})
