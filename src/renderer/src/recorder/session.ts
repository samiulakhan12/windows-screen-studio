import type { CapturePlan, RecordingApi, RecordingStartInfo, SaveRecordingPayload, TrackKind } from '../../../shared/api/recording'
import { STEM_KINDS, type StemKind } from '../../../shared/audio/settings'
import type { NormRect } from '../../../shared/types'
import { ChunkPipe } from '../../../shared/recording/chunkPipe'
import { captureDisplay, SYSTEM_AUDIO_WARNING } from '../../../shared/recording/displayCapture'
import { friendlyError, RecorderError, SOURCE_GONE, type DeviceKind } from '../../../shared/recording/errors'
import { epochNow, nextFrameSize, nextFrameTime, syncEpoch } from './firstFrame'
import { AUDIO_MIMES, CAMERA_MIMES, pickMime, screenBitrate, screenMimes } from '../../../shared/recording/mime'

export interface SessionOptions {
  sourceId: string
  region: NormRect | null
  systemAudio: boolean
  micId: string | null
  cameraId: string | null
  captureKeys: boolean
}

/** One-second chunks keep at most ~1 s of media per track in flight. */
const TIMESLICE_MS = 1000

interface Track {
  kind: TrackKind
  recorder: MediaRecorder
  pipe: ChunkPipe
}

const isSupported = (mime: string): boolean => MediaRecorder.isTypeSupported(mime)
const isStem = (kind: TrackKind): kind is StemKind => kind === 'mic' || kind === 'system'

/** A captured sound source: the microphone, or the system sound (loopback or the captured screen's audio). */
interface AudioSource {
  kind: StemKind
  track: MediaStreamTrack
}

function stopRecorder(r: MediaRecorder, timeoutMs = 5000): Promise<void> {
  return new Promise((resolve) => {
    if (r.state === 'inactive') return resolve()
    const timer = setTimeout(resolve, timeoutMs)
    r.addEventListener(
      'stop',
      () => {
        clearTimeout(timer)
        resolve()
      },
      { once: true }
    )
    r.stop()
  })
}

/**
 * Owns the capture streams and MediaRecorders of one recording. Media is streamed
 * to the main process chunk by chunk; nothing accumulates in this renderer.
 *
 * With native capture the main process records the video (without the OS cursor)
 * and this session records only audio (and the camera).
 */
export class RecordingSession {
  private streams: MediaStream[] = []
  private audioCtx: AudioContext | null = null
  private video: MediaStreamTrack | null = null
  private audioSources: AudioSource[] = []
  private camera: MediaStreamTrack | null = null
  private tracks: Track[] = []
  private method: 'native' | 'chromium'
  private nativeStart: number | null = null
  private startCall = 0
  private hasAudio = false
  /** Stems whose recorder or disk write failed: their files are incomplete and are dropped. */
  private failedStems = new Set<StemKind>()
  private firstFrames: Promise<[number | null, number | null]> = Promise.resolve([null, null])
  private size = { width: 0, height: 0 }
  private running = false
  private isPaused = false
  private activeMs = 0
  private resumedAt = 0
  private failure: RecorderError | null = null
  private disposed = false
  /** System audio could not be started (no active output device, …). */
  private loopbackFailed = false
  readonly warnings: string[] = []
  /** The captured screen/window went away (closed window, unplugged display). */
  onEnded: (() => void) | null = null
  /** Recording cannot continue (a recorder or the disk failed); stop and keep what was written. */
  onFailure: ((err: RecorderError) => void) | null = null

  constructor(
    private readonly api: RecordingApi,
    private readonly plan: CapturePlan,
    private readonly options: SessionOptions
  ) {
    this.method = plan.method
  }

  /** Screen capture frame rate chosen on Home (the plan carries it; older plans: 60). */
  private get fps(): 30 | 60 {
    return this.plan.fps === 30 ? 30 : 60
  }

  get error(): RecorderError | null {
    return this.failure
  }

  /** Acquires every stream up front so permission prompts never interrupt the countdown. */
  async acquire(): Promise<void> {
    const { systemAudio, micId, cameraId } = this.options
    if (this.method === 'chromium') await this.acquireScreen(systemAudio)
    else if (systemAudio) await this.acquireLoopback()
    if (micId) {
      const mic = await this.openDevice('microphone', micId, (deviceId) => ({
        audio: { ...(deviceId ? { deviceId: { exact: deviceId } } : {}), echoCancellation: true, noiseSuppression: true }
      }))
      if (mic) this.audioSources.push(...mic.getAudioTracks().map((track) => ({ kind: 'mic' as const, track })))
    }
    if (cameraId) {
      const cam = await this.openDevice('camera', cameraId, (deviceId) => ({
        video: { ...(deviceId ? { deviceId: { exact: deviceId } } : {}), width: { ideal: 1280 }, height: { ideal: 720 }, frameRate: { ideal: 30 } }
      }))
      if (cam) this.camera = cam.getVideoTracks()[0] ?? null
    }
  }

  /** Switches a native-capture session to Chromium capture (the helper failed to start). */
  async fallbackToChromium(): Promise<void> {
    this.method = 'chromium'
    // The loopback-only stream (if any) is replaced by a full capture with audio.
    for (const s of this.streams.filter((s) => s.getVideoTracks().length > 0)) {
      s.getTracks().forEach((t) => t.stop())
      this.audioSources = this.audioSources.filter((a) => !s.getTracks().includes(a.track))
    }
    this.streams = this.streams.filter((s) => s.getVideoTracks().length === 0)
    // Do not ask again for system audio that already failed to start.
    await this.acquireScreen(this.options.systemAudio && !this.loopbackFailed)
  }

  private async acquireScreen(systemAudio: boolean): Promise<void> {
    const { stream: display, systemAudioFailed } = await captureDisplay(
      (audio) => navigator.mediaDevices.getDisplayMedia({ video: { frameRate: { ideal: this.fps, max: this.fps } }, audio }),
      systemAudio
    )
    if (systemAudioFailed) {
      this.loopbackFailed = true
      this.warnings.push(SYSTEM_AUDIO_WARNING)
    }
    this.streams.push(display)
    const track = display.getVideoTracks()[0]
    if (!track || track.readyState === 'ended') throw new RecorderError(SOURCE_GONE)
    this.video = track
    const s = track.getSettings()
    this.size = { width: s.width ?? 1920, height: s.height ?? 1080 }
    // A window's video keeps its first frame's size (a resized window is fitted into it), and
    // its cursor is mapped into that size: take it from the first frame, not the settings.
    if (this.options.sourceId.startsWith('window:')) this.size = (await nextFrameSize(track)) ?? this.size
    this.audioSources.unshift(...display.getAudioTracks().map((track) => ({ kind: 'system' as const, track })))
    track.addEventListener('ended', () => {
      this.freeze()
      this.onEnded?.()
    })
  }

  private async acquireLoopback(): Promise<void> {
    // Chromium only captures system audio together with a video track: ask for a
    // tiny one and never record it.
    try {
      const s = await navigator.mediaDevices.getDisplayMedia({
        video: { width: { max: 320 }, height: { max: 180 }, frameRate: { max: 1 } },
        audio: true
      })
      this.streams.push(s)
      this.audioSources.unshift(...s.getAudioTracks().map((track) => ({ kind: 'system' as const, track })))
    } catch (err) {
      console.warn('System audio capture failed:', err)
      this.loopbackFailed = true
      this.warnings.push(SYSTEM_AUDIO_WARNING)
    }
  }

  private async openDevice(
    kind: Exclude<DeviceKind, 'screen'>,
    id: string,
    constraints: (deviceId?: string) => MediaStreamConstraints
  ): Promise<MediaStream | null> {
    let stream: MediaStream
    try {
      stream = await navigator.mediaDevices.getUserMedia(constraints(id))
    } catch (err) {
      const name = (err as DOMException | null)?.name
      if (name !== 'OverconstrainedError' && name !== 'NotFoundError') throw friendlyError(err, kind)
      // The selected device was unplugged: fall back to the default one, or none.
      try {
        stream = await navigator.mediaDevices.getUserMedia(constraints())
        this.warnings.push(`The selected ${kind} is not connected, so the default ${kind} was used.`)
      } catch {
        this.warnings.push(`The selected ${kind} is not connected, so the recording has no ${kind}.`)
        return null
      }
    }
    this.streams.push(stream)
    return stream
  }

  /** System audio and microphone as one track (mixed only when there are two). */
  private audioTrack(): MediaStreamTrack | null {
    const live = this.audioSources.map((a) => a.track).filter((t) => t.readyState === 'live')
    if (live.length <= 1) return live[0] ?? null
    this.audioCtx = new AudioContext()
    void this.audioCtx.resume()
    const dest = this.audioCtx.createMediaStreamDestination()
    for (const track of live) this.audioCtx.createMediaStreamSource(new MediaStream([track])).connect(dest)
    return dest.stream.getAudioTracks()[0] ?? null
  }

  private addTrack(kind: TrackKind, stream: MediaStream, options: MediaRecorderOptions): MediaRecorder {
    const recorder = new MediaRecorder(stream, options)
    const pipe = new ChunkPipe(
      (data) => this.api.appendRecordingChunk(this.plan.token, kind, data),
      (err) => (isStem(kind) ? this.dropStem(kind, err) : this.fail(friendlyError(err)))
    )
    recorder.ondataavailable = (e) => pipe.push(e.data)
    recorder.onerror = (e) => {
      const detail = (e as Event & { error?: DOMException }).error?.message
      if (kind === 'webcam') this.warnings.push('The camera recording stopped early.')
      else if (isStem(kind)) this.dropStem(kind, detail)
      else this.fail(new RecorderError(`Recording stopped unexpectedly${detail ? ` (${detail})` : ''}.`))
    }
    this.tracks.push({ kind, recorder, pipe })
    return recorder
  }

  /**
   * Also records the microphone and the system sound each on its own (for per-source volume
   * and cleanup in the editor), next to the mixed track that stays in the recording as before.
   * They start with the other recorders, so they share the mixed sound's timeline. A stem is
   * a bonus: one that cannot start or fails later is dropped and never stops the recording.
   */
  private addStems(): void {
    const mime = pickMime(AUDIO_MIMES, isSupported)
    for (const kind of STEM_KINDS) {
      const source = this.audioSources.find((a) => a.kind === kind && a.track.readyState === 'live')
      if (!source) continue
      try {
        this.addTrack(kind, new MediaStream([source.track]), { mimeType: mime, audioBitsPerSecond: 128_000 })
      } catch (err) {
        console.warn(`The ${kind} sound is not recorded on its own:`, err)
      }
    }
  }

  private dropStem(kind: StemKind, reason: unknown): void {
    if (this.failedStems.has(kind)) return
    this.failedStems.add(kind)
    console.warn(`The ${kind} sound stopped being recorded on its own (it stays in the mixed sound):`, reason)
    const track = this.tracks.find((t) => t.kind === kind)
    if (track && track.recorder.state !== 'inactive') track.recorder.stop()
  }

  private fail(err: RecorderError): void {
    if (this.failure || this.disposed) return
    this.failure = err
    this.freeze()
    this.onFailure?.(err)
  }

  /** Starts the recorders. `native` is the helper's start when it records the video. */
  start(native: { startedAt: number; width: number; height: number } | null): RecordingStartInfo {
    // Every epoch time below is compared with Date.now() in the main process and with
    // the native helper's system clock: align with them now.
    syncEpoch()
    const audio = this.audioTrack()
    this.hasAudio = !!audio
    if (native) {
      this.method = 'native'
      this.nativeStart = native.startedAt
      this.size = { width: native.width, height: native.height }
      if (audio) this.addTrack('audio', new MediaStream([audio]), { mimeType: pickMime(AUDIO_MIMES, isSupported), audioBitsPerSecond: 192_000 })
    } else {
      if (!this.video || this.video.readyState !== 'live') throw new RecorderError(SOURCE_GONE)
      const { width, height } = this.size
      const screen = this.addTrack('screen', new MediaStream(audio ? [this.video, audio] : [this.video]), {
        // H.264 encoders need even frame sizes; odd-sized windows use VP8.
        mimeType: pickMime(screenMimes(!!audio, width % 2 === 0 && height % 2 === 0), isSupported),
        videoBitsPerSecond: screenBitrate(width, height, this.fps),
        audioBitsPerSecond: 192_000
      })
      // A recorder stops by itself when its video track ends; the clock must stop with it.
      screen.addEventListener('stop', () => this.freeze())
    }
    if (audio) this.addStems()
    if (this.camera?.readyState === 'live') {
      this.addTrack('webcam', new MediaStream([this.camera]), { mimeType: pickMime(CAMERA_MIMES, isSupported), videoBitsPerSecond: 4_000_000 })
    }
    this.firstFrames = Promise.all([
      !native && this.video ? nextFrameTime(this.video) : Promise.resolve(null),
      this.camera ? nextFrameTime(this.camera) : Promise.resolve(null)
    ])
    this.startCall = epochNow()
    for (const t of this.tracks) t.recorder.start(TIMESLICE_MS)
    this.running = true
    this.resumedAt = performance.now()
    const fps = this.camera?.getSettings().frameRate
    return {
      method: this.method,
      startedAt: native ? native.startedAt : this.startCall,
      width: this.size.width,
      height: this.size.height,
      hasAudio: this.hasAudio,
      hasWebcam: this.tracks.some((t) => t.kind === 'webcam'),
      webcamFps: fps && fps > 0 ? Math.min(60, Math.round(fps)) : 30,
      // Known now for native capture, so a recording interrupted by a crash keeps its sound in sync.
      audioOffset: native ? (this.startCall - native.startedAt) / 1000 : 0
    }
  }

  pause(): void {
    if (!this.running) return
    for (const t of this.tracks) if (t.recorder.state === 'recording') t.recorder.pause()
    this.freeze()
    this.isPaused = true
  }

  resume(): void {
    if (!this.isPaused || this.failure) return
    for (const t of this.tracks) if (t.recorder.state === 'paused') t.recorder.resume()
    this.isPaused = false
    this.running = true
    this.resumedAt = performance.now()
  }

  private freeze(): void {
    if (!this.running) return
    this.activeMs += performance.now() - this.resumedAt
    this.running = false
  }

  /** Recorded (non-paused) seconds; keeps counting real time even if a recorder stopped by itself. */
  get elapsed(): number {
    return (this.activeMs + (this.running ? performance.now() - this.resumedAt : 0)) / 1000
  }

  get paused(): boolean {
    return this.isPaused
  }

  /** Stops the recorders, waits until every chunk is on disk and returns the timing metadata. */
  async stop(): Promise<SaveRecordingPayload> {
    this.freeze()
    this.isPaused = false
    const duration = this.elapsed
    await Promise.all(this.tracks.map((t) => stopRecorder(t.recorder)))
    await Promise.all(this.tracks.map((t) => t.pipe.flush()))
    const [screenFirst, cameraFirst] = await Promise.race([
      this.firstFrames,
      new Promise<[null, null]>((r) => setTimeout(() => r([null, null]), 500))
    ])
    this.dispose()

    const start = this.startCall
    const stems = this.tracks.filter((t) => isStem(t.kind) && !this.failedStems.has(t.kind as StemKind)).map((t) => t.kind as StemKind)
    if (this.method === 'native' && this.nativeStart !== null) {
      // The audio recorders' timelines start when they were started.
      return {
        startedAt: this.nativeStart,
        duration,
        audioOffset: (start - this.nativeStart) / 1000,
        webcamOffset: ((cameraFirst ?? start) - this.nativeStart) / 1000,
        stems
      }
    }
    // A recorder's timeline starts with its first media: audio flows at once, video
    // only with the first frame. The stems' recorders start with the screen's.
    const screenZero = this.hasAudio ? Math.min(screenFirst ?? start, start) : (screenFirst ?? start)
    return {
      startedAt: screenZero,
      duration,
      audioOffset: (start - screenZero) / 1000,
      webcamOffset: ((cameraFirst ?? start) - screenZero) / 1000,
      stems
    }
  }

  dispose(): void {
    this.disposed = true
    for (const t of this.tracks) if (t.recorder.state !== 'inactive') t.recorder.stop()
    for (const s of this.streams) s.getTracks().forEach((t) => t.stop())
    this.streams = []
    void this.audioCtx?.close()
    this.audioCtx = null
  }
}
