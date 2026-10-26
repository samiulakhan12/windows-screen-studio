import { beforeEach, describe, expect, it, vi } from 'vitest'
import { createProject } from '../src/shared/engine/project'
import type { Project } from '../src/shared/types'

/*
 * The preview's camera while it seeks (editor/player.ts). A seeking <video> has no picture, so a
 * frame drawn then would leave the camera out (with a camera layout, the whole picture changes):
 * paused, nothing is drawn until the camera has landed too; playing, the camera's picture from
 * before the seek is drawn instead (or, with its background blurred, its last blurred picture),
 * and a fast playback does not seek the camera again before it lands. The videos, the
 * compositor and the animation frames are stand-ins that record what happens.
 */

interface Draw {
  t: number
  camera: { image: unknown } | null
  cameraSeeking: boolean
}
const draws: Draw[] = []
let livePair: object | null = null

vi.mock('../src/renderer/src/render/compositor', () => ({
  drawFrame: (_ctx: unknown, _w: number, _h: number, t: number, _scene: unknown, src: { webcam: FakeVideo | null; webcamFrame?: { image: unknown } | null }) =>
    void draws.push({ t, camera: src.webcamFrame ?? null, cameraSeeking: !!src.webcam?.seeking })
}))
vi.mock('../src/renderer/src/editor/previewAudio', () => ({
  PreviewAudio: class {
    failedStems: string[] = []
    onStemFailed: (() => void) | null = null
    setProject() {}
    play() {}
    pause() {}
    jump() {}
    setRate() {}
    setView() {}
    setSilent() {}
    hold() {}
    frame() {}
    fadeAt() {
      return 1
    }
    reloadMusic() {}
    dispose() {}
  }
}))
vi.mock('../src/renderer/src/render/cursorLayer', () => ({ onCursorAssetsChanged: () => () => undefined }))
vi.mock('../src/renderer/src/render/watermarkLayer', () => ({ onStyleAssetsChanged: () => () => undefined }))
vi.mock('../src/renderer/src/render/segmentation/cameraMasks', () => ({
  onCameraMasksChanged: () => () => undefined,
  heldLivePicture: () => livePair
}))

/** A <video>: assigning currentTime starts a seek (no picture until it lands). */
class FakeVideo extends EventTarget {
  seeking = false
  readyState = 4
  paused = true
  playbackRate = 1
  duration = 60
  videoWidth = 1280
  videoHeight = 720
  muted = false
  preservesPitch = true
  error: unknown = null
  seeks: number[] = []
  private time = 0
  get currentTime(): number {
    return this.time
  }
  set currentTime(t: number) {
    this.time = t
    this.seeks.push(t)
    this.seeking = true
    this.readyState = 1
  }
  /** The seek lands: the picture is there again. */
  land(): void {
    this.seeking = false
    this.readyState = 4
    this.dispatchEvent(new Event('seeked'))
  }
  /** Plays on by `dt` seconds of its own time (no seek). */
  advance(dt: number): void {
    this.time += dt
  }
  play(): Promise<void> {
    this.paused = false
    return Promise.resolve()
  }
  pause(): void {
    this.paused = true
  }
  removeAttribute(): void {}
  load(): void {}
}

/** Frames copied from the camera element (VideoFrame), and whether they were closed. */
const frames: FakeFrame[] = []
class FakeFrame {
  closed = false
  displayWidth = 1280
  displayHeight = 720
  constructor(readonly source: FakeVideo) {
    frames.push(this)
  }
  close(): void {
    this.closed = true
  }
}

let raf: (() => void)[] = []
vi.stubGlobal('requestAnimationFrame', (cb: () => void) => raf.push(cb))
vi.stubGlobal('cancelAnimationFrame', () => undefined)
vi.stubGlobal('VideoFrame', FakeFrame)
vi.stubGlobal('window', { api: { stopAnalysis: async () => undefined } })
vi.stubGlobal('Path2D', class {})

/** Runs the animation frames requested so far (the paused redraws, or one playing frame). */
function frame(): void {
  const due = raf
  raf = []
  for (const cb of due) cb()
}

// Renderer code (DOM types): imported at run time so the Node typecheck of tests/ does not follow it.
const PLAYER = '../src/renderer/src/editor/player'
type Player = {
  time: number
  playing: boolean
  seek(t: number): void
  play(): void
  pause(): void
  attachCanvas(c: unknown): void
  setScene(scene: unknown, bg: unknown): void
  dispose(): void
}
const { PreviewPlayer } = (await import(/* @vite-ignore */ PLAYER)) as { PreviewPlayer: new (s: FakeVideo, w: FakeVideo, p: Project) => Player }

function project(blur = 0, speed = 1): Project {
  const p = createProject({
    id: 'p',
    name: 'p',
    duration: 60,
    width: 1920,
    height: 1080,
    hasWebcam: true,
    hasAudio: false,
    webcamOffset: 0,
    zooms: [],
    cursorValid: false,
    capture: { method: 'native', cursorInVideo: false, region: null }
  })
  p.webcam = { ...p.webcam, show: true, backgroundBlur: blur }
  p.layouts = [{ id: 'l', start: 0, end: 60, layout: 'camera-only' }]
  p.clips = [{ id: 'c', start: 0, end: 60, speed }]
  return p
}

function setUp(blur = 0, speed = 1) {
  const screen = new FakeVideo()
  const camera = new FakeVideo()
  const p = project(blur, speed)
  const player = new PreviewPlayer(screen, camera, p)
  screen.land()
  camera.land()
  player.attachCanvas({ width: 640, height: 360, getContext: () => ({}) })
  player.setScene({ project: p, cursor: { samples: [], clicks: [], valid: false } }, null)
  frame()
  draws.length = 0
  return { screen, camera, player }
}

beforeEach(() => {
  draws.length = 0
  frames.length = 0
  raf = []
  livePair = null
})

describe('preview camera while it seeks, paused', () => {
  it('draws nothing until the camera has landed too, then draws once with it', () => {
    const { screen, camera, player } = setUp()
    player.seek(10)
    expect(screen.seeking && camera.seeking).toBe(true)
    // The screen lands first: its frame would show the camera missing.
    screen.land()
    frame()
    expect(draws).toEqual([])
    camera.land()
    frame()
    expect(draws).toHaveLength(1)
    expect(draws[0]).toMatchObject({ t: 10, camera: null, cameraSeeking: false })
    // The other way round as well.
    player.seek(20)
    camera.land()
    frame()
    expect(draws).toHaveLength(1)
    screen.land()
    frame()
    expect(draws).toHaveLength(2)
    expect(draws[1].cameraSeeking).toBe(false)
    // Paused seeks keep no picture.
    expect(frames).toEqual([])
  })

  it('is not held up by a camera the frame does not show: turned off, or hidden by the layout', () => {
    for (const hide of ['off', 'screen-only'] as const) {
      const screen = new FakeVideo()
      const camera = new FakeVideo()
      const p = project()
      if (hide === 'off') p.webcam = { ...p.webcam, show: false }
      else p.layouts = [{ id: 'l', start: 0, end: 30, layout: 'screen-only' }]
      const player = new PreviewPlayer(screen, camera, p)
      screen.land()
      camera.land()
      player.attachCanvas({ width: 640, height: 360, getContext: () => ({}) })
      player.setScene({ project: p, cursor: { samples: [], clicks: [], valid: false } }, null)
      frame()
      draws.length = 0
      // A slow drag: the screen lands before each next move, the camera (seeked along) never does.
      for (let i = 1; i <= 10; i++) {
        player.seek(i)
        screen.land()
        frame()
      }
      expect(camera.seeking).toBe(true)
      expect(draws.map((d) => d.t)).toEqual([1, 2, 3, 4, 5, 6, 7, 8, 9, 10])
      // Its landing changes nothing on screen: no redraw.
      camera.land()
      frame()
      expect(draws).toHaveLength(10)
      if (hide === 'screen-only') {
        // Past the hiding segment the camera shows again, and is waited for.
        player.seek(40)
        screen.land()
        frame()
        expect(draws).toHaveLength(10)
        camera.land()
        frame()
        expect(draws).toHaveLength(11)
      }
      player.dispose()
    }
  })

  it('is not held up by a camera file that failed', () => {
    const { screen, camera, player } = setUp()
    player.seek(10)
    camera.error = { code: 4 }
    screen.land()
    frame()
    expect(draws).toHaveLength(1)
  })
})

describe('preview camera while it seeks, playing', () => {
  it("draws the camera's picture from before the seek until it lands, then lets it go", () => {
    const { screen, camera, player } = setUp()
    player.seek(5)
    screen.land()
    camera.land()
    frame()
    draws.length = 0
    player.play()
    // play() seeks the camera to the screen: its picture is kept first.
    expect(camera.seeking).toBe(true)
    expect(frames).toHaveLength(1)
    frame()
    expect(draws).toHaveLength(1)
    expect(draws[0].camera?.image).toBe(frames[0])
    camera.land()
    expect(frames[0].closed).toBe(true)
    screen.advance(1 / 60)
    frame()
    expect(draws[1].camera).toBeNull()
    // A cut jump seeks the camera again: one picture per seek, however many frames it takes.
    player.seek(30)
    screen.land()
    frame()
    screen.advance(1 / 60)
    frame()
    expect(frames).toHaveLength(2)
    expect(draws.slice(2).map((d) => d.camera?.image)).toEqual([frames[1], frames[1]])
    player.dispose()
    expect(frames[1].closed).toBe(true)
  })

  it('draws the last blurred picture of a camera with its background blurred', () => {
    const { camera, player } = setUp(0.8)
    livePair = { mask: {} }
    player.play()
    frame()
    // The layer finds the live camera's blurred picture through the element.
    expect(draws[0].camera?.image).toBe(camera)
    player.dispose()
  })

  it('does not seek a drifting camera again before it lands', () => {
    const { screen, camera, player } = setUp()
    player.play()
    camera.land()
    frame()
    const seeks = camera.seeks.length
    // 0.3 s behind is seeked back.
    screen.advance(0.3)
    frame()
    expect(camera.seeks).toHaveLength(seeks + 1)
    // Still on its way there: no new seek, however far the screen has gone.
    screen.advance(0.5)
    frame()
    screen.advance(0.5)
    frame()
    expect(camera.seeks).toHaveLength(seeks + 1)
    // Landed (behind the screen again by now): seeked once more.
    camera.land()
    frame()
    expect(camera.seeks).toHaveLength(seeks + 2)
    player.dispose()
  })

  it('measures the drift in viewing time: at 8x, 0.3 s of the recording (40 ms) is left alone', () => {
    const { screen, camera, player } = setUp(0, 8)
    player.play()
    camera.land()
    frame()
    expect(screen.playbackRate).toBe(8)
    const seeks = camera.seeks.length
    screen.advance(0.3)
    frame()
    expect(camera.seeks).toHaveLength(seeks)
    // Over 0.15 s of viewing (1.2 s of the recording): seeked back.
    screen.advance(1)
    frame()
    expect(camera.seeks).toHaveLength(seeks + 1)
    player.dispose()
  })
})
