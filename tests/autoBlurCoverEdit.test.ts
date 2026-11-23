import fs from 'node:fs'
import { describe, expect, it } from 'vitest'
import {
  addCover,
  copyCovers,
  coverEndHere,
  coverFromShape,
  coversFromShapes,
  coverStartHere,
  coverWholeVideo,
  deleteCovers,
  duplicateCover,
  editCoverBox,
  keepCovers,
  moveCoverTime,
  nudgeCovers,
  pasteCovers,
  setCoverColour,
  setCoverEnds,
  withFollowedPath,
  type BoxEdit
} from '../src/shared/editor/coverEdit'
import * as coverEdit from '../src/shared/editor/coverEdit'
import * as coverGroup from '../src/shared/editor/coverGroup'
import { EditStore } from '../src/shared/editor/editStore'
import { restoreVersion } from '../src/shared/editor/versions'
import { settleDeletedWords } from '../src/shared/editor/transcript'
import { settleAutoCuts } from '../src/shared/review/autoCuts'
import { settleJoins } from '../src/shared/editor/joinsEdit'
import { settleGrade } from '../src/shared/editor/colourEdit'
import { settleCaptionAuto } from '../src/shared/captions/captionAutoSettle'
import { settleChapters } from '../src/shared/chapters/chapterAuto'
import { boxAt, coverSlack, drawnBox, parsePath, pathKeys, stepKeys, writePath, type CoverKey } from '../src/shared/privacy/coverPath'
import { readCovers, readPrivacy } from '../src/shared/privacy/coverData'
import type { Cover, NormRect, Project, Shape } from '../src/shared/types'
import { base } from './autoBlurFixtures'

/*
 * Editing covers (docs/design/auto-blur.md §2.1-2.4, §5.9, §14; §17.1 tests 42-52 and 201-204, 206).
 * Pure functions on projects built from the fixtures; every one is one store.update.
 */

const seq = (): (() => number) => {
  let i = 0
  return () => ((i++ * 0.6180339887) % 1)
}
const key = (t: number, x: number, y: number, w: number, h: number): CoverKey => ({ t, x, y, w, h })
const cover = (id: string, start: number, end: number, keys: CoverKey[], over: Partial<Cover> = {}): Cover => ({ id, start, end, path: writePath(keys), color: '#203040', ...over })
const withCovers = (p: Project, covers: Cover[]): Project => ({ ...p, covers })
const coverOf = (p: Project, id: string): Cover => p.covers!.find((c) => c.id === id)!
const near = (a: number, b: number, eps = 1e-3): boolean => Math.abs(a - b) <= eps
const boxNear = (a: NormRect | null, b: NormRect, eps = 2e-4): void => {
  expect(a).not.toBeNull()
  for (const k of ['x', 'y', 'w', 'h'] as const) expect(Math.abs(a![k] - b[k]), `${k}: ${a![k]} vs ${b[k]}`).toBeLessThanOrEqual(eps)
}
const blur = (id: string, start: number, end: number, box: NormRect, kind: Shape['kind'] = 'blur'): Shape => ({ id, kind, start, end, ...box, color: '#000000', strokeWidth: 4, fill: true, opacity: 1, strength: 0.6 })

/** A 40-key followed cover: the text moves 0.004 down each 0.05 s from 2 s. */
function followed40(): Cover {
  const keys = Array.from({ length: 40 }, (_v, i) => key(2 + i * 0.05, 0.3, 0.2 + i * 0.004, 0.2, 0.05))
  return cover('f40', 2, 4, keys, { found: 'auto', kind: 'email', group: 'g1', thin: true, missed: true })
}

describe('auto-blur P1: cover edits', () => {
  it('42. coverFromShape: a blur shape becomes a cover over its box and times, the shape removed, in one step', () => {
    const p = { ...base('p42', 30), shapes: [blur('b1', 2, 7, { x: 0.6, y: 0.1, w: 0.25, h: 0.08 }), blur('r1', 1, 2, { x: 0.1, y: 0.1, w: 0.1, h: 0.1 }, 'rect')] }
    const store = new EditStore<Project>(p)
    let id = ''
    store.update((q) => {
      const r = coverFromShape(q, 'b1', '#112233', seq())!
      id = r.id
      return r.project
    })
    const q = store.state
    expect(q.shapes!.map((s) => s.id)).toEqual(['r1'])
    const c = coverOf(q, id)
    expect([c.start, c.end, c.color]).toEqual([2, 7, '#112233'])
    boxNear(boxAt(c, 4), { x: 0.6, y: 0.1, w: 0.25, h: 0.08 })
    expect(c.found).toBeUndefined()
    // One undo step brings the blur back and removes the cover.
    expect(store.undo()).toBe(true)
    expect(store.state).toBe(p)
    expect(store.undo()).toBe(false)
    // Another kind of shape is never turned into a cover.
    expect(coverFromShape(p, 'r1', '#112233', seq())).toBeNull()
    // A pixelate shape too, and a shape drawn with a negative width keeps its place.
    const neg = { ...base('p42b', 30), shapes: [blur('px', 1, 3, { x: 0.5, y: 0.5, w: -0.2, h: 0.1 }, 'pixelate')] }
    const r = coverFromShape(neg, 'px', '#000000', seq())!
    boxNear(boxAt(coverOf(r.project, r.id), 2), { x: 0.3, y: 0.5, w: 0.2, h: 0.1 })
  })

  it('43. editCoverBox: a move without the whole path changes the span at the playhead, with it every key; an edge moves at every key whatever wholePath says; both drop found', () => {
    const keys = [key(1, 0.1, 0.1, 0.2, 0.05), key(2, 0.12, 0.2, 0.2, 0.05), key(3, 0.14, 0.3, 0.2, 0.05)]
    const p = withCovers(base('p43', 10), [cover('c', 1, 4, keys, { found: 'check', kind: 'email', group: 'g', missed: true, thin: true })])
    const move: BoxEdit = { move: { dx: 0.05, dy: 0.01 } }
    // Off: only the span the playhead is in (the key in effect at 2.5 until the next key).
    const one = coverOf(editCoverBox(p, 'c', 2.5, move, false), 'c')
    boxNear(boxAt(one, 1.5), { x: 0.1, y: 0.1, w: 0.2, h: 0.05 })
    boxNear(boxAt(one, 2.5), { x: 0.17, y: 0.21, w: 0.2, h: 0.05 })
    boxNear(boxAt(one, 3.5), { x: 0.14, y: 0.3, w: 0.2, h: 0.05 })
    // On: every key.
    const all = coverOf(editCoverBox(p, 'c', 2.5, move, true), 'c')
    boxNear(boxAt(all, 1.5), { x: 0.15, y: 0.11, w: 0.2, h: 0.05 })
    boxNear(boxAt(all, 3.5), { x: 0.19, y: 0.31, w: 0.2, h: 0.05 })
    // An edge moves at every key with wholePath off: widening the right edge holds at every playhead.
    const wide = coverOf(editCoverBox(p, 'c', 2.5, { edges: { right: 0.03 } }, false), 'c')
    for (const [t, x] of [
      [1.5, 0.1],
      [2.5, 0.12],
      [3.5, 0.14]
    ])
      boxNear(boxAt(wide, t), { x, y: [0.1, 0.2, 0.3][Math.round(t - 1.5)], w: 0.23, h: 0.05 })
    const left = coverOf(editCoverBox(p, 'c', 1.5, { edges: { left: -0.02, top: -0.01 } }, false), 'c')
    boxNear(boxAt(left, 3.5), { x: 0.12, y: 0.29, w: 0.22, h: 0.06 })
    for (const c of [one, all, wide, left]) {
      expect(c.found).toBeUndefined()
      expect(c.missed).toBeUndefined()
      expect(c.thin).toBeUndefined()
      // What it hides and its group stay: it is the user's now, still one Review row.
      expect([c.kind, c.group]).toEqual(['email', 'g'])
    }
    // Held inside the frame.
    const out = coverOf(editCoverBox(p, 'c', 1.5, { move: { dx: 2, dy: -2 } }, true), 'c')
    for (const k of pathKeys(out)) {
      expect(k.x + k.w).toBeLessThanOrEqual(1 + 1e-9)
      expect(k.y).toBeGreaterThanOrEqual(0)
    }
  })

  it('44. setCoverEnds holds the first and last boxes; moveCoverTime is null for a cover with two or more keys and moves a one-key cover', () => {
    const keys = [key(2, 0.1, 0.1, 0.2, 0.05), key(3, 0.3, 0.3, 0.2, 0.05)]
    const p = withCovers(base('p44', 10), [cover('two', 2, 4, keys), cover('one', 5, 6, [key(5, 0.5, 0.5, 0.1, 0.1)], { found: 'auto', kind: 'key' })])
    const longer = coverOf(setCoverEnds(p, 'two', 1, 6), 'two')
    expect([longer.start, longer.end]).toEqual([1, 6])
    boxNear(boxAt(longer, 1), { x: 0.1, y: 0.1, w: 0.2, h: 0.05 })
    boxNear(boxAt(longer, 5.9), { x: 0.3, y: 0.3, w: 0.2, h: 0.05 })
    // A start moved inside the path takes the box in effect there.
    const later = coverOf(setCoverEnds(p, 'two', 3.5, 4), 'two')
    expect(later.start).toBe(3.5)
    boxNear(boxAt(later, 3.5), { x: 0.3, y: 0.3, w: 0.2, h: 0.05 })
    expect(pathKeys(later)).toHaveLength(1)
    expect(moveCoverTime(p, 'two', 1)).toBeNull()
    const moved = coverOf(moveCoverTime(p, 'one', 2)!, 'one')
    expect([moved.start, moved.end]).toEqual([7, 8])
    boxNear(boxAt(moved, 7.5), { x: 0.5, y: 0.5, w: 0.1, h: 0.1 })
    expect(moved.found).toBeUndefined()
    // Held inside the recording.
    const end = coverOf(moveCoverTime(p, 'one', 100)!, 'one')
    expect([end.start, end.end]).toEqual([9, 10])
  })

  it('45. coverWholeVideo covers 0 to the recording\'s end with the path\'s ends held', () => {
    const keys = [key(2, 0.1, 0.1, 0.2, 0.05), key(3, 0.3, 0.3, 0.2, 0.05)]
    const p = withCovers(base('p45', 12.5), [cover('c', 2, 4, keys, { found: 'auto', kind: 'card' })])
    const c = coverOf(coverWholeVideo(p, 'c'), 'c')
    expect([c.start, c.end]).toEqual([0, 12.5])
    boxNear(boxAt(c, 0), { x: 0.1, y: 0.1, w: 0.2, h: 0.05 })
    boxNear(boxAt(c, 2.5), { x: 0.1, y: 0.1, w: 0.2, h: 0.05 })
    boxNear(boxAt(c, 12.4), { x: 0.3, y: 0.3, w: 0.2, h: 0.05 })
    expect(c.found).toBeUndefined()
  })

  it('46. deleteCovers writes a rejected place (kind, times, its own path, at most 400 keys) for each suggestion and none for a user\'s cover', () => {
    const long = Array.from({ length: 900 }, (_v, i) => key(1 + i * 0.01, 0.2, 0.1 + (i % 50) * 0.01, 0.2, 0.04))
    const p = withCovers(base('p46', 20), [
      cover('s1', 1, 3, [key(1, 0.1, 0.1, 0.2, 0.05)], { found: 'auto', kind: 'email', group: 'g1' }),
      cover('s2', 1, 10, long, { found: 'check', kind: 'key', group: 'g2' }),
      cover('mine', 2, 4, [key(2, 0.5, 0.5, 0.1, 0.1)]),
      cover('kept', 2, 4, [key(2, 0.6, 0.6, 0.1, 0.1)], { kind: 'phone', group: 'g3' })
    ])
    const q = deleteCovers(p, ['s1', 's2', 'mine', 'kept'])
    expect(q.covers).toBeUndefined()
    const rejected = q.privacy!.rejected!
    expect(rejected.map((r) => [r.kind, r.start, r.end])).toEqual([
      ['email', 1, 3],
      ['key', 1, 10]
    ])
    expect(rejected[0].path).toBe(coverOf(p, 's1').path)
    const keys = parsePath(rejected[1].path)!
    expect(keys.length).toBeLessThanOrEqual(400)
    // Simplifying only grows boxes: the removed path still holds every box it had.
    for (const k of parsePath(coverOf(p, 's2').path)!) {
      const held = drawnBox({ id: 'r', start: 1, end: 10, path: rejected[1].path, color: '#000000' }, k.t, 0)!
      expect(held.x).toBeLessThanOrEqual(k.x + 1e-9)
      expect(held.y + held.h).toBeGreaterThanOrEqual(k.y + k.h - 1e-9)
    }
    // It reads back as it was written.
    expect(readPrivacy(q.privacy, 20)!.rejected).toEqual(rejected)
    // A user's cover leaves nothing.
    expect(deleteCovers(withCovers(base('p46b', 9), [cover('m', 1, 2, [key(1, 0.1, 0.1, 0.1, 0.1)])]), ['m']).privacy).toBeUndefined()
  })

  it('47. keepCovers drops found, missed and thin', () => {
    const p = withCovers(base('p47', 9), [cover('a', 1, 2, [key(1, 0.1, 0.1, 0.1, 0.1)], { found: 'check', missed: true, thin: true, kind: 'email', group: 'g', lost: true }), cover('b', 1, 2, [key(1, 0.1, 0.1, 0.1, 0.1)], { found: 'auto' })])
    const q = keepCovers(p, ['a'])
    expect(coverOf(q, 'a')).toEqual({ id: 'a', start: 1, end: 2, path: coverOf(p, 'a').path, color: '#203040', kind: 'email', group: 'g', lost: true })
    expect(coverOf(q, 'b')).toBe(coverOf(p, 'b'))
    // A user's cover already kept: nothing changes.
    expect(keepCovers(q, ['a'])).toBe(q)
  })

  it('48. nudgeCovers moves whole paths by pixels in normalised units, clamped to the frame', () => {
    const keys = [key(1, 0.1, 0.1, 0.2, 0.05), key(2, 0.7, 0.2, 0.2, 0.05)]
    const p = withCovers(base('p48', 9, { width: 2000, height: 1000 }), [cover('c', 1, 3, keys, { found: 'auto', kind: 'key' })])
    const c = coverOf(nudgeCovers(p, ['c'], 10, -5), 'c')
    boxNear(boxAt(c, 1.5), { x: 0.105, y: 0.095, w: 0.2, h: 0.05 })
    boxNear(boxAt(c, 2.5), { x: 0.705, y: 0.195, w: 0.2, h: 0.05 })
    expect(c.found).toBeUndefined()
    // Clamped: the right key cannot pass the frame's edge.
    const far = coverOf(nudgeCovers(p, ['c'], 400, 0), 'c')
    boxNear(boxAt(far, 2.5), { x: 0.8, y: 0.2, w: 0.2, h: 0.05 })
    boxNear(boxAt(far, 1.5), { x: 0.3, y: 0.1, w: 0.2, h: 0.05 })
  })

  it('49. Copy and paste (finding 18): a paste holds the cover as it was when copied, even after the source is edited; another project gives null and privacy.cover.oneProject; no OS clipboard is used', async () => {
    const p = withCovers(base('p49', 20), [cover('c', 2, 4, [key(2, 0.1, 0.1, 0.2, 0.05)], { found: 'auto', kind: 'email', group: 'g' })])
    const clip = copyCovers(p, ['c'], 3)
    // The source changes after the copy.
    const edited = setCoverColour(editCoverBox(p, 'c', 3, { move: { dx: 0.4, dy: 0.4 } }, true), ['c'], '#ffffff')
    const r = pasteCovers(edited, clip, 10, seq())!
    expect(r.ids).toHaveLength(1)
    const pasted = coverOf(r.project, r.ids[0])
    expect([pasted.start, pasted.end, pasted.color]).toEqual([9, 11, '#203040'])
    boxNear(boxAt(pasted, 10), { x: 0.1, y: 0.1, w: 0.2, h: 0.05 })
    // The user's, in no group, with a new id.
    expect(pasted.id).not.toBe('c')
    expect([pasted.found, pasted.group]).toEqual([undefined, undefined])
    // Another project: refused, with the one-project message.
    expect(pasteCovers({ ...edited, id: 'other' }, clip, 10, seq())).toBeNull()
    const { copyItems, pasteItems, pasteNotice } = await import('../src/shared/editor/groupClipboard')
    const items = copyItems(p, ['cover:c'])!
    const refused = pasteItems({ ...p, id: 'other' }, items, 5)
    expect(refused.keys).toEqual([])
    expect(pasteNotice(refused, 1)).toBe('Covers paste only into the video they were copied from.')
    // No OS clipboard: the copy is plain data the editor keeps in memory (itemClipboard.ts never touches navigator.clipboard).
    const fs = await import('node:fs')
    for (const f of ['src/shared/editor/coverEdit.ts', 'src/shared/editor/groupClipboard.ts', 'src/renderer/src/editor/itemClipboard.ts']) expect(fs.readFileSync(f, 'utf8')).not.toMatch(/navigator\.clipboard|clipboard\.write|readText|clipboardData/)
  })

  it('50. duplicateCover gives a new id and the same path', () => {
    const keys = [key(2, 0.1, 0.1, 0.2, 0.05), key(3, 0.3, 0.3, 0.2, 0.05)]
    const p = withCovers(base('p50', 9), [cover('c', 2, 4, keys, { found: 'check', kind: 'email', group: 'g' })])
    const r = duplicateCover(p, 'c', seq())
    expect(r.id).not.toBe('c')
    const d = coverOf(r.project, r.id)
    expect([d.start, d.end, d.path, d.color, d.kind]).toEqual([2, 4, coverOf(p, 'c').path, '#203040', 'email'])
    expect([d.found, d.group]).toEqual([undefined, undefined])
    expect(coverOf(r.project, 'c')).toBe(coverOf(p, 'c'))
  })

  it('51. withFollowedPath never covers less than the old path where the walk was lost or outside the time it walked', () => {
    const oldBox = { x: 0.4, y: 0.4, w: 0.2, h: 0.05 }
    const p = withCovers(base('p51', 30), [cover('c', 2, 30, [key(2, oldBox.x, oldBox.y, oldBox.w, oldBox.h)], { found: 'auto', kind: 'email' })])
    // The walk reached 4 to 12; the text moved up from 6; lost from 8 to 9.
    const fkeys = [key(4, 0.4, 0.4, 0.2, 0.05), key(6, 0.4, 0.3, 0.2, 0.05), key(8, 0.4, 0.2, 0.2, 0.05), key(10, 0.4, 0.1, 0.2, 0.05)]
    const result = { ok: true as const, projectId: 'p51', requestId: 'r', path: writePath(fkeys), start: 4, end: 12, walked: { start: 4, end: 12 }, lostSpans: '8 9', thin: false }
    const c = coverOf(withFollowedPath(p, 'c', result), 'c')
    expect([c.start, c.end]).toEqual([2, 30])
    const contains = (outer: NormRect | null, inner: NormRect): boolean => !!outer && outer.x <= inner.x + 1e-9 && outer.y <= inner.y + 1e-9 && outer.x + outer.w >= inner.x + inner.w - 1e-9 && outer.y + outer.h >= inner.y + inner.h - 1e-9
    for (let t = 2; t < 30; t += 0.05) {
      const inWalk = t >= 4 && t < 12
      const lost = t >= 8 && t < 9
      const now = boxAt(c, t)
      if (!inWalk || lost) expect(contains(now, oldBox), `t ${t.toFixed(2)}`).toBe(true)
      if (inWalk) expect(contains(now, boxAt({ id: 'f', start: 4, end: 12, path: result.path, color: '#000000' }, t)!), `t ${t.toFixed(2)}`).toBe(true)
    }
    // Inside the walk where it was placed, the old place is no longer covered: at 7 the box is the followed one alone.
    boxNear(boxAt(c, 7), { x: 0.4, y: 0.3, w: 0.2, h: 0.05 })
    expect(c.found).toBeUndefined()
    // A thin result marks the cover thin.
    expect(coverOf(withFollowedPath(p, 'c', { ...result, thin: true }), 'c').thin).toBe(true)
  })

  it('52. Every exported edit function of coverEdit.ts and coverGroup.ts drops found from what it changes (one property test over all of them)', () => {
    const suggestion = (id: string, keys: CoverKey[]): Cover => cover(id, 2, 6, keys, { found: 'auto', missed: true, thin: true, kind: 'email', group: 'g' })
    const one = [key(2, 0.2, 0.2, 0.2, 0.05)]
    const two = [key(2, 0.2, 0.2, 0.2, 0.05), key(4, 0.3, 0.3, 0.2, 0.05)]
    const p = withCovers({ ...base('p52', 20) }, [suggestion('a', one), suggestion('b', two)])
    const follow = { ok: true as const, projectId: 'p52', requestId: 'r', path: writePath(two), start: 2, end: 8, walked: { start: 2, end: 8 }, lostSpans: '', thin: false }
    const look = coverGroup.coverLookOf({ ...coverOf(p, 'a'), color: '#ffffff' })
    // Each edit that changes covers, by its export name.
    const edits: Record<string, (q: Project) => Project | null> = {
      editCoverBox: (q) => coverEdit.editCoverBox(q, 'b', 3, { move: { dx: 0.01, dy: 0 } }, false),
      setCoverEnds: (q) => coverEdit.setCoverEnds(q, 'b', 1, 7),
      coverStartHere: (q) => coverEdit.coverStartHere(q, 'b', 3),
      coverEndHere: (q) => coverEdit.coverEndHere(q, 'b', 5),
      moveCoverTime: (q) => coverEdit.moveCoverTime(q, 'a', 1),
      coverWholeVideo: (q) => coverEdit.coverWholeVideo(q, 'b'),
      setCoverColour: (q) => coverEdit.setCoverColour(q, ['a', 'b'], '#ffffff'),
      keepCovers: (q) => coverEdit.keepCovers(q, ['a', 'b']),
      nudgeCovers: (q) => coverEdit.nudgeCovers(q, ['a', 'b'], 3, 3),
      withFollowedPath: (q) => coverEdit.withFollowedPath(q, 'b', follow),
      moveCoversInTime: (q) => coverGroup.moveCoversInTime(q, ['a', 'b'], 1).project,
      pasteCoverLook: (q) => coverGroup.pasteCoverLook(q, ['a', 'b'], look)
    }
    // Functions that make covers rather than change one: what they make is the user's.
    const makers: Record<string, (q: Project) => { project: Project; ids: string[] } | null> = {
      addCoverSpan: (q) => {
        const r = coverEdit.addCoverSpan(q, { start: 1, end: 4, box: { x: 0.1, y: 0.1, w: 0.3, h: 0.1 }, color: '#000000' }, seq())
        return { project: r.project, ids: [r.id] }
      },
      addCover: (q) => {
        const r = coverEdit.addCover(q, { t: 3, box: { x: 0.1, y: 0.1, w: 0.3, h: 0.1 }, length: 'three', color: '#000000' }, seq())
        return { project: r.project, ids: [r.id] }
      },
      duplicateCover: (q) => {
        const r = coverEdit.duplicateCover(q, 'a', seq())
        return { project: r.project, ids: [r.id] }
      },
      pasteCovers: (q) => coverEdit.pasteCovers(q, coverEdit.copyCovers(q, ['a', 'b'], 3), 5, seq()),
      coversFromShapes: (q) => coverEdit.coversFromShapes({ ...q, shapes: [blur('s', 1, 3, { x: 0.1, y: 0.1, w: 0.1, h: 0.1 })] }, ['s'], {}, seq()),
      coverFromShape: (q) => {
        const r = coverEdit.coverFromShape({ ...q, shapes: [blur('s', 1, 3, { x: 0.1, y: 0.1, w: 0.1, h: 0.1 })] }, 's', '#000000', seq())
        return r && { project: r.project, ids: [r.id] }
      }
    }
    // Functions that read, remove or make no cover: listed, so a new export cannot be left out of this test.
    const others = new Set(['newCoverId', 'boxInFrame', 'coverBoxAt', 'settled', 'coverTimes', 'coverBoxAtTime', 'rejectedPlaceOf', 'deleteCovers', 'copyCovers', 'coverActiveAt', 'COVER_SECONDS', 'NEW_COVER_SIZE', 'MIN_COVER_LENGTH', 'MIN_COVER_SIDE'])
    const groupOthers = new Set(['coverItems', 'coverTrackOf', 'followsText', 'deleteCoverItems', 'coverLookOf', 'validCoverSelection', 'groupCoverIds'])
    for (const name of Object.keys(coverEdit)) expect(name in edits || name in makers || others.has(name), `coverEdit.${name} is listed`).toBe(true)
    for (const name of Object.keys(coverGroup)) expect(name in edits || groupOthers.has(name), `coverGroup.${name} is listed`).toBe(true)
    for (const [name, edit] of Object.entries(edits)) {
      const q = edit(p)
      expect(q, name).not.toBeNull()
      const changed = q!.covers!.filter((c) => c !== p.covers!.find((x) => x.id === c.id))
      expect(changed.length, `${name} changes a cover`).toBeGreaterThan(0)
      for (const c of changed) expect([c.found, c.missed, c.id === 'b' && name === 'withFollowedPath' ? undefined : c.thin], `${name} ${c.id}`).toEqual([undefined, undefined, undefined])
    }
    for (const [name, make] of Object.entries(makers)) {
      const r = make(p)!
      for (const id of r.ids) expect([coverOf(r.project, id).found, coverOf(r.project, id).missed, coverOf(r.project, id).thin], `${name}`).toEqual([undefined, undefined, undefined])
    }
  })

  it('201. Versions and undo never settle (finding 19): restoring a version, opening one, and undo and redo across a Find leave every found, missed, thin and auto as they were', () => {
    const start = { ...base('p201', 30), transcript: { language: 'en', provider: 'local' as const, model: 'm', createdAt: '2026-11-01T09:00:00.000Z', segments: [] } }
    const found: Cover[] = [
      cover('a', 1, 3, [key(1, 0.1, 0.1, 0.2, 0.05)], { found: 'auto', kind: 'email', group: 'g1', thin: true }),
      cover('b', 4, 6, [key(4, 0.2, 0.2, 0.2, 0.05)], { found: 'check', kind: 'key', group: 'g2', missed: true }),
      cover('c', 7, 9, [key(7, 0.3, 0.3, 0.2, 0.05)], { kind: 'phone', group: 'g3' })
    ]
    const bleeps = [{ id: 'pb', start: 10, end: 11, word: ':card:k3v9q2m8xa', sound: 'tone' as const, auto: true as const }]
    // The editor's store with its own settle chain (Editor.tsx: exactly these steps, none for covers).
    const editor = fs.readFileSync('src/renderer/src/views/Editor.tsx', 'utf8')
    expect(editor).toContain('settleChapters(settleGrade(settleJoins(settleAutoCuts(settleCaptionAuto(settleDeletedWords(next, prev), prev), prev), prev), prev), prev)')
    const store = new EditStore<Project>(start, undefined, undefined, undefined, (next, prev) =>
      settleChapters(settleGrade(settleJoins(settleAutoCuts(settleCaptionAuto(settleDeletedWords(next, prev), prev), prev), prev), prev), prev)
    )
    // A Find lands as one update.
    store.update((p) => ({ ...p, covers: found, bleeps, privacy: { find: { at: '2026-11-20T10:00:00.000Z', kinds: ['email'], listened: true } } }))
    const afterFind = store.state
    const marks = (p: Project): unknown => [p.covers?.map((c) => [c.id, c.found, c.missed, c.thin]), p.bleeps?.map((b) => [b.id, b.auto])]
    const want = marks(afterFind)
    // An edit that is not about covers, then undo and redo across the Find.
    store.update((p) => ({ ...p, name: 'renamed' }))
    expect(marks(store.state)).toEqual(want)
    store.undo()
    expect(marks(store.state)).toEqual(want)
    store.undo()
    expect(store.state.covers).toBeUndefined()
    store.redo()
    expect(marks(store.state)).toEqual(want)
    store.redo()
    expect(marks(store.state)).toEqual(want)
    // Restoring a version (as Versions does: one update between seals) and opening one keep them.
    const version = JSON.parse(JSON.stringify(afterFind)) as Project
    store.seal()
    store.update((p) => restoreVersion(p, version))
    store.seal()
    expect(marks(store.state)).toEqual(want)
    // Opening the version's file (migration reads it) keeps them too.
    expect(readCovers(version.covers, version.duration)!.map((c) => [c.id, c.found, c.missed, c.thin])).toEqual((want as unknown[])[0])
  })

  it('202. A size change on a 40-key followed cover, by an edge and by the Width field, holds at the playhead and every other key; a move with Change the whole path off moves one span only', () => {
    const c = followed40()
    const p = withCovers(base('p202', 20), [c])
    const before = pathKeys(c)
    // The Width field at the playhead: its width to 0.26 moves the right edge by the same amount at every key.
    const at = 3.03
    const w = boxAt(c, at)!.w
    const byField = coverOf(editCoverBox(p, 'f40', at, { edges: { right: 0.26 - w } }, false), 'f40')
    const byHandle = coverOf(editCoverBox(p, 'f40', 2.2, { edges: { right: 0.06 } }, false), 'f40')
    for (const changed of [byField, byHandle]) {
      const keys = pathKeys(changed)
      expect(keys).toHaveLength(40)
      keys.forEach((k, i) => {
        expect(near(k.x, before[i].x, 1e-4)).toBe(true)
        expect(near(k.w, 0.26, 2e-4), `key ${i}: ${k.w}`).toBe(true)
        expect(near(k.y, before[i].y, 1e-4)).toBe(true)
      })
    }
    // A move with the whole path off: only the span at the playhead (one key) moves.
    const moved = pathKeys(coverOf(editCoverBox(p, 'f40', 3.03, { move: { dx: 0.1, dy: 0 } }, false), 'f40'))
    const changedKeys = moved.filter((k, i) => !near(k.x, before[i].x, 1e-6))
    expect(changedKeys).toHaveLength(1)
    expect(near(changedKeys[0].t, 3, 1e-6)).toBe(true)
  })

  it('203. coverStartHere and coverEndHere hold the box at the playhead, are one undo step each, and are null outside the cover', () => {
    const c = followed40()
    const p = withCovers(base('p203', 20), [c])
    const store = new EditStore<Project>(p)
    const box = boxAt(c, 2.51)!
    store.update((q) => coverStartHere(q, 'f40', 2.51) ?? q)
    const started = coverOf(store.state, 'f40')
    expect(near(started.start, 2.51)).toBe(true)
    boxNear(boxAt(started, started.start), box)
    store.seal()
    const endBox = boxAt(c, 3.59)!
    store.update((q) => coverEndHere(q, 'f40', 3.6) ?? q)
    const ended = coverOf(store.state, 'f40')
    expect(near(ended.end, 3.6)).toBe(true)
    boxNear(boxAt(ended, 3.59), endBox)
    store.undo()
    expect(coverOf(store.state, 'f40')).toBe(started)
    store.undo()
    expect(store.state).toBe(p)
    // Outside the cover: null (the buttons are disabled with privacy.cover.outside).
    expect(coverStartHere(p, 'f40', 1)).toBeNull()
    expect(coverEndHere(p, 'f40', 4.5)).toBeNull()
    expect(coverStartHere(p, 'missing', 3)).toBeNull()
  })

  it('204. Follow on a To the end of the video cover over an email that then scrolls: after the scroll no frame has a box at the old place; where the walk was lost, the old box stays', () => {
    const at = { x: 0.3, y: 0.6, w: 0.25, h: 0.04 }
    const made = addCover(base('p204', 40), { t: 5, box: at, length: 'toEnd', color: '#ffffff' }, seq())
    const id = made.id
    expect([coverOf(made.project, id).start, coverOf(made.project, id).end]).toEqual([5, 40])
    // The email scrolls up from 10 to 12 (every second frame placed at 60 fps), then stays to the end; the walk was lost from 11 to 11.2.
    const placements = [{ t: 5, box: at }]
    for (let i = 0; i <= 60; i++) placements.push({ t: 10 + i / 30, box: { ...at, y: 0.6 - i * 0.005 } })
    const path = writePath(stepKeys(placements, 60))
    const result = { ok: true as const, projectId: made.project.id, requestId: 'r', path, start: 5, end: 40, walked: { start: 5, end: 40 }, lostSpans: '11 11.2', thin: false }
    const c = coverOf(withFollowedPath(made.project, id, result), id)
    const overlapsOld = (b: NormRect | null): boolean => !!b && b.y < at.y + at.h - 1e-6 && b.y + b.h > at.y + 1e-6
    for (let t = 12.1; t < 40; t += 0.25) expect(overlapsOld(drawnBox(c, t, coverSlack(60))), `t ${t}`).toBe(false)
    for (let t = 11; t < 11.2; t += 0.02) expect(overlapsOld(boxAt(c, t)), `lost at ${t}`).toBe(true)
  })

  it('206. Turn into covers on three selected blur shapes, and Turn them all into covers, are one undo step each and leave no blur or pixelate shape behind', () => {
    const shapes = [
      blur('b1', 1, 3, { x: 0.1, y: 0.1, w: 0.1, h: 0.1 }),
      blur('b2', 2, 4, { x: 0.3, y: 0.1, w: 0.1, h: 0.1 }),
      blur('b3', 3, 5, { x: 0.5, y: 0.1, w: 0.1, h: 0.1 }, 'pixelate'),
      blur('b4', 3, 5, { x: 0.7, y: 0.1, w: 0.1, h: 0.1 }),
      blur('arrow', 1, 2, { x: 0.1, y: 0.5, w: 0.1, h: 0.1 }, 'arrow')
    ]
    const p = { ...base('p206', 20), shapes }
    const store = new EditStore<Project>(p)
    store.update((q) => coversFromShapes(q, ['b1', 'b2', 'b3'], { b1: '#101010' }, seq()).project)
    expect(store.state.shapes!.map((s) => s.id)).toEqual(['b4', 'arrow'])
    expect(store.state.covers!.map((c) => [c.start, c.end, c.color])).toEqual([
      [1, 3, '#101010'],
      [2, 4, '#1c1c22'],
      [3, 5, '#1c1c22']
    ])
    store.undo()
    expect(store.state).toBe(p)
    // Turn them all into covers: every blur and pixelate shape, one step.
    store.update((q) => coversFromShapes(q, (q.shapes ?? []).map((s) => s.id), {}, seq()).project)
    expect(store.state.shapes!.map((s) => s.kind)).toEqual(['arrow'])
    expect(store.state.covers).toHaveLength(4)
    store.undo()
    expect(store.state).toBe(p)
  })
})

