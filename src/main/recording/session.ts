import { randomUUID } from 'node:crypto'
import path from 'node:path'
import type { TrackKind } from '../../shared/api/recording'
import type { CursorShape } from '../../shared/types'
import type { NativeCaptureSession, NativeStartInfo, NativeStopInfo } from '../nativeCapture'
import { RAW, type RecordingManifest } from '../projects'
import { ChunkWriter } from './chunkWriter'
import { stopNativeVideo } from './nativeVideo'
import type { PauseSpan } from './trackMath'

export type Phase = 'countdown' | 'recording' | 'paused' | 'stopping' | 'processing'

const FILES: Record<TrackKind, string> = { screen: RAW.screen, webcam: RAW.webcam, audio: RAW.audio }

/**
 * Main-process state of the one recording in progress: its folder, the files
 * chunks are streamed into, the pause timeline and the native capture helper.
 */
export class ActiveRecording {
  readonly token = randomUUID()
  phase: Phase = 'countdown'
  readonly pauses: PauseSpan[] = []
  private pausedAt: number | null = null
  private stoppedAt: number | null = null
  private writers = new Map<TrackKind, ChunkWriter>()
  private native: NativeCaptureSession | null = null
  private nativeStop: Promise<NativeStopInfo | null> | null = null

  constructor(
    readonly manifest: RecordingManifest,
    readonly dir: string
  ) {}

  get id(): string {
    return this.manifest.id
  }

  get usesNative(): boolean {
    return this.native !== null || this.nativeStop !== null
  }

  write(kind: TrackKind, data: Uint8Array): Promise<void> {
    let writer = this.writers.get(kind)
    if (!writer) {
      writer = new ChunkWriter(path.join(this.dir, FILES[kind]))
      this.writers.set(kind, writer)
    }
    return writer.write(data)
  }

  async closeWriters(): Promise<void> {
    await Promise.all([...this.writers.values()].map((w) => w.close()))
  }

  attachNative(session: NativeCaptureSession, info: NativeStartInfo): void {
    this.native = session
    this.manifest.method = 'native'
    this.manifest.startedAt = info.startedAt
    this.manifest.width = info.width
    this.manifest.height = info.height
  }

  pause(at = Date.now()): void {
    if (this.pausedAt !== null || this.stoppedAt !== null) return
    this.pausedAt = at
    this.native?.pause()
  }

  resume(at = Date.now()): void {
    if (this.pausedAt === null || this.stoppedAt !== null) return
    this.pauses.push({ from: this.pausedAt, to: at })
    this.pausedAt = null
    this.native?.resume()
  }

  /** Freezes the clock and starts finalising the native video. Idempotent. */
  stop(at = Date.now()): void {
    if (this.stoppedAt !== null) return
    if (this.pausedAt !== null) {
      this.pauses.push({ from: this.pausedAt, to: at })
      this.pausedAt = null
    }
    this.stoppedAt = at
    const native = this.native
    this.native = null
    if (native) {
      this.nativeStop = stopNativeVideo(native)
      // Awaited by finishNative(); keep a failure from being reported as unhandled meanwhile.
      this.nativeStop.catch(() => undefined)
    }
  }

  /** Waits for the helper to finalise its MP4 and returns its cursor shapes (pause-adjusted later). */
  async finishNative(): Promise<{ at: number; shape: CursorShape }[]> {
    if (!this.nativeStop) return []
    try {
      return (await this.nativeStop)?.shapes ?? []
    } catch (err) {
      // The MP4 may still be usable; processing will tell.
      console.error('Native capture did not stop cleanly:', err)
      return []
    }
  }

  killNative(): void {
    try {
      this.native?.kill()
    } catch {
      // Already gone.
    }
    this.native = null
  }

  /** Recorded (non-paused) seconds since the video started. */
  activeSeconds(at = this.stoppedAt ?? Date.now()): number {
    const start = this.manifest.startedAt
    if (start === null) return 0
    let paused = 0
    for (const p of this.pauses) paused += p.to - p.from
    if (this.pausedAt !== null) paused += at - this.pausedAt
    return Math.max(0, (at - start - paused) / 1000)
  }
}
