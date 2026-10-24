import { beforeEach, describe, expect, it, vi } from 'vitest'
import { createProject } from '../src/shared/engine/project'
import type { Project } from '../src/shared/types'

/* ---------- a stand-in browser: worker, canvases, camera element and frames ---------- */

interface Message {
  type: string
  id?: number
}

class FakeWorker {
  static all: FakeWorker[] = []
  sent: Message[] = []
  terminated = false
  onmessage: ((e: { data: unknown }) => void) | null = null
  onerror: unknown = null
  constructor() {
    FakeWorker.all.push(this)
  }
  postMessage(m: Message): void {
    if (!this.terminated) this.sent.push(m)
  }
  terminate(): void {
    this.terminated = true
  }
  reply(data: unknown): void {
    this.onmessage?.({ data })
  }
  segments(): Message[] {
    return this.sent.filter((m) => m.type === 'segment')
  }
}

/** A 2D context that accepts every call (and reads back blank pixels). */
function fakeCanvas(): unknown {
  const canvas: Record<string, unknown> = { width: 0, height: 0 }
  const ctx = new Proxy<Record<string | symbol, unknown>>(
    { canvas, getImageData: (_x: number, _y: number, w: number, h: number) => ({ data: new Uint8ClampedArray(w * h * 4) }) },
    {
      get: (target, prop) => (prop in target ? target[prop] : () => undefined),
      set: (target, prop, value) => {
        target[prop] = value
        return true
      }
    }
  )
  canvas.getContext = () => ctx
  return canvas
}

class FakeVideo extends EventTarget {
  currentTime = 0
  readyState = 4
  paused = true
  src = 'media://camera'
  videoWidth = 64
  videoHeight = 36
  listening = 0
  addEventListener(...args: Parameters<EventTarget['addEventListener']>): void {
    this.listening++
    super.addEventListener(...args)
  }
  removeEventListener(...args: Parameters<EventTarget['removeEventListener']>): void {
    this.listening--
    super.removeEventListener(...args)
  }
}

class FakeFrame {
  closed = false
  timestamp: number
  displayWidth: number
  displayHeight: number
  constructor(v: { currentTime: number; videoWidth: number; videoHeight: number }) {
    this.timestamp = Math.round(v.currentTime * 1e6)
    this.displayWidth = v.videoWidth
    this.displayHeight = v.videoHeight
  }
  close(): void {
    this.closed = true
  }
}

vi.stubGlobal('Worker', FakeWorker)
vi.stubGlobal('document', { createElement: () => fakeCanvas() })
vi.stubGlobal(
  'ImageData',
  class {
    constructor(
      public data: Uint8ClampedArray,
      public width: number,
      public height: number
    ) {}
  }
)
vi.stubGlobal('VideoFrame', FakeFrame)
vi.stubGlobal('HTMLVideoElement', FakeVideo)
vi.stubGlobal(
  'Path2D',
  class {
    constructor(_d?: string) {}
  }
)

/* ---------- the modules under test, fresh for every test ---------- */

interface Masked {
  mask: unknown
  frame: FakeFrame
}
interface Masks {
  livePicture(v: FakeVideo): Masked | null
  releaseLivePicture(v: FakeVideo): void
  onCameraMasksChanged(l: () => void): () => void
  maskOf(image: object): unknown
  CameraMaskPreparer: new () => { start(): Promise<boolean>; prepare(frame: { image: object; width: number; height: number }): Promise<void> }
}
interface Segmenter {
  ensureSegmenter(): Promise<boolean>
  segmenterState(): { status: string; reason?: string }
}
// Renderer code (DOM types): imported at run time so the Node typecheck of tests/ does not follow it.
const MASKS = '../src/renderer/src/render/segmentation/cameraMasks'
const SEGMENTER = '../src/renderer/src/render/segmentation/personSegmenter'
const LAYER = '../src/renderer/src/render/webcamLayer'

let masks: Masks
let seg: Segmenter
let worker: FakeWorker
let redraws = 0

const tick = (): Promise<void> => new Promise((r) => setTimeout(r, 5))
const mask = (id: number | undefined) => ({ type: 'mask', id, width: 4, height: 4, pixels: new ArrayBuffer(64) })
const missed = (id: number | undefined) => ({ type: 'missed', id, reason: 'the graphics context was lost' })
const lastRequest = (): number | undefined => worker.segments().at(-1)?.id

beforeEach(async () => {
  vi.resetModules()
  FakeWorker.all = []
  masks = (await import(/* @vite-ignore */ MASKS)) as Masks
  seg = (await import(/* @vite-ignore */ SEGMENTER)) as Segmenter
  const loaded = seg.ensureSegmenter()
  worker = FakeWorker.all[0]
  worker.reply({ type: 'ready' })
  expect(await loaded).toBe(true)
  redraws = 0
  masks.onCameraMasksChanged(() => redraws++)
})

/** Lets the preview camera segment its current frame and answers with a mask. */
async function blurred(video: FakeVideo): Promise<Masked> {
  masks.livePicture(video)
  await tick()
  worker.reply(mask(lastRequest()))
  await tick()
  const pair = masks.livePicture(video)
  expect(pair?.mask).toBeTruthy()
  return pair!
}

describe('preview background blur', () => {
  it('falls back to the live, unblurred camera when segmentation breaks after working', async () => {
    const video = new FakeVideo()
    const pair = await blurred(video)
    expect(redraws).toBe(1)
    // The worker cannot run any more (it could not reload after a lost graphics context).
    worker.reply({ type: 'failed', reason: 'it needs WebGL graphics' })
    expect(seg.segmenterState().status).toBe('failed')
    expect(redraws).toBe(2) // the preview redraws at once
    expect(masks.livePicture(video)).toBeNull()
    expect(pair.frame.closed).toBe(true)
    expect(video.listening).toBe(0)
    // Nothing more is segmented.
    video.currentTime = 0.5
    expect(masks.livePicture(video)).toBeNull()
    await tick()
    expect(worker.segments()).toHaveLength(1)
  })

  it('draws a frame whose picture failed unblurred, tries it once more, and keeps the blur on', async () => {
    const video = new FakeVideo()
    const first = await blurred(video)
    video.currentTime = 0.1
    expect(masks.livePicture(video)).toBe(first) // the previous frame while the new one is segmented
    await tick()
    worker.reply(missed(lastRequest()))
    await tick()
    expect(seg.segmenterState().status).toBe('ready')
    // Never the older frame for this one: the camera as it is now.
    expect(first.frame.closed).toBe(true)
    expect(masks.livePicture(video)).toBeNull()
    await tick()
    expect(worker.segments()).toHaveLength(3) // tried again
    worker.reply(mask(lastRequest()))
    await tick()
    expect(masks.livePicture(video)?.frame.timestamp).toBe(100000)
  })

  it('turns the blur off after pictures fail again and again', async () => {
    const video = new FakeVideo()
    await blurred(video)
    video.currentTime = 0.2
    masks.livePicture(video)
    await tick()
    worker.reply(missed(lastRequest()))
    await tick()
    masks.livePicture(video)
    await tick()
    worker.reply(missed(lastRequest()))
    await tick()
    // Twice for one frame is enough: no third try at it.
    masks.livePicture(video)
    await tick()
    expect(worker.segments()).toHaveLength(3)
    expect(seg.segmenterState().status).toBe('ready')
    video.currentTime = 0.3
    masks.livePicture(video)
    await tick()
    worker.reply(missed(lastRequest()))
    await tick()
    expect(seg.segmenterState()).toMatchObject({ status: 'failed', reason: 'the graphics context was lost' })
    expect(worker.terminated).toBe(true)
    expect(masks.livePicture(video)).toBeNull()
  })

  it('stops segmenting once the blur is turned off, also when the camera is seeked', async () => {
    const video = new FakeVideo()
    const pair = await blurred(video)
    masks.releaseLivePicture(video)
    expect(pair.frame.closed).toBe(true)
    expect(video.listening).toBe(0)
    video.currentTime = 2
    video.dispatchEvent(new Event('seeked'))
    await tick()
    expect(worker.segments()).toHaveLength(1)
    expect(redraws).toBe(1)
  })
})

describe('export background blur', () => {
  it('tries a failed picture once more, then draws that frame unblurred (never through the preview path)', async () => {
    const prep = new masks.CameraMaskPreparer()
    expect(await prep.start()).toBe(true)
    const a = new FakeFrame({ currentTime: 0, videoWidth: 64, videoHeight: 36 })
    const pa = prep.prepare({ image: a, width: 64, height: 36 })
    await tick()
    worker.reply(missed(lastRequest()))
    await tick()
    worker.reply(mask(lastRequest()))
    await pa
    expect(masks.maskOf(a)).toBeTruthy()
    const b = new FakeFrame({ currentTime: 1 / 30, videoWidth: 64, videoHeight: 36 })
    const pb = prep.prepare({ image: b, width: 64, height: 36 })
    await tick()
    worker.reply(missed(lastRequest()))
    await tick()
    worker.reply(missed(lastRequest()))
    await pb
    expect(masks.maskOf(b)).toBeNull()
    expect(masks.maskOf({})).toBeUndefined()
    expect(seg.segmenterState().status).toBe('ready')
  })
})

describe('webcam layer', () => {
  function context(): unknown {
    return new Proxy<Record<string | symbol, unknown>>(
      {},
      {
        get: (target, prop) => (prop in target ? target[prop] : () => undefined),
        set: (target, prop, value) => {
          target[prop] = value
          return true
        }
      }
    )
  }

  it('lets the preview camera go when the blur is turned off or the camera hidden', async () => {
    const { drawWebcamLayer } = (await import(/* @vite-ignore */ LAYER)) as { drawWebcamLayer: (fc: unknown, camera: unknown) => void }
    const base = createProject({
      id: 'p',
      name: 'P',
      duration: 5,
      width: 1280,
      height: 720,
      hasWebcam: true,
      hasAudio: false,
      webcamOffset: 0,
      zooms: [],
      cursorValid: false,
      capture: { method: 'chromium', cursorInVideo: true, region: null }
    })
    const ctx = context()
    const video = new FakeVideo()
    const camera = { image: video, width: 64, height: 36 }
    const draw = (webcam: Partial<Project['webcam']>): void => {
      const project = { ...base, webcam: { ...base.webcam, ...webcam } }
      drawWebcamLayer({ ctx, project, w: 1920, h: 1080, k: 1, vw: 1280, vh: 720, t: 0 }, project.webcam.show ? camera : null)
    }
    draw({ backgroundBlur: 1 })
    expect(video.listening).toBe(1) // segmented in the background
    await tick()
    worker.reply(mask(lastRequest()))
    await tick()
    draw({ backgroundBlur: 1 })
    const held = masks.livePicture(video)!
    draw({ backgroundBlur: 0 })
    expect(held.frame.closed).toBe(true)
    expect(video.listening).toBe(0)
    draw({ backgroundBlur: 1 })
    expect(video.listening).toBe(1)
    draw({ backgroundBlur: 1, show: false })
    expect(video.listening).toBe(0)
    await tick()
    // Nothing was segmented after the first frame: the camera was hidden before its turn came.
    expect(worker.segments()).toHaveLength(1)
  })
})
