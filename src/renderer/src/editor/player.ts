import { hasSoundtrack, type StemKind } from '../../../shared/audio/settings'
import { displayTime, outputTimeAt } from '../../../shared/editor/clips'
import {
  DEFAULT_PREVIEW_SPEED,
  elementRate,
  isPreviewSpeed,
  pressShuttle,
  reversePosition,
  soundAt,
  STOPPED,
  viewRate,
  type PreviewSpeed,
  type Shuttle,
  type ShuttleKey,
  type ShuttleStep
} from '../../../shared/editor/shuttle'
import { pictureTime, planOf, type FreezePlan, type Hold } from '../../../shared/engine/freeze'
import { croppedFrameSize } from '../../../shared/engine/crop'
import { cameraShownAt } from '../../../shared/engine/layout'
import { clamp } from '../../../shared/engine/math'
import { withoutFollow } from '../../../shared/engine/reframeData'
import { clipIndexAt, keptBounds, playableFrom } from '../../../shared/engine/timeline'
import { webcamLook } from '../../../shared/engine/webcamData'
import { ClickSoundScheduler, clickWaveform, soundingClicks } from '../../../shared/render/clickSound'
import { cursorLook } from '../../../shared/render/cursorFx'
import { JUMP_SLACK } from '../../../shared/render/cutFades'
import { frameSeekTime } from '../../../shared/render/frameTiming'
import type { Clip, Project } from '../../../shared/types'
import { drawFrame, type DrawOptions, type FrameImage, type RenderScene } from '../render/compositor'
import { onCursorAssetsChanged } from '../render/cursorLayer'
import { heldLivePicture, onCameraMasksChanged } from '../render/segmentation/cameraMasks'
import { onStyleAssetsChanged } from '../render/watermarkLayer'
import { FreezeStills } from './freezeStills'
import { PreviewAudio } from './previewAudio'

/** Proxy frame rate when the project does not say (older projects: always 60 fps). */
const SOURCE_FPS = 60
/** Seconds of viewing time the camera may drift from the screen before it is seeked back. */
const WEBCAM_DRIFT = 0.15
/** A frozen frame (E-11) is drawn sharp, as the export draws it: no motion blur. */
const FROZEN: DrawOptions = { blurSamples: 1 }

const hasVideoFrameCallback = typeof HTMLVideoElement !== 'undefined' && 'requestVideoFrameCallback' in HTMLVideoElement.prototype

/** The preview speed the next editor starts with: the last one chosen in this app session (never saved). */
let sessionPreviewSpeed: PreviewSpeed = DEFAULT_PREVIEW_SPEED

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

  /** How fast normal playback runs; the project and the export never see it. */
  get previewSpeed(): PreviewSpeed {
    return this.speedSetting
  }

  /** J/K/L: the direction and how many doublings above the preview speed. */
  get shuttleState(): Shuttle {
    return this.shuttleNow
  }

  /** Playing backwards (J). */
  get reversing(): boolean {
    return this.rev !== null
  }

  /** Anything moving: playing forward, or shuttling in reverse. */
  get moving(): boolean {
    return this.playing || this.rev !== null
  }

  /** Signed viewing rate: direction × preview speed × 2^shuttle level; 0 when stopped. */
  get viewRate(): number {
    return viewRate(this.shuttleNow, this.speedSetting)
  }

  /**
   * Seconds into the pause freeze being held (E-11). Just after one, until the playhead moves past
   * its frame, its whole length: video time counts a hold AT a time apart (editToVideo leaves it out).
   */
  get holdElapsed(): number {
    if (this.hold) return this.hold.elapsed
    const p = this.passed
    return p && !(p.edit < outputTimeAt(this.project.clips, this.time) - 1e-9) ? p.length : 0
  }

  /** Id of the pause freeze being held (its timeline block shows how far), or null. */
  get heldFreeze(): string | null {
    return this.hold?.h.id ?? null
  }

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
  private speedSetting: PreviewSpeed = sessionPreviewSpeed
  private shuttleNow: Shuttle = STOPPED
  /**
   * Reverse playback: it started (or was last re-anchored) at output second `fromOut` at wall time
   * `t0` (ms), runs at `rate` output seconds per second, and waits for an animation frame `raf`.
   */
  private rev: { fromOut: number; t0: number; rate: number; raf: number } | null = null
  /** Whether the soundtrack plays at the current rates (see soundAt); off, the sound is paused. */
  private audible = true
  /** The camera's picture from before a seek during playback, drawn until the seek lands (closed then). */
  private heldCam: VideoFrame | null = null
  /** The soundtrack: the video's own track, or Web Audio for stems, music, fades and gains above 100%. */
  private readonly sound: PreviewAudio
  /** Click sounds (CursorSettings.clickSound): which clicks play, and the Web Audio graph playing them. */
  private readonly clickSounds = new ClickSoundScheduler()
  private clickAudio: { ctx: AudioContext; gain: GainNode; buffer: AudioBuffer; voices: Set<AudioBufferSourceNode> } | null = null
  private readonly offCursorAssets: () => void
  private readonly offStyleAssets: () => void
  private readonly offCameraMasks: () => void
  /**
   * Freeze frames (E-11): the plan; the pause freeze being held (seconds into it, and the wall clock
   * of the last tick) and its timer; the one just left; where playback may next enter a hold (source
   * s: the end of what earlier frames looked ahead at); the stills continue freezes show.
   */
  private plan: FreezePlan
  private hold: { h: Hold; elapsed: number; t0: number } | null = null
  private holdRaf = 0
  private passed: Hold | null = null
  private holdFrom = 0
  private stills: FreezeStills | null = null
  private disposed = false

  constructor(
    readonly screen: HTMLVideoElement,
    readonly webcam: HTMLVideoElement | null,
    project: Project,
    /** Stems whose file was missing when the project was opened: it opened without them (see openedWithoutStems). */
    readonly missingStems: readonly StemKind[] = []
  ) {
    this.project = project
    this.plan = planOf(project)
    screen.preservesPitch = true
    if (webcam) {
      webcam.muted = true
      webcam.preservesPitch = true
      webcam.addEventListener('seeked', this.onWebcamSeeked)
      webcam.addEventListener('loadeddata', this.invalidate)
      webcam.addEventListener('error', this.onWebcamSeeked)
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
    this.prepareStills()
    this.seek(keptBounds(project.clips).start)
  }

  /* ---------- observers ---------- */

  subscribe = (listener: () => void): (() => void) => {
    this.listeners.add(listener)
    return () => this.listeners.delete(listener)
  }

  getPlaying = (): boolean => this.moving

  /**
   * The shuttle as "dir|level|previewSpeed|silent" (a stable snapshot for useSyncExternalStore):
   * silent is 1 while playing forward without the sound a project with sound would have.
   */
  getShuttleKey = (): string => {
    const s = this.shuttleNow
    const silent = s.dir > 0 && !this.audible && hasSoundtrack(this.project, cursorLook(this.project.cursor).clickSound)
    return `${s.dir}|${s.level}|${this.speedSetting}|${silent ? 1 : 0}`
  }

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

  /** Shows the frame without zoom, and the whole recording without following the action (while the user picks a zoom's focus point on it). */
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
    if (project.clips !== prev.clips || project.freezes !== prev.freezes) this.replan()
  }

  /* ---------- transport ---------- */

  seek(t: number): void {
    // A seek leaves a pause freeze (E-11); playback goes on from the new place.
    const held = this.clearHold()
    this.time = clamp(t, 0, this.project.duration)
    const clips = this.project.clips
    // Reversing: the loop moves the video from the new position.
    if (this.rev) this.anchorReverse(outputTimeAt(clips, this.time))
    else if (this.playing) {
      const from = playableFrom(clips, this.time)
      if (!from) {
        this.finish()
        return
      }
      this.time = from.time
      this.holdFrom = from.time - this.frame / 2
      this.setRate(clips[from.index].speed)
      this.jumpTarget = null
      this.clickSounds.restart(from.time)
      this.screen.currentTime = from.time
      this.sound.jump(from.time, this.rateFor(clips[from.index].speed))
      this.syncWebcam(from.time, true)
      if (held) this.goOn()
    } else {
      // On a pause freeze's anchor (a paused edit in its hold, a click on its block, text added on
      // it): the middle of its frame, as the hold and the export show it, not the frame before.
      const anchor = this.plan.holds.some((h) => !h.end && h.at === this.time)
      this.seekVideo(anchor ? frameSeekTime(this.time, 1 / this.frame) : this.frameTimeFor(displayTime(clips, this.time)))
    }
    this.emit()
  }

  play(): void {
    if (this.playing || this.disposed) return
    if (this.rev) this.stopReverse()
    if (this.shuttleNow.dir !== 1) this.shuttleNow = { dir: 1, level: 0 }
    // Paused in a pause freeze (E-11): the hold goes on.
    if (this.hold) return this.resumeHold()
    const clips = this.project.clips
    let from = playableFrom(clips, this.time)
    if (!from || this.time >= keptBounds(clips).end - this.frame) from = { time: clips[0].start, index: 0 }
    // On the frame of the pause freeze just left, that one is over; otherwise one at the playhead starts the playback.
    const after = !!this.passed && this.holdElapsed > 0 && from.time >= this.passed.at - this.frame
    this.holdFrom = after ? this.passed!.at + 1e-6 : from.time - this.frame / 2
    if (!after) this.clearHold()
    this.playing = true
    this.time = from.time
    this.pendingSeek = null
    this.jumpTarget = null
    this.setRate(clips[from.index].speed)
    if (Math.abs(this.screen.currentTime - from.time) > 1e-3) this.screen.currentTime = from.time
    this.syncWebcam(from.time, true)
    if (this.audible) this.sound.play(from.time, this.rateFor(clips[from.index].speed))
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
    if (this.rev) {
      this.stopReverse()
      this.emit()
      return
    }
    if (!this.playing) return
    this.stopPlaying()
    // In a pause freeze (E-11) the playhead stays on its frame.
    if (!this.hold) this.time = this.screen.currentTime
    this.emit()
  }

  toggle(): void {
    if (this.moving) this.pause()
    else this.play()
  }

  /**
   * J (reverse), K (pause) or L (forward); `pauseHeld` while K is down. Returns the step, whose
   * `frameStep` the caller applies (one frame, as the arrow keys do) when J or L was tapped with K held.
   */
  shuttle(key: ShuttleKey, pauseHeld = false): ShuttleStep {
    const step = pressShuttle(this.shuttleNow, key, pauseHeld)
    const next = step.next
    if (next.dir === 0) {
      this.pause()
    } else if (next.dir > 0) {
      if (this.rev) this.stopReverse()
      this.shuttleNow = next
      if (this.playing) {
        this.applyRate()
        this.emit()
      } else this.play()
    } else {
      if (this.playing) {
        // Stop where the picture is, then run backwards from there (silently).
        this.stopPlaying()
        this.time = this.screen.currentTime
      }
      const out = this.rev ? this.reverseOut() : outputTimeAt(this.project.clips, this.time)
      this.shuttleNow = next
      // Again: faster from where it is now.
      if (this.rev) this.anchorReverse(out)
      else this.startReverse(out)
      this.emit()
    }
    return step
  }

  /** Sets the preview speed (also for the next editor opened in this app session); playback follows at once. */
  setPreviewSpeed(speed: PreviewSpeed): void {
    if (!isPreviewSpeed(speed) || speed === this.speedSetting) return
    const out = this.reverseOut()
    this.speedSetting = speed
    sessionPreviewSpeed = speed
    if (this.playing) this.applyRate()
    else if (this.rev) this.anchorReverse(out)
    this.emit()
  }

  /* ---------- drawing ---------- */

  /**
   * Redraws on the next animation frame (coalesced); a no-op while playing. Not while the screen
   * seeks, nor while the camera seeks when the frame shows it: it would be missing (with a camera
   * layout, the whole picture changes); the one landing last redraws. A camera the frame does not
   * show (turned off, or hidden by the layout) is not waited for.
   */
  invalidate = (): void => {
    // While a pause freeze holds (E-11) no frame comes: it redraws like a paused player.
    if ((this.playing && !this.hold) || this.drawRaf || this.disposed) return
    this.drawRaf = requestAnimationFrame(() => {
      this.drawRaf = 0
      const t = this.screen.currentTime
      if ((!this.playing || this.hold) && !this.screen.seeking && !(this.webcamSeeking() && this.webcamShownAt(t))) this.draw(t)
    })
  }

  /** Redraws synchronously (after the canvas was resized, which clears it). */
  drawNow(): void {
    if (!this.screen.seeking) this.draw(this.screen.currentTime)
  }

  private draw(t: number): void {
    const { canvas, ctx, scene } = this
    if (!canvas || !ctx || !scene || this.screen.readyState < 2) return
    // Freeze frames (E-11): a pause freeze shows its frame (the playhead stays on it), a continue
    // freeze its still once that is ready (the screen plays on for its sound); both sharp.
    const s = this.hold ? this.heldTime(this.hold.h) : t
    const p = pictureTime(this.project.clips, this.plan, s)
    const still = p !== s ? this.stills?.get(p) : null
    drawFrame(
      ctx,
      canvas.width,
      canvas.height,
      still ? p : s,
      this.noZoom ? this.unzoomedScene(scene) : this.flat ? this.untiltedScene(scene) : scene,
      {
        screen: this.screen,
        webcam: this.webcam,
        background: this.background,
        webcamFrame: this.seekingWebcamPicture(scene),
        ...(still && { screenFrame: { image: still, width: still.width, height: still.height } })
      },
      this.hold || still ? FROZEN : undefined,
      s
    )
  }

  /** True while the camera seeks (an element that failed never lands: it does not hold drawing up). */
  private webcamSeeking(): boolean {
    return !!this.webcam?.seeking && !this.webcam.error
  }

  /** True when the frame at `t` shows the camera: the compositor's own test (cameraShownAt), at the size it draws. */
  private webcamShownAt(t: number): boolean {
    const { canvas, scene } = this
    if (!canvas || !scene) return false
    const p = scene.project
    const shown = croppedFrameSize(scene.crop ?? null, this.screen.videoWidth, this.screen.videoHeight, p)
    return cameraShownAt(p, canvas.width, canvas.height, shown.width, shown.height, t)
  }

  /**
   * The camera's picture while it seeks, when its element has none: with the background blurred,
   * the live camera's last blurred frame (the layer finds it through the element); otherwise the
   * frame held from before the seek. Null when it is not seeking (the element is drawn as it is).
   */
  private seekingWebcamPicture(scene: RenderScene): FrameImage | null {
    const cam = this.webcam
    if (!cam || !this.webcamSeeking()) return null
    if (webcamLook(scene.project.webcam).backgroundBlur > 0 && heldLivePicture(cam)) return { image: cam, width: cam.videoWidth, height: cam.videoHeight }
    const held = this.heldCam
    return held ? { image: held, width: held.displayWidth, height: held.displayHeight } : null
  }

  private unzoomedScene(scene: RenderScene): RenderScene {
    if (!this.unzoomed) this.unzoomed = { ...scene, project: withoutFollow({ ...scene.project, zooms: [], tilt: undefined }) }
    return this.unzoomed
  }

  private untiltedScene(scene: RenderScene): RenderScene {
    if (!scene.project.tilt?.enabled) return scene
    if (!this.flatScene) this.flatScene = { ...scene, project: { ...scene.project, tilt: undefined } }
    return this.flatScene
  }

  /* ---------- playback loop ---------- */

  private scheduleFrame(): void {
    if (!this.playing || this.hold) return
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
    let t = meta ? meta.mediaTime : this.screen.currentTime
    const clips = this.project.clips
    if (this.jumpTarget !== null) {
      // Frames decoded before the jump landed belong to the cut: never show them.
      if (Math.abs(t - this.jumpTarget) > this.frame * 1.5 && t < this.jumpTarget) {
        this.scheduleFrame()
        return
      }
      this.jumpTarget = null
    }
    let i = clipIndexAt(clips, t)
    const next = i < 0 ? playableFrom(clips, t) : null
    // A clip that starts between two frames (a transcript cut) first shows the frame covering its
    // start, whose time is just before it: that is the clip's first frame, not one to jump from again.
    if (next && next.time - t < this.frame - 1e-6) {
      t = next.time
      i = next.index
    }
    if (i < 0) {
      if (next) this.jumpTo(next.time, next.index)
      else this.finish()
      if (this.playing) this.scheduleFrame()
      return
    }
    const clip = clips[i]
    const rate = this.rateFor(clip.speed)
    if (this.screen.playbackRate !== rate) this.setRate(clip.speed)
    this.time = t
    this.syncWebcam(t, false)
    this.leavePassed(t)
    this.draw(t)
    // Clicks land on their frames at the element's rate; none while the sound is off.
    if (this.audible) this.playClicks(t, rate === clip.speed ? clip : { ...clip, speed: rate })
    else this.clickSounds.reset()
    this.emit()
    // A pause freeze whose frame comes before the next decoded frame: hold it there (E-11).
    if (this.holdAhead(t)) return
    // Then the soundtrack: on a frame that holds, the element's clock can be past the anchor, which
    // video time counts after the whole hold (the hold's ticks keep it on time instead).
    this.sound.frame(t)
    // Jump before the next decoded frame would land in a cut (or past the end).
    if (t + rate * this.frame >= clip.end - JUMP_SLACK) this.leaveClip(clips, i)
    if (this.playing) this.scheduleFrame()
  }

  private leaveClip(clips: Clip[], i: number): void {
    const next = clips[i + 1]
    if (!next) {
      // A pause freeze at the edit's end holds the last frame first (E-11).
      const end = this.plan.holds.find((h) => h.end)
      if (end) this.startHold(end)
      else this.finish()
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
    this.sound.jump(time, this.rateFor(this.project.clips[index].speed))
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
    if (!this.rev) this.shuttleNow = STOPPED
    this.cancelFrame()
    this.jumpTarget = null
    if (!this.screen.paused) this.screen.pause()
    if (this.webcam && !this.webcam.paused) this.webcam.pause()
    this.sound.pause()
    // A paused editor never keeps a shuttle's mute.
    this.audible = true
    this.sound.setSilent(false)
    this.stopClicks()
    if (wasPlaying) {
      this.emit()
      this.invalidate()
    }
  }

  private onEnded = (): void => {
    if (this.playing && !this.hold) this.finish()
  }

  /** The element paused on its own (end of file, media session keys): keep the transport honest. */
  private onPause = (): void => {
    // A late event from an earlier pause() must not stop a playback that has restarted since, nor
    // the player's own pause for a pause freeze (E-11).
    if (!this.playing || this.hold || !this.screen.paused) return
    if (this.screen.ended) this.finish()
    else this.pause()
  }

  /* ---------- reverse (J) ---------- */

  /**
   * Plays backwards from output second `out`, silently. Chromium cannot play a video backwards, so
   * the loop seeks: each landed seek is drawn (onSeeked), then the next wall-clock position is
   * sought. The position is walked in output time, so cuts are skipped.
   */
  private startReverse(out: number): void {
    // Reverse playback skips freeze frames (E-11): a hold in progress is left.
    this.clearHold()
    this.pendingSeek = null
    this.rev = { fromOut: out, t0: performance.now(), rate: Math.abs(this.viewRate), raf: 0 }
    this.revStep()
  }

  /** Output second reverse playback has reached by now. */
  private reverseOut(): number {
    const rev = this.rev
    return rev ? Math.max(0, rev.fromOut - ((performance.now() - rev.t0) / 1000) * rev.rate) : 0
  }

  /** Reverse playback goes on from output second `out` at the current viewing rate (a seek, a new rate, an edit). */
  private anchorReverse(out: number): void {
    const rev = this.rev
    if (!rev) return
    rev.fromOut = out
    rev.t0 = performance.now()
    rev.rate = Math.abs(this.viewRate)
  }

  /** One step: seeks to where reverse playback should be now, or waits a display frame when that is the frame shown. */
  private revStep = (): void => {
    const rev = this.rev
    if (!rev || this.disposed) return
    rev.raf = 0
    const clips = this.project.clips
    const r = reversePosition(clips, rev.fromOut, (performance.now() - rev.t0) / 1000, rev.rate)
    this.time = r.time
    if (r.done) {
      // Reached the start: stops on the first kept frame.
      this.stopReverse()
      this.emit()
      return
    }
    const s = this.frameTimeFor(r.time)
    if (Math.abs(this.screen.currentTime - s) < this.frame / 2) {
      rev.raf = requestAnimationFrame(this.revStep)
    } else {
      this.screen.currentTime = s
      this.reverseWebcam(s)
    }
    this.emit()
  }

  /** Stops reverse playback and shows the frame of the playhead (a seek may still have been under way). */
  private stopReverse(): void {
    const rev = this.rev
    if (!rev) return
    cancelAnimationFrame(rev.raf)
    this.rev = null
    this.shuttleNow = STOPPED
    this.seekVideo(this.frameTimeFor(displayTime(this.project.clips, this.time)))
  }

  /**
   * Follows reverse playback with the camera: never while its last seek is under way (seeking it
   * again would restart that seek, and it would never show a picture); its picture is held meanwhile.
   */
  private reverseWebcam(s: number): void {
    const cam = this.webcam
    if (!cam || cam.seeking) return
    this.holdWebcam(cam)
    cam.currentTime = Math.max(0, s - this.project.webcamOffset)
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
    const rev = this.rev
    if (rev) {
      // Reverse: draw the frame that landed, then seek the next one.
      cancelAnimationFrame(rev.raf)
      rev.raf = requestAnimationFrame(() => {
        rev.raf = 0
        if (this.rev !== rev) return
        this.draw(this.screen.currentTime)
        this.revStep()
      })
      return
    }
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

  /**
   * Seeks the camera to the screen's time `t` (forced, or when it drifted). A drift is measured in
   * viewing time, and not while a seek is under way: at a high speed the camera would otherwise
   * be seeked again before it lands, over and over, and never show a picture.
   */
  private syncWebcam(t: number, force: boolean): void {
    const cam = this.webcam
    if (!cam) return
    const want = Math.max(0, t - this.project.webcamOffset)
    const drift = WEBCAM_DRIFT * Math.max(1, this.screen.playbackRate)
    if (force || (!cam.seeking && Math.abs(cam.currentTime - want) > drift)) {
      if (this.playing) this.holdWebcam(cam)
      cam.currentTime = want
    }
    if (this.playing && !this.hold && cam.paused && this.webcamInRange(t)) void cam.play().catch(() => undefined)
  }

  /** Keeps the camera's current picture to draw while it seeks (one copy per seek; one already held is kept). */
  private holdWebcam(cam: HTMLVideoElement): void {
    if (cam.seeking || cam.readyState < 2 || typeof VideoFrame === 'undefined') return
    this.releaseWebcam()
    try {
      this.heldCam = new VideoFrame(cam)
    } catch {
      // No picture to keep: the camera is left out until its seek lands, as before.
    }
  }

  private releaseWebcam(): void {
    this.heldCam?.close()
    this.heldCam = null
  }

  private onWebcamSeeked = (): void => {
    if (this.webcamSeeking()) return
    this.releaseWebcam()
    // A camera the paused frame does not show changes nothing in it.
    if (this.webcamShownAt(this.screen.currentTime)) this.invalidate()
  }

  /**
   * Plays a clip at `speed` at the current viewing rate: the elements' rate, the sound's rate and
   * timing, and whether there is sound at all (paused, and the element muted, when there is not).
   */
  private setRate(speed: number): void {
    const view = this.viewRate
    const rate = elementRate(speed, view)
    this.screen.playbackRate = rate
    if (this.webcam) this.webcam.playbackRate = rate
    this.sound.setRate(rate)
    this.sound.setView(Math.abs(view))
    const audible = soundAt(speed, view)
    if (audible === this.audible) return
    this.audible = audible
    if (audible) {
      if (this.playing) this.sound.play(this.screen.currentTime, rate)
      this.sound.setSilent(false)
    } else {
      this.sound.setSilent(true)
      this.sound.pause()
      this.stopClicks()
    }
  }

  /** The viewing rate changed during playback (L again, the preview speed): the clip under the playhead follows. */
  private applyRate(): void {
    const clips = this.project.clips
    const i = clipIndexAt(clips, this.time)
    // In a cut, the next frame jumps and sets the next clip's rate.
    if (i >= 0) this.setRate(clips[i].speed)
  }

  /** The element rate for a clip at `speed` at the current viewing rate. */
  private rateFor(speed: number): number {
    return elementRate(speed, this.viewRate)
  }

  /* ---------- freeze frames (E-11) ---------- */

  /**
   * A new freeze plan; the stills follow. While playing, a hold in progress is let go as when it runs
   * out (playback goes on past its frame, or ends after one at the edit's end), and one just left
   * stays left: an edit never holds that frame again. Paused, or when that freeze moved or went, it
   * is a seek (play then starts a hold on the frame from its beginning).
   */
  private replan(): void {
    const plan = planOf(this.project)
    if (plan === this.plan) return
    this.plan = plan
    this.prepareStills()
    const left = this.hold?.h ?? this.passed
    if (!left) return
    // The same freeze on the same frame (its length, or the edit around it, may have changed).
    const h = this.playing ? plan.holds.find((x) => x.id === left.id && x.at === left.at) : undefined
    if (!h) return this.seek(this.time)
    if (!this.hold) {
      this.passed = h
      this.sound.hold(h, h.length)
      return
    }
    cancelAnimationFrame(this.holdRaf)
    this.holdRaf = 0
    this.hold.h = h
    this.leaveHold()
  }

  /** Makes the stills of the continue freezes ahead (the cache exists only once there are some). */
  private prepareStills(): void {
    const ats = this.plan.stills.map((s) => s.at)
    if (ats.length === 0) return
    this.stills ??= new FreezeStills(this.screen.currentSrc || this.screen.src, 1 / this.frame, this.invalidate)
    this.stills.prepare(ats)
  }

  /**
   * Holds the pause freeze whose frame comes before the next decoded frame (from where earlier
   * frames looked ahead to, so one is not missed when frames are dropped): true when it did.
   */
  private holdAhead(t: number): boolean {
    const until = t + this.screen.playbackRate * this.frame
    const h = this.plan.holds.find((x) => !x.end && x.at >= this.holdFrom && x.at < until)
    if (h) this.startHold(h)
    else this.holdFrom = Math.max(this.holdFrom, until)
    return !!h
  }

  /**
   * Holds pause freeze `h`: the screen and camera wait on its frame (the edit's last for one at its
   * end), the stems with them, while the music plays on; a wall clock at the viewing rate runs its
   * length. The playhead stays on the frame.
   */
  private startHold(h: Hold): void {
    // The middle of the held frame, as the export and FreezeStills seek: a seek to a frame's start can
    // show the frame before (Chromium truncates it to whole µs: 2.05 s seeks 2.049999 s).
    const s = h.end ? this.heldTime(h) : frameSeekTime(h.at, 1 / this.frame)
    const played = !this.screen.paused
    // Set first: pausing the screen fires 'pause', and no frame callback may run meanwhile.
    this.hold = { h, elapsed: 0, t0: performance.now() }
    this.passed = null
    this.time = this.heldTime(h)
    this.cancelFrame()
    if (played) this.screen.pause()
    if (this.webcam && !this.webcam.paused) this.webcam.pause()
    // A playing element can show a frame decoded ahead of its time: it seeks even when it is there.
    if (played || Math.abs(this.screen.currentTime - s) > 1e-3) this.screen.currentTime = s
    // Forced: the camera's drift tolerance would hold a different face than the export.
    this.syncWebcam(this.time, true)
    this.sound.hold(h, 0)
    this.invalidate()
    cancelAnimationFrame(this.holdRaf)
    this.holdRaf = requestAnimationFrame(this.holdTick)
    this.emit()
  }

  /**
   * Source time a hold shows: its frame, or for one at the edit's end the last frame (as the paused
   * end shows it, whichever side of the edit's end its whole-ms anchor fell).
   */
  private heldTime(h: Hold): number {
    return h.end ? this.frameTimeFor(keptBounds(this.project.clips).end) : h.at
  }

  /** Playing again while paused in a hold: the music plays on (the stems wait), the hold's clock goes on. */
  private resumeHold(): void {
    const hold = this.hold!
    const clips = this.project.clips
    this.playing = true
    hold.t0 = performance.now()
    // The viewing rate of this playback (a hold at the edit's end belongs to the last clip).
    this.setRate(clips[clipIndexAt(clips, hold.h.at)]?.speed ?? clips[clips.length - 1].speed)
    if (this.audible) this.sound.play(this.screen.currentTime, this.screen.playbackRate)
    this.sound.hold(hold.h, hold.elapsed)
    // Created here, inside the user's gesture, so the audio context may start.
    if (cursorLook(this.project.cursor).clickSound) void this.ensureClickAudio()?.ctx.resume()
    cancelAnimationFrame(this.holdRaf)
    this.holdRaf = requestAnimationFrame(this.holdTick)
    this.emit()
  }

  /** One tick of a hold: a pause freeze lasts length / |viewing rate| seconds of wall clock (the rate is never 0 while playing). */
  private holdTick = (): void => {
    this.holdRaf = 0
    const hold = this.hold
    if (!hold || !this.playing || this.disposed) return
    const now = performance.now()
    hold.elapsed += ((now - hold.t0) / 1000) * (Math.abs(this.viewRate) || 1)
    hold.t0 = now
    if (hold.elapsed >= hold.h.length) return this.leaveHold()
    this.sound.hold(hold.h, hold.elapsed)
    this.sound.frame()
    this.emit()
    this.holdRaf = requestAnimationFrame(this.holdTick)
  }

  /** The hold is over: playback goes on from its frame, or ends after a hold at the edit's end. */
  private leaveHold(): void {
    const { h } = this.hold!
    this.hold = null
    this.sound.hold(h.end ? null : h, h.length)
    if (h.end) return this.finish()
    this.passed = h
    this.holdFrom = h.at + 1e-6
    this.time = h.at
    // The stems start again from the frame; the music's clock stays past the hold.
    this.sound.jump(h.at, this.screen.playbackRate)
    this.syncWebcam(h.at, false)
    this.goOn()
    this.emit()
  }

  /** The playhead moved past the frame of the hold just left: video time counts that hold from here on. */
  private leavePassed(t: number): void {
    const p = this.passed
    if (!p || !(p.edit < outputTimeAt(this.project.clips, t) - 1e-9)) return
    this.passed = null
    this.sound.hold(null, 0)
  }

  /** Leaves any hold without going on from it (a seek, a new plan); true when one was held. */
  private clearHold(): boolean {
    const held = !!this.hold
    cancelAnimationFrame(this.holdRaf)
    this.holdRaf = 0
    if (held || this.passed) this.sound.hold(null, 0)
    this.hold = null
    this.passed = null
    return held
  }

  /** The screen plays again after a hold (the camera follows through syncWebcam), and the frame loop goes on. */
  private goOn(): void {
    this.screen.play().catch((err: unknown) => {
      // AbortError just means pause() won the race.
      if (!(err instanceof DOMException && err.name === 'AbortError')) this.stopPlaying()
    })
    this.scheduleFrame()
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
    this.stopReverse()
    this.stopPlaying()
    this.disposed = true
    cancelAnimationFrame(this.drawRaf)
    cancelAnimationFrame(this.holdRaf)
    this.stills?.dispose()
    this.screen.removeEventListener('seeked', this.onSeeked)
    this.screen.removeEventListener('loadeddata', this.invalidate)
    this.screen.removeEventListener('ended', this.onEnded)
    this.screen.removeEventListener('pause', this.onPause)
    this.webcam?.removeEventListener('seeked', this.onWebcamSeeked)
    this.webcam?.removeEventListener('loadeddata', this.invalidate)
    this.webcam?.removeEventListener('error', this.onWebcamSeeked)
    this.releaseWebcam()
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
