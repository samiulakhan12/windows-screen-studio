import { describe, expect, it } from 'vitest'
import { effectiveTrack } from '../src/shared/engine/inputTrack'
import { clickKey, clickRows, ignoredKeys, paintPathRange, readInputEdits, readScrolls } from '../src/shared/engine/inputData'
import { createProject, migrateCursor, migrateProject } from '../src/shared/engine/project'
import { DEFAULT_ZOOM_SETTINGS, zoomSettingsOf } from '../src/shared/engine/zoom'
import type { ClickEvent, CursorTrack, PathRange } from '../src/shared/types'

const click = (t: number, x = 0.5, y = 0.5, button: ClickEvent['button'] = 'left'): ClickEvent => ({ t, x, y, button })
const track = (clicks: ClickEvent[], extra: Partial<CursorTrack> = {}): CursorTrack => ({ samples: [{ t: 0, x: 0.5, y: 0.5 }], clicks, valid: true, ...extra })

describe('clickKey', () => {
  it('names a click by its whole millisecond', () => {
    expect(clickKey(4.2)).toBe(4200)
    expect(clickKey(4.2004)).toBe(4200)
    expect(clickKey(0.0005)).toBe(1)
    expect(clickKey(12.3456)).toBe(12346)
  })
})

describe('readInputEdits', () => {
  it('is undefined for anything without edits', () => {
    expect(readInputEdits(undefined, 10)).toBeUndefined()
    expect(readInputEdits(null, 10)).toBeUndefined()
    expect(readInputEdits([], 10)).toBeUndefined()
    expect(readInputEdits('x', 10)).toBeUndefined()
    expect(readInputEdits({}, 10)).toBeUndefined()
    expect(readInputEdits({ ignoredClicks: [], straighten: false, paths: [] }, 10)).toBeUndefined()
  })

  it('cleans ignored clicks: whole, in range, sorted, unique, the user winning over detection', () => {
    const e = readInputEdits(
      {
        ignoredClicks: [{ ms: 9000 }, { ms: 300, stray: 'start' }, { ms: 'x' }, null, { ms: -5 }, { ms: 99999 }, { ms: 4200.4, stray: 'nope' }, { ms: 9000, stray: 'end' }, { ms: 300 }]
      },
      10
    )
    expect(e).toEqual({ ignoredClicks: [{ ms: 300 }, { ms: 4200 }, { ms: 9000 }] })
    expect(readInputEdits({ ignoredClicks: [{ ms: 5000, stray: 'moving' }] }, 10)).toEqual({ ignoredClicks: [{ ms: 5000, stray: 'moving' }] })
  })

  it('keeps straighten only when true', () => {
    expect(readInputEdits({ straighten: true }, 10)).toEqual({ straighten: true })
    expect(readInputEdits({ straighten: 'yes' }, 10)).toBeUndefined()
  })

  it('clamps, drops and paints path ranges in order', () => {
    const e = readInputEdits(
      {
        paths: [
          { start: -2, end: 4, mode: 'straight' },
          { start: 3, end: 5, mode: 'recorded' },
          { start: 6, end: 6.005, mode: 'straight' },
          { start: 7, end: 'x', mode: 'straight' },
          { start: 8, end: 20, mode: 'other' },
          { start: 9, end: 30, mode: 'straight' }
        ]
      },
      10
    )
    expect(e).toEqual({
      paths: [
        { start: 0, end: 3, mode: 'straight' },
        { start: 3, end: 5, mode: 'recorded' },
        { start: 9, end: 10, mode: 'straight' }
      ]
    })
  })

  it('is idempotent', () => {
    const raw = { ignoredClicks: [{ ms: 2000 }, { ms: 300, stray: 'start' }], straighten: true, paths: [{ start: 1, end: 2, mode: 'recorded' }] }
    const once = readInputEdits(raw, 10)
    expect(readInputEdits(once, 10)).toEqual(once)
  })
})

describe('paintPathRange', () => {
  const base: PathRange[] = [{ start: 1, end: 5, mode: 'straight' }]
  it('splits a range painted inside it, and never changes the input', () => {
    expect(paintPathRange(base, { start: 2, end: 3, mode: 'recorded' })).toEqual([
      { start: 1, end: 2, mode: 'straight' },
      { start: 2, end: 3, mode: 'recorded' },
      { start: 3, end: 5, mode: 'straight' }
    ])
    expect(base).toEqual([{ start: 1, end: 5, mode: 'straight' }])
  })
  it('clears with a null mode and joins touching ranges of one mode', () => {
    expect(paintPathRange(base, { start: 0, end: 2, mode: null })).toEqual([{ start: 2, end: 5, mode: 'straight' }])
    expect(paintPathRange(base, { start: 5, end: 7, mode: 'straight' })).toEqual([{ start: 1, end: 7, mode: 'straight' }])
    expect(paintPathRange(base, { start: 7, end: 6, mode: 'recorded' })).toEqual([...base, { start: 6, end: 7, mode: 'recorded' }])
  })
})

describe('readScrolls', () => {
  it('is undefined unless the stored value is a list', () => {
    expect(readScrolls(undefined)).toBeUndefined()
    expect(readScrolls({})).toBeUndefined()
    expect(readScrolls([])).toEqual([])
  })
  it('keeps valid events sorted, reading a broken amount as 0', () => {
    expect(readScrolls([{ t: 2, x: 0.5, y: 0.5, dx: 0, dy: 1 }, { t: 1, x: 0.1, y: 0.2, dy: 'x' }, { t: 'a', x: 0, y: 0 }, null])).toEqual([
      { t: 1, x: 0.1, y: 0.2, dx: 0, dy: 0 },
      { t: 2, x: 0.5, y: 0.5, dx: 0, dy: 1 }
    ])
  })
})

describe('clickRows', () => {
  const clicks = [click(4, 0.7, 0.3), click(0.3), click(2, 1.5, 0.5), click(9, 0.3, 0.7, 'right')]
  it('lists the clicks inside the video, every button, sorted, with their ignore state', () => {
    const rows = clickRows(track(clicks), { ignoredClicks: [{ ms: 300, stray: 'start' }, { ms: 77 }] })
    expect(rows.map((r) => [r.click.t, r.ms, r.ignored])).toEqual([
      [0.3, 300, { ms: 300, stray: 'start' }],
      [4, 4000, null],
      [9, 9000, null]
    ])
  })
  it('gives the same array for the same inputs, and none without cursor data', () => {
    const t = track(clicks)
    const edits = { ignoredClicks: [{ ms: 4000 }] }
    expect(clickRows(t, edits)).toBe(clickRows(t, edits))
    expect(clickRows(t, undefined)).toBe(clickRows(t, undefined))
    expect(clickRows({ ...t, valid: false }, edits)).toEqual([])
    expect([...ignoredKeys(edits)]).toEqual([4000])
    expect(ignoredKeys(undefined).size).toBe(0)
  })
})

describe('old projects and tracks load unchanged', () => {
  const base = { id: 'x', name: 'x', duration: 10, width: 1920, height: 1080, hasWebcam: false, hasAudio: false, webcamOffset: 0, zooms: [], cursorValid: true }
  it('gives a project without edits no inputEdits key, and cleans stored ones', () => {
    const p = createProject({ ...base, capture: { method: 'native', cursorInVideo: false, region: null } })
    expect('inputEdits' in migrateProject(p)).toBe(false)
    expect('inputEdits' in migrateProject({ ...p, inputEdits: { paths: 'x' } })).toBe(false)
    expect(migrateProject({ ...p, inputEdits: { ignoredClicks: [{ ms: 4000 }, { ms: 4000 }], straighten: true } }).inputEdits).toEqual({
      ignoredClicks: [{ ms: 4000 }],
      straighten: true
    })
  })
  it('gives a cursor track without scrolls no scrolls key, and keeps stored scrolls', () => {
    expect('scrolls' in migrateCursor({ samples: [], clicks: [], valid: true })).toBe(false)
    expect(migrateCursor({ samples: [], clicks: [], valid: true, scrolls: [{ t: 1, x: 0.5, y: 0.5, dx: 0, dy: -2 }] }).scrolls).toEqual([{ t: 1, x: 0.5, y: 0.5, dx: 0, dy: -2 }])
    expect(migrateCursor({ samples: [], clicks: [], valid: true, scrolls: [] }).scrolls).toEqual([])
  })
  it('reads the scroll mode as zoom out when a project has none', () => {
    expect(zoomSettingsOf({}).auto.scrolling).toBe('zoom-out')
    expect(DEFAULT_ZOOM_SETTINGS.auto.scrolling).toBe('zoom-out')
  })
  it('effectiveTrack returns the recorded track itself for a project without edits', () => {
    const t = track([click(2)])
    expect(effectiveTrack(t, { capture: { method: 'native', cursorInVideo: false, region: null }, width: 1920, height: 1080 })).toBe(t)
  })
})
