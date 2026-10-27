// Freeze frame edits (E-11, docs/design/freeze-frame.md §4.8): the anchor under the playhead, the
// refusals, and each edit returning the same project when it changes nothing.
import { describe, expect, it } from 'vitest'
import {
  atEditEnd,
  canMoveFreeze,
  freezeAtPlayhead,
  freezeIdAt,
  freezeRefusal,
  freezeTextRange,
  moveFreeze,
  removeFreeze,
  setFreezeLength,
  setFreezeSound,
  setStillEnd,
  stillEndsAt
} from '../src/shared/editor/freezeEdit'
import { outputToSourceRanges } from '../src/shared/editor/smartSpeed'
import { buildSnapIndex, projectFreezeTargets, projectSnapSources, snapAt, type SnapIndex, type SnapLimit } from '../src/shared/editor/snapping'
import { freezePlan, MAX_FREEZES, videoDuration } from '../src/shared/engine/freeze'
import { readFreezes } from '../src/shared/engine/freezeData'
import { createProject, migrateProject } from '../src/shared/engine/project'
import { outputDuration, setTrimEnd } from '../src/shared/engine/timeline'
import type { Clip, Freeze, Project } from '../src/shared/types'

const base = (clips: Clip[] = [{ id: 'a', start: 0, end: 10, speed: 1 }], fps = 60): Project => ({
  ...createProject({
    id: 'p',
    name: 'Freeze',
    duration: 10,
    width: 1280,
    height: 720,
    hasWebcam: false,
    hasAudio: true,
    webcamOffset: 0,
    zooms: [],
    cursorValid: false,
    capture: { method: 'chromium', cursorInVideo: true, region: null, fps }
  }),
  clips
})
const freeze = (id: string, at: number, length = 3, sound: Freeze['sound'] = 'pause'): Freeze => ({ id, at, length, sound })
const cutClips: Clip[] = [
  { id: 'a', start: 0, end: 4, speed: 1 },
  { id: 'b', start: 6, end: 10, speed: 1 }
]

/** A recording of `end` seconds kept whole, or cut into `clips`. */
const long = (end: number, clips: Clip[] = [{ id: 'a', start: 0, end, speed: 1 }]): Project => ({ ...base(clips), duration: end })

/** As FreezeMarks begins a drag of freeze `id` (it is no target), plus `clicks`. */
const dragIndex = (p: Project, id: string, clicks: number[] = []): SnapIndex => {
  const exclude = [{ owner: `freeze:${id}` }]
  return buildSnapIndex({ ...projectSnapSources(p, [], { playhead: null, layouts: false, freezes: projectFreezeTargets(p, exclude) }), clicks }, exclude)
}

/** Source second the still of `id` ends at on the timeline (its right edge), as FreezeMarks draws it. */
const stillEndOf = (p: Project, id: string): number | undefined => {
  const s = freezePlan(p.clips, p.freezes).stills.find((x) => x.id === id)
  return s && outputToSourceRanges(p.clips, s.editStart, s.editEnd).at(-1)?.end
}

/** The project and freeze of a successful freezeAtPlayhead. */
function added(p: Project, t: number, init?: Parameters<typeof freezeAtPlayhead>[2]): { project: Project; f: Freeze } {
  const r = freezeAtPlayhead(p, t, init)
  if (!('project' in r)) throw new Error(`refused: ${r.refused}`)
  return { project: r.project, f: r.project.freezes!.find((x) => x.id === r.id)! }
}

describe('freeze at the playhead', () => {
  it('holds the frame under the playhead for 3 s with the sound paused', () => {
    const { project, f } = added(base(), 3)
    expect(f).toMatchObject({ at: 3, length: 3, sound: 'pause' })
    expect(project.freezes).toHaveLength(1)
  })

  it('anchors on the start of the source frame, rounded up to whole ms', () => {
    expect(added(base(), 2.02).f.at).toBe(2.017)
    expect(added(base(), 2.0166).f.at).toBe(2.0)
    expect(added(base(undefined, 30), 2.02).f.at).toBe(2)
    // Never before the clip: a clip starting between frames.
    expect(added(base([{ id: 'a', start: 1.0004, end: 10, speed: 1 }]), 1.005).f.at).toBe(1.001)
    // Whole ms survive saving.
    const { project } = added(base(), 7.777)
    expect(readFreezes(project.freezes, 10)).toEqual(project.freezes)
  })

  it('refuses in a cut, where a freeze is, where the picture is already frozen, and past the limit', () => {
    expect(freezeAtPlayhead(base(cutClips), 5)).toEqual({ refused: 'cut' })
    const one = { ...base(), freezes: [freeze('x', 3)] }
    expect(freezeAtPlayhead(one, 3.004)).toEqual({ refused: 'taken', id: 'x' })
    const still = { ...base(), freezes: [freeze('k', 3, 2, 'continue')] }
    expect(freezeAtPlayhead(still, 4)).toEqual({ refused: 'frozen', id: 'k' })
    expect('project' in freezeAtPlayhead(still, 5.5)).toBe(true)
    const full = { ...base(), freezes: Array.from({ length: MAX_FREEZES }, (_, i) => freeze(`f${i}`, i * 0.04)) }
    expect(freezeAtPlayhead(full, 9.5)).toEqual({ refused: 'full' })
    expect(freezeRefusal(base(), 3)).toBeNull()
  })

  it('names the freeze the playhead is on', () => {
    const p = { ...base(), freezes: [freeze('x', 3), freeze('k', 6, 2, 'continue')] }
    expect(freezeIdAt(p, 3.005)).toBe('x')
    expect(freezeIdAt(p, 7)).toBe('k')
    expect(freezeIdAt(p, 5)).toBeNull()
  })

  it('freezes the end of the edit with the sound paused (nothing plays after it)', () => {
    const p = base(cutClips)
    expect(added(p, 10 - 0.0005).f).toMatchObject({ at: 10, sound: 'pause' })
    expect(added(p, 10, { sound: 'continue' }).f.sound).toBe('pause')
    expect(added(p, 3, { sound: 'continue', length: 1.26 }).f).toMatchObject({ sound: 'continue', length: 1.3 })
  })

  it('keeps the list sorted by anchor', () => {
    const p = { ...base(), freezes: [freeze('a', 2), freeze('c', 8)] }
    expect(added(p, 5).project.freezes!.map((f) => f.at)).toEqual([2, 5, 8])
  })
})

describe('edits', () => {
  const p = { ...base(cutClips), freezes: [freeze('a', 2), freeze('b', 8, 2, 'continue')] }

  it('length: tenths within 0.5..30, the same project when nothing changes', () => {
    expect(setFreezeLength(p, 'a', 0.26).freezes![0].length).toBe(0.5)
    expect(setFreezeLength(p, 'a', 31).freezes![0].length).toBe(30)
    expect(setFreezeLength(p, 'a', 4.44).freezes![0].length).toBe(4.4)
    expect(setFreezeLength(p, 'a', 3)).toBe(p)
    expect(setFreezeLength(p, 'a', 3.04)).toBe(p)
    expect(setFreezeLength(p, 'nope', 5)).toBe(p)
  })

  it('sound: switches the mode, never to continue at the edit end', () => {
    expect(setFreezeSound(p, 'a', 'continue').freezes![0].sound).toBe('continue')
    expect(setFreezeSound(p, 'a', 'pause')).toBe(p)
    const end = { ...p, freezes: [freeze('e', 10)] }
    expect(setFreezeSound(end, 'e', 'continue')).toBe(end)
  })

  it('move: to the frame under the pointer, not into a cut or onto another freeze', () => {
    const moved = moveFreeze(p, 'a', 3.02)
    expect(moved.freezes!.map((f) => [f.id, f.at])).toEqual([
      ['a', 3.017],
      ['b', 8]
    ])
    expect(moveFreeze(p, 'a', 5)).toBe(p)
    expect(moveFreeze(p, 'a', 8.003)).toBe(p)
    expect(moveFreeze(p, 'a', 2.005)).toBe(p)
    // Past the other one: still sorted.
    expect(moveFreeze(p, 'a', 9).freezes!.map((f) => f.id)).toEqual(['b', 'a'])
  })

  it('move: onto a cut, the last frame before it (a clip ends where the cut starts, in no clip)', () => {
    const at = (q: Project, t: number): number => moveFreeze(q, 'a', t).freezes!.find((f) => f.id === 'a')!.at
    expect(at(p, 4)).toBe(3.984)
    expect(at(p, 6)).toBe(6)
    expect(at(p, 10)).toBe(10)
    expect(at({ ...base(cutClips, 30), freezes: [freeze('a', 2)] }, 4)).toBe(3.967)
    // A split: its edge is the next clip's first frame.
    const split = { ...base([{ id: 'a', start: 0, end: 4, speed: 1 }, { id: 'b', start: 4, end: 10, speed: 2 }]), freezes: [freeze('a', 2)] }
    expect(at(split, 4)).toBe(4)
  })

  it('move: a drag snapped to a cut (E-05) lands on the last frame before it', () => {
    const q = { ...base([{ id: 'a', start: 0, end: 3, speed: 1 }, { id: 'b', start: 5, end: 10, speed: 1 }]), freezes: [freeze('f', 1)] }
    const idx = dragIndex(q, 'f')
    // As FreezeMarks limits the drag.
    const limit: SnapLimit = { min: 0, max: q.duration, accept: (t) => canMoveFreeze(q, 'f', t) }
    for (const raw of [2.65, 2.8, 2.99]) {
      const snapped = snapAt(idx, raw, { pxPerSec: 20, current: null }, limit)
      expect(snapped).toMatchObject({ t: 3, target: { label: 'Cut' } })
      expect(moveFreeze(q, 'f', snapped.t).freezes![0].at).toBe(2.984)
    }
    // Inside the cut no frame takes it.
    expect(canMoveFreeze(q, 'f', 4)).toBe(false)
    expect(canMoveFreeze(q, 'f', 5)).toBe(true)
  })

  it('move: a drag never snaps onto a frame moveFreeze refuses, so a freeze can be dropped next to another (E-05)', () => {
    // A 10-minute recording at fit: 8 px is about 4 s. B is dragged left towards A.
    const q = { ...long(600), freezes: [freeze('A', 100), freeze('B', 110)] }
    const idx = dragIndex(q, 'B')
    const view = { pxPerSec: 1.93, current: null }
    expect(snapAt(idx, 98, view, { min: 0, max: 600 })).toMatchObject({ t: 100, target: { label: 'Freeze frame' } })
    expect(moveFreeze(q, 'B', 100)).toBe(q)
    const limit: SnapLimit = { min: 0, max: 600, accept: (t) => canMoveFreeze(q, 'B', t) }
    for (const raw of [104, 102, 98, 96]) {
      expect(snapAt(idx, raw, view, limit)).toEqual({ t: raw, target: null })
      expect(moveFreeze(q, 'B', raw).freezes!.find((f) => f.id === 'B')!.at).toBe(raw)
    }
    // A catch from before lets go as well.
    expect(snapAt(idx, 101, { ...view, current: idx.targets.find((x) => x.t === 100)! }, limit).target).toBeNull()
  })

  describe('length of a continue freeze from its right edge (E-05 snaps it only where the still really ends)', () => {
    const view = { pxPerSec: 400, current: null }
    const limitFor = (p: Project, id: string): SnapLimit => ({ min: p.freezes!.find((f) => f.id === id)!.at, max: p.duration, accept: (t) => stillEndsAt(p, id, t) })

    it('not to a click between tenths: the length is stored in tenths, so the still would end past the guide', () => {
      const p = { ...long(20), freezes: [freeze('k', 2.017, 3, 'continue')] }
      const idx = dragIndex(p, 'k', [5.37, 5.917])
      expect(snapAt(idx, 5.36, view, { min: 2.017, max: 20 })).toMatchObject({ t: 5.37, target: { label: 'Click' } })
      expect(stillEndOf(setStillEnd(p, 'k', 5.37), 'k')).toBeCloseTo(5.417, 9)
      expect(snapAt(idx, 5.36, view, limitFor(p, 'k'))).toEqual({ t: 5.36, target: null })
      expect(setStillEnd(p, 'k', 5.36).freezes![0].length).toBe(3.3)
      // A click a whole number of tenths after the frame: the still ends exactly on it.
      const on = snapAt(idx, 5.91, view, limitFor(p, 'k'))
      expect(on).toMatchObject({ t: 5.917, target: { label: 'Click' } })
      expect(stillEndOf(setStillEnd(p, 'k', on.t), 'k')).toBeCloseTo(5.917, 9)
    })

    it('not to a cut it would hold past into the next clip', () => {
      const clips: Clip[] = [
        { id: 'a', start: 0, end: 8, speed: 1 },
        { id: 'b', start: 10, end: 20, speed: 1 }
      ]
      const p = { ...long(20, clips), freezes: [freeze('k', 2.017, 3, 'continue')] }
      expect(snapAt(dragIndex(p, 'k'), 7.99, view, { min: 2.017, max: 20 })).toMatchObject({ t: 8, target: { label: 'Cut' } })
      expect(stillEndOf(setStillEnd(p, 'k', 8), 'k')).toBeCloseTo(10.017, 9)
      expect(snapAt(dragIndex(p, 'k'), 7.99, view, limitFor(p, 'k'))).toEqual({ t: 7.99, target: null })
      // From a frame a whole number of tenths before it, it ends on the cut.
      const q = { ...p, freezes: [freeze('k', 2, 3, 'continue')] }
      const on = snapAt(dragIndex(q, 'k'), 7.99, view, limitFor(q, 'k'))
      expect(on).toMatchObject({ t: 8, target: { label: 'Cut' } })
      expect(stillEndOf(setStillEnd(q, 'k', on.t), 'k')).toBe(8)
    })

    it('to the next freeze or the end of the video, where the still is cut short exactly', () => {
      const p = { ...long(20), freezes: [freeze('k', 2.06, 3, 'continue'), freeze('n', 6)] }
      const on = snapAt(dragIndex(p, 'k'), 5.99, view, limitFor(p, 'k'))
      expect(on).toMatchObject({ t: 6, target: { label: 'Freeze frame' } })
      // 3.94 s to it: the nearest tenth, 3.9, would end before it; 4.0 is cut short there.
      const q = setStillEnd(p, 'k', on.t)
      expect(q.freezes![0].length).toBe(4)
      expect(stillEndOf(q, 'k')).toBe(6)
      const end = { ...long(20), freezes: [freeze('k', 17.06, 3, 'continue')] }
      const last = snapAt(dragIndex(end, 'k'), 19.99, view, limitFor(end, 'k'))
      expect(last).toMatchObject({ t: 20, target: { label: 'End' } })
      expect(stillEndOf(setStillEnd(end, 'k', last.t), 'k')).toBe(20)
    })

    it('not past the longest freeze', () => {
      const p = { ...long(60), freezes: [freeze('k', 2, 3, 'continue')] }
      const idx = dragIndex(p, 'k', [40])
      expect(snapAt(idx, 39.99, { pxPerSec: 100, current: null }, { min: 2, max: 60 })).toMatchObject({ t: 40 })
      expect(snapAt(idx, 39.99, { pxPerSec: 100, current: null }, limitFor(p, 'k'))).toEqual({ t: 39.99, target: null })
      expect(setStillEnd(p, 'k', 40).freezes![0].length).toBe(30)
    })
  })

  it('remove: no freezes key once the last one is gone', () => {
    const one = removeFreeze(p, 'a')
    expect(one.freezes!.map((f) => f.id)).toEqual(['b'])
    const none = removeFreeze(one, 'b')
    expect('freezes' in none).toBe(false)
    expect(removeFreeze(p, 'nope')).toBe(p)
  })

  it('text on a freeze: half a second of the edit on each side of its frame', () => {
    expect(freezeTextRange([{ id: 'a', start: 0, end: 10, speed: 1 }], freeze('f', 4))).toEqual({ start: 3.5, end: 4.5 })
    expect(freezeTextRange(cutClips, freeze('f', 3.8))).toEqual({ start: 3.3, end: 6.3 })
    expect(freezeTextRange(cutClips, freeze('f', 5))).toBeNull()
  })
})

describe('a freeze at the end of a trimmed edit, saved and reopened', () => {
  // The trim handle leaves the pointer's time, so an edit rarely ends on a whole ms; project.json
  // keeps anchors in whole ms (readFreezes rounds them on load), up or down.
  const trimmed = (end: number): Project => ({ ...base(), clips: setTrimEnd(base().clips, end, 10) })
  const reopened = (p: Project): Project => migrateProject(JSON.parse(JSON.stringify(p)))

  it.each([8.7346, 8.7344])('still holds the last frame with the sound paused (edit end %s)', (end) => {
    const { project, f } = added(trimmed(end), end)
    const again = reopened(project)
    expect(again.freezes).toHaveLength(1)
    for (const p of [project, again]) {
      const plan = freezePlan(p.clips, p.freezes)
      expect(plan.inactive).toEqual([])
      expect(plan.holds).toEqual([expect.objectContaining({ id: f.id, edit: outputDuration(p.clips), end: true })])
      expect(videoDuration(p.clips, plan)).toBeCloseTo(end + 3, 9)
      const g = p.freezes![0]
      expect(atEditEnd(p.clips, g.at)).toBe(true)
      expect(setFreezeSound(p, f.id, 'continue')).toBe(p)
      expect(freezeTextRange(p.clips, g)).toEqual({ start: expect.closeTo(end - 0.5, 9), end })
      expect(freezeRefusal(p, end)).toEqual({ refused: 'taken', id: f.id })
    }
  })

  it('the end of a still running to the edit end can still be frozen', () => {
    const p = { ...trimmed(8.7344), freezes: [freeze('k', 7, 3, 'continue')] }
    expect(freezeRefusal(p, 8.7344)).toBeNull()
    expect(freezeRefusal(reopened(added(p, 8.7344).project), 8.7344)).toMatchObject({ refused: 'taken' })
  })
})
