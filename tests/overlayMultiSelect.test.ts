import { describe, expect, it } from 'vitest'
import { copyItems, duplicateItems, pasteItems, pasteNotice } from '../src/shared/editor/groupClipboard'
import { applyField, copyLook, deleteItems, fieldsFor, fieldValue, GROUP_FIELDS, lookClassOf, lookLabel, pasteLook, type FieldCtx } from '../src/shared/editor/groupEdit'
import { groupMovePlan, moveGroup, setGroupLength } from '../src/shared/editor/groupMove'
import { EditStore } from '../src/shared/editor/editStore'
import { groupLabel, projectItems, selectAllStep, validGroup, type ItemKey } from '../src/shared/editor/multiSelect'
import { projectSnapSegments } from '../src/shared/editor/snapping'
import { DEFAULT_ZOOM_STYLE } from '../src/shared/engine/zoom'
import type { ImageOverlay, Project } from '../src/shared/types'
import { p20, text, title } from './groupFixture'

/* Image overlays as a kind of multi-select (docs/design/multi-select.md, docs/design/brand-kit.md). */

const ctx: FieldCtx = { crop: null, cursorValid: true, style: DEFAULT_ZOOM_STYLE, background: { type: 'color', color: '#202020' } }
const field = (id: string) => GROUP_FIELDS.find((f) => f.id === id)!
const img = (id: string, start: number, end: number, extra: Partial<ImageOverlay> = {}): ImageOverlay => ({
  id,
  start,
  end,
  file: 'overlay-1.png',
  x: 0.5,
  y: 0.5,
  w: 0.4,
  h: 0.2,
  rotation: 0,
  opacity: 1,
  fadeIn: 0.2,
  fadeOut: 0.2,
  ...extra
})
const withImages = (overlays: ImageOverlay[], extra: Partial<Project> = {}): Project => ({ ...p20({ annotations: [text('t1', 1, 3)] }), overlays, ...extra })
const K = (s: string): ItemKey => s as ItemKey

describe('overlays in a group', () => {
  it('are listed on their own Images track and counted by name', () => {
    const p = withImages([img('o1', 2, 4), img('o2', 5, 7, { sticker: 'star', file: undefined })])
    const items = projectItems(p).filter((x) => x.kind === 'overlay')
    expect(items.map((x) => [x.key, x.track])).toEqual([
      ['overlay:o1', 'images'],
      ['overlay:o2', 'images']
    ])
    expect(groupLabel([K('overlay:o1'), K('overlay:o2'), K('annotation:t1')])).toBe('1 text item · 2 images')
    expect(selectAllStep(projectItems(p), [], 'images').keys).toEqual(['overlay:o1', 'overlay:o2'])
    // M1: an image's key is its snapping owner, so the timeline's edges catch on image blocks.
    expect(projectSnapSegments(p, { layouts: false }).filter((s) => s.owner.startsWith('overlay:'))).toEqual([
      { owner: 'overlay:o1', label: 'Image', start: 2, end: 4 },
      { owner: 'overlay:o2', label: 'Image', start: 5, end: 7 }
    ])
    // A deleted overlay leaves the group.
    expect(validGroup({ keys: [K('overlay:o1'), K('overlay:gone')], anchor: K('overlay:gone'), stamp: 1 }, p).keys).toEqual(['overlay:o1'])
  })

  it('get an Images section with position, size, rotation, opacity and fades; Mixed where they differ', () => {
    const p = withImages([img('o1', 2, 4, { opacity: 0.5 }), img('o2', 5, 7, { opacity: 0.8 })])
    const keys = [K('overlay:o1'), K('overlay:o2'), K('annotation:t1')]
    const sections = fieldsFor(p, keys)
    const images = sections.find((s) => s.cls === 'image')!
    expect(images.fields.map((f) => f.field.id)).toEqual(['image.x', 'image.y', 'image.size', 'image.rotation', 'image.opacity', 'image.fadeIn', 'image.fadeOut'])
    expect(fieldValue(p, field('image.opacity'), images.keys, ctx)).toEqual({ mixed: true, value: 0.5 })
    expect(lookClassOf(p, K('overlay:o1'))).toBe('image')
  })

  it('opacity is set on every selected image at once, as one undo step; text is left alone', () => {
    const p = withImages([img('o1', 2, 4, { opacity: 0.5 }), img('o2', 5, 7, { opacity: 0.8 })])
    const store = new EditStore(p)
    store.update((q) => applyField(q, field('image.opacity'), [K('overlay:o1'), K('overlay:o2'), K('annotation:t1')], 0.3, ctx).project)
    expect(store.state.overlays!.map((o) => o.opacity)).toEqual([0.3, 0.3])
    expect(store.state.annotations).toBe(p.annotations)
    expect(store.undo()).toBe(true)
    expect(store.state).toBe(p)
  })

  it('size keeps each image its own shape', () => {
    const p = withImages([img('o1', 2, 4, { w: 0.4, h: 0.2 }), img('o2', 5, 7, { w: 0.1, h: 0.3 })])
    const q = applyField(p, field('image.size'), [K('overlay:o1'), K('overlay:o2')], 0.6, ctx).project
    expect(q.overlays![0]).toMatchObject({ w: 0.6, h: 0.3 })
    expect(q.overlays![1].h).toBeCloseTo(0.6)
    expect(q.overlays![1].w).toBeCloseTo(0.2)
  })

  it('copy look / paste look carries opacity, rotation, size and fades, not the position', () => {
    const p = withImages([img('o1', 2, 4, { opacity: 0.4, rotation: 30, fadeIn: 1, x: 0.1 }), img('o2', 5, 7)])
    const look = copyLook(p, K('overlay:o1'), ctx)!
    expect(look.cls).toBe('image')
    expect(lookLabel(look)).toBe('Image: 40 %, 30°')
    const q = pasteLook(p, [K('overlay:o2')], look, ctx).project
    expect(q.overlays![1]).toMatchObject({ opacity: 0.4, rotation: 30, fadeIn: 1, x: 0.5 })
  })

  it('move together, take one length, and are deleted together', () => {
    const p = withImages([img('o1', 2, 4), img('o2', 5, 7)])
    const keys = [K('overlay:o1'), K('overlay:o2'), K('annotation:t1')]
    const moved = moveGroup(p, groupMovePlan(p, keys), 1.5)
    expect(moved.overlays!.map((o) => [o.start, o.end])).toEqual([
      [3.5, 5.5],
      [6.5, 8.5]
    ])
    expect(moved.annotations[0].start).toBe(2.5)
    const long = setGroupLength(p, keys, 4).project
    expect(long.overlays!.map((o) => o.end - o.start)).toEqual([4, 4])
    const gone = deleteItems(p, keys)
    expect(gone.overlays).toEqual([])
    expect(gone.annotations).toEqual([])
  })

  it('copy and paste: an image file pastes only into its own recording, a sticker anywhere', () => {
    const p = withImages([img('o1', 2, 4), img('o2', 3, 5, { sticker: 'star', file: undefined })])
    const clip = copyItems(p, [K('overlay:o1'), K('overlay:o2')])!
    const same = pasteItems(p, clip, 10)
    expect(same.keys).toHaveLength(2)
    expect(same.project.overlays!.slice(2).map((o) => o.start)).toEqual([10, 11])
    expect(new Set(same.project.overlays!.map((o) => o.id)).size).toBe(4)
    const other = pasteItems({ ...p, id: 'other' }, clip, 10)
    expect(other.keys).toHaveLength(1)
    expect(other.project.overlays!.at(-1)!.sticker).toBe('star')
    expect(other.skipped).toEqual([{ kind: 'overlay', why: 'image-other-recording' }])
    expect(pasteNotice(other, 2)).toBe('Pasted 1 of 2: 1 image is from another recording')
    expect(duplicateItems(p, [K('overlay:o1')]).project.overlays).toHaveLength(3)
  })

  it("a pasted copy of the brand kit's intro is the user's (applying the kit again keeps it)", () => {
    const p = { ...p20({ titles: [title('c1', 0, 2, { brand: 'intro' })] }) }
    const r = pasteItems(p, copyItems(p, [K('title:c1')])!, 5)
    expect(r.project.titles![0].brand).toBe('intro')
    expect('brand' in r.project.titles![1]).toBe(false)
  })
})
