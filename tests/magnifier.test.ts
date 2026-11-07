import { describe, expect, it } from 'vitest'
import { EASE } from '../src/shared/captions/motion'
import { copyItems, pasteItems } from '../src/shared/editor/groupClipboard'
import { groupMovePlan, moveGroup } from '../src/shared/editor/groupMove'
import { itemKey, projectItems, trackOfKind, type ItemKey } from '../src/shared/editor/multiSelect'
import { nudgeItems } from '../src/shared/editor/nudge'
import { projectSnapSegments } from '../src/shared/editor/snapping'
import { migrateProject } from '../src/shared/engine/project'
import { toOutput } from '../src/shared/engine/outputPoint'
import type { Camera } from '../src/shared/engine/zoom'
import { defaultZoom, isMagnifier, lensBox, lensCamera, magnifierPhase, MAGNIFIER, newMagnifier, spotlightIcon, spotlightName } from '../src/shared/render/magnifier'
import type { Clip, Project, Spotlight } from '../src/shared/types'
import { p20, spot } from './groupFixture'
import { rng } from './verticalFixtures'

/*
 * The magnifier's pure parts (docs/design/editing-polish.md §6, §19.1 tests 25, 26, 27 and 30): how
 * it grows in and out, the lens camera, a new magnifier's size, place and zoom, and a magnifier
 * being a spotlight for every edit (selection, clipboard, nudge, moves, snapping, load and save).
 */

const mag = (start: number, end: number, extra: Partial<Spotlight> = {}): Spotlight => ({
  id: 'm',
  mode: 'region',
  start,
  end,
  x: 0.4,
  y: 0.4,
  w: 0.2,
  h: 0.3,
  shape: 'ellipse',
  dim: 0,
  feather: 0,
  magnify: 2.5,
  ...extra
})
const ONE: Clip[] = [{ id: 'c', start: 0, end: 100, speed: 1 }]

describe('magnifierPhase (test 25)', () => {
  it('is null outside the item and for a plain spotlight', () => {
    const s = mag(2, 5)
    expect(magnifierPhase(s, 1.99, ONE, false)).toBeNull()
    expect(magnifierPhase(s, 5, ONE, false)).toBeNull()
    expect(magnifierPhase({ ...s, magnify: undefined }, 3, ONE, false)).toBeNull()
  })

  it('g is 0 at the start and the end, 1 in between; r and z follow g', () => {
    const s = mag(2, 5)
    expect(magnifierPhase(s, 2, ONE, false)).toEqual({ r: 0.6, z: 1, alpha: 0 })
    const end = magnifierPhase(s, 5 - 1e-9, ONE, false)!
    expect(end.alpha).toBeLessThan(1e-6)
    expect(end.r).toBeCloseTo(0.6, 6)
    expect(end.z).toBeCloseTo(1, 6)
    expect(magnifierPhase(s, 3.5, ONE, false)).toEqual({ r: 1, z: 2.5, alpha: 1 })
    // Growing in over 0.30 s (emphasised decelerate), shrinking over 0.22 s (emphasised accelerate).
    const g = EASE.emphDecel(0.1 / 0.3)
    const at = magnifierPhase(s, 2.1, ONE, false)!
    expect(at.r).toBeCloseTo(0.6 + 0.4 * g, 12)
    expect(at.z).toBeCloseTo(1 + 1.5 * g, 12)
    expect(at.alpha).toBeCloseTo(Math.min(1, 2.5 * g), 12)
    const gOut = 1 - EASE.emphAccel(1 - 0.11 / 0.22)
    expect(magnifierPhase(s, 5 - 0.11, ONE, false)!.z).toBeCloseTo(1 + 1.5 * gOut, 9)
    expect(magnifierPhase(s, 2.3, ONE, false)!.r).toBe(1)
    expect(magnifierPhase(s, 5 - 0.22, ONE, false)!.r).toBeCloseTo(1, 9)
  })

  it('each side lasts at most half the item', () => {
    const s = mag(2, 2.3)
    // dIn = dOut = 0.15: fully grown at the middle only.
    expect(magnifierPhase(s, 2.15, ONE, false)!.r).toBeCloseTo(1, 9)
    expect(magnifierPhase(s, 2.075, ONE, false)!.r).toBeCloseTo(0.6 + 0.4 * EASE.emphDecel(0.5), 9)
    expect(magnifierPhase(s, 2.3 - 0.075, ONE, false)!.r).toBeCloseTo(0.6 + 0.4 * (1 - EASE.emphAccel(0.5)), 9)
  })

  it('runs in viewing time: on a 2x clip it grows over 0.6 s of the recording', () => {
    const fast: Clip[] = [{ id: 'c', start: 0, end: 100, speed: 2 }]
    const s = mag(10, 16)
    expect(magnifierPhase(s, 10.3, fast, false)!.r).toBeCloseTo(0.6 + 0.4 * EASE.emphDecel(0.5), 9)
    expect(magnifierPhase(s, 10.6, fast, false)!.r).toBeCloseTo(1, 9)
  })

  it('Calm motion changes only the opacity, linearly over at least 0.2 s', () => {
    const s = mag(2, 5)
    for (const t of [2, 2.05, 2.15, 3, 4.9, 4.99]) {
      const p = magnifierPhase(s, t, ONE, true)!
      expect(p.r).toBe(1)
      expect(p.z).toBe(2.5)
    }
    expect(magnifierPhase(s, 2, ONE, true)!.alpha).toBe(0)
    expect(magnifierPhase(s, 2.15, ONE, true)!.alpha).toBeCloseTo(0.5, 9)
    expect(magnifierPhase(s, 5 - 0.11, ONE, true)!.alpha).toBeCloseTo(0.5, 9)
    // A 0.3 s item: each fade at most half of it.
    expect(magnifierPhase(mag(2, 2.3), 2.075, ONE, true)!.alpha).toBeCloseTo(0.5, 9)
  })
})

describe('lensCamera (test 26)', () => {
  it('keeps the centre where it is and multiplies the scale, for 1,000 random cameras', () => {
    const r = rng(26)
    for (let i = 0; i < 1000; i++) {
      const cam: Camera = { scale: 0.5 + r() * 4, cx: r(), cy: r() }
      const P = { x: r(), y: r() }
      const z = 1.5 + r() * 2.5
      const rect = { x: r() * 200, y: r() * 200, w: 200 + r() * 1800, h: 200 + r() * 1800 }
      const lens = lensCamera(cam, P, z)
      expect(lens.scale).toBeCloseTo(cam.scale * z, 12)
      const a = toOutput(rect, cam)(P.x, P.y)
      const b = toOutput(rect, lens)(P.x, P.y)
      expect(Math.abs(a.x - b.x)).toBeLessThan(1e-9)
      expect(Math.abs(a.y - b.y)).toBeLessThan(1e-9)
      // Any other point lands z times further from the centre.
      const Q = { x: r(), y: r() }
      const qa = toOutput(rect, cam)(Q.x, Q.y)
      const qb = toOutput(rect, lens)(Q.x, Q.y)
      expect(qb.x - b.x).toBeCloseTo((qa.x - a.x) * z, 6)
      expect(qb.y - b.y).toBeCloseTo((qa.y - a.y) * z, 6)
    }
  })
})

describe('newMagnifier and defaultZoom (test 27)', () => {
  it('defaultZoom: 2 for a recording shown 1:1, 2.25 at 0.85, 2.5 at 0.43, 1.5 at 1.5', () => {
    expect(defaultZoom(1)).toBe(2)
    expect(defaultZoom(0.85)).toBe(2.25)
    expect(defaultZoom(0.43)).toBe(2.5)
    expect(defaultZoom(1.5)).toBe(1.5)
    expect(defaultZoom(0.1)).toBe(2.5)
  })

  const p = (): Project => p20()
  const rect = { x: 0, y: 0, w: 1920, h: 1080 }
  const view = (cam: Camera, cursor: { x: number; y: number } | null) => ({ rect, cam, w: 1920, h: 1080, centre: { x: cam.cx, y: cam.cy }, cursor })

  it('is 0.30 S across in the view at the playhead, with and without a zoom', () => {
    for (const cam of [{ scale: 1, cx: 0.5, cy: 0.5 }, { scale: 2, cx: 0.3, cy: 0.6 }]) {
      const { project, id } = newMagnifier(p(), 5, view(cam, null), 'region')
      const s = project.spotlights!.find((x) => x.id === id)!
      const box = lensBox(s, { x: s.x + s.w / 2, y: s.y + s.h / 2 }, rect, cam, 1, toOutput(rect, cam))
      expect(2 * box.rx).toBeCloseTo(0.3 * 1080, 9)
      expect(2 * box.ry).toBeCloseTo(0.3 * 1080, 9)
    }
  })

  it('is centred on the cursor when it shows in the view, else on the view centre', () => {
    const cam = { scale: 2, cx: 0.5, cy: 0.5 }
    const on = newMagnifier(p(), 5, view(cam, { x: 0.6, y: 0.4 }), 'region')
    const a = on.project.spotlights!.at(-1)!
    expect(a.x + a.w / 2).toBeCloseTo(0.6, 12)
    expect(a.y + a.h / 2).toBeCloseTo(0.4, 12)
    // The view spans 0.25..0.75 at 2x: a cursor at 0.9 is not in it.
    const off = newMagnifier(p(), 5, view(cam, { x: 0.9, y: 0.4 }), 'region')
    const b = off.project.spotlights!.at(-1)!
    expect(b.x + b.w / 2).toBeCloseTo(0.5, 12)
    expect(b.y + b.h / 2).toBeCloseTo(0.5, 12)
  })

  it('lasts 3 s, is fully grown at the playhead, with no darkness or soft edge, at the default zoom, in one project out', () => {
    const before = p()
    const { project, id } = newMagnifier(before, 5, view({ scale: 1, cx: 0.5, cy: 0.5 }, null), 'cursor')
    expect(before.spotlights).toEqual([])
    expect(project.spotlights).toHaveLength(1)
    const s = project.spotlights![0]
    expect(s.id).toBe(id)
    expect(s).toMatchObject({ mode: 'cursor', shape: 'ellipse', dim: 0, feather: 0, magnify: 2 })
    expect(s.end - s.start).toBeCloseTo(3, 9)
    expect(magnifierPhase(s, 5, project.clips, false)).toEqual({ r: 1, z: 2, alpha: 1 })
    expect(s.start).toBeCloseTo(5 - MAGNIFIER.enter, 9)
    // A recording drawn at 85 % (a padded card): 2.25 times; zoomed in 2x: 1.5 times.
    expect(newMagnifier(before, 5, { ...view({ scale: 1, cx: 0.5, cy: 0.5 }, null), rect: { x: 0, y: 0, w: 1632, h: 918 } }, 'region').project.spotlights![0].magnify).toBe(2.25)
    expect(newMagnifier(before, 5, view({ scale: 2, cx: 0.5, cy: 0.5 }, null), 'region').project.spotlights![0].magnify).toBe(1.5)
  })

  it('is stored in the full frame under a crop', () => {
    const crop = { x: 0.5, y: 0, w: 0.5, h: 1 }
    const { project } = newMagnifier({ ...p(), crop }, 5, view({ scale: 1, cx: 0.5, cy: 0.5 }, { x: 0.5, y: 0.5 }), 'region')
    const s = project.spotlights![0]
    // The crop's view centre is x 0.75 of the whole frame.
    expect(s.x + s.w / 2).toBeCloseTo(0.75, 12)
    expect(s.w).toBeCloseTo(((0.3 * 1080) / 1920) * 0.5, 12)
  })
})

describe('a magnifier is a spotlight for every edit (test 30)', () => {
  const m = spot('l1', 3, 5, { magnify: 2 })
  const base = (): Project => p20({ spotlights: [m] })
  const key = itemKey('spotlight', 'l1') as ItemKey

  it('names and icons', () => {
    expect(spotlightName(m)).toBe('Magnifier, 2 times')
    expect(spotlightName({ ...m, magnify: 2.25 })).toBe('Magnifier, 2.25 times')
    expect(spotlightIcon(m)).toBe('magnifier')
    expect(isMagnifier(m)).toBe(true)
    const plain = spot('l2', 1, 2)
    expect(spotlightName(plain)).toBe('Spotlight')
    expect(spotlightName({ ...plain, mode: 'cursor' })).toBe('Cursor spotlight')
    expect(spotlightIcon(plain)).toBe('spotlight')
  })

  it('is selected on the shapes track with the spotlights', () => {
    const items = projectItems(base())
    expect(items.find((x) => x.key === key)).toMatchObject({ kind: 'spotlight', track: trackOfKind('spotlight') })
  })

  it('is copied and pasted with its zoom', () => {
    const p = base()
    const r = pasteItems(p, copyItems(p, [key])!, 12)
    const pasted = r.project.spotlights![1]
    expect(pasted.id).not.toBe('l1')
    expect(pasted).toMatchObject({ magnify: 2, start: 12, end: 14 })
  })

  it('is nudged and moved with a group, keeping its zoom', () => {
    const p = base()
    const n = nudgeItems(p, [key], 3)
    expect(n.project.spotlights![0].start).toBeCloseTo(3.1, 9)
    expect(n.project.spotlights![0].magnify).toBe(2)
    const moved = moveGroup(p, groupMovePlan(p, [key]), 1)
    expect(moved.spotlights![0]).toMatchObject({ start: 4, end: 6, magnify: 2 })
  })

  it('is a snapping target like a spotlight, named as on its block', () => {
    expect(projectSnapSegments(base(), { layouts: false })).toContainEqual({ owner: 'spotlight:l1', label: 'Magnifier, 2 times', start: 3, end: 5 })
  })

  it('survives a load and a save', () => {
    const saved = JSON.parse(JSON.stringify(base()))
    const loaded = migrateProject(saved)
    expect(loaded.spotlights![0]).toEqual(m)
    expect(JSON.stringify(migrateProject(JSON.parse(JSON.stringify(loaded))))).toBe(JSON.stringify(loaded))
  })
})
