import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'
import { fadeKeyframes, gainAt } from '../src/shared/audio/automation'
import { createProject } from '../src/shared/engine/project'
import { planOf, videoTimeAt, type Hold } from '../src/shared/engine/freeze'
import { frameSeekTime } from '../src/shared/render/frameTiming'
import type { Freeze, Project } from '../src/shared/types'

/*
 * The preview's background music through a pause freeze (editor/previewAudio.ts with
 * editor/player.ts, E-11): it plays on the video clock before, during and after a hold,
 * whatever time the screen element waits at (the middle of the held frame, past the anchor),
 * and when playback enters a hold, resumes one or seeks into and out of one. The audio graph,
 * the audio and video elements, the compositor, the clock and the animation frames are
 * stand-ins (as in previewFreeze.test.ts); the soundtrack is the real one.
 */

/** An <audio>: plays on with `advance`; every assignment to currentTime is a seek, recorded. */
class FakeAudio {
  paused = true
  playbackRate = 1
  loop = false
  duration = NaN
  error = null
  readonly seeks: number[] = []
  private time = 0
  constructor(readonly url: string) {}
  get currentTime(): number {
    return this.time
  }
  set currentTime(t: number) {
    this.time = t
    this.seeks.push(t)
  }
  advance(dt: number): void {
    if (!this.paused) this.time += dt * this.playbackRate
  }
  play(): Promise<void> {
    this.paused = false
    return Promise.resolve()
  }
  pause(): void {
    this.paused = true
  }
  addEventListener(): void {}
  removeAttribute(): void {}
  load(): void {}
}
const audios: FakeAudio[] = []

vi.mock('../src/renderer/src/editor/media', async (original) => ({
  ...(await original<object>()),
  createAudio: (url: string) => {
    const a = new FakeAudio(url)
    audios.push(a)
    return a
  }
}))
vi.mock('../src/renderer/src/editor/audioAnalysis', () => ({ loadAudioAnalysis: async () => ({}) }))
vi.mock('../src/renderer/src/render/compositor', () => ({ drawFrame: () => undefined }))
vi.mock('../src/renderer/src/editor/freezeStills', () => ({
  FreezeStills: class {
    get() {
      return null
    }
    prepare() {}
    dispose() {}
  }
}))
vi.mock('../src/renderer/src/render/cursorLayer', () => ({ onCursorAssetsChanged: () => () => undefined }))
vi.mock('../src/renderer/src/render/watermarkLayer', () => ({ onStyleAssetsChanged: () => () => undefined }))
vi.mock('../src/renderer/src/render/segmentation/cameraMasks', () => ({
  onCameraMasksChanged: () => () => undefined,
  heldLivePicture: () => null
}))

/** A gain's value as the last schedule set it at the playhead. */
class FakeParam {
  value = 1
  cancelScheduledValues(): void {}
  setValueAtTime(v: number): void {
    this.value = v
  }
  linearRampToValueAtTime(): void {}
}
class FakeNode {
  gain = new FakeParam()
  curve: unknown = null
  to: unknown = null
  connect<T>(n: T): T {
    this.to = n
    return n
  }
  disconnect(): void {}
}
class FakeAudioContext {
  static last: FakeAudioContext
  currentTime = 0
  destination = {}
  readonly nodes: FakeNode[] = []
  constructor() {
    FakeAudioContext.last = this
  }
  private node(): FakeNode {
    const n = new FakeNode()
    this.nodes.push(n)
    return n
  }
  createGain = (): FakeNode => this.node()
  createWaveShaper = (): FakeNode => this.node()
  createMediaElementSource = (): FakeNode => this.node()
  resume = (): Promise<void> => Promise.resolve()
  suspend = (): Promise<void> => Promise.resolve()
  close = (): Promise<void> => Promise.resolve()
}
vi.stubGlobal('AudioContext', FakeAudioContext)

/** A <video>: assigning currentTime starts a seek; `advance` plays on. */
class FakeVideo extends EventTarget {
  seeking = false
  readyState = 4
  paused = true
  playbackRate = 1
  duration = 60
  videoWidth = 1280
  videoHeight = 720
  muted = false
  volume = 1
  preservesPitch = true
  error: unknown = null
  currentSrc = 'studio-media://p/screen.mp4'
  src = this.currentSrc
  private time = 0
  get currentTime(): number {
    return this.time
  }
  set currentTime(t: number) {
    this.time = t
    this.seeking = true
    this.readyState = 1
  }
  land(): void {
    this.seeking = false
    this.readyState = 4
    this.dispatchEvent(new Event('seeked'))
  }
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

let raf: (() => void)[] = []
vi.stubGlobal('requestAnimationFrame', (cb: () => void) => raf.push(cb))
vi.stubGlobal('cancelAnimationFrame', () => undefined)
vi.stubGlobal('VideoFrame', class {})
vi.stubGlobal('window', { api: { stopAnalysis: async () => undefined } })
vi.stubGlobal('Path2D', class {})

/** Wall clock (ms) the player reads through performance.now. */
let clock = 0

/** Runs the animation frames (and the frame callbacks, which are animation frames here) requested so far. */
function frame(): void {
  const due = raf
  raf = []
  for (const cb of due) cb()
}

// Renderer code (DOM types): imported at run time so the Node typecheck of tests/ does not follow it.
const AUDIO = '../src/renderer/src/editor/previewAudio'
const PLAYER = '../src/renderer/src/editor/player'
type Sound = {
  play(t: number, speed: number): void
  pause(): void
  jump(t: number, speed: number): void
  setView(rate: number): void
  setProject(p: Project): void
  hold(h: Hold | null, elapsed: number): void
  frame(): void
  dispose(): void
}
type Player = {
  time: number
  readonly holdElapsed: number
  readonly heldFreeze: string | null
  seek(t: number): void
  play(): void
  pause(): void
  attachCanvas(c: unknown): void
  setScene(scene: unknown, bg: unknown): void
  dispose(): void
}
const { PreviewAudio } = (await import(/* @vite-ignore */ AUDIO)) as { PreviewAudio: new (s: unknown, p: Project) => Sound }
const { PreviewPlayer } = (await import(/* @vite-ignore */ PLAYER)) as { PreviewPlayer: new (s: FakeVideo, w: FakeVideo | null, p: Project) => Player }

/** Seconds the music may be off the video before it is seeked (previewAudio MUSIC_SEEK). */
const MUSIC_SEEK = 0.3

/** A minute of recording at 60 fps with background music and a 3 s pause freeze at 2 s. */
function project(fadeIn = 0): Project {
  const p = createProject({
    id: 'p',
    name: 'p',
    duration: 60,
    width: 1920,
    height: 1080,
    hasWebcam: false,
    hasAudio: true,
    webcamOffset: 0,
    zooms: [],
    cursorValid: false,
    capture: { method: 'native', cursorInVideo: false, region: null, fps: 60 }
  })
  p.clips = [{ id: 'c', start: 0, end: 60, speed: 1 }]
  p.freezes = [{ id: 'f', at: 2, length: 3, sound: 'pause' } satisfies Freeze]
  p.audio = { ...p.audio, fadeIn, music: { path: 'music.mp3', volume: 1, ducking: 0, loop: true, fadeIn: 0, fadeOut: 0 } }
  return p
}

const music = (): FakeAudio => audios.find((a) => a.url.includes('music'))!

const disposers: (() => void)[] = []

beforeEach(() => {
  audios.length = 0
  raf = []
  clock = 1000
  vi.spyOn(performance, 'now').mockImplementation(() => clock)
})

afterEach(() => {
  for (const d of disposers.splice(0)) d()
  vi.restoreAllMocks()
})

describe('the preview soundtrack in a pause freeze', () => {
  it('runs on the hold, not on where the screen waits in it (the middle of the held frame)', () => {
    const p = project(5)
    const h = planOf(p).holds[0]
    const screen = { currentTime: 0, muted: false, volume: 1 }
    const sound = new PreviewAudio(screen, p)
    disposers.push(() => sound.dispose())
    const m = music()
    const master = FakeAudioContext.last.nodes.find((n) => n.to === FakeAudioContext.last.destination)!
    sound.play(0, 1)
    screen.currentTime = 1.99
    m.advance(1.99)
    sound.frame()
    // The player holds the freeze: the screen waits in the middle of its frame, the music plays on.
    screen.currentTime = frameSeekTime(h.at, 60)
    sound.hold(h, 0)
    m.advance(0.01)
    m.seeks.length = 0
    // A second into it: the music is a second past the hold's start, not past the hold.
    m.advance(1)
    sound.hold(h, 1)
    sound.frame()
    expect(m.seeks).toEqual([])
    expect(m.currentTime).toBeCloseTo(3, 9)
    // The viewing rate or a sound setting changes meanwhile: nothing moves.
    sound.setView(2)
    sound.setView(1)
    sound.setProject({ ...p, audio: { ...p.audio, music: { ...p.audio.music!, volume: 0.5 } } })
    expect(m.seeks).toEqual([])
    // Paused there: the soundtrack's 5 s fade-in stays where the hold is, 3 s in (past the hold it is over).
    sound.pause()
    expect(master.gain.value).toBeCloseTo(gainAt(fadeKeyframes(63, 5, 0), 3), 9)
    expect(master.gain.value).toBeLessThan(0.9)
    // Playing on in the hold starts the music where the hold is.
    sound.play(screen.currentTime, 1)
    expect(m.currentTime).toBeCloseTo(3, 9)
    // The hold runs out: the music goes on from its end, and is not pulled back while the screen
    // plays on from the middle of the frame (counted past the hold from there).
    m.advance(2)
    sound.hold(h, 3)
    sound.jump(h.at, 1)
    m.seeks.length = 0
    for (let i = 0; i < 30; i++) {
      screen.currentTime += 1 / 60
      m.advance(1 / 60)
      // The player's playhead moves past the frame: the hold just left is let go.
      if (i === 1) sound.hold(null, 0)
      sound.frame()
    }
    expect(m.seeks).toEqual([])
    expect(m.currentTime).toBeCloseTo(5.5, 9)
  })
})

describe('the player and its music through a pause freeze', () => {
  function setUp() {
    const screen = new FakeVideo()
    const p = project()
    const player = new PreviewPlayer(screen, null, p)
    disposers.push(() => player.dispose())
    screen.land()
    player.attachCanvas({ width: 640, height: 360, getContext: () => ({}) })
    player.setScene({ project: p, cursor: { samples: [], clicks: [], valid: false } }, null)
    frame()
    const m = music()
    /** The Transport's position: video time of the playhead, plus the time held. */
    const position = (): number => videoTimeAt(p.clips, planOf(p), player.time) + player.holdElapsed
    /** Plays on by `dt` seconds of the screen's and the music's own time and runs that frame. */
    const playOn = (dt: number): void => {
      screen.advance(dt)
      m.advance(dt)
      frame()
    }
    /** `ms` of wall clock pass in a hold (the music plays on). */
    const wait = (ms: number): void => {
      clock += ms
      m.advance(ms / 1000)
      frame()
    }
    /** The music is on the video clock. */
    const inTime = (): void => expect(Math.abs(m.currentTime - position())).toBeLessThan(MUSIC_SEEK)
    return { screen, player, m, position, playOn, wait, inTime }
  }

  it('plays on through a hold entered on a frame whose clock is past the anchor', () => {
    const { player, m, playOn, wait, inTime } = setUp()
    player.play()
    expect(m.currentTime).toBe(0)
    m.seeks.length = 0
    playOn(1.9)
    // The next frame is called back with the screen's clock just past the freeze's anchor.
    playOn(0.105)
    expect(player.heldFreeze).toBe('f')
    inTime()
    wait(1000)
    expect(player.holdElapsed).toBeCloseTo(1, 9)
    inTime()
    wait(1000)
    inTime()
    // It runs out: playback goes on from the frame, the music from the hold's end.
    wait(1000)
    expect(player.heldFreeze).toBeNull()
    inTime()
    for (let i = 0; i < 30; i++) playOn(1 / 60)
    inTime()
    expect(m.seeks).toEqual([])
  })

  it('starts the hold on the playhead (a seek into it), and resumes it after a pause where it was', () => {
    const { screen, player, m, playOn, wait, inTime } = setUp()
    player.seek(2)
    screen.land()
    frame()
    player.play()
    expect(m.currentTime).toBe(2)
    m.seeks.length = 0
    playOn(0.005)
    expect(player.heldFreeze).toBe('f')
    wait(1000)
    inTime()
    expect(m.seeks).toEqual([])
    player.pause()
    clock += 5000
    frame()
    player.play()
    expect(m.currentTime).toBeCloseTo(3, 9)
    inTime()
    m.seeks.length = 0
    wait(1000)
    wait(1000)
    expect(player.heldFreeze).toBeNull()
    for (let i = 0; i < 30; i++) playOn(1 / 60)
    inTime()
    expect(m.seeks).toEqual([])
  })

  it('a seek out of a hold moves the music to the new place, one back into it to the hold', () => {
    const { screen, player, m, playOn, wait, inTime } = setUp()
    player.play()
    playOn(2)
    expect(player.heldFreeze).toBe('f')
    wait(1000)
    inTime()
    player.seek(10)
    expect(player.heldFreeze).toBeNull()
    expect(m.currentTime).toBeCloseTo(13, 9)
    screen.land()
    playOn(0.5)
    inTime()
    // Back to the freeze's frame while playing: held again from its start.
    player.seek(2)
    expect(m.currentTime).toBeCloseTo(2, 9)
    screen.land()
    m.seeks.length = 0
    playOn(0.005)
    expect(player.heldFreeze).toBe('f')
    wait(1500)
    expect(player.holdElapsed).toBeCloseTo(1.5, 9)
    inTime()
    expect(m.seeks).toEqual([])
  })
})
