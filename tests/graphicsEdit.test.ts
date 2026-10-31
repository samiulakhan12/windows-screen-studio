import { describe, expect, it } from 'vitest'
import { createProject, migrateProject } from '../src/shared/engine/project'
import { addGraphic, deleteGraphics, moveGraphics, placeGraphicAt, trimGraphic, updateGraphic } from '../src/shared/editor/graphicsEdit'
import { GRAPHIC_DEFAULTS } from '../src/shared/render/graphics'
import type { ListGraphic, Project } from '../src/shared/types'

/* Test 22 (docs/design/captions-studio.md §16.1): add, move, trim, delete and place are one update each (§10.5). */

const base = (): Project => createProject({ id: 'p', name: 'p', duration: 20, width: 1920, height: 1080, hasWebcam: false, hasAudio: true, webcamOffset: 0, zooms: [], cursorValid: true, capture: { method: 'native', cursorInVideo: false, region: null } as Project['capture'] })
const reread = (p: Project): Project['graphics'] => migrateProject(JSON.parse(JSON.stringify(p))).graphics

describe('graphics edits (test 22)', () => {
  it('adds a graphic of each kind at the playhead with its defaults, placed automatically', () => {
    let p = base()
    const ids: string[] = []
    for (const [kind, at] of [
      ['keyword', 2],
      ['emoji', 5],
      ['counter', 8],
      ['list', 11]
    ] as const) {
      const r = addGraphic(p, kind, at)
      expect(r.project).not.toBe(p)
      p = r.project
      ids.push(r.id)
      const g = p.graphics!.find((x) => x.id === r.id)!
      expect(g).toMatchObject({ kind, start: at, end: at + GRAPHIC_DEFAULTS[kind].length, place: 'auto', size: GRAPHIC_DEFAULTS[kind].size })
    }
    expect(new Set(ids).size).toBe(4)
    expect(p.graphics).toEqual(reread(p))
    // At the end of the recording it fits before the end.
    const late = addGraphic(base(), 'keyword', 19.5)
    expect(late.project.graphics![0]).toMatchObject({ start: 20 - 1.6, end: 20 })
    // Its own values over the defaults.
    const own = addGraphic(base(), 'keyword', 1, { text: 'Export', look: 'tag' } as never)
    expect(own.project.graphics![0]).toMatchObject({ text: 'Export', look: 'tag' })
  })

  it('updates a field, keeping the id and the kind', () => {
    const { project, id } = addGraphic(base(), 'counter', 1)
    const next = updateGraphic(project, id, { to: 300, suffix: '%', id: 'other', kind: 'list' } as never)
    expect(next.graphics![0]).toMatchObject({ id, kind: 'counter', to: 300 })
    expect(updateGraphic(project, 'nope', { size: 0.2 })).toBe(project)
    expect(updateGraphic(next, id, { to: 300 })).toBe(next)
  })

  it('moves graphics together, list items with them, inside the recording', () => {
    let p = addGraphic(base(), 'list', 2).project
    const list = p.graphics![0] as ListGraphic
    p = addGraphic(p, 'emoji', 10).project
    const both = p.graphics!.map((g) => g.id)
    const moved = moveGraphics(p, both, 1.5)
    expect(moved.graphics!.map((g) => g.start)).toEqual([3.5, 11.5])
    expect((moved.graphics![0] as ListGraphic).items[0].at).toBe(list.items[0].at + 1.5)
    // As far as the group can go.
    expect(moveGraphics(p, both, -10).graphics!.map((g) => g.start)).toEqual([0, 8])
    expect(moveGraphics(p, both, 0)).toBe(p)
    expect(moveGraphics(p, ['nope'], 1)).toBe(p)
  })

  it('trims a start or an end, at least 0.2 s long', () => {
    const { project, id } = addGraphic(base(), 'keyword', 2)
    expect(trimGraphic(project, id, 'start', 2.5).graphics![0]).toMatchObject({ start: 2.5, end: 3.6 })
    expect(trimGraphic(project, id, 'end', 5).graphics![0]).toMatchObject({ start: 2, end: 5 })
    expect(trimGraphic(project, id, 'start', 9).graphics![0].start).toBeCloseTo(3.4, 9)
    expect(trimGraphic(project, id, 'end', 99).graphics![0].end).toBe(20)
    expect(trimGraphic(project, id, 'start', 2)).toBe(project)
  })

  it('deletes one or many, and the key goes with the last', () => {
    let p = addGraphic(base(), 'keyword', 2).project
    p = addGraphic(p, 'emoji', 4).project
    const [a, b] = p.graphics!.map((g) => g.id)
    expect(deleteGraphics(p, [a]).graphics!.map((g) => g.id)).toEqual([b])
    expect(deleteGraphics(p, [a, b]).graphics).toBeUndefined()
    expect('graphics' in deleteGraphics(p, [a, b])).toBe(false)
    expect(deleteGraphics(p, ['nope'])).toBe(p)
  })

  it('places a graphic by hand, kept in the frame, and back to automatic', () => {
    const { project, id } = addGraphic(base(), 'emoji', 2)
    const placed = placeGraphicAt(project, id, { x: 1.4, y: 0.3 })
    expect(placed.graphics![0].place).toEqual({ x: 1, y: 0.3 })
    expect(placeGraphicAt(placed, id, 'auto').graphics![0].place).toBe('auto')
    expect(placeGraphicAt(project, id, 'auto')).toBe(project)
    expect(placed.graphics).toEqual(reread(placed))
  })
})
