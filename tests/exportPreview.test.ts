import { beforeEach, describe, expect, it, vi } from 'vitest'
import { createProject } from '../src/shared/engine/project'
import { DEFAULT_EXPORT_OPTIONS } from '../src/shared/render/exportPresets'
import type { Project } from '../src/shared/types'
import { mockReact, render, unmountAll, type El } from './studioHarness'

/*
 * The export dialog's preview (ExportPreview) seeks a paused video of its own and draws the frame
 * once the seek lands. Rendered without a DOM (tests/studioHarness.ts); the video's readiness and
 * its seeks are held until the test lets them through.
 *
 * - The picture drawn is the decoded frame whose timestamp is the sought one (seekedFrame), not the
 *   element: Chromium fires 'seeked' a moment before the new picture reaches the element, and the
 *   preview draws once per seek, so drawing the element could leave the frame before under the new
 *   frame's texts for good (tests/e2e/languages.e2e.cjs, L13, saw it under load).
 * - A request a newer one replaced does not seek once its video is ready: its seek would land last
 *   and leave its frame on the element.
 * - data-settled tells a reader when the pixels are the newest frame's, so a test waits for it
 *   instead of a fixed time.
 */

/** The video's readiness and seeks, held until the test lets them through, and the frames taken. */
const media = vi.hoisted(() => ({
  readyNow: true,
  waiting: [] as (() => void)[],
  seeks: [] as { t: number; land: () => void }[],
  frames: [] as { t: number; closed: boolean; displayWidth: number; displayHeight: number; close(): void }[]
}))
/** What each drawFrame call drew: its time and the screen picture it was given (undefined: the element). */
const drawn = vi.hoisted(() => [] as { t: number; screen: unknown }[])

vi.mock('../src/renderer/src/editor/media', () => ({
  SCREEN_PROXY_FPS: 60,
  WEBCAM_PROXY_FPS: 30,
  createVideo: () => ({ muted: false, removeAttribute: () => undefined, load: () => undefined }),
  whenReady: () => (media.readyNow ? Promise.resolve() : new Promise<void>((ready) => void media.waiting.push(ready))),
  seekToFrame: (_v: unknown, t: number) => new Promise<void>((land) => void media.seeks.push({ t, land })),
  seekedFrame: async (_v: unknown, t: number) => {
    const frame = {
      t,
      closed: false,
      displayWidth: 1280,
      displayHeight: 720,
      close() {
        frame.closed = true
      }
    }
    media.frames.push(frame)
    return { frame, verified: true }
  }
}))
vi.mock('../src/renderer/src/render/compositor', () => ({
  drawFrame: (_ctx: unknown, _w: number, _h: number, t: number, _scene: unknown, src: { screenFrame?: { image: unknown } | null }) =>
    void drawn.push({ t, screen: src.screenFrame?.image })
}))
vi.mock('../src/renderer/src/render/segmentation/cameraMasks', () => ({ CameraMaskPreparer: class {}, onCameraMasksChanged: () => () => undefined }))
vi.mock('../src/renderer/src/render/watermarkLayer', () => ({ onStyleAssetsChanged: () => () => undefined }))
vi.mock('../src/renderer/src/editor/joinStills', () => ({ JoinStills: class {} }))
vi.stubGlobal('window', { devicePixelRatio: 1 })
mockReact()

// Renderer code: imported at run time so the Node typecheck of tests/ does not follow it.
const EXPORT_PREVIEW = '../src/renderer/src/editor/ExportPreview'
const { ExportPreview } = (await import(/* @vite-ignore */ EXPORT_PREVIEW)) as { ExportPreview: (p: unknown) => unknown }

const project: Project = createProject({ id: 'p', name: 'p', duration: 3, width: 1280, height: 720, hasWebcam: false, hasAudio: false, webcamOffset: 0, zooms: [], cursorValid: false, capture: { method: 'native', cursorInVideo: false, region: null } })
// One look for every render, as the dialog gives while only the frame moves.
const scene = { project }
const preview = (time: number): El => ({
  type: ExportPreview,
  props: { project, scene, screenUrl: 'studio-media://screen.mp4', webcamUrl: null, background: null, options: DEFAULT_EXPORT_OPTIONS, time, box: { width: 236, height: 236 } }
})
/** The canvas, with a 2D context the draw effect can take (the harness's stand-in has none). */
function canvas(els: El[]): El {
  const c = els.find((e) => e.type === 'canvas')!
  const node = (c.ref as { current: Record<string, unknown> }).current
  node.getContext = () => ({})
  return c
}
const settled = (els: El[]): unknown => canvas(els).props['data-settled']
const microtasks = async (): Promise<void> => {
  for (let i = 0; i < 10; i++) await Promise.resolve()
}
/** Lands the seek to `t` (asked once the video is ready), lets its promise chain run, then renders again. */
async function land(t: number, root: El): Promise<El[]> {
  await microtasks()
  media.seeks.find((s) => s.t === t)!.land()
  await microtasks()
  return render(root)
}

beforeEach(() => {
  unmountAll()
  media.readyNow = true
  media.waiting.length = 0
  media.seeks.length = 0
  media.frames.length = 0
  drawn.length = 0
})

describe('ExportPreview: the picture drawn', () => {
  it("draws the decoded frame whose timestamp is the sought one, not the element ('seeked' comes before the picture reaches it)", async () => {
    const opened = preview(0)
    canvas(render(opened))
    await land(0, opened)
    const first = media.frames.find((f) => f.t === 0)
    expect(first).toBeDefined()
    expect(drawn).toEqual([{ t: 0, screen: first }])
    const moved = preview(1.5)
    canvas(render(moved))
    await land(1.5, moved)
    const second = media.frames.find((f) => f.t === 1.5)
    expect(drawn.at(-1)).toEqual({ t: 1.5, screen: second })
    // The frame before is let go once another replaces it, the last one when the preview goes.
    expect(first!.closed).toBe(true)
    expect(second!.closed).toBe(false)
    unmountAll()
    expect(second!.closed).toBe(true)
  })

  it('a request a newer one replaced does not seek once its video is ready (its seek would land last)', async () => {
    // The dialog opens before the video has loaded: the opening frame's request waits for it.
    media.readyNow = false
    canvas(render(preview(0)))
    await microtasks()
    expect(media.waiting).toHaveLength(1)
    // The frame moves to 1.5 s just as the video becomes ready; the new request seeks at once.
    media.readyNow = true
    const moved = preview(1.5)
    canvas(render(moved))
    await microtasks()
    media.waiting[0]()
    await microtasks()
    expect(media.seeks.map((s) => s.t)).toEqual([1.5])
    await land(1.5, moved)
    expect(drawn.map((d) => d.t)).toEqual([1.5])
  })
})

describe('ExportPreview: data-settled', () => {
  it('is absent until the first frame is drawn, then present', async () => {
    const root = preview(0)
    expect(settled(render(root))).toBeUndefined()
    const els = await land(0, root)
    expect(drawn.map((d) => d.t)).toEqual([0])
    expect(settled(els)).toBe('')
  })

  it('goes away while a newer frame is sought, and comes back only once that frame is drawn', async () => {
    const opened = preview(0)
    canvas(render(opened))
    expect(settled(await land(0, opened))).toBe('')
    // The thumbnail frame moves to 1.5 s: the canvas still holds 0 s until the seek lands.
    const moved = preview(1.5)
    expect(settled(render(moved))).toBeUndefined()
    expect(drawn.map((d) => d.t)).toEqual([0])
    const els = await land(1.5, moved)
    expect(drawn.map((d) => d.t)).toEqual([0, 1.5])
    expect(settled(els)).toBe('')
  })

  it('a seek that lands after a newer request settles nothing (the newest request wins)', async () => {
    const opened = preview(0)
    canvas(render(opened))
    // The opening frame's seek is under way when the frame moves.
    await microtasks()
    expect(media.seeks.map((s) => s.t)).toEqual([0])
    const moved = preview(1.5)
    canvas(render(moved))
    expect(settled(await land(0, moved))).toBeUndefined()
    expect(drawn).toEqual([])
    expect(settled(await land(1.5, moved))).toBe('')
    expect(drawn.map((d) => d.t)).toEqual([1.5])
  })
})
