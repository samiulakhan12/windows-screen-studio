// When the native helper fails to start, the session falls back to Chromium capture. Only the
// tiny loopback capture may be replaced: the camera (shown live in the bubble) must keep being
// recorded, and the microphone too.
import { afterEach, describe, expect, it, vi } from 'vitest'
import type { CapturePlan, RecordingApi, RecordingStartInfo } from '../src/shared/api/recording'

// Renderer code (DOM types): imported at run time so the Node typecheck of tests/ does not follow it.
const SESSION = '../src/renderer/src/recorder/session'
type Session = {
  acquire(): Promise<void>
  fallbackToChromium(): Promise<void>
  start(native: null): RecordingStartInfo
  dispose(): void
  readonly cameraTrack: unknown
  readonly warnings: string[]
}
const { RecordingSession } = (await import(/* @vite-ignore */ SESSION)) as { RecordingSession: new (api: RecordingApi, plan: CapturePlan, options: object) => Session }

class FakeTrack {
  readyState: 'live' | 'ended' = 'live'
  enabled = true
  constructor(readonly kind: 'audio' | 'video', readonly label: string) {}
  stop(): void {
    this.readyState = 'ended'
  }
  clone(): FakeTrack {
    return new FakeTrack(this.kind, `${this.label} clone`)
  }
  getSettings(): { width?: number; height?: number; frameRate?: number } {
    return this.kind === 'video' ? { width: 1920, height: 1080, frameRate: 30 } : {}
  }
  addEventListener(): void {}
}

class FakeStream {
  constructor(private readonly tracks: FakeTrack[] = []) {}
  getTracks(): FakeTrack[] {
    return this.tracks
  }
  getVideoTracks(): FakeTrack[] {
    return this.tracks.filter((t) => t.kind === 'video')
  }
  getAudioTracks(): FakeTrack[] {
    return this.tracks.filter((t) => t.kind === 'audio')
  }
}

class FakeRecorder {
  static isTypeSupported(): boolean {
    return true
  }
  state = 'inactive'
  ondataavailable: unknown = null
  onerror: unknown = null
  constructor(readonly stream: FakeStream) {}
  start(): void {
    this.state = 'recording'
  }
  stop(): void {
    this.state = 'inactive'
  }
  addEventListener(): void {}
}

class FakeAudioContext {
  resume = async (): Promise<void> => undefined
  close = async (): Promise<void> => undefined
  createMediaStreamDestination = (): { stream: FakeStream } => ({ stream: new FakeStream([new FakeTrack('audio', 'mixed')]) })
  createMediaStreamSource = (): { connect(): void } => ({ connect: () => undefined })
}

function setup(): { camera: FakeTrack; mic: FakeTrack; loopback: FakeStream } {
  const camera = new FakeTrack('video', 'camera')
  const mic = new FakeTrack('audio', 'mic')
  const loopback = new FakeStream([new FakeTrack('video', 'loopback video'), new FakeTrack('audio', 'loopback audio')])
  let displayCalls = 0
  vi.stubGlobal('MediaStream', FakeStream)
  vi.stubGlobal('MediaRecorder', FakeRecorder)
  vi.stubGlobal('AudioContext', FakeAudioContext)
  vi.stubGlobal('navigator', {
    mediaDevices: {
      getUserMedia: async (c: { video?: unknown }) => new FakeStream([c.video ? camera : mic]),
      // The first request is the native session's loopback; the second the fallback's full capture.
      getDisplayMedia: async () =>
        displayCalls++ === 0 ? loopback : new FakeStream([new FakeTrack('video', 'screen'), new FakeTrack('audio', 'system')])
    }
  })
  return { camera, mic, loopback }
}

const api = {
  appendRecordingChunk: async () => undefined,
  recordingOffsets: async () => undefined,
  dropRecordingStems: async () => undefined
} as unknown as RecordingApi
const plan: CapturePlan = { token: 't', method: 'native', stopShortcut: true, fps: 60 }

afterEach(() => vi.unstubAllGlobals())

describe('RecordingSession.fallbackToChromium', () => {
  it('keeps the camera and microphone and replaces only the loopback capture', async () => {
    const { camera, mic, loopback } = setup()
    const session = new RecordingSession(api, plan, { sourceId: 'screen:1:0', region: null, systemAudio: true, micId: 'm', cameraId: 'c', captureKeys: false })
    await session.acquire()
    const bubble = (session.cameraTrack as unknown as FakeTrack).clone()
    await session.fallbackToChromium()

    expect(camera.readyState).toBe('live')
    expect(mic.readyState).toBe('live')
    expect(loopback.getTracks().every((t) => t.readyState === 'ended')).toBe(true)
    expect(bubble.readyState).toBe('live')
    expect(session.cameraTrack).toBe(camera)

    const info = session.start(null)
    expect(info.method).toBe('chromium')
    expect(info.hasWebcam).toBe(true)
    expect(info.stems).toEqual(['system', 'mic'])
    expect(session.warnings).toEqual([])

    // Disposing still releases the camera and microphone.
    session.dispose()
    expect(camera.readyState).toBe('ended')
    expect(mic.readyState).toBe('ended')
  })
})
