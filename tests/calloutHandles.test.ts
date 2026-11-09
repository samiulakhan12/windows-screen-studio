import { isValidElement, type ReactElement, type ReactNode } from 'react'
import { describe, expect, it, vi } from 'vitest'
import type { Annotation, CursorTrack, Project, ZoomSegment } from '../src/shared/types'

/*
 * The preview's handles of step badges and speech bubbles (docs/design/editing-polish.md §2.3,
 * §7.3, §7.4, §12): a pinned badge or tail tip moved with the pointer or the arrow keys stays on
 * the picture (so it is still drawn and its handle keeps the focus), and dragging a bubble's body
 * while its tip is off the picture moves the body, never the tip. CalloutHandles is called as a
 * function, with React's hooks and the editor's contexts answered here (as
 * tests/transportNotice.test.ts does), and its handles' moves are run on a project that the
 * store's updates change.
 */

vi.stubGlobal('document', { createElement: () => ({ getContext: () => null }) })
vi.doMock('react', async (importOriginal) => ({
  ...(await importOriginal<Record<string, unknown>>()),
  useState: (init: unknown) => [typeof init === 'function' ? (init as () => unknown)() : init, () => undefined],
  useEffect: () => undefined
}))

let project: Project
const store = { update: (fn: (p: Project) => Project) => void (project = fn(project)) }
const player = { moving: false, time: 0, subscribe: () => () => undefined, pausedFrame: (): { scene: unknown } | null => ({ scene: sceneOf(project) }) }
vi.doMock('../src/renderer/src/editor/context', () => ({ useEditor: () => ({ store, player }), holdGesture: () => undefined }))
vi.doMock('../src/renderer/src/editor/groupContext', () => ({ useGroup: () => ({ notice: () => undefined }) }))

const { createProject } = await import('../src/shared/engine/project')
const { cropView } = await import('../src/shared/engine/crop')
const { SmoothedTrack } = await import('../src/shared/engine/cursor')
const { focusPathFor } = await import('../src/shared/engine/zoom')
const { calloutOf } = await import('../src/shared/render/calloutData')
const { calloutPlace } = await import('../src/shared/render/callouts')

// Renderer code (DOM types, JSX): imported by path at run time, as the Node typecheck of tests/ does not follow it.
const E = '../src/renderer/src/editor/'
const { CalloutHandles } = (await import(/* @vite-ignore */ `${E}CalloutHandles`)) as { CalloutHandles: (props: { project: Project; selection: unknown; view: unknown }) => ReactNode }
type Mapping = { view: { w: number; h: number; toOut: (x: number, y: number) => { x: number; y: number } }; frame: Parameters<typeof calloutPlace>[2]; seen: { x: number; y: number; w: number; h: number } }
const { calloutMapping } = (await import(/* @vite-ignore */ `${E}calloutView`)) as { calloutMapping: (scene: unknown, t: number) => Mapping }

const track = { valid: false, samples: [], clicks: [], keys: [] } as unknown as CursorTrack

function sceneOf(p: Project): unknown {
  const view = cropView(p, track)
  return {
    project: view.project,
    cursor: view.cursor,
    cursorPath: new SmoothedTrack(view.cursor.samples, p.duration, p.cursor.smoothing),
    focusPath: focusPathFor(view.cursor.samples, p.duration),
    ...(view.crop ? { crop: view.crop } : {})
  }
}

function start(annotations: Annotation[], zooms: ZoomSegment[] = []): void {
  const p = createProject({
    id: 'p',
    name: 'Handles',
    duration: 30,
    width: 1920,
    height: 1080,
    hasWebcam: false,
    hasAudio: false,
    webcamOffset: 0,
    zooms: [],
    cursorValid: false,
    capture: { method: 'native', cursorInVideo: false, region: null, fps: 30 }
  })
  project = { ...p, annotations, zooms }
}

type HandleProps = { testId: string; at: { x: number; y: number }; onMove: (p: { x: number; y: number }, key?: string) => void }
const kids = (node: ReactNode): ReactNode[] => (Array.isArray(node) ? node.flatMap(kids) : [node])
/** The handles shown for annotation `id` at source time `t` (the editor paused there), by test id. */
function handles(id: string, t: number): Map<string, HandleProps> {
  player.time = t
  const out = new Map<string, HandleProps>()
  const walk = (n: ReactNode): void => {
    for (const k of kids(n)) {
      if (!isValidElement(k)) continue
      const props = (k as ReactElement<HandleProps & { children?: ReactNode }>).props
      if (typeof props.testId === 'string') out.set(props.testId, props)
      walk(props.children)
    }
  }
  walk(CalloutHandles({ project, selection: { kind: 'annotation', id }, view: null }))
  return out
}
const placeOf = (id: string, t: number): ReturnType<typeof calloutPlace> => calloutPlace(project.annotations.find((a) => a.id === id)!, '1', calloutMapping(sceneOf(project), t).frame, (s, px) => s.length * px * 0.55)

const zoom: ZoomSegment = { id: 'z', start: 3, end: 9, scale: 2.2, focus: { mode: 'fixed', x: 0.62, y: 0.38 }, transition: 1.2, auto: false }
const badge = (patch: Partial<Annotation> & Record<string, unknown>): Annotation => ({ id: 'b', start: 2, end: 10, text: '', x: 0.5, y: 0.5, size: 0.045, style: 'badge', number: 'auto', ...patch }) as Annotation
const bubble = (patch: Partial<Annotation> & Record<string, unknown>): Annotation => ({ id: 'u', start: 2, end: 10, text: 'Click here', x: 0.5, y: 0.5, size: 0.045, style: 'bubble', ...patch }) as Annotation

describe("a pinned badge or tail tip stays on the picture (§2.3, §12)", () => {
  it('Shift+Arrow and arrow presses at the edge keep the badge drawn and its handle shown', () => {
    start([badge({ pin: { x: 0.03, y: 0.5 }, x: 0.03, y: 0.5 })])
    const m = calloutMapping(sceneOf(project), 5)
    let h = handles('b', 5).get('badge-handle')!
    expect(h).toBeDefined()
    // Shift+ArrowLeft: 10 % of the frame to the left, past the card's edge onto the padding.
    h.onMove({ x: h.at.x - 0.1 * m.view.w, y: h.at.y }, 'callout-move:badge-handle')
    expect(placeOf('b', 5)).not.toBeNull()
    h = handles('b', 5).get('badge-handle')!
    expect(h).toBeDefined()
    // On the card's left edge (half a pixel in).
    expect(Math.abs(h.at.x - m.seen.x)).toBeLessThanOrEqual(1)
    // More presses at the edge: it stays there.
    for (let i = 0; i < 3; i++) {
      h.onMove({ x: h.at.x - 0.01 * m.view.w, y: h.at.y }, 'callout-move:badge-handle')
      h = handles('b', 5).get('badge-handle')!
      expect(h, `press ${i}`).toBeDefined()
    }
    // Dragged far onto the padding below the card: on the card's bottom edge.
    h.onMove({ x: m.view.w / 2, y: m.view.h - 2 })
    h = handles('b', 5).get('badge-handle')!
    expect(h).toBeDefined()
    expect(Math.abs(h.at.y - (m.seen.y + m.seen.h))).toBeLessThanOrEqual(1)
  })

  it('during a zoom too, and a tail tip moved off the picture keeps its handle', () => {
    start([badge({ pin: { x: 0.62, y: 0.38 }, x: 0.62, y: 0.38 }), bubble({ pin: { x: 0.62, y: 0.38 }, body: { dx: 0.12, dy: -0.1 } })], [zoom])
    const m = calloutMapping(sceneOf(project), 6)
    const b = handles('b', 6).get('badge-handle')!
    b.onMove({ x: m.view.w + 50, y: -50 })
    expect(handles('b', 6).get('badge-handle')).toBeDefined()
    const tip = handles('u', 6).get('tail-handle')!
    expect(tip).toBeDefined()
    tip.onMove({ x: -100, y: m.view.h / 2 }, 'callout-move:tail-handle')
    expect(handles('u', 6).get('tail-handle')).toBeDefined()
    expect(placeOf('u', 6)!.tail).not.toBeNull()
  })

  it('a badge that does not follow the zoom still goes anywhere in the frame', () => {
    start([badge({ x: 0.5, y: 0.5 })])
    const m = calloutMapping(sceneOf(project), 5)
    handles('b', 5).get('badge-handle')!.onMove({ x: 10, y: 10 })
    const a = project.annotations[0]
    expect(calloutOf(a).pin).toBeUndefined()
    expect(a.x).toBeCloseTo(10 / m.view.w, 9)
    expect(a.y).toBeCloseTo(10 / m.view.h, 9)
  })
})

describe("dragging a bubble's body (§2.3, §7.4)", () => {
  it('moves the body around its tip, the tip staying where it is', () => {
    start([bubble({ pin: { x: 0.4, y: 0.6 }, body: { dx: 0.12, dy: -0.1 } })])
    const body = handles('u', 5).get('bubble-body')!
    body.onMove({ x: body.at.x + 50, y: body.at.y + 20 })
    const a = project.annotations[0]
    expect(calloutOf(a).pin).toEqual({ x: 0.4, y: 0.6 })
    const box = placeOf('u', 5)!.box
    expect(box.x + box.w / 2).toBeCloseTo(body.at.x + 50, 6)
    expect(box.y + box.h / 2).toBeCloseTo(body.at.y + 20, 6)
  })

  it('while its tip is off the picture (a zoom) moves the body, never the tip', () => {
    // Zoomed in on the top right, the tip at the bottom left is out of the picture.
    start([bubble({ pin: { x: 0.05, y: 0.9 }, body: { dx: 0.12, dy: -0.1 } })], [zoom])
    const shown = handles('u', 6)
    expect(shown.get('tail-handle')).toBeUndefined()
    const body = shown.get('bubble-body')!
    body.onMove({ x: body.at.x + 50, y: body.at.y - 30 })
    const a = project.annotations[0]
    // The pin the user chose is kept for the whole bubble.
    expect(calloutOf(a).pin).toEqual({ x: 0.05, y: 0.9 })
    const place = placeOf('u', 6)!
    expect(place.tail).toBeNull()
    expect(place.box.x + place.box.w / 2).toBeCloseTo(body.at.x + 50, 6)
    expect(place.box.y + place.box.h / 2).toBeCloseTo(body.at.y - 30, 6)
    // Before the zoom the tip shows where it was, with its tail.
    expect(placeOf('u', 2.5)!.tail).not.toBeNull()
  })
})
