import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'
import { createProject } from '../src/shared/engine/project'
import { planOf, videoTimeAt } from '../src/shared/engine/freeze'
import type { ShuttleKey, ShuttleStep } from '../src/shared/editor/shuttle'
import type { Clip, Freeze, Project } from '../src/shared/types'

/*
 * Freeze frames in the preview (editor/player.ts, E-11): a pause freeze holds its frame for its
 * length of wall clock (at the viewing rate) with the elements paused, then playback goes on from
 * the frame; pausing, seeking and reverse playback during a hold; a continue freeze's still. The
 * videos, the soundtrack, the compositor, the stills, the clock and the animation frames are
 * stand-ins that record what happens (as in previewShuttle.test.ts).
 */

interface Draw {
  t: number
  blur: number | undefined
  sound: number | undefined
  still: boolean
}
const draws: Draw[] = []
/** What the player asked of its soundtrack, in order. */
const sound: string[] = []

vi.mock('../src/renderer/src/render/compositor', () => ({
  drawFrame: (_ctx: unknown, _w: number, _h: number, t: number, _scene: unknown, src: { screenFrame?: unknown }, options?: { blurSamples?: number }, soundTime?: number) =>
    void draws.push({ t, blur: options?.blurSamples, sound: soundTime, still: !!src.screenFrame })
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
    jump(t: number, rate: number) {
      sound.push(`jump ${t} ${rate}`)
    }
    setRate() {}
    setView() {}
    setSilent() {}
    hold(h: { id: string } | null, elapsed: number) {
      sound.push(h ? `hold ${h.id} ${+elapsed.toFixed(3)}` : 'hold none')
    }
    frame() {}
    fadeAt() {
      return 1
    }
    reloadMusic() {}
    dispose() {}
  }
}))
vi.mock('../src/renderer/src/editor/freezeStills', () => ({
  FreezeStills: class {
    get() {
      return { width: 1280, height: 720 }
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
vi.stubGlobal('VideoFrame', class {
  displayWidth = 1280
  displayHeight = 720
  close(): void {}
})
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
const PLAYER = '../src/renderer/src/editor/player'
type Player = {
  time: number
  playing: boolean
  readonly holdElapsed: number
  readonly heldFreeze: string | null
  readonly reversing: boolean
  seek(t: number): void
  play(): void
  pause(): void
  shuttle(key: ShuttleKey, pauseHeld?: boolean): ShuttleStep
  setPreviewSpeed(speed: number): void
  setProject(p: Project): void
  attachCanvas(c: unknown): void
  setScene(scene: unknown, bg: unknown): void
  dispose(): void
}
const { PreviewPlayer } = (await import(/* @vite-ignore */ PLAYER)) as { PreviewPlayer: new (s: FakeVideo, w: FakeVideo | null, p: Project) => Player }

const freeze = (id: string, at: number, length = 3, sound: Freeze['sound'] = 'pause'): Freeze => ({ id, at, length, sound })

function project(freezes: Freeze[], clips: Clip[] = [{ id: 'c', start: 0, end: 60, speed: 1 }]): Project {
  const p = createProject({
    id: 'p',
    name: 'p',
    duration: 60,
    width: 1920,
    height: 1080,
    hasWebcam: true,
    hasAudio: true,
    webcamOffset: 0,
    zooms: [],
    cursorValid: false,
    capture: { method: 'native', cursorInVideo: false, region: null, fps: 60 }
  })
  p.webcam = { ...p.webcam, show: true }
  p.clips = clips
  p.freezes = freezes
  return p
}

const players: Player[] = []
function setUp(freezes: Freeze[], clips?: Clip[]) {
  const screen = new FakeVideo()
  const camera = new FakeVideo()
  const p = project(freezes, clips)
  const player = new PreviewPlayer(screen, camera, p)
  players.push(player)
  screen.land()
  camera.land()
  player.attachCanvas({ width: 640, height: 360, getContext: () => ({}) })
  player.setScene({ project: p, cursor: { samples: [], clicks: [], valid: false } }, null)
  frame()
  draws.length = 0
  sound.length = 0
  /** The Transport's position: video time of the playhead, plus the time held. */
  const position = (): number => videoTimeAt(p.clips, planOf(p), player.time) + player.holdElapsed
  return { screen, camera, player, project: p, position }
}

/** Plays on by `dt` seconds of the screen's own time and runs that frame. */
function playOn(screen: FakeVideo, dt: number): void {
  screen.advance(dt)
  frame()
}

beforeEach(() => {
  draws.length = 0
  sound.length = 0
  raf = []
  clock = 1000
  vi.spyOn(performance, 'now').mockImplementation(() => clock)
})

afterEach(() => {
  players.at(-1)?.setPreviewSpeed(1)
  for (const p of players.splice(0)) p.dispose()
  vi.restoreAllMocks()
})

describe('a pause freeze in the preview', () => {
  it('holds its frame for its length with the elements paused, then plays on from the frame', () => {
    const { screen, camera, player, position } = setUp([freeze('f', 2)])
    player.play()
    playOn(screen, 1.9)
    expect(player.heldFreeze).toBeNull()
    sound.length = 0
    // The frame of the freeze: held there.
    playOn(screen, 0.1)
    expect(player.heldFreeze).toBe('f')
    expect(player.playing).toBe(true)
    expect(screen.paused && camera.paused).toBe(true)
    expect(player.time).toBe(2)
    expect(sound).toEqual(['hold f 0'])
    // Drawn on its frame, sharp, once the camera's forced seek to it lands.
    camera.land()
    draws.length = 0
    clock += 1000
    frame()
    expect(draws.at(-1)).toMatchObject({ t: 2, blur: 1, sound: 2 })
    expect(player.holdElapsed).toBeCloseTo(1, 9)
    expect(position()).toBeCloseTo(3, 9)
    expect(sound.at(-1)).toBe('hold f 1')
    // The wall clock runs out: the stems start again from the frame, the video plays on.
    clock += 2100
    frame()
    expect(player.heldFreeze).toBeNull()
    expect(screen.paused).toBe(false)
    expect(sound.slice(-2)).toEqual(['hold f 3', 'jump 2 1'])
    expect(position()).toBe(5)
    // The next frame is the held one again: not held twice. Past it, video time counts the hold.
    frame()
    expect(player.heldFreeze).toBeNull()
    playOn(screen, 1 / 60)
    expect(player.holdElapsed).toBe(0)
    expect(sound.at(-1)).toBe('hold none')
    expect(position()).toBeCloseTo(5 + 1 / 60, 9)
  })

  it('lasts length / |viewing rate| of wall clock at a faster preview speed', () => {
    const { screen, player } = setUp([freeze('f', 1, 2)])
    player.setPreviewSpeed(2)
    player.play()
    playOn(screen, 1)
    expect(player.heldFreeze).toBe('f')
    clock += 600
    frame()
    expect(player.holdElapsed).toBeCloseTo(1.2, 9)
    clock += 500
    frame()
    expect(player.heldFreeze).toBeNull()
  })

  it('pausing keeps the playhead on the frame and the time held; playing goes on with the hold', () => {
    const { screen, player, position } = setUp([freeze('f', 2)])
    player.play()
    playOn(screen, 2)
    clock += 1000
    frame()
    screen.advance(0.0004)
    player.pause()
    expect(player.playing).toBe(false)
    expect(player.time).toBe(2)
    expect(player.heldFreeze).toBe('f')
    expect(position()).toBeCloseTo(3, 9)
    // Paused for a while: the hold does not move on.
    clock += 5000
    frame()
    expect(player.holdElapsed).toBeCloseTo(1, 9)
    sound.length = 0
    player.play()
    expect(sound).toEqual(['play 1', 'hold f 1'])
    expect(screen.paused).toBe(true)
    clock += 2000
    frame()
    expect(player.heldFreeze).toBeNull()
    expect(screen.paused).toBe(false)
  })

  it('a seek leaves the hold and plays on from the new place; reverse playback skips holds', () => {
    const { screen, player } = setUp([freeze('f', 2)])
    player.play()
    playOn(screen, 2)
    expect(player.heldFreeze).toBe('f')
    player.seek(10)
    expect(player.heldFreeze).toBeNull()
    expect(player.holdElapsed).toBe(0)
    expect(sound).toContain('hold none')
    expect(screen.paused).toBe(false)
    expect(player.playing).toBe(true)
    // Back into it, then J: reverse leaves it.
    player.seek(1.99)
    screen.land()
    frame()
    playOn(screen, 0.01)
    expect(player.heldFreeze).toBe('f')
    player.shuttle('reverse')
    expect(player.reversing).toBe(true)
    expect(player.heldFreeze).toBeNull()
    expect(player.holdElapsed).toBe(0)
  })

  it('a freeze at the edit end holds the last frame, then playback ends there', () => {
    const { screen, player, position } = setUp([freeze('e', 10, 1)], [{ id: 'c', start: 0, end: 10, speed: 1 }])
    player.play()
    playOn(screen, 9.99)
    expect(player.heldFreeze).toBe('e')
    expect(player.time).toBeLessThan(10)
    clock += 500
    frame()
    expect(position()).toBeCloseTo(10.5, 2)
    clock += 600
    frame()
    expect(player.playing).toBe(false)
    expect(player.heldFreeze).toBeNull()
    expect(player.time).toBe(10)
    expect(position()).toBe(11)
  })

  it('a freeze at a trimmed edit end, read back from project.json in whole ms, holds the same last frame', () => {
    // The edit ends at 9.9994 (a trim leaves the pointer's time); the anchor stored there loads as 9.999.
    const { screen, camera, player } = setUp([freeze('e', 9.999, 1)], [{ id: 'c', start: 0, end: 9.9994, speed: 1 }])
    player.play()
    playOn(screen, 9.99)
    expect(player.heldFreeze).toBe('e')
    // The last frame, as the paused end shows it (frameTimeFor(last.end)), not the frame under the anchor.
    const last = 9.9994 - 1 / 240
    expect(player.time).toBeCloseTo(last, 9)
    expect(screen.currentTime).toBeCloseTo(last, 9)
    screen.land()
    camera.land()
    frame()
    expect(draws.at(-1)).toMatchObject({ t: player.time, blur: 1 })
    clock += 1100
    frame()
    expect(player.playing).toBe(false)
    expect(player.heldFreeze).toBeNull()
  })

  it('starts the playback when the playhead is on its frame', () => {
    const { screen, player } = setUp([freeze('f', 2)])
    player.seek(2)
    screen.land()
    frame()
    player.play()
    frame()
    expect(player.heldFreeze).toBe('f')
  })
})

describe('a continue freeze in the preview', () => {
  it('draws its still over its span, sharp, while the sound and the clock go on', () => {
    const { screen, player } = setUp([freeze('k', 2, 1.5, 'continue')])
    player.play()
    playOn(screen, 2.5)
    expect(draws.at(-1)).toEqual({ t: 2, blur: 1, sound: 2.5, still: true })
    expect(player.heldFreeze).toBeNull()
    expect(screen.paused).toBe(false)
    playOn(screen, 1.1)
    expect(draws.at(-1)).toMatchObject({ t: 3.6, still: false, sound: 3.6 })
  })
})

describe('without freezes', () => {
  it('draws every frame as before: at its own time, the default motion blur, no still', () => {
    const { screen, player } = setUp([])
    player.play()
    playOn(screen, 1)
    expect(draws.at(-1)).toEqual({ t: 1, blur: undefined, sound: 1, still: false })
    expect(sound.filter((s) => s.startsWith('hold'))).toEqual([])
  })
})
