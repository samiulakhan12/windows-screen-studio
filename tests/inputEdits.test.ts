/**
 * Editing the recorded input (docs/design/smarter-auto-zoom.md §4, §5): stray-click detection,
 * ignoring and using clicks with the zoom rebase, the click at the playhead, what made a zoom,
 * the straightening option, path ranges and the path summary.
 */
import { describe, expect, it } from 'vitest'
import {
  clickAtPlayhead,
  findStrayClicks,
  ignoreStrayClicks,
  pathSummary,
  setClicksIgnored,
  setPathRange,
  setStraighten,
  useAllClicks,
  zoomCause
} from '../src/shared/editor/inputEdits'
import { planCursorPath } from '../src/shared/engine/cursorPath'
import { clickRows } from '../src/shared/engine/inputData'
import { effectiveTrack } from '../src/shared/engine/inputTrack'
import { createProject } from '../src/shared/engine/project'
import { autoZoomsForTrack, DEFAULT_ZOOM_SETTINGS, rebaseAutoZooms, zoomSettingsOf } from '../src/shared/engine/zoom'
import type { ClickEvent, CursorSample, CursorTrack, InputEdits, Project, ScrollEvent, ZoomSegment } from '../src/shared/types'

const ASPECT = 16 / 9
const click = (t: number, x = 0.5, y = 0.5, extra: Partial<ClickEvent> = {}): ClickEvent => ({ t, x, y, button: 'left', ...extra })
const resting = (duration: number, x = 0.5, y = 0.5): CursorSample[] => [
  { t: 0, x, y },
  { t: duration, x, y }
]
const track = (clicks: ClickEvent[], extra: Partial<CursorTrack> = {}): CursorTrack => ({ samples: resting(20), clicks, valid: true, ...extra })

function project(patch: Partial<Project> = {}): Project {
  const p = createProject({
    id: 'rec-1',
    name: 'Test',
    duration: 20,
    width: 1920,
    height: 1080,
    hasWebcam: false,
    hasAudio: false,
    webcamOffset: 0,
    zooms: [],
    cursorValid: true,
    capture: { method: 'native', cursorInVideo: false, region: null }
  })
  return { ...p, ...patch }
}

const spans = (zs: ZoomSegment[]): [number, number][] => zs.map((z) => [Math.round(z.start * 1e6) / 1e6, Math.round(z.end * 1e6) / 1e6])

/* ---------- §4.2 stray clicks ---------- */

describe('findStrayClicks', () => {
  it('the edge examples: start before 0.6 s, end in the last 0.6 s with nothing after', () => {
    const t = track([0.3, 0.59, 0.6, 4.0, 9.41, 9.6].map((s) => click(s)))
    expect(findStrayClicks(t, 10, ASPECT)).toEqual([
      { ms: 300, stray: 'start' },
      { ms: 590, stray: 'start' },
      { ms: 9600, stray: 'end' }
    ])
  })

  it('any later input keeps an end click: a key, a mark, a scroll, typing ending after it, a click elsewhere', () => {
    const last = [click(9.6)]
    const ends = (extra: Partial<CursorTrack>) => findStrayClicks(track(last, extra), 10, ASPECT).length
    expect(ends({})).toBe(1)
    expect(ends({ keys: [{ t: 9.8, label: 'Ctrl + S' }] })).toBe(0)
    expect(ends({ marks: [{ t: 9.7 }] })).toBe(0)
    expect(ends({ scrolls: [{ t: 9.65, x: 0.5, y: 0.5, dx: 0, dy: 1 }] })).toBe(0)
    expect(ends({ typing: [{ t: 9, end: 9.9 }] })).toBe(0)
    expect(ends({ typing: [{ t: 9, end: 9.5 }] })).toBe(1)
    expect(findStrayClicks(track([click(9.6), click(9.7, 1.5, 0.5)]), 10, ASPECT)).toEqual([])
    // Input at the same instant is not after it.
    expect(ends({ keys: [{ t: 9.6, label: 'Enter' }] })).toBe(1)
  })

  /** Rest at (0.30, 0.40) until 1.9 s, then a swipe at 2.0 widths/s to (0.90, 0.40) at 2.2 s. */
  const swipe: CursorSample[] = [
    { t: 0, x: 0.3, y: 0.4 },
    { t: 1.9, x: 0.3, y: 0.4 },
    { t: 2.2, x: 0.9, y: 0.4 },
    { t: 10, x: 0.9, y: 0.4 }
  ]

  it('a click while flying past is moving; one at the end of the swipe is not', () => {
    expect(findStrayClicks(track([click(2.05, 0.6, 0.4)], { samples: swipe }), 10, ASPECT)).toEqual([{ ms: 2050, stray: 'moving' }])
    expect(findStrayClicks(track([click(2.2, 0.9, 0.4)], { samples: swipe }), 10, ASPECT)).toEqual([])
    // Arriving then clicking is one-sided too.
    expect(findStrayClicks(track([click(1.9, 0.3, 0.4)], { samples: swipe }), 10, ASPECT)).toEqual([])
  })

  it('a press held 0.25 s or longer is deliberate, never moving', () => {
    expect(findStrayClicks(track([click(2.05, 0.6, 0.4, { up: 2.3 })], { samples: swipe }), 10, ASPECT)).toEqual([])
    expect(findStrayClicks(track([click(2.05, 0.6, 0.4, { up: 2.2 })], { samples: swipe }), 10, ASPECT)).toEqual([{ ms: 2050, stray: 'moving' }])
  })

  it('the two moves must point the same way (within 45 degrees)', () => {
    // Right into the click, then straight down: 90 degrees apart.
    const corner: CursorSample[] = [
      { t: 0, x: 0.3, y: 0.2 },
      { t: 1.9, x: 0.3, y: 0.2 },
      { t: 2.0, x: 0.5, y: 0.2 },
      { t: 2.1, x: 0.5, y: 0.6 },
      { t: 10, x: 0.5, y: 0.6 }
    ]
    expect(findStrayClicks(track([click(2.0, 0.5, 0.2)], { samples: corner }), 10, ASPECT)).toEqual([])
  })

  it('only clicks inside the video, of every button, and nothing without cursor data', () => {
    expect(findStrayClicks(track([click(0.3, 1.2, 0.5), click(0.4, 0.5, 0.5, { button: 'right' })]), 10, ASPECT)).toEqual([{ ms: 400, stray: 'start' }])
    expect(findStrayClicks({ samples: [], clicks: [click(0.3)], valid: false }, 10, ASPECT)).toEqual([])
  })
})

/* ---------- §4.3 ignoring and using, with the zoom rebase ---------- */

describe('setClicksIgnored and rebaseAutoZooms (the §4.3 example)', () => {
  const recorded = track([click(2, 0.3, 0.3), click(4, 0.6, 0.4), click(9, 0.7, 0.7)])
  const manual: ZoomSegment = { id: 'm', start: 12, end: 15, scale: 2, focus: { mode: 'cursor' }, auto: false }
  const generated = autoZoomsForTrack(recorded, 20)
  const base = project({ zooms: [...generated, manual] })

  it('starts from the generator: [1.1, 5.8] at 2 and [8.1, 10.8] at 9, plus the manual zoom', () => {
    expect(spans(base.zooms)).toEqual([
      [1.1, 5.8],
      [8.1, 10.8],
      [12, 15]
    ])
  })

  it('ignoring 4 replaces only the zoom that changes; ids and the manual zoom are kept', () => {
    const next = setClicksIgnored(base, recorded, { ignore: [{ ms: 4000 }] })
    expect(next.inputEdits).toEqual({ ignoredClicks: [{ ms: 4000 }] })
    expect(spans(next.zooms)).toEqual([
      [1.1, 3.8],
      [8.1, 10.8],
      [12, 15]
    ])
    expect(next.zooms[0].id).not.toBe(base.zooms[0].id)
    expect(next.zooms[0].anchor).toEqual({ t: 2, x: 0.3, y: 0.3 })
    expect(next.zooms[1]).toBe(base.zooms[1])
    expect(next.zooms[2]).toBe(manual)
    // Using it again restores [1.1, 5.8].
    const back = setClicksIgnored(next, recorded, { use: [4000] })
    expect(back.inputEdits).toBeUndefined()
    expect(spans(back.zooms)).toEqual(spans(base.zooms))
    expect(back.zooms[1]).toBe(base.zooms[1])
  })

  it('a zoom the user deleted stays deleted', () => {
    const deleted = { ...base, zooms: [base.zooms[0], manual] }
    const next = setClicksIgnored(deleted, recorded, { ignore: [{ ms: 4000 }] })
    expect(spans(next.zooms)).toEqual([
      [1.1, 3.8],
      [12, 15]
    ])
    expect(spans(setClicksIgnored(next, recorded, { use: [4000] }).zooms)).toEqual([
      [1.1, 5.8],
      [12, 15]
    ])
  })

  it('a deleted zoom stays deleted when its own clicks change', () => {
    const deleted = { ...base, zooms: [base.zooms[1], manual] }
    for (const ms of [4000, 2000]) {
      const next = setClicksIgnored(deleted, recorded, { ignore: [{ ms }] })
      expect(next.inputEdits).toEqual({ ignoredClicks: [{ ms }] })
      expect(next.zooms).toEqual(deleted.zooms)
      // Using it again brings nothing back either.
      expect(setClicksIgnored(next, recorded, { use: [ms] }).zooms).toEqual(deleted.zooms)
    }
    // After Remove all, ignoring a click adds nothing; a lone click used again still gets its zoom.
    const none = { ...base, zooms: [] }
    expect(setClicksIgnored(none, recorded, { ignore: [{ ms: 4000 }] }).zooms).toEqual([])
    const lone = track([click(2, 0.3, 0.3), click(15, 0.6, 0.6)])
    const off = { ...setClicksIgnored(project({ zooms: autoZoomsForTrack(lone, 20) }), lone, { ignore: [{ ms: 15000 }] }), zooms: [] }
    expect(spans(setClicksIgnored(off, lone, { use: [15000] }).zooms)).toEqual([[14.1, 16.8]])
  })

  it('a zoom the user kept survives when its replacement is held back by one they deleted or made', () => {
    const three = track([click(2, 0.3, 0.3), click(5, 0.4, 0.4), click(8, 0.6, 0.6)])
    const all = project({ zooms: autoZoomsForTrack(three, 20) })
    expect(spans(all.zooms)).toEqual([[1.1, 9.8]])
    const split = setClicksIgnored(all, three, { ignore: [{ ms: 5000 }] })
    expect(spans(split.zooms)).toEqual([
      [1.1, 3.8],
      [7.1, 9.8]
    ])
    // Delete either half, then use 5 again: the merged [1.1, 9.8] would cover the deleted half, so
    // it is not added, and the half the user kept stays (same object); the deleted stretch stays clear.
    for (const keep of [1, 0]) {
      const deleted = { ...split, zooms: [split.zooms[keep]] }
      const used = setClicksIgnored(deleted, three, { use: [5000] })
      expect(used.inputEdits).toBeUndefined()
      expect(used.zooms).toBe(deleted.zooms)
      // Ignoring 5 once more changes nothing either.
      expect(setClicksIgnored(used, three, { ignore: [{ ms: 5000 }] }).zooms).toBe(deleted.zooms)
    }
    // A zoom the user made between the halves holds the merge back the same way: both halves stay.
    const made: ZoomSegment = { id: 'm', start: 4.5, end: 6, scale: 2, focus: { mode: 'cursor' }, auto: false }
    const gap = { ...split, zooms: [split.zooms[0], made, split.zooms[1]] }
    expect(setClicksIgnored(gap, three, { use: [5000] }).zooms).toBe(gap.zooms)
    // A zoom deleted elsewhere does not hold the merge back.
    const four = track([...three.clicks, click(15, 0.6, 0.6)])
    const parts = setClicksIgnored(project({ zooms: autoZoomsForTrack(four, 20) }), four, { ignore: [{ ms: 5000 }] })
    expect(spans(parts.zooms)).toEqual([
      [1.1, 3.8],
      [7.1, 9.8],
      [14.1, 16.8]
    ])
    const merged = setClicksIgnored({ ...parts, zooms: parts.zooms.slice(0, 2) }, four, { use: [5000] })
    expect(spans(merged.zooms)).toEqual([[1.1, 9.8]])
  })

  it('a stretch the user cleared stays clear when a later click edit drops the zoom they kept', () => {
    const three = track([click(2, 0.3, 0.3), click(5, 0.4, 0.4), click(8, 0.6, 0.6)])
    const split = setClicksIgnored(project({ zooms: autoZoomsForTrack(three, 20) }), three, { ignore: [{ ms: 5000 }] })
    // Delete one half, use 5 again (nothing visible changes), then ignore the kept half's click:
    // the kept zoom goes with its click, and nothing comes back over the cleared half.
    for (const [keep, kept] of [
      [1, 8000],
      [0, 2000]
    ]) {
      const used = setClicksIgnored({ ...split, zooms: [split.zooms[keep]] }, three, { use: [5000] })
      expect(spans(setClicksIgnored(used, three, { ignore: [{ ms: kept }] }).zooms)).toEqual([])
    }
  })

  it('rebaseAutoZooms: a kept zoom holds back the next replacement too', () => {
    const seg = (start: number, end: number, t: number): ZoomSegment => ({ id: `z${t}`, start, end, scale: 2, focus: { mode: 'cursor' }, auto: true, anchor: { t, x: 0.5, y: 0.5 } })
    // `before` has A, B and C; `after` replaces A and B with X, and B and C with Y.
    const [a, b, c] = [seg(1, 3, 2), seg(4, 9, 5), seg(10, 12, 11)]
    const after = [seg(1, 6, 2), seg(7, 12, 8)]
    for (const zooms of [
      [b, c],
      [a, b],
      [a, c]
    ]) {
      expect(rebaseAutoZooms(zooms, [a, b, c], after)).toBe(zooms)
    }
    expect(spans(rebaseAutoZooms([a, b, c], [a, b, c], after))).toEqual([
      [1, 6],
      [7, 12]
    ])
  })

  it('zooms the user edited (auto: false) are never touched, and nothing new overlaps them', () => {
    const edited = { ...base.zooms[0], auto: false, end: 6 }
    const p = { ...base, zooms: [edited, base.zooms[1], manual] }
    const next = setClicksIgnored(p, recorded, { ignore: [{ ms: 4000 }] })
    expect(next.zooms).toEqual(p.zooms)
    expect(next.zooms[0]).toBe(edited)
  })

  it('with auto zoom off only the edit changes', () => {
    {
      const p = { ...base, zoomSettings: { ...DEFAULT_ZOOM_SETTINGS, auto: { ...DEFAULT_ZOOM_SETTINGS.auto, enabled: false } } }
      expect(zoomSettingsOf(p).auto.enabled).toBe(false)
      const next = setClicksIgnored(p, recorded, { ignore: [{ ms: 4000 }] })
      expect(next.inputEdits).toEqual({ ignoredClicks: [{ ms: 4000 }] })
      expect(next.zooms).toBe(p.zooms)
    }
  })

  it('returns the project itself when no click changes state', () => {
    expect(setClicksIgnored(base, recorded, { use: [4000] })).toBe(base)
    expect(setClicksIgnored(base, recorded, {})).toBe(base)
    // A key that names no recorded click.
    expect(setClicksIgnored(base, recorded, { ignore: [{ ms: 5000 }] })).toBe(base)
    const ignored = setClicksIgnored(base, recorded, { ignore: [{ ms: 4000 }] })
    expect(setClicksIgnored(ignored, recorded, { ignore: [{ ms: 4000 }] })).toBe(ignored)
  })

  it('the stale-anchor fallback drops the ignored click own zoom made by an older generator', () => {
    // Zooms an older generator made: they match nothing `before` reproduces.
    const stale4: ZoomSegment = { id: 's4', start: 3.5, end: 6.5, scale: 1.8, focus: { mode: 'cursor' }, auto: true, anchor: { t: 4, x: 0.6, y: 0.4 } }
    const stale2: ZoomSegment = { id: 's2', start: 1, end: 3.4, scale: 1.8, focus: { mode: 'cursor' }, auto: true, anchor: { t: 2, x: 0.3, y: 0.3 } }
    const p = { ...base, zooms: [stale2, stale4, base.zooms[1], manual] }
    const next = setClicksIgnored(p, recorded, { ignore: [{ ms: 4000 }] })
    // stale4 goes (its click is ignored); stale2 keeps its length until Regenerate, so [1.1, 3.8] would overlap it and is not added.
    expect(next.zooms.map((z) => z.id)).toEqual(['s2', base.zooms[1].id, 'm'])
    // An older zoom for both clicks, anchored at 2: ignoring 2 drops it, and the zoom for 4 takes its place.
    const stale24: ZoomSegment = { id: 's24', start: 1, end: 6.5, scale: 1.8, focus: { mode: 'cursor' }, auto: true, anchor: { t: 2, x: 0.3, y: 0.3 } }
    const replaced = setClicksIgnored({ ...base, zooms: [stale24, base.zooms[1], manual] }, recorded, { ignore: [{ ms: 2000 }] })
    expect(spans(replaced.zooms)).toEqual([
      [3.1, 5.8],
      [8.1, 10.8],
      [12, 15]
    ])
  })

  it('keeps the other edits (and their arrays) and orders the list; an emptied list and edits are removed', () => {
    const paths = [{ start: 1, end: 2, mode: 'straight' as const }]
    const p = { ...base, inputEdits: { ignoredClicks: [{ ms: 9000, stray: 'end' as const }], straighten: true, paths } }
    const next = setClicksIgnored(p, recorded, { ignore: [{ ms: 2000 }] })
    expect(next.inputEdits?.ignoredClicks).toEqual([{ ms: 2000 }, { ms: 9000, stray: 'end' }])
    expect(next.inputEdits?.paths).toBe(paths)
    expect(next.inputEdits?.straighten).toBe(true)
    const used = setClicksIgnored(next, recorded, { use: [2000, 9000] })
    expect(used.inputEdits).toEqual({ straighten: true, paths })
    expect('ignoredClicks' in used.inputEdits!).toBe(false)
    const plain = setClicksIgnored(setClicksIgnored(base, recorded, { ignore: [{ ms: 2000 }] }), recorded, { use: [2000] })
    expect('inputEdits' in plain).toBe(false)
  })

  it("the user's entry replaces detection's for the same click", () => {
    const p = { ...base, inputEdits: { ignoredClicks: [{ ms: 2000, stray: 'start' as const }] } }
    const next = setClicksIgnored(p, recorded, { ignore: [{ ms: 2000 }, { ms: 9000 }] })
    expect(next.inputEdits?.ignoredClicks).toEqual([{ ms: 2000 }, { ms: 9000 }])
  })

  it('rebaseAutoZooms returns the list itself when nothing changes', () => {
    expect(rebaseAutoZooms(base.zooms, generated, autoZoomsForTrack(recorded, 20))).toBe(base.zooms)
  })
})

describe('ignoreStrayClicks and useAllClicks', () => {
  const recorded = track([click(0.3, 0.2, 0.2), click(4, 0.7, 0.3), click(9, 0.3, 0.7), click(19.7, 0.9, 0.9)])
  const p = project({ zooms: autoZoomsForTrack(recorded, 20) })

  it('ignores what detection finds, once, as one change with the zooms', () => {
    expect(spans(p.zooms)).toEqual([
      [0, 2.2],
      [3.1, 5.8],
      [8.1, 10.8],
      [18.6, 20]
    ])
    const { project: next, added } = ignoreStrayClicks(p, recorded)
    expect(added).toEqual([
      { ms: 300, stray: 'start' },
      { ms: 19700, stray: 'end' }
    ])
    expect(next.inputEdits).toEqual({ ignoredClicks: added })
    expect(spans(next.zooms)).toEqual([
      [3.1, 5.8],
      [8.1, 10.8]
    ])
    const again = ignoreStrayClicks(next, recorded)
    expect(again.added).toEqual([])
    expect(again.project).toBe(next)
  })

  it('does not overrule the user: a click they ignored keeps its own entry', () => {
    const mine = setClicksIgnored(p, recorded, { ignore: [{ ms: 300 }] })
    const { project: next, added } = ignoreStrayClicks(mine, recorded)
    expect(added).toEqual([{ ms: 19700, stray: 'end' }])
    expect(next.inputEdits?.ignoredClicks).toEqual([{ ms: 300 }, { ms: 19700, stray: 'end' }])
  })

  it('useAllClicks brings every click and its zoom back', () => {
    const { project: next } = ignoreStrayClicks(p, recorded)
    const all = useAllClicks(next, recorded)
    expect(all.inputEdits).toBeUndefined()
    expect(spans(all.zooms)).toEqual(spans(p.zooms))
    expect(useAllClicks(p, recorded)).toBe(p)
  })
})

/* ---------- §4.4, §4.5 ---------- */

describe('clickAtPlayhead', () => {
  const recorded = track([click(2), click(4), click(9)])
  const edits: InputEdits = { ignoredClicks: [{ ms: 9000 }] }
  const rows = clickRows(recorded, edits)
  const zooms = autoZoomsForTrack(recorded, 20)

  it('the click the auto zoom under the playhead was made for comes first', () => {
    expect(clickAtPlayhead(rows, zooms, 4.2)?.ms).toBe(2000)
  })

  it('else the nearest click within 1 s (the later one on a tie), ignored ones included', () => {
    expect(clickAtPlayhead(rows, [], 4.2)?.ms).toBe(4000)
    expect(clickAtPlayhead(rows, [], 3)?.ms).toBe(4000)
    expect(clickAtPlayhead(rows, [], 8.2)?.ms).toBe(9000)
    expect(clickAtPlayhead(rows, [], 6.5)).toBeNull()
    // A manual zoom or a typing zoom does not name a click.
    const manual = zooms.map((z) => ({ ...z, auto: false }))
    expect(clickAtPlayhead(rows, manual, 4.2)?.ms).toBe(4000)
    const typing = zooms.map((z) => ({ ...z, anchor: { ...z.anchor!, until: z.anchor!.t + 1 } }))
    expect(clickAtPlayhead(rows, typing, 4.2)?.ms).toBe(4000)
  })
})

describe('zoomCause', () => {
  const settings = DEFAULT_ZOOM_SETTINGS.auto
  const scrolls: ScrollEvent[] = Array.from({ length: 41 }, (_, k) => ({ t: Math.round((3 + k * 0.1) * 1000) / 1000, x: 0.5, y: 0.5, dx: 0, dy: 1 }))
  const recorded = track([click(2, 0.3, 0.3), click(12)], { scrolls, marks: [{ t: 24 }], typing: [{ t: 17.5, end: 19 }] })
  const zooms = autoZoomsForTrack(recorded, 30, settings)
  const at = (t: number) => zooms.find((z) => z.start <= t && t <= z.end)!

  it('names each kind of zoom', () => {
    expect(zoomCause(at(2), recorded, settings)).toEqual({ kind: 'click', click: recorded.clicks[0], ms: 2000 })
    expect(zoomCause(at(8.1), recorded, settings)).toEqual({ kind: 'scroll', t: 7 })
    expect(zoomCause(at(24), recorded, settings)).toEqual({ kind: 'mark', t: 24 })
    const typing = zooms.find((z) => typeof z.anchor?.until === 'number')!
    expect(zoomCause(typing, recorded, settings)).toEqual({ kind: 'typing', t: typing.anchor!.t })
  })

  it('is null for zooms made or edited by hand, and for an ignored click', () => {
    expect(zoomCause({ ...at(2), auto: false }, recorded, settings)).toBeNull()
    const { anchor: _a, ...plain } = at(2)
    expect(zoomCause(plain, recorded, settings)).toBeNull()
    const eff = effectiveTrack(recorded, { ...project(), inputEdits: { ignoredClicks: [{ ms: 2000 }] } })
    expect(zoomCause(at(2), eff, settings)).toBeNull()
    // No scroll cause without zoom-out.
    expect(zoomCause(at(8.1), recorded, { ...settings, scrolling: 'hold' })).toBeNull()
  })
})

/* ---------- §5 options ---------- */

describe('setStraighten and setPathRange', () => {
  const p = project()

  it('turns the option on and off; off removes the key and empty edits', () => {
    const on = setStraighten(p, true)
    expect(on.inputEdits).toEqual({ straighten: true })
    expect(setStraighten(on, true)).toBe(on)
    expect(setStraighten(p, false)).toBe(p)
    const off = setStraighten(on, false)
    expect('inputEdits' in off).toBe(false)
    const ignored = [{ ms: 2000 }]
    const kept = setStraighten({ ...on, inputEdits: { straighten: true, ignoredClicks: ignored } }, false)
    expect(kept.inputEdits).toEqual({ ignoredClicks: ignored })
    expect(kept.inputEdits?.ignoredClicks).toBe(ignored)
  })

  it('paints path ranges, clamped to the recording; clearing removes them', () => {
    const a = setPathRange(p, { start: 5, end: 3 }, 'straight')
    expect(a.inputEdits).toEqual({ paths: [{ start: 3, end: 5, mode: 'straight' }] })
    expect(setPathRange(a, { start: 3, end: 5 }, 'straight')).toBe(a)
    expect(setPathRange(a, { start: 3.5, end: 4.5 }, 'straight')).toBe(a)
    const b = setPathRange(a, { start: 4, end: 30 }, 'recorded')
    expect(b.inputEdits?.paths).toEqual([
      { start: 3, end: 4, mode: 'straight' },
      { start: 4, end: 20, mode: 'recorded' }
    ])
    const cleared = setPathRange(b, { start: 0, end: 20 }, null)
    expect('inputEdits' in cleared).toBe(false)
    expect(setPathRange(p, { start: 2, end: 3 }, null)).toBe(p)
    expect(setPathRange(p, { start: Number.NaN, end: 3 }, 'straight')).toBe(p)
  })
})

describe('pathSummary', () => {
  /** Moves A -> B (1.0-1.6 s, straightenable) and B -> A (4.0-4.6 s, with a click inside). */
  const samples: CursorSample[] = []
  const rest = (t0: number, t1: number, x: number) => samples.push({ t: t0, x, y: 0.5 }, { t: (t0 + t1) / 2, x, y: 0.5 }, { t: t1, x, y: 0.5 })
  const move = (t0: number, from: number, to: number) => {
    for (let k = 1; k < 36; k++) samples.push({ t: t0 + k / 60, x: from + ((to - from) * k) / 36, y: 0.5 + 0.01 * Math.sin((Math.PI * k) / 36) })
  }
  rest(0, 1, 0.2)
  move(1, 0.2, 0.6)
  rest(1.6, 4, 0.6)
  move(4, 0.6, 0.2)
  rest(4.6, 10, 0.2)
  const recorded: CursorTrack = { samples, clicks: [click(4.3, 0.4, 0.5)], valid: true }

  it('counts the moves, the straightened ones and why the others keep their path', () => {
    expect(pathSummary(recorded, project())).toEqual({ moves: 2, straightened: 0, kept: { click: 1 } })
    const on = setStraighten(project(), true)
    expect(pathSummary(recorded, on)).toEqual({ moves: 2, straightened: 1, kept: { click: 1 } })
    expect(pathSummary(recorded, on, { start: 0, end: 2 })).toEqual({ moves: 1, straightened: 1, kept: {} })
    const kept = setPathRange(on, { start: 0, end: 2 }, 'recorded')
    expect(pathSummary(recorded, kept)).toEqual({ moves: 2, straightened: 0, kept: { click: 1 } })
    const forced = setPathRange(project(), { start: 3, end: 5 }, 'straight')
    expect(pathSummary(recorded, forced, { start: 3, end: 5 })).toEqual({ moves: 1, straightened: 0, kept: { click: 1 } })
  })

  it('shares the effective track plan: ignoring a click after many summaries keeps the same samples array', () => {
    const on = setStraighten(project(), true)
    const samples = effectiveTrack(recorded, on).samples
    expect(samples).not.toBe(recorded.samples)
    // The Cursor tab recomputes the summary on every project change.
    let p = on
    for (let i = 0; i < 6; i++) {
      p = { ...p, name: `Test ${i}` }
      expect(pathSummary(recorded, p).straightened).toBe(1)
    }
    const ignored = setClicksIgnored(p, recorded, { ignore: [{ ms: 4300 }] })
    expect(ignored.inputEdits?.ignoredClicks).toEqual([{ ms: 4300 }])
    expect(effectiveTrack(recorded, ignored).samples).toBe(samples)
  })

  it('a range edit plans the path once: the check before it and the edit share the plan', () => {
    const p = project()
    const r = { start: 0, end: 2 }
    // The editor paints the range to count what it straightens, then paints it again in store.update.
    const checked = setPathRange(p, r, 'straight')
    expect(pathSummary(recorded, checked, r).straightened).toBe(1)
    const stored = setPathRange(p, r, 'straight')
    expect(stored.inputEdits?.paths).not.toBe(checked.inputEdits?.paths)
    const samples = effectiveTrack(recorded, stored).samples
    const plan = (q: Project) => planCursorPath(recorded, { aspect: q.width / q.height, straighten: false, paths: q.inputEdits?.paths ?? [] })
    expect(plan(stored)).toBe(plan(checked))
    expect(samples).toBe(plan(checked).samples)
  })

  it('is all zero with the cursor in the video or without cursor data', () => {
    const zero = { moves: 0, straightened: 0, kept: {} }
    expect(pathSummary(recorded, project({ capture: { method: 'native', cursorInVideo: true, region: null }, inputEdits: { straighten: true } }))).toEqual(zero)
    expect(pathSummary({ ...recorded, valid: false }, setStraighten(project(), true))).toEqual(zero)
  })
})
