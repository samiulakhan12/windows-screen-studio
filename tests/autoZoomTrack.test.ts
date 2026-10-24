import { describe, expect, it } from 'vitest'
import { autoZoomsForTrack, DEFAULT_ZOOM_SETTINGS, generateAutoZooms, regenerateAutoZooms, TYPING_CLICK_WINDOW, zoomSettingsOf } from '../src/shared/engine/zoom'
import type { AutoZoomSettings, ClickEvent, CursorTrack, ZoomSegment } from '../src/shared/types'

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

  it('zooms on a typing burst at the field clicked just before, for the whole burst', () => {
    const t = track({ clicks: [click(4, 0.3, 0.6)], typing: [{ t: 5, end: 9 }] })
    const zs = autoZoomsForTrack(t, 30)
    expect(zs).toHaveLength(1)
    const [z] = zs
    expect(covers(z, 4) && covers(z, 9 + AUTO.hold - 1e-6)).toBe(true)
    // Aimed at the clicked field until the typing ends.
    expect(z.anchor).toEqual({ t: 9, x: 0.3, y: 0.6 })
  })

  it('a typing burst far from any click zooms on its own, aimed at the last click within 10 s', () => {
    const t = track({ clicks: [click(1, 0.3, 0.6)], typing: [{ t: 8, end: 10 }] })
    const zs = autoZoomsForTrack(t, 40)
    expect(zs).toHaveLength(2)
    const typing = zs[1]
    expect(typing.start).toBeCloseTo(8 - AUTO.leadIn)
    expect(typing.end).toBeCloseTo(10 + AUTO.hold)
    expect(typing.anchor).toEqual({ t: 10, x: 0.3, y: 0.6 })
  })

  it('without a recent click, a typing burst aims at the cursor where it starts', () => {
    const t = track({ clicks: [click(1, 0.3, 0.6)], typing: [{ t: 1 + TYPING_CLICK_WINDOW + 5, end: 18 }] })
    const typing = autoZoomsForTrack(t, 40).find((z) => covers(z, 17))!
    expect(typing.anchor).toEqual({ t: 18, x: 0.2, y: 0.7 })
    // No cursor data at all: the centre.
    const blind = autoZoomsForTrack({ samples: [], clicks: [], valid: true, typing: [{ t: 3, end: 4 }] }, 20)
    expect(blind[0].anchor).toEqual({ t: 4, x: 0.5, y: 0.5 })
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

  it('merges overlapping zooms from clicks, typing and marks, never overlapping, all anchored', () => {
    const t = track({
      clicks: [click(2, 0.1, 0.1), click(30, 0.9, 0.9, 'right')],
      typing: [{ t: 2.5, end: 5 }, { t: 40, end: 41 }],
      marks: [{ t: 5.5 }, { t: 41.5 }]
    })
    const zs = autoZoomsForTrack(t, 60, settings({ rightClicks: true }))
    for (let i = 1; i < zs.length; i++) expect(zs[i].start).toBeGreaterThanOrEqual(zs[i - 1].end)
    for (const z of zs) {
      expect(z.anchor).toBeDefined()
      expect(z.anchor!.t).toBeGreaterThanOrEqual(z.start)
      expect(z.anchor!.t).toBeLessThanOrEqual(z.end)
    }
    expect(zs).toHaveLength(3)
    expect(zs.every((z) => z.end <= 60 && z.start >= 0)).toBe(true)
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
