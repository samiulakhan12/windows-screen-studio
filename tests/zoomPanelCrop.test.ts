import { beforeEach, describe, expect, it, vi } from 'vitest'
import { setZoomRegionInView } from '../src/shared/editor/cropEdit'
import { setZoomRegion } from '../src/shared/editor/zoomEdit'
import { DEFAULT_KEYMAP } from '../src/shared/editor/shortcuts'
import { zoomInView } from '../src/shared/engine/crop'
import { createProject } from '../src/shared/engine/project'
import { zoomTargetScale } from '../src/shared/engine/zoom'
import type { NormRect, Project, ZoomSegment } from '../src/shared/types'

/*
 * The Zoom tab's selected zoom on a cropped recording (docs/design/crop-in-editor.md, decision 6
 * and §4.2) without a DOM: the panel is called as a function and its elements read, as
 * tests/captionsPanel.test.ts does. Its only hooks are the editor's and the keymap's contexts,
 * which are swapped for a store and the default keys.
 */

interface El {
  type: unknown
  props: Record<string, unknown>
}

let store: { state: Project; update: (fn: (p: Project) => Project, key?: string) => void }
const CONTEXT = '../src/renderer/src/editor/context'
const KEYMAP = '../src/renderer/src/editor/keymapContext'
vi.doMock(CONTEXT, async (importOriginal) => ({ ...(await importOriginal<Record<string, unknown>>()), useEditor: () => ({ store, player: { time: 0, seek: () => undefined } }) }))
vi.doMock(KEYMAP, async (importOriginal) => ({ ...(await importOriginal<Record<string, unknown>>()), useKeymap: () => DEFAULT_KEYMAP }))

// Renderer code: imported at run time so the Node typecheck of tests/ does not follow it.
const PANEL = '../src/renderer/src/editor/panels/ZoomPanel'
const { ZoomPanel } = (await import(/* @vite-ignore */ PANEL)) as { ZoomPanel: (props: unknown) => unknown }

const RENDERED = new Set(['ZoomPanel', 'SelectedZoom'])

/** The tab with the project's first zoom selected: every element under the rendered components. */
function render(cursorValid = true): El[] {
  const out: El[] = []
  const walk = (node: unknown): void => {
    if (Array.isArray(node)) return node.forEach(walk)
    if (!node || typeof node !== 'object' || !('props' in node)) return
    const el = node as El
    if (typeof el.type === 'function' && RENDERED.has(el.type.name)) return walk((el.type as (p: unknown) => unknown)(el.props))
    out.push(el)
    walk(el.props.children)
  }
  const p = store.state
  walk({
    type: ZoomPanel,
    props: {
      project: p,
      selection: { kind: 'zoom', id: p.zooms[0].id },
      clickRows: [],
      cursor: { samples: [], clicks: [], keys: [], valid: cursorValid },
      recorded: { samples: [], clicks: [], keys: [], valid: cursorValid },
      input: {},
      focusFor: () => ({ x: 0.5, y: 0.5 }),
      pickFocus: false,
      onPickFocus: () => undefined,
      onNotice: () => undefined,
      onSelect: () => undefined
    }
  })
  return out
}

const byLabel = (out: El[], ...labels: string[]): El => out.find((e) => labels.includes(e.props.label as string))!
/** The level the panel shows (its slider). */
const shownLevel = (): number => byLabel(render(), 'Zoom level', 'Zoom level · pull back').props.value as number
const chooseFocus = (mode: 'cursor' | 'fixed'): void => (byLabel(render(), 'Zoom focus').props.onChange as (m: string) => void)(mode)

const LEFT_HALF: NormRect = { x: 0, y: 0, w: 0.5, h: 1 }
const zoom = (): ZoomSegment => ({ id: 'z1', start: 1, end: 4, scale: 2, focus: { mode: 'cursor' }, auto: false })

function project(z: ZoomSegment, crop?: NormRect): Project {
  const capture = { method: 'native', cursorInVideo: false, region: null, target: 'screen' } as const
  const p = createProject({ id: 'p', name: 'p', duration: 10, width: 1920, height: 1080, hasWebcam: false, hasAudio: false, webcamOffset: 0, zooms: [z], cursorValid: true, capture })
  return crop ? { ...p, crop } : p
}

beforeEach(() => {
  store = {
    state: project(zoom()),
    update(fn) {
      store.state = fn(store.state)
    }
  }
})

describe('ZoomPanel: switching a region zoom to a point keeps the level it shows', () => {
  // Framed before the crop: a fifth of the frame's width, 5× (the level it stores).
  const framed = setZoomRegion(zoom(), { x: 0.1, y: 0.3, w: 0.2, h: 0.2 })

  for (const mode of ['fixed', 'cursor'] as const) {
    it(`cropped to the left half: 2.5× stays 2.5× (${mode === 'fixed' ? 'Fixed point' : 'Follow cursor'})`, () => {
      store.state = project(framed, LEFT_HALF)
      expect(framed.scale).toBe(5)
      expect(shownLevel()).toBeCloseTo(2.5, 9)
      chooseFocus(mode)
      const z = store.state.zooms[0]
      expect(z.focus.mode).toBe(mode)
      expect(zoomTargetScale(zoomInView(LEFT_HALF, z))).toBeCloseTo(2.5, 9)
      expect(shownLevel()).toBeCloseTo(2.5, 9)
    })
  }

  it('framed while cropped, then the crop reset: the level of the whole frame', () => {
    // 1.25× of the left half's view (a box 80% of its width) is 2.5× of the whole frame.
    const inView = setZoomRegionInView(LEFT_HALF, zoom(), { x: 0.1, y: 0.4, w: 0.8, h: 0.2 })
    expect(inView.scale).toBeCloseTo(1.25, 9)
    store.state = project(inView)
    expect(shownLevel()).toBeCloseTo(2.5, 9)
    chooseFocus('fixed')
    expect(zoomTargetScale(store.state.zooms[0])).toBeCloseTo(2.5, 9)
  })

  it('without a crop, as before: the region level', () => {
    store.state = project(framed)
    chooseFocus('fixed')
    const z = store.state.zooms[0]
    expect(z.focus).toEqual({ mode: 'fixed', x: 0.2, y: 0.4 })
    expect(z.scale).toBe(5)
  })
})
