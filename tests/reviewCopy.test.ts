import { describe, expect, it } from 'vitest'
import { actedMessage, bulkMessage, buttonLabel, itemAccessibleName, KIND_WORDS, placeOf, progressText, REVIEW_KINDS } from '../src/shared/review/copy'

describe('review copy', () => {
  it('places points in thirds of the frame', () => {
    expect([placeOf(0.1, 0.1), placeOf(0.5, 0.1), placeOf(0.9, 0.1), placeOf(0.1, 0.5), placeOf(0.5, 0.5), placeOf(0.9, 0.5), placeOf(0.1, 0.9), placeOf(0.5, 0.9), placeOf(0.9, 0.9)]).toEqual([
      'top left',
      'top',
      'top right',
      'left',
      'middle',
      'right',
      'bottom left',
      'bottom',
      'bottom right'
    ])
  })

  it('progress, the accessible name and the live messages', () => {
    expect(progressText(12, 40)).toBe('12 of 40 reviewed')
    expect(itemAccessibleName({ title: 'Cut 2.4 s of silence', kind: 'silence' }, '0:12.4', 'pending')).toBe('Cut 2.4 s of silence, silence, at 0:12.4, not reviewed')
    expect(itemAccessibleName({ title: 'Zoom in', kind: 'zoom' }, '0:01.0', 'kept')).toBe('Zoom in, zoom, at 0:01.0, kept')
    expect(actedMessage('keep', 13, 40)).toBe('Kept. 13 of 40 reviewed.')
    expect(actedMessage('remove', 14, 40)).toBe('Removed. 14 of 40 reviewed.')
    expect(bulkMessage('keep', 26)).toBe('Kept 26 changes.')
    expect(bulkMessage('keep', 1)).toBe('Kept 1 change.')
    expect(bulkMessage('remove', 5, 'zoom')).toBe('Removed 5 zooms.')
    expect(bulkMessage('remove', 1, 'words')).toBe('Removed 1 word cut.')
    expect(buttonLabel(12)).toBe('Review automatic changes, 12 to review')
    expect(buttonLabel(0)).toBe('Review automatic changes, nothing to review')
  })

  it('every kind has its words', () => {
    for (const k of REVIEW_KINDS) expect(KIND_WORDS[k].all).toMatch(/^Remove all /)
  })
})
