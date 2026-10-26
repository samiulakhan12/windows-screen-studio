// Freeze frame edits (E-11, docs/design/freeze-frame.md §4.8): the anchor under the playhead, the
// refusals, and each edit returning the same project when it changes nothing.
import { describe, expect, it } from 'vitest'
import {
  freezeAtPlayhead,
  freezeIdAt,
  freezeRefusal,
  freezeTextRange,
  moveFreeze,
  removeFreeze,
  setFreezeLength,
  setFreezeSound
} from '../src/shared/editor/freezeEdit'
import { MAX_FREEZES } from '../src/shared/engine/freeze'
import { readFreezes } from '../src/shared/engine/freezeData'
import { createProject } from '../src/shared/engine/project'
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
