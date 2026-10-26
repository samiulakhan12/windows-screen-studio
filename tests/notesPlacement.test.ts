import { describe, expect, it } from 'vitest'
import { notesAllowed, notesBounds, placementOf, rectsOverlap, type NotesDisplay } from '../src/shared/notes/placement'

const D1: NotesDisplay = { id: '1', bounds: { x: 0, y: 0, width: 1920, height: 1080 }, workArea: { x: 0, y: 0, width: 1920, height: 1040 }, primary: true }
const D2: NotesDisplay = { id: '2', bounds: { x: 1920, y: 0, width: 1707, height: 960 }, workArea: { x: 1920, y: 0, width: 1707, height: 920 }, primary: false }
const DISPLAYS = [D2, D1]
const size = { width: 560, height: 240 }

describe('notesBounds', () => {
  it('defaults to the top centre of the primary work area, under the camera', () => {
    expect(notesBounds(DISPLAYS, { ...size, placement: null })).toEqual({ displayId: '1', rect: { x: 680, y: 8, width: 560, height: 240 } })
  })

  it('puts a saved placement back on its display as shares of the room left', () => {
    expect(notesBounds(DISPLAYS, { ...size, placement: { displayId: '2', x: 1, y: 1 } })).toEqual({
      displayId: '2',
      rect: { x: 1920 + 1707 - 560, y: 920 - 240, width: 560, height: 240 }
    })
    expect(notesBounds(DISPLAYS, { ...size, placement: { displayId: '2', x: 0, y: 0 } }).rect).toMatchObject({ x: 1920, y: 0 })
  })

  it('an unknown display falls back to the default place', () => {
    expect(notesBounds(DISPLAYS, { ...size, placement: { displayId: '3', x: 1, y: 1 } })).toEqual({ displayId: '1', rect: { x: 680, y: 8, width: 560, height: 240 } })
  })

  it('clamps the size to the limits and to the work area, staying inside it', () => {
    expect(notesBounds(DISPLAYS, { width: 2000, height: 1200, placement: null }).rect).toEqual({ x: 360, y: 8, width: 1200, height: 720 })
    const small: NotesDisplay = { id: 's', bounds: { x: 0, y: 0, width: 800, height: 600 }, workArea: { x: 0, y: 0, width: 800, height: 400 }, primary: true }
    const r = notesBounds([small], { width: 1200, height: 720, placement: { displayId: 's', x: 1, y: 1 } }).rect
    expect(r).toEqual({ x: 0, y: 0, width: 800, height: 400 })
    // Below the minimum: the minimum.
    expect(notesBounds(DISPLAYS, { width: 10, height: 10, placement: null }).rect).toMatchObject({ width: 320, height: 140 })
  })
})

describe('placementOf', () => {
  it('round-trips through notesBounds within 1 DIP', () => {
    for (const rect of [
      { x: 1000, y: 300, width: 560, height: 240 },
      { x: 2500, y: 123, width: 700, height: 300 },
      { x: 0, y: 800, width: 560, height: 240 }
    ]) {
      const placement = placementOf(DISPLAYS, rect)
      const back = notesBounds(DISPLAYS, { width: rect.width, height: rect.height, placement }).rect
      expect(Math.abs(back.x - rect.x)).toBeLessThanOrEqual(1)
      expect(Math.abs(back.y - rect.y)).toBeLessThanOrEqual(1)
    }
  })

  it('a rectangle across two displays belongs to the one holding its centre', () => {
    // Centre at x = 1700 + 280 = 1980: on D2.
    expect(placementOf(DISPLAYS, { x: 1700, y: 0, width: 560, height: 240 }).displayId).toBe('2')
    // Centre at x = 1500 + 280 = 1780: on D1.
    expect(placementOf(DISPLAYS, { x: 1500, y: 0, width: 560, height: 240 }).displayId).toBe('1')
  })

  it('the display holding the centre wins over the one it overlaps most', () => {
    const big: NotesDisplay = { id: 'big', bounds: { x: 0, y: 0, width: 1000, height: 1000 }, workArea: { x: 0, y: 0, width: 1000, height: 1000 }, primary: true }
    const thin: NotesDisplay = { id: 'thin', bounds: { x: 1000, y: 400, width: 1000, height: 200 }, workArea: { x: 1000, y: 400, width: 1000, height: 200 }, primary: false }
    // Centre (1050, 500) on the thin display; 200 000 DIP² on the big one, 60 000 on the thin one.
    expect(placementOf([big, thin], { x: 800, y: 0, width: 500, height: 1000 }).displayId).toBe('thin')
  })

  it('a centre off every display goes to the one it overlaps most; no room means 0.5', () => {
    expect(placementOf(DISPLAYS, { x: 1800, y: 800, width: 400, height: 400 }).displayId).toBe('2')
    expect(placementOf(DISPLAYS, { x: 0, y: 0, width: 1920, height: 1040 })).toEqual({ displayId: '1', x: 0.5, y: 0.5 })
  })
})

describe('rectsOverlap and notesAllowed', () => {
  it('touching edges do not overlap', () => {
    expect(rectsOverlap({ x: 0, y: 0, width: 10, height: 10 }, { x: 10, y: 0, width: 10, height: 10 })).toBe(false)
    expect(rectsOverlap({ x: 0, y: 0, width: 10, height: 10 }, { x: 0, y: 10, width: 10, height: 10 })).toBe(false)
    expect(rectsOverlap({ x: 0, y: 0, width: 10, height: 10 }, { x: 9, y: 9, width: 10, height: 10 })).toBe(true)
  })

  const notes = { x: 680, y: 8, width: 560, height: 240 }

  it('where the PC keeps them out of the capture, always', () => {
    for (const kind of ['screen', 'area', 'window'] as const) expect(notesAllowed({ excluded: true, kind, notes, captured: null })).toBe(true)
  })

  it('older Windows: never for a window, and only off the captured screen or area', () => {
    expect(notesAllowed({ excluded: false, kind: 'window', notes, captured: null })).toBe(false)
    // Even when the window is elsewhere now: it can move under the notes.
    expect(notesAllowed({ excluded: false, kind: 'window', notes, captured: D2.bounds })).toBe(false)
    expect(notesAllowed({ excluded: false, kind: 'screen', notes, captured: D1.bounds })).toBe(false)
    expect(notesAllowed({ excluded: false, kind: 'screen', notes, captured: D2.bounds })).toBe(true)
    expect(notesAllowed({ excluded: false, kind: 'area', notes, captured: { x: 0, y: 300, width: 800, height: 600 } })).toBe(true)
    expect(notesAllowed({ excluded: false, kind: 'area', notes, captured: { x: 0, y: 100, width: 800, height: 600 } })).toBe(false)
    expect(notesAllowed({ excluded: false, kind: 'screen', notes, captured: null })).toBe(false)
  })
})
