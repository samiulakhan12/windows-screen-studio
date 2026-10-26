import path from 'node:path'
import { describe, expect, it, vi } from 'vitest'

vi.mock('electron', () => ({ app: { getPath: () => '/tmp', isPackaged: false, getAppPath: () => '/tmp' } }))

import { nativeCaptureTimeouts, watchWindow, type NativeCaptureSession, type NativeStopInfo, type WindowRectEvent, type WindowWatchSession } from '../src/main/nativeCapture'
import type { RecordingManifest } from '../src/main/projects'
import { defaultWatchStopTimeoutMs, nativeWindowAvailable, startWindowWatch, stopWindowWatch, type NativeCaptureApi } from '../src/main/recording/nativeVideo'
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
    dipToScreenPoint: (p) => ({ x: Math.round(p.x * 1.5), y: Math.round(p.y * 1.5) }),
    getDisplayMatching: () => ({ scaleFactor: 1.5 })
  }

  it('maps in physical pixels on Windows, converting each DIP position back, so DIP clicks land on the right spot', () => {
    // The window is at (150, 75) physical, 1200 x 600: (100, 50) DIP, 800 x 400.
    const { mapping, scale } = windowCursorMapping([rect(T0 - 10, 150, 75, 1200, 600)], { width: 1200, height: 600 }, screen150, 'win32')
    expect(scale).toBe(1.5)
    expect(mapping!.poses[0].dip).toEqual({ x: 150, y: 75, width: 1200, height: 600 })
    const track = buildCursorTrack(
      { samples: [{ at: T0, x: 500, y: 250 }], clicks: [{ at: T0 + 100, x: 300, y: 150, button: 'left' }], keys: [], bounds: null, scale: 1 },
      { startedAt: T0, pauses: [], duration: 1, region: null, window: mapping }
    )
    expect(track.clicks[0]).toMatchObject({ x: 0.25, y: 0.25 })
    expect(track.samples[0]).toMatchObject({ x: 0.5, y: 0.5 })
  })

  it('keeps the rectangles as they are where both spaces are the same pixels (X11)', () => {
    const { mapping } = windowCursorMapping([rect(T0, 150, 75, 1200, 600)], { width: 1200, height: 600 }, screen150, 'linux')
    expect(mapping!.poses[0].dip).toEqual({ x: 150, y: 75, width: 1200, height: 600 })
    expect(mapping!.pointToScreen).toBeUndefined()
  })

  /**
   * Electron's screen (Chromium ScreenWin) with two monitors: A at 100%, physical and DIP
   * (0, 0) 1920 x 1080; B at 150% to its right, physical (1920, 0) 3840 x 2160, DIP (1920, 0)
   * 2560 x 1440. Points convert on the monitor that holds them; a rectangle converts as a
   * whole on the monitor it overlaps most (MonitorFromRect).
   */
  const mixed = (() => {
    const monitors = [
      { phys: { x: 0, y: 0, width: 1920, height: 1080 }, dip: { x: 0, y: 0, width: 1920, height: 1080 }, scale: 1 },
      { phys: { x: 1920, y: 0, width: 3840, height: 2160 }, dip: { x: 1920, y: 0, width: 2560, height: 1440 }, scale: 1.5 }
    ]
    const overlap = (a: Rect, b: Rect): number =>
      Math.max(0, Math.min(a.x + a.width, b.x + b.width) - Math.max(a.x, b.x)) * Math.max(0, Math.min(a.y + a.height, b.y + b.height) - Math.max(a.y, b.y))
    const holding = (p: { x: number; y: number }, space: 'phys' | 'dip') => monitors.find((m) => p.x < m[space].x + m[space].width) ?? monitors[1]
    const screen: DipScreen & { screenToDipPoint(p: { x: number; y: number }): { x: number; y: number } } = {
      screenToDipPoint: (p) => {
        const m = holding(p, 'phys')
        return { x: m.dip.x + (p.x - m.phys.x) / m.scale, y: m.dip.y + (p.y - m.phys.y) / m.scale }
      },
      dipToScreenPoint: (p) => {
        const m = holding(p, 'dip')
        return { x: Math.round(m.phys.x + (p.x - m.dip.x) * m.scale), y: Math.round(m.phys.y + (p.y - m.dip.y) * m.scale) }
      },
      screenToDipRect: (_w, r) => {
        const m = [...monitors].sort((a, b) => overlap(r, b.phys) - overlap(r, a.phys))[0]
        return { x: m.dip.x + (r.x - m.phys.x) / m.scale, y: m.dip.y + (r.y - m.phys.y) / m.scale, width: r.width / m.scale, height: r.height / m.scale }
      },
      getDisplayMatching: (r) => ({ scaleFactor: [...monitors].sort((a, b) => overlap(r, b.dip) - overlap(r, a.dip))[0].scale })
    }
    return screen
  })()

  it('maps a window straddling a 100% and a 150% monitor exactly on both, dropping no click (mapping-1)', () => {
    // Physical x 1500..2700, y 100..900: 420 px on A, 780 px on B (B holds most of it).
    const { mapping, scale } = windowCursorMapping([rect(T0 - 10, 1500, 100, 1200, 800)], { width: 1200, height: 800 }, mixed, 'win32')
    expect(scale).toBe(1.5)
    // Positions as the app captures them: DIP, converted on the monitor holding each point.
    const xs = [1510, 1550, 1700, 1900, 1919, 1921, 2100, 2690]
    const dip = (x: number, y: number) => mixed.screenToDipPoint({ x, y })
    const track = buildCursorTrack(
      {
        samples: xs.map((x, i) => ({ at: T0 + 10 * i, ...dip(x, 300) })),
        clicks: xs.map((x, i) => ({ at: T0 + 10 * i, ...dip(x, 500), button: 'left' as const })),
        keys: [],
        bounds: null,
        scale: 1
      },
      { startedAt: T0, pauses: [], duration: 1, region: null, window: mapping }
    )
    expect(track.clicks).toHaveLength(xs.length)
    track.clicks.forEach((c, i) => {
      expect(c.x).toBeCloseTo((xs[i] - 1500) / 1200, 2)
      expect(c.y).toBeCloseTo(0.5, 2)
    })
    for (const [i, x] of xs.entries()) {
      const s = track.samples.find((p) => Math.abs(p.t - (10 * i) / 1000) < 1e-9)!
      expect(s.x).toBeCloseTo((x - 1500) / 1200, 2)
      expect(s.y).toBeCloseTo(0.25, 2)
    }
  })

  it('maps scrolls through pointToScreen exactly like clicks on a window straddling a 100% and a 150% monitor', () => {
    const { mapping } = windowCursorMapping([rect(T0 - 10, 1500, 100, 1200, 800)], { width: 1200, height: 800 }, mixed, 'win32')
    const xs = [1510, 1700, 1919, 1921, 2100, 2690]
    const dip = (x: number, y: number) => mixed.screenToDipPoint({ x, y })
    const track = buildCursorTrack(
      {
        samples: [{ at: T0, ...dip(1600, 300) }],
        clicks: xs.map((x, i) => ({ at: T0 + 100 * i, ...dip(x, 500), button: 'left' as const, up: T0 + 100 * i + 40 })),
        scrolls: xs.map((x, i) => ({ at: T0 + 100 * i + 50, ...dip(x, 500), dx: 0, dy: i % 2 ? -1 : 1 })),
        keys: [],
        bounds: null,
        scale: 1
      },
      { startedAt: T0, pauses: [], duration: 1, region: null, window: mapping }
    )
    expect(track.scrolls).toHaveLength(xs.length)
    track.scrolls!.forEach((s, i) => {
      expect(s.x).toBeCloseTo(track.clicks[i].x, 9)
      expect(s.y).toBeCloseTo(track.clicks[i].y, 9)
      expect(s.x).toBeCloseTo((xs[i] - 1500) / 1200, 2)
      expect(s.dy).toBe(i % 2 ? -1 : 1)
      expect(track.clicks[i].up! - track.clicks[i].t).toBeCloseTo(0.04, 9)
    })
  })

  it('looks up the cursor size on the monitor holding most of the window', () => {
    expect(windowCursorMapping([rect(T0, 100, 100, 1200, 800)], { width: 1200, height: 800 }, mixed, 'win32').scale).toBe(1)
    expect(windowCursorMapping([rect(T0, 1800, 100, 1200, 800)], { width: 1200, height: 800 }, mixed, 'win32').scale).toBe(1.5)
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
    expect(await stopWindowWatch(hanging.watch, 30, 30)).toEqual([])
    expect(hanging.calls).toEqual(['stop', 'kill'])
  })

  it('keeps what a watcher collected when it is killed for not stopping in time (mapping-4)', async () => {
    // Like the real client: stop() resolves with the rectangles once the killed process is gone.
    let killed: () => void = () => undefined
    const gone = new Promise<void>((resolve) => (killed = resolve))
    const watch: WindowWatchSession = {
      ready: Promise.resolve(rect(T0)),
      stop: () => gone.then(() => [rect(T0), rect(T0 + 700, 400)]),
      kill: () => setTimeout(killed, 5)
    }
    expect(await stopWindowWatch(watch, 30)).toEqual([rect(T0), rect(T0 + 700, 400)])
  })

  it('leaves the real watcher client time to kill a hung helper and hand over its timeline (mapping-4)', async () => {
    expect(defaultWatchStopTimeoutMs()).toBeGreaterThan(nativeCaptureTimeouts.watchStop)
    const saved = { ...nativeCaptureTimeouts }
    const keys = ['SSW_CAPTURE_HELPER', 'FAKE_HELPER_WINDOW_RECTS', 'FAKE_HELPER_WATCH'] as const
    const env = Object.fromEntries(keys.map((k) => [k, process.env[k]]))
    try {
      process.env.SSW_CAPTURE_HELPER = path.resolve(__dirname, 'fixtures/fake-capture-helper.cjs')
      process.env.FAKE_HELPER_WINDOW_RECTS = JSON.stringify([
        { after: 0, x: 3, y: 4, width: 10, height: 10 },
        { after: 100, x: 30, y: 4, width: 10, height: 10 }
      ])
      process.env.FAKE_HELPER_WATCH = 'hang-on-stop'
      nativeCaptureTimeouts.watchStop = 300
      const w = watchWindow(WINDOW)
      await w.ready
      await new Promise((r) => setTimeout(r, 400))
      // Both guards used to be equal, so the outer one always won and returned [].
      const rects = await stopWindowWatch(w)
      expect(rects.map((r) => r.x)).toEqual([3, 30])
    } finally {
      Object.assign(nativeCaptureTimeouts, saved)
      for (const k of keys) {
        if (env[k] === undefined) delete process.env[k]
        else process.env[k] = env[k]
      }
    }
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

  it('asks again after a negative answer: a slow first start of the helper is not remembered (ux-4)', async () => {
    let attempt = 0
    const flaky = api({
      native: false,
      watch: () => (++attempt === 1 ? fakeWatch({ ready: Promise.reject(new Error('did not answer in time')) }) : fakeWatch()).watch
    })
    expect(await windowCaptureSupport(flaky, 'window:1:0')).toEqual({ effects: false, smoothCursor: false })
    expect(await windowCaptureSupport(flaky, 'window:1:0')).toEqual({ effects: true, smoothCursor: false })
    expect(await windowCaptureSupport(flaky, 'window:1:0')).toEqual({ effects: true, smoothCursor: false })
    expect(flaky.watched).toHaveLength(2)
  })

  it('gives the probe watcher the same budget as a recording (ux-4)', async () => {
    vi.useFakeTimers()
    try {
      let answer: (r: WindowRectEvent) => void = () => undefined
      const slow = fakeWatch({ ready: new Promise((resolve) => (answer = resolve)) })
      const check = windowCaptureSupport(api({ native: false, watch: () => slow.watch }), 'window:1:0')
      // Slower than the old 3 s probe budget, within the recording's 5 s.
      await vi.advanceTimersByTimeAsync(4000)
      answer(rect(T0))
      expect(await check).toEqual({ effects: true, smoothCursor: false })
    } finally {
      vi.useRealTimers()
    }
  })

  it('says effects once a recording was followed by a watcher', async () => {
    let attempt = 0
    const a = api({
      native: false,
      watch: () => (++attempt === 1 ? fakeWatch({ ready: Promise.reject(new Error('slow')) }) : fakeWatch()).watch
    })
    expect(await windowCaptureSupport(a, null)).toEqual({ effects: false, smoothCursor: false })
    expect((await planWindowCapture(a, WINDOW)).method).toBe('chromium')
    expect(await windowCaptureSupport(a, null)).toEqual({ effects: false, smoothCursor: false })
    expect(await planWindowCapture(a, WINDOW)).toMatchObject({ method: 'chromium', first: rect(T0) })
    expect(await windowCaptureSupport(a, null)).toEqual({ effects: true, smoothCursor: false })
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
