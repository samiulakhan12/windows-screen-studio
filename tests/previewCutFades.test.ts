import { afterEach, describe, expect, it, vi } from 'vitest'
import { createProject } from '../src/shared/engine/project'
import { planOf, type Hold } from '../src/shared/engine/freeze'
import { fadesInAfterHold, recordingGraph } from '../src/shared/render/audioPlan'
import { CUT_FADE, JUMP_SLACK } from '../src/shared/render/cutFades'
import type { Clip, Freeze, Project } from '../src/shared/types'

/*
 * Smooth cuts in the preview (editor/previewAudio.ts, NW-06, docs/design/edit-by-text.md §4.9): the
 * gain node at the cuts, driven the way the player drives it (a frame callback per frame on the
 * recording's frame grid, the jump at the callback whose next frame would reach the clip's end). The
 * audio graph and the video element are stand-ins that record what is scheduled.
 */

vi.mock('../src/renderer/src/editor/media', async (original) => ({
  ...(await original<object>()),
  createAudio: () => ({
    paused: true,
    playbackRate: 1,
    currentTime: 0,
    play: () => Promise.resolve(),
    pause: () => undefined,
    addEventListener: () => undefined,
    removeAttribute: () => undefined,
    load: () => undefined
  })
}))
vi.mock('../src/renderer/src/editor/audioAnalysis', () => ({
  loadAudioAnalysis: async () => ({})
}))
vi.stubGlobal('window', { api: { stopAnalysis: async () => undefined } })

type Op = ['cancel' | 'set' | 'ramp', number, number]

/** An AudioParam that records what is scheduled on it: [what, value, audio-clock time]. */
class FakeParam {
  value = 1
  readonly ops: Op[] = []
  cancelScheduledValues(t: number): void {
    this.ops.push(['cancel', 0, t])
  }
  setValueAtTime(v: number, t: number): void {
    this.value = v
    this.ops.push(['set', v, t])
  }
  linearRampToValueAtTime(v: number, t: number): void {
    this.ops.push(['ramp', v, t])
  }
}
class FakeNode {
  gain = new FakeParam()
  curve: unknown = null
  to: FakeNode | null = null
  constructor(readonly source = false) {}
  connect(n: FakeNode): FakeNode {
    this.to = n
    return n
  }
  disconnect(): void {}
}
class FakeAudioContext {
  static last: FakeAudioContext
  currentTime = 0
  /** One render buffer at 44.1 kHz, as Chromium reports for latencyHint 'playback'. */
  baseLatency = 0.0232
  destination = new FakeNode()
  readonly nodes: FakeNode[] = []
  constructor() {
    FakeAudioContext.last = this
  }
  private node(source = false): FakeNode {
    const n = new FakeNode(source)
    this.nodes.push(n)
    return n
  }
  createGain = (): FakeNode => this.node()
  createWaveShaper = (): FakeNode => this.node()
  createMediaElementSource = (): FakeNode => this.node(true)
  resume = (): Promise<void> => Promise.resolve()
  suspend = (): Promise<void> => Promise.resolve()
  close = (): Promise<void> => Promise.resolve()
}
vi.stubGlobal('AudioContext', FakeAudioContext)

// Renderer code (DOM types): imported at run time so the Node typecheck of tests/ does not follow it.
const AUDIO = '../src/renderer/src/editor/previewAudio'
type Sound = {
  play(t: number, speed: number): void
  jump(t: number, speed: number): void
  hold(h: Hold | null, elapsed: number): void
  frame(frameTime?: number): void
  dispose(): void
}
const { PreviewAudio } = (await import(/* @vite-ignore */ AUDIO)) as {
  PreviewAudio: new (s: unknown, p: Project) => Sound
}

function project(clips: Clip[], freezes: Freeze[] = [], fps = 60): Project {
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
    capture: { method: 'native', cursorInVideo: false, region: null, fps }
  })
  p.clips = clips
  p.freezes = freezes
  return p
}

const disposers: (() => void)[] = []
afterEach(() => {
  for (const d of disposers.splice(0)) d()
})

function setUp(p: Project) {
  const screen = { currentTime: 0, muted: false, volume: 1, playbackRate: 1 }
  const sound = new PreviewAudio(screen, p)
  disposers.push(() => sound.dispose())
  const ctx = FakeAudioContext.last
  // The recording's chain: element → screen gain → recording gain → cut gain.
  const cut = ctx.nodes.find((n) => n.source)!.to!.to!.to!
  return { screen, sound, ctx, cut }
}

describe('the fade out before a cut in the preview', () => {
  /** A 60 or 30 fps recording, clip ends on and off the frame grid, the element clock half a frame ahead of or behind the frame shown. */
  const cases = [60, 30].flatMap((fps) => [2.001, 2.005, 2.009, 2.013, 2.021, 2.029].flatMap((end) => [0.5, -0.5].map((skew) => ({ fps, end, skew: skew / fps }))))

  it('ends one render buffer before the jump (rendered before the seek), placed by the frame shown, whatever the element clock says', () => {
    for (const { fps, end, skew } of cases) {
      const what = `${fps} fps, end ${end}, skew ${skew}`
      const frame = 1 / fps
      const { screen, sound, ctx, cut } = setUp(project([{ id: 'a', start: 0, end, speed: 1 }, { id: 'b', start: 3, end: 10, speed: 1 }], [], fps))
      sound.play(0, 1)
      let jumpAt = -1
      for (let k = fps; k < 4 * fps && jumpAt < 0; k++) {
        // Rate 1: the audio clock runs with the frames; the element's clock is off the frame shown.
        const t = k * frame
        ctx.currentTime = t
        screen.currentTime = t + skew
        sound.frame(t)
        // The player's rule: jump when the next frame would reach the clip's end.
        if (t + frame >= end - JUMP_SLACK) {
          jumpAt = ctx.currentTime
          const before = cut.gain.ops.length
          screen.currentTime = 3
          sound.jump(3, 1)
          expect(cut.gain.ops.slice(before)).toContainEqual(['set', 0, jumpAt])
        }
      }
      const ramps = cut.gain.ops.filter(([op, v]) => op === 'ramp' && v === 0)
      expect(ramps, what).toHaveLength(1)
      expect(ramps[0][2], what).toBeCloseTo(jumpAt - ctx.baseLatency, 9)
      // The whole fade, from full sound.
      const from = cut.gain.ops.filter(([op, v]) => op === 'set' && v === 1).at(-1)!
      expect(ramps[0][2] - from[2], what).toBeCloseTo(CUT_FADE, 9)
    }
  })

  it('keeps the whole fade, never a step, when playing starts closer to the cut than the fade and a buffer', () => {
    // 60 fps, the clip ends at 2 s: the player jumps at the frame at 119/60 s. Play starts 1 to 3 frames before it.
    for (const k0 of [116, 117, 118]) {
      const { screen, sound, ctx, cut } = setUp(project([{ id: 'a', start: 0, end: 2, speed: 1 }, { id: 'b', start: 3, end: 10, speed: 1 }]))
      sound.play(k0 / 60, 1)
      let jumpAt = -1
      for (let k = k0; jumpAt < 0; k++) {
        const t = k / 60
        ctx.currentTime = t
        screen.currentTime = t
        sound.frame(t)
        if (t + 1 / 60 >= 2 - JUMP_SLACK) {
          jumpAt = t
          sound.jump(3, 1)
        }
      }
      const ramps = cut.gain.ops.filter(([op, v]) => op === 'ramp' && v === 0)
      expect(ramps, `from frame ${k0}`).toHaveLength(1)
      expect(ramps[0][2], `from frame ${k0}`).toBeLessThanOrEqual(jumpAt + 1e-9)
      const from = cut.gain.ops.filter(([op, v]) => op === 'set' && v === 1).at(-1)!
      expect(ramps[0][2] - from[2], `from frame ${k0}`).toBeCloseTo(CUT_FADE, 9)
    }
  })
})

describe('leaving a pause freeze', () => {
  const pause = (at: number): Freeze => ({ id: 'f', at, length: 1, sound: 'pause' })

  /** Plays over the cut into the freeze's frame, holds it, leaves it and plays one frame on: what the cut gain gets from leaving the hold on. */
  function leave(clips: Clip[], at: number, jumpFrom: number | null) {
    const p = project(clips, [pause(at)])
    const h = planOf(p).holds[0]
    const { screen, sound, ctx, cut } = setUp(p)
    sound.play(jumpFrom ?? at - 1, 1)
    if (jumpFrom !== null) {
      // The jump over the cut lands on the freeze's frame.
      ctx.currentTime = 1
      screen.currentTime = h.at
      sound.jump(h.at, 1)
    }
    // The hold, a tick of it (the screen waits), then its end.
    sound.hold(h, 0)
    ctx.currentTime = 1.02
    sound.frame()
    sound.hold(h, h.length)
    ctx.currentTime = 2
    const from = cut.gain.ops.length
    sound.jump(h.at, 1)
    ctx.currentTime = 2.017
    screen.currentTime = h.at + 1 / 60
    sound.frame(h.at + 1 / 60)
    return cut.gain.ops.slice(from)
  }

  it('fades the sound in after a freeze on the first frame after a cut, as the export does', () => {
    // The clip after the cut starts on the anchor, or less than a ms before it (anchors are whole ms).
    for (const start of [8, 7.9995]) {
      const clips = [
        { id: 'a', start: 0, end: 5, speed: 1 },
        { id: 'b', start, end: 60, speed: 1 }
      ]
      expect(fadesInAfterHold(clips, 8)).toBe(true)
      expect(recordingGraph({ clips, volume: 1, input: '1:a', cutFade: CUT_FADE, holds: [{ at: 8, length: 1 }] }, 60)).toContain('afade=t=in:st=1:')
      const ops = leave(clips, 8, 4.98)
      expect(ops).toContainEqual(['set', 0, 2])
      expect(ops).not.toContainEqual(['set', 1, 2])
      expect(ops.at(-1)).toEqual(['ramp', 1, 2.017 + CUT_FADE])
    }
  })

  it('joins the sound straight on after a freeze inside a clip, after a split or on the edit\'s first frame', () => {
    const cases: { clips: Clip[]; at: number }[] = [
      { clips: [{ id: 'a', start: 0, end: 5, speed: 1 }, { id: 'b', start: 8, end: 60, speed: 1 }], at: 10 },
      { clips: [{ id: 'a', start: 0, end: 8, speed: 2 }, { id: 'b', start: 8, end: 30, speed: 1 }, { id: 'c', start: 40, end: 60, speed: 1 }], at: 8 },
      { clips: [{ id: 'a', start: 2, end: 5, speed: 1 }, { id: 'b', start: 8, end: 60, speed: 1 }], at: 2 }
    ]
    for (const { clips, at } of cases) {
      expect(fadesInAfterHold(clips, at)).toBe(false)
      const ops = leave(clips, at, null)
      expect(ops).toContainEqual(['set', 1, 2])
      expect(ops.some(([op]) => op === 'ramp')).toBe(false)
    }
  })
})
