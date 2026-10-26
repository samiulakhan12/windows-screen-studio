import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'
import { createProject } from '../src/shared/engine/project'
import type { Shuttle, ShuttleKey, ShuttleStep } from '../src/shared/editor/shuttle'
import type { Clip, Project } from '../src/shared/types'

/*
 * The preview speed and the J/K/L shuttle in the player (editor/player.ts): element rates, when
 * the soundtrack is paused and the video muted, and reverse playback as a loop of seeks walked in
 * output time. The videos, the soundtrack, the compositor, the clock and the animation frames are
 * stand-ins that record what happens (as in previewCamera.test.ts).
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
    play(_t: number, rate: number) {
      sound.push(`play ${rate}`)
    }
    pause() {
      sound.push('pause')
    }
    jump(_t: number, rate: number) {
      sound.push(`jump ${rate}`)
    }
    setRate(rate: number) {
      sound.push(`rate ${rate}`)
    }
    setView(rate: number) {
      sound.push(`view ${rate}`)
    }
    setSilent(on: boolean) {
      sound.push(`silent ${on}`)
    }
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

class FakeFrame {
  displayWidth = 1280
  displayHeight = 720
  close(): void {}
}

let raf: (() => void)[] = []
vi.stubGlobal('requestAnimationFrame', (cb: () => void) => raf.push(cb))
vi.stubGlobal('cancelAnimationFrame', () => undefined)
vi.stubGlobal('VideoFrame', FakeFrame)
vi.stubGlobal('window', { api: { stopAnalysis: async () => undefined } })
vi.stubGlobal('Path2D', class {})

/** Wall clock (ms) the player reads through performance.now. */
let clock = 0

/** Runs the animation frames requested so far. */
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
  readonly moving: boolean
  readonly reversing: boolean
  readonly viewRate: number
  readonly previewSpeed: number
  readonly shuttleState: Shuttle
  getPlaying(): boolean
  getShuttleKey(): string
  seek(t: number): void
  play(): void
  pause(): void
  toggle(): void
  shuttle(key: ShuttleKey, pauseHeld?: boolean): ShuttleStep
  setPreviewSpeed(speed: number): void
  setProject(p: Project): void
  attachCanvas(c: unknown): void
  setScene(scene: unknown, bg: unknown): void
  dispose(): void
}
const { PreviewPlayer } = (await import(/* @vite-ignore */ PLAYER)) as { PreviewPlayer: new (s: FakeVideo, w: FakeVideo | null, p: Project) => Player }

// Kept 0–10 s at 1×, cut 10–20 s, kept 20–40 s at 2× (output 10–20 s): output 20 s.
const CUT: Clip[] = [
  { id: 'a', start: 0, end: 10, speed: 1 },
  { id: 'b', start: 20, end: 40, speed: 2 }
]

function project(clips: Clip[], hasAudio = true): Project {
  const p = createProject({
    id: 'p',
    name: 'p',
    duration: 60,
    width: 1920,
    height: 1080,
    hasWebcam: true,
    hasAudio,
    webcamOffset: 0,
    zooms: [],
    cursorValid: false,
    capture: { method: 'native', cursorInVideo: false, region: null }
  })
  p.webcam = { ...p.webcam, show: true }
  p.clips = clips
  return p
}

const players: Player[] = []
function setUp(clips: Clip[] = [{ id: 'c', start: 0, end: 60, speed: 1 }], hasAudio = true) {
  const screen = new FakeVideo()
  const camera = new FakeVideo()
  const p = project(clips, hasAudio)
  const player = new PreviewPlayer(screen, camera, p)
  players.push(player)
  screen.land()
  camera.land()
  player.attachCanvas({ width: 640, height: 360, getContext: () => ({}) })
  player.setScene({ project: p, cursor: { samples: [], clicks: [], valid: false } }, null)
  frame()
  draws.length = 0
  sound.length = 0
  return { screen, camera, player, project: p }
}

/** Seeks while paused and lets the seek land. */
function seekTo(v: { screen: FakeVideo; camera: FakeVideo; player: Player }, t: number): void {
  v.player.seek(t)
  v.screen.land()
  v.camera.land()
  frame()
  draws.length = 0
}

beforeEach(() => {
  draws.length = 0
  sound.length = 0
  raf = []
  clock = 1000
  vi.spyOn(performance, 'now').mockImplementation(() => clock)
})

afterEach(() => {
  // The preview speed lasts for the app session: put it back for the next test.
  players.at(-1)?.setPreviewSpeed(1)
  for (const p of players.splice(0)) p.dispose()
  vi.restoreAllMocks()
})

describe('preview speed', () => {
  it('plays the elements and the soundtrack faster, and the next editor starts at it', () => {
    const { screen, camera, player } = setUp()
    expect(player.previewSpeed).toBe(1)
    expect(player.viewRate).toBe(0)
    player.setPreviewSpeed(1.5)
    player.play()
    expect(player.viewRate).toBe(1.5)
    expect(screen.playbackRate).toBe(1.5)
    expect(camera.playbackRate).toBe(1.5)
    expect(sound).toEqual(['rate 1.5', 'view 1.5', 'play 1.5'])
    // During playback: the rate follows at once.
    player.setPreviewSpeed(2)
    expect(screen.playbackRate).toBe(2)
    expect(sound.slice(3)).toEqual(['rate 2', 'view 2'])
    // Not in the project: a new player (another editor in this app session) starts at it.
    expect(setUp().player.previewSpeed).toBe(2)
  })

  it('ignores a speed that is not on the list', () => {
    const { player } = setUp()
    player.setPreviewSpeed(3)
    expect(player.previewSpeed).toBe(1)
  })
})

describe('L, K and Space', () => {
  it('L plays and doubles; above 4× the sound pauses and the video is muted until it stops', () => {
    const { screen, player } = setUp()
    player.shuttle('forward')
    expect(player.playing && player.shuttleState).toEqual({ dir: 1, level: 0 })
    expect(screen.playbackRate).toBe(1)
    player.shuttle('forward')
    player.shuttle('forward')
    expect(screen.playbackRate).toBe(4)
    expect(sound).not.toContain('pause')
    sound.length = 0
    player.shuttle('forward')
    expect(screen.playbackRate).toBe(8)
    // Silent first, so the soundtrack's pause leaves the video's clock running.
    expect(sound).toEqual(['rate 8', 'view 8', 'silent true', 'pause'])
    expect(player.getShuttleKey()).toBe('1|3|1|1')
    sound.length = 0
    // Space: everything stops, with no mute left behind.
    player.toggle()
    expect(player.moving).toBe(false)
    expect(player.shuttleState).toEqual({ dir: 0, level: 0 })
    expect(sound).toEqual(['pause', 'silent false'])
    expect(player.getShuttleKey()).toBe('0|0|1|0')
    // Space again plays at the preview speed, with sound.
    sound.length = 0
    player.toggle()
    expect(screen.playbackRate).toBe(1)
    expect(sound).toEqual(['rate 1', 'view 1', 'play 1'])
  })

  it('a project without sound is not "no sound"', () => {
    const { player } = setUp(undefined, false)
    for (let i = 0; i < 4; i++) player.shuttle('forward')
    expect(player.getShuttleKey()).toBe('1|3|1|0')
  })

  it('at viewing rate 1 an 8× clip plays as before; faster, the element rate stops at 16', () => {
    const { screen, player } = setUp([{ id: 'c', start: 0, end: 60, speed: 8 }])
    player.play()
    expect(screen.playbackRate).toBe(8)
    expect(sound).toEqual(['rate 8', 'view 1', 'play 8'])
    player.shuttle('forward')
    expect(player.viewRate).toBe(2)
    expect(screen.playbackRate).toBe(16)
    player.shuttle('forward')
    expect(player.viewRate).toBe(4)
    expect(screen.playbackRate).toBe(16)
  })

  it('K stops; J or L while K is held steps a frame instead', () => {
    const { player } = setUp()
    player.shuttle('forward')
    expect(player.shuttle('pause')).toEqual({ next: { dir: 0, level: 0 }, frameStep: 0 })
    expect(player.moving).toBe(false)
    expect(player.shuttle('forward', true).frameStep).toBe(1)
    expect(player.shuttle('reverse', true).frameStep).toBe(-1)
    expect(player.moving).toBe(false)
  })
})

describe('reverse (J)', () => {
  it('draws each landed seek and walks back in output time, skipping the cut', () => {
    const v = setUp(CUT)
    const { screen, player } = v
    // Source 30 is output 15.
    seekTo(v, 30)
    player.shuttle('reverse')
    expect(player.reversing && player.moving && player.getPlaying()).toBe(true)
    expect(screen.paused).toBe(true)
    expect(sound).toEqual([])
    // Nothing to seek yet (the frame shown is the target): it waits a display frame.
    expect(screen.seeking).toBe(false)
    // One second later: output 14, source 28 (the 2× clip reverses 2 s per second).
    clock += 1000
    frame()
    expect(screen.currentTime).toBe(28)
    expect(player.time).toBe(28)
    // It lands, is drawn, and the loop goes on from the clock.
    clock += 4000
    screen.land()
    frame()
    expect(draws).toEqual([28])
    // Output 10 - 1 = 9: across the cut, into the 1× clip.
    expect(screen.currentTime).toBeCloseTo(20, 6)
    clock += 2000
    screen.land()
    frame()
    expect(draws).toEqual([28, 20])
    expect(screen.currentTime).toBeCloseTo(8, 6)
    expect(screen.seeks.some((t) => t > 10 && t < 20)).toBe(false)
  })

  it('stops on the first kept frame', () => {
    const v = setUp(CUT)
    seekTo(v, 5)
    v.player.shuttle('reverse')
    clock += 10_000
    frame()
    expect(v.player.moving).toBe(false)
    expect(v.player.shuttleState).toEqual({ dir: 0, level: 0 })
    expect(v.player.time).toBe(0)
    expect(v.screen.currentTime).toBe(0)
  })

  it('re-anchors on a seek without seeking itself, and goes faster from where it is on J again', () => {
    const v = setUp()
    const { screen, player } = v
    seekTo(v, 30)
    player.shuttle('reverse')
    const seeks = screen.seeks.length
    player.seek(50)
    expect(screen.seeks).toHaveLength(seeks)
    clock += 1000
    frame()
    expect(screen.currentTime).toBe(49)
    // J again 0.5 s later: 2× from 48.5, wherever the last seek is.
    clock += 500
    expect(player.shuttle('reverse').next).toEqual({ dir: -1, level: 1 })
    expect(player.viewRate).toBe(-2)
    clock += 1000
    screen.land()
    frame()
    expect(screen.currentTime).toBe(46.5)
    // A faster preview speed: 4× from there.
    clock += 250
    player.setPreviewSpeed(2)
    clock += 500
    screen.land()
    frame()
    expect(screen.currentTime).toBe(44)
  })

  it('an edit re-anchors on the new clips', () => {
    const v = setUp()
    seekTo(v, 30)
    v.player.shuttle('reverse')
    v.player.setProject(project(CUT))
    clock += 1000
    frame()
    // Source 30 is output 15 in the new edit; one second back is output 14, source 28.
    expect(v.screen.currentTime).toBe(28)
  })

  it('seeks the camera along, never again before it has landed', () => {
    const v = setUp()
    const { screen, camera, player } = v
    seekTo(v, 30)
    player.shuttle('reverse')
    clock += 100
    frame()
    expect(camera.seeking).toBe(true)
    const camSeeks = camera.seeks.length
    for (let i = 0; i < 3; i++) {
      clock += 100
      screen.land()
      frame()
    }
    expect(camera.seeks).toHaveLength(camSeeks)
    camera.land()
    clock += 100
    screen.land()
    frame()
    expect(camera.seeks).toHaveLength(camSeeks + 1)
    expect(camera.currentTime).toBe(screen.currentTime)
  })

  it('K, Space or L end it; L plays forward from where it was', () => {
    const v = setUp()
    const { screen, player } = v
    for (const stop of ['pause', 'toggle', 'forward'] as const) {
      seekTo(v, 30)
      player.shuttle('reverse')
      clock += 1000
      frame()
      screen.land()
      frame()
      if (stop === 'pause') player.shuttle('pause')
      else if (stop === 'toggle') player.toggle()
      else player.shuttle('forward')
      expect(player.reversing).toBe(false)
      expect(player.playing).toBe(stop === 'forward')
      if (stop === 'forward') {
        expect(player.shuttleState).toEqual({ dir: 1, level: 0 })
        expect(player.time).toBe(29)
        player.pause()
      } else {
        // The paused frame is the playhead's.
        expect(player.time).toBe(29)
        expect(screen.currentTime).toBe(29)
      }
    }
  })

  it('J while playing forward stops the sound and runs back from the frame shown', () => {
    const v = setUp()
    const { screen, player } = v
    seekTo(v, 10)
    player.shuttle('forward')
    player.shuttle('forward')
    sound.length = 0
    screen.advance(2)
    expect(player.shuttle('reverse').next).toEqual({ dir: -1, level: 0 })
    expect(player.playing).toBe(false)
    expect(sound).toEqual(['pause', 'silent false'])
    clock += 1000
    frame()
    expect(screen.currentTime).toBe(11)
  })
})
