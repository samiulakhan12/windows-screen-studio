import { describe, expect, it } from 'vitest'
import { PALETTE_COMMANDS, searchCommands } from '../src/shared/editor/commands'
import { chordFromEvent, matchShortcut, resolveKeymap, shortcutIndex, type KeyInput } from '../src/shared/editor/shortcuts'
import {
  atOutputStart,
  DEFAULT_PREVIEW_SPEED,
  elementRate,
  formatRate,
  isPreviewSpeed,
  MAX_SHUTTLE_LEVEL,
  nextPreviewSpeed,
  pressShuttle,
  PREVIEW_SPEEDS,
  previewSpeedHint,
  reversePosition,
  type Shuttle,
  shuttleHint,
  shuttleLabel,
  soundAt,
  STOPPED,
  viewRate
} from '../src/shared/editor/shuttle'
import type { Clip } from '../src/shared/types'

const fwd = (level: number): Shuttle => ({ dir: 1, level })
const rev = (level: number): Shuttle => ({ dir: -1, level })

describe('pressShuttle', () => {
  it('L plays forward, then each press doubles up to the top level', () => {
    expect(pressShuttle(STOPPED, 'forward')).toEqual({ next: fwd(0), frameStep: 0 })
    let s = fwd(0)
    const levels: number[] = []
    for (let i = 0; i < 4; i++) {
      s = pressShuttle(s, 'forward').next
      levels.push(s.level)
    }
    expect(levels).toEqual([1, 2, 3, 3])
    expect(MAX_SHUTTLE_LEVEL).toBe(3)
  })

  it('J plays backwards the same way; the other key switches direction at level 0', () => {
    expect(pressShuttle(STOPPED, 'reverse').next).toEqual(rev(0))
    expect(pressShuttle(rev(1), 'reverse').next).toEqual(rev(2))
    expect(pressShuttle(rev(3), 'reverse').next).toEqual(rev(3))
    expect(pressShuttle(fwd(2), 'reverse')).toEqual({ next: rev(0), frameStep: 0 })
    expect(pressShuttle(rev(2), 'forward')).toEqual({ next: fwd(0), frameStep: 0 })
  })

  it('K stops from anywhere', () => {
    for (const s of [STOPPED, fwd(0), fwd(3), rev(2)]) expect(pressShuttle(s, 'pause')).toEqual({ next: STOPPED, frameStep: 0 })
    expect(pressShuttle(rev(2), 'pause', true)).toEqual({ next: STOPPED, frameStep: 0 })
  })

  it('J or L while K is held steps one frame and stops', () => {
    expect(pressShuttle(STOPPED, 'forward', true)).toEqual({ next: STOPPED, frameStep: 1 })
    expect(pressShuttle(fwd(2), 'reverse', true)).toEqual({ next: STOPPED, frameStep: -1 })
    expect(pressShuttle(rev(1), 'reverse', true)).toEqual({ next: STOPPED, frameStep: -1 })
  })
})

describe('rates', () => {
  it('viewRate: direction × preview speed × 2^level, 0 when stopped', () => {
    expect(viewRate(fwd(0), 1.5)).toBe(1.5)
    expect(viewRate(fwd(3), 2)).toBe(16)
    expect(viewRate(rev(1), 1)).toBe(-2)
    expect(viewRate(STOPPED, 2)).toBe(0)
  })

  it("elementRate: clip speed × |view| within Chromium's playbackRate range", () => {
    expect(elementRate(8, 4)).toBe(16)
    expect(elementRate(0.25, 0.5)).toBe(0.125)
    expect(elementRate(1, -2)).toBe(2)
    expect(elementRate(0.25, 0.125)).toBe(0.0625)
    // Viewing rate 1 leaves every clip speed as it was.
    for (const s of [0.25, 0.5, 1, 2, 8]) expect(elementRate(s, 1)).toBe(s)
  })

  it('soundAt: always at viewing rate 1, never in reverse, else between 0.5× and 4× of the element', () => {
    expect(soundAt(8, 1)).toBe(true)
    expect(soundAt(1, 2)).toBe(true)
    expect(soundAt(1, 4)).toBe(true)
    expect(soundAt(2, 4)).toBe(false)
    expect(soundAt(0.75, 0.5)).toBe(false)
    expect(soundAt(1, 0.5)).toBe(true)
    expect(soundAt(1, -1)).toBe(false)
    expect(soundAt(1, 0)).toBe(false)
  })
})

describe('labels', () => {
  it('formatRate', () => {
    expect([0.5, 1, 1.5, 16].map(formatRate)).toEqual(['0.5×', '1×', '1.5×', '16×'])
  })

  it('shuttleLabel: only while reversing or going forward above level 0', () => {
    expect(shuttleLabel(STOPPED, 1)).toBeNull()
    expect(shuttleLabel(fwd(0), 2)).toBeNull()
    expect(shuttleLabel(fwd(1), 1)).toBe('Forward 2×')
    expect(shuttleLabel(rev(0), 1)).toBe('Reverse 1×')
    expect(shuttleLabel(rev(0), 1, true)).toBe('Reverse 1×')
    expect(shuttleLabel(fwd(3), 1.5)).toBe('Forward 12×')
    expect(shuttleLabel(fwd(3), 1, true)).toBe('Forward 8× · no sound')
  })

  it('shuttleHint names the bound keys and leaves the unbound ones out', () => {
    expect(shuttleHint({ reverse: 'J', pause: 'K', forward: 'L' })).toBe(
      'J plays backwards, K pauses, L plays forward; press again to go faster. Hold K and tap J or L to step one frame. No sound in reverse or above 4×.'
    )
    expect(shuttleHint({ reverse: null, pause: 'K', forward: 'L' })).toBe('K pauses, L plays forward; press again to go faster. Hold K and tap L to step one frame. No sound in reverse or above 4×.')
    expect(shuttleHint({ reverse: 'J', pause: null, forward: 'L' })).toBe('J plays backwards, L plays forward; press again to go faster. No sound in reverse or above 4×.')
    expect(shuttleHint({ reverse: null, pause: 'K', forward: null })).toBe('K pauses. No sound in reverse or above 4×.')
    expect(shuttleHint({ reverse: null, pause: null, forward: null })).toBe('No sound in reverse or above 4×.')
  })

  it('previewSpeedHint', () => {
    expect(previewSpeedHint('<', '>')).toBe('Preview speed: play the preview faster or slower to review it (< slower, > faster). The exported video keeps its own speed.')
    expect(previewSpeedHint(null, '>')).toBe('Preview speed: play the preview faster or slower to review it (> faster). The exported video keeps its own speed.')
    expect(previewSpeedHint(null, null)).toBe('Preview speed: play the preview faster or slower to review it. The exported video keeps its own speed.')
  })
})

describe('preview speeds', () => {
  it('are 0.5×, 1×, 1.5× and 2×, starting at 1×', () => {
    expect(PREVIEW_SPEEDS).toEqual([0.5, 1, 1.5, 2])
    expect(DEFAULT_PREVIEW_SPEED).toBe(1)
  })

  it('nextPreviewSpeed moves along the list and stops at its ends', () => {
    expect(nextPreviewSpeed(1, 1)).toBe(1.5)
    expect(nextPreviewSpeed(1.5, 1)).toBe(2)
    expect(nextPreviewSpeed(2, 1)).toBeNull()
    expect(nextPreviewSpeed(1, -1)).toBe(0.5)
    expect(nextPreviewSpeed(0.5, -1)).toBeNull()
  })

  it('isPreviewSpeed', () => {
    expect(isPreviewSpeed(1.5)).toBe(true)
    expect(isPreviewSpeed(3)).toBe(false)
    expect(isPreviewSpeed('1')).toBe(false)
    expect(isPreviewSpeed(Number.NaN)).toBe(false)
  })
})

describe('reverse', () => {
  // Output length 6: 0–4 at 1×, then 6–10 at 2× (output 4–6); output 5 is source 8.
  const clips: Clip[] = [
    { id: 'a', start: 0, end: 4, speed: 1 },
    { id: 'b', start: 6, end: 10, speed: 2 }
  ]

  it('walks back in output time from where it started, skipping cuts', () => {
    expect(reversePosition(clips, 5, 0, 1)).toEqual({ time: 8, out: 5, done: false })
    expect(reversePosition(clips, 5, 0.5, 1)).toEqual({ time: 7, out: 4.5, done: false })
    // Crosses the cut from 4 to 6.
    expect(reversePosition(clips, 5, 2, 1)).toEqual({ time: 3, out: 3, done: false })
    expect(reversePosition(clips, 5, 1, 2)).toEqual({ time: 3, out: 3, done: false })
  })

  it('stops at the first kept frame', () => {
    expect(reversePosition(clips, 5, 6, 1)).toEqual({ time: 0, out: 0, done: true })
    const trimmed: Clip[] = [{ id: 'a', start: 2, end: 9, speed: 1 }]
    expect(reversePosition(trimmed, 3, 3, 1)).toEqual({ time: 2, out: 0, done: true })
  })

  it('atOutputStart: nothing to play backwards at the first kept frame (or before it, in a trim)', () => {
    const trimmed: Clip[] = [{ id: 'a', start: 2, end: 9, speed: 1 }]
    expect(atOutputStart(trimmed, 2)).toBe(true)
    expect(atOutputStart(trimmed, 0.5)).toBe(true)
    expect(atOutputStart(trimmed, 2.1)).toBe(false)
    expect(atOutputStart(clips, 0)).toBe(true)
    expect(atOutputStart(clips, 5)).toBe(false)
  })
})

/** A keydown as the browser reports it. */
const ev = (key: string, code: string, mods: Partial<Pick<KeyInput, 'ctrlKey' | 'altKey' | 'shiftKey' | 'metaKey'>> = {}): KeyInput => ({
  key,
  code,
  ctrlKey: false,
  altKey: false,
  shiftKey: false,
  metaKey: false,
  ...mods
})

describe('shuttle keys and commands', () => {
  it('Shift+L still plays forward, and a key the user gave another command wins', () => {
    const chord = chordFromEvent(ev('L', 'KeyL', { shiftKey: true }))
    expect(chord && matchShortcut(shortcutIndex(resolveKeymap({})), chord)).toBe('shuttleForward')
    const keymap = resolveKeymap({ split: ['L'] })
    expect(keymap.shuttleForward).toEqual([])
    expect(keymap.split).toEqual(['L'])
  })

  it('rank first in the palette for their words, and leave smart speed first for its own', () => {
    const titles = (query: string): string[] => searchCommands(PALETTE_COMMANDS, query, []).map((r) => r.command.title)
    expect(titles('reverse')[0]).toBe('Play backwards (again: faster)')
    expect(titles('preview speed').slice(0, 2).sort()).toEqual(['Faster preview speed', 'Slower preview speed'])
    expect(titles('pause').slice(0, 2)).toEqual(['Pause', 'Play / pause'])
    expect(titles('  Smart  SPEED ')[0]).toBe('Smart speed: find idle parts')
  })
})
