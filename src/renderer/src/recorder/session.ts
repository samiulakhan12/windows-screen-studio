export interface SessionOptions {
  sourceId: string
  systemAudio: boolean
  micId: string | null
  cameraId: string | null
}

export interface SessionResult {
  screen: Blob
  webcam: Blob | null
  startedAt: number
  webcamStartedAt: number | null
  duration: number
  width: number
  height: number
  hasAudio: boolean
  /** True when the OS cursor is not baked into the screen video. */
  cursorHidden: boolean
}

function pickMime(candidates: string[]): string {
  return candidates.find((m) => MediaRecorder.isTypeSupported(m)) ?? ''
}

/** Owns the capture streams and MediaRecorders for one recording. */
export class RecordingSession {
  private streams: MediaStream[] = []
  private audioCtx: AudioContext | null = null
  private screenRecorder: MediaRecorder | null = null
  private webcamRecorder: MediaRecorder | null = null
  private screenChunks: Blob[] = []
  private webcamChunks: Blob[] = []
  private startedAt = 0
  private webcamStartedAt: number | null = null
  private activeMs = 0
  private resumedAt = 0
  private hasAudio = false
  private cursorHidden = false
  private size = { width: 1920, height: 1080 }

  constructor(private readonly options: SessionOptions) {}

  /** Acquires every stream up front so permission prompts never interrupt the countdown. */
  async acquire(): Promise<void> {
    const { sourceId, systemAudio, micId, cameraId } = this.options
    await window.api.prepareCapture(sourceId, systemAudio)
    const display = await navigator.mediaDevices.getDisplayMedia({
      video: { frameRate: { ideal: 60, max: 60 }, cursor: 'never' } as MediaTrackConstraints,
      audio: systemAudio
    })
    this.streams.push(display)
    const videoTrack = display.getVideoTracks()[0]
    const settings = videoTrack.getSettings()
    this.size = { width: settings.width ?? 1920, height: settings.height ?? 1080 }
    this.cursorHidden = (settings as MediaTrackSettings & { cursor?: string }).cursor === 'never'

    const audioTracks: MediaStreamTrack[] = [...display.getAudioTracks()]
    if (micId) {
      const mic = await navigator.mediaDevices.getUserMedia({
        audio: { deviceId: { exact: micId }, echoCancellation: true, noiseSuppression: true }
      })
      this.streams.push(mic)
      audioTracks.push(...mic.getAudioTracks())
    }

    const tracks: MediaStreamTrack[] = [videoTrack]
    if (audioTracks.length > 0) {
      // Mix system audio and microphone into a single track.
      this.audioCtx = new AudioContext()
      const dest = this.audioCtx.createMediaStreamDestination()
      for (const track of audioTracks) {
        this.audioCtx.createMediaStreamSource(new MediaStream([track])).connect(dest)
      }
      tracks.push(...dest.stream.getAudioTracks())
      this.hasAudio = true
    }
    const screenStream = new MediaStream(tracks)

    const mime = pickMime(['video/webm;codecs=vp9,opus', 'video/webm;codecs=vp8,opus', 'video/webm'])
    this.screenRecorder = new MediaRecorder(screenStream, {
      mimeType: mime,
      videoBitsPerSecond: Math.round(this.size.width * this.size.height * 60 * 0.12),
      audioBitsPerSecond: 192_000
    })
    this.screenRecorder.ondataavailable = (e) => e.data.size > 0 && this.screenChunks.push(e.data)

    if (cameraId) {
      const cam = await navigator.mediaDevices.getUserMedia({
        video: { deviceId: { exact: cameraId }, width: { ideal: 1280 }, height: { ideal: 720 }, frameRate: { ideal: 30 } }
      })
      this.streams.push(cam)
      this.webcamRecorder = new MediaRecorder(cam, {
        mimeType: pickMime(['video/webm;codecs=vp9', 'video/webm;codecs=vp8', 'video/webm']),
        videoBitsPerSecond: 5_000_000
      })
      this.webcamRecorder.ondataavailable = (e) => e.data.size > 0 && this.webcamChunks.push(e.data)
    }

    // If the user stops sharing from the OS, treat it like pressing stop.
    videoTrack.addEventListener('ended', () => this.onEnded?.())
  }

  onEnded: (() => void) | null = null

  start(): void {
    this.screenRecorder?.start(1000)
    this.startedAt = Date.now()
    this.resumedAt = performance.now()
    if (this.webcamRecorder) {
      this.webcamRecorder.start(1000)
      this.webcamStartedAt = Date.now()
    }
  }

  pause(): void {
    if (this.screenRecorder?.state !== 'recording') return
    this.screenRecorder.pause()
    this.webcamRecorder?.pause()
    this.activeMs += performance.now() - this.resumedAt
  }

  resume(): void {
    if (this.screenRecorder?.state !== 'paused') return
    this.screenRecorder.resume()
    this.webcamRecorder?.resume()
    this.resumedAt = performance.now()
  }

  get elapsed(): number {
    const running = this.screenRecorder?.state === 'recording' ? performance.now() - this.resumedAt : 0
    return (this.activeMs + running) / 1000
  }

  get paused(): boolean {
    return this.screenRecorder?.state === 'paused'
  }

  async stop(): Promise<SessionResult> {
    const duration = this.elapsed
    const stopRecorder = (r: MediaRecorder | null): Promise<void> =>
      new Promise((resolve) => {
        if (!r || r.state === 'inactive') return resolve()
        r.addEventListener('stop', () => resolve(), { once: true })
        r.stop()
      })
    await Promise.all([stopRecorder(this.screenRecorder), stopRecorder(this.webcamRecorder)])
    this.dispose()
    return {
      screen: new Blob(this.screenChunks, { type: 'video/webm' }),
      webcam: this.webcamChunks.length ? new Blob(this.webcamChunks, { type: 'video/webm' }) : null,
      startedAt: this.startedAt,
      webcamStartedAt: this.webcamStartedAt,
      duration,
      width: this.size.width,
      height: this.size.height,
      hasAudio: this.hasAudio,
      cursorHidden: this.cursorHidden
    }
  }

  dispose(): void {
    for (const s of this.streams) s.getTracks().forEach((t) => t.stop())
    this.streams = []
    void this.audioCtx?.close()
    this.audioCtx = null
  }
}
