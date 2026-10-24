import { describe, expect, it, vi } from 'vitest'

vi.mock('electron', () => ({ app: { getPath: () => '/tmp' } }))

import type { NativeCaptureSession, NativeStopInfo, WindowRectEvent, WindowWatchSession } from '../src/main/nativeCapture'
import type { RecordingManifest } from '../src/main/projects'
import { nativeWindowAvailable, startWindowWatch, stopWindowWatch, type NativeCaptureApi } from '../src/main/recording/nativeVideo'
import { ActiveRecording } from '../src/main/recording/session'
import { buildCursorTrack } from '../src/main/recording/trackMath'
import { planWindowCapture, watchForChromium, windowCaptureSupport, windowCursorMapping, windowMapping, type DipScreen } from '../src/main/recording/windowCapture'
import { posesFromRects, type Rect } from '../src/shared/recording/windowGeometry'

const T0 = 1_700_000_000_000
const WINDOW = 'window:4194316:0'
const rect = (at: number, x = 100, y = 50, width = 800, height = 400, minimized = false): WindowRectEvent => ({ at, x, y, width, height, minimized })

/** A scripted watcher that records how it was driven. */
function fakeWatch(opts: { ready?: Promise<WindowRectEvent>; stop?: () => Promise<WindowRectEvent[]> } = {}) {
  const calls: string[] = []
  const watch: WindowWatchSession = {
    ready: opts.ready ?? Promise.resolve(rect(T0)),
    stop: () => {
      calls.push('stop')
      return opts.stop ? opts.stop() : Promise.resolve([rect(T0), rect(T0 + 1000, 300)])
    },
    kill: () => void calls.push('kill')
  }
  return { watch, calls }
}

function api(opts: { native?: boolean | (() => Promise<boolean>); watch?: () => WindowWatchSession; omit?: boolean } = {}): NativeCaptureApi & { watched: string[] } {
  const watched: string[] = []
  const base = {
    watched,
    isNativeCaptureAvailable: async () => true,
    startNativeCapture: (): never => {
      throw new Error('not used')
    }
  }
  if (opts.omit) return base
  return {
    ...base,
    isNativeWindowCaptureAvailable: typeof opts.native === 'function' ? opts.native : async () => opts.native === true,
    watchWindow: (id: string) => {
      watched.push(id)
      if (!opts.watch) throw new Error('Window watching is not available in this build')
      return opts.watch()
    }
  }
}

describe('posesFromRects', () => {
  it('converts physical rectangles to DIP, sorted by time, skipping malformed ones', () => {
    const half = (r: Rect): Rect => ({ x: r.x / 2, y: r.y / 2, width: r.width / 2, height: r.height / 2 })
    const poses = posesFromRects(
      [rect(T0 + 10, 200, 100, 400, 200), rect(T0, 0, 0, 800, 600), { ...rect(T0 + 5), width: NaN }, rect(T0 + 6, 0, 0, 0, 10), null as never],
      half
    )
    expect(poses.map((p) => p.at)).toEqual([T0, T0 + 10])
    expect(poses[1]).toEqual({ at: T0 + 10, dip: { x: 100, y: 50, width: 200, height: 100 }, physical: { x: 200, y: 100, width: 400, height: 200 }, minimized: false })
  })

  it('keeps a minimised window as is (Windows parks it off screen) and never converts it', () => {
    const toDip = vi.fn((r: Rect) => r)
    const [p] = posesFromRects([rect(T0, -32000, -32000, 160, 28, true)], toDip)
    expect(p.minimized).toBe(true)
    expect(toDip).not.toHaveBeenCalled()
  })
})

describe('windowMapping', () => {
  it('fits into the proxy size (even pixels, as the proxy step rounds it)', () => {
    const m = windowMapping([rect(T0)], (r) => r, { width: 801, height: 401 })!
    expect(m.out).toEqual({ width: 800, height: 400 })
    expect(m.poses).toHaveLength(1)
  })

  it('is null without a usable rectangle or video size', () => {
    expect(windowMapping([], (r) => r, { width: 800, height: 400 })).toBeNull()
    expect(windowMapping([rect(T0, -32000, -32000, 160, 28, true)], (r) => r, { width: 800, height: 400 })).toBeNull()
    expect(windowMapping([rect(T0)], (r) => r, { width: 0, height: 0 })).toBeNull()
  })
})

describe('windowCursorMapping (physical rectangles, DIP cursor)', () => {
  /** Electron's screen on a 150% monitor: DIP = physical / 1.5. */
  const screen150: DipScreen = {
    screenToDipRect: (_w, r) => ({ x: r.x / 1.5, y: r.y / 1.5, width: r.width / 1.5, height: r.height / 1.5 }),
    getDisplayMatching: () => ({ scaleFactor: 1.5 })
  }

  it('converts the helper rectangles to DIP on Windows, so DIP clicks land on the right spot', () => {
    // The window is at (150, 75) physical, 1200 x 600: (100, 50) DIP, 800 x 400.
    const { mapping, scale } = windowCursorMapping([rect(T0 - 10, 150, 75, 1200, 600)], { width: 1200, height: 600 }, screen150, 'win32')
    expect(scale).toBe(1.5)
    expect(mapping!.poses[0].dip).toEqual({ x: 100, y: 50, width: 800, height: 400 })
    const track = buildCursorTrack(
      { samples: [], clicks: [{ at: T0 + 100, x: 300, y: 150, button: 'left' }], keys: [], bounds: null, scale: 1 },
      { startedAt: T0, pauses: [], duration: 1, region: null, window: mapping }
    )
    expect(track.clicks[0]).toMatchObject({ x: 0.25, y: 0.25 })
  })

  it('keeps the rectangles as they are where both spaces are the same pixels (X11)', () => {
    const { mapping } = windowCursorMapping([rect(T0, 150, 75, 1200, 600)], { width: 1200, height: 600 }, screen150, 'linux')
    expect(mapping!.poses[0].dip).toEqual({ x: 150, y: 75, width: 1200, height: 600 })
  })

  it('knows no scale without a visible window', () => {
    expect(windowCursorMapping([], { width: 800, height: 400 }, screen150, 'win32')).toEqual({ mapping: null, scale: null })
  })
})

describe('nativeWindowAvailable', () => {
  it('is false when the helper client has no window capture, fails or hangs', async () => {
    expect(await nativeWindowAvailable(api({ omit: true }))).toBe(false)
    expect(await nativeWindowAvailable(api({ native: true }))).toBe(true)
    expect(await nativeWindowAvailable(api({ native: () => Promise.reject(new Error('probe crashed')) }))).toBe(false)
    expect(await nativeWindowAvailable(api({ native: () => new Promise(() => undefined) }), 30)).toBe(false)
  })
})

describe('startWindowWatch / stopWindowWatch', () => {
  it('waits for the first rectangle', async () => {
    const { watch } = fakeWatch()
    const a = api({ watch: () => watch })
    const r = await startWindowWatch(a, WINDOW)
    expect(r).toMatchObject({ ok: true, first: rect(T0) })
    expect(a.watched).toEqual([WINDOW])
    expect(await stopWindowWatch(watch)).toEqual([rect(T0), rect(T0 + 1000, 300)])
  })

  it('reports (never throws) a missing or throwing watcher', async () => {
    expect(await startWindowWatch(api({ omit: true }), WINDOW)).toMatchObject({ ok: false })
    expect(await startWindowWatch(api(), WINDOW)).toEqual({ ok: false, message: 'Window watching is not available in this build' })
  })

  it('kills a watcher that fails, never answers, reports nonsense or is cancelled', async () => {
    const failing = fakeWatch({ ready: Promise.reject(new Error('window not found')) })
    expect(await startWindowWatch(api({ watch: () => failing.watch }), WINDOW)).toEqual({ ok: false, message: 'window not found' })
    expect(failing.calls).toContain('kill')

    const silent = fakeWatch({ ready: new Promise(() => undefined) })
    expect((await startWindowWatch(api({ watch: () => silent.watch }), WINDOW, 30)).ok).toBe(false)
    expect(silent.calls).toContain('kill')

    const nonsense = fakeWatch({ ready: Promise.resolve({ ...rect(T0), x: Number.NaN }) })
    expect((await startWindowWatch(api({ watch: () => nonsense.watch }), WINDOW)).ok).toBe(false)
    expect(nonsense.calls).toContain('kill')

    const abort = new AbortController()
    const slow = fakeWatch({ ready: new Promise(() => undefined) })
    const starting = startWindowWatch(api({ watch: () => slow.watch }), WINDOW, 10_000, abort.signal)
    abort.abort()
    expect(await starting).toEqual({ ok: false, message: 'The recording was cancelled' })
    expect(slow.calls).toContain('kill')
  })

  it('returns [] and kills a watcher that fails or hangs on stop', async () => {
    const failing = fakeWatch({ stop: () => Promise.reject(new Error('crashed')) })
    expect(await stopWindowWatch(failing.watch)).toEqual([])
    expect(failing.calls).toEqual(['stop', 'kill'])
    const hanging = fakeWatch({ stop: () => new Promise(() => undefined) })
    expect(await stopWindowWatch(hanging.watch, 30)).toEqual([])
    expect(hanging.calls).toEqual(['stop', 'kill'])
  })
})

describe('planWindowCapture (route selection)', () => {
  it('(a) records natively when the helper can capture windows without the cursor', async () => {
    const a = api({ native: true, watch: () => fakeWatch().watch })
    expect(await planWindowCapture(a, WINDOW)).toEqual({ method: 'native' })
    // No watcher is needed: the helper reports the rectangles itself.
    expect(a.watched).toEqual([])
  })

  it('(b) falls back to Chromium capture with a watcher', async () => {
    const { watch } = fakeWatch()
    const route = await planWindowCapture(api({ native: false, watch: () => watch }), WINDOW)
    expect(route).toMatchObject({ method: 'chromium', watch, first: rect(T0) })
  })

  it('(c) falls back to Chromium capture without cursor data when nothing can follow the window', async () => {
    expect(await planWindowCapture(api({ native: false }), WINDOW)).toMatchObject({ method: 'chromium', watch: null })
    expect(await planWindowCapture(api({ omit: true }), WINDOW)).toMatchObject({ method: 'chromium', watch: null })
    const broken = fakeWatch({ ready: Promise.reject(new Error('exit 4')) })
    expect(await watchForChromium(api({ watch: () => broken.watch }), WINDOW)).toEqual({ method: 'chromium', watch: null, reason: 'exit 4' })
  })
})

describe('windowCaptureSupport (the hint on Home)', () => {
  it('says what window recordings get, checked once per helper', async () => {
    const native = api({ native: true })
    expect(await windowCaptureSupport(native, 'window:1:0')).toEqual({ effects: true, smoothCursor: true })

    const { watch, calls } = fakeWatch()
    const watched = api({ native: false, watch: () => watch })
    expect(await windowCaptureSupport(watched, 'window:1:0')).toEqual({ effects: true, smoothCursor: false })
    expect(watched.watched).toEqual(['window:1:0'])
    await vi.waitFor(() => expect(calls).toContain('stop'))
    // Cached: no second watcher.
    expect(await windowCaptureSupport(watched, 'window:1:0')).toEqual({ effects: true, smoothCursor: false })
    expect(watched.watched).toHaveLength(1)

    expect(await windowCaptureSupport(api({ native: false }), 'window:1:0')).toEqual({ effects: false, smoothCursor: false })
    expect(await windowCaptureSupport(api({ native: false, watch: () => fakeWatch().watch }), null)).toEqual({ effects: false, smoothCursor: false })
  })
})

function manifest(over: Partial<RecordingManifest> = {}): RecordingManifest {
  return {
    version: 1,
    id: 'rec-test',
    createdAt: new Date(T0).toISOString(),
    status: 'recording',
    error: null,
    method: 'chromium',
    sourceKind: 'window',
    region: null,
    startedAt: T0,
    width: 800,
    height: 400,
    hasAudio: false,
    hasWebcam: false,
    webcamFps: 30,
    webcamOffset: 0,
    audioOffset: 0,
    duration: null,
    ...over
  }
}

function nativeSession(stop: () => Promise<NativeStopInfo>): NativeCaptureSession {
  return { started: Promise.resolve({ startedAt: T0, width: 800, height: 400 }), pause() {}, resume() {}, stop, kill() {} }
}

describe('ActiveRecording window rectangles', () => {
  it('come from the native helper', async () => {
    const s = new ActiveRecording(manifest(), '/tmp', WINDOW)
    s.attachNative(nativeSession(async () => ({ frames: 1, shapes: [], windowRects: [rect(T0), rect(T0 + 500, 0)] })), { startedAt: T0, width: 800, height: 400 })
    s.stop(T0 + 1000)
    expect(await s.windowRects()).toEqual([rect(T0), rect(T0 + 500, 0)])
  })

  it('survive a helper that failed (attached to its error, like the cursor shapes)', async () => {
    const err = Object.assign(new Error('crashed'), { shapes: [], windowRects: [rect(T0)] })
    const s = new ActiveRecording(manifest(), '/tmp', WINDOW)
    s.attachNative(nativeSession(() => Promise.reject(err)), { startedAt: T0, width: 800, height: 400 })
    s.stop(T0 + 1000)
    expect(await s.windowRects()).toEqual([rect(T0)])
  })

  it('come from the watcher, stopped with the recording; its first rectangle when it cannot report them', async () => {
    const ok = fakeWatch()
    const s = new ActiveRecording(manifest(), '/tmp', WINDOW)
    s.attachWatch(ok.watch, rect(T0))
    expect(s.watchesWindow).toBe(true)
    s.stop(T0 + 1000)
    expect(ok.calls).toEqual(['stop'])
    expect(await s.windowRects()).toEqual([rect(T0), rect(T0 + 1000, 300)])

    const failing = fakeWatch({ stop: () => Promise.reject(new Error('gone')) })
    const t = new ActiveRecording(manifest(), '/tmp', WINDOW)
    t.attachWatch(failing.watch, rect(T0 - 5))
    t.stop(T0 + 1000)
    expect(await t.windowRects()).toEqual([rect(T0 - 5)])
  })

  it('kills the watcher when the recording is discarded, or attached after it stopped', () => {
    const a = fakeWatch()
    const s = new ActiveRecording(manifest(), '/tmp', WINDOW)
    s.attachWatch(a.watch, rect(T0))
    s.killWatch()
    expect(a.calls).toEqual(['kill'])
    expect(s.watchesWindow).toBe(false)

    const late = fakeWatch()
    s.stop(T0)
    s.attachWatch(late.watch, rect(T0))
    expect(late.calls).toEqual(['kill'])
  })

  it('are empty for an untracked window', async () => {
    const s = new ActiveRecording(manifest(), '/tmp', WINDOW)
    s.stop(T0)
    expect(await s.windowRects()).toEqual([])
  })
})
