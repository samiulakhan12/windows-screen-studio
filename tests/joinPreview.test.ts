import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'
import { createProject } from '../src/shared/engine/project'
import { joinPlan, stillFrame, trackTimes, type JoinWindow } from '../src/shared/render/joins'
import type { Clip, Freeze, Project } from '../src/shared/types'

/*
 * Smooth cuts in the preview (docs/design/editing-polish.md §5.7; §19.1 test 24): the player's video
 * time through a hold, the stills of the next three cuts asked for at play, a paused frame that
 * draws a hard cut until A* is ready and redraws then, a playing window that stays hard when its
 * A* comes late; and JoinStills, which picks each still with the export's rule and composes A* in a
 * task of its own once the stills (and the camera still's mask) are there. The videos, the
 * soundtrack, the compositor, the seek path and the clock are stand-ins (as in previewFreeze.test.ts).
 */

interface Draw {
  t: number
  video: number | undefined
  join: { window: JoinWindow; p: number; still: unknown } | null | undefined
}
const draws: Draw[] = []

vi.mock('../src/renderer/src/render/compositor', () => ({
  drawFrame: (_c: unknown, _w: number, _h: number, t: number, _s: unknown, _src: unknown, _o: unknown, _sound: unknown, extras?: { video?: number; join?: { at: { window: JoinWindow; p: number }; still: unknown } | null }) =>
    void draws.push({ t, video: extras?.video, join: extras?.join ? { window: extras.join.at.window, p: extras.join.at.p, still: extras.join.still } : (extras?.join as null | undefined) })
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
  heldLivePicture: () => null,
  CameraMaskPreparer: class {
    start() {
      return Promise.resolve(true)
    }
    prepare() {
      return Promise.resolve()
    }
  }
}))

/* ---------- the seek path and the tracks' indexes (JoinStills' inputs) ---------- */

/** Every still the seek path was asked for: its video and time. */
const asked: { url: string; at: number }[] = []
/** Stills made: ready once `deliver` runs. */
const made = new Map<string, { width: number; height: number; at: number; url: string }>()
let deliverers: (() => void)[] = []
vi.mock('../src/renderer/src/editor/freezeStills', () => ({
  FreezeStills: class {
    constructor(
      private readonly url: string,
      readonly fps: number,
      private readonly onReady?: () => void
    ) {}
    get(at: number) {
      const key = `${this.url}|${Math.round(at * 1000)}`
      const still = made.get(key)
      if (still) return still
      if (!asked.some((a) => a.url === this.url && a.at === at)) {
        asked.push({ url: this.url, at })
        deliverers.push(() => {
          made.set(key, { width: 1280, height: 720, at, url: this.url })
          this.onReady?.()
        })
      }
      return null
    }
    prepare() {}
    dispose() {}
  }
}))
/** Both proxies at 30 fps (decode order = presentation order). */
const SAMPLES = Array.from({ length: 1800 }, (_, k) => ({ offset: k, size: 1, time: k / 30, duration: 1 / 30, key: k % 30 === 0 }))
vi.mock('../src/renderer/src/render/frameSource', () => ({
  openTrack: async () => ({ track: { samples: SAMPLES } })
}))
const composed: { window: JoinWindow; screen: unknown; camera: unknown; inCallback: boolean }[] = []
let inCallback = false
vi.mock('../src/renderer/src/render/joinLayer', () => ({
  scratchTarget: () => ({}),
  releaseScratch: () => undefined,
  composeJoinStill: (_s: unknown, out: { tag?: string }, _w: number, _h: number, window: JoinWindow, _scene: unknown, stills: { screen: { image: unknown }; camera: { image: unknown } | null }) => {
    out.tag = `A* ${window.clip}`
    composed.push({ window, screen: stills.screen.image, camera: stills.camera?.image ?? null, inCallback })
  }
}))

/** A <video>: assigning currentTime starts a seek; `land` ends it; `advance` plays on. */
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
  constructor(readonly currentSrc: string) {
    super()
  }
  src = ''
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
vi.stubGlobal('document', { createElement: () => ({ width: 0, height: 0 }) })
vi.stubGlobal('Path2D', class {})

let clock = 0

/** Runs the animation frames (the frame callbacks too) asked for so far, as the frame callback does. */
function frame(): void {
  const due = raf
  raf = []
  inCallback = true
  try {
    for (const cb of due) cb()
  } finally {
    inCallback = false
  }
}

/** Lets the tasks queued so far run (the tracks' indexes, the compose task). */
const tasks = async (): Promise<void> => {
  for (let i = 0; i < 5; i++) await new Promise((r) => setTimeout(r, 0))
}

/** The stills asked for so far arrive. */
function deliver(): void {
  const due = deliverers
  deliverers = []
  for (const d of due) d()
}

// Renderer code (DOM types): imported at run time so the Node typecheck of tests/ does not follow it.
const PLAYER = '../src/renderer/src/editor/player'
const STILLS = '../src/renderer/src/editor/joinStills'
type Player = {
  time: number
  playing: boolean
  seek(t: number): void
  play(): void
  pause(): void
  toggle(): void
  shuttle(key: 'reverse' | 'pause' | 'forward'): unknown
  readonly moving: boolean
  playCut(video: number): void
  attachCanvas(c: unknown): void
  setScene(scene: unknown, bg: unknown): void
  dispose(): void
}
const { PreviewPlayer } = (await import(/* @vite-ignore */ PLAYER)) as { PreviewPlayer: new (s: FakeVideo, w: FakeVideo | null, p: Project) => Player }
const { JoinStills } = (await import(/* @vite-ignore */ STILLS)) as {
  JoinStills: new (
    screenUrl: string,
    webcamUrl: string | null,
    onReady: () => void,
    segment?: (still: unknown) => Promise<void>
  ) => {
    prepare(windows: readonly JoinWindow[], scene: unknown, w: number, h: number): void
    still(window: JoinWindow, w: number, h: number): unknown
    dispose(): void
  }
}

/** Clips of 2 s with 1 s cuts between them (cut k at edit 2k), every cut a crossfade. */
function project(over: Partial<Project> = {}): Project {
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
    capture: { method: 'native', cursorInVideo: false, region: null, fps: 30 }
  })
  const clips: Clip[] = Array.from({ length: 6 }, (_, i) => ({ id: `c${i}`, start: i * 3, end: i * 3 + 2, speed: 1 }))
  return { ...p, clips, joins: { all: { kind: 'crossfade', duration: 0.5 } }, ...over }
}

const players: Player[] = []
function setUp(p: Project) {
  const screen = new FakeVideo('studio-media://p/screen.mp4')
  const player = new PreviewPlayer(screen, null, p)
  players.push(player)
  screen.land()
  player.attachCanvas({ width: 640, height: 360, getContext: () => ({}) })
  player.setScene({ project: p, cursor: { samples: [], clicks: [], valid: false } }, null)
  frame()
  draws.length = 0
  return { screen, player }
}

beforeEach(() => {
  draws.length = 0
  asked.length = 0
  made.clear()
  deliverers = []
  composed.length = 0
  raf = []
  clock = 1000
  vi.spyOn(performance, 'now').mockImplementation(() => clock)
})

afterEach(() => {
  for (const p of players.splice(0)) p.dispose()
  vi.restoreAllMocks()
})

const track = trackTimes(SAMPLES, 30, 60)
/** The still time the seek path is asked for, for an instant: a quarter frame into k*. */
const askedFor = (instant: number): number => track.starts[stillFrame(track, instant, false, -Infinity).index] + track.half / 2

describe('the preview player (test 24)', () => {
  it('passes the video time of each frame, through a pause hold', () => {
    const freezes: Freeze[] = [{ id: 'h', at: 1, length: 2, sound: 'pause' }]
    const { screen, player } = setUp(project({ freezes }))
    player.play()
    screen.advance(0.5)
    frame()
    expect(draws.at(-1)!.video).toBeCloseTo(0.5, 9)
    // Into the hold at 1 s: video time runs on while the picture holds.
    screen.advance(0.5)
    frame()
    screen.land()
    frame()
    expect(draws.at(-1)!.t).toBe(1)
    expect(draws.at(-1)!.video).toBeCloseTo(1, 9)
    clock += 700
    frame()
    expect(draws.at(-1)!.video).toBeCloseTo(1, 9)
  })

  it('redraws a join over a held frame as video time runs through the hold', () => {
    // A pause freeze at B's start (source 3 s): the crossfade runs over the held frame.
    const freezes: Freeze[] = [{ id: 'h', at: 3, length: 2, sound: 'pause' }]
    const { screen, player } = setUp(project({ freezes }))
    player.seek(1.9)
    screen.land()
    frame()
    player.play()
    screen.advance(0.1)
    frame()
    screen.currentTime = 3
    screen.land()
    frame()
    screen.land()
    frame()
    const before = draws.length
    clock += 200
    frame()
    frame()
    expect(draws.length).toBeGreaterThan(before)
    expect(draws.at(-1)!.t).toBe(3)
    expect(draws.at(-1)!.video).toBeCloseTo(2.2, 6)
    expect(draws.at(-1)!.join?.p).toBeCloseTo(0.4, 6)
  })

  it('asks for the stills of the next three cuts at play, never composing inside a frame', async () => {
    const p = project()
    const { player } = setUp(p)
    player.play()
    await tasks()
    const windows = joinPlan(p)
    // A* instants of cuts 1–3 (A ends at 2, 5, 8 s).
    expect(asked.map((a) => a.at)).toEqual([2, 5, 8].map((u) => askedFor(u - 1e-6)))
    expect(asked.map((a) => a.at)).not.toContain(askedFor(11 - 1e-6))
    deliver()
    await tasks()
    expect(composed.map((c) => c.window)).toEqual(windows.slice(0, 3))
    expect(composed.every((c) => !c.inCallback)).toBe(true)
  })

  it('paused in a window, draws a hard cut until A* is ready, then redraws with it', async () => {
    const p = project()
    const { screen, player } = setUp(p)
    // 0.1 s into the first window (the cut at edit 2 s, source 3 s).
    player.seek(3.1)
    screen.land()
    frame()
    const first = draws.at(-1)!
    expect(first.join?.window).toBe(joinPlan(p)[0])
    expect(first.join?.still).toBeNull()
    await tasks()
    deliver()
    await tasks()
    draws.length = 0
    frame()
    expect((draws.at(-1)!.join?.still as { tag: string }).tag).toBe('A* c1')
    expect(draws.at(-1)!.join!.p).toBeCloseTo(0.2, 6)
  })

  it('playing, keeps a window whose A* came late a hard cut to its end, and shows it in the next window', async () => {
    const p = project()
    const { screen, player } = setUp(p)
    player.seek(2.9)
    screen.land()
    frame()
    player.play()
    // The jump over the first cut lands on its first frame before any still is ready.
    screen.advance(0.15)
    frame()
    screen.currentTime = 3
    screen.land()
    frame()
    expect(draws.at(-1)!.join?.window.clip).toBe('c1')
    expect(draws.at(-1)!.join?.still).toBeNull()
    // The stills arrive mid-window: still a hard cut.
    await tasks()
    deliver()
    await tasks()
    screen.advance(0.1)
    frame()
    expect(draws.at(-1)!.join?.window.clip).toBe('c1')
    expect(draws.at(-1)!.join?.still).toBeNull()
    // The next window's A* was ready at its first frame: shown.
    screen.currentTime = 6
    screen.land()
    frame()
    expect(draws.at(-1)!.join?.window.clip).toBe('c2')
    expect((draws.at(-1)!.join?.still as { tag: string }).tag).toBe('A* c2')
  })

  it('plays a cut from 1 s before to 1 s after it, then goes back', () => {
    const { screen, player } = setUp(project())
    player.seek(10)
    screen.land()
    player.playCut(4)
    expect(player.playing).toBe(true)
    // 1 s of video before the cut at 4 s: source 4 s (clip c1 runs 3–5 s at edit 2–4 s).
    expect(player.time).toBeCloseTo(4, 9)
    screen.currentTime = 7.05
    screen.land()
    frame()
    expect(player.playing).toBe(false)
    expect(player.time).toBe(10)
  })

  it('forgets Play this cut once J leaves it: a later playback goes on past the cut', () => {
    for (const after of [['pause', 'toggle'], ['forward']] as const) {
      const { screen, player } = setUp(project())
      player.seek(10)
      screen.land()
      player.playCut(4)
      screen.advance(0.3)
      frame()
      // J, then K and Space, or L: playing forward again from where the playhead is.
      player.shuttle('reverse')
      for (const key of after) {
        if (key === 'toggle') player.toggle()
        else player.shuttle(key)
      }
      expect(player.playing).toBe(true)
      screen.currentTime = 7.05
      screen.land()
      frame()
      expect(player.playing).toBe(true)
      expect(player.time).toBeCloseTo(7.05, 9)
    }
  })

  it('goes back where the playhead was when the edit ends before 1 s after the cut', () => {
    // The last clip is 0.5 s long: its cut is at 10 s of video and the edit ends at 10.5 s.
    const clips: Clip[] = [...project().clips.slice(0, 5), { id: 'c5', start: 15, end: 15.5, speed: 1 }]
    const { screen, player } = setUp(project({ clips }))
    player.seek(3)
    screen.land()
    player.playCut(10)
    expect(player.playing).toBe(true)
    screen.currentTime = 15.49
    screen.land()
    frame()
    expect(player.playing).toBe(false)
    expect(player.time).toBe(3)
  })
})

describe('JoinStills', () => {
  const camera = { show: true, corner: 'bottom-right', size: 0.24, shape: 'circle' } as const
  // The camera's background blurred: its still needs a person mask before A* is composed.
  const p = project({ hasWebcam: true, webcam: { ...camera, backgroundBlur: 0.6 } })
  const scene = { project: p }

  it('asks for the frames that hold A\'s end with the export\'s rule, and composes A* in a task once they and the mask are ready', async () => {
    const ready = vi.fn()
    const segmented: unknown[] = []
    let release: () => void = () => undefined
    const stills = new JoinStills('screen.mp4', 'camera.mp4', ready, (still) => {
      segmented.push(still)
      return new Promise<void>((r) => (release = r))
    })
    const [w] = joinPlan(p)
    stills.prepare([w], scene, 640, 360)
    expect(stills.still(w, 640, 360)).toBeNull()
    await tasks()
    expect(asked).toEqual([
      { url: 'screen.mp4', at: askedFor(w.still!.screen) },
      { url: 'camera.mp4', at: askedFor(w.still!.camera!) }
    ])
    // Frame k* is the last one starting at or before A's end (2 s): frame 59.
    expect(Math.round(asked[0].at * 30 - 0.25)).toBe(59)
    deliver()
    await tasks()
    // The camera still is segmented first: nothing composed until its mask is ready.
    expect(segmented).toHaveLength(1)
    expect(composed).toEqual([])
    release()
    await tasks()
    expect(composed).toHaveLength(1)
    expect(composed[0].inCallback).toBe(false)
    expect(composed[0].camera).toBe(segmented[0])
    expect(ready).toHaveBeenCalledTimes(1)
    expect((stills.still(w, 640, 360) as { tag: string }).tag).toBe('A* c1')
    // Another size, or another project: made again.
    expect(stills.still(w, 320, 180)).toBeNull()
    stills.dispose()
  })

  it('segments a camera still kept from before the background was blurred, before A* is made again', async () => {
    const sharp = project({ hasWebcam: true, webcam: { ...camera } })
    let current = sharp
    const segmented: unknown[] = []
    let release: () => void = () => undefined
    // As the player's: no mask is made while the camera's background is not blurred.
    const stills = new JoinStills('screen.mp4', 'camera.mp4', () => undefined, async (still) => {
      if (!((current.webcam.backgroundBlur ?? 0) > 0)) return
      segmented.push(still)
      await new Promise<void>((r) => (release = r))
    })
    const [w] = joinPlan(sharp)
    stills.prepare([w], { project: sharp }, 640, 360)
    await tasks()
    deliver()
    await tasks()
    expect(segmented).toEqual([])
    expect(composed).toHaveLength(1)
    // The background blurred: the same camera still is segmented first.
    current = { ...sharp, webcam: { ...sharp.webcam, backgroundBlur: 0.6 } }
    stills.prepare([w], { project: current }, 640, 360)
    await tasks()
    expect(segmented).toEqual([composed[0].camera])
    expect(composed).toHaveLength(1)
    release()
    await tasks()
    expect(composed).toHaveLength(2)
    expect(composed[1].camera).toBe(segmented[0])
    stills.dispose()
  })
})
