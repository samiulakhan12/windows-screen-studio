/**
 * Test 78 (docs/design/output-and-languages.md §21.8 row X4, §23.1): Review mode's KIND_WORDS hold
 * message keys, and the kinds' words, as plural messages, give today's English for 0, 1, 2 and 1000
 * of each kind, in the live messages that count them too. TODAY is the table KIND_WORDS held before
 * the extraction, and the functions below it are today's sentences, kept here as the reference.
 */
import { afterEach, describe, expect, it } from 'vitest'
import { setCatalogue } from '../src/shared/i18n/t'
import {
  bulkMessage,
  busyMessage,
  KIND_WORDS,
  kindAll,
  kindChip,
  kindCount,
  kindName,
  REVIEW_KINDS,
  stillBusyMessage,
  stoppedMessage,
  type ReviewKind
} from '../src/shared/review/copy'

const TODAY: Record<ReviewKind, { chip: string; name: string; all: string; one: string; plural: string }> = {
  zoom: { chip: 'Zoom', name: 'zoom', all: 'Remove all zooms', one: 'zoom', plural: 'zooms' },
  camera: { chip: 'Camera', name: 'camera', all: 'Remove all camera changes', one: 'camera change', plural: 'camera changes' },
  silence: { chip: 'Silence', name: 'silence', all: 'Remove all silence cuts', one: 'silence cut', plural: 'silence cuts' },
  idle: { chip: 'Idle', name: 'idle time', all: 'Remove all idle-time changes', one: 'idle-time change', plural: 'idle-time changes' },
  words: { chip: 'Words', name: 'words', all: 'Remove all word cuts', one: 'word cut', plural: 'word cuts' },
  style: { chip: 'Style', name: 'caption style', all: 'Remove all caption style changes', one: 'caption style change', plural: 'caption style changes' },
  emphasis: { chip: 'Emphasis', name: 'emphasis', all: 'Remove all emphasis', one: 'emphasis', plural: 'emphasis' },
  text: { chip: 'Text', name: 'text fixes', all: 'Remove all text fixes', one: 'text fix', plural: 'text fixes' },
  emoji: { chip: 'Emoji', name: 'emoji', all: 'Remove all emoji', one: 'emoji', plural: 'emoji' },
  graphic: { chip: 'Graphic', name: 'graphic', all: 'Remove all graphics', one: 'graphic', plural: 'graphics' },
  bleep: { chip: 'Bleep', name: 'bleep', all: 'Remove all bleeps', one: 'bleep', plural: 'bleeps' },
  join: { chip: 'Cuts', name: 'cut style', all: 'Remove all cut styles', one: 'cut style', plural: 'cut styles' },
  colour: { chip: 'Colour', name: 'colour', all: 'Remove all colour changes', one: 'colour change', plural: 'colour changes' },
  // Auto-blur's private items (docs/design/auto-blur.md §2.7), added by its contracts step.
  private: { chip: 'Private', name: 'private item', all: 'Uncover all private items', one: 'private item', plural: 'private items' },
  chapter: { chip: 'Chapter', name: 'found chapter', all: 'Remove all found chapters', one: 'found chapter', plural: 'found chapters' },
  short: { chip: 'Short', name: 'shorter-version cut', all: 'Remove all shorter-version cuts', one: 'shorter-version cut', plural: 'shorter-version cuts' }
}

// Today's sentences (review/copy.ts before the extraction).
const RULE = 'Keep, Remove, Undo and Redo wait until it is done. Closing the panel stops it.'
const noun = (count: number, kind?: ReviewKind): string => `${count} ${count === 1 ? (kind ? TODAY[kind].one : 'change') : kind ? TODAY[kind].plural : 'changes'}`
const todayBulk = (action: 'keep' | 'remove', count: number, kind?: ReviewKind): string => (action === 'keep' ? `Kept ${noun(count)}.` : `Removed ${noun(count, kind)}.`)
const todayWork = (action: 'keep' | 'remove', count: number, kind?: ReviewKind): string => noun(count, action === 'remove' ? kind : undefined)
const todayBusy = (action: 'keep' | 'remove', count: number, kind?: ReviewKind): string => `${action === 'keep' ? 'Keeping' : 'Removing'} ${todayWork(action, count, kind)}… ${RULE}`
const todayStill = (action: 'keep' | 'remove', count: number, kind?: ReviewKind): string => `Still ${action === 'keep' ? 'keeping' : 'removing'} ${todayWork(action, count, kind)}…`

const COUNTS = [0, 1, 2, 1000]

afterEach(() => setCatalogue({ language: 'en', messages: {}, formatLocale: 'en-US', dir: 'ltr' }))

describe('test 78: KIND_WORDS as plural messages', () => {
  it('holds message keys, one plural count message per kind, never English text', () => {
    expect(Object.keys(KIND_WORDS).sort()).toEqual([...REVIEW_KINDS].sort())
    for (const k of REVIEW_KINDS) {
      expect(KIND_WORDS[k]).toEqual({ chip: `review.kind.${k}.chip`, name: `review.kind.${k}.name`, all: `review.kind.${k}.all`, count: `review.kind.${k}.count` })
    }
  })

  it("gives today's chip, name and Remove all for every kind", () => {
    for (const k of REVIEW_KINDS) expect({ chip: kindChip(k), name: kindName(k), all: kindAll(k) }).toEqual({ chip: TODAY[k].chip, name: TODAY[k].name, all: TODAY[k].all })
  })

  it("gives today's English for 0, 1, 2 and 1000 of each kind, alone and in the live messages", () => {
    for (const k of REVIEW_KINDS) {
      for (const c of COUNTS) {
        expect(kindCount(k, c)).toBe(`${c} ${c === 1 ? TODAY[k].one : TODAY[k].plural}`)
        expect(bulkMessage('remove', c, k)).toBe(todayBulk('remove', c, k))
        expect(busyMessage('remove', c, k)).toBe(todayBusy('remove', c, k))
        expect(stillBusyMessage('remove', c, k)).toBe(todayStill('remove', c, k))
        // Keep all counts changes of any kind.
        expect(bulkMessage('keep', c, k)).toBe(todayBulk('keep', c, k))
        expect(busyMessage('keep', c, k)).toBe(todayBusy('keep', c, k))
        expect(stillBusyMessage('keep', c, k)).toBe(todayStill('keep', c, k))
      }
      expect(stoppedMessage('remove', k)).toBe(`${TODAY[k].all} stopped: nothing was removed.`)
    }
    for (const c of COUNTS) expect(bulkMessage('remove', c)).toBe(todayBulk('remove', c))
    expect(stoppedMessage('remove')).toBe('Remove all stopped: nothing was removed.')
    expect(stoppedMessage('keep')).toBe('Keep all stopped: nothing was kept.')
  })

  it('counts in the format locale’s digits, choosing the plural by the number', () => {
    setCatalogue({ language: 'bn', messages: {}, formatLocale: 'bn-BD', dir: 'ltr' })
    expect(kindCount('zoom', 1000)).toBe('১০০০ zooms')
    expect(kindCount('zoom', 1)).toBe('১ zoom')
  })
})
