import { beforeEach, describe, expect, it, vi } from 'vitest'
import { DEFAULT_KEYMAP } from '../src/shared/editor/shortcuts'
import { cropProject } from '../src/shared/engine/crop'
import { createProject } from '../src/shared/engine/project'
import type { NormRect, Project, Spotlight } from '../src/shared/types'

/*
 * The selected cursor spotlight's Size slider on a cropped recording (docs/design/crop-in-editor.md
 * §4.6) without a DOM: the panel is called as a function and its elements read, as
 * tests/zoomPanelCrop.test.ts does. The slider shows and sets the size the preview draws, a share
 * of the crop's height, and stores it in the full frame.
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
const PANEL = '../src/renderer/src/editor/panels/ShapesPanel'
const { ShapesPanel } = (await import(/* @vite-ignore */ PANEL)) as { ShapesPanel: (props: unknown) => unknown }

const RENDERED = new Set(['ShapesPanel', 'SelectedSpotlight'])

/** The tab with the project's first spotlight selected: every element under the rendered components. */
function render(): El[] {
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
    type: ShapesPanel,
    props: {
      project: p,
      selection: { kind: 'spotlight', id: p.spotlights![0].id },
      cursor: { samples: [], clicks: [], keys: [], valid: true },
      onSelect: () => undefined
    }
  })
  return out
}

const sizeSlider = (): El => render().find((e) => e.props.label === 'Size')!
const shownSize = (): number => sizeSlider().props.value as number
const dragSize = (h: number): void => (sizeSlider().props.onChange as (v: number) => void)(h)
/** The spotlight as the preview draws it. */
const drawn = (): Spotlight => cropProject(store.state).spotlights![0]

/** Added before the crop: a quarter of the frame's height, round on a 1920×1080 screen. */
const SPOT: Spotlight = { id: 's1', mode: 'cursor', start: 1, end: 4, x: 0.3, y: 0.3, w: 0.135, h: 0.24, shape: 'ellipse', dim: 0.6, feather: 0.4 }
const TOP_HALF: NormRect = { x: 0, y: 0, w: 1, h: 0.5 }

function project(crop?: NormRect): Project {
  const capture = { method: 'native', cursorInVideo: false, region: null, target: 'screen' } as const
  const p = createProject({ id: 'p', name: 'p', duration: 10, width: 1920, height: 1080, hasWebcam: false, hasAudio: false, webcamOffset: 0, zooms: [], cursorValid: true, capture })
  return { ...p, spotlights: [{ ...SPOT }], ...(crop ? { crop } : {}) }
}

beforeEach(() => {
  store = {
    state: project(),
    update(fn) {
      store.state = fn(store.state)
    }
  }
})

describe('ShapesPanel: the cursor spotlight Size on a cropped recording', () => {
  it('cropped to the top half: shows the share of the picture it lights', () => {
    store.state = project(TOP_HALF)
    expect(shownSize()).toBeCloseTo(0.48, 9)
    expect(drawn().h).toBeCloseTo(0.48, 9)
  })

  it('cropped to the top half: Size 50% draws it half as tall as the picture, keeping its shape', () => {
    store.state = project(TOP_HALF)
    dragSize(0.5)
    const s = store.state.spotlights![0]
    expect(s.h).toBeCloseTo(0.25, 9)
    expect(s.w / s.h).toBeCloseTo(SPOT.w / SPOT.h, 9)
    expect(drawn().h).toBeCloseTo(0.5, 9)
    expect(shownSize()).toBeCloseTo(0.5, 9)
  })

  it('on a short crop the whole range draws different sizes, up to the picture height', () => {
    store.state = project({ x: 0, y: 0, w: 1, h: 0.3 })
    dragSize(0.06)
    expect(drawn().h).toBeCloseTo(0.06, 9)
    dragSize(1)
    expect(drawn().h).toBeCloseTo(1, 9)
    expect(store.state.spotlights![0].h).toBeCloseTo(0.3, 9)
  })

  it('without a crop, as before: the stored size', () => {
    expect(shownSize()).toBe(0.24)
    dragSize(0.5)
    expect(store.state.spotlights![0]).toMatchObject({ h: 0.5, w: expect.closeTo((0.135 / 0.24) * 0.5, 9) })
  })
})
