import { chmodSync, mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import path from 'node:path'
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'

interface FakeDisplay {
  id: number
  bounds: { x: number; y: number; width: number; height: number }
  scaleFactor: number
  nativeOrigin: { x: number; y: number }
}

type QuitEvent = { preventDefault(): void }

const electron = vi.hoisted(() => ({
  displays: [] as FakeDisplay[],
  primary: 1,
  isPackaged: false,
  appPath: '',
  willQuit: [] as ((e: QuitEvent) => void)[],
  quits: 0
}))

vi.mock('electron', () => ({
  app: {
    get isPackaged() {
      return electron.isPackaged
    },
    getAppPath: () => electron.appPath,
    prependListener: (name: string, fn: (e: QuitEvent) => void) => {
      if (name === 'will-quit') electron.willQuit.unshift(fn)
    },
    quit: () => {
      electron.quits++
    }
  },
  screen: {
    getAllDisplays: () => electron.displays,
    getPrimaryDisplay: () => electron.displays.find((d) => d.id === electron.primary),
    dipToScreenRect: (_w: unknown, r: unknown) => r
  }
}))

import {
  isNativeCaptureAvailable,
  isNativeWindowCaptureAvailable,
  matchMonitor,
  nativeCaptureTimeouts,
  probeNativeCapture,
  recordSpawnOptions,
  resetNativeCaptureCache,
  startNativeCapture,
  stopAllNativeCaptures,
  watchWindow,
  windowHandleOf,
  type HelperMonitor,
  type NativeCaptureError,
  type NativeCaptureSession,
  type NativeEndedInfo,
  type PhysicalDisplay,
  type WindowRectEvent,
  type WindowWatchSession
} from '../src/main/nativeCapture'

const FAKE = path.resolve(__dirname, 'fixtures/fake-capture-helper.cjs')
const ENV_KEYS = [
  'SSW_CAPTURE_HELPER',
  'FAKE_HELPER_PROBE',
  'FAKE_HELPER_MONITORS',
  'FAKE_HELPER_RECORD',
  'FAKE_HELPER_VIDEO',
  'FAKE_HELPER_LOG',
  'FAKE_HELPER_SHAPES',
  'FAKE_HELPER_END_AFTER_MS',
  'FAKE_HELPER_WINDOW_CAPTURE',
  'FAKE_HELPER_WINDOW_RECTS',
  'FAKE_HELPER_WATCH'
]
const DEFAULT_TIMEOUTS = { ...nativeCaptureTimeouts }
const sleep = (ms: number): Promise<void> => new Promise((r) => setTimeout(r, ms))

let dir = ''
let logFile = ''
const sessions: NativeCaptureSession[] = []
const watches: WindowWatchSession[] = []

function display(id: number, x: number, y: number, width: number, height: number, scaleFactor = 1): FakeDisplay {
  return { id, bounds: { x, y, width, height }, scaleFactor, nativeOrigin: { x, y } }
}

function monitor(index: number, x: number, y: number, width: number, height: number, primary = false): HelperMonitor {
  return { index, device: `\\\\.\\DISPLAY${index + 1}`, name: `Monitor ${index + 1}`, x, y, width, height, primary }
}

function physical(id: string, x: number, y: number, width: number, height: number, primary = false): PhysicalDisplay {
  return { id, x, y, width, height, primary }
}

/** Everything the fake helper logged: argv per invocation and stdin lines. */
function helperLog(): { argv?: string[]; pid?: number; stdin?: string }[] {
  try {
    return readFileSync(logFile, 'utf8')
      .split('\n')
      .filter(Boolean)
      .map((l) => JSON.parse(l))
  } catch {
    return []
  }
}

/** Commands the fake helper read (stdin closing right after "stop" may or may not be seen). */
function stdinLines(): string[] {
  return helperLog().flatMap((e) => (e.stdin && e.stdin !== '<eof>' ? [e.stdin] : []))
}

function recordPid(): number | undefined {
  return helperLog().find((e) => e.argv?.[0] === 'record')?.pid
}

function watchPid(): number | undefined {
  return helperLog().find((e) => e.argv?.[0] === 'watch-window')?.pid
}

function alive(pid: number | undefined): boolean {
  if (!pid) return false
  try {
    process.kill(pid, 0)
    return true
  } catch {
    return false
  }
}

async function waitFor(cond: () => boolean, ms = 3000): Promise<void> {
  const end = Date.now() + ms
  while (!cond()) {
    if (Date.now() > end) throw new Error('timed out waiting for condition')
    await sleep(20)
  }
}

function start(opts: Partial<{ displayId: string; fps: 30 | 60; bitrate: number }> = {}): NativeCaptureSession {
  const s = startNativeCapture({ displayId: '1', output: path.join(dir, 'screen.mp4'), fps: 30, ...opts })
  sessions.push(s)
  return s
}

beforeEach(() => {
  dir = mkdtempSync(path.join(tmpdir(), 'ssw-native-'))
  logFile = path.join(dir, 'helper.log')
  for (const k of ENV_KEYS) delete process.env[k]
  process.env.SSW_CAPTURE_HELPER = FAKE
  process.env.FAKE_HELPER_LOG = logFile
  electron.displays = [display(1, 0, 0, 1920, 1080)]
  electron.primary = 1
  electron.isPackaged = false
  electron.appPath = dir
  Object.assign(nativeCaptureTimeouts, DEFAULT_TIMEOUTS)
  resetNativeCaptureCache()
})

afterEach(async () => {
  for (const w of watches.splice(0)) w.kill()
  const left = sessions.splice(0)
  for (const s of left) s.kill()
  // Settled once each helper process is gone, so no test sees another's helper as running.
  await Promise.allSettled(left.map((s) => s.stop()))
  for (const k of ENV_KEYS) delete process.env[k]
  rmSync(dir, { recursive: true, force: true })
})

describe('matchMonitor', () => {
  const monitors = [monitor(0, 0, 0, 1920, 1080, true), monitor(1, 1920, -360, 2560, 1440)]

  it('matches by physical rectangle', () => {
    const displays = [physical('10', 0, 0, 1920, 1080, true), physical('11', 1920, -360, 2560, 1440)]
    expect(matchMonitor('10', displays, monitors)?.device).toBe('\\\\.\\DISPLAY1')
    expect(matchMonitor('11', displays, monitors)?.device).toBe('\\\\.\\DISPLAY2')
  })

  it('tolerates DPI rounding of a pixel or two', () => {
    const displays = [physical('10', 0, 0, 1920, 1080, true), physical('11', 1921, -359, 2559, 1441)]
    expect(matchMonitor('11', displays, monitors)?.index).toBe(1)
  })

  it('falls back to the only monitor, then to a unique size', () => {
    expect(matchMonitor('7', [physical('7', 5, 5, 1280, 720, true)], [monitor(0, 0, 0, 1920, 1080, true)])?.index).toBe(0)
    // Origins disagree (scaled layout) but each size is unique.
    const displays = [physical('10', 0, 0, 1920, 1080, true), physical('11', 1280, 0, 2560, 1440)]
    expect(matchMonitor('11', displays, monitors)?.index).toBe(1)
  })

  it('refuses ambiguous or unknown displays', () => {
    const twins = [monitor(0, 0, 0, 1920, 1080, true), monitor(1, 1920, 0, 1920, 1080)]
    const displays = [physical('1', 0, 0, 1920, 1080, true), physical('2', 1900, 0, 1920, 1080)]
    expect(matchMonitor('2', displays, twins)).toBeNull()
    // The primary one is still identifiable by its exact rectangle.
    expect(matchMonitor('1', displays, twins)?.index).toBe(0)
    expect(matchMonitor('3', displays, twins)).toBeNull()
    expect(matchMonitor('1', displays, [])).toBeNull()
  })
})

describe('probe', () => {
  it('is unavailable without a helper on non-Windows', async () => {
    delete process.env.SSW_CAPTURE_HELPER
    const r = await probeNativeCapture()
    expect(r.supported).toBe(false)
    expect(r.reason).toMatch(/only available on Windows/)
    expect(await isNativeCaptureAvailable()).toBe(false)
  })

  it('reports a supported helper and caches availability', async () => {
    expect(await isNativeCaptureAvailable()).toBe(true)
    expect(await isNativeCaptureAvailable()).toBe(true)
    expect(helperLog().filter((e) => e.argv?.[0] === 'probe')).toHaveLength(1)
    const r = await probeNativeCapture()
    expect(r).toMatchObject({ supported: true, cursorToggle: true, borderToggle: true, hardwareEncoders: ['Fake H.264 Encoder MFT'] })
  })

  it('passes on the reason when capture is unsupported', async () => {
    process.env.FAKE_HELPER_PROBE = 'unsupported'
    const r = await probeNativeCapture()
    expect(r).toMatchObject({ supported: false, reason: 'Fake helper: capture unsupported' })
    expect(await isNativeCaptureAvailable()).toBe(false)
  })

  it('treats unparsable output, a hang or a missing helper as unavailable', async () => {
    process.env.FAKE_HELPER_PROBE = 'garbage'
    expect((await probeNativeCapture()).supported).toBe(false)

    process.env.FAKE_HELPER_PROBE = 'hang'
    nativeCaptureTimeouts.probe = 500
    const t0 = Date.now()
    const r = await probeNativeCapture()
    expect(r.supported).toBe(false)
    expect(r.reason).toMatch(/timed out/)
    expect(Date.now() - t0).toBeLessThan(3000)
    const pid = helperLog().find((e) => e.argv?.[0] === 'probe')?.pid
    await waitFor(() => !alive(pid))

    process.env.SSW_CAPTURE_HELPER = path.join(dir, 'missing.cjs')
    expect((await probeNativeCapture()).supported).toBe(false)
  })

  // The stand-in "exe" is a shell script, so this runs on POSIX only.
  it.skipIf(process.platform === 'win32')('finds ssw-capture.exe in the resources folder when packaged and native/bin in development', async () => {
    delete process.env.SSW_CAPTURE_HELPER
    const platform = Object.getOwnPropertyDescriptor(process, 'platform')!
    const resourcesPath = (process as { resourcesPath?: string }).resourcesPath
    // An executable script standing in for the exe (it is spawned directly).
    const script = `#!/bin/sh\necho '{"supported":true,"cursorToggle":true,"borderToggle":false,"reason":null,"from":"'$0'"}'\n`
    const install = (file: string): void => {
      mkdirSync(path.dirname(file), { recursive: true })
      writeFileSync(file, script)
      chmodSync(file, 0o755)
    }
    try {
      Object.defineProperty(process, 'platform', { value: 'win32' })
      expect((await probeNativeCapture()).reason).toMatch(/ssw-capture.exe\) is missing/)

      install(path.join(dir, 'native', 'bin', 'ssw-capture.exe'))
      expect(await probeNativeCapture()).toMatchObject({ supported: true, borderToggle: false })

      electron.isPackaged = true
      ;(process as { resourcesPath?: string }).resourcesPath = path.join(dir, 'resources')
      expect((await probeNativeCapture()).supported).toBe(false)
      install(path.join(dir, 'resources', 'native', 'ssw-capture.exe'))
      expect((await probeNativeCapture()).supported).toBe(true)
    } finally {
      Object.defineProperty(process, 'platform', platform)
      ;(process as { resourcesPath?: string }).resourcesPath = resourcesPath
    }
  })
})

describe('recording session', () => {
  it('starts, pauses, resumes and stops with cursor shapes', async () => {
    const s = start({ fps: 60, bitrate: 8_000_000 })
    const info = await s.started
    expect(info).toMatchObject({ width: 1920, height: 1080, fps: 60, encoder: 'Fake H.264 Encoder MFT', hardware: true })
    expect(Math.abs(info.startedAt - Date.now())).toBeLessThan(2000)

    // The app passes the instants it paused/resumed/stopped at; the helper cuts there.
    await sleep(300)
    const pauseAt = Date.now() - 20
    s.pause(pauseAt)
    await sleep(200)
    const resumeAt = Date.now() - 10
    s.resume(resumeAt)
    await sleep(300)
    const stopAt = Date.now() - 5
    const result = await s.stop(stopAt)
    const active = pauseAt - info.startedAt + (stopAt - resumeAt)
    expect(result.duration).toBeCloseTo(active / 1000, 3)
    expect(result.frames).toBe(Math.round((active / 1000) * 60))
    expect(result.dropped).toBe(0)
    expect(result.shapes.map((x) => x.shape)).toEqual(['arrow', 'text', 'pointer'])
    for (const x of result.shapes) expect(x.at).toBeGreaterThanOrEqual(info.startedAt)

    const record = helperLog().find((e) => e.argv?.[0] === 'record')
    expect(record?.argv).toEqual(['record', '--monitor', '\\\\.\\DISPLAY1', '--out', path.join(dir, 'screen.mp4'), '--fps', '60', '--bitrate', '8000000'])
    expect(stdinLines()).toEqual([`pause ${pauseAt}`, `resume ${resumeAt}`, `stop ${stopAt}`])
    await waitFor(() => !alive(record?.pid))
    expect(await s.stop()).toBe(result)
  })

  it('records the display the app asked for on a multi-monitor setup', async () => {
    electron.displays = [display(1, 0, 0, 1920, 1080), display(2, 1920, 0, 1280, 720, 2)]
    process.env.FAKE_HELPER_MONITORS = JSON.stringify([monitor(0, 0, 0, 1920, 1080, true), monitor(1, 1920, 0, 2560, 1440)])
    const s = start({ displayId: '2' })
    expect(await s.started).toMatchObject({ width: 2560, height: 1440 })
    expect(helperLog().find((e) => e.argv?.[0] === 'record')?.argv?.[2]).toBe('\\\\.\\DISPLAY2')
    await s.stop()
  })

  it('queues commands issued while the monitor is being looked up', async () => {
    const s = start()
    s.pause(Date.now())
    s.resume()
    await s.started
    const result = await s.stop()
    expect(result.frames).toBeGreaterThanOrEqual(0)
    expect(stdinLines().map((l) => l.split(' ')[0])).toEqual(['pause', 'resume', 'stop'])
  })

  it('rejects when no monitor matches the display', async () => {
    process.env.FAKE_HELPER_MONITORS = JSON.stringify([monitor(0, 0, 0, 1280, 1024, true), monitor(1, 1280, 0, 1280, 1024)])
    const s = start()
    await expect(s.started).rejects.toThrow(/No capture monitor matches display 1/)
    await expect(s.stop()).rejects.toThrow(/No capture monitor matches/)
    expect(recordPid()).toBeUndefined()
  })

  it('rejects with the helper error when capture cannot start', async () => {
    process.env.FAKE_HELPER_RECORD = 'fail-start'
    const s = start()
    await expect(s.started).rejects.toThrow(/exited with code 3: Fake helper: Windows.Graphics.Capture is not available/)
    await expect(s.stop()).rejects.toThrow(/not available/)
  })

  it('rejects with stderr when the helper crashes before the first frame', async () => {
    process.env.FAKE_HELPER_RECORD = 'crash'
    const s = start()
    await expect(s.started).rejects.toThrow(/exited with code 1: .*Direct3D 11 device failed: fake crash/)
  })

  it('rejects an invalid start and kills the helper', async () => {
    process.env.FAKE_HELPER_RECORD = 'bad-start'
    const s = start()
    await expect(s.started).rejects.toThrow(/invalid start/)
    await waitFor(() => !alive(recordPid()))
  })

  it('times out a helper that never delivers a frame, killing it', async () => {
    process.env.FAKE_HELPER_RECORD = 'never-start'
    nativeCaptureTimeouts.start = 1500
    const s = start()
    await expect(s.started).rejects.toThrow(/did not start within 1.5 s/)
    await waitFor(() => !alive(recordPid()))
    await expect(s.stop()).rejects.toThrow(/did not start/)
  })

  it('times out a helper that does not finish, killing it', async () => {
    process.env.FAKE_HELPER_RECORD = 'hang-on-stop'
    nativeCaptureTimeouts.stop = 800
    const s = start()
    await s.started
    await expect(s.stop()).rejects.toThrow(/did not finish within 0.8 s/)
    await waitFor(() => !alive(recordPid()))
  })

  it('rejects stop with the finalisation error', async () => {
    process.env.FAKE_HELPER_RECORD = 'error-on-stop'
    const s = start()
    await s.started
    await expect(s.stop()).rejects.toThrow(/exited with code 1: Finalising the MP4 failed: fake encoder error/)
  })

  it('keeps the result of a helper that ended on its own (monitor disconnected)', async () => {
    process.env.FAKE_HELPER_RECORD = 'close-early'
    const s = start()
    await s.started
    await waitFor(() => !alive(recordPid()))
    const result = await s.stop()
    expect(result.duration).toBeGreaterThanOrEqual(0.2)
    expect(result.duration).toBeLessThan(1)
    expect(result.frames).toBe(Math.round(result.duration! * 30))
    expect(result.shapes.length).toBeGreaterThan(0)
  })

  it('kill() ends a running helper and fails stop()', async () => {
    const s = start()
    await s.started
    const pid = recordPid()
    expect(alive(pid)).toBe(true)
    s.kill()
    await waitFor(() => !alive(pid))
    await expect(s.stop()).rejects.toThrow(/was stopped/)
  })

  it('kill() or stop() before the helper is spawned never spawns it', async () => {
    const killed = start()
    killed.kill()
    await expect(killed.started).rejects.toThrow(/was stopped/)

    const stopped = start()
    const result = await stopped.stop()
    expect(result).toEqual({ frames: 0, shapes: [] })
    await expect(stopped.started).rejects.toThrow(/stopped before it started/)

    await sleep(300)
    expect(recordPid()).toBeUndefined()
  })

  it('ignores commands after stop and unknown cursor shapes', async () => {
    process.env.FAKE_HELPER_SHAPES = 'arrow,sparkles,text'
    const s = start()
    await s.started
    await sleep(200)
    const result = await s.stop()
    s.pause()
    s.resume()
    expect(result.shapes.map((x) => x.shape)).toEqual(['arrow', 'text'])
    expect(stdinLines().filter((l) => l.startsWith('pause'))).toHaveLength(0)
  })

  it('fails cleanly when the helper is missing', async () => {
    process.env.SSW_CAPTURE_HELPER = path.join(dir, 'nope.cjs')
    const s = start()
    await expect(s.started).rejects.toThrow(/not available/)
  })

  it('reports whether the helper writes a crash-safe (fragmented) MP4', async () => {
    const s = start()
    // The fake does not say; the field is optional and absent then.
    expect((await s.started).fragmented).toBeUndefined()
    await s.stop()
  })
})

describe('spawning the record helper', () => {
  it('detaches it on Windows, so it outlives a crashed or killed app long enough to finalise', () => {
    const env = { A: '1' }
    expect(recordSpawnOptions(env, 'win32')).toEqual({ env, windowsHide: true, stdio: ['pipe', 'pipe', 'pipe'], detached: true })
    // Elsewhere a child is not killed with its parent anyway; keep it in the app's process group.
    expect(recordSpawnOptions(env, 'linux').detached).toBe(false)
  })
})

describe('helper ending on its own (onEnded)', () => {
  /** Collects onEnded notifications. */
  function track(s: NativeCaptureSession): NativeEndedInfo[] {
    const seen: NativeEndedInfo[] = []
    s.onEnded!((info) => seen.push(info))
    return seen
  }

  it('reports a closed capture (monitor unplugged) once, after the MP4 was finalised', async () => {
    process.env.FAKE_HELPER_RECORD = 'close-early'
    process.env.FAKE_HELPER_END_AFTER_MS = '300'
    const s = start()
    const seen = track(s)
    await s.started
    expect(seen).toEqual([])
    await waitFor(() => seen.length > 0)
    expect(seen).toEqual([{ reason: 'closed' }])
    expect(readFileSync(path.join(dir, 'screen.mp4'), 'utf8')).toBe('fake video')
    // The app then stops the recording as usual and gets the helper's result.
    const result = await s.stop()
    expect(result.duration).toBeGreaterThanOrEqual(0.3)
    await waitFor(() => !alive(recordPid()))
    await sleep(100)
    expect(seen).toHaveLength(1)
  })

  it('still reports an end that happened before the app subscribed', async () => {
    process.env.FAKE_HELPER_RECORD = 'close-early'
    const s = start()
    await s.started
    await waitFor(() => !alive(recordPid()))
    await sleep(50)
    const seen = track(s)
    await waitFor(() => seen.length > 0)
    expect(seen).toEqual([{ reason: 'closed' }])
  })

  it('honours pause, resume and stop until then; a stopped helper is not reported', async () => {
    process.env.FAKE_HELPER_RECORD = 'close-early'
    process.env.FAKE_HELPER_END_AFTER_MS = '1500'
    const s = start()
    const seen = track(s)
    await s.started
    s.pause()
    s.resume()
    const result = await s.stop()
    expect(result.frames).toBeGreaterThanOrEqual(0)
    expect(stdinLines().map((l) => l.split(' ')[0])).toEqual(['pause', 'resume', 'stop'])
    await sleep(200)
    expect(seen).toEqual([])
  })

  it('reports a fatal helper error with its message; stop() rejects with the shapes seen', async () => {
    process.env.FAKE_HELPER_RECORD = 'error-early'
    process.env.FAKE_HELPER_END_AFTER_MS = '300'
    const s = start()
    const seen = track(s)
    await s.started
    await waitFor(() => seen.length > 0)
    expect(seen[0].reason).toBe('error')
    expect(seen[0].error?.message).toMatch(/fake device removed/)
    const err = (await s.stop().then(
      () => null,
      (e: unknown) => e
    )) as NativeCaptureError
    expect(err.message).toMatch(/exited with code 1: Encoding a frame failed: fake device removed/)
    expect(err.shapes?.map((x) => x.shape)).toEqual(['arrow', 'text', 'pointer'])
    expect(seen).toHaveLength(1)
  })

  it('reports a helper that dies without a word as crashed', async () => {
    process.env.FAKE_HELPER_RECORD = 'crash-early'
    process.env.FAKE_HELPER_END_AFTER_MS = '300'
    const s = start()
    const seen = track(s)
    await s.started
    await waitFor(() => seen.length > 0)
    expect(seen[0].reason).toBe('crashed')
    expect(seen[0].error?.message).toMatch(/The capture helper was terminated \(SIGKILL\)/)
    await expect(s.stop()).rejects.toThrow(/terminated/)
  })

  it('does not report ends the app asked for, or helpers that never started', async () => {
    const stopped = start()
    const stoppedSeen = track(stopped)
    await stopped.started
    await stopped.stop()

    const killed = start()
    const killedSeen = track(killed)
    await killed.started
    killed.kill()
    await expect(killed.stop()).rejects.toThrow(/was stopped/)

    process.env.FAKE_HELPER_RECORD = 'fail-start'
    const failed = start()
    const failedSeen = track(failed)
    await expect(failed.started).rejects.toThrow()

    process.env.FAKE_HELPER_RECORD = 'never-start'
    nativeCaptureTimeouts.start = 500
    const hung = start()
    const hungSeen = track(hung)
    await expect(hung.started).rejects.toThrow(/did not start/)

    await sleep(200)
    expect([stoppedSeen, killedSeen, failedSeen, hungSeen]).toEqual([[], [], [], []])
  })

  it('keeps notifying other listeners when one throws', async () => {
    process.env.FAKE_HELPER_RECORD = 'close-early'
    const s = start()
    const error = vi.spyOn(console, 'error').mockImplementation(() => undefined)
    s.onEnded!(() => {
      throw new Error('listener bug')
    })
    const seen = track(s)
    await waitFor(() => seen.length > 0)
    expect(error).toHaveBeenCalled()
    error.mockRestore()
  })
})

describe('quitting the app', () => {
  it('stopAllNativeCaptures finalises running helpers instead of killing them', async () => {
    const s = start()
    const seen: NativeEndedInfo[] = []
    s.onEnded!((info) => seen.push(info))
    await s.started
    await stopAllNativeCaptures(5000)
    expect(stdinLines().map((l) => l.split(' ')[0])).toEqual(['stop'])
    expect(readFileSync(path.join(dir, 'screen.mp4'), 'utf8')).toBe('fake video')
    await expect(s.stop()).resolves.toMatchObject({ dropped: 0 })
    expect(seen).toEqual([])
    // Nothing left to stop.
    await stopAllNativeCaptures(10)
  })

  it('stopAllNativeCaptures kills a helper that does not finish in time', async () => {
    process.env.FAKE_HELPER_RECORD = 'hang-on-stop'
    const s = start()
    await s.started
    const t0 = Date.now()
    await stopAllNativeCaptures(400)
    expect(Date.now() - t0).toBeLessThan(2000)
    await waitFor(() => !alive(recordPid()))
    await expect(s.stop()).rejects.toThrow(/was stopped/)
  })

  it('postpones the first will-quit until running helpers are finalised, then quits', async () => {
    // Installed (prepended) with the first session of this file.
    expect(electron.willQuit).toHaveLength(1)
    const quit = (): number => {
      let prevented = 0
      for (const fn of [...electron.willQuit]) fn({ preventDefault: () => void prevented++ })
      return prevented
    }
    // No helper running: nothing to wait for.
    expect(quit()).toBe(0)

    const s = start()
    await s.started
    const quitsBefore = electron.quits
    expect(quit()).toBe(1)
    // A second quit while the helper finalises is held back too.
    expect(quit()).toBe(1)
    await waitFor(() => electron.quits === quitsBefore + 1)
    expect(stdinLines().map((l) => l.split(' ')[0])).toEqual(['stop'])
    await expect(s.stop()).resolves.toMatchObject({ dropped: 0 })
    expect(readFileSync(path.join(dir, 'screen.mp4'), 'utf8')).toBe('fake video')
    // The re-issued quit goes through.
    expect(quit()).toBe(0)
  })
})

describe('window source ids', () => {
  it('takes the handle from "window:<handle>:<n>"', () => {
    expect(windowHandleOf('window:4194316:0')).toBe('4194316')
    expect(windowHandleOf('window:131330:1')).toBe('131330')
    // Chromium prints the HWND as a signed integer.
    expect(windowHandleOf('window:-2147352318:0')).toBe('-2147352318')
    expect(windowHandleOf('window:0007:0')).toBe('7')
    expect(windowHandleOf('window:9223372036854775807:0')).toBe('9223372036854775807')
  })

  it('rejects anything else', () => {
    for (const bad of ['', 'screen:0:0', 'window:0:0', 'window:-0:0', 'window:abc:0', 'window:12', 'window:12:', ' window:12:0', 'window:12:0 ', 'window:1.5:0', 'window:0x20:0', 'window:9223372036854775808:0', 'window:12:0:1']) {
      expect(windowHandleOf(bad), bad).toBeNull()
    }
  })
})

/** A window timeline for the fake helper (see FAKE_HELPER_WINDOW_RECTS). */
function timeline(...entries: object[]): void {
  process.env.FAKE_HELPER_WINDOW_RECTS = JSON.stringify(entries)
}

const WINDOW = 'window:4194316:0'

function startWindow(opts: Partial<{ windowId: string; displayId: string; fps: 30 | 60 }> = {}): NativeCaptureSession {
  const s = startNativeCapture({ windowId: WINDOW, output: path.join(dir, 'window.mp4'), fps: 30, ...opts })
  sessions.push(s)
  return s
}

function watch(windowId = WINDOW): WindowWatchSession {
  const w = watchWindow(windowId)
  watches.push(w)
  return w
}

const rect = (r: WindowRectEvent): Omit<WindowRectEvent, 'at'> => ({ x: r.x, y: r.y, width: r.width, height: r.height, minimized: r.minimized })

describe('native window capture availability', () => {
  it('follows probe.windowCapture, sharing one probe with isNativeCaptureAvailable', async () => {
    expect(await isNativeWindowCaptureAvailable()).toBe(true)
    expect(await isNativeCaptureAvailable()).toBe(true)
    expect(helperLog().filter((e) => e.argv?.[0] === 'probe')).toHaveLength(1)
    expect(await probeNativeCapture()).toMatchObject({ supported: true, windowCapture: true })
  })

  it('is unavailable when the helper cannot capture windows, or cannot capture at all', async () => {
    process.env.FAKE_HELPER_WINDOW_CAPTURE = '0'
    expect(await isNativeCaptureAvailable()).toBe(true)
    expect(await isNativeWindowCaptureAvailable()).toBe(false)

    resetNativeCaptureCache()
    delete process.env.FAKE_HELPER_WINDOW_CAPTURE
    process.env.FAKE_HELPER_PROBE = 'unsupported'
    expect(await isNativeWindowCaptureAvailable()).toBe(false)
    expect((await probeNativeCapture()).windowCapture).toBe(false)

    resetNativeCaptureCache()
    delete process.env.SSW_CAPTURE_HELPER
    expect(await isNativeWindowCaptureAvailable()).toBe(false)
  })

  it('treats a helper that does not report it (older builds) as unable to capture windows', async () => {
    const old = path.join(dir, 'old-helper.cjs')
    writeFileSync(old, `process.stdout.write(JSON.stringify({ supported: true, cursorToggle: true, borderToggle: false, hardwareEncoders: [], reason: null }) + '\\n')\n`)
    process.env.SSW_CAPTURE_HELPER = old
    expect(await probeNativeCapture()).toMatchObject({ supported: true, windowCapture: false })
    expect(await isNativeWindowCaptureAvailable()).toBe(false)
  })
})

describe('recording a window', () => {
  it('records the window by handle and returns its rectangles over time', async () => {
    timeline(
      { after: 0, x: 100, y: 50, width: 801, height: 601 },
      { after: 120, x: 140, y: 60, width: 801, height: 601 },
      { after: 240, x: -9, y: -9, width: 160, height: 28, minimized: true },
      { after: 360, x: 140, y: 60, width: 1000, height: 600 }
    )
    const s = startWindow({ fps: 60 })
    const info = await s.started
    // The initial size, made even; later sizes are fitted into it.
    expect(info).toMatchObject({ width: 800, height: 600, fps: 60 })
    await sleep(600)
    const stopAt = Date.now()
    const result = await s.stop(stopAt)
    expect(result.windowRects?.map(rect)).toEqual([
      { x: 100, y: 50, width: 801, height: 601, minimized: false },
      { x: 140, y: 60, width: 801, height: 601, minimized: false },
      // Minimised: the last on-screen rectangle, flagged.
      { x: 140, y: 60, width: 801, height: 601, minimized: true },
      { x: 140, y: 60, width: 1000, height: 600, minimized: false }
    ])
    const times = result.windowRects!.map((r) => r.at)
    expect(times).toEqual([...times].sort((a, b) => a - b))
    expect(times[0]).toBeGreaterThanOrEqual(info.startedAt)
    expect(times[3]).toBeLessThanOrEqual(stopAt)
    expect(result.shapes.map((x) => x.shape)).toEqual(['arrow', 'text', 'pointer'])

    const argv = helperLog().find((e) => e.argv?.[0] === 'record')?.argv
    expect(argv).toEqual(['record', '--window', '4194316', '--out', path.join(dir, 'window.mp4'), '--fps', '60'])
    // No monitor lookup for a window.
    expect(helperLog().some((e) => e.argv?.[0] === 'list')).toBe(false)
    expect(stdinLines()).toEqual([`stop ${stopAt}`])
  })

  it('pauses and resumes like a monitor recording', async () => {
    timeline({ after: 0, x: 0, y: 0, width: 640, height: 480 })
    const s = startWindow()
    const info = await s.started
    await sleep(200)
    const pauseAt = Date.now()
    s.pause(pauseAt)
    await sleep(200)
    const resumeAt = Date.now()
    s.resume(resumeAt)
    await sleep(200)
    const stopAt = Date.now()
    const result = await s.stop(stopAt)
    expect(result.duration).toBeCloseTo((pauseAt - info.startedAt + stopAt - resumeAt) / 1000, 2)
    expect(result.windowRects).toHaveLength(1)
  })

  it('monitor recordings report no window rectangles', async () => {
    const s = start()
    await s.started
    expect((await s.stop()).windowRects).toBeUndefined()
  })

  it('rejects malformed window ids without running the helper', async () => {
    for (const windowId of ['screen:0:0', 'window:0:0', '4194316', 'window:abc:1']) {
      const s = startWindow({ windowId })
      await expect(s.started).rejects.toThrow(/Not a window source id/)
      await expect(s.stop()).rejects.toThrow(/Not a window source id/)
    }
    const both = startWindow({ displayId: '1' })
    await expect(both.started).rejects.toThrow(/either a display or a window/)
    await sleep(100)
    expect(recordPid()).toBeUndefined()
  })

  it('rejects with exit code 4 when the window does not exist', async () => {
    timeline({ closed: true })
    const s = startWindow()
    await expect(s.started).rejects.toThrow(/exited with code 4: Window 4194316 not found/)
  })

  it('ends on its own with "closed" when the window closes; the rectangles are kept', async () => {
    timeline({ after: 0, x: 10, y: 20, width: 300, height: 200 }, { after: 300, closed: true })
    const s = startWindow()
    const seen: NativeEndedInfo[] = []
    s.onEnded!((e) => seen.push(e))
    await s.started
    await waitFor(() => seen.length > 0)
    expect(seen).toEqual([{ reason: 'closed' }])
    const result = await s.stop()
    expect(result.duration).toBeGreaterThanOrEqual(0.25)
    expect(result.windowRects?.map(rect)).toEqual([{ x: 10, y: 20, width: 300, height: 200, minimized: false }])
    await waitFor(() => !alive(recordPid()))
  })

  it('attaches the rectangles to the error of a helper that failed after starting', async () => {
    timeline({ after: 0, x: 10, y: 20, width: 300, height: 200 }, { after: 100, x: 30, y: 20, width: 300, height: 200 })
    process.env.FAKE_HELPER_RECORD = 'error-early'
    process.env.FAKE_HELPER_END_AFTER_MS = '300'
    const s = startWindow()
    const seen: NativeEndedInfo[] = []
    s.onEnded!((e) => seen.push(e))
    await s.started
    await waitFor(() => seen.length > 0)
    expect(seen[0].reason).toBe('error')
    const err = (await s.stop().then(
      () => null,
      (e: unknown) => e
    )) as NativeCaptureError
    expect(err.message).toMatch(/fake device removed/)
    expect(err.windowRects?.map((r) => r.x)).toEqual([10, 30])
    expect(err.shapes?.length).toBeGreaterThan(0)
  })
})

describe('watching a window (watch-window)', () => {
  it('reports the first rectangle through ready, then every change until stop', async () => {
    timeline(
      { after: 0, x: 5, y: 6, width: 700, height: 500 },
      { after: 100, x: 50, y: 6, width: 700, height: 500 },
      { after: 200, x: 50, y: 6, width: 900, height: 500 }
    )
    const w = watch()
    const first = await w.ready
    expect(rect(first)).toEqual({ x: 5, y: 6, width: 700, height: 500, minimized: false })
    expect(Math.abs(first.at - Date.now())).toBeLessThan(2000)
    await sleep(400)
    const rects = await w.stop()
    expect(rects.map((r) => [r.x, r.width])).toEqual([
      [5, 700],
      [50, 700],
      [50, 900]
    ])
    expect(rects[0]).toEqual(first)
    expect(helperLog().find((e) => e.argv?.[0] === 'watch-window')?.argv).toEqual(['watch-window', '--window', '4194316'])
    expect(stdinLines()).toEqual(['stop'])
    await waitFor(() => !alive(watchPid()))
    expect(await w.stop()).toBe(rects)
  })

  it('keeps the rectangles of a window that closed while watched', async () => {
    timeline({ after: 0, x: 1, y: 2, width: 30, height: 40 }, { after: 150, closed: true })
    const w = watch()
    await w.ready
    await waitFor(() => !!watchPid() && !alive(watchPid()))
    expect((await w.stop()).map(rect)).toEqual([{ x: 1, y: 2, width: 30, height: 40, minimized: false }])
  })

  it('throws for a malformed id, or without a helper', () => {
    expect(() => watchWindow('screen:1:0')).toThrow(/Not a window source id/)
    expect(() => watchWindow('window:0:0')).toThrow(/Not a window source id/)
    delete process.env.SSW_CAPTURE_HELPER
    expect(() => watchWindow(WINDOW)).toThrow(/only available on Windows/)
  })

  it('rejects ready when the window does not exist (exit 4); stop still resolves', async () => {
    timeline({ closed: true })
    const w = watch()
    await expect(w.ready).rejects.toThrow(/exited with code 4.*Window 4194316 not found/)
    expect(await w.stop()).toEqual([])
  })

  it('rejects ready when the helper exits early, and leaves no process', async () => {
    timeline({ after: 0, x: 0, y: 0, width: 10, height: 10 })
    process.env.FAKE_HELPER_WATCH = 'crash'
    const w = watch()
    await expect(w.ready).rejects.toThrow(/exited with code 1.*fake watch-window crash/)
    await waitFor(() => !!watchPid() && !alive(watchPid()))
    expect(await w.stop()).toEqual([])
  })

  it('times out a helper that reports nothing, killing it', async () => {
    timeline({ after: 0, x: 0, y: 0, width: 10, height: 10 })
    process.env.FAKE_HELPER_WATCH = 'silent'
    nativeCaptureTimeouts.watchReady = 500
    const w = watch()
    await expect(w.ready).rejects.toThrow(/no window within 0.5 s/)
    await waitFor(() => !!watchPid() && !alive(watchPid()))
    expect(await w.stop()).toEqual([])
  })

  it('kills a helper that does not exit after stop, still resolving with the rectangles', async () => {
    timeline({ after: 0, x: 3, y: 4, width: 10, height: 10 })
    process.env.FAKE_HELPER_WATCH = 'hang-on-stop'
    nativeCaptureTimeouts.watchStop = 400
    const w = watch()
    await w.ready
    const t0 = Date.now()
    const rects = await w.stop()
    expect(Date.now() - t0).toBeLessThan(2500)
    expect(rects.map((r) => r.x)).toEqual([3])
    await waitFor(() => !alive(watchPid()))
  })

  it('kill() ends it at once; stop() afterwards resolves with what was reported', async () => {
    timeline({ after: 0, x: 7, y: 8, width: 10, height: 10 })
    const w = watch()
    await w.ready
    const pid = watchPid()
    expect(alive(pid)).toBe(true)
    w.kill()
    await waitFor(() => !alive(pid))
    expect((await w.stop()).map((r) => r.x)).toEqual([7])
  })

  it('stop() before the first rectangle rejects ready and resolves', async () => {
    timeline({ after: 0, x: 0, y: 0, width: 10, height: 10 })
    process.env.FAKE_HELPER_WATCH = 'silent'
    nativeCaptureTimeouts.watchStop = 300
    const w = watch()
    const rects = await w.stop()
    await expect(w.ready).rejects.toThrow(/stopped before the window was reported/)
    expect(rects).toEqual([])
    await waitFor(() => !!watchPid() && !alive(watchPid()))
  })
})
