/**
 * Follow scrolling (docs/design/smarter-auto-zoom.md part 3): scroll sessions, breaks, holds and
 * landings in auto zoom, and the golden parity of recordings without scroll data.
 */
import { afterAll, describe, expect, it, vi } from 'vitest'
import { cursorAt } from '../src/shared/engine/cursor'
import { clamp } from '../src/shared/engine/math'
import { isLongScroll, scrollBreaks, scrollSessions } from '../src/shared/engine/scroll'
import {
  autoZoomsForTrack,
  cameraAt,
  DEFAULT_AUTO_ZOOM,
  DEFAULT_ZOOM_SETTINGS,
  focusPathFor,
  ZOOM_MAX_SCALE,
  ZOOM_TRANSITION,
  type AutoZoomOptions
} from '../src/shared/engine/zoom'
import type { AutoZoomSettings, ClickEvent, CursorSample, CursorTrack, ScrollEvent, ScrollZoomMode, ZoomSegment } from '../src/shared/types'

/* ---------- golden parity: every call the zoom fixtures make is checked against the old generator ---------- */

const parity = vi.hoisted(() => ({ calls: 0 }))

vi.mock('../src/shared/engine/zoom', async (importOriginal) => {
  const real = await importOriginal<typeof import('../src/shared/engine/zoom')>()
  return {
    ...real,
    autoZoomsForTrack: (track: CursorTrack, duration: number, settings?: AutoZoomSettings): ZoomSegment[] => {
      const out = real.autoZoomsForTrack(track, duration, settings)
      checkParity(real.autoZoomsForTrack, out, track, duration, settings ?? real.DEFAULT_ZOOM_SETTINGS.auto)
      return out
    },
    generateAutoZooms: (clicks: ClickEvent[], duration: number, options?: Partial<AutoZoomOptions>): ZoomSegment[] => {
      const out = real.generateAutoZooms(clicks, duration, options)
      expect(strip(out)).toEqual(strip(legacyGenerateAutoZooms(clicks, duration, options)))
      parity.calls++
      return out
    }
  }
})

const strip = (zs: ZoomSegment[]): Omit<ZoomSegment, 'id'>[] => zs.map(({ id: _id, ...rest }) => rest)

/** Wheel events every 0.25 s over the whole recording: under 'ignore' they must change nothing. */
function everywhere(duration: number): ScrollEvent[] {
  const out: ScrollEvent[] = []
  for (let t = 0; t <= Math.min(duration, 120); t += 0.25) out.push({ t, x: 0.5, y: 0.5, dx: 0, dy: 1 })
  return out
}

/**
 * `out` (autoZoomsForTrack of `track`) equals the generator as it was before scrolling was
 * recorded when the track has no scrolls, and the same track with `scrolls: []`, and with
 * scrolling everywhere under 'ignore', give exactly the same zooms.
 */
function checkParity(
  generate: (t: CursorTrack, d: number, s?: AutoZoomSettings) => ZoomSegment[],
  out: ZoomSegment[],
  track: CursorTrack,
  duration: number,
  settings: AutoZoomSettings
): void {
  if (track.scrolls === undefined) {
    expect(strip(out)).toEqual(strip(legacyAutoZoomsForTrack(track, duration, settings)))
    expect(strip(generate({ ...track, scrolls: [] }, duration, settings))).toEqual(strip(out))
    expect(strip(generate({ ...track, scrolls: everywhere(duration) }, duration, { ...settings, scrolling: 'ignore' }))).toEqual(strip(out))
    parity.calls++
  }
}

describe('golden parity: the zoom fixtures without scroll data', async () => {
  // Every fixture of these files runs here again, through the checks above.
  await import('./autoZoomTrack.test')
  await import('./zoom.test')
  afterAll(() => {
    // Sanity: the checks above really ran (the two files call the generators more than 30 times).
    expect(parity.calls).toBeGreaterThanOrEqual(30)
  })
})

/** A small deterministic PRNG for the fuzzed fixtures. */
function rng(seed: number): () => number {
  let s = seed >>> 0
  return () => {
    s = (s * 1664525 + 1013904223) >>> 0
    return s / 2 ** 32
  }
}

function randomTrack(seed: number): { track: CursorTrack; duration: number; settings: AutoZoomSettings } {
  const r = rng(seed)
  const duration = r() < 0.15 ? 0.5 + r() * 2 : 5 + r() * 55
  const samples: CursorSample[] = []
  for (let t = 0; t <= duration; t += 0.05 + r() * 0.5) samples.push({ t, x: r() * 1.2 - 0.1, y: r() * 1.2 - 0.1 })
  const clicks: ClickEvent[] = []
  const n = Math.floor(r() * 14)
  for (let i = 0; i < n; i++) {
    const b = r()
    clicks.push({ t: r() * duration, x: r() * 1.1 - 0.05, y: r() * 1.1 - 0.05, button: b < 0.7 ? 'left' : b < 0.9 ? 'right' : 'middle' })
  }
  const typing = Array.from({ length: Math.floor(r() * 4) }, () => {
    const t = r() * duration
    return { t, end: t + r() * 6 }
  })
  const marks = Array.from({ length: Math.floor(r() * 3) }, () => ({ t: r() * duration }))
  const settings: AutoZoomSettings = {
    ...DEFAULT_ZOOM_SETTINGS.auto,
    scale: 1 + r() * 3,
    clusterGap: r() * 6,
    leadIn: r() * 2,
    hold: r() * 4,
    rightClicks: r() < 0.5,
    onTyping: r() < 0.8,
    onMarks: r() < 0.8
  }
  return { track: { samples, clicks, typing, marks, valid: r() > 0.1 }, duration, settings }
}

describe('golden parity: fuzzed recordings without scroll data', () => {
  it('scrolls absent, [] and ignored all give exactly the old zooms', () => {
    for (let seed = 1; seed <= 400; seed++) {
      const { track, duration, settings } = randomTrack(seed)
      // The mocked generator checks absent, [] and 'ignore' against the old one on every call.
      autoZoomsForTrack(track, duration, settings)
      autoZoomsForTrack(track, duration)
    }
  })

  it('a recording without scrolls is also unchanged under hold and zoom-out', () => {
    for (let seed = 401; seed <= 500; seed++) {
      const { track, duration, settings } = randomTrack(seed)
      const old = strip(legacyAutoZoomsForTrack(track, duration, settings))
      for (const scrolling of ['hold', 'zoom-out'] as ScrollZoomMode[]) {
        expect(strip(autoZoomsForTrack(track, duration, { ...settings, scrolling }))).toEqual(old)
        expect(strip(autoZoomsForTrack({ ...track, scrolls: [] }, duration, { ...settings, scrolling }))).toEqual(old)
      }
    }
  })
})

/* ---------- sessions ---------- */

const wheel = (t: number, dy = 1, x = 0.5, y = 0.5, dx = 0): ScrollEvent => ({ t, x, y, dx, dy })
/** Wheel events every `step` seconds from `from` to `to` (inclusive), times rounded to 1 ms. */
function wheels(from: number, to: number, step = 0.1, dy = 1, x = 0.5, y = 0.5): ScrollEvent[] {
  const out: ScrollEvent[] = []
  for (let k = 0; from + k * step <= to + 1e-9; k++) out.push(wheel(Math.round((from + k * step) * 1000) / 1000, dy, x, y))
  return out
}

describe('scrollSessions', () => {
  it('joins events at most 0.8 s apart and splits them 0.81 s apart', () => {
    expect(scrollSessions([wheel(1), wheel(1.8)])).toHaveLength(1)
    expect(scrollSessions([wheel(1), wheel(1.81)])).toHaveLength(2)
  })

  it('records start, end, notches, count and the last position, from unsorted events', () => {
    const [s] = scrollSessions([wheel(2, -2, 0.4, 0.6), wheel(1, 1, 0.1, 0.1, 1), wheel(1.5, 0, 0.2, 0.2)])
    expect(s).toEqual({ start: 1, end: 2, notches: 4, count: 3, last: { x: 0.4, y: 0.6 } })
  })

  it('is empty without scroll data', () => {
    expect(scrollSessions(undefined)).toEqual([])
    expect(scrollSessions([])).toEqual([])
  })

  it('cuts at instants strictly inside a session; an event exactly at a cut starts the next one', () => {
    const events = wheels(3, 7)
    const [a, b] = scrollSessions(events, [5])
    expect([a.start, a.end, b.start, b.end]).toEqual([3, 4.9, 5, 7])
    expect(a.count + b.count).toBe(41)
    // A cut between two events splits them too, and cuts outside change nothing.
    expect(scrollSessions([wheel(1), wheel(1.4)], [1.2]).map((s) => s.start)).toEqual([1, 1.4])
    expect(scrollSessions(events, [1, 3, 9])).toHaveLength(1)
  })

  it('a long scroll lasts 1.5 s with at least 4 notches', () => {
    const [four] = scrollSessions([wheel(0), wheel(0.5), wheel(1), wheel(1.5)])
    const [three] = scrollSessions([wheel(0), wheel(0.75), wheel(1.5)])
    const [quick] = scrollSessions(wheels(0, 1.4, 0.1))
    expect(isLongScroll(four)).toBe(true)
    expect(isLongScroll(three)).toBe(false)
    expect(isLongScroll(quick)).toBe(false)
  })
})

/* ---------- the worked examples (§6.5, defaults, duration 20) ---------- */

const D = 20
const click = (t: number, x = 0.5, y = 0.5, button: ClickEvent['button'] = 'left'): ClickEvent => ({ t, x, y, button })
const A = click(2, 0.3, 0.3)
const B = click(12, 0.7, 0.6)
const MAIN = wheels(3, 7)

function scrollTrack(clicks: ClickEvent[], scrolls: ScrollEvent[] | undefined, extra: Partial<CursorTrack> = {}): CursorTrack {
  // The cursor rests at A, then at (0.5, 0.5) while scrolling, then at B.
  const samples: CursorSample[] = [
    { t: 0, x: 0.3, y: 0.3 },
    { t: 2.5, x: 0.3, y: 0.3 },
    { t: 2.6, x: 0.5, y: 0.5 },
    { t: 11, x: 0.5, y: 0.5 },
    { t: 11.5, x: 0.7, y: 0.6 },
    { t: D, x: 0.7, y: 0.6 }
  ]
  return { samples, clicks, valid: true, ...(scrolls ? { scrolls } : {}), ...extra }
}

const auto = (scrolling: ScrollZoomMode): AutoZoomSettings => ({ ...DEFAULT_ZOOM_SETTINGS.auto, scrolling })
const r6 = (v: number): number => Math.round(v * 1e6) / 1e6
const spans = (zs: ZoomSegment[]): [number, number][] => zs.map((z) => [r6(z.start), r6(z.end)])
const anchorOf = (z: ZoomSegment) => z.anchor && { t: r6(z.anchor.t), x: z.anchor.x, y: z.anchor.y }

describe('auto zoom while scrolling: the main example', () => {
  const track = scrollTrack([A, B], MAIN)

  it("'zoom-out': out for the long scroll, back in where it stopped", () => {
    const zs = autoZoomsForTrack(track, D, auto('zoom-out'))
    expect(spans(zs)).toEqual([
      [1.1, 3.35],
      [7.2, 9.9],
      [11.1, 13.8]
    ])
    expect(anchorOf(zs[0])).toEqual({ t: 2, x: 0.3, y: 0.3 })
    expect(anchorOf(zs[1])).toEqual({ t: 8.1, x: 0.5, y: 0.5 })
    expect(anchorOf(zs[2])).toEqual({ t: 12, x: 0.7, y: 0.6 })
    expect(zs.every((z) => z.auto && z.scale === DEFAULT_AUTO_ZOOM.scale)).toBe(true)
    // A's zoom starts leaving at 2.65 s; the camera shows the whole frame at 5.0 s and is fully in on the landing at 7.9 s.
    expect(zs[0].end - ZOOM_TRANSITION).toBeCloseTo(2.65, 9)
    const focus = focusPathFor(track.samples, D)
    expect(cameraAt(zs, 5.0, focus).scale).toBe(1)
    expect(cameraAt(zs, 2.6, focus).scale).toBeCloseTo(DEFAULT_AUTO_ZOOM.scale, 9)
    expect(cameraAt(zs, 7.9, focus).scale).toBeCloseTo(DEFAULT_AUTO_ZOOM.scale, 9)
    expect(cameraAt(zs, 7.5, focus).scale).toBeLessThan(DEFAULT_AUTO_ZOOM.scale)
  })

  it("'hold': the zoom stays in until hold after the scroll", () => {
    expect(spans(autoZoomsForTrack(track, D, auto('hold')))).toEqual([
      [1.1, 8.8],
      [11.1, 13.8]
    ])
  })

  it("'ignore', no scroll data and scrolls: [] give today's zooms", () => {
    const today = [
      [1.1, 3.8],
      [11.1, 13.8]
    ]
    expect(spans(autoZoomsForTrack(track, D, auto('ignore')))).toEqual(today)
    expect(spans(autoZoomsForTrack(scrollTrack([A, B], undefined), D, auto('zoom-out')))).toEqual(today)
    expect(spans(autoZoomsForTrack(scrollTrack([A, B], []), D, auto('zoom-out')))).toEqual(today)
  })

  it('absent settings.scrolling means zoom-out', () => {
    const { scrolling: _s, ...old } = auto('zoom-out')
    expect(spans(autoZoomsForTrack(track, D, old))).toEqual(spans(autoZoomsForTrack(track, D, auto('zoom-out'))))
  })

  it('scrollBreaks reports the long scroll in zoom-out mode only', () => {
    const [b] = scrollBreaks(track, auto('zoom-out'))
    expect(b).toMatchObject({ start: 3, end: 7, notches: 41, count: 41, last: { x: 0.5, y: 0.5 } })
    expect(scrollBreaks(track, auto('hold'))).toEqual([])
    expect(scrollBreaks(track, auto('ignore'))).toEqual([])
    expect(scrollBreaks(track, { ...auto('zoom-out'), enabled: false })).toEqual([])
    expect(scrollBreaks(scrollTrack([A, B], undefined), auto('zoom-out'))).toEqual([])
  })

  it('scrolling alone never creates a zoom', () => {
    for (const mode of ['zoom-out', 'hold'] as ScrollZoomMode[]) expect(autoZoomsForTrack(scrollTrack([], MAIN), D, auto(mode))).toEqual([])
  })
})

describe('auto zoom while scrolling: variants', () => {
  it('a 3-notch scroll is short: it holds the zoom (A ends at 5.0)', () => {
    const zs = autoZoomsForTrack(scrollTrack([A, B], [wheel(3.0), wheel(3.1), wheel(3.2)]), D, auto('zoom-out'))
    expect(spans(zs)).toEqual([
      [1.1, 5],
      [11.1, 13.8]
    ])
  })

  it('no landing when the zoom had ended before the scroll began', () => {
    const zs = autoZoomsForTrack(scrollTrack([A, B], wheels(5, 9)), D, auto('zoom-out'))
    expect(spans(zs)).toEqual([
      [1.1, 3.8],
      [11.1, 13.8]
    ])
  })

  it('no landing when a click follows within 1.5 s; that click starts its zoom once the page settled', () => {
    const zs = autoZoomsForTrack(scrollTrack([A, click(7.5, 0.6, 0.4)], MAIN), D, auto('zoom-out'))
    expect(spans(zs)).toEqual([
      [1.1, 3.35],
      [7.2, 9.4]
    ])
    expect(anchorOf(zs[1])?.t).toBe(7.5)
  })

  it('a click inside the scroll splits it into two breaks; its own zoom is too short and dropped', () => {
    const track = scrollTrack([A, click(5, 0.4, 0.4), B], MAIN)
    const breaks = scrollBreaks(track, auto('zoom-out'))
    expect(breaks.map((b) => [b.start, b.end])).toEqual([
      [3, 4.9],
      [5, 7]
    ])
    const zs = autoZoomsForTrack(track, D, auto('zoom-out'))
    expect(spans(zs)).toEqual([
      [1.1, 3.35],
      [7.2, 9.9],
      [11.1, 13.8]
    ])
    expect(anchorOf(zs[1])).toEqual({ t: 8.1, x: 0.5, y: 0.5 })
  })

  it('typing over a scroll keeps the zoom on the field: no break', () => {
    const track = scrollTrack([A, B], MAIN, { typing: [{ t: 3.5, end: 7.5 }] })
    expect(scrollBreaks(track, auto('zoom-out'))).toEqual([])
    const zs = autoZoomsForTrack(track, D, auto('zoom-out'))
    // The typing zoom (from the click into the field at 2.0) holds through the scroll.
    expect(zs.some((z) => z.start <= 3 && z.end >= 7.5)).toBe(true)
  })

  it('no landing past the end of the recording', () => {
    const zs = autoZoomsForTrack(scrollTrack([A], MAIN), 8, auto('zoom-out'))
    expect(spans(zs)).toEqual([[1.1, 3.35]])
  })

  it('a second long scroll starting before the landing: the camera stays out and lands after it', () => {
    // 3-7 s, a 0.9 s pause (more than the 0.8 s join, less than 0.2 + lead-in), then 7.9-10 s.
    const track = scrollTrack([A], [...MAIN, ...wheels(7.9, 10)])
    expect(scrollBreaks(track, auto('zoom-out')).map((b) => [b.start, b.end])).toEqual([
      [3, 7],
      [7.9, 10]
    ])
    const zs = autoZoomsForTrack(track, D, auto('zoom-out'))
    expect(spans(zs)).toEqual([
      [1.1, 3.35],
      [10.2, 12.9]
    ])
    expect(anchorOf(zs[1])).toEqual({ t: 11.1, x: 0.5, y: 0.5 })
    const focus = focusPathFor(track.samples, D)
    for (const t of [7.5, 8, 8.5, 9, 9.9]) expect(cameraAt(zs, t, focus).scale).toBe(1)
    expect(cameraAt(zs, 11.1, focus).scale).toBeCloseTo(DEFAULT_AUTO_ZOOM.scale, 9)
    // A 1.3 s pause leaves room to land in between: the first landing is bounded by the second scroll, which lands too.
    expect(spans(autoZoomsForTrack(scrollTrack([A], [...MAIN, ...wheels(8.3, 10)]), D, auto('zoom-out')))).toEqual([
      [1.1, 3.35],
      [7.2, 8.65],
      [10.2, 12.9]
    ])
  })

  it('a short scroll after a long one does not keep the zoom from before it in (long hold)', () => {
    const settings = { ...auto('zoom-out'), hold: 3 }
    // A 17-notch long scroll right after A, then a 2-notch scroll at 4.7-4.8 s.
    const track = scrollTrack([A], [...wheels(2.2, 3.8), ...wheels(4.7, 4.8)])
    expect(scrollBreaks(track, settings).map((b) => [b.start, b.end])).toEqual([[2.2, 3.8]])
    const zs = autoZoomsForTrack(track, D, settings)
    expect(spans(zs)).toEqual([
      [1.1, 2.55],
      [4, 7.9]
    ])
    expect(cameraAt(zs, 3, focusPathFor(track.samples, D)).scale).toBe(1)
  })

  it('a zoom is never clustered or merged across a break', () => {
    // Clicks 3 s apart cluster today; with a long scroll between them they are two zooms.
    const track = scrollTrack([click(2), click(4.9)], wheels(2.5, 4.4))
    const today = autoZoomsForTrack(track, D, auto('ignore'))
    expect(spans(today)).toEqual([[1.1, 6.7]])
    const zs = autoZoomsForTrack(track, D, auto('zoom-out'))
    expect(spans(zs)).toEqual([
      [1.1, 2.85],
      [4.6, 6.8]
    ])
  })
})

describe('auto zoom while scrolling: the variants in every mode', () => {
  const cases: { name: string; track: CursorTrack; zoomOut: [number, number][]; hold: [number, number][]; ignore: [number, number][] }[] = [
    {
      name: 'a 3-notch scroll at 3.0-3.2 s',
      track: scrollTrack([A, B], [wheel(3.0), wheel(3.1), wheel(3.2)]),
      zoomOut: [[1.1, 5], [11.1, 13.8]],
      hold: [[1.1, 5], [11.1, 13.8]],
      ignore: [[1.1, 3.8], [11.1, 13.8]]
    },
    {
      name: 'a long scroll at 5-9 s, after A ended',
      track: scrollTrack([A, B], wheels(5, 9)),
      zoomOut: [[1.1, 3.8], [11.1, 13.8]],
      hold: [[1.1, 3.8], [11.1, 13.8]],
      ignore: [[1.1, 3.8], [11.1, 13.8]]
    },
    {
      name: 'click B at 7.5 s after the 3-7 s scroll',
      track: scrollTrack([A, click(7.5, 0.6, 0.4)], MAIN),
      zoomOut: [[1.1, 3.35], [7.2, 9.4]],
      hold: [[1.1, 9.3]],
      ignore: [[1.1, 3.8], [6.6, 9.3]]
    },
    {
      name: 'a click at 5.0 s inside the 3-7 s scroll',
      track: scrollTrack([A, click(5, 0.4, 0.4), B], MAIN),
      zoomOut: [[1.1, 3.35], [7.2, 9.9], [11.1, 13.8]],
      hold: [[1.1, 8.8], [11.1, 13.8]],
      ignore: [[1.1, 6.8], [11.1, 13.8]]
    }
  ]
  for (const c of cases) {
    it(c.name, () => {
      expect(spans(autoZoomsForTrack(c.track, D, auto('zoom-out')))).toEqual(c.zoomOut)
      expect(spans(autoZoomsForTrack(c.track, D, auto('hold')))).toEqual(c.hold)
      expect(spans(autoZoomsForTrack(c.track, D, auto('ignore')))).toEqual(c.ignore)
    })
  }
})

/* ---------- the generator as it was before scrolling was recorded (5dbaccb), verbatim ---------- */

let legacyId = 0
const newZoomId = (): string => `legacy${legacyId++}`

const inUnit = (p: { x: number; y: number }): boolean => p.x >= 0 && p.x <= 1 && p.y >= 0 && p.y <= 1

/**
 * Left clicks that landed on the captured display. Clicks on other monitors are
 * normalised outside 0..1 and must never become zooms aimed at the frame edge.
 */
function isUsableClick(c: ClickEvent): boolean {
  return c.button === 'left' && Number.isFinite(c.t) && inUnit(c)
}

/** Clicks that create auto zooms: left clicks, and right clicks when asked for. */
function isZoomClick(c: ClickEvent, rightClicks = false): boolean {
  return (c.button === 'left' || (rightClicks && c.button === 'right')) && Number.isFinite(c.t) && inUnit(c)
}

/** Something recorded that deserves a zoom: it spans t0..t1 and the zoom aims at `anchor`. */
interface ZoomEvent {
  t0: number
  t1: number
  anchor: { t: number; x: number; y: number }
  /** Typing into the field at `anchor` from t0 to t1: the zoom holds its aim there for as long as it lasts. */
  typing?: boolean
}

/** Places closer than this (normalised units) are the same field: one zoom aims at both. */
const SAME_FIELD = 0.08

const near = (a: { x: number; y: number }, b: { x: number; y: number }): boolean => Math.hypot(a.x - b.x, a.y - b.y) < SAME_FIELD

/** Consecutive events of one zoom that aim at the same thing: clicks and marks together, or one typing session. */
interface ZoomPart {
  t0: number
  t1: number
  anchor: ZoomEvent['anchor']
  typing: boolean
  events: ZoomEvent[]
}

/** The parts of one zoom: typing on its own (with clicks into the same field), clicks and marks between. */
function zoomParts(events: ZoomEvent[]): ZoomPart[] {
  const parts: ZoomPart[] = []
  for (const e of events) {
    const last = parts[parts.length - 1]
    if (last && !e.typing && !last.typing) {
      last.t1 = Math.max(last.t1, e.t1)
      last.events.push(e)
    } else {
      parts.push({ t0: e.t0, t1: e.t1, anchor: { ...e.anchor }, typing: !!e.typing, events: [e] })
    }
  }
  // Clicking into a field and typing there (or typing on after a pause) is one part aimed at the field.
  const sameField = (a: ZoomPart, b: ZoomPart): boolean => {
    if (!a.typing && !b.typing) return false
    const field = a.typing ? a.anchor : b.anchor
    return [...a.events, ...b.events].every((e) => near(e.anchor, field))
  }
  for (let i = 0; i + 1 < parts.length; ) {
    const a = parts[i]
    const b = parts[i + 1]
    if (!sameField(a, b)) {
      i++
      continue
    }
    const field = a.typing ? a.anchor : b.anchor
    parts.splice(i, 2, { t0: a.t0, t1: Math.max(a.t1, b.t1), anchor: { ...field }, typing: true, events: [...a.events, ...b.events] })
  }
  return parts
}

/**
 * The zoom segments of one range [start, end]: one per part, back to back, so the camera pans
 * from one part to the next without zooming out. A part's segment begins leadIn before it (or
 * halfway from the previous part when that is closer, never before the previous part ends).
 * Click parts aim at their first event as zooms always have; typing parts look at their field
 * for the whole segment (an anchor spanning the typing, see anchorWeight), at `typingScale`.
 */
function rangeSegments(r: { start: number; end: number; events: ZoomEvent[] }, o: AutoZoomOptions, typingScale: number): ZoomSegment[] {
  const parts = zoomParts(r.events)
  const bounds = [r.start]
  for (let i = 1; i < parts.length; i++) {
    const prev = parts[i - 1]
    const next = parts[i]
    bounds.push(clamp(Math.max(next.t0 - o.leadIn, (prev.t1 + next.t0) / 2), bounds[i - 1], r.end))
  }
  bounds.push(r.end)
  const segments: ZoomSegment[] = []
  parts.forEach((part, i) => {
    const start = bounds[i]
    const end = bounds[i + 1]
    // Only when clamped to the recording's end: nothing is left of this part, the previous one goes on.
    if (end - start < 0.05) {
      const prev = segments[segments.length - 1]
      if (prev) prev.end = end
      else bounds[i + 1] = start
      return
    }
    // Typing spans its whole part (from the click into the field to the last key), not one instant.
    const anchor = part.typing ? { t: part.t0, x: part.anchor.x, y: part.anchor.y, until: part.t1 } : { ...part.anchor }
    segments.push({ id: newZoomId(), start, end, scale: part.typing ? typingScale : o.scale, focus: { mode: 'cursor' }, auto: true, anchor })
  })
  return segments
}

/**
 * Zoom segments from recorded events: events closer than clusterGap share one zoom, which
 * starts leadIn before the first and holds until `hold` after the last; segments whose
 * transitions would overlap are merged (no zoom-out/in dip). Each zoom aims at its first
 * event; typing gets its own part of the zoom, aimed at the field for as long as it lasts,
 * joined to the clicks around it by a pan.
 */
function zoomsFromEvents(events: ZoomEvent[], duration: number, o: AutoZoomOptions, typingScale = o.scale): ZoomSegment[] {
  const sorted = [...events].sort((a, b) => a.t0 - b.t0)
  const ranges: { start: number; end: number; last: number; events: ZoomEvent[] }[] = []
  for (const e of sorted) {
    const cur = ranges[ranges.length - 1]
    if (cur && e.t0 - cur.last <= o.clusterGap) {
      cur.last = Math.max(cur.last, e.t1)
      cur.end = Math.max(cur.end, e.t1 + o.hold)
      cur.events.push(e)
    } else {
      ranges.push({ start: e.t0 - o.leadIn, end: e.t1 + o.hold, last: e.t1, events: [e] })
    }
  }
  const zooms: { start: number; end: number; events: ZoomEvent[] }[] = []
  for (const r of ranges) {
    let start = clamp(r.start, 0, duration)
    let end = clamp(Math.max(r.end, start + o.minDuration), 0, duration)
    if (end - start < 2 * ZOOM_TRANSITION) {
      start = clamp(end - 2 * ZOOM_TRANSITION, 0, duration)
      end = clamp(start + 2 * ZOOM_TRANSITION, 0, duration)
    }
    const prev = zooms[zooms.length - 1]
    // Merge segments whose transitions would overlap, to avoid a zoom-out/in "dip".
    if (prev && start - prev.end < ZOOM_TRANSITION) {
      prev.end = Math.max(prev.end, end)
      prev.events.push(...r.events)
      continue
    }
    if (end - start > 0.2) zooms.push({ start, end, events: [...r.events] })
  }
  return zooms.flatMap((r) => rangeSegments(r, o, typingScale))
}

const clickEvent = (c: ClickEvent): ZoomEvent => ({ t0: c.t, t1: c.t, anchor: { t: c.t, x: c.x, y: c.y } })

/** Builds zoom segments from click clusters: zoom in just before a click, hold, ease out. */
function legacyGenerateAutoZooms(
  clicks: ClickEvent[],
  duration: number,
  options: Partial<AutoZoomOptions> = {}
): ZoomSegment[] {
  return zoomsFromEvents(clicks.filter((c) => isUsableClick(c)).map(clickEvent), duration, { ...DEFAULT_AUTO_ZOOM, ...options })
}

/** How far back (seconds) a click still counts as "the field being typed into". */
const TYPING_CLICK_WINDOW = 10
/** A click this shortly before typing (seconds) is the click into the field: they are one zoom. */
const TYPING_CLICK_JOIN = 5
/** Typing shorter than this (seconds: a lone key, a quick "ok") makes no zoom of its own. */
const TYPING_MIN_LENGTH = 0.5
/** Pauses between typing bursts up to this long (seconds) keep the zoom in: thinking mid-sentence. */
const TYPING_PAUSE = 6

/**
 * Level of a typing zoom: text needs a closer look than a click, so a step (20%) closer than
 * click zooms, up to 2.2× (a level already above that is kept, never lowered).
 */
function typingScale(scale: number): number {
  return Math.max(scale, Math.min(scale * 1.2, 2.2))
}

/** Where a typing burst starting at `t` types into: the last click before it, else the cursor. */
function typingPlace(track: CursorTrack, t: number, rightClicks: boolean): { x: number; y: number } {
  let click: ClickEvent | null = null
  for (const c of track.clicks) {
    if (c.t <= t && c.t >= t - TYPING_CLICK_WINDOW && isZoomClick(c, rightClicks) && (!click || c.t >= click.t)) click = c
  }
  if (click) return { x: click.x, y: click.y }
  return cursorPlace(track, t)
}

/** The recorded cursor position at `t`, kept on the frame (centre without cursor data). */
function cursorPlace(track: CursorTrack, t: number): { x: number; y: number } {
  const p = cursorAt(track.samples, t)
  return p ? { x: clamp(p.x, 0, 1), y: clamp(p.y, 0, 1) } : { x: 0.5, y: 0.5 }
}

/** A stretch of typing into one field, with the click into it (when there was one just before). */
interface TypingSession {
  t0: number
  t1: number
  place: { x: number; y: number }
  click: ClickEvent | null
}

/**
 * Typing sessions from the recorded bursts: bursts with pauses up to `pause` between them and
 * no click in between are one session (a click means another field, or the same one again:
 * then the sessions join later, being at the same place). Sessions shorter than
 * TYPING_MIN_LENGTH are dropped. A session takes the last zoom click up to TYPING_CLICK_JOIN
 * before it (after the previous session) as the click into its field.
 */
function typingSessions(track: CursorTrack, clicks: readonly ClickEvent[], pause: number, rightClicks: boolean): TypingSession[] {
  const bursts = (track.typing ?? [])
    .filter((b) => Number.isFinite(b.t) && Number.isFinite(b.end))
    .map((b) => ({ t0: b.t, t1: Math.max(b.t, b.end) }))
    .sort((a, b) => a.t0 - b.t0)
  const runs: { t0: number; t1: number }[] = []
  for (const b of bursts) {
    const cur = runs[runs.length - 1]
    if (cur && b.t0 - cur.t1 <= pause && !clicks.some((c) => c.t > cur.t1 && c.t < b.t0)) cur.t1 = Math.max(cur.t1, b.t1)
    else runs.push({ ...b })
  }
  const sessions: TypingSession[] = []
  let after = -Infinity
  for (const r of runs) {
    if (r.t1 - r.t0 < TYPING_MIN_LENGTH) continue
    let click: ClickEvent | null = null
    for (const c of clicks) if (c.t <= r.t0 && c.t > after && (!click || c.t >= click.t)) click = c
    const into = click && r.t0 - click.t <= TYPING_CLICK_JOIN ? click : null
    sessions.push({ t0: into ? into.t : r.t0, t1: r.t1, place: into ? { x: into.x, y: into.y } : typingPlace(track, r.t0, rightClicks), click: into })
    after = r.t1
  }
  return sessions
}

/**
 * Auto zoom segments for a whole cursor track: clicks (right clicks too when enabled),
 * typing (see below) and "zoom here" marks (aimed at the cursor). Overlapping results are
 * merged. Every zoom carries an anchor.
 *
 * Typing: bursts a short pause apart are one session, which holds the zoom in until it ends
 * (plus the hold) instead of zooming out mid-sentence. It aims at the place being typed into,
 * the last click up to TYPING_CLICK_WINDOW before it, else the cursor where it starts, for its
 * whole length (the idle mouse is never chased), a little closer than click zooms
 * (typingScale). The click into the field just before and the typing are one zoom; clicks and
 * marks elsewhere in the same zoom pan to their own place and back. Typing too short to read
 * makes no zoom of its own.
 *
 * Scrolling (track.scrolls with settings.scrolling, docs/design/smarter-auto-zoom.md part 3):
 * 'zoom-out' (the default) zooms out during long scrolls and back in where they stop, short
 * scrolls hold the zoom; 'hold' holds through every scroll. Without scroll data (older
 * recordings, or `scrolls: []`) or with 'ignore' the result is exactly what it was before
 * scrolling was recorded.
 * CONTRACT: used by recording finalize and by "Regenerate", always with the effective track
 * (shared/engine/inputTrack.ts effectiveTrack), so ignored clicks stay ignored.
 */
function legacyAutoZoomsForTrack(track: CursorTrack, duration: number, settings: AutoZoomSettings = DEFAULT_ZOOM_SETTINGS.auto): ZoomSegment[] {
  if (!settings.enabled) return []
  const o: AutoZoomOptions = {
    scale: clamp(settings.scale, 1.05, ZOOM_MAX_SCALE),
    clusterGap: Math.max(0, settings.clusterGap),
    leadIn: Math.max(0, settings.leadIn),
    hold: Math.max(0, settings.hold),
    minDuration: DEFAULT_AUTO_ZOOM.minDuration
  }
  const clicks = track.clicks.filter((c) => isZoomClick(c, settings.rightClicks)).sort((a, b) => a.t - b.t)
  const sessions = track.valid !== false && settings.onTyping ? typingSessions(track, clicks, Math.max(TYPING_PAUSE, o.clusterGap), settings.rightClicks) : []
  // Clicks into a field, and clicks and marks while typing, belong to the typing.
  const typed = (t: number): boolean => sessions.some((s) => t >= s.t0 && t <= s.t1)
  const events: ZoomEvent[] = clicks.filter((c) => !sessions.some((s) => s.click === c) && !typed(c.t)).map(clickEvent)
  for (const s of sessions) events.push({ t0: s.t0, t1: s.t1, anchor: { t: s.t0, ...s.place }, typing: true })
  if (settings.onMarks) {
    for (const m of track.marks ?? []) {
      if (!Number.isFinite(m.t) || typed(m.t)) continue
      events.push({ t0: m.t, t1: m.t, anchor: { t: m.t, ...cursorPlace(track, m.t) } })
    }
  }
  const zooms = zoomsFromEvents(events, duration, o, typingScale(o.scale))
  // Without cursor data there is no cursor to follow: look at the anchor instead.
  return track.valid === false ? zooms.map((z) => ({ ...z, focus: { mode: 'fixed', x: z.anchor?.x ?? 0.5, y: z.anchor?.y ?? 0.5 } })) : zooms
}

