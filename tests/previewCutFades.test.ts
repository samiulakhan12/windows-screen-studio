import { afterEach, describe, expect, it, vi } from 'vitest'
import { createProject } from '../src/shared/engine/project'
import type { Hold } from '../src/shared/engine/freeze'
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

  it('ends two render buffers before the jump (rendered before the seek), placed by the frame shown, whatever the element clock says', () => {
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
      expect(ramps[0][2], what).toBeCloseTo(jumpAt - 2 * ctx.baseLatency, 9)
      // The whole fade, from full sound.
      const from = cut.gain.ops.filter(([op, v]) => op === 'set' && v === 1).at(-1)!
      expect(ramps[0][2] - from[2], what).toBeCloseTo(CUT_FADE, 9)
    }
  })
})
