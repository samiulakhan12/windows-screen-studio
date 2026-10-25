import type { CapturePlan, RecordingApi, RecordingOffsets, RecordingStartInfo, SaveRecordingPayload, TrackKind } from '../../../shared/api/recording'
import type { StemKind } from '../../../shared/audio/settings'
import type { NormRect } from '../../../shared/types'
import { ChunkPipe } from '../../../shared/recording/chunkPipe'
import { captureDisplay, SYSTEM_AUDIO_WARNING } from '../../../shared/recording/displayCapture'
import { friendlyError, RecorderError, SOURCE_GONE, type DeviceKind } from '../../../shared/recording/errors'
import { levelFromSamples } from './devices'
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
/** How often the microphone's level is measured for the recording bar's meter (ms). */
const METER_MS = 125

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
  /** The tiny screen capture that only carries system audio for native capture. */
  private loopback: MediaStream | null = null
  private tracks: Track[] = []
  private method: 'native' | 'chromium'
  private nativeStart: number | null = null
  private startCall = 0
  private hasAudio = false
  /** A stem's recorder or disk write failed: the set is incomplete, so none is kept. */
  private stemsDropped = false
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
  private muted = false
  private meter: { ctx: AudioContext; timer: number } | null = null
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
    // The loopback-only stream (if any) is replaced by a full capture with audio. The camera and
    // microphone streams stay open: the camera is recorded (and shown in the bubble) as before.
    const lb = this.loopback
    if (lb) {
      lb.getTracks().forEach((t) => t.stop())
      this.audioSources = this.audioSources.filter((a) => !lb.getTracks().includes(a.track))
      this.streams = this.streams.filter((s) => s !== lb)
      this.loopback = null
    }
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
      this.loopback = s
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

  /** The `live` sources (system audio and microphone) as one track, mixed only when there are two. */
  private audioTrack(live: AudioSource[]): MediaStreamTrack | null {
    if (live.length <= 1) return live[0]?.track ?? null
    this.audioCtx = new AudioContext()
    void this.audioCtx.resume()
    const dest = this.audioCtx.createMediaStreamDestination()
    for (const { track } of live) this.audioCtx.createMediaStreamSource(new MediaStream([track])).connect(dest)
    return dest.stream.getAudioTracks()[0] ?? null
  }

  private addTrack(kind: TrackKind, stream: MediaStream, options: MediaRecorderOptions): MediaRecorder {
    const recorder = new MediaRecorder(stream, options)
    const pipe = new ChunkPipe(
      (data) => this.api.appendRecordingChunk(this.plan.token, kind, data),
      (err) => (isStem(kind) ? this.dropStems(kind, err) : this.fail(friendlyError(err)))
    )
    recorder.ondataavailable = (e) => pipe.push(e.data)
    recorder.onerror = (e) => {
      const detail = (e as Event & { error?: DOMException }).error?.message
      if (kind === 'webcam') this.warnings.push('The camera recording stopped early.')
      else if (isStem(kind)) this.dropStems(kind, detail)
      else this.fail(new RecorderError(`Recording stopped unexpectedly${detail ? ` (${detail})` : ''}.`))
    }
    this.tracks.push({ kind, recorder, pipe })
    return recorder
  }

  /**
   * Also records each source of the mixed sound (`live`: the microphone, the system sound) on
   * its own, for per-source volume and cleanup in the editor; the mixed track stays in the
   * recording as before. They start with the other recorders, so they share the mixed sound's
   * timeline. Stems are kept only as a complete set (the editor plays them instead of the
   * mixed sound, so a missing one would silence its source): when one cannot start, none is
   * recorded. A stem is a bonus and never stops the recording. Returns the kinds recorded.
   */
  private addStems(live: AudioSource[]): StemKind[] {
    const kinds = live.map((a) => a.kind)
    // Two sources of one kind would share a stem: only the mixed sound has them both.
    if (new Set(kinds).size !== kinds.length) return []
    const mime = pickMime(AUDIO_MIMES, isSupported)
    try {
      for (const { kind, track } of live) this.addTrack(kind, new MediaStream([track]), { mimeType: mime, audioBitsPerSecond: 128_000 })
    } catch (err) {
      console.warn('The microphone and system sound are not recorded on their own:', err)
      // Not started yet: the ones already set up are simply left out.
      this.tracks = this.tracks.filter((t) => !isStem(t.kind))
      return []
    }
    return kinds
  }

  /**
   * A stem failed (`kind`'s recorder or its disk writes): the set is incomplete, so every
   * stem stops and none is kept, also when the recording is recovered after a crash.
   */
  private dropStems(kind: StemKind, reason: unknown): void {
    if (this.stemsDropped) return
    this.stemsDropped = true
    console.warn(`The ${kind} sound stopped being recorded on its own; the recording keeps only its mixed sound:`, reason)
    for (const t of this.tracks) if (isStem(t.kind) && t.recorder.state !== 'inactive') t.recorder.stop()
    void this.api.dropRecordingStems(this.plan.token).catch((err: unknown) => console.warn('Could not tell the recorder to drop the stems:', err))
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
    const live = this.audioSources.filter((a) => a.track.readyState === 'live')
    const audio = this.audioTrack(live)
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
    const stems = audio ? this.addStems(live) : []
    if (this.camera && this.camera.readyState !== 'live') this.warnings.push('The camera stopped before recording started, so the recording has no camera.')
    if (this.camera?.readyState === 'live') {
      this.addTrack('webcam', new MediaStream([this.camera]), { mimeType: pickMime(CAMERA_MIMES, isSupported), videoBitsPerSecond: 4_000_000 })
    }
    this.firstFrames = Promise.all([
      !native && this.video ? nextFrameTime(this.video) : Promise.resolve(null),
      this.camera ? nextFrameTime(this.camera) : Promise.resolve(null)
    ])
    this.startCall = epochNow()
    // Known within a few frames: kept by the main process at once, for a recording recovered after a crash.
    void this.firstFrames
      .then(([screenFirst, cameraFirst]) => (this.disposed ? undefined : this.api.recordingOffsets(this.plan.token, this.offsets(screenFirst, cameraFirst))))
      .catch((err: unknown) => console.warn('Could not send the recording offsets:', err))
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
      audioOffset: native ? (this.startCall - native.startedAt) / 1000 : 0,
      stems
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

  /**
   * The camera as it is being recorded, for the live camera bubble: the same capture (a clone of
   * the track shows it elsewhere), so the camera is never opened a second time.
   */
  get cameraTrack(): MediaStreamTrack | null {
    return this.camera?.readyState === 'live' ? this.camera : null
  }

  /** The recording has a microphone. */
  get hasMic(): boolean {
    return this.audioSources.some((a) => a.kind === 'mic')
  }

  get micMuted(): boolean {
    return this.muted
  }

  /**
   * Silences the microphone in the recording (and its stem) while `muted`: the track keeps
   * running and delivers silence, so nothing restarts and the timelines stay in step.
   */
  setMicMuted(muted: boolean): void {
    this.muted = muted
    for (const a of this.audioSources) if (a.kind === 'mic') a.track.enabled = !muted
  }

  /**
   * Measures the microphone a few times a second for the recording bar's meter (`onLevel`, 0..1,
   * sent only when it changes visibly). A meter that cannot start is simply left out.
   */
  meterMic(onLevel: (level: number) => void): void {
    const mic = this.audioSources.find((a) => a.kind === 'mic' && a.track.readyState === 'live')
    if (!mic || this.meter) return
    try {
      const ctx = new AudioContext()
      const analyser = ctx.createAnalyser()
      analyser.fftSize = 1024
      ctx.createMediaStreamSource(new MediaStream([mic.track])).connect(analyser)
      const samples = new Float32Array(analyser.fftSize)
      let sent = -1
      const timer = window.setInterval(() => {
        analyser.getFloatTimeDomainData(samples)
        const level = this.muted || this.isPaused ? 0 : levelFromSamples(samples)
        if (Math.abs(level - sent) < 0.03) return
        sent = level
        onLevel(level)
      }, METER_MS)
      this.meter = { ctx, timer }
    } catch (err) {
      console.warn('The microphone level is not shown:', err)
    }
  }

  private stopMeter(): void {
    if (!this.meter) return
    window.clearInterval(this.meter.timer)
    void this.meter.ctx.close().catch(() => undefined)
    this.meter = null
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
    const stems = this.stemsDropped ? [] : this.tracks.map((t) => t.kind).filter(isStem)
    return { ...this.offsets(screenFirst, cameraFirst), duration, stems }
  }

  /** The screen timeline's start and the other tracks' offsets from it, given the first frames' times. */
  private offsets(screenFirst: number | null, cameraFirst: number | null): RecordingOffsets {
    const start = this.startCall
    if (this.method === 'native' && this.nativeStart !== null) {
      // The audio recorders' timelines start when they were started.
      return {
        startedAt: this.nativeStart,
        audioOffset: (start - this.nativeStart) / 1000,
        webcamOffset: ((cameraFirst ?? start) - this.nativeStart) / 1000
      }
    }
    // A recorder's timeline starts with its first media: audio flows at once, video
    // only with the first frame. The stems' recorders start with the screen's.
    const screenZero = this.hasAudio ? Math.min(screenFirst ?? start, start) : (screenFirst ?? start)
    return {
      startedAt: screenZero,
      audioOffset: (start - screenZero) / 1000,
      webcamOffset: ((cameraFirst ?? start) - screenZero) / 1000
    }
  }

  dispose(): void {
    this.disposed = true
    this.stopMeter()
    for (const t of this.tracks) if (t.recorder.state !== 'inactive') t.recorder.stop()
    for (const s of this.streams) s.getTracks().forEach((t) => t.stop())
    this.streams = []
    void this.audioCtx?.close()
    this.audioCtx = null
  }
}
