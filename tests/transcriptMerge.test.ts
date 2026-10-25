import { describe, expect, it } from 'vitest'
import { mergeParts } from '../src/shared/captions/transcriptMerge'
import type { RawTranscript } from '../src/shared/captions/transcriptParse'
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
      // Both parts heard it; part 0 heard it farther from the edge of its sound.
      ['across', 8.3, 9.5],
      ['after', 9.75, 11]
    ])
    expect(out.language).toBeUndefined()
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
