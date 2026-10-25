import { describe, expect, it } from 'vitest'
import { setCornerAt, setLayoutAt } from '../src/shared/editor/layoutCommands'
import { byHand, dragLayout, removeLayout, stayAround, updateLayout } from '../src/shared/editor/layouts'
import {
  DEFAULT_DIRECTOR,
  directorMayFrame,
  directorSettingsOf,
  framingIsDirectors,
  framingUntouched,
  hasCameraPositions,
  hasDirectorChanges,
  HIDE_AFTER_CHOICES,
  readDirectorSettings
} from '../src/shared/engine/directorData'
import { toOutput } from '../src/shared/engine/outputPoint'
import { migrateProject } from '../src/shared/engine/project'
import { readLayouts } from '../src/shared/engine/webcamData'
import { cameraFor } from '../src/shared/engine/zoom'
import type { CameraLayout, Corner, LayoutSegment, WebcamSettings } from '../src/shared/types'

/*
 * The camera director's data contract (docs/design/camera-director.md): the `auto` and `cutOut`
 * marks on layout segments survive loading, any edit by hand makes a segment the user's,
 * removing a cut-out gives its time back to the camera position it came from, the saved options
 * are sanitised, and the director measures points where the compositor draws them.
 */

const seg = (id: string, start: number, end: number, layout: CameraLayout, extra: Partial<LayoutSegment> = {}): LayoutSegment => ({ id, start, end, layout, ...extra })
const WEBCAM: WebcamSettings = { show: true, corner: 'bottom-right', size: 0.24, shape: 'circle' }

describe('layout segments keep the director marks when loaded', () => {
  it('keeps auto only when it is exactly true', () => {
    const list = readLayouts(
      [
        { id: 'a', start: 0, end: 2, layout: 'camera-only', auto: true },
        { id: 'b', start: 2, end: 4, layout: 'screen-only', auto: 'yes' },
        { id: 'c', start: 4, end: 6, layout: 'screen-only', auto: 1 },
        { id: 'd', start: 6, end: 8, layout: 'screen-only', auto: false }
      ],
      10
    )
    expect(list.map((s) => [s.id, s.auto])).toEqual([
      ['a', true],
      ['b', undefined],
      ['c', undefined],
      ['d', undefined]
    ])
    expect('auto' in list[1]).toBe(false)
  })

  it('keeps cutOut only with auto and a corner on a layout other than the default one', () => {
    const list = readLayouts(
      [
        { id: 'ok', start: 0, end: 2, layout: 'camera-only', corner: 'top-left', auto: true, cutOut: true },
        { id: 'manual', start: 2, end: 4, layout: 'camera-only', corner: 'top-left', cutOut: true },
        { id: 'no-corner', start: 4, end: 6, layout: 'screen-only', auto: true, cutOut: true },
        { id: 'default', start: 6, end: 8, layout: 'default', corner: 'top-left', auto: true, cutOut: true }
      ],
      10
    )
    expect(list.map((s) => [s.id, !!s.auto, !!s.cutOut])).toEqual([
      ['ok', true, true],
      ['manual', false, false],
      ['no-corner', true, false],
      ['default', true, false]
    ])
  })

  it('keeps the marks on a segment trimmed so it does not overlap the one before', () => {
    const list = readLayouts(
      [
        { id: 'a', start: 0, end: 5, layout: 'default', corner: 'top-left' },
        { id: 'b', start: 4, end: 8, layout: 'camera-only', corner: 'top-left', auto: true, cutOut: true }
      ],
      10
    )
    expect(list[1]).toEqual({ id: 'b', start: 5, end: 8, layout: 'camera-only', corner: 'top-left', auto: true, cutOut: true })
  })
})

describe('the saved director options', () => {
  const raw = (extra: Record<string, unknown>) => ({ id: 'p', duration: 10, clips: [], ...extra })

  it('is absent in a project never directed, and dropped when it is not an object', () => {
    expect(migrateProject(raw({})).director).toBeUndefined()
    expect('director' in migrateProject(raw({}))).toBe(false)
    expect(migrateProject(raw({ director: 'yes' })).director).toBeUndefined()
    expect(migrateProject(raw({ director: [1] })).director).toBeUndefined()
  })

  it('keeps valid options and replaces invalid ones with the defaults', () => {
    const ok = { intro: 'camera-large', corners: 'keep', hideAfter: 20, frameFace: false, framed: { zoom: 1.25, cropX: 0.62, cropY: 0.4 } }
    expect(migrateProject(raw({ director: ok })).director).toEqual(ok)
    expect(readDirectorSettings({ intro: 'huge', corners: 'random', hideAfter: 7, frameFace: 'yes' })).toEqual({
      intro: 'camera-only',
      corners: 'auto',
      hideAfter: 10,
      frameFace: true
    })
    expect(HIDE_AFTER_CHOICES).toContain(DEFAULT_DIRECTOR.hideAfter)
  })

  it('clamps the framing it applied, and drops one that is not finite', () => {
    expect(readDirectorSettings({ framed: { zoom: 9, cropX: -1, cropY: 2 } })?.framed).toEqual({ zoom: 3, cropX: 0, cropY: 1 })
    expect(readDirectorSettings({ framed: { zoom: Number.NaN, cropX: 0.5, cropY: 0.5 } })?.framed).toBeUndefined()
    expect(readDirectorSettings({ framed: { zoom: 1.2, cropX: 0.5 } })?.framed).toBeUndefined()
  })
})

describe('who owns the webcam framing', () => {
  const framed = { zoom: 1.25, cropX: 0.62, cropY: 0.4 }

  it('is untouched without zoom or crop, or at zoom 1 centred', () => {
    expect(framingUntouched({})).toBe(true)
    expect(framingUntouched({ zoom: 1, cropX: 0.5, cropY: 0.5 })).toBe(true)
    expect(framingUntouched({ zoom: 1.05 })).toBe(false)
    expect(framingUntouched({ cropX: 0.6 })).toBe(false)
  })

  it("is the director's while the webcam still shows the framing it applied", () => {
    expect(framingIsDirectors({ ...framed }, { framed })).toBe(true)
    expect(framingIsDirectors({ ...framed, cropX: 0.62004 }, { framed })).toBe(true)
    expect(framingIsDirectors({ ...framed, cropX: 0.6 }, { framed })).toBe(false)
    expect(framingIsDirectors({ ...framed }, undefined)).toBe(false)
    expect(framingIsDirectors({}, { framed: { zoom: 1, cropX: 0.5, cropY: 0.5 } })).toBe(true)
  })

  it('may be set by the director when untouched or still its own', () => {
    expect(directorMayFrame({}, undefined)).toBe(true)
    expect(directorMayFrame({ ...framed }, { framed })).toBe(true)
    expect(directorMayFrame({ zoom: 2, cropX: 0.3, cropY: 0.3 }, { framed })).toBe(false)
  })
})

describe('the options the director works with', () => {
  const position = seg('rec1', 10, 24, 'default', { corner: 'top-left' })

  it('keeps the bubble where the user put the camera, for a project never directed', () => {
    expect(directorSettingsOf({ layouts: [], webcam: WEBCAM })).toEqual({ ...DEFAULT_DIRECTOR, corners: 'auto' })
    expect(directorSettingsOf({ layouts: [position], webcam: WEBCAM }).corners).toBe('keep')
    // A corner segment the director made is not the user's camera position.
    expect(directorSettingsOf({ layouts: [{ ...position, auto: true }], webcam: WEBCAM }).corners).toBe('auto')
    expect(hasCameraPositions([seg('x', 0, 5, 'camera-only', { corner: 'top-left' })])).toBe(false)
  })

  it('uses the saved options as they are', () => {
    const director = { intro: 'off', corners: 'auto', hideAfter: 5, frameFace: true } as const
    expect(directorSettingsOf({ layouts: [position], webcam: WEBCAM, director })).toEqual(director)
  })

  it("does not offer face framing over a framing the user set by hand, but does over the director's", () => {
    const framed = { zoom: 1.25, cropX: 0.62, cropY: 0.4 }
    const director = { ...DEFAULT_DIRECTOR, framed }
    expect(directorSettingsOf({ layouts: [], webcam: { ...WEBCAM, zoom: 2, cropX: 0.3 } }).frameFace).toBe(false)
    expect(directorSettingsOf({ layouts: [], webcam: { ...WEBCAM, ...framed }, director }).frameFace).toBe(true)
    expect(directorSettingsOf({ layouts: [], webcam: { ...WEBCAM, ...framed, zoom: 1.5 }, director })).toEqual({ ...director, frameFace: false })
  })

  it("knows when the director's changes are in the project", () => {
    const framed = { zoom: 1.25, cropX: 0.62, cropY: 0.4 }
    expect(hasDirectorChanges({ layouts: [position], webcam: WEBCAM })).toBe(false)
    expect(hasDirectorChanges({ layouts: [seg('a', 0, 5, 'camera-only', { auto: true })], webcam: WEBCAM })).toBe(true)
    expect(hasDirectorChanges({ layouts: [], webcam: { ...WEBCAM, ...framed }, director: { ...DEFAULT_DIRECTOR, framed } })).toBe(true)
    expect(hasDirectorChanges({ layouts: [], webcam: { ...WEBCAM, ...framed, zoom: 2 }, director: { ...DEFAULT_DIRECTOR, framed } })).toBe(false)
  })
})

describe("an edit by hand makes a segment the user's", () => {
  const auto = seg('a', 0, 5, 'camera-only', { corner: 'top-left', auto: true, cutOut: true })

  it('strips the marks, and leaves a segment without them as it is', () => {
    expect(byHand(auto)).toEqual({ id: 'a', start: 0, end: 5, layout: 'camera-only', corner: 'top-left' })
    const mine = seg('m', 0, 5, 'side-by-side')
    expect(byHand(mine)).toBe(mine)
  })

  it('in the Camera panel pickers and when dragged; the pieces dragged along keep their marks', () => {
    expect(updateLayout([auto], 'a', { layout: 'camera-large' })[0]).toEqual({ id: 'a', start: 0, end: 5, layout: 'camera-large', corner: 'top-left' })
    const piece = seg('p', 5, 20, 'default', { corner: 'top-left', auto: true })
    const dragged = dragLayout([auto, piece], 'a', { start: 0, end: 6 }, { after: piece })
    expect(dragged[0].auto).toBeUndefined()
    expect(dragged[1]).toEqual({ ...piece, start: 6 })
  })

  it('in the layout and corner commands at the playhead', () => {
    const hidden = seg('h', 0, 10, 'screen-only', { auto: true })
    const p = { layouts: [hidden], duration: 20, clips: [{ id: 'c', start: 0, end: 20, speed: 1 }] }
    const r = setLayoutAt(p, 'camera-only', 5)
    expect(r.ok && r.layouts[0]).toEqual({ id: 'h', start: 0, end: 10, layout: 'camera-only' })
    const bubble = seg('b', 0, 10, 'camera-large', { corner: 'bottom-left', auto: true })
    const c = setCornerAt({ ...p, layouts: [bubble], webcam: WEBCAM }, 'top-right', 5)
    expect(c.ok && c.layouts[0]).toEqual({ id: 'b', start: 0, end: 10, layout: 'camera-large', corner: 'top-right' })
  })

  it("adds a change inside the director's bubble corner as the user's, the corner pieces staying the director's", () => {
    const bubble = seg('b', 0, 20, 'default', { corner: 'bottom-left', auto: true })
    const r = setLayoutAt({ layouts: [bubble], duration: 20, clips: [{ id: 'c', start: 0, end: 20, speed: 1 }] }, 'camera-only', 8)
    expect(r.ok).toBe(true)
    if (!r.ok) return
    const added = r.layouts.find((s) => s.id === r.id)!
    expect(added.auto).toBeUndefined()
    expect(r.layouts.filter((s) => s.id !== r.id).every((s) => s.auto === true && s.corner === 'bottom-left')).toBe(true)
  })
})

describe("removing the director's cut-out gives its time back to the camera position", () => {
  const corner: Corner = 'top-left'

  it('joins the pieces around it, keeping the first one', () => {
    const list = [seg('p1', 10, 14, 'default', { corner }), seg('x', 14, 20, 'screen-only', { corner, auto: true, cutOut: true }), seg('p2', 20, 30, 'default', { corner })]
    expect(stayAround(list, list[1])).toEqual({ before: list[0], after: list[2] })
    expect(removeLayout(list, 'x')).toEqual([seg('p1', 10, 30, 'default', { corner })])
  })

  it('becomes the camera position again when it covered it whole', () => {
    const list = [seg('m', 0, 10, 'side-by-side'), seg('x', 10, 30, 'camera-only', { corner, auto: true, cutOut: true })]
    expect(removeLayout(list, 'x')).toEqual([seg('m', 0, 10, 'side-by-side'), seg('x', 10, 30, 'default', { corner })])
  })

  it('removes any other segment without pieces as before', () => {
    expect(removeLayout([seg('x', 10, 30, 'camera-only', { corner, auto: true })], 'x')).toEqual([])
    expect(removeLayout([seg('x', 10, 30, 'camera-only', { corner })], 'x')).toEqual([])
  })
})

describe('the director maps points as the compositor draws them', () => {
  const rect = { x: 100, y: 50, w: 1600, h: 900 }

  it('is the identity onto the card at rest', () => {
    const f = toOutput(rect, { scale: 1, cx: 0.5, cy: 0.5 })
    expect(f(0, 0)).toEqual({ x: 100, y: 50 })
    expect(f(1, 1)).toEqual({ x: 1700, y: 950 })
  })

  it('follows a zoom: a point at the focus of a 2x zoom at (0.3, 0.3) sees (0.5, 0.5) at 0.9 of the card', () => {
    const p = toOutput(rect, cameraFor(2, 0.3, 0.3))(0.5, 0.5)
    expect(p.x).toBeCloseTo(rect.x + 0.9 * rect.w, 9)
    expect(p.y).toBeCloseTo(rect.y + 0.9 * rect.h, 9)
  })

  it('matches the compositor formula for zoomed in and pulled back cameras', () => {
    let seed = 7
    const rnd = (): number => ((seed = (seed * 16807) % 2147483647) - 1) / 2147483646
    for (let i = 0; i < 50; i++) {
      const cam = cameraFor(i % 5 === 0 ? 0.6 + 0.4 * rnd() : 1 + 2 * rnd(), rnd(), rnd())
      const x = rnd()
      const y = rnd()
      const viewX = cam.cx - 0.5 / cam.scale
      const viewY = cam.cy - 0.5 / cam.scale
      expect(toOutput(rect, cam)(x, y)).toEqual({ x: rect.x + (x - viewX) * cam.scale * rect.w, y: rect.y + (y - viewY) * cam.scale * rect.h })
    }
  })
})
