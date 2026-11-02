import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'
import { LEVEL_WINDOW, normalizeGain, type AudioLevels } from '../src/shared/audio/loudness'
import { editLoudness, type AudioAnalysis } from '../src/shared/audio/soundtrack'
import { createProject } from '../src/shared/engine/project'
import type { Project, SoundSpan } from '../src/shared/types'

/*
 * The preview's sound with stretches muted or lowered by the unwanted-sound finder (F-17,
 * editor/previewAudio.ts): its loudness normalisation and the music's ducking follow a Mute, as
 * the export does (its loudnorm hears the muted sound; its music ducks only under what is heard).
 * The audio graph and the media elements are stand-ins; the levels come from a stand-in analysis.
 */

class FakeAudio {
  paused = true
  playbackRate = 1
  loop = false
  duration = NaN
  error = null
  currentTime = 0
  constructor(readonly url: string) {}
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

let analysis: AudioAnalysis = {}
vi.mock('../src/renderer/src/editor/media', async (original) => ({
  ...(await original<object>()),
  createAudio: (url: string) => new FakeAudio(url)
}))
vi.mock('../src/renderer/src/editor/audioAnalysis', () => ({ loadAudioAnalysis: async () => analysis }))

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
  constructor(readonly kind: string) {}
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
  private node(kind: string): FakeNode {
    const n = new FakeNode(kind)
    this.nodes.push(n)
    return n
  }
  createGain = (): FakeNode => this.node('gain')
  createWaveShaper = (): FakeNode => this.node('shaper')
  createMediaElementSource = (): FakeNode => this.node('source')
  resume = (): Promise<void> => Promise.resolve()
  suspend = (): Promise<void> => Promise.resolve()
  close = (): Promise<void> => Promise.resolve()
}
vi.stubGlobal('AudioContext', FakeAudioContext)

// Renderer code (DOM types): imported at run time so the Node typecheck of tests/ does not follow it.
const AUDIO = '../src/renderer/src/editor/previewAudio'
type Sound = { setProject(p: Project): void; dispose(): void }
const { PreviewAudio } = (await import(/* @vite-ignore */ AUDIO)) as { PreviewAudio: new (s: unknown, p: Project) => Sound }

/** An envelope from per-window dB levels; `run` is `seconds` of `db`. */
const levels = (db: number[]): AudioLevels => ({ window: LEVEL_WINDOW, power: Float32Array.from(db, (v) => 10 ** (v / 10)) })
const run = (db: number, seconds: number): number[] => new Array(Math.round(seconds / LEVEL_WINDOW)).fill(db)

function project(duration: number, audio: Partial<Project['audio']>): Project {
  const p = createProject({
    id: 'p',
    name: 'p',
    duration,
    width: 1920,
    height: 1080,
    hasWebcam: false,
    hasAudio: true,
    webcamOffset: 0,
    zooms: [],
    cursorValid: false,
    capture: { method: 'native', cursorInVideo: false, region: null, fps: 30 }
  })
  p.clips = [{ id: 'c', start: 0, end: duration, speed: 1 }]
  p.audio = { ...p.audio, volume: 1, muted: false, ...audio }
  return p
}

const withSpans = (p: Project, ...spans: [number, number, SoundSpan['action']][]): Project => ({
  ...p,
  sounds: { spans: spans.map(([start, end, action], i) => ({ start, end, action, key: `music-${i}` })), ignored: [] }
})

/** The graph's nodes: the recording's gain (after the video's own track) and the music's duck. */
function nodes(): { rec: FakeNode; duck: FakeNode | undefined } {
  const ctx = FakeAudioContext.last
  const screen = ctx.nodes.find((n) => n.kind === 'source')!.to as FakeNode
  const master = ctx.nodes.find((n) => n.to === ctx.destination)!
  return { rec: screen.to as FakeNode, duck: ctx.nodes.find((n) => n.kind === 'gain' && n.to === master) }
}

const settle = (): Promise<void> => new Promise((r) => setTimeout(r, 0))
const disposers: (() => void)[] = []

beforeEach(() => {
  analysis = {}
})
afterEach(() => {
  for (const d of disposers.splice(0)) d()
})

describe('the preview with unwanted sounds muted or lowered', () => {
  it('normalises the loudness the export does: muted stretches count as silence', async () => {
    // 40 s of loud music on the PC, then 80 s of quieter narration.
    analysis = { mix: levels([...run(-20, 40), ...run(-35, 80)]) }
    const p = project(120, { normalize: true })
    const sound = new PreviewAudio({ currentTime: 50, muted: false, volume: 1 }, p)
    disposers.push(() => sound.dispose())
    await settle()
    const { rec } = nodes()
    const before = rec.gain.value
    expect(before).toBeCloseTo(normalizeGain(editLoudness(analysis.mix!, p.clips)), 6)
    // Muting the music leaves the narration: louder to reach the target, as loudnorm makes it.
    const narration = normalizeGain(editLoudness(levels(run(-35, 80)), [{ id: 'n', start: 0, end: 80, speed: 1 }]))
    sound.setProject(withSpans(p, [0, 40, 'mute']))
    expect(20 * Math.log10(rec.gain.value)).toBeCloseTo(20 * Math.log10(narration), 1)
    expect(rec.gain.value).toBeGreaterThan(before * 2)
    // Lowered instead: in between. Restored (Undo): as before.
    sound.setProject(withSpans(p, [0, 40, 'duck']))
    expect(rec.gain.value).toBeGreaterThan(before)
    expect(rec.gain.value).toBeLessThan(narration)
    sound.setProject(p)
    expect(rec.gain.value).toBe(before)
  })
})
