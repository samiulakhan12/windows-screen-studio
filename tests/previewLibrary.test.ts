import { spawnSync } from 'node:child_process'
import path from 'node:path'
import { afterEach, describe, expect, it, vi } from 'vitest'
import { ffmpegPath } from '../src/main/ffmpeg'
import type { ExportJob } from '../src/shared/api/export'
import { bedLoop, bedSeconds, bedTime, soundBed, soundEffect } from '../src/shared/audio/soundLibrary'
import { createProject } from '../src/shared/engine/project'
import { editToVideo, planOf } from '../src/shared/engine/freeze'
import { sourceToOutput } from '../src/shared/engine/timeline'
import { planSoundtrack } from '../src/shared/render/audioPlan'
import { sfxJob } from '../src/shared/render/sfxJob'
import type { Annotation, Project } from '../src/shared/types'

/*
 * Editing polish, part P5 (docs/design/editing-polish.md §10.4, §10.9, §19.1 test 69): the preview
 * plays a library bed from a buffer node that loops from S to E on the music's drift loop, and the
 * library's effects at the export's times, each voice cut where its effect sounds next. The audio
 * graph and the media elements are stand-ins that record what is scheduled; the effects' scheduled
 * voices are then rendered sample by sample (what an OfflineAudioContext would play) and compared
 * with ffmpeg's render of the export job.
 */

const RATE = 48000
const LIBRARY = path.join(__dirname, '..', 'resources', 'sound-library')
const BED = soundBed('upbeat-sweet-sun')!
const { start: S, end: E } = bedLoop(BED)
const MUSIC_SEEK = 0.3

/** Mono float samples of a library file at 48 kHz (ffmpeg, as main and Chromium decode it). */
const decodedCache = new Map<string, Float32Array>()
function decodeFile(file: string): Float32Array {
  let d = decodedCache.get(file)
  if (!d) {
    const r = spawnSync(ffmpegPath(), ['-v', 'error', '-i', path.join(LIBRARY, file), '-ac', '1', '-ar', String(RATE), '-f', 'f32le', '-'], { maxBuffer: 1 << 28 })
    d = new Float32Array(r.stdout.buffer.slice(r.stdout.byteOffset, r.stdout.byteOffset + r.stdout.length))
    decodedCache.set(file, d)
  }
  return d
}

/* ---------- stand-ins ---------- */

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
class FakeBuffer {
  constructor(
    readonly duration: number,
    readonly samples: Float32Array | null = null
  ) {}
  readonly sampleRate = RATE
  get length(): number {
    return Math.round(this.duration * RATE)
  }
}
class FakeSource extends FakeNode {
  buffer: FakeBuffer | null = null
  loop = false
  loopStart = 0
  loopEnd = 0
  playbackRate = new FakeParam()
  started: { when: number; offset: number; duration?: number } | null = null
  stopped: number | null = null
  onended: (() => void) | null = null
  constructor() {
    super('buffer')
  }
  start(when: number, offset = 0, duration?: number): void {
    this.started = { when, offset, ...(duration !== undefined ? { duration } : {}) }
  }
  stop(when = 0): void {
    this.stopped = when
  }
}
const urls = new WeakMap<ArrayBuffer, string>()
const fetched: string[] = []
class FakeAudioContext {
  static last: FakeAudioContext
  currentTime = 0
  baseLatency = 0.01
  destination = {}
  readonly nodes: FakeNode[] = []
  constructor() {
    FakeAudioContext.last = this
  }
  private node<T extends FakeNode>(n: T): T {
    this.nodes.push(n)
    return n
  }
  createGain = (): FakeNode => this.node(new FakeNode('gain'))
  createWaveShaper = (): FakeNode => this.node(new FakeNode('shaper'))
  createMediaElementSource = (): FakeNode => this.node(new FakeNode('source'))
  createBufferSource = (): FakeSource => this.node(new FakeSource())
  createBuffer = (_c: number, length: number): FakeBuffer & { copyToChannel(): void } => Object.assign(new FakeBuffer(length / RATE), { copyToChannel: () => undefined })
  decodeAudioData = async (data: ArrayBuffer): Promise<FakeBuffer> => {
    const url = urls.get(data) ?? ''
    const file = decodeURIComponent(url.split('?')[0].split('/').pop() ?? '')
    if (url.includes('://sounds/')) return new FakeBuffer(decodeFile(file).length / RATE, decodeFile(file))
    // The project's copy of the bed: the catalogue's file holds E + pad samples.
    return new FakeBuffer(file === 'music-9.ogg' ? 12.5 : BED.prepared.samples / RATE)
  }
  resume = (): Promise<void> => Promise.resolve()
  suspend = (): Promise<void> => Promise.resolve()
  close = (): Promise<void> => Promise.resolve()
  get sources(): FakeSource[] {
    return this.nodes.filter((n): n is FakeSource => n instanceof FakeSource)
  }
}
vi.stubGlobal('AudioContext', FakeAudioContext)
vi.stubGlobal('fetch', async (url: string) => {
  fetched.push(url)
  return {
    arrayBuffer: async () => {
      const b = new ArrayBuffer(8)
      urls.set(b, url)
      return b
    }
  }
})

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
vi.mock('../src/renderer/src/editor/media', async (original) => ({ ...(await original<object>()), createAudio: (url: string) => new FakeAudio(url) }))
vi.mock('../src/renderer/src/editor/audioAnalysis', () => ({ loadAudioAnalysis: async () => ({}) }))

class FakeVideo {
  currentTime = 0
  playbackRate = 1
  muted = false
  volume = 1
  private readonly listeners = new Map<string, (() => void)[]>()
  addEventListener(type: string, fn: () => void): void {
    this.listeners.set(type, [...(this.listeners.get(type) ?? []), fn])
  }
  removeEventListener(type: string, fn: () => void): void {
    this.listeners.set(type, (this.listeners.get(type) ?? []).filter((f) => f !== fn))
  }
  fire(type: string): void {
    for (const fn of this.listeners.get(type) ?? []) fn()
  }
}

// Renderer code (DOM types): imported at run time so the Node typecheck of tests/ does not follow it.
const AUDIO = '../src/renderer/src/editor/previewAudio'
interface Sound {
  setProject(p: Project): void
  play(t: number, speed: number): void
  pause(): void
  jump(t: number, speed: number): void
  frame(t?: number): void
  dispose(): void
}
const { PreviewAudio } = (await import(/* @vite-ignore */ AUDIO)) as { PreviewAudio: new (s: unknown, p: Project) => Sound }
type Inside = Sound & { bed: { node: FakeSource | null } | null; bedPosition(b: unknown, now: number): number | null; effectsOf(): { sfx: unknown[] }; outputAt(t: number): number }

const settle = (): Promise<void> => new Promise((r) => setTimeout(r, 0))
const disposers: (() => void)[] = []
afterEach(() => {
  for (const d of disposers.splice(0)) d()
  fetched.length = 0
})

function project(duration: number, over: Partial<Project> = {}): Project {
  const p = createProject({
    id: 'p',
    name: 'p',
    duration,
    width: 1920,
    height: 1080,
    hasWebcam: false,
    hasAudio: false,
    webcamOffset: 0,
    zooms: [],
    cursorValid: false,
    capture: { method: 'native', cursorInVideo: false, region: null, fps: 30 }
  })
  return { ...p, clips: [{ id: 'c', start: 0, end: duration, speed: 1 }], ...over }
}
const withBed = (p: Project, loop = true, path = 'music-1.ogg'): Project => ({
  ...p,
  audio: { ...p.audio, music: { path, volume: 0.35, ducking: 0, loop, fadeIn: 0, fadeOut: 0, library: { id: BED.id } } }
})

async function open(p: Project, video = new FakeVideo()): Promise<{ sound: Inside; video: FakeVideo; ctx: FakeAudioContext }> {
  const sound = new PreviewAudio(video, p) as Inside
  disposers.push(() => sound.dispose())
  await settle()
  await settle()
  return { sound, video, ctx: FakeAudioContext.last }
}

describe('a library bed in the preview (test 69)', () => {
  it('a buffer node loops from S to E, started at bedTime(out), and again after a seek', async () => {
    const { sound, video, ctx } = await open(withBed(project(300)))
    expect(fetched).toEqual([expect.stringMatching(/^studio-media:\/\/project\/p\/music-1\.ogg\?v=\d+$/)])
    video.currentTime = 10
    sound.play(10, 1)
    const node = sound.bed!.node!
    expect(node.loop).toBe(true)
    expect(node.loopStart).toBe(S / RATE)
    expect(node.loopEnd).toBe(E / RATE)
    expect(node.started).toEqual({ when: 0, offset: 10 })
    expect(node.to).toBeInstanceOf(FakeNode)
    // A seek past E: a new node, from S again (bedTime).
    ctx.currentTime = 1
    video.currentTime = 150
    sound.jump(150, 1)
    const after = sound.bed!.node!
    expect(after).not.toBe(node)
    expect(node.stopped).not.toBeNull()
    expect(after.started!.offset).toBeCloseTo(bedTime(BED, 150, true), 9)
    expect(after.started!.offset).toBeCloseTo(S / RATE + (150 - E / RATE), 9)
    // No <audio> element plays the music.
    expect(ctx.nodes.filter((n) => n.kind === 'source').length).toBe(1)
  })

  it('without Loop it plays to E / 48000 and stops there, never the pad', async () => {
    const { sound, video, ctx } = await open(withBed(project(300), false))
    video.currentTime = bedSeconds(BED) - 2
    sound.play(video.currentTime, 1)
    const node = sound.bed!.node!
    expect(node.loop).toBe(false)
    expect(node.started!.offset).toBeCloseTo(bedSeconds(BED) - 2, 9)
    expect(node.started!.duration).toBeCloseTo(2, 9)
    ctx.currentTime = 3
    video.currentTime = bedSeconds(BED) + 1
    sound.frame()
    expect(sound.bed!.node).toBeNull()
    expect(node.stopped).not.toBeNull()
  })

  it('with an 80 ms stall of the video at each of 50 cuts, the bed stays within MUSIC_SEEK of bedTime(out)', async () => {
    // 51 clips of 1.9 s with 0.1 s cut out between them.
    const clips = Array.from({ length: 51 }, (_, i) => ({ id: `c${i}`, start: i * 2, end: i * 2 + 1.9, speed: 1 }))
    const { sound, video, ctx } = await open(withBed(project(102, { clips })))
    sound.play(0, 1)
    let clip = 0
    let worst = 0
    let restarts = 0
    let last = sound.bed!.node
    const frame = 1 / 60
    let stall = 0
    for (let step = 0; step < 60 * 110 && clip < clips.length; step++) {
      ctx.currentTime += frame
      if (stall > 0) {
        // The video's clock waits at the cut while the context's runs on.
        stall -= frame
        sound.frame()
      } else {
        video.currentTime += frame
        if (video.currentTime >= clips[clip].end) {
          clip++
          if (clip >= clips.length) break
          video.currentTime = clips[clip].start
          sound.jump(video.currentTime, 1)
          stall = 0.08
        }
        sound.frame()
      }
      const b = sound.bed!
      if (b.node !== last) restarts++
      last = b.node
      const out = sound.outputAt(video.currentTime)
      // It plays to the end of the video (and stops there).
      const at = sound.bedPosition(b, ctx.currentTime)
      if (out > 96.9 - 0.05) continue
      expect(at, `${step}`).not.toBeNull()
      worst = Math.max(worst, Math.abs(at! - bedTime(BED, out, true)))
    }
    expect(clip).toBe(clips.length)
    expect(worst).toBeLessThanOrEqual(MUSIC_SEEK + 1 / 60)
    // Nudged mostly (13 restarts without the nudge: 50 × 80 ms over 0.3 s), restarted only past MUSIC_SEEK.
    expect(restarts).toBeLessThanOrEqual(8)
    expect(restarts).toBeGreaterThan(0)
  })

  it('the video waiting stops it, and playing again starts it where the video is', async () => {
    const { sound, video, ctx } = await open(withBed(project(300)))
    video.currentTime = 5
    sound.play(5, 1)
    const first = sound.bed!.node!
    video.fire('waiting')
    expect(sound.bed!.node).toBeNull()
    expect(first.stopped).not.toBeNull()
    ctx.currentTime = 2
    sound.frame()
    expect(sound.bed!.node).toBeNull()
    video.currentTime = 5.5
    video.fire('playing')
    expect(sound.bed!.node!.started).toEqual({ when: 2, offset: 5.5 })
  })

  it('a file that is not the catalogue bed plays as a user own file', async () => {
    const { sound, ctx } = await open(withBed(project(60), true, 'music-9.ogg'))
    await settle()
    expect(sound.bed).toBeNull()
    expect(ctx.nodes.filter((n) => n.kind === 'source').length).toBe(2)
  })
})

describe("the library's effects in the preview (test 69)", () => {
  const text = (id: string, start: number, sound?: Annotation['sound']): Annotation => ({ id, start, end: start + 1, text: 'x', x: 0.5, y: 0.5, size: 0.05, style: 'pill', ...(sound ? { sound } : {}) })

  it('play at the export times at the export gain, each voice stopping where its effect sounds next', async () => {
    const p = project(10, {
      annotations: [text('a', 1, 'sfx:whoosh-soft'), text('b', 1.2, 'sfx:whoosh-soft'), text('c', 2, 'sfx:pop')],
      zooms: [{ id: 'z', start: 5, end: 7, scale: 2, focus: { mode: 'fixed', x: 0.5, y: 0.5 }, auto: false }],
      soundFx: { zoomIn: 'sfx:whoosh-in', volume: 0.5 }
    })
    const { sound, video, ctx } = await open(p)
    sound.play(0, 1)
    // Decoding happens on the first frame; the voices are scheduled from the next ones.
    sound.frame()
    await settle()
    await settle()
    const job = sfxJob(p)
    for (let t = 0; t <= 10; t += 0.05) {
      video.currentTime = t
      ctx.currentTime = t
      sound.frame()
    }
    expect(fetched.filter((u) => u.includes('://sounds/')).sort()).toEqual(['sfx-pop.ogg', 'sfx-whoosh-in.ogg', 'sfx-whoosh-soft.ogg'].map((f) => `studio-media://sounds/${f}`))
    const voices = ctx.sources.filter((v) => v.buffer?.samples)
    const scheduled = voices.map((v) => ({ start: v.started!.when, stop: v.stopped, samples: v.buffer!.samples!.length }))
    const want = job.flatMap((e) => e.times.map((t, i) => ({ start: t, stop: e.times[i + 1] ?? null, samples: decodeFile(soundEffect(e.id)!.prepared.file).length }))).sort((a, b) => a.start - b.start)
    expect(scheduled.sort((a, b) => a.start - b.start)).toEqual(want)
    const gain = ctx.nodes.find((n) => voices.some((v) => v.to === n))!
    expect(gain.gain.value).toBe(0.5)

    // What an OfflineAudioContext plays from these voices, against ffmpeg's export of the same job.
    const seconds = 10
    const n = seconds * RATE
    const preview = new Float32Array(n)
    for (const v of voices) {
      const from = Math.round(v.started!.when * RATE)
      const to = v.stopped !== null ? Math.round(v.stopped * RATE) : n
      const src = v.buffer!.samples!
      for (let i = 0; i < src.length && from + i < Math.min(n, to); i++) preview[from + i] += gain.gain.value * src[i]
    }
    const exportJob: ExportJob = { width: 0, height: 0, fps: 60, frames: seconds * 60, format: 'm4a', quality: 'high', video: { kind: 'none' }, outputPath: '/o.m4a', effects: job }
    const effects = Object.fromEntries(job.map((e) => [e.id, path.join(LIBRARY, soundEffect(e.id)!.prepared.file)]))
    const plan = planSoundtrack(exportJob, { mix: null, effects }, 0)
    const r = spawnSync(ffmpegPath(), ['-v', 'error', ...plan.args, '-filter_complex', plan.graph!, '-map', '[aout]', '-ac', '1', '-ar', String(RATE), '-f', 'f32le', '-'], { maxBuffer: 1 << 28 })
    expect(r.status, r.stderr.toString()).toBe(0)
    const exported = new Float32Array(r.stdout.buffer.slice(r.stdout.byteOffset, r.stdout.byteOffset + r.stdout.length))
    expect(exported.length).toBe(n)
    let worst = 0
    let loud = 0
    for (let i = 0; i < n; i++) {
      worst = Math.max(worst, Math.abs(preview[i] - exported[i]))
      loud = Math.max(loud, Math.abs(exported[i]))
    }
    expect(loud).toBeGreaterThan(0.01)
    // Within −60 dB.
    expect(worst).toBeLessThan(0.001)
  })

  it('effectsOf is made again when chapterBar, zooms or soundFx change', async () => {
    const p = project(10, { soundFx: { zoomIn: 'sfx:whoosh-soft' } })
    const { sound } = await open(p)
    const first = sound.effectsOf()
    expect(sound.effectsOf()).toBe(first)
    const changes: Partial<Project>[] = [
      { chapterBar: { show: true, place: 'auto', style: 'float', labels: 'current' } },
      { zooms: [{ id: 'z', start: 2, end: 4, scale: 2, focus: { mode: 'fixed', x: 0.5, y: 0.5 }, auto: false }] },
      { soundFx: { zoomIn: 'sfx:whoosh-in' } }
    ]
    let prev = first
    let q = p
    for (const change of changes) {
      q = { ...q, ...change }
      sound.setProject(q)
      const next = sound.effectsOf()
      expect(next, Object.keys(change)[0]).not.toBe(prev)
      prev = next
    }
    expect(prev.sfx).toEqual(sfxJob(q))
  })

  it("an old project's graph is as before: no new node, nothing fetched", async () => {
    const p = project(10, { audio: { ...project(10).audio, music: { path: 'music-1.mp3', volume: 0.35, ducking: 0, loop: true, fadeIn: 0, fadeOut: 0 } } })
    const { sound, video, ctx } = await open(p)
    sound.play(0, 1)
    for (let t = 0; t < 2; t += 0.1) {
      video.currentTime = t
      ctx.currentTime = t
      sound.frame()
    }
    // The video's track, its gains, the limiter, the master, cut, sounds, pops and tones; the music's element and its three gains.
    expect(ctx.nodes.map((n) => n.kind)).toEqual(['gain', 'gain', 'shaper', 'gain', 'gain', 'gain', 'gain', 'gain', 'source', 'source', 'gain', 'gain', 'gain'])
    expect(fetched).toEqual([])
    expect(ctx.sources).toEqual([])
  })
})

describe('the export and the preview agree on when effects sound (test 69)', () => {
  it('the preview takes sfxJob with the same start of a graphic as the export', () => {
    const p = project(10, { annotations: [{ id: 'a', start: 3, end: 4, text: 'x', x: 0.5, y: 0.5, size: 0.05, style: 'pill', sound: 'sfx:pop' }] })
    const plan = planOf(p)
    expect(sfxJob(p)[0].times[0]).toBe(editToVideo(plan, sourceToOutput(p.clips, 3)!) + 0.075 - soundEffect('pop')!.prepared.peakAt)
  })
})
