import type { StemKind } from '../../../shared/audio/settings'
import { displayTime } from '../../../shared/editor/clips'
import { clamp } from '../../../shared/engine/math'
import { clipIndexAt, keptBounds, playableFrom } from '../../../shared/engine/timeline'
import { ClickSoundScheduler, clickWaveform, soundingClicks } from '../../../shared/render/clickSound'
import { cursorLook } from '../../../shared/render/cursorFx'
import type { Clip, Project } from '../../../shared/types'
import { drawFrame, type RenderScene } from '../render/compositor'
import { onCursorAssetsChanged } from '../render/cursorLayer'
import { onCameraMasksChanged } from '../render/segmentation/cameraMasks'
import { onStyleAssetsChanged } from '../render/watermarkLayer'
import { PreviewAudio } from './previewAudio'

/** Proxy frame rate when the project does not say (older projects: always 60 fps). */
const SOURCE_FPS = 60
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

  /** One proxy frame (proxies run at the recording's frame rate, 30 or 60 fps); used to look ahead at cut points. */
  private get frame(): number {
    return 1 / (this.project.capture?.fps ?? SOURCE_FPS)
  }
  private scene: RenderScene | null = null
  private unzoomed: RenderScene | null = null
  private background: HTMLImageElement | null = null
  private canvas: HTMLCanvasElement | null = null
  private ctx: CanvasRenderingContext2D | null = null
  private noZoom = false
  /** Draw without the 3D tilt (while something is edited on the preview, so handles line up). */
  private flat = false
  private flatScene: RenderScene | null = null
  private readonly listeners = new Set<() => void>()
  private drawRaf = 0
  private frameHandle = 0
  private pendingSeek: number | null = null
  private jumpTarget: number | null = null
  /** The soundtrack: the video's own track, or Web Audio for stems, music, fades and gains above 100%. */
  private readonly sound: PreviewAudio
  /** Click sounds (CursorSettings.clickSound): which clicks play, and the Web Audio graph playing them. */
  private readonly clickSounds = new ClickSoundScheduler()
  private clickAudio: { ctx: AudioContext; gain: GainNode; buffer: AudioBuffer; voices: Set<AudioBufferSourceNode> } | null = null
  private readonly offCursorAssets: () => void
  private readonly offStyleAssets: () => void
  private readonly offCameraMasks: () => void
  private disposed = false

  constructor(
    readonly screen: HTMLVideoElement,
    readonly webcam: HTMLVideoElement | null,
    project: Project,
    /** Stems whose file was missing when the project was opened: it opened without them (see openedWithoutStems). */
    readonly missingStems: readonly StemKind[] = []
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
    this.sound = new PreviewAudio(screen, project)
    this.sound.onStemFailed = () => this.emit()
    // A custom cursor image finishing loading changes the picture.
    this.offCursorAssets = onCursorAssetsChanged(this.invalidate)
    this.offStyleAssets = onStyleAssetsChanged(this.invalidate)
    // The camera's background blur: a frame's person mask arrives after the frame.
    this.offCameraMasks = onCameraMasksChanged(this.invalidate)
    this.seek(keptBounds(project.clips).start)
  }

  /* ---------- observers ---------- */

  subscribe = (listener: () => void): (() => void) => {
    this.listeners.add(listener)
    return () => this.listeners.delete(listener)
  }

  getPlaying = (): boolean => this.playing

  /** Stems the preview could not load, as "mic,system" (a stable snapshot for useSyncExternalStore). */
  getFailedStems = (): string => this.sound.failedStems.join(',')

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
    this.clickSounds.setTimes(soundingClicks(scene.cursor))
    this.unzoomed = null
    this.flatScene = null
    this.background = background
    this.invalidate()
  }

  /** Shows the frame without zoom (while the user picks a zoom's focus point on it). */
  setNoZoom(on: boolean): void {
    if (this.noZoom === on) return
    this.noZoom = on
    this.invalidate()
  }

  /** Shows the frame without the 3D tilt (while the user edits something on the preview). */
  setFlat(on: boolean): void {
    if (this.flat === on) return
    this.flat = on
    this.invalidate()
  }

  setProject(project: Project): void {
    const prev = this.project
    this.project = project
    this.sound.setProject(project)
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
      this.clickSounds.restart(from.time)
      this.screen.currentTime = from.time
      this.sound.jump(from.time, clips[from.index].speed)
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
    if (!from || this.time >= keptBounds(clips).end - this.frame) from = { time: clips[0].start, index: 0 }
    this.playing = true
    this.time = from.time
    this.pendingSeek = null
    this.jumpTarget = null
    this.setRate(clips[from.index].speed)
    if (Math.abs(this.screen.currentTime - from.time) > 1e-3) this.screen.currentTime = from.time
    this.syncWebcam(from.time, true)
    this.sound.play(from.time, clips[from.index].speed)
    this.clickSounds.restart(from.time)
    // Created here, inside the user's gesture, so the audio context may start.
    if (cursorLook(this.project.cursor).clickSound) void this.ensureClickAudio()?.ctx.resume()
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
    drawFrame(ctx, canvas.width, canvas.height, t, this.noZoom ? this.unzoomedScene(scene) : this.flat ? this.untiltedScene(scene) : scene, {
      screen: this.screen,
      webcam: this.webcam,
      background: this.background
    })
  }

  private unzoomedScene(scene: RenderScene): RenderScene {
    if (!this.unzoomed) this.unzoomed = { ...scene, project: { ...scene.project, zooms: [], tilt: undefined } }
    return this.unzoomed
  }

  private untiltedScene(scene: RenderScene): RenderScene {
    if (!scene.project.tilt?.enabled) return scene
    if (!this.flatScene) this.flatScene = { ...scene, project: { ...scene.project, tilt: undefined } }
    return this.flatScene
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
      if (Math.abs(t - this.jumpTarget) > this.frame * 1.5 && t < this.jumpTarget) {
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
    this.sound.frame()
    this.draw(t)
    this.playClicks(t, clip)
    this.emit()
    // Jump before the next decoded frame would land in a cut (or past the end).
    if (t + clip.speed * this.frame >= clip.end - 1e-4) this.leaveClip(clips, i)
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
    // Clicks in the cut are skipped; the next clip's clicks play from its start.
    this.clickSounds.restart(time)
    this.setRate(this.project.clips[index].speed)
    this.screen.currentTime = time
    this.sound.jump(time, this.project.clips[index].speed)
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
    this.sound.pause()
    this.stopClicks()
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
    // A late event from an earlier pause() must not stop a playback that has restarted since.
    if (!this.playing || !this.screen.paused) return
    if (this.screen.ended) this.finish()
    else this.pause()
  }

  /* ---------- media helpers ---------- */

  /** Source time to seek to for showing `s`; the edit's end shows its last kept frame. */
  private frameTimeFor(s: number): number {
    const clips = this.project.clips
    const last = clips[clips.length - 1]
    const media = Number.isFinite(this.screen.duration) ? this.screen.duration : this.project.duration
    const t = s >= last.end - 1e-6 ? Math.max(last.start, last.end - this.frame / 4) : s
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
    this.sound.setRate(speed)
  }

  /** Loads the background music again (a new file replaced it under the same name). */
  reloadMusic(): void {
    this.sound.reloadMusic()
  }

  /* ---------- click sounds ---------- */

  /**
   * Plays the click sounds due for the frame at `t` (see ClickSoundScheduler): only during
   * playback, each click once, none for clicks in cuts, at the right moment at any speed.
   */
  private playClicks(t: number, clip: Clip): void {
    const look = cursorLook(this.project.cursor)
    if (!look.clickSound || look.clickSoundVolume <= 0) {
      // Switching sounds on mid-playback starts at the playhead, not with a backlog.
      this.clickSounds.reset()
      return
    }
    const due = this.clickSounds.frame(t, clip)
    if (due.length === 0) return
    const audio = this.ensureClickAudio()
    if (!audio) return
    if (audio.ctx.state === 'suspended') void audio.ctx.resume()
    // The whole soundtrack's fades apply to the clicks too, as in the export.
    audio.gain.gain.value = look.clickSoundVolume * this.sound.fadeAt(t)
    const now = audio.ctx.currentTime
    for (const d of due) {
      const voice = audio.ctx.createBufferSource()
      voice.buffer = audio.buffer
      voice.connect(audio.gain)
      voice.onended = () => {
        audio.voices.delete(voice)
        voice.disconnect()
      }
      audio.voices.add(voice)
      voice.start(now + d.delay)
    }
  }

  /** The click sound graph, created on first use (an AudioContext costs CPU while it runs). */
  private ensureClickAudio(): PreviewPlayer['clickAudio'] {
    if (this.clickAudio || this.disposed) return this.clickAudio
    try {
      const ctx = new AudioContext({ latencyHint: 'interactive' })
      const gain = ctx.createGain()
      gain.connect(ctx.destination)
      const wave = clickWaveform(ctx.sampleRate)
      const buffer = ctx.createBuffer(1, wave.length, ctx.sampleRate)
      buffer.copyToChannel(wave, 0)
      this.clickAudio = { ctx, gain, buffer, voices: new Set() }
    } catch (err) {
      // Without Web Audio the preview is silent; the export still mixes the clicks in.
      console.warn('Click sounds unavailable in the preview:', err)
    }
    return this.clickAudio
  }

  /** Silences clicks still scheduled (pausing must not let one play late) and idles the audio context. */
  private stopClicks(): void {
    this.clickSounds.reset()
    const audio = this.clickAudio
    if (!audio) return
    for (const v of audio.voices) {
      try {
        v.stop()
      } catch {
        // Already stopped.
      }
    }
    audio.voices.clear()
    void audio.ctx.suspend()
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
    this.sound.dispose()
    // The editor is closing: the project's analyses (smart speed, sound levels) stop reading its files.
    void window.api.stopAnalysis(this.project.id).catch(() => undefined)
    void this.clickAudio?.ctx.close()
    this.clickAudio = null
    this.offCursorAssets()
    this.offStyleAssets()
    this.offCameraMasks()
    this.listeners.clear()
    for (const v of [this.screen, this.webcam]) {
      if (!v) continue
      v.removeAttribute('src')
      v.load()
    }
  }
}
