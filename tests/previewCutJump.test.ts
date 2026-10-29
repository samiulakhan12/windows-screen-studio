import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'
import { createProject } from '../src/shared/engine/project'
import type { Clip, Project } from '../src/shared/types'

/*
 * The jump over a cut in the preview (editor/player.ts) when the next clip starts between two frames
 * of the proxy, as transcript cuts almost always do (the cut ends in the middle of a pause). Driven
 * by video frame callbacks, as in Chromium: after a seek to 3.0125 s at 60 fps, the first callback
 * reports the frame covering it, whose time (3.0 s) is just before it. The video, the soundtrack and
 * the compositor are stand-ins that record what happens (as in previewShuttle.test.ts).
 */

const draws: number[] = []
/** What the player asked of its soundtrack, in order. */
const sound: string[] = []

vi.mock('../src/renderer/src/render/compositor', () => ({
  drawFrame: (_ctx: unknown, _w: number, _h: number, t: number) => void draws.push(t)
}))
vi.mock('../src/renderer/src/editor/previewAudio', () => ({
  PreviewAudio: class {
    failedStems: string[] = []
    onStemFailed: (() => void) | null = null
    setProject() {}
    play(t: number) {
      sound.push(`play ${t}`)
    }
    pause() {}
    jump(t: number) {
      sound.push(`jump ${t}`)
    }
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
  heldLivePicture: () => null
}))

/** A <video> with video frame callbacks: assigning currentTime starts a seek; `show` delivers a frame. */
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
  private callback: ((now: number, meta: { mediaTime: number }) => void) | null = null
  get currentTime(): number {
    return this.time
  }
  set currentTime(t: number) {
    this.time = t
    this.seeks.push(t)
    this.seeking = true
    this.readyState = 1
  }
  land(): void {
    this.seeking = false
    this.readyState = 4
    this.dispatchEvent(new Event('seeked'))
  }
  requestVideoFrameCallback(cb: (now: number, meta: { mediaTime: number }) => void): number {
    this.callback = cb
    return 1
  }
  cancelVideoFrameCallback(): void {
    this.callback = null
  }
  /** The frame at `mediaTime` is presented (a seek has landed by then). */
  show(mediaTime: number): void {
    if (this.seeking) this.land()
    const cb = this.callback
    this.callback = null
    cb?.(0, { mediaTime })
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

let raf: (() => void)[] = []
vi.stubGlobal('requestAnimationFrame', (cb: () => void) => raf.push(cb))
vi.stubGlobal('cancelAnimationFrame', () => undefined)
// Chromium's video elements have frame callbacks: the player drives playback with them.
vi.stubGlobal('HTMLVideoElement', class { requestVideoFrameCallback() {} })
vi.stubGlobal('window', { api: { stopAnalysis: async () => undefined } })
vi.stubGlobal('Path2D', class {})

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
  attachCanvas(c: unknown): void
  setScene(scene: unknown, bg: unknown): void
  dispose(): void
}
const { PreviewPlayer } = (await import(/* @vite-ignore */ PLAYER)) as { PreviewPlayer: new (s: FakeVideo, w: FakeVideo | null, p: Project) => Player }

const FPS = 60
/** Kept 0–2 s, cut 2–3.0125 s (between the frames at 3.0 and 3.0167 s), kept from 3.0125 s. */
const OFF_GRID: Clip[] = [
  { id: 'a', start: 0, end: 2, speed: 1 },
  { id: 'b', start: 3.0125, end: 30, speed: 1 }
]

const players: Player[] = []
function setUp(clips: Clip[], hasAudio: boolean) {
  const p = createProject({
    id: 'p',
    name: 'p',
    duration: 60,
    width: 1920,
    height: 1080,
    hasWebcam: false,
    hasAudio,
    webcamOffset: 0,
    zooms: [],
    cursorValid: false,
    capture: { method: 'native', cursorInVideo: false, region: null, fps: FPS }
  })
  p.clips = clips
  const screen = new FakeVideo()
  const player = new PreviewPlayer(screen, null, p)
  players.push(player)
  screen.land()
  player.attachCanvas({ width: 640, height: 360, getContext: () => ({}) })
  player.setScene({ project: p, cursor: { samples: [], clicks: [], valid: false } }, null)
  frame()
  return { screen, player }
}

/** Seeks while paused, lets it land, and clears the records. */
function seekTo(v: { screen: FakeVideo; player: Player }, t: number): void {
  v.player.seek(t)
  v.screen.land()
  frame()
  draws.length = 0
  sound.length = 0
  v.screen.seeks = []
}

beforeEach(() => {
  draws.length = 0
  sound.length = 0
  raf = []
})

afterEach(() => {
  for (const p of players.splice(0)) p.dispose()
})

describe('a clip that starts between two frames', () => {
  for (const hasAudio of [true, false]) {
    it(`is jumped to once at the cut, and plays on from the frame covering its start (${hasAudio ? 'with' : 'without'} sound)`, () => {
      const v = setUp(OFF_GRID, hasAudio)
      seekTo(v, 1.9)
      v.player.play()
      v.screen.seeks = []
      sound.length = 0
      // Frames up to the clip's end: the one at 119/60 s jumps (the next would reach 2 s).
      for (let k = 114; k <= 119; k++) v.screen.show(k / FPS)
      expect(v.screen.seeks).toEqual([3.0125])
      // The seek lands on the frame at 3.0 s, which covers 3.0125 s: the clip's first frame.
      v.screen.show(180 / FPS)
      expect(v.screen.seeks).toEqual([3.0125])
      expect(sound.filter((s) => s.startsWith('jump'))).toEqual(['jump 3.0125'])
      expect(v.player.playing).toBe(true)
      expect(v.player.time).toBe(3.0125)
      expect(draws.at(-1)).toBe(3.0125)
      // And on, frame by frame, with no seek.
      v.screen.show(181 / FPS)
      v.screen.show(182 / FPS)
      expect(v.screen.seeks).toEqual([3.0125])
      expect(v.player.time).toBe(182 / FPS)
      expect(draws.slice(-2)).toEqual([181 / FPS, 182 / FPS])
    })
  }

  it('plays from it once when Space is pressed with the playhead in the cut', () => {
    const v = setUp(OFF_GRID, true)
    // A click on a struck-through word: the paused video waits at the clip's start.
    seekTo(v, 2.5)
    expect(v.screen.currentTime).toBe(3.0125)
    v.player.play()
    v.screen.show(180 / FPS)
    v.screen.show(181 / FPS)
    expect(v.screen.seeks).toEqual([])
    expect(sound).toEqual(['play 3.0125'])
    expect(v.player.time).toBe(181 / FPS)
    expect(draws).toEqual([3.0125, 181 / FPS])
  })

  it('still jumps from a frame further into the cut, never drawing it', () => {
    const v = setUp(OFF_GRID, true)
    seekTo(v, 2.5)
    v.player.play()
    v.screen.seeks = []
    // A frame of the cut more than a frame before the clip (the seek had not landed): jump again.
    v.screen.show(179 / FPS)
    expect(v.screen.seeks).toEqual([3.0125])
    expect(draws).toEqual([])
  })

  it('on the frame grid: the frame before it is the cut, the jump lands on its first frame', () => {
    const v = setUp([OFF_GRID[0], { ...OFF_GRID[1], start: 3 }], true)
    seekTo(v, 2.5)
    v.player.play()
    v.screen.seeks = []
    v.screen.show(179 / FPS)
    expect(v.screen.seeks).toEqual([3])
    v.screen.show(180 / FPS)
    expect(v.screen.seeks).toEqual([3])
    expect(draws).toEqual([3])
  })
})
