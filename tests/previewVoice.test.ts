import { describe, expect, it, vi } from 'vitest'
import { VOICE_COPY } from '../src/shared/audio/voiceCopy'
import { createProject } from '../src/shared/engine/project'
import type { Project } from '../src/shared/types'

/*
 * The preview's cleaned voice (editor/previewAudio.ts, docs/design/clean-voice.md §4.5) when its
 * file will not play: main says the stem is ready (the file is there) but the element cannot
 * load it (a damaged file, a cloud placeholder read offline). The element is loaded again a few
 * times at most, then the preview plays the original and the panel says the stem failed; its Try
 * again has main make the file again. The stems store is the real one, over a fake main process;
 * the audio graph and the elements are stand-ins.
 */

const FILE = 'voice-0123456789abcdef.m4a'
/** Per project: how many loads of its cleaned file fail from now on (Infinity: every one). */
const failing = new Map<string, number>()
/** Per project: loads of its cleaned file. */
const loads = new Map<string, number>()

class FakeAudio {
  paused = true
  playbackRate = 1
  loop = false
  duration = NaN
  error = null
  currentTime = 0
  private readonly listeners = new Map<string, (() => void)[]>()
  constructor(readonly url: string) {
    if (!url.includes('voice-')) return
    const id = /^studio-media:\/\/project\/([^/]+)\//.exec(url)![1]
    loads.set(id, (loads.get(id) ?? 0) + 1)
    const left = failing.get(id) ?? 0
    if (left > 0) {
      failing.set(id, left - 1)
      setTimeout(() => this.fire('error'), 0)
    }
  }
  play(): Promise<void> {
    this.paused = false
    return Promise.resolve()
  }
  pause(): void {
    this.paused = true
  }
  addEventListener(type: string, fn: () => void): void {
    this.listeners.set(type, [...(this.listeners.get(type) ?? []), fn])
  }
  fire(type: string): void {
    for (const fn of this.listeners.get(type) ?? []) fn()
  }
  removeAttribute(): void {}
  load(): void {}
}

vi.mock('../src/renderer/src/editor/media', async (original) => ({
  ...(await original<object>()),
  createAudio: (url: string) => new FakeAudio(url)
}))
vi.mock('../src/renderer/src/editor/audioAnalysis', () => ({ loadAudioAnalysis: async () => ({}) }))

/** Main: the stem is always there. Its status asks, per project, and the projects whose stem it made again. */
const statusCalls = new Map<string, number>()
const remade: string[] = []
vi.stubGlobal('window', {
  api: {
    voiceStatus: async (id: string) => {
      statusCalls.set(id, (statusCalls.get(id) ?? 0) + 1)
      return { state: 'ready', file: FILE }
    },
    prepareVoice: async (id: string, _source: string, _strength: string, remake?: boolean) => {
      if (remake === true) remade.push(id)
      return FILE
    },
    cancelVoice: async () => undefined,
    onVoiceProgress: () => () => undefined
  }
})

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
  to: FakeNode | null = null
  src: unknown = null
  connect<T>(n: T): T {
    this.to = n as FakeNode
    return n
  }
  disconnect(): void {
    this.to = null
  }
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
  createMediaElementSource = (el: unknown): FakeNode => {
    const n = this.node()
    n.src = el
    return n
  }
  resume = (): Promise<void> => Promise.resolve()
  suspend = (): Promise<void> => Promise.resolve()
  close = (): Promise<void> => Promise.resolve()
}
vi.stubGlobal('AudioContext', FakeAudioContext)

// Renderer code (DOM types): imported at run time so the Node typecheck of tests/ does not follow it.
const AUDIO = '../src/renderer/src/editor/previewAudio'
const { PreviewAudio } = (await import(/* @vite-ignore */ AUDIO)) as {
  PreviewAudio: new (screen: unknown, p: Project) => { play(t: number, speed: number): void; dispose(): void }
}
const STEMS = '../src/renderer/src/editor/voiceStems'
const stems = ((await import(/* @vite-ignore */ STEMS)) as { voiceStems: () => { get(id: string, source: string, strength: string): object; prepare(id: string, source: string, strength: string): Promise<string> } }).voiceStems()

/** A recording without stems (Clean voice cleans its mixed track), with Clean voice on. */
function project(id: string): Project {
  const p = createProject({
    id,
    name: id,
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
  p.audio = { ...p.audio, voice: { on: true, strength: 'normal' } }
  return p
}

/** The gain each connected element plays at now ('screen': the video's own track; NaN: none), its latest element per file. */
function gains(screen: object): { screen: number; voice: number } {
  const out = { screen: NaN, voice: NaN }
  for (const n of FakeAudioContext.last.nodes) {
    if (!n.src || !n.to) continue
    if (n.src === screen) out.screen = n.to.gain.value
    else if ((n.src as FakeAudio).url.includes(FILE)) out.voice = n.to.gain.value
  }
  return out
}

const settle = (ms: number): Promise<void> => new Promise((r) => setTimeout(r, ms))

describe('the preview’s cleaned voice that will not play', () => {
  it('is loaded again a few times at most, then the original plays', async () => {
    const warn = vi.spyOn(console, 'warn').mockImplementation(() => undefined)
    failing.set('broken', Infinity)
    const screen = { currentTime: 0, muted: false, volume: 1 }
    const sound = new PreviewAudio(screen, project('broken'))
    sound.play(0, 1)
    await settle(300)
    // The first load and two more once the store found the file again; then it stays as it is,
    // and the panel says so (it no longer says the preview plays the clean voice, nor offers the A/B).
    expect(loads.get('broken')).toBe(3)
    expect(statusCalls.get('broken')).toBe(3)
    expect(stems.get('broken', 'mix', 'normal')).toEqual({ state: 'failed', message: VOICE_COPY.unplayable, remake: true })
    expect(gains(screen)).toEqual({ screen: 1, voice: NaN })
    await settle(100)
    expect(loads.get('broken')).toBe(3)
    expect(remade).not.toContain('broken')
    sound.dispose()
    warn.mockRestore()
  })

  it('has main make the file again on Try again, and plays the new one', async () => {
    const warn = vi.spyOn(console, 'warn').mockImplementation(() => undefined)
    failing.set('remade', 3)
    const screen = { currentTime: 0, muted: false, volume: 1 }
    const sound = new PreviewAudio(screen, project('remade'))
    sound.play(0, 1)
    await settle(100)
    expect(loads.get('remade')).toBe(3)
    expect(stems.get('remade', 'mix', 'normal')).toEqual({ state: 'failed', message: VOICE_COPY.unplayable, remake: true })
    // What the panel's Try again (and the export) does.
    await expect(stems.prepare('remade', 'mix', 'normal')).resolves.toBe(FILE)
    expect(remade).toEqual(['remade'])
    await settle(50)
    expect(loads.get('remade')).toBe(4)
    expect(stems.get('remade', 'mix', 'normal')).toEqual({ state: 'ready', file: FILE })
    expect(gains(screen)).toEqual({ screen: 0, voice: 1 })
    sound.dispose()
    warn.mockRestore()
  })

  it('plays a file that loads on the next try (made again under the same name)', async () => {
    const warn = vi.spyOn(console, 'warn').mockImplementation(() => undefined)
    failing.set('healed', 1)
    const screen = { currentTime: 0, muted: false, volume: 1 }
    const sound = new PreviewAudio(screen, project('healed'))
    sound.play(0, 1)
    await settle(50)
    expect(loads.get('healed')).toBe(2)
    expect(gains(screen)).toEqual({ screen: 0, voice: 1 })
    sound.dispose()
    warn.mockRestore()
  })
})
