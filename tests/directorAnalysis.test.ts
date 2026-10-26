import { beforeEach, describe, expect, it, vi } from 'vitest'
import type { AudioLevels } from '../src/shared/audio/loudness'
import type { AudioSource } from '../src/shared/audio/settings'
import type { DirectorSpeech } from '../src/shared/audio/speech'
import type { FramingOutcome } from '../src/shared/render/faceFraming'
import type { CursorTrack, Project } from '../src/shared/types'

/* ---------- a stand-in browser: window.api, the camera element and its frames ---------- */

const analyzeAudio = vi.fn<(id: string, sources: AudioSource[]) => Promise<Partial<Record<AudioSource, AudioLevels>>>>()
vi.stubGlobal('window', { api: { analyzeAudio } })

const FPS = 30

class FakeVideo extends EventTarget {
  static all: FakeVideo[] = []
  /** Camera times whose seek never finishes. */
  static stuck = new Set<number>()
  src = ''
  preload = ''
  playsInline = false
  crossOrigin: string | null = null
  muted = false
  readyState = 4
  seeking = false
  paused = true
  duration = 60
  videoWidth = 1280
  videoHeight = 720
  released = false
  seeks: number[] = []
  private time = 0
  constructor() {
    super()
    FakeVideo.all.push(this)
  }
  get currentTime(): number {
    return this.time
  }
  set currentTime(t: number) {
    this.time = t
    this.seeks.push(t)
    if ([...FakeVideo.stuck].some((s) => Math.abs(s - t) < 1 / FPS)) return
    setTimeout(() => this.dispatchEvent(new Event('seeked')), 1)
  }
  removeAttribute(name: string): void {
    if (name === 'src') {
      this.src = ''
      this.released = true
    }
  }
  load(): void {}
}

class FakeFrame {
  static all: FakeFrame[] = []
  closed = false
  timestamp: number
  displayWidth: number
  displayHeight: number
  constructor(v: FakeVideo) {
    this.timestamp = Math.round((Math.floor(v.currentTime * FPS + 1e-6) / FPS) * 1e6)
    this.displayWidth = v.videoWidth
    this.displayHeight = v.videoHeight
    FakeFrame.all.push(this)
  }
  close(): void {
    this.closed = true
  }
}

vi.stubGlobal('VideoFrame', FakeFrame)
vi.stubGlobal('document', { createElement: () => new FakeVideo() })

/* ---------- person masks the stand-in segmenter answers with ---------- */

const MW = 256
const MH = 144

/** The person of tests/faceFraming.test.ts (head at x 166 of 256) as a mask. */
function personMask(cx = 166): { pixels: { data: Uint8ClampedArray; width: number; height: number } } {
  const data = new Uint8ClampedArray(MW * MH * 4)
  for (let y = 0; y < MH; y++) {
    for (let x = 0; x < MW; x++) {
      const X = x + 0.5
      const Y = y + 0.5
      const on =
        ((X - cx) / 20) ** 2 + ((Y - 48) / 26) ** 2 <= 1 || (Y >= 48 && Y < 80 && Math.abs(X - cx) <= 8) || (Y >= 80 && Math.abs(X - cx) <= 40 + (20 * (Y - 80)) / 64)
      if (on) data[(y * MW + x) * 4 + 3] = 255
    }
  }
  return { pixels: { data, width: MW, height: MH } }
}

const emptyMask = () => ({ pixels: { data: new Uint8ClampedArray(MW * MH * 4), width: MW, height: MH } })

type Mask = ReturnType<typeof personMask> | null
const seg = {
  ok: true,
  state: { status: 'ready' } as { status: string; reason?: string },
  /** The mask for a picture at camera time t. */
  answer: (_t: number): Mask => personMask(),
  calls: 0
}

vi.doMock('../src/renderer/src/render/segmentation/personSegmenter', () => ({
  ensureSegmenter: async () => seg.ok,
  segmenterState: () => seg.state,
  segmentPicture: async (image: FakeFrame | FakeVideo) => {
    seg.calls++
    const t = image instanceof FakeFrame ? image.timestamp / 1e6 : image.currentTime
    return seg.answer(t)
  }
}))

/* ---------- the module under test, fresh for every test ---------- */

interface Analysis {
  loadDirectorSpeech(project: Pick<Project, 'id' | 'hasAudio' | 'audioStems' | 'transcript'>, cursor: CursorTrack): Promise<{ speech: DirectorSpeech | null; failed: boolean }>
  measureFraming(
    url: string,
    times: readonly number[],
    maxZoom: number,
    options?: { onProgress?: (p: { done: number; total: number }) => void; signal?: AbortSignal }
  ): Promise<FramingOutcome>
}
// Renderer code (DOM types): imported at run time so the Node typecheck of tests/ does not follow it.
const ANALYSIS = '../src/renderer/src/editor/directorAnalysis'

let analysis: Analysis

beforeEach(async () => {
  vi.resetModules()
  analyzeAudio.mockReset()
  FakeVideo.all = []
  FakeVideo.stuck.clear()
  FakeFrame.all = []
  seg.ok = true
  seg.state = { status: 'ready' }
  seg.answer = () => personMask()
  seg.calls = 0
  analysis = (await import(/* @vite-ignore */ ANALYSIS)) as Analysis
})

/* ---------- speech ---------- */

const WINDOW = 0.05

/** 30 s at a quiet floor, with talking at 1e-3 over `parts`. */
function levels(parts: [number, number][], floor = 1e-7): AudioLevels {
  const power = new Float32Array(Math.round(30 / WINDOW)).fill(floor)
  for (const [s, e] of parts) for (let i = Math.round(s / WINDOW); i < Math.round(e / WINDOW); i++) power[i] = 1e-3
  return { window: WINDOW, power }
}

const cursor: CursorTrack = { samples: [], clicks: [], typing: [{ t: 12, end: 14 }], valid: true }
const talking = levels([
  [1, 6],
  [12.2, 13.8],
  [20, 25]
])

const project = (over: Partial<Project> = {}): Pick<Project, 'id' | 'hasAudio' | 'audioStems' | 'transcript'> & Partial<Project> => ({
  id: 'p1',
  hasAudio: true,
  ...over
})

const plain = (s: DirectorSpeech | null): unknown => s && { ...s, ranges: s.ranges.map((r) => [r.start, r.end]) }

describe('loadDirectorSpeech', () => {
  it('listens to the microphone stem when the recording kept one, typing removed', async () => {
    analyzeAudio.mockResolvedValue({ mic: talking })
    const r = await analysis.loadDirectorSpeech(project({ audioStems: { mic: true, system: true } }), cursor)
    expect(analyzeAudio).toHaveBeenCalledWith('p1', ['mic'])
    expect(r.failed).toBe(false)
    expect(plain(r.speech)).toEqual({
      source: 'mic',
      refined: false,
      ranges: [
        [1, 6],
        [20, 25]
      ]
    })
  })

  it('listens to the mixed track without a microphone stem, and lets the transcript gate it', async () => {
    analyzeAudio.mockResolvedValue({ mix: talking })
    const transcript = { provider: 'openai', model: 'm', createdAt: '', segments: [{ id: 'a', start: 1, end: 6, text: 'hello' }] } as Project['transcript']
    const r = await analysis.loadDirectorSpeech(project({ transcript }), cursor)
    expect(analyzeAudio).toHaveBeenCalledWith('p1', ['mix'])
    expect(plain(r.speech)).toEqual({ source: 'mix', refined: true, ranges: [[1, 6]] })
  })

  it('never asks for the background music: only the recorded voice counts', async () => {
    analyzeAudio.mockResolvedValue({ mic: talking })
    const music = { path: 'music.mp3', volume: 0.35, ducking: 0.7, loop: true, fadeIn: 1, fadeOut: 2 }
    const r = await analysis.loadDirectorSpeech(project({ audioStems: { mic: true, system: false }, audio: { music } as Project['audio'] }), cursor)
    expect(analyzeAudio).toHaveBeenCalledTimes(1)
    expect(analyzeAudio.mock.calls[0][1]).toEqual(['mic'])
    expect(r.speech?.source).toBe('mic')
  })

  it('finds no talking in a recording of silence only', async () => {
    analyzeAudio.mockResolvedValue({ mic: levels([]) })
    const r = await analysis.loadDirectorSpeech(project({ audioStems: { mic: true, system: false } }), cursor)
    expect(r).toEqual({ speech: { source: 'mic', refined: false, ranges: [] }, failed: false })
  })

  it('measures nothing without sound: the transcript alone, else nothing', async () => {
    const none = await analysis.loadDirectorSpeech(project({ hasAudio: false }), cursor)
    expect(none).toEqual({ speech: null, failed: false })
    const transcript = { provider: 'openai', model: 'm', createdAt: '', segments: [{ id: 'a', start: 2, end: 4, text: 'hi' }] } as Project['transcript']
    const words = await analysis.loadDirectorSpeech(project({ hasAudio: false, transcript }), cursor)
    expect(plain(words.speech)).toEqual({ source: 'transcript', refined: false, ranges: [[2, 4]] })
    expect(analyzeAudio).not.toHaveBeenCalled()
  })

  it('reports a failed measurement without rejecting, and tries again on the next call', async () => {
    const warn = vi.spyOn(console, 'warn').mockImplementation(() => undefined)
    analyzeAudio.mockRejectedValueOnce(new Error('ffmpeg crashed'))
    const first = await analysis.loadDirectorSpeech(project({ audioStems: { mic: true, system: false } }), cursor)
    expect(first).toEqual({ speech: null, failed: true })
    analyzeAudio.mockResolvedValueOnce({ mic: talking })
    const second = await analysis.loadDirectorSpeech(project({ audioStems: { mic: true, system: false } }), cursor)
    expect(analyzeAudio).toHaveBeenCalledTimes(2)
    expect(second.failed).toBe(false)
    expect(second.speech?.ranges).toHaveLength(2)
    // Measured once: later calls use the session's levels.
    await analysis.loadDirectorSpeech(project({ audioStems: { mic: true, system: false } }), cursor)
    expect(analyzeAudio).toHaveBeenCalledTimes(2)
    warn.mockRestore()
  })

  it('never rejects even when the bridge throws', async () => {
    const warn = vi.spyOn(console, 'warn').mockImplementation(() => undefined)
    analyzeAudio.mockImplementationOnce(() => {
      throw new Error('no bridge')
    })
    await expect(analysis.loadDirectorSpeech(project(), cursor)).resolves.toEqual({ speech: null, failed: true })
    warn.mockRestore()
  })
})

/* ---------- face framing ---------- */

const TIMES = [3, 9, 15, 21, 27, 33]

function closedAll(): void {
  expect(FakeFrame.all.length).toBeGreaterThan(0)
  expect(FakeFrame.all.every((f) => f.closed)).toBe(true)
}

describe('measureFraming', () => {
  it('frames the face on its own hidden muted camera, reporting progress, closing every frame', async () => {
    const progress: number[] = []
    const out = await analysis.measureFraming('media://webcam.mp4', TIMES, 1.6, { onProgress: (p) => progress.push(p.done) })
    expect(out).toMatchObject({ status: 'framed', found: 6, sampled: 6, steady: true })
    if (out.status !== 'framed') throw new Error('not framed')
    expect(Math.abs(out.zoom - 1.55)).toBeLessThanOrEqual(0.05)
    expect(Math.abs(out.cropX - 0.648)).toBeLessThanOrEqual(0.01)
    expect(Math.abs(out.cropY - 0.38)).toBeLessThanOrEqual(0.02)
    expect(progress).toEqual([0, 1, 2, 3, 4, 5, 6])
    expect(FakeVideo.all).toHaveLength(1)
    const video = FakeVideo.all[0]
    expect(video.muted).toBe(true)
    expect(video.released).toBe(true)
    expect(video.seeks).toHaveLength(6)
    closedAll()
  })

  it('caps the zoom at the plan cap', async () => {
    const out = await analysis.measureFraming('media://webcam.mp4', TIMES, 1.3)
    expect(out).toMatchObject({ status: 'framed', zoom: 1.3 })
  })

  it('is unavailable when person detection cannot run, with its reason', async () => {
    seg.ok = false
    seg.state = { status: 'failed', reason: 'it needs WebGL graphics' }
    const out = await analysis.measureFraming('media://webcam.mp4', TIMES, 1.6)
    expect(out).toEqual({ status: 'unavailable', reason: 'it needs WebGL graphics' })
    expect(FakeVideo.all).toHaveLength(0)
  })

  it('is unavailable when person detection breaks while measuring', async () => {
    seg.answer = () => {
      seg.state = { status: 'failed', reason: 'the graphics context was lost' }
      return null
    }
    const out = await analysis.measureFraming('media://webcam.mp4', TIMES, 1.6)
    expect(out).toEqual({ status: 'unavailable', reason: 'the graphics context was lost' })
    expect(FakeVideo.all[0].released).toBe(true)
    closedAll()
  })

  it('finds no one in empty masks', async () => {
    seg.answer = () => emptyMask()
    const out = await analysis.measureFraming('media://webcam.mp4', TIMES, 1.6)
    expect(out).toEqual({ status: 'not-found', found: 0, sampled: 6 })
    closedAll()
  })

  it('skips a dark frame that got no mask and frames from the others', async () => {
    seg.answer = (t) => (t < 4 ? null : personMask())
    const out = await analysis.measureFraming('media://webcam.mp4', TIMES, 1.6)
    expect(out).toMatchObject({ status: 'framed', found: 5, sampled: 6 })
    closedAll()
  })

  it('frames a person who leaves the picture from the frames they are in, until too few remain', async () => {
    // In the first 5 of 8 pictures, then gone.
    seg.answer = (t) => (t < 30 ? personMask() : emptyMask())
    expect(await analysis.measureFraming('media://a.mp4', [...TIMES, 39, 45], 1.6)).toMatchObject({ status: 'framed', found: 5, sampled: 8, steady: true })
  })

  it('is not found when the person is in too few frames', async () => {
    seg.answer = (t) => (t < 10 ? personMask() : emptyMask())
    expect(await analysis.measureFraming('media://b.mp4', TIMES, 1.6)).toEqual({ status: 'not-found', found: 2, sampled: 6 })
  })

  it('stops early when aborted, releasing the camera and every frame', async () => {
    const abort = new AbortController()
    const out = await analysis.measureFraming('media://webcam.mp4', TIMES, 1.6, {
      signal: abort.signal,
      onProgress: (p) => {
        if (p.done === 2) abort.abort()
      }
    })
    expect(out).toEqual({ status: 'skipped' })
    expect(seg.calls).toBe(2)
    expect(FakeVideo.all[0].released).toBe(true)
    closedAll()
    // Aborted before it starts: nothing at all.
    expect(await analysis.measureFraming('media://webcam.mp4', TIMES, 1.6, { signal: AbortSignal.abort() })).toEqual({ status: 'skipped' })
    expect(FakeVideo.all).toHaveLength(1)
  })

  it('skips a picture whose seek does not finish within 3 s', async () => {
    FakeVideo.stuck.add(9.0166)
    const started = Date.now()
    const out = await analysis.measureFraming('media://webcam.mp4', TIMES, 1.6)
    expect(Date.now() - started).toBeGreaterThanOrEqual(2900)
    expect(out).toMatchObject({ status: 'framed', found: 5, sampled: 6 })
    expect(seg.calls).toBe(5)
  }, 10000)

  it('measures a camera file at the same times once per session', async () => {
    const first = await analysis.measureFraming('media://webcam.mp4', TIMES, 1.6)
    const progress: number[] = []
    const again = await analysis.measureFraming('media://webcam.mp4', TIMES, 1.6, { onProgress: (p) => progress.push(p.done) })
    expect(again).toEqual(first)
    expect(progress).toEqual([6])
    expect(FakeVideo.all).toHaveLength(1)
    expect(seg.calls).toBe(6)
    // Another cap reuses the faces; other times measure again.
    expect(await analysis.measureFraming('media://webcam.mp4', TIMES, 1.3)).toMatchObject({ zoom: 1.3 })
    expect(seg.calls).toBe(6)
    await analysis.measureFraming('media://webcam.mp4', [4, 10, 16, 22, 28, 34], 1.6)
    expect(seg.calls).toBe(12)
  })

  it('finds nothing to measure without times', async () => {
    expect(await analysis.measureFraming('media://webcam.mp4', [], 1.6)).toEqual({ status: 'not-found', found: 0, sampled: 0 })
  })
})
