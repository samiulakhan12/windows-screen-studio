import { displayTime } from '../../../shared/editor/clips'
import { clamp } from '../../../shared/engine/math'
import { clipIndexAt, keptBounds, playableFrom } from '../../../shared/engine/timeline'
import type { Clip, Project } from '../../../shared/types'
import { drawFrame, type RenderScene } from '../render/compositor'

/** Proxies are encoded at 60 fps (see proxyArgs); used to look one frame ahead at cut points. */
const SOURCE_FPS = 60
const FRAME = 1 / SOURCE_FPS
const WEBCAM_DRIFT = 0.15

const hasVideoFrameCallback = typeof HTMLVideoElement !== 'undefined' && 'requestVideoFrameCallback' in HTMLVideoElement.prototype

/**
 * Plays the edit in the preview: skips cut gaps, applies each clip's speed to
 * the screen and camera videos, stops at the end, and draws a frame only when
 * there is something new to show (one draw per decoded video frame while
 * playing, one per seek or scene change while paused, nothing when idle).
 *
 * `time` is the playhead in source seconds. It may sit inside a cut (e.g. after
 * scrubbing); the preview then shows the next kept frame.
 */
export class PreviewPlayer {
  time = 0
  playing = false

  private project: Project
  private scene: RenderScene | null = null
  private unzoomed: RenderScene | null = null
  private background: HTMLImageElement | null = null
  private canvas: HTMLCanvasElement | null = null
  private ctx: CanvasRenderingContext2D | null = null
  private noZoom = false
  private readonly listeners = new Set<() => void>()
  private drawRaf = 0
  private frameHandle = 0
  private pendingSeek: number | null = null
  private jumpTarget: number | null = null
  private audio: { ctx: AudioContext; gain: GainNode } | null = null
  private disposed = false

  constructor(
    readonly screen: HTMLVideoElement,
    readonly webcam: HTMLVideoElement | null,
    project: Project
  ) {
    this.project = project
    screen.preservesPitch = true
    if (webcam) {
      webcam.muted = true
      webcam.preservesPitch = true
      webcam.addEventListener('seeked', this.invalidate)
      webcam.addEventListener('loadeddata', this.invalidate)
    }
    screen.addEventListener('seeked', this.onSeeked)
    screen.addEventListener('loadeddata', this.invalidate)
    screen.addEventListener('ended', this.onEnded)
    screen.addEventListener('pause', this.onPause)
    this.applyAudio()
    this.seek(keptBounds(project.clips).start)
  }

  /* ---------- observers ---------- */

  subscribe = (listener: () => void): (() => void) => {
    this.listeners.add(listener)
    return () => this.listeners.delete(listener)
  }

  getPlaying = (): boolean => this.playing

  private emit(): void {
    for (const l of [...this.listeners]) l()
  }

  /* ---------- inputs ---------- */

  attachCanvas(canvas: HTMLCanvasElement | null): void {
    this.canvas = canvas
    this.ctx = canvas ? canvas.getContext('2d', { alpha: false }) : null
    this.drawNow()
  }

  setScene(scene: RenderScene, background: HTMLImageElement | null): void {
    this.scene = scene
    this.unzoomed = null
    this.background = background
    this.invalidate()
  }

  /** Shows the frame without zoom (while the user picks a zoom's focus point on it). */
  setNoZoom(on: boolean): void {
    if (this.noZoom === on) return
    this.noZoom = on
    this.invalidate()
  }

  setProject(project: Project): void {
    const prev = this.project
    this.project = project
    if (project.audio !== prev.audio || project.hasAudio !== prev.hasAudio) this.applyAudio()
    if (project.webcamOffset !== prev.webcamOffset) this.syncWebcam(this.screen.currentTime, true)
    if (project.clips !== prev.clips || project.duration !== prev.duration) {
      // Re-show the right frame if the playhead is now in a cut; while playing the frame loop handles it.
      if (!this.playing) this.seek(this.time)
    }
  }

  /* ---------- transport ---------- */

  seek(t: number): void {
    this.time = clamp(t, 0, this.project.duration)
    const clips = this.project.clips
    if (this.playing) {
      const from = playableFrom(clips, this.time)
      if (!from) {
        this.finish()
        return
      }
      this.time = from.time
      this.setRate(clips[from.index].speed)
      this.jumpTarget = null
      this.screen.currentTime = from.time
      this.syncWebcam(from.time, true)
    } else {
      this.seekVideo(this.frameTimeFor(displayTime(clips, this.time)))
    }
    this.emit()
  }

  play(): void {
    if (this.playing || this.disposed) return
    const clips = this.project.clips
    let from = playableFrom(clips, this.time)
    if (!from || this.time >= keptBounds(clips).end - FRAME) from = { time: clips[0].start, index: 0 }
    this.playing = true
    this.time = from.time
    this.pendingSeek = null
    this.jumpTarget = null
    this.setRate(clips[from.index].speed)
    if (Math.abs(this.screen.currentTime - from.time) > 1e-3) this.screen.currentTime = from.time
    this.syncWebcam(from.time, true)
    void this.audio?.ctx.resume()
    this.screen.play().catch((err: unknown) => {
      // AbortError just means pause() won the race.
      if (!(err instanceof DOMException && err.name === 'AbortError')) this.stopPlaying()
    })
    if (this.webcam && this.webcamInRange(from.time)) void this.webcam.play().catch(() => undefined)
    this.scheduleFrame()
    this.emit()
  }

  pause(): void {
    if (!this.playing) return
    this.stopPlaying()
    this.time = this.screen.currentTime
    this.emit()
  }

  toggle(): void {
    if (this.playing) this.pause()
    else this.play()
  }

  /* ---------- drawing ---------- */

  /** Redraws on the next animation frame (coalesced); a no-op while playing. */
  invalidate = (): void => {
    if (this.playing || this.drawRaf || this.disposed) return
    this.drawRaf = requestAnimationFrame(() => {
      this.drawRaf = 0
      if (!this.playing && !this.screen.seeking) this.draw(this.screen.currentTime)
    })
  }

  /** Redraws synchronously (after the canvas was resized, which clears it). */
  drawNow(): void {
    if (!this.screen.seeking) this.draw(this.screen.currentTime)
  }

  private draw(t: number): void {
    const { canvas, ctx, scene } = this
    if (!canvas || !ctx || !scene || this.screen.readyState < 2) return
    drawFrame(ctx, canvas.width, canvas.height, t, this.noZoom ? this.unzoomedScene(scene) : scene, {
      screen: this.screen,
      webcam: this.webcam,
      background: this.background
    })
  }

  private unzoomedScene(scene: RenderScene): RenderScene {
    if (!this.unzoomed) this.unzoomed = { ...scene, project: { ...scene.project, zooms: [] } }
    return this.unzoomed
  }

  /* ---------- playback loop ---------- */

  private scheduleFrame(): void {
    if (!this.playing) return
    if (hasVideoFrameCallback) this.frameHandle = this.screen.requestVideoFrameCallback(this.onVideoFrame)
    else this.frameHandle = requestAnimationFrame(() => this.onVideoFrame(performance.now()))
  }

  private cancelFrame(): void {
    if (!this.frameHandle) return
    if (hasVideoFrameCallback) this.screen.cancelVideoFrameCallback(this.frameHandle)
    else cancelAnimationFrame(this.frameHandle)
    this.frameHandle = 0
  }

  private onVideoFrame = (_now: number, meta?: VideoFrameCallbackMetadata): void => {
    this.frameHandle = 0
    if (!this.playing || this.disposed) return
    const t = meta ? meta.mediaTime : this.screen.currentTime
    const clips = this.project.clips
    if (this.jumpTarget !== null) {
      // Frames decoded before the jump landed belong to the cut: never show them.
      if (Math.abs(t - this.jumpTarget) > FRAME * 1.5 && t < this.jumpTarget) {
        this.scheduleFrame()
        return
      }
      this.jumpTarget = null
    }
    const i = clipIndexAt(clips, t)
    if (i < 0) {
      const next = playableFrom(clips, t)
      if (next) this.jumpTo(next.time, next.index)
      else this.finish()
      if (this.playing) this.scheduleFrame()
      return
    }
    const clip = clips[i]
    if (this.screen.playbackRate !== clip.speed) this.setRate(clip.speed)
    this.time = t
    this.syncWebcam(t, false)
    this.draw(t)
    this.emit()
    // Jump before the next decoded frame would land in a cut (or past the end).
    if (t + clip.speed * FRAME >= clip.end - 1e-4) this.leaveClip(clips, i)
    if (this.playing) this.scheduleFrame()
  }

  private leaveClip(clips: Clip[], i: number): void {
    const next = clips[i + 1]
    if (!next) {
      this.finish()
      return
    }
    // Adjacent clips (a split with different speeds) need no seek, only the new rate.
    if (next.start - clips[i].end > 1e-6) this.jumpTo(next.start, i + 1)
  }

  private jumpTo(time: number, index: number): void {
    this.jumpTarget = time
    this.setRate(this.project.clips[index].speed)
    this.screen.currentTime = time
    this.syncWebcam(time, true)
  }

  /** Stops at the end of the edit and shows its last frame. */
  private finish(): void {
    const clips = this.project.clips
    this.stopPlaying()
    this.time = keptBounds(clips).end
    this.seekVideo(this.frameTimeFor(this.time))
    this.emit()
  }

  private stopPlaying(): void {
    const wasPlaying = this.playing
    this.playing = false
    this.cancelFrame()
    this.jumpTarget = null
    if (!this.screen.paused) this.screen.pause()
    if (this.webcam && !this.webcam.paused) this.webcam.pause()
    void this.audio?.ctx.suspend()
    if (wasPlaying) {
      this.emit()
      this.invalidate()
    }
  }

  private onEnded = (): void => {
    if (this.playing) this.finish()
  }

  /** The element paused on its own (end of file, media session keys): keep the transport honest. */
  private onPause = (): void => {
    if (!this.playing) return
    if (this.screen.ended) this.finish()
    else this.pause()
  }

  /* ---------- media helpers ---------- */

  /** Source time to seek to for showing `s`; the edit's end shows its last kept frame. */
  private frameTimeFor(s: number): number {
    const clips = this.project.clips
    const last = clips[clips.length - 1]
    const media = Number.isFinite(this.screen.duration) ? this.screen.duration : this.project.duration
    const t = s >= last.end - 1e-6 ? Math.max(last.start, last.end - FRAME / 4) : s
    return clamp(t, 0, Math.max(0, media - 0.001))
  }

  /** Seeks the paused video, coalescing rapid scrubbing so seeks never queue up. */
  private seekVideo(s: number): void {
    if (this.screen.seeking) {
      this.pendingSeek = s
      return
    }
    if (Math.abs(this.screen.currentTime - s) < 1e-4 && this.screen.readyState >= 2) {
      this.syncWebcam(s, true)
      this.invalidate()
      return
    }
    this.screen.currentTime = s
    this.syncWebcam(s, true)
  }

  private onSeeked = (): void => {
    if (this.pendingSeek !== null && !this.playing) {
      const s = this.pendingSeek
      this.pendingSeek = null
      this.screen.currentTime = s
      this.syncWebcam(s, true)
      return
    }
    this.pendingSeek = null
    this.invalidate()
  }

  private webcamInRange(t: number): boolean {
    const cam = this.webcam
    if (!cam) return false
    const want = t - this.project.webcamOffset
    return want >= 0 && (!Number.isFinite(cam.duration) || want < cam.duration)
  }

  private syncWebcam(t: number, force: boolean): void {
    const cam = this.webcam
    if (!cam) return
    const want = Math.max(0, t - this.project.webcamOffset)
    if (force || Math.abs(cam.currentTime - want) > WEBCAM_DRIFT) cam.currentTime = want
    if (this.playing && cam.paused && this.webcamInRange(t)) void cam.play().catch(() => undefined)
  }

  private setRate(speed: number): void {
    this.screen.playbackRate = speed
    if (this.webcam) this.webcam.playbackRate = speed
  }

  /**
   * Preview volume. Up to 100% uses the element volume; louder needs a gain node,
   * which is only created on demand (an AudioContext costs CPU while running).
   */
  private applyAudio(): void {
    const { volume, muted } = this.project.audio
    const silent = !this.project.hasAudio || muted || volume <= 0
    this.screen.muted = silent
    if (!silent && volume > 1 && !this.audio) this.createGain()
    if (this.audio) {
      this.audio.gain.gain.value = clamp(volume, 0, 2)
      this.screen.volume = 1
    } else {
      this.screen.volume = clamp(volume, 0, 1)
    }
  }

  private createGain(): void {
    try {
      const ctx = new AudioContext()
      const gain = ctx.createGain()
      ctx.createMediaElementSource(this.screen).connect(gain).connect(ctx.destination)
      this.audio = { ctx, gain }
      if (!this.playing) void ctx.suspend()
    } catch {
      // Without Web Audio the preview tops out at 100%; export still applies the gain.
    }
  }

  dispose(): void {
    if (this.disposed) return
    this.stopPlaying()
    this.disposed = true
    cancelAnimationFrame(this.drawRaf)
    this.screen.removeEventListener('seeked', this.onSeeked)
    this.screen.removeEventListener('loadeddata', this.invalidate)
    this.screen.removeEventListener('ended', this.onEnded)
    this.screen.removeEventListener('pause', this.onPause)
    this.webcam?.removeEventListener('seeked', this.invalidate)
    this.webcam?.removeEventListener('loadeddata', this.invalidate)
    void this.audio?.ctx.close()
    this.listeners.clear()
    for (const v of [this.screen, this.webcam]) {
      if (!v) continue
      v.removeAttribute('src')
      v.load()
    }
  }
}
