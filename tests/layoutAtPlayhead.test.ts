import { describe, expect, it } from 'vitest'
import { setLayoutAt } from '../src/shared/editor/layoutCommands'
import { addLayoutAt, DEFAULT_LAYOUT_LENGTH, layoutSegmentAt, layoutShowTime, layoutTimeAt } from '../src/shared/editor/layouts'
import { layoutPhaseAt, layoutRamps, LAYOUT_TRANSITION } from '../src/shared/engine/layout'
import type { CameraLayout, Clip, LayoutSegment, WebcamSettings } from '../src/shared/types'

/*
 * A camera layout change "at the playhead" follows one rule whichever way it is added: the Camera
 * panel's picker and the layout commands (setLayoutAt), and a double-click on the camera track
 * (addLayoutAt at the clicked time). It goes on the frame the preview shows, fits the kept video,
 * and the playhead then moves to where it shows.
 */

const clip = (start: number, end: number, speed = 1): Clip => ({ id: `c${start}`, start, end, speed })
const seg = (id: string, start: number, end: number, layout: CameraLayout = 'camera-only'): LayoutSegment => ({ id, start, end, layout })
const webcam: WebcamSettings = { show: true, corner: 'bottom-right', size: 0.24, shape: 'circle' }
const edit = (over: { duration: number; clips?: Clip[]; layouts?: LayoutSegment[] }) => ({ layouts: [] as LayoutSegment[], webcam, hasWebcam: true, ...over })

/** The new segment each entry point adds at `t`: the panel and the commands, and the track's double-click. */
function addedBoth(p: ReturnType<typeof edit>, layout: CameraLayout, t: number): { start: number; end: number } {
  const viaCommand = setLayoutAt(p, layout, t)
  const viaTrack = addLayoutAt(p, layout, t)
  if (!viaCommand.ok || !viaCommand.added || !viaTrack.ok) throw new Error(`nothing added at ${t}: ${JSON.stringify([viaCommand, viaTrack])}`)
  const a = viaCommand.layouts.find((s) => s.id === viaCommand.id)!
  expect({ start: a.start, end: a.end }, `the same segment at ${t}`).toEqual({ start: viaTrack.segment.start, end: viaTrack.segment.end })
  return { start: a.start, end: a.end }
}

describe('a camera layout change at the playhead', () => {
  it('near the end of the video: it ends with the video and its change plays', () => {
    const p = edit({ duration: 12 })
    for (const t of [11.95, 12, 13]) expect(addedBoth(p, 'camera-only', t), `at ${t}`).toEqual({ start: 12 - DEFAULT_LAYOUT_LENGTH, end: 12 })
    // Far enough from the end, it starts at the playhead.
    expect(addedBoth(p, 'camera-only', 6)).toEqual({ start: 6, end: 11 })
  })

  it('a trimmed end is the end of the video', () => {
    const p = edit({ duration: 12, clips: [clip(0, 10)] })
    // Just before it, where playback stops, and in the trimmed part after it.
    for (const t of [9.9, 10, 11]) expect(addedBoth(p, 'side-by-side', t), `at ${t}`).toEqual({ start: 5, end: 10 })
    // No room between the one before and the end: says so, pointing at that one.
    expect(addLayoutAt({ ...p, layouts: [seg('a', 2, 9.9)] }, 'camera-large', 9.95)).toEqual({ ok: false, reason: 'end', id: 'a' })
    expect(setLayoutAt({ ...p, layouts: [seg('a', 2, 9.9)] }, 'camera-large', 11)).toEqual({ ok: false, reason: 'end', id: 'a' })
    // A trimmed start: on the first kept frame.
    expect(addedBoth(edit({ duration: 12, clips: [clip(2, 12)] }), 'camera-only', 0.5)).toEqual({ start: 2, end: 7 })
  })

  it('with the playhead in a cut: on the next kept frame, which the preview shows', () => {
    const clips = [clip(0, 10), clip(15, 30)]
    const p = edit({ duration: 30, clips })
    expect(layoutTimeAt(p, 12)).toBe(15)
    expect(addedBoth(p, 'side-by-side', 12)).toEqual({ start: 15, end: 20 })
    // A change that starts in the cut and shows after it is the one at the playhead: the panel
    // shows it as current, and picking another layout changes it rather than adding a hidden one.
    const shown = { ...p, layouts: [seg('a', 14, 20)] }
    expect(layoutSegmentAt(shown.layouts, layoutTimeAt(shown, 12))?.id).toBe('a')
    const r = setLayoutAt(shown, 'side-by-side', 12)
    expect(r).toMatchObject({ ok: true, id: 'a', added: false })
    if (r.ok) expect(r.layouts).toEqual([seg('a', 14, 20, 'side-by-side')])
    expect(setLayoutAt(shown, 'camera-only', 12)).toEqual({ ok: false, reason: 'same', id: 'a' })
    // The track's double-click there selects it instead of adding over it.
    expect(addLayoutAt(shown, 'side-by-side', 12)).toEqual({ ok: false, reason: 'inside', id: 'a' })
  })

  it('inside an existing segment: that segment changes, nothing is stacked on it', () => {
    const p = edit({ duration: 20, layouts: [seg('a', 2, 6), seg('b', 9, 12, 'screen-only')] })
    const r = setLayoutAt(p, 'camera-large', 4)
    expect(r).toMatchObject({ ok: true, id: 'a', added: false })
    if (r.ok) expect(r.layouts.map((s) => [s.id, s.layout])).toEqual([['a', 'camera-large'], ['b', 'screen-only']])
    expect(addLayoutAt(p, 'side-by-side', 4)).toEqual({ ok: false, reason: 'inside', id: 'a' })
    // Between two: up to the next one, and in order.
    const between = setLayoutAt(p, 'side-by-side', 7)
    expect(between.ok && between.layouts.map((s) => [s.start, s.end])).toEqual([[2, 6], [7, 9], [9, 12]])
    expect(setLayoutAt(p, 'side-by-side', 8.9)).toEqual({ ok: false, reason: 'no-room', id: null })
  })

  /** Whether the preview of a paused playhead at `t` shows `s` settled. */
  const settled = (p: ReturnType<typeof edit>, s: LayoutSegment, t: number): boolean => {
    const phase = layoutPhaseAt(p, layoutTimeAt(p, t))
    return phase.progress === 1 && phase.to === s.layout
  }
  const add = (p: ReturnType<typeof edit>, t: number, layout: CameraLayout = 'side-by-side') => {
    const r = setLayoutAt(p, layout, t)
    if (!r.ok || !r.added) throw new Error(JSON.stringify(r))
    return { p: { ...p, layouts: r.layouts }, s: r.layouts.find((s) => s.id === r.id)! }
  }

  it('then moves the playhead past the change in, so the paused preview shows it', () => {
    // Added at 3 s: at the playhead it has not changed anything yet.
    const mid = add(edit({ duration: 20 }), 3)
    expect(settled(mid.p, mid.s, 3)).toBe(false)
    const at = layoutShowTime(mid.p, mid.s, 3)!
    expect(at).toBeCloseTo(3 + LAYOUT_TRANSITION + 0.01)
    expect(settled(mid.p, mid.s, at)).toBe(true)
    // Already shown settled there: the playhead stays.
    expect(layoutShowTime(mid.p, mid.s, at)).toBeNull()
    // With the playhead in a cut, past the change in after the cut.
    const cut = add(edit({ duration: 30, clips: [clip(0, 10), clip(15, 30)] }), 12)
    expect(layoutShowTime(cut.p, cut.s, 12)).toBeCloseTo(15 + LAYOUT_TRANSITION + 0.01)
    // At the end of the video it ends with the video, settled on the last frame: the playhead stays there.
    const end = add(edit({ duration: 12 }), 12)
    expect(settled(end.p, end.s, 12)).toBe(true)
    expect(layoutShowTime(end.p, end.s, 12)).toBeNull()
    // A change at the very start of the video is instant.
    const first = add(edit({ duration: 12 }), 0)
    expect(layoutShowTime(first.p, first.s, 0)).toBeNull()
    // The same whether the camera is shown or hidden.
    const hidden = { ...mid.p, webcam: { ...webcam, show: false } }
    expect(layoutShowTime(hidden, mid.s, 3)).toBe(at)
  })

  it('a short change running straight into the next one shows settled before it, or as far as it gets', () => {
    const p = edit({ duration: 20, layouts: [seg('b', 8, 12, 'screen-only')] })
    // Up to the next change: it changes in, then straight into the next one (no change out).
    const short = add(p, 7.4, 'camera-only')
    expect([short.s.start, short.s.end]).toEqual([7.4, 8])
    expect(layoutRamps(short.p, short.s)).toEqual({ in: LAYOUT_TRANSITION, out: 0 })
    const at = layoutShowTime(short.p, short.s, 7.4)!
    expect(settled(short.p, short.s, at)).toBe(true)
    expect(layoutShowTime(short.p, short.s, at)).toBeNull()
    // Too short to settle before the next one: its last frame, the furthest its change gets.
    const tiny = add(p, 7.65, 'camera-only')
    const last = layoutShowTime(tiny.p, tiny.s, 7.65)!
    expect(last).toBeLessThan(8)
    const phase = layoutPhaseAt(tiny.p, last)
    expect(phase.to).toBe('camera-only')
    expect(phase.progress).toBeGreaterThan(0.99)
    // Settling only in a cut: as far into its change as the kept video gets, before the cut
    // (not the frame after the cut, which is outside the change).
    const cut = edit({ duration: 20, clips: [clip(0, 4.2), clip(7, 20)], layouts: [seg('b', 4.4, 6, 'screen-only')] })
    const inCut = add(cut, 3.9, 'camera-only')
    expect([inCut.s.start, inCut.s.end]).toEqual([3.9, 4.4])
    const before = layoutShowTime(inCut.p, inCut.s, 3.9)!
    expect(layoutTimeAt(inCut.p, before)).toBe(before)
    expect(before).toBeGreaterThan(4.19)
    expect(before).toBeLessThan(4.2)
    expect(layoutPhaseAt(inCut.p, before).to).toBe('camera-only')
    // With the cut covering all of the settled part, the side of it further into the change.
    const across = edit({ duration: 20, clips: [clip(0, 9.2), clip(10.9, 20)], layouts: [seg('a', 9, 11)] })
    const side = layoutShowTime(across, across.layouts[0], 3)!
    expect(side).toBeGreaterThan(9.19)
    expect(side).toBeLessThan(9.2)
    // A short one with a change out as well: settled between the two, at its middle.
    const both = edit({ duration: 20, layouts: [seg('a', 2, 2.6)] })
    const ramps = layoutRamps(both, both.layouts[0])
    expect([ramps.in, ramps.out].map((v) => v.toFixed(6))).toEqual(['0.300000', '0.300000'])
    expect(settled(both, both.layouts[0], layoutShowTime(both, both.layouts[0], 1)!)).toBe(true)
  })

  it('while playing, a change the playhead is in plays: the playhead stays', () => {
    const mid = add(edit({ duration: 20 }), 3)
    // Just added at the playhead, in its change in, settled, and in its change out.
    for (const t of [3, 3 + LAYOUT_TRANSITION / 2, 5, mid.s.end - LAYOUT_TRANSITION / 2]) expect(layoutShowTime(mid.p, mid.s, t, true), `at ${t}`).toBeNull()
    // Added near the end it starts before the playhead, which is in it.
    const end = add(edit({ duration: 12, clips: [clip(0, 10)] }), 9.9)
    expect(end.s.start).toBeLessThan(9.9)
    expect(layoutShowTime(end.p, end.s, 9.9, true)).toBeNull()
    // A click on a change elsewhere still goes to it, as when paused.
    for (const t of [1, 12]) expect(layoutShowTime(mid.p, mid.s, t, true), `at ${t}`).toBe(layoutShowTime(mid.p, mid.s, t))
    expect(layoutShowTime(mid.p, mid.s, 12, true)).not.toBeNull()
  })
})
