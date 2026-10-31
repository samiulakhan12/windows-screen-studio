/**
 * Captions Studio test 39 (docs/design/captions-studio.md §11.5): lists from the captions, items
 * trimmed, two items at least. (listWindows is part P1's, tested there.)
 */
import { describe, expect, it, vi } from 'vitest'
import { findLists } from '../src/shared/captions/lists'
import type { CaptionSegment } from '../src/shared/types'

vi.mock('../src/shared/captions/words', async (o) => (await import('./p1Fillins')).fillWords(await o()))

let n = 0
const seg = (start: number, text: string): CaptionSegment => ({ id: `c${++n}`, start, end: start + 3, text })

describe('findLists (test 39)', () => {
  it('finds the three-step example with trimmed items', () => {
    const segs = [
      seg(0, 'Exporting takes three steps.'),
      seg(4, 'First, open the Settings page and pick a preset.'),
      seg(8, 'Second, choose the format you want.'),
      seg(12, 'Finally, click the Export button.')
    ]
    const [list] = findLists(segs, 'en')
    expect(list.caption).toBe(segs[0].id)
    expect(list.title).toBe('Three steps')
    expect(list.items.map((i) => i.text)).toEqual(['Open the Settings page', 'Choose the format you want', 'Click the Export button'])
    // Each item shows from its marker word.
    expect(list.items[0].at).toBe(4)
    expect(list.items[1].at).toBe(8)
  })

  it('needs two items, in order, within 120 s of the announcement', () => {
    expect(findLists([seg(0, 'Here are two tips.'), seg(4, 'First, save often.')], 'en')).toEqual([])
    expect(findLists([seg(0, 'Here are two tips.'), seg(4, 'Second, save often.'), seg(8, 'First, be calm.')], 'en')).toEqual([])
    expect(findLists([seg(0, 'Here are two tips.'), seg(4, 'First, save often.'), seg(200, 'Second, be calm.')], 'en')).toEqual([])
    expect(findLists([seg(0, 'Here are two tips.'), seg(4, 'First, save often.'), seg(9, 'Second, be calm.')], 'en')).toHaveLength(1)
  })

  it('reads "step N" markers, digits and "A, B and C" in one caption', () => {
    const steps = findLists([seg(0, 'Follow these 3 steps.'), seg(4, 'Step 1, open Flown.'), seg(8, 'Step 2, record your screen.')], 'en')
    expect(steps[0].items.map((i) => i.text)).toEqual(['Open Flown', 'Record your screen'])
    const inline = findLists([seg(0, 'There are three ways: speed, quality and price.')], 'en')
    expect(inline[0].items.map((i) => i.text)).toEqual(['Speed', 'Quality', 'Price'])
  })

  it('reads Bangla markers', () => {
    const segs = [seg(0, 'এখানে তিনটি ধাপ আছে।'), seg(4, 'প্রথমত, সেটিংস খুলুন।'), seg(8, 'দ্বিতীয়ত, ফরম্যাট বাছুন।')]
    const [list] = findLists(segs, 'bn')
    expect(list.items.map((i) => i.text)).toEqual(['সেটিংস খুলুন', 'ফরম্যাট বাছুন'])
  })

  it('a count without a list noun is no announcement', () => {
    expect(findLists([seg(0, 'I have three cats.'), seg(4, 'First, Tom.'), seg(8, 'Second, Kit.')], 'en')).toEqual([])
  })
})
