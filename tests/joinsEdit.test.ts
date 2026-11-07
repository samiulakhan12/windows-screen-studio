/**
 * Editing cut styles (docs/design/editing-polish.md §2.1, §11, §16; §19.1 tests 16 and 17): Smooth
 * all cuts, Use hard cuts everywhere, a cut's own style, settling styles whose cut went, the cut
 * numbers and walking from cut to cut; and why styles are kept on the project, not on clips.
 */
import { describe, expect, it } from 'vitest'
import { restoreRange } from '../src/shared/editor/clips'
import { EditStore } from '../src/shared/editor/editStore'
import {
  cutCount,
  cutNumber,
  cutSpan,
  giveSameStyle,
  hardCutsEverywhere,
  joinLabel,
  nextCutAfter,
  prevCutBefore,
  settleJoins,
  smoothAllCuts,
  withCutJoin,
  withJoinAll
} from '../src/shared/editor/joinsEdit'
import { createProject } from '../src/shared/engine/project'
import { cutRange, splitAt } from '../src/shared/engine/timeline'
import { resolvedJoin } from '../src/shared/render/joins'
import type { Clip, Project, ProjectJoins } from '../src/shared/types'

function base(over: Partial<Project> = {}): Project {
  const p = createProject({
    id: 'p',
    name: 'p',
    duration: 400,
    width: 1280,
    height: 720,
    hasWebcam: false,
    hasAudio: true,
    webcamOffset: 0,
    zooms: [],
    cursorValid: true,
    capture: { method: 'chromium', cursorInVideo: true, region: null }
  })
  return { ...p, ...over }
}

/** `n` clips of 4 s with a 1 s cut between each: B of cut k is 'c<k>'. */
function cutClips(n: number): Clip[] {
  return Array.from({ length: n }, (_, i) => ({ id: `c${i}`, start: i * 5, end: i * 5 + 4, speed: 1 }))
}

const project = (n: number, joins?: ProjectJoins): Project => base({ clips: cutClips(n), duration: n * 5, ...(joins ? { joins } : {}) })

describe('joinsEdit (test 16)', () => {
  it('Smooth all cuts: one project out, every cut Smooth, own styles kept, 34 changed and 3 kept of 37', () => {
    const own: ProjectJoins = { cuts: [{ clip: 'c3', kind: 'dip' }, { clip: 'c9', kind: 'slide', from: 'left' }, { clip: 'c20', kind: 'cut' }] }
    const p = project(38, own)
    expect(cutCount(p)).toBe(37)
    const r = smoothAllCuts(p)
    expect(r.changed).toBe(34)
    expect(r.kept).toBe(3)
    expect(r.project).not.toBe(p)
    expect(r.project.joins).toEqual({ all: { kind: 'smooth' }, cuts: own.cuts })
    // Again: every cut already is Smooth, nothing changes.
    const again = smoothAllCuts(r.project)
    expect(again.project).toBe(r.project)
    expect(again.changed).toBe(0)
    // One store update: one undo step.
    const store = new EditStore(p)
    store.update((s) => smoothAllCuts(s).project)
    expect(store.state.joins?.all).toEqual({ kind: 'smooth' })
    store.undo()
    expect(store.state).toBe(p)
    expect(store.canUndo).toBe(false)
  })

  it('Use hard cuts everywhere stores { kind: \'cut\' } and clears own styles and Polish\'s record', () => {
    const p = project(4, { all: { kind: 'smooth' }, cuts: [{ clip: 'c1', kind: 'dip' }], auto: { by: 'polish', was: null } })
    const hard = hardCutsEverywhere(p)
    expect(hard.joins).toEqual({ all: { kind: 'cut' } })
    expect(hardCutsEverywhere(hard)).toBe(hard)
    expect([1, 2, 3].map((i) => resolvedJoin(hard, i))).toEqual([null, null, null])
  })

  it('Give them the same style clears the own styles; withCutJoin(…, null) removes one', () => {
    const p = project(4, { all: { kind: 'crossfade' }, cuts: [{ clip: 'c1', kind: 'dip' }, { clip: 'c2', kind: 'punch' }] })
    const same = giveSameStyle(p)
    expect(same.joins).toEqual({ all: { kind: 'crossfade' } })
    expect(giveSameStyle(same)).toBe(same)
    const one = withCutJoin(p, 'c1', null)
    expect(one.joins?.cuts).toEqual([{ clip: 'c2', kind: 'punch' }])
    expect(withCutJoin(p, 'c3', null)).toBe(p)
    // Setting one replaces it in place; an empty joins goes.
    expect(withCutJoin(p, 'c2', { kind: 'slide', from: 'top' }).joins?.cuts).toEqual([
      { clip: 'c1', kind: 'dip' },
      { clip: 'c2', kind: 'slide', from: 'top' }
    ])
    const bare = project(3, { cuts: [{ clip: 'c1', kind: 'dip' }] })
    expect(withCutJoin(bare, 'c1', null).joins).toBeUndefined()
    expect('joins' in withCutJoin(bare, 'c1', null)).toBe(false)
    expect(withJoinAll(project(3, { all: { kind: 'dip' } }), null).joins).toBeUndefined()
  })

  it('settleJoins drops a style whose clip was merged or no longer follows a cut, keeps the rest, and returns next itself otherwise', () => {
    const p = project(5, { cuts: [{ clip: 'c1', kind: 'dip' }, { clip: 'c2', kind: 'punch' }, { clip: 'c3', kind: 'slide' }] })
    // Restoring the cut before c1 merges c1 into c0 (same speed): c1's style goes.
    const merged = { ...p, clips: restoreRange(p.clips, 4, 5, p.duration) }
    expect(merged.clips.some((c) => c.id === 'c1')).toBe(false)
    const settled = settleJoins(merged, p)
    expect(settled.joins?.cuts).toEqual([{ clip: 'c2', kind: 'punch' }, { clip: 'c3', kind: 'slide' }])
    // A clip that now touches the one before (a speed split) no longer follows a cut.
    const split = { ...p, clips: p.clips.map((c) => (c.id === 'c2' ? { ...c, speed: 2 } : c.id === 'c1' ? { ...c, end: 10 } : c)) }
    expect(settleJoins(split, p).joins?.cuts).toEqual([{ clip: 'c1', kind: 'dip' }, { clip: 'c3', kind: 'slide' }])
    // Nothing applies: next itself.
    const moved = { ...p, zooms: [] }
    expect(settleJoins(moved, p)).toBe(moved)
    const old = base({ clips: cutClips(3) })
    const edited = { ...old, clips: old.clips.slice(1) }
    expect(settleJoins(edited, old)).toBe(edited)
    const same = { ...p, clips: [...p.clips] }
    expect(settleJoins(same, p)).toBe(same)
  })

  it('settleJoins drops Polish\'s record when every cut\'s style changed by hand, and not when Polish set it', () => {
    const before = project(3)
    const polished = { ...before, joins: { all: { kind: 'smooth' as const }, auto: { by: 'polish' as const, was: null } } }
    expect(settleJoins(polished, before)).toBe(polished)
    const byHand = { ...polished, joins: { ...polished.joins, all: { kind: 'dip' as const } } }
    expect(settleJoins(byHand, polished).joins).toEqual({ all: { kind: 'dip' } })
    // A change elsewhere keeps the record.
    const own = { ...polished, joins: { ...polished.joins, cuts: [{ clip: 'c1', kind: 'punch' as const }] } }
    expect(settleJoins(own, polished)).toBe(own)
  })

  it('numbers the cuts and walks every one of them both ways', () => {
    const p = project(38)
    // Cut 5 is before clip c5, which starts at 25.
    expect(cutNumber(p, 25)).toEqual({ n: 5, of: 37 })
    expect(cutNumber(p, 26)).toBeNull()
    const forward: number[] = []
    for (let g = nextCutAfter(p, -1); g; g = nextCutAfter(p, g.end)) forward.push(g.end)
    expect(forward).toEqual(p.clips.slice(1).map((c) => c.start))
    const back: number[] = []
    for (let g = prevCutBefore(p, 1000); g; g = prevCutBefore(p, g.end)) back.push(g.end)
    expect(back).toEqual([...forward].reverse())
    expect(nextCutAfter(p, 9)).toEqual({ start: 9, end: 10 })
    expect(prevCutBefore(p, 10)).toEqual({ start: 4, end: 5 })
    expect(cutSpan({ start: 83.4, end: 85 })).toBe('1:23.4 to 1:25.0')
    expect(joinLabel({ kind: 'crossfade' })).toBe('Crossfade, 0.15 s')
    expect(joinLabel({ kind: 'punch', scale: 1.15 })).toBe('Punch-in, 115 %')
    expect(joinLabel(null)).toBe('Hard cut')
  })
})

describe('why styles are not on Clip (test 17)', () => {
  it('a split inside B keeps B\'s style on the cut before B only', () => {
    const p = project(3, { all: { kind: 'crossfade' }, cuts: [{ clip: 'c1', kind: 'dip', duration: 0.4 }] })
    const clips = splitAt(p.clips, 7)
    const split = { ...p, clips }
    expect(clips).toHaveLength(4)
    // B (c1) is still after the cut, the new piece touches it: no cut, no style.
    expect(resolvedJoin(split, 1)).toEqual({ kind: 'dip', duration: 0.4, color: '#000000' })
    expect(resolvedJoin(split, 2)).toBeNull()
    expect(settleJoins(split, p)).toBe(split)
  })

  it('a range cut inside B makes a new cut with every cut\'s style', () => {
    const p = project(3, { all: { kind: 'crossfade' }, cuts: [{ clip: 'c1', kind: 'dip', duration: 0.4 }] })
    const clips = cutRange(p.clips, 6.5, 7)
    const cut = { ...p, clips }
    expect(clips).toHaveLength(4)
    expect(clips[1].id).toBe('c1')
    expect(resolvedJoin(cut, 1)).toEqual({ kind: 'dip', duration: 0.4, color: '#000000' })
    expect(resolvedJoin(cut, 2)).toEqual({ kind: 'crossfade', duration: 0.15 })
    expect(settleJoins(cut, p).joins?.cuts).toEqual([{ clip: 'c1', kind: 'dip', duration: 0.4 }])
  })
})
