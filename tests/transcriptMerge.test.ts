import { describe, expect, it } from 'vitest'
import { mergeParts } from '../src/shared/captions/transcriptMerge'
import type { RawTranscript, RawWord } from '../src/shared/captions/transcriptParse'
import { planParts } from '../src/shared/captions/transcriptPlan'

const seg = (start: number, end: number, text: string, words?: { text: string; start: number; end: number }[]): RawTranscript['segments'][number] => ({ start, end, text, ...(words ? { words } : {}) })

describe('mergeParts', () => {
  it('shifts parts cut in pauses to source seconds, with ids in time order', () => {
    const parts = planParts(20, [{ start: 9, end: 10 }], { maxSeconds: 12 })
    expect(parts.map((p) => p.start)).toEqual([0, 9.5])
    const out = mergeParts(
      [
        { part: parts[0], transcript: { language: 'en', segments: [seg(1, 3, 'one', [{ text: 'one', start: 1.2, end: 2 }]), seg(5, 8.9, 'two')] } },
        { part: parts[1], transcript: { language: 'en', segments: [seg(0.6, 2.5, 'three', [{ text: 'three', start: 0.7, end: 2.4 }]), seg(4, 10.4, 'four')] } }
      ],
      20
    )
    expect(out.language).toBe('en')
    expect(out.segments).toEqual([
      { id: 't1', start: 1, end: 3, text: 'one', words: [{ text: 'one', start: 1.2, end: 2 }] },
      { id: 't2', start: 5, end: 8.9, text: 'two' },
      { id: 't3', start: 10.1, end: 12, text: 'three', words: [{ text: 'three', start: 10.2, end: 11.9 }] },
      // Clamped to the recording.
      { id: 't4', start: 13.5, end: 19.9, text: 'four' }
    ])
  })

  it('keeps a word timed past the end of a part cut in a pause, with its punctuation', () => {
    // A pause at 300: parts 0..300 and 300..600, which share no sound.
    const parts = planParts(600, [{ start: 299.7, end: 300.3 }], { maxSeconds: 400 })
    expect(parts.map((p) => [p.start, p.keepEnd, p.end])).toEqual([
      [0, 300, 300],
      [300, 600, 600]
    ])
    const out = mergeParts(
      [
        // Part 0 times "it" after the end of what it sent (a provider's times can run late).
        {
          part: parts[0],
          transcript: {
            segments: [seg(297, 300.6, "And that's it.", [{ text: 'And', start: 297, end: 297.4 }, { text: "that's", start: 297.5, end: 298 }, { text: 'it', start: 300.1, end: 300.5 }])]
          }
        },
        { part: parts[1], transcript: { segments: [seg(1, 2, 'Next topic.', [{ text: 'Next', start: 1, end: 1.4 }, { text: 'topic.', start: 1.5, end: 2 }])] } }
      ],
      600
    )
    // Part 1 never heard "it": part 0 keeps it, so the segment stays as heard.
    expect(out.segments.map((s) => [s.text, s.start, s.end])).toEqual([
      ["And that's it.", 297, 300],
      ['Next topic.', 301, 302]
    ])
  })

  it('keeps words heard twice in an overlap once, from the part with the better view of them', () => {
    // No pauses: parts 0..10 and 8..20, cut at 9 (overlap 8..10).
    const parts = planParts(18, [], { maxSeconds: 10, overlap: 2 })
    expect(parts.map((p) => [p.start, p.keepEnd, p.end])).toEqual([
      [0, 9, 10],
      [8, 18, 18]
    ])
    const out = mergeParts(
      [
        // Part 0 hears "before" whole, "across" a little before the cut, and "after" cut off at its end.
        { part: parts[0], transcript: { segments: [seg(6, 8, 'before'), seg(8.3, 9.5, 'across'), seg(9.7, 10, 'af')] } },
        // Part 1 hears "before" cut off at its start, the same words just after the cut, and "after" whole.
        { part: parts[1], transcript: { segments: [seg(0, 0.1, 'ore'), seg(0.2, 1.9, 'across the cut'), seg(1.75, 3, 'after')] } }
      ],
      18
    )
    expect(out.segments.map((s) => [s.text, s.start, s.end])).toEqual([
      ['before', 6, 8],
      // Without word times both parts' segments are whole: the one heard farther from an edge wins.
      ['across', 8.3, 9.5],
      ['after', 9.75, 11]
    ])
    expect(out.language).toBeUndefined()
  })

  it('splits a sentence across a fixed cut by word: each word from one part, none lost or repeated', () => {
    const parts = planParts(18, [], { maxSeconds: 10, overlap: 2 })
    const out = mergeParts(
      [
        // Part 0 (sent until 10) hears the sentence's start; "the" is past the cut at 9.
        { part: parts[0], transcript: { segments: [seg(8.3, 9.7, 'Across the', [{ text: 'Across', start: 8.3, end: 8.9 }, { text: 'the', start: 9.1, end: 9.7 }])] } },
        // Part 1 (sent from 8) hears it whole; "across" is before the cut.
        {
          part: parts[1],
          transcript: { segments: [seg(0.3, 1.9, 'across the cut.', [{ text: 'across', start: 0.3, end: 0.9 }, { text: 'the', start: 1.1, end: 1.5 }, { text: 'cut.', start: 1.55, end: 1.9 }])] }
        }
      ],
      18
    )
    expect(out.segments.map((s) => [s.text, s.start, s.end])).toEqual([
      ['Across', 8.3, 8.9],
      ['the cut.', 9.1, 9.9]
    ])
    expect(out.segments[1].words?.map((w) => w.text)).toEqual(['the', 'cut.'])
  })

  it('keeps every word of a long sentence across a fixed cut exactly once', () => {
    // 1000 s without a pause: a fixed cut at 599, part 0 sent until 600 and part 1 from 598.
    const parts = planParts(1000, [], { maxSeconds: 600 })
    expect(parts.map((p) => [p.start, p.keepEnd])).toEqual([
      [0, 599],
      [598, 1000]
    ])
    // Words w590 .. w609, one a second, in a 20 s sentence that both parts hear in part.
    const words = (from: number, to: number, offset: number): { text: string; start: number; end: number }[] =>
      Array.from({ length: to - from }, (_, i) => ({ text: `w${from + i}`, start: from + i - offset, end: from + i + 0.8 - offset }))
    const out = mergeParts(
      [
        { part: parts[0], transcript: { segments: [seg(590, 600, words(590, 600, 0).map((w) => w.text).join(' '), words(590, 600, 0))] } },
        { part: parts[1], transcript: { segments: [seg(0, 12, words(598, 610, 598).map((w) => w.text).join(' '), words(598, 610, 598))] } }
      ],
      1000
    )
    expect(out.segments.map((s) => s.text).join(' ')).toBe(words(590, 610, 0).map((w) => w.text).join(' '))
    expect(out.segments.flatMap((s) => s.words!.map((w) => w.text))).toEqual(words(590, 610, 0).map((w) => w.text))
  })

  // A fixed cut at 599: part 0 sent until 600, part 1 from 598. Each times "we need an <word>
  // change now." on its own (given here in source seconds); the merged words are returned.
  const acrossCut = (first: RawWord[], second: RawWord[]): string[] => {
    const parts = planParts(1000, [], { maxSeconds: 600 })
    const segOf = (words: RawWord[], offset: number): RawTranscript['segments'][number] =>
      seg(
        words[0].start - offset,
        words[words.length - 1].end - offset,
        words.map((w) => w.text).join(' '),
        words.map((w) => ({ text: w.text, start: w.start - offset, end: w.end - offset }))
      )
    const out = mergeParts(
      [
        { part: parts[0], transcript: { segments: [segOf(first, 0)] } },
        { part: parts[1], transcript: { segments: [segOf(second, 598)] } }
      ],
      1000
    )
    const words = out.segments.flatMap((s) => s.words!.map((w) => w.text))
    expect(out.segments.map((s) => s.text).join(' ')).toBe(words.join(' '))
    return words
  }
  const w = (text: string, start: number, end: number): RawWord => ({ text, start, end })
  const before = [w('we', 596, 596.4), w('need', 596.5, 597), w('an', 597.6, 598)]

  it('keeps a word both parts hear at a fixed cut once, though they time it a little differently', () => {
    const sentence = ['we', 'need', 'an', 'important', 'change', 'now.']
    // Part 0 puts its middle before the cut and part 1 after it: kept by part 0 only.
    expect(acrossCut([...before, w('important', 598.68, 599.3), w('change', 599.4, 599.9)], [w('important', 598.72, 599.34), w('change', 599.4, 599.9), w('now.', 600, 600.5)])).toEqual(sentence)
    // The other way round: kept by part 1 only.
    expect(acrossCut([...before, w('important', 598.72, 599.34), w('change', 599.4, 599.9)], [w('important', 598.66, 599.3), w('change', 599.4, 599.9), w('now.', 600, 600.5)])).toEqual(sentence)
  })

  it('keeps a word both parts hear at a fixed cut once with whole-second times that drift', () => {
    const sentence = ['we', 'need', 'an', 'important', 'change', 'now.']
    const coarse = [w('we', 595, 596), w('need', 596, 597), w('an', 597, 598)]
    // Part 1 half a second late: "important" ends where part 0's ends, after the cut, in both.
    expect(acrossCut([...coarse, w('important', 598, 599), w('change', 599, 600)], [w('important', 598.5, 599.5), w('change', 599.5, 600.5), w('now.', 600.5, 601.5)])).toEqual(sentence)
    // Part 0 half a second late: each part puts "important"'s middle on its other side of the cut.
    expect(
      acrossCut([w('we', 595.5, 596.5), w('need', 596.5, 597.5), w('an', 597.5, 598.5), w('important', 598.5, 599.5), w('change', 599.5, 600)], [w('important', 598, 599), w('change', 599, 600), w('now.', 600, 601)])
    ).toEqual(sentence)
  })

  it("keeps a word the two parts hear differently at a fixed cut once, on the earlier part's timing", () => {
    // Part 0 keeps "important", which ends after part 1's "importance" has its middle.
    expect(acrossCut([...before, w('important', 598.68, 599.3), w('change', 599.4, 599.9)], [w('importance', 598.72, 599.34), w('change', 599.4, 599.9), w('now.', 600, 600.5)])).toEqual([
      'we',
      'need',
      'an',
      'important',
      'change',
      'now.'
    ])
    // Part 0 does not keep it: part 1's, after the last word part 0 kept, is.
    expect(acrossCut([...before, w('important', 598.72, 599.34), w('change', 599.4, 599.9)], [w('importance', 598.66, 599.3), w('change', 599.4, 599.9), w('now.', 600, 600.5)])).toEqual([
      'we',
      'need',
      'an',
      'importance',
      'change',
      'now.'
    ])
  })

  it('pairs a word the two parts time apart at a fixed cut, so it is neither repeated nor lost', () => {
    const sentence = ['we', 'need', 'an', 'important', 'change', 'now.']
    // Part 1 hears 'an' 0.1 s after part 0 did: the same word, already kept by part 0.
    expect(
      acrossCut(
        [w('we', 596, 596.4), w('need', 596.5, 597), w('an', 598.3, 598.5), w('important', 598.75, 599.35), w('change', 599.4, 599.9)],
        [w('an', 598.6, 598.8), w('important', 599.05, 599.65), w('change', 599.7, 600.2), w('now.', 600.3, 600.8)]
      )
    ).toEqual(sentence)
    // Part 1 hears 'change' 0.1 s before part 0's copy starts: part 0 did not keep it, so part 1 does.
    expect(
      acrossCut(
        [w('we', 596, 596.4), w('need', 596.5, 597), w('an', 597.6, 598), w('important', 598.67, 599.28), w('change', 599.38, 599.61)],
        [w('important', 598.5, 599.1), w('change', 599.14, 599.27), w('now.', 599.4, 599.9)]
      )
    ).toEqual(sentence)
  })

  it('trims overlapping neighbours so segments follow one another, and drops slivers', () => {
    const parts = planParts(10, [], { maxSeconds: 60 })
    const out = mergeParts([{ part: parts[0], transcript: { segments: [seg(0, 2.5, 'a', [{ text: 'a', start: 2, end: 2.5 }]), seg(2, 4, 'b'), seg(4, 4.01, 'c')] } }], 10)
    // "a" ends where "b" starts (its word after that goes); "c" is too short to show.
    expect(out.segments).toEqual([
      { id: 't1', start: 0, end: 2, text: 'a' },
      { id: 't2', start: 2, end: 4, text: 'b' }
    ])
  })
})
