import { execFileSync } from 'node:child_process'
import { existsSync, mkdtempSync, readFileSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import path from 'node:path'
import { describe, expect, it, vi } from 'vitest'

const root = vi.hoisted(() => ({ dir: '' }))
vi.mock('electron', () => ({ app: { getPath: () => root.dir } }))

import { ffmpegPath } from '../src/main/ffmpeg'
import type { NativeCaptureSession, NativeStartInfo, NativeStopInfo } from '../src/main/nativeCapture'
import * as projects from '../src/main/projects'
import { processRecording, RecordingError } from '../src/main/recording/finalize'
import { nativeCaptureTimeouts } from '../src/main/nativeCapture'
import { defaultStartTimeoutMs, nativeAvailable, startNativeVideo, stopNativeVideo, type NativeCaptureApi } from '../src/main/recording/nativeVideo'
import { ActiveRecording } from '../src/main/recording/session'
import { buildCursorTrack } from '../src/main/recording/trackMath'
import { windowMapping } from '../src/main/recording/windowCapture'

const T0 = 1_700_000_000_000

/** A scripted stand-in for the native helper that records how it was driven. */
function fakeSession(opts: { started?: Promise<NativeStartInfo>; stop?: () => Promise<NativeStopInfo> } = {}) {
  const calls: string[] = []
  const session: NativeCaptureSession = {
    started: opts.started ?? Promise.resolve({ startedAt: T0, width: 320, height: 240 }),
    pause: () => void calls.push('pause'),
    resume: () => void calls.push('resume'),
    stop: () => {
      calls.push('stop')
      return opts.stop ? opts.stop() : Promise.resolve({ frames: 10, shapes: [{ at: T0 + 500, shape: 'text' }] })
    },
    kill: () => void calls.push('kill')
  }
  return { session, calls }
}

function fakeApi(session: NativeCaptureSession | (() => never), available = true): NativeCaptureApi {
  return {
    isNativeCaptureAvailable: async () => available,
    startNativeCapture: () => (typeof session === 'function' ? session() : session)
  }
}

const opts = { displayId: '1', output: '/tmp/x.mp4', fps: 60 as const }

describe('startNativeVideo', () => {
  it('resolves with the helper start info', async () => {
    const { session } = fakeSession()
    const r = await startNativeVideo(fakeApi(session), opts)
    expect(r).toMatchObject({ ok: true, info: { startedAt: T0, width: 320, height: 240 } })
  })

  it('reports a failed start and kills the helper', async () => {
    const { session, calls } = fakeSession({ started: Promise.reject(new Error('WGC unsupported')) })
    expect(await startNativeVideo(fakeApi(session), opts)).toEqual({ ok: false, message: 'WGC unsupported' })
    expect(calls).toContain('kill')
  })

  it('gives up on a helper that never delivers a frame', async () => {
    const { session, calls } = fakeSession({ started: new Promise(() => undefined) })
    const r = await startNativeVideo(fakeApi(session), opts, 50)
    expect(r.ok).toBe(false)
    expect(calls).toContain('kill')
  })

  it('rejects an invalid video size and a throwing launcher', async () => {
    const { session } = fakeSession({ started: Promise.resolve({ startedAt: T0, width: 0, height: 0 }) })
    expect((await startNativeVideo(fakeApi(session), opts)).ok).toBe(false)
    const throwing = (): never => {
      throw new Error('helper missing')
    }
    expect(await startNativeVideo(fakeApi(throwing), opts)).toEqual({ ok: false, message: 'helper missing' })
  })
})

describe('native start budget (seams-5 / windows-5)', () => {
  it('never gives up before the helper start budget runs out', () => {
    expect(defaultStartTimeoutMs()).toBeGreaterThan(nativeCaptureTimeouts.start)
  })

  it('waits for a slow but legitimate start (9 s) instead of falling back', async () => {
    vi.useFakeTimers()
    try {
      const { session, calls } = fakeSession({
        started: new Promise((resolve) => setTimeout(() => resolve({ startedAt: T0, width: 320, height: 240 }), 9000))
      })
      const result = startNativeVideo(fakeApi(session), opts)
      await vi.advanceTimersByTimeAsync(9000)
      expect((await result).ok).toBe(true)
      expect(calls).not.toContain('kill')
    } finally {
      vi.useRealTimers()
    }
  })

  it('stops a helper that is still starting when the recording is cancelled', async () => {
    const { session, calls } = fakeSession({ started: new Promise(() => undefined) })
    const abort = new AbortController()
    const result = startNativeVideo(fakeApi(session), opts, undefined, abort.signal)
    abort.abort()
    expect(await result).toEqual({ ok: false, message: 'The recording was cancelled' })
    expect(calls).toContain('kill')
  })
})

describe('nativeAvailable', () => {
  it('treats errors and hangs as unavailable', async () => {
    const { session } = fakeSession()
    expect(await nativeAvailable(fakeApi(session, true))).toBe(true)
    expect(await nativeAvailable({ ...fakeApi(session), isNativeCaptureAvailable: () => Promise.reject(new Error('x')) })).toBe(false)
    expect(await nativeAvailable({ ...fakeApi(session), isNativeCaptureAvailable: () => new Promise(() => undefined) }, 30)).toBe(false)
  })
})

describe('stopNativeVideo', () => {
  it('kills a helper that does not finish in time', async () => {
    const { session, calls } = fakeSession({ stop: () => new Promise(() => undefined) })
    await expect(stopNativeVideo(session, undefined, 30)).rejects.toThrow(/did not stop/)
    expect(calls).toContain('kill')
  })
})

function manifest(over: Partial<projects.RecordingManifest> = {}): projects.RecordingManifest {
  return {
    version: 1,
    id: 'rec-test',
    createdAt: new Date(T0).toISOString(),
    status: 'recording',
    error: null,
    method: 'native',
    sourceKind: 'screen',
    region: null,
    startedAt: null,
    width: 0,
    height: 0,
    hasAudio: false,
    hasWebcam: false,
    webcamFps: 30,
    webcamOffset: 0,
    audioOffset: 0,
    duration: null,
    ...over
  }
}

describe('ActiveRecording with native capture', () => {
  it('drives pause/resume on the helper and keeps one pause timeline', async () => {
    const { session, calls } = fakeSession()
    const s = new ActiveRecording(manifest(), '/tmp')
    s.attachNative(session, { startedAt: T0, width: 320, height: 240 })
    expect(s.manifest).toMatchObject({ method: 'native', startedAt: T0, width: 320, height: 240 })
    s.pause(T0 + 1000)
    s.pause(T0 + 1100) // already paused: ignored
    s.resume(T0 + 3000)
    s.pause(T0 + 4000)
    s.stop(T0 + 5000) // stopping while paused closes the pause
    expect(calls).toEqual(['pause', 'resume', 'pause', 'stop'])
    expect(s.pauses).toEqual([
      { from: T0 + 1000, to: T0 + 3000 },
      { from: T0 + 4000, to: T0 + 5000 }
    ])
    expect(s.activeSeconds()).toBe(2)
    expect(await s.finishNative()).toEqual([{ at: T0 + 500, shape: 'text' }])
  })

  it('keeps going when the helper fails to stop cleanly', async () => {
    const { session, calls } = fakeSession({ stop: () => Promise.reject(new Error('crashed')) })
    const s = new ActiveRecording(manifest(), '/tmp')
    s.attachNative(session, { startedAt: T0, width: 320, height: 240 })
    s.stop(T0 + 1000)
    expect(await s.finishNative()).toEqual([])
    expect(calls).toContain('kill')
  })

  it('keeps the cursor shapes a crashed helper reported before it failed', async () => {
    const err = Object.assign(new Error('crashed'), { shapes: [{ at: T0 + 200, shape: 'pointer' as const }] })
    const { session } = fakeSession({ stop: () => Promise.reject(err) })
    const s = new ActiveRecording(manifest(), '/tmp')
    s.attachNative(session, { startedAt: T0, width: 320, height: 240 })
    s.stop(T0 + 1000)
    expect(await s.finishNative()).toEqual([{ at: T0 + 200, shape: 'pointer' }])
  })
})

const ffmpeg = ffmpegPath()
const haveFfmpeg = ffmpeg !== 'ffmpeg' && existsSync(ffmpeg)
const ffprobe = ['/usr/bin/ffprobe', '/usr/local/bin/ffprobe'].find((p) => existsSync(p))

function probeFrames(file: string): { r_frame_rate: string; frames: number } {
  const out = JSON.parse(
    execFileSync(ffprobe!, ['-v', 'error', '-count_frames', '-select_streams', 'v:0', '-show_entries', 'stream=r_frame_rate,nb_read_frames', '-of', 'json', file]).toString()
  )
  return { r_frame_rate: out.streams[0].r_frame_rate, frames: Number(out.streams[0].nb_read_frames) }
}

function probe(file: string): { streams: { codec_type: string; width?: number; height?: number; start_time?: string; duration?: string }[] } {
  return JSON.parse(execFileSync(ffprobe!, ['-v', 'error', '-show_streams', '-of', 'json', file]).toString())
}

describe.skipIf(!haveFfmpeg || !ffprobe)('processRecording (real ffmpeg)', () => {
  const gen = (args: string[]): void => void execFileSync(ffmpeg, ['-hide_banner', '-loglevel', 'error', '-y', ...args])

  it('builds a project from native video + separate audio with offset, region crop and cursor shapes', async () => {
    root.dir = mkdtempSync(path.join(tmpdir(), 'ssw-native-'))
    const { id, dir } = await projects.createProjectDir(new Date(T0))
    gen(['-f', 'lavfi', '-i', 'testsrc=size=320x240:rate=60:duration=2', '-c:v', 'libx264', '-g', '120', path.join(dir, 'native.mp4')])
    gen(['-f', 'lavfi', '-i', 'sine=frequency=440:duration=1', '-c:a', 'libopus', path.join(dir, 'audio.webm')])
    const m = manifest({
      id,
      startedAt: T0,
      width: 320,
      height: 240,
      hasAudio: true,
      region: { x: 0, y: 0, w: 0.5, h: 0.5 },
      audioOffset: 0.5,
      duration: 2,
      status: 'processing'
    })
    await projects.writeManifest(m)
    const track = buildCursorTrack(
      { samples: [{ at: T0 + 100, x: 80, y: 60 }], clicks: [{ at: T0 + 1000, x: 80, y: 60, button: 'left' }], keys: [], bounds: { x: 0, y: 0, width: 320, height: 240 }, scale: 1 },
      { startedAt: T0, pauses: [], duration: 2, region: m.region, shapes: [{ at: T0 + 700, shape: 'pointer' }], slack: 1 }
    )
    await projects.writeCursor(id, track)

    const progress: (number | null)[] = []
    const project = await processRecording(m, (p) => progress.push(p.progress))

    expect(project.capture).toEqual({ method: 'native', cursorInVideo: false, region: { x: 0, y: 0, w: 0.5, h: 0.5 }, target: 'area', fps: 60 })
    expect(project.cursor.show).toBe(true)
    expect([project.width, project.height]).toEqual([160, 120])
    expect(project.hasAudio).toBe(true)
    expect(project.duration).toBeGreaterThan(1.9)
    expect(project.duration).toBeLessThan(2.2)
    expect(project.zooms.length).toBeGreaterThan(0)
    expect(progress[0]).toBe(0)
    expect(progress.every((p) => p !== null && p >= 0 && p <= 1)).toBe(true)
    expect(progress.at(-1)).toBe(1)

    const streams = probe(path.join(dir, 'screen.mp4')).streams
    const video = streams.find((s) => s.codec_type === 'video')!
    const audio = streams.find((s) => s.codec_type === 'audio')!
    expect([video.width, video.height]).toEqual([160, 120])
    // 0.5 s of leading silence + 1 s tone, padded to the video: no track outlasts the video (seams-2).
    expect(Number(audio.duration)).toBeGreaterThan(1.4)
    expect(Number(audio.duration)).toBeLessThanOrEqual(Number(video.duration) + 0.001)
    expect(project.duration).toBeCloseTo(Number(video.duration), 3)
    expect(existsSync(path.join(dir, 'screen.video.mp4'))).toBe(false)

    const cursor = JSON.parse(readFileSync(path.join(dir, 'cursor.json'), 'utf8'))
    expect(cursor.shapes).toEqual([{ t: 0.7, shape: 'pointer' }])
    expect(cursor.clicks[0]).toMatchObject({ x: 0.5, y: 0.5 })
    expect(existsSync(path.join(dir, 'native.mp4'))).toBe(false)
    expect(existsSync(path.join(dir, 'audio.webm'))).toBe(false)
    expect(existsSync(path.join(dir, 'recording.json'))).toBe(false)
    expect(existsSync(path.join(dir, 'project.json'))).toBe(true)
  }, 60000)

  it('builds a native window recording: smooth cursor on, clicks mapped through the window, auto zooms', async () => {
    root.dir = mkdtempSync(path.join(tmpdir(), 'ssw-window-'))
    const { id, dir } = await projects.createProjectDir(new Date(T0))
    gen(['-f', 'lavfi', '-i', 'testsrc=size=640x360:rate=60:duration=2', '-c:v', 'libx264', '-g', '120', path.join(dir, 'native.mp4')])
    const m = manifest({ id, sourceKind: 'window', startedAt: T0, width: 640, height: 360, duration: 2, status: 'processing' })
    await projects.writeManifest(m)
    // The window is at (1000, 500) and moves to (0, 0) at 1 s.
    const rects = [
      { at: T0 - 50, x: 1000, y: 500, width: 640, height: 360 },
      { at: T0 + 1000, x: 0, y: 0, width: 640, height: 360 }
    ]
    const track = buildCursorTrack(
      {
        samples: [{ at: T0 + 100, x: 1320, y: 680 }],
        clicks: [
          { at: T0 + 500, x: 1160, y: 590, button: 'left' },
          { at: T0 + 600, x: 100, y: 100, button: 'left' }, // outside the window then: dropped
          { at: T0 + 1500, x: 480, y: 270, button: 'left' }
        ],
        keys: [],
        bounds: null,
        scale: 1
      },
      { startedAt: T0, pauses: [], duration: 2, region: null, slack: 1, window: windowMapping(rects, (r) => r, { width: 640, height: 360 }) }
    )
    await projects.writeCursor(id, track)
    const project = await processRecording(m, () => undefined)
    expect(project.capture).toEqual({ method: 'native', cursorInVideo: false, region: null, target: 'window', fps: 60 })
    expect(project.cursor.show).toBe(true)
    expect([project.width, project.height]).toEqual([640, 360])
    const cursor = JSON.parse(readFileSync(path.join(dir, 'cursor.json'), 'utf8'))
    expect(cursor.valid).toBe(true)
    expect(cursor.clicks.map((c: { x: number; y: number }) => [c.x, c.y])).toEqual([
      [0.25, 0.25],
      [0.75, 0.75]
    ])
    expect(project.zooms.length).toBeGreaterThan(0)
  }, 60000)

  it('processes a Chromium WebM, probing the real duration', async () => {
    root.dir = mkdtempSync(path.join(tmpdir(), 'ssw-chromium-'))
    const { id, dir } = await projects.createProjectDir(new Date(T0))
    gen([
      '-f', 'lavfi', '-i', 'testsrc=size=640x360:rate=30:duration=1.5',
      '-f', 'lavfi', '-i', 'sine=duration=1.5',
      '-c:v', 'libvpx', '-c:a', 'libopus', '-shortest', path.join(dir, 'screen.webm')
    ])
    // The renderer measured 0 s (e.g. the source closed); the proxy duration wins.
    const m = manifest({ id, method: 'chromium', startedAt: T0, width: 640, height: 360, hasAudio: true, duration: 0 })
    const project = await processRecording(m, () => undefined)
    expect(project.capture).toEqual({ method: 'chromium', cursorInVideo: true, region: null, target: 'screen', fps: 60 })
    expect(project.duration).toBeGreaterThan(1.4)
    expect(project.hasAudio).toBe(true)
    expect(existsSync(path.join(dir, 'screen.webm'))).toBe(false)
  }, 60000)

  it('keeps a 30 fps recording at 30 fps, with its exact duration, marks and typing bursts', async () => {
    root.dir = mkdtempSync(path.join(tmpdir(), 'ssw-30fps-'))
    const { id, dir } = await projects.createProjectDir(new Date(T0))
    gen(['-f', 'lavfi', '-i', 'testsrc=size=320x240:rate=30:duration=3', '-c:v', 'libx264', '-g', '60', path.join(dir, 'native.mp4')])
    const m = manifest({ id, startedAt: T0, width: 320, height: 240, duration: 3, fps: 30, status: 'processing' })
    await projects.writeManifest(m)
    const track = buildCursorTrack(
      {
        samples: [{ at: T0 + 100, x: 80, y: 60 }],
        clicks: [{ at: T0 + 2000, x: 160, y: 120, button: 'left' }],
        keys: [],
        marks: [T0 + 1000, T0 + 9000],
        typing: [T0 + 200, T0 + 400, T0 + 600, T0 + 800],
        bounds: { x: 0, y: 0, width: 320, height: 240 },
        scale: 1
      },
      { startedAt: T0, pauses: [], duration: 3, region: null, slack: 1 }
    )
    await projects.writeCursor(id, track)
    const project = await processRecording(m, () => undefined)
    expect(project.capture.fps).toBe(30)
    const video = probeFrames(path.join(dir, 'screen.mp4'))
    expect(video.r_frame_rate).toBe('30/1')
    expect(video.frames).toBe(90)
    expect(project.duration).toBeCloseTo(3, 2)
    // Marks and typing survive processing (the 9 s mark is past the end).
    const cursor = await projects.readCursor(id)
    expect(cursor.marks).toEqual([{ t: 1 }])
    expect(cursor.typing).toEqual([{ t: 0.2, end: 0.8 }])
    // Auto zoom comes from the whole track (clicks, and marks/typing as the zoom settings allow).
    expect(project.zooms.length).toBeGreaterThan(0)
  }, 60000)

  it('refuses an empty recording and keeps the folder for inspection', async () => {
    root.dir = mkdtempSync(path.join(tmpdir(), 'ssw-empty-'))
    const { id, dir } = await projects.createProjectDir(new Date(T0))
    writeFileSync(path.join(dir, 'screen.webm'), '')
    await expect(processRecording(manifest({ id, method: 'chromium' }), () => undefined)).rejects.toBeInstanceOf(RecordingError)
    expect(existsSync(dir)).toBe(true)
  })

  it('creates unique folders even within the same second', async () => {
    root.dir = mkdtempSync(path.join(tmpdir(), 'ssw-ids-'))
    const a = await projects.createProjectDir(new Date(T0))
    const b = await projects.createProjectDir(new Date(T0))
    expect(a.id).not.toBe(b.id)
    expect(b.id).toBe(`${a.id}-2`)
  })
})
