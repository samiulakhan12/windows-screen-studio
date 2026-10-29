import { describe, expect, it } from 'vitest'
import type { TranscriptWord } from '../src/shared/editor/transcript'
import { clickSelection, moveSelection, selectAll, selectionSpan, validWordSelection } from '../src/shared/editor/transcriptSelection'

/** Words in captions: [3, 2, 4] gives captions a (0..2), b (3..4), c (5..8). */
function words(sizes: number[]): TranscriptWord[] {
  const out: TranscriptWord[] = []
  sizes.forEach((n, c) => {
    for (let k = 0; k < n; k++) out.push({ index: out.length, caption: String.fromCharCode(97 + c), text: 'w', start: out.length, end: out.length + 0.5, estimated: false })
  })
  return out
}

describe('transcript selection', () => {
  const w = words([3, 2, 4])

  it('selects a clicked word alone, or from the anchor with Shift', () => {
    const one = clickSelection(null, 4, false)
    expect(one).toEqual({ anchor: 4, focus: 4 })
    expect(clickSelection(one, 1, true)).toEqual({ anchor: 4, focus: 1 })
    expect(selectionSpan({ anchor: 4, focus: 1 })).toEqual([1, 4])
    expect(clickSelection(null, 2, true)).toEqual({ anchor: 2, focus: 2 })
  })

  it('moves by word with the arrows and extends with Shift', () => {
    expect(moveSelection({ anchor: 2, focus: 2 }, 'ArrowRight', false, w)).toEqual({ anchor: 3, focus: 3 })
    expect(moveSelection({ anchor: 2, focus: 2 }, 'ArrowRight', true, w)).toEqual({ anchor: 2, focus: 3 })
    expect(moveSelection({ anchor: 2, focus: 0 }, 'ArrowLeft', true, w)).toEqual({ anchor: 2, focus: 0 })
    expect(moveSelection({ anchor: 8, focus: 8 }, 'ArrowRight', false, w)).toEqual({ anchor: 8, focus: 8 })
  })

  it('goes to the first or last word with Home and End', () => {
    expect(moveSelection({ anchor: 4, focus: 4 }, 'Home', false, w)).toEqual({ anchor: 0, focus: 0 })
    expect(moveSelection({ anchor: 4, focus: 4 }, 'End', true, w)).toEqual({ anchor: 4, focus: 8 })
  })

  it('moves by caption with Up and Down', () => {
    expect(moveSelection({ anchor: 1, focus: 1 }, 'ArrowDown', false, w)).toEqual({ anchor: 3, focus: 3 })
    expect(moveSelection({ anchor: 3, focus: 3 }, 'ArrowDown', false, w)).toEqual({ anchor: 5, focus: 5 })
    expect(moveSelection({ anchor: 6, focus: 6 }, 'ArrowDown', false, w)).toEqual({ anchor: 8, focus: 8 })
    // Up inside a caption goes to its first word, then to the caption before.
    expect(moveSelection({ anchor: 7, focus: 7 }, 'ArrowUp', false, w)).toEqual({ anchor: 5, focus: 5 })
    expect(moveSelection({ anchor: 5, focus: 5 }, 'ArrowUp', false, w)).toEqual({ anchor: 3, focus: 3 })
    expect(moveSelection({ anchor: 3, focus: 3 }, 'ArrowUp', true, w)).toEqual({ anchor: 3, focus: 0 })
    expect(moveSelection({ anchor: 0, focus: 0 }, 'ArrowUp', false, w)).toEqual({ anchor: 0, focus: 0 })
  })

  it('starts at an end without a selection, and gives null without words', () => {
    expect(moveSelection(null, 'ArrowRight', false, w)).toEqual({ anchor: 0, focus: 0 })
    expect(moveSelection(null, 'ArrowLeft', false, w)).toEqual({ anchor: 8, focus: 8 })
    expect(moveSelection(null, 'ArrowRight', false, [])).toBeNull()
  })

  it('selects every word, and keeps a selection inside a shorter list', () => {
    expect(selectAll(w)).toEqual({ anchor: 0, focus: 8 })
    expect(selectAll([])).toBeNull()
    const sel = { anchor: 2, focus: 7 }
    expect(validWordSelection(sel, 9)).toBe(sel)
    expect(validWordSelection(sel, 5)).toEqual({ anchor: 2, focus: 4 })
    expect(validWordSelection(sel, 0)).toBeNull()
  })
})
