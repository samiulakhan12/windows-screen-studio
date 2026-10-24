import { describe, expect, it } from 'vitest'
import { disconnectFromNext } from '../src/shared/editor/zoomEdit'
import {
  anchorWeight,
  autoZoomsForTrack,
  cameraAt,
  cameraFor,
  clampZooms,
  DEFAULT_ZOOM_SETTINGS,
  focusPathFor,
  generateAutoZooms,
  regenerateAutoZooms,
  TYPING_CLICK_WINDOW,
  typingScale,
  zoomsConnected,
  zoomSettingsOf
} from '../src/shared/engine/zoom'
import type { AutoZoomSettings, ClickEvent, CursorSample, CursorTrack, ZoomSegment } from '../src/shared/types'

const AUTO = DEFAULT_ZOOM_SETTINGS.auto
const settings = (patch: Partial<AutoZoomSettings> = {}): AutoZoomSettings => ({ ...AUTO, ...patch })
const click = (t: number, x = 0.5, y = 0.5, button: ClickEvent['button'] = 'left'): ClickEvent => ({ t, x, y, button })

function track(extra: Partial<CursorTrack> = {}): CursorTrack {
  // The cursor sits at (0.8, 0.3) until 10 s, then at (0.2, 0.7).
  return {
    samples: [
      { t: 0, x: 0.8, y: 0.3 },
      { t: 10, x: 0.8, y: 0.3 },
      { t: 10.01, x: 0.2, y: 0.7 },
      { t: 60, x: 0.2, y: 0.7 }
    ],
    clicks: [],
    valid: true,
    ...extra
  }
}

const covers = (z: ZoomSegment, t: number): boolean => t >= z.start && t <= z.end

describe('autoZoomsForTrack', () => {
  it('matches generateAutoZooms for left clicks with the default settings', () => {
    const clicks = [click(2, 0.2, 0.3), click(3, 0.6, 0.6), click(12, 0.9, 0.1)]
    const strip = (zs: ZoomSegment[]) => zs.map(({ id: _id, ...rest }) => rest)
    expect(strip(autoZoomsForTrack(track({ clicks }), 30))).toEqual(strip(generateAutoZooms(clicks, 30)))
  })

  it('creates nothing when auto zoom is off', () => {
    expect(autoZoomsForTrack(track({ clicks: [click(2)], marks: [{ t: 5 }] }), 30, settings({ enabled: false }))).toEqual([])
  })

  it('uses the level, lead-in and hold from the settings', () => {
    const [z] = autoZoomsForTrack(track({ clicks: [click(5)] }), 30, settings({ scale: 2.6, leadIn: 1.5, hold: 3 }))
    expect(z.scale).toBe(2.6)
    expect(z.start).toBeCloseTo(3.5)
    expect(z.end).toBeCloseTo(8)
    expect(z.auto).toBe(true)
  })

  it('clusters clicks with the cluster gap', () => {
    const clicks = [click(2), click(4.5)]
    expect(autoZoomsForTrack(track({ clicks }), 30, settings({ clusterGap: 3 }))).toHaveLength(1)
    expect(autoZoomsForTrack(track({ clicks: [click(2), click(8)] }), 30, settings({ clusterGap: 1 }))).toHaveLength(2)
  })

  it('ignores right clicks unless enabled, and clicks outside the frame always', () => {
    const clicks = [click(3, 0.4, 0.4, 'right'), click(15, 1.3, 0.5, 'right')]
    expect(autoZoomsForTrack(track({ clicks }), 30)).toEqual([])
    const zs = autoZoomsForTrack(track({ clicks }), 30, settings({ rightClicks: true }))
    expect(zs).toHaveLength(1)
    expect(zs[0].anchor).toEqual({ t: 3, x: 0.4, y: 0.4 })
  })

  it('zooms on a typing burst at the field clicked just before, for the whole burst and its hold', () => {
    const t = track({ clicks: [click(4, 0.3, 0.6)], typing: [{ t: 5, end: 9 }] })
    const zs = autoZoomsForTrack(t, 30)
    expect(zs).toHaveLength(1)
    const [z] = zs
    expect(z.start).toBeCloseTo(4 - AUTO.leadIn)
    expect(z.end).toBeCloseTo(9 + AUTO.hold)
    // Aimed at the clicked field from the click to the last key (and so for the whole zoom), a step closer than a click zoom.
    expect(z.anchor).toEqual({ t: 4, x: 0.3, y: 0.6, until: 9 })
    expect(z.scale).toBeCloseTo(typingScale(AUTO.scale))
  })

  it('repeated clicks at one place keep aiming from the first click, as before', () => {
    const [z] = autoZoomsForTrack(track({ clicks: [click(4, 0.3, 0.6), click(5.5, 0.3, 0.6)] }), 30)
    expect(z.anchor).toEqual({ t: 4, x: 0.3, y: 0.6 })
  })

  it('a click long before the typing is its own zoom; the typing still aims at it within 10 s', () => {
    const t = track({ clicks: [click(1, 0.3, 0.6)], typing: [{ t: 8, end: 10 }] })
    const zs = autoZoomsForTrack(t, 40)
    expect(zs).toHaveLength(2)
    const typing = zs[1]
    expect(typing.start).toBeCloseTo(8 - AUTO.leadIn)
    expect(typing.end).toBeCloseTo(10 + AUTO.hold)
    expect(typing.anchor).toEqual({ t: 8, x: 0.3, y: 0.6, until: 10 })
  })

  it('without a recent click, a typing burst aims at the cursor where it starts', () => {
    const t = track({ clicks: [click(1, 0.3, 0.6)], typing: [{ t: 1 + TYPING_CLICK_WINDOW + 5, end: 18 }] })
    const typing = autoZoomsForTrack(t, 40).find((z) => covers(z, 17))!
    expect(typing.anchor).toEqual({ t: 16, x: 0.2, y: 0.7, until: 18 })
    // No cursor data at all: the centre.
    const blind = autoZoomsForTrack({ samples: [], clicks: [], valid: true, typing: [{ t: 3, end: 4 }] }, 20)
    expect(blind[0].anchor).toEqual({ t: 3, x: 0.5, y: 0.5, until: 4 })
  })

  it('typing zooms can be turned off', () => {
    expect(autoZoomsForTrack(track({ typing: [{ t: 5, end: 9 }] }), 30, settings({ onTyping: false }))).toEqual([])
  })

  it('zooms at "zoom here" marks, aimed at the cursor there', () => {
    const zs = autoZoomsForTrack(track({ marks: [{ t: 3 }, { t: 20 }] }), 40)
    expect(zs).toHaveLength(2)
    expect(zs[0].anchor).toEqual({ t: 3, x: 0.8, y: 0.3 })
    expect(zs[1].anchor).toEqual({ t: 20, x: 0.2, y: 0.7 })
    expect(covers(zs[0], 3) && covers(zs[1], 20)).toBe(true)
    expect(autoZoomsForTrack(track({ marks: [{ t: 3 }] }), 40, settings({ onMarks: false }))).toEqual([])
  })

  it('without cursor data, marks still zoom (on a fixed point) and typing does not', () => {
    const blind: CursorTrack = { samples: [], clicks: [], valid: false, marks: [{ t: 4 }], typing: [{ t: 10, end: 12 }] }
    const zs = autoZoomsForTrack(blind, 30)
    expect(zs).toHaveLength(1)
    expect(zs[0].focus).toEqual({ mode: 'fixed', x: 0.5, y: 0.5 })
    expect(covers(zs[0], 4)).toBe(true)
  })

  it('joins clicks, typing and marks into zooms that never overlap, each part anchored', () => {
    const t = track({
      clicks: [click(2, 0.1, 0.1), click(30, 0.9, 0.9, 'right')],
      typing: [{ t: 2.5, end: 5 }, { t: 40, end: 41 }],
      marks: [{ t: 5.5 }, { t: 41.5 }]
    })
    const zs = autoZoomsForTrack(t, 60, settings({ rightClicks: true }))
    for (let i = 1; i < zs.length; i++) expect(zs[i].start).toBeGreaterThanOrEqual(zs[i - 1].end - 1e-9)
    for (const z of zs) {
      expect(z.anchor).toBeDefined()
      expect(z.anchor!.t).toBeGreaterThanOrEqual(z.start)
      expect(z.anchor!.t).toBeLessThanOrEqual(z.end)
    }
    expect(zs.every((z) => z.end <= 60 && z.start >= 0)).toBe(true)
    // Three zooms: the field clicked at 2 s (typing, then a pan to the mark at 5.5 s), the right
    // click at 30 s, and the typing at 40 s (a pan to the mark at 41.5 s).
    const zooms = (list: ZoomSegment[]): ZoomSegment[][] => {
      const out: ZoomSegment[][] = []
      for (const z of list) {
        const last = out[out.length - 1]
        if (last && zoomsConnected(last[last.length - 1], z)) last.push(z)
        else out.push([z])
      }
      return out
    }
    const grouped = zooms(zs)
    expect(grouped.map((g) => g.length)).toEqual([2, 1, 2])
    expect(grouped[0][0].anchor).toMatchObject({ x: 0.1, y: 0.1 })
    expect(grouped[0][1].anchor).toEqual({ t: 5.5, x: 0.8, y: 0.3 })
    expect(grouped[2][0].anchor).toMatchObject({ x: 0.9, y: 0.9 })
  })

  it('regenerate with a track and settings keeps edited zooms', () => {
    const edited: ZoomSegment = { id: 'e', start: 20, end: 23, scale: 3, focus: { mode: 'cursor' }, auto: false }
    const r = regenerateAutoZooms([edited], track({ clicks: [click(5)], marks: [{ t: 21 }] }), 40, settings({ scale: 2.2 }))
    expect(r.zooms.find((z) => z.id === 'e')).toEqual(edited)
    expect(r.added).toBe(1)
    expect(r.zooms.find((z) => z.auto)!.scale).toBe(2.2)
  })

  it('zoomSettingsOf fills defaults and follows the old autoZoom flag', () => {
    expect(zoomSettingsOf({})).toEqual(DEFAULT_ZOOM_SETTINGS)
    expect(zoomSettingsOf({ autoZoom: false }).auto.enabled).toBe(false)
    const s = zoomSettingsOf({ autoZoom: true, zoomSettings: { ...DEFAULT_ZOOM_SETTINGS, easing: 'bouncy', auto: { ...AUTO, enabled: false } } })
    expect(s.easing).toBe('bouncy')
    expect(s.auto.enabled).toBe(false)
  })
})

/** A cursor that glides between `stops` ([t, x, y], linear in between), sampled at 30 Hz like a recording. */
function glide(stops: [number, number, number][], duration: number): CursorSample[] {
  const samples: CursorSample[] = []
  for (let i = 0; i <= duration * 30; i++) {
    const t = i / 30
    const k = stops.findIndex((s) => s[0] > t)
    const [t0, x0, y0] = stops[k < 0 ? stops.length - 1 : Math.max(0, k - 1)]
    const [t1, x1, y1] = k < 0 ? stops[stops.length - 1] : stops[k]
    const w = t1 > t0 ? Math.min(1, Math.max(0, (t - t0) / (t1 - t0))) : 0
    samples.push({ t: +t.toFixed(4), x: x0 + (x1 - x0) * w, y: y0 + (y1 - y0) * w })
  }
  return samples
}

/** Where the camera looks at time t. */
function lookAt(zs: ZoomSegment[], samples: CursorSample[], duration: number, t: number): { scale: number; x: number; y: number } {
  const c = cameraAt(zs, t, focusPathFor(samples, duration))
  return { scale: c.scale, x: c.cx, y: c.cy }
}

describe('auto zoom on typing, with realistic recordings', () => {
  const duration = 40

  it('typing into a field just clicked: one zoom over the whole typing, aimed at the field, the idle mouse ignored', () => {
    // The mouse goes to a search field and clicks it at 4 s, then is pushed aside while typing
    // three bursts with pauses of 2 and 4 s in between (the user thinks between sentences).
    const samples = glide([[0, 0.8, 0.8], [3.6, 0.3, 0.6], [5.5, 0.3, 0.6], [6.5, 0.85, 0.15]], duration)
    const t: CursorTrack = { samples, clicks: [click(4, 0.3, 0.6)], valid: true, typing: [{ t: 4.6, end: 6.2 }, { t: 8.2, end: 10.1 }, { t: 14.1, end: 16.4 }] }
    const zs = autoZoomsForTrack(t, duration)
    expect(zs).toHaveLength(1)
    const [z] = zs
    expect(z.start).toBeCloseTo(4 - AUTO.leadIn)
    expect(z.end).toBeCloseTo(16.4 + AUTO.hold)
    expect(z.scale).toBeCloseTo(typingScale(AUTO.scale))
    // Fully zoomed in on the field through every burst and pause, though the mouse rests far away.
    for (const at of [4, 6, 7.5, 9, 12, 15, 17]) {
      const v = lookAt(zs, samples, duration, at)
      expect(v.scale, `${at} s`).toBeCloseTo(z.scale)
      expect(Math.hypot(v.x - 0.3, v.y - 0.6), `${at} s: ${JSON.stringify(v)}`).toBeLessThan(0.01)
    }
    // Typing alone at the click: the same single zoom.
    const plain = autoZoomsForTrack({ ...t, typing: [{ t: 4.3, end: 9 }] }, duration)
    expect(plain).toHaveLength(1)
    expect(covers(plain[0], 4) && covers(plain[0], 9)).toBe(true)
  })

  it('long typing with pauses holds the zoom; a long break zooms out and in again', () => {
    const samples = glide([[0, 0.5, 0.5]], duration)
    const typing = [{ t: 2, end: 4 }, { t: 6, end: 8 }, { t: 12.5, end: 14 }, { t: 19.5, end: 21 }, { t: 34, end: 36 }]
    const zs = autoZoomsForTrack({ samples, clicks: [click(1.5, 0.6, 0.4)], valid: true, typing }, duration)
    // Pauses of 2, 4.5 and 5.5 s keep one zoom; the 13 s break ends it.
    expect(zs).toHaveLength(2)
    expect(zs[0].start).toBeCloseTo(1.5 - AUTO.leadIn)
    expect(zs[0].end).toBeCloseTo(21 + AUTO.hold)
    expect(zs[1].start).toBeCloseTo(34 - AUTO.leadIn)
    // The later typing still types into the field clicked last, if that was recent; here it was not.
    expect(zs[1].anchor).toEqual({ t: 34, x: 0.5, y: 0.5, until: 36 })
    // With a larger click grouping the pauses may be longer still.
    expect(autoZoomsForTrack({ samples, clicks: [], valid: true, typing: [{ t: 2, end: 4 }, { t: 11.5, end: 13 }] }, duration, settings({ clusterGap: 8 }))).toHaveLength(1)
  })

  it('typing without a click aims where the cursor was when it started, not where the mouse goes', () => {
    const samples = glide([[0, 0.7, 0.35], [9, 0.7, 0.35], [10, 0.15, 0.85]], duration)
    const zs = autoZoomsForTrack({ samples, clicks: [], valid: true, typing: [{ t: 8, end: 14 }] }, duration)
    expect(zs).toHaveLength(1)
    expect(zs[0].anchor).toEqual({ t: 8, x: 0.7, y: 0.35, until: 14 })
    const v = lookAt(zs, samples, duration, 13)
    expect(Math.hypot(v.x - 0.7, v.y - 0.35)).toBeLessThan(0.01)
  })

  it('typing during a click cluster: clicks elsewhere pan there and back, the field holds while typing', () => {
    // Open a menu (2 s), pick an item (3 s), click a field (4.5 s), type, then click Submit (9 s).
    const samples = glide([[0, 0.5, 0.5], [1.8, 0.2, 0.2], [2.8, 0.25, 0.32], [4.3, 0.7, 0.6], [8.6, 0.7, 0.6], [8.9, 0.85, 0.8]], duration)
    const clicks = [click(2, 0.2, 0.2), click(3, 0.25, 0.32), click(4.5, 0.7, 0.6), click(9, 0.85, 0.8)]
    const zs = autoZoomsForTrack({ samples, clicks, valid: true, typing: [{ t: 5, end: 8 }] }, duration)
    expect(zs).toHaveLength(3)
    // One zoom made of three connected parts: no zoom-out between them.
    for (let i = 1; i < zs.length; i++) {
      expect(zs[i].start).toBeCloseTo(zs[i - 1].end)
      expect(zoomsConnected(zs[i - 1], zs[i])).toBe(true)
    }
    const [menu, field, submit] = zs
    expect(menu.anchor).toEqual({ t: 2, x: 0.2, y: 0.2 })
    expect(menu.scale).toBeCloseTo(AUTO.scale)
    expect(field.anchor).toEqual({ t: 4.5, x: 0.7, y: 0.6, until: 8 })
    expect(field.scale).toBeCloseTo(typingScale(AUTO.scale))
    expect(field.start).toBeLessThanOrEqual(4.5)
    expect(field.end).toBeGreaterThanOrEqual(8)
    expect(submit.anchor).toEqual({ t: 9, x: 0.85, y: 0.8 })
    expect(submit.end).toBeCloseTo(9 + AUTO.hold)
    // While typing the camera stays on the field.
    const v = lookAt(zs, samples, duration, 6.5)
    expect(Math.hypot(v.x - 0.7, v.y - 0.6)).toBeLessThan(0.01)
  })

  it('a typing zoom keeps aiming at the field when its end is trimmed, disconnected or clamped', () => {
    // Click a field at (0.2, 0.2) at 16 s and type until 19.5 s; the mouse is pushed aside to (0.9, 0.9).
    const length = 20
    const samples = glide([[0, 0.9, 0.9], [15.5, 0.9, 0.9], [15.9, 0.2, 0.2], [16.2, 0.2, 0.2], [16.6, 0.9, 0.9]], length)
    const [z] = autoZoomsForTrack({ samples, clicks: [click(16, 0.2, 0.2)], valid: true, typing: [{ t: 16.5, end: 19.5 }] }, length)
    expect(z.start).toBeCloseTo(16 - AUTO.leadIn)
    expect(z.end).toBe(length)
    const field = cameraFor(z.scale, 0.2, 0.2)
    const aimsAtField = (zs: ZoomSegment[], at: number): void => {
      const v = lookAt(zs, samples, length, at)
      expect(Math.hypot(v.x - field.cx, v.y - field.cy), `${at} s: ${JSON.stringify(v)}`).toBeLessThan(0.01)
    }
    aimsAtField([z], 18.5)
    // The end dragged a little earlier on the timeline, or clamped to a slightly shorter video.
    aimsAtField([{ ...z, end: z.end - 0.3 }], 18.5)
    aimsAtField(clampZooms([z], 19.97), 18.5)
    // Even trimmed to end before the last key, it still shows the typing.
    aimsAtField([{ ...z, end: 18.8 }], 17.5)

    // "Pan to next zoom" turned off between the typing and the click on Submit after it.
    const s2 = glide([[0, 0.5, 0.5], [1.8, 0.2, 0.2], [2.3, 0.2, 0.2], [2.8, 0.9, 0.1], [6.2, 0.9, 0.1], [6.5, 0.85, 0.8]], length)
    const zs = autoZoomsForTrack({ samples: s2, clicks: [click(2, 0.2, 0.2), click(6.5, 0.85, 0.8)], valid: true, typing: [{ t: 2.4, end: 4.5 }] }, length)
    expect(zs).toHaveLength(2)
    expect(zoomsConnected(zs[0], zs[1])).toBe(true)
    const apart = disconnectFromNext(zs, zs[0].id)!
    expect(apart[0].end).toBeLessThan(zs[0].end)
    expect(zoomsConnected(apart[0], apart[1])).toBe(false)
    for (const list of [zs, apart]) {
      const v = lookAt(list, s2, length, 4)
      const f = cameraFor(list[0].scale, 0.2, 0.2)
      expect(Math.hypot(v.x - f.cx, v.y - f.cy), JSON.stringify(v)).toBeLessThan(0.01)
    }
  })

  it('a typing anchor holds for the whole zoom while the zoom overlaps the typing, and not once moved off it', () => {
    const seg: ZoomSegment = { id: 't', start: 15, end: 20, scale: 2, focus: { mode: 'cursor' }, auto: true, anchor: { t: 16, x: 0.2, y: 0.2, until: 19.5 } }
    for (const at of [15.2, 16, 17.5, 19.5, 19.9]) expect(anchorWeight(seg, at)).toBe(1)
    expect(anchorWeight({ ...seg, start: 18, end: 19 }, 18.5)).toBe(1)
    expect(anchorWeight({ ...seg, start: 15, end: 16 }, 15.5)).toBe(1)
    // Moved away from the typing, before or after it.
    expect(anchorWeight({ ...seg, start: 5, end: 10 }, 7)).toBe(0)
    expect(anchorWeight({ ...seg, start: 19.6, end: 22 }, 20)).toBe(0)
    // A malformed span (hand-edited file) is read as a click anchor at t.
    const bad = { ...seg, anchor: { t: 16, x: 0.2, y: 0.2, until: Number.NaN } }
    expect(anchorWeight(bad, 15.5)).toBe(1)
    expect(anchorWeight(bad, 17)).toBe(0)
  })

  it('clicking again in the field between bursts keeps one part aimed at the field', () => {
    const clicks = [click(3, 0.4, 0.5), click(7, 0.43, 0.52)]
    const zs = autoZoomsForTrack({ samples: glide([[0, 0.4, 0.5]], duration), clicks, valid: true, typing: [{ t: 3.4, end: 6 }, { t: 7.3, end: 10 }] }, duration)
    expect(zs).toHaveLength(1)
    expect(zs[0].anchor).toEqual({ t: 3, x: 0.4, y: 0.5, until: 10 })
  })

  it('a single short keystroke burst makes no zoom of its own', () => {
    const samples = glide([[0, 0.5, 0.5]], duration)
    expect(autoZoomsForTrack({ samples, clicks: [], valid: true, typing: [{ t: 5, end: 5.3 }] }, duration)).toEqual([])
    // After a click it changes nothing: the click's own zoom, as without typing.
    const strip = (zs: ZoomSegment[]) => zs.map(({ id: _id, ...rest }) => rest)
    const withKey = autoZoomsForTrack({ samples, clicks: [click(4, 0.3, 0.3)], valid: true, typing: [{ t: 4.5, end: 4.7 }] }, duration)
    expect(strip(withKey)).toEqual(strip(autoZoomsForTrack({ samples, clicks: [click(4, 0.3, 0.3)], valid: true }, duration)))
  })

  it('keeps the auto zoom settings working for typing', () => {
    const t: CursorTrack = { samples: glide([[0, 0.5, 0.5]], duration), clicks: [click(4, 0.3, 0.6)], valid: true, typing: [{ t: 5, end: 9 }] }
    const [z] = autoZoomsForTrack(t, duration, settings({ leadIn: 1.5, hold: 3, scale: 2.5 }))
    expect(z.start).toBeCloseTo(2.5)
    expect(z.end).toBeCloseTo(12)
    expect(z.scale).toBe(2.5)
    // Typing off: only the click zooms, as before.
    const [click1] = autoZoomsForTrack(t, duration, settings({ onTyping: false }))
    expect(click1.anchor).toEqual({ t: 4, x: 0.3, y: 0.6 })
    expect(click1.end).toBeCloseTo(4 + AUTO.hold)
    // Regenerating keeps a zoom the user edited and skips typing zooms over it.
    const edited: ZoomSegment = { id: 'mine', start: 5, end: 7, scale: 3, focus: { mode: 'fixed', x: 0.1, y: 0.1 }, auto: false }
    const r = regenerateAutoZooms([edited], t, duration, AUTO)
    expect(r.zooms).toEqual([edited])
    expect(r.kept).toBe(1)
  })

  it('typing level: a step closer than click zooms, up to 2.2×, never lower', () => {
    expect(typingScale(1.8)).toBeCloseTo(2.16)
    expect(typingScale(1.25)).toBeCloseTo(1.5)
    expect(typingScale(2.1)).toBeCloseTo(2.2)
    expect(typingScale(3)).toBe(3)
  })
})

