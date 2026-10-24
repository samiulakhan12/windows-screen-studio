import { describe, expect, it } from 'vitest'
import { createShape, createSpotlight } from '../src/shared/editor/shapes'
import { migrateProject } from '../src/shared/engine/project'
import { projectShapes, projectSpotlights } from '../src/shared/render/shapes'

const stored = (extra: Record<string, unknown>): Record<string, unknown> => ({ version: 2, id: 'x', name: 'x', duration: 10, ...extra })

describe('migrateProject (shapes and spotlights)', () => {
  it('keeps valid shapes and spotlights exactly', () => {
    const shapes = [createShape('arrow', 1, 10), createShape('blur', 2, 10, { strength: 0.8 })]
    const spotlights = [createSpotlight('cursor', 3, 10), createSpotlight('region', 4, 10, { shape: 'rect' })]
    const p = migrateProject(stored({ shapes, spotlights }))
    expect(p.shapes).toEqual(shapes)
    expect(p.spotlights).toEqual(spotlights)
    // Older projects have none.
    expect(migrateProject(stored({})).shapes).toEqual([])
    expect(migrateProject(stored({ spotlights: 'x' })).spotlights).toEqual([])
  })

  it('drops entries the editor cannot select or draw (hand-edited or damaged files)', () => {
    const ok = createShape('rect', 1, 10)
    const p = migrateProject(
      stored({
        shapes: [
          null,
          42,
          'arrow',
          [ok],
          { ...ok, id: undefined },
          { ...ok, id: '' },
          { ...ok, id: 7 },
          { ...ok, id: 'star', kind: 'star' },
          { ...ok, id: 'nan', start: NaN },
          { ...ok, id: 'inf', end: Infinity },
          { ...ok, id: 'back', start: 5, end: 4 },
          { ...ok, id: 'nox', x: null },
          { ...ok, id: 'strw', w: '0.3' },
          ok,
          { ...ok, x: 0.9 }
        ],
        spotlights: [null, 'spot', { id: 'm', mode: 'torch', start: 0, end: 1 }, { id: 't', mode: 'region', start: 'a', end: 2 }, { id: 'l', mode: 'region', start: 1, end: 2 }]
      })
    )
    // Only the valid rectangle (its repeated id is dropped too) and the one usable spotlight.
    expect(p.shapes).toEqual([ok])
    expect(p.spotlights?.map((s) => s.id)).toEqual(['l'])
    // The timeline lists exactly what the canvas draws.
    expect(projectShapes(p)).toEqual(p.shapes)
    expect(projectSpotlights(p)).toEqual(p.spotlights)
  })

  it('fills in missing settings and clamps out-of-range ones', () => {
    const p = migrateProject(
      stored({
        shapes: [{ id: 'a', kind: 'blur', start: 0, end: 2, x: 0.1, y: 0.1, w: 0.3, h: 0.3, strength: 7, opacity: -1, color: 'red', strokeWidth: 1000 }],
        spotlights: [{ id: 'b', mode: 'cursor', start: 1, end: 3, w: 99, dim: 2 }]
      })
    )
    expect(p.shapes?.[0]).toEqual({ id: 'a', kind: 'blur', start: 0, end: 2, x: 0.1, y: 0.1, w: 0.3, h: 0.3, color: '#ff3b30', strokeWidth: 64, fill: false, opacity: 0, strength: 1 })
    expect(p.spotlights?.[0]).toEqual({ id: 'b', mode: 'cursor', start: 1, end: 3, x: 0.3, y: 0.3, w: 2, h: 0.4, shape: 'ellipse', dim: 1, feather: 0.4 })
  })

  it('drops non-object zooms and text too, which the timeline would crash on', () => {
    const zoom = { id: 'z', start: 1, end: 3, scale: 2, focus: { mode: 'cursor' }, auto: false }
    const text = { id: 't', start: 1, end: 2, text: 'Hi', x: 0.5, y: 0.5, size: 0.05, style: 'pill' }
    const p = migrateProject(stored({ zooms: [null, zoom, 3], annotations: ['x', null, text] }))
    expect(p.zooms).toEqual([zoom])
    expect(p.annotations).toEqual([text])
  })
})
