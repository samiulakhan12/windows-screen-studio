import { describe, expect, it } from 'vitest'
import { buildCursorTrack, type RawTrack } from '../src/main/recording/trackMath'
import { SmoothedTrack } from '../src/shared/engine/cursor'
import { ANCHOR_RELEASE, anchorWeight, cameraAt, focusPathFor, generateAutoZooms, regenerateAutoZooms, type Camera } from '../src/shared/engine/zoom'
import { posesFromRects } from '../src/shared/recording/windowGeometry'
import type { ClickEvent, CursorTrack, ZoomSegment } from '../src/shared/types'

/**
 * ux-1: an auto zoom must frame its click, also when the cursor arrives from far outside the
 * recorded frame (another app beside a recorded window or area) just before clicking.
 */

const T0 = 1_700_000_000_000
const DURATION = 6

const contains = (cam: Camera, c: { x: number; y: number }): boolean =>
  Math.abs(c.x - cam.cx) <= 0.5 / cam.scale + 1e-9 && Math.abs(c.y - cam.cy) <= 0.5 / cam.scale + 1e-9

/** The cursor rests at `from` (screen px), moves to `to` in `entryMs` from 2 s on, and clicks there `dwellMs` later. */
function input(from: { x: number; y: number }, to: { x: number; y: number }, entryMs: number, dwellMs: number): RawTrack {
  const samples: RawTrack['samples'] = [{ at: T0 - 500, ...from }]
  const start = T0 + 2000
  for (let ms = 0; ms <= entryMs; ms += 1000 / 60) {
    const k = ms / entryMs
    samples.push({ at: start + ms, x: from.x + (to.x - from.x) * k, y: from.y + (to.y - from.y) * k })
  }
  samples.push({ at: start + entryMs, ...to })
  return { samples, clicks: [{ at: start + entryMs + dwellMs, ...to, button: 'left' }], keys: [], bounds: null, scale: 1 }
}

/** A 600 x 400 window at (300, 200) on a 1920 x 1080 screen; the video is its size. */
function windowTrack(raw: RawTrack): CursorTrack {
  const poses = posesFromRects([{ at: T0 - 1000, x: 300, y: 200, width: 600, height: 400 }])
  return buildCursorTrack(raw, { startedAt: T0, pauses: [], duration: DURATION, region: null, window: { poses, out: { width: 600, height: 400 } } })
}

/** An area of a 1920 x 1080 screen: 576 x 324 px at (576, 324). */
function areaTrack(raw: RawTrack): CursorTrack {
  return buildCursorTrack(
    { ...raw, bounds: { x: 0, y: 0, width: 1920, height: 1080 } },
    { startedAt: T0, pauses: [], duration: DURATION, region: { x: 0.3, y: 0.3, w: 0.3, h: 0.3 } }
  )
}

/** The camera at each click, as the editor and export compute it. */
function camerasAtClicks(track: CursorTrack, zooms = generateAutoZooms(track.clicks, DURATION)): { click: ClickEvent; cam: Camera }[] {
  const focus = focusPathFor(track.samples, DURATION)
  return track.clicks.map((click) => ({ click, cam: cameraAt(zooms, click.t, focus) }))
}

const ENTRIES = [200, 300, 450, 600]
const DWELLS = [200, 250, 300]

describe('auto zoom frames the click (ux-1)', () => {
  it('window recording: a quick entry from another app, then a click 200-300 ms later', () => {
    // Window-relative targets near every edge and the middle; the cursor comes from far right.
    const targets = [
      { x: 60, y: 340 },
      { x: 540, y: 60 },
      { x: 90, y: 300 },
      { x: 300, y: 200 },
      { x: 520, y: 350 },
      { x: 40, y: 40 }
    ]
    let n = 0
    for (const from of [{ x: 1850, y: 1000 }, { x: 1100, y: 150 }, { x: 20, y: 1050 }])
      for (const t of targets)
        for (const entry of ENTRIES)
          for (const dwell of DWELLS) {
            const track = windowTrack(input(from, { x: 300 + t.x, y: 200 + t.y }, entry, dwell))
            expect(track.clicks).toHaveLength(1)
            for (const { click, cam } of camerasAtClicks(track)) {
              expect(cam.scale).toBeGreaterThan(1.7)
              expect(contains(cam, click), `from ${JSON.stringify(from)} to ${JSON.stringify(t)} in ${entry} ms, click ${dwell} ms later: camera ${JSON.stringify(cam)}`).toBe(true)
              n++
            }
          }
    expect(n).toBe(3 * targets.length * ENTRIES.length * DWELLS.length)
  })

  it('area recording: the same from outside the area', () => {
    for (const t of [{ x: 0.1, y: 0.9 }, { x: 0.95, y: 0.05 }, { x: 0.5, y: 0.5 }])
      for (const entry of ENTRIES)
        for (const dwell of DWELLS) {
          const to = { x: 576 + t.x * 576, y: 324 + t.y * 324 }
          const track = areaTrack(input({ x: 1880, y: 1060 }, to, entry, dwell))
          for (const { click, cam } of camerasAtClicks(track)) expect(contains(cam, click), `${JSON.stringify(t)} ${entry}/${dwell}`).toBe(true)
        }
  })

  it('is a case the smoothed cursor alone gets wrong (without anchors or the clamped focus path)', () => {
    let missed = 0
    for (const entry of ENTRIES)
      for (const dwell of DWELLS) {
        const track = windowTrack(input({ x: 1850, y: 1000 }, { x: 360, y: 540 }, entry, dwell))
        const zooms = generateAutoZooms(track.clicks, DURATION).map(({ anchor: _anchor, ...z }) => z)
        const focus = new SmoothedTrack(track.samples, DURATION, 1)
        for (const c of track.clicks) if (!contains(cameraAt(zooms, c.t, focus), c)) missed++
      }
    expect(missed).toBeGreaterThan(0)
  })

  it('anchors each auto zoom to its first click, and regenerating keeps doing so', () => {
    const clicks: ClickEvent[] = [
      { t: 2, x: 0.2, y: 0.3, button: 'left' },
      { t: 3, x: 0.6, y: 0.6, button: 'left' },
      { t: 12, x: 0.9, y: 0.1, button: 'left' }
    ]
    const zooms = generateAutoZooms(clicks, 20)
    expect(zooms.map((z) => z.anchor)).toEqual([
      { t: 2, x: 0.2, y: 0.3 },
      { t: 12, x: 0.9, y: 0.1 }
    ])
    const manual: ZoomSegment = { id: 'm', start: 15, end: 17, scale: 2, focus: { mode: 'cursor' }, auto: false }
    const r = regenerateAutoZooms([...zooms, manual], clicks, 20)
    expect(r.zooms.filter((z) => z.auto).map((z) => z.anchor)).toEqual(zooms.map((z) => z.anchor))
    expect(r.zooms.find((z) => z.id === 'm')!.anchor).toBeUndefined()
  })

  it('hands the camera back to the cursor shortly after the click', () => {
    const seg: ZoomSegment = { id: 'a', start: 1, end: 4, scale: 2, focus: { mode: 'cursor' }, auto: true, anchor: { t: 2, x: 0.3, y: 0.7 } }
    expect(anchorWeight(seg, 1.5)).toBe(1)
    expect(anchorWeight(seg, 2)).toBe(1)
    expect(anchorWeight(seg, 2 + ANCHOR_RELEASE / 2)).toBeCloseTo(0.5)
    expect(anchorWeight(seg, 2 + ANCHOR_RELEASE)).toBe(0)
    // Moved away from its click (by hand): the anchor no longer applies.
    expect(anchorWeight({ ...seg, start: 2.5, end: 5 }, 3)).toBe(0)
    // The cursor sits still at (0.8, 0.2) the whole time.
    const focus = new SmoothedTrack([{ t: 0, x: 0.8, y: 0.2 }], 6, 1)
    const atClick = cameraAt([seg], 2, focus)
    expect(atClick.cx).toBeCloseTo(0.3)
    expect(atClick.cy).toBeCloseTo(0.7)
    const later = cameraAt([seg], 2.5, focus)
    expect(later.cx).toBeCloseTo(0.75)
    expect(later.cy).toBeCloseTo(0.25)
    // A fixed focus is the user's choice: the anchor does not move it.
    const fixed = cameraAt([{ ...seg, focus: { mode: 'fixed', x: 0.5, y: 0.5 } }], 2, focus)
    expect(fixed).toMatchObject({ cx: 0.5, cy: 0.5 })
  })

  it('leaves zooms without an anchor (older projects, manual zooms) following the smoothed cursor', () => {
    const seg: ZoomSegment = { id: 'a', start: 1, end: 4, scale: 2, focus: { mode: 'cursor' }, auto: true }
    const focus = new SmoothedTrack([{ t: 0, x: 0.7, y: 0.3 }], 6, 1)
    expect(cameraAt([seg], 2, focus)).toMatchObject({ scale: 2, cx: expect.closeTo(0.7, 6), cy: expect.closeTo(0.3, 6) })
  })

  it('keeps the focus path inside the frame: positions off it are held at its edge', () => {
    const path = focusPathFor(
      [
        { t: 0, x: 3.5, y: -2 },
        { t: 5, x: 3.5, y: -2 }
      ],
      6
    )
    const p = path.at(4)
    expect(p.x).toBeCloseTo(1)
    expect(p.y).toBeCloseTo(0)
  })
})
