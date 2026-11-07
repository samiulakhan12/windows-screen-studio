/**
 * The preview's A* stills (docs/design/editing-polish.md §5.7): the frames that hold A's end on the
 * screen and camera proxies, picked from each track's own frame times with the export's rule
 * (stillFrame) and seeked with the export's own seek path (FreezeStills: seekToFrame, seekedFrame)
 * at the track's own rate, so the preview shows the frame the export copies. Each A* is composed in
 * a task of its own once its stills (and the camera still's person mask) are ready, never inside a
 * frame callback; the frame that starts the window then only draws it.
 */
import { stillFrame, trackTimes, type JoinWindow, type TrackTimes } from '../../../shared/render/joins'
import type { Project } from '../../../shared/types'
import type { FrameImage, RenderScene } from '../render/compositor'
import { openTrack } from '../render/frameSource'
import { composeJoinStill, releaseScratch, scratchTarget } from '../render/joinLayer'
import { FreezeStills } from './freezeStills'
import { SCREEN_PROXY_FPS, WEBCAM_PROXY_FPS } from './media'

/** A* kept at once (the preview's size: 8 MB each at 1080p). */
const KEEP = 4
/** Windows whose stills are asked for at once (the next three cuts, and one seeked into). */
const WANT = 4

type Samples = readonly { time: number; duration: number }[] | null

/** One track: its frame times (the samples, or null for the fallback grid) and the stills seeked from it. */
interface Track {
  samples: Samples
  fallback: number
  times: TrackTimes | null
  stills: FreezeStills | null
}

export class JoinStills {
  private screen: Track | null = null
  private camera: Track | null = null
  private wanted: JoinWindow[] = []
  private target: { scene: RenderScene; w: number; h: number; background: HTMLImageElement | null } | null = null
  /** A* by `${clip}|${w}x${h}`, with the project it was composed for. */
  private readonly composed = new Map<string, { canvas: HTMLCanvasElement; project: Project }>()
  /** Camera stills whose person mask is ready (or that need none), and those being segmented. */
  private readonly masked = new WeakSet<ImageBitmap>()
  private readonly segmenting = new WeakSet<ImageBitmap>()
  private timer: ReturnType<typeof setTimeout> | null = null
  private disposed = false

  constructor(
    private readonly screenUrl: string,
    private readonly webcamUrl: string | null,
    private readonly onReady: () => void,
    private readonly segment?: (still: ImageBitmap) => Promise<void>
  ) {
    void this.open()
  }

  /** Reads both tracks' sample tables (the index only, by range), once per session. */
  private async open(): Promise<void> {
    const index = async (url: string): Promise<Samples> => {
      try {
        return (await openTrack(url)).track.samples
      } catch {
        // Not indexable: the rate the export's seeking path falls back to.
        return null
      }
    }
    const [s, c] = await Promise.all([index(this.screenUrl), this.webcamUrl ? index(this.webcamUrl) : Promise.resolve(null)])
    if (this.disposed) return
    this.screen = { samples: s, fallback: SCREEN_PROXY_FPS, times: null, stills: null }
    if (this.webcamUrl) this.camera = { samples: c, fallback: WEBCAM_PROXY_FPS, times: null, stills: null }
    this.schedule()
  }

  /** A track's frame times and stills, made once its index is known and the project's length with it. */
  private ready(track: Track | null, url: string | null, seconds: number): { times: TrackTimes; stills: FreezeStills } | null {
    if (!track || !url) return null
    track.times ??= trackTimes(track.samples, track.fallback, seconds)
    // The seek path at the track's own rate (1 / its median frame duration).
    track.stills ??= new FreezeStills(url, 1 / (2 * track.times.half), () => this.schedule())
    return { times: track.times, stills: track.stills }
  }

  /** Asks for the stills of `windows` (the next three cuts after the playhead) and composes them as they arrive. */
  prepare(windows: readonly JoinWindow[], scene: RenderScene, w: number, h: number, background: HTMLImageElement | null = null): void {
    if (this.disposed) return
    this.target = { scene, w, h, background }
    this.wanted = windows.filter((x) => x.still).slice(0, WANT)
    this.schedule()
  }

  /** A* of `window` at w × h when it is ready for the current project, else null (asked for; the frame draws a hard cut). */
  still(window: JoinWindow, w: number, h: number): CanvasImageSource | null {
    if (!window.still || this.disposed) return null
    const c = this.composed.get(keyOf(window, w, h))
    if (c && this.target && c.project === this.target.scene.project) return c.canvas
    if (!this.wanted.includes(window)) {
      this.wanted = [window, ...this.wanted.filter((x) => x !== window)].slice(0, WANT)
      this.schedule()
    }
    return null
  }

  /** Composes in a task of its own, outside any frame callback. */
  private schedule(): void {
    if (this.timer !== null || this.disposed) return
    this.timer = setTimeout(() => {
      this.timer = null
      this.compose()
    }, 0)
  }

  private compose(): void {
    const target = this.target
    if (!target || this.disposed) return
    const { scene, w, h, background } = target
    const project = scene.project
    const screen = this.ready(this.screen, this.screenUrl, project.duration)
    if (!screen) return
    const camera = this.ready(this.camera, this.webcamUrl, project.duration)
    let made = false
    for (const win of this.wanted) {
      const still = win.still!
      const key = keyOf(win, w, h)
      if (this.composed.get(key)?.project === project) continue
      const shot = this.frameOf(screen, still.screen, still.held)
      const cam = still.camera !== null && camera ? this.frameOf(camera, still.camera, false) : null
      if (!shot || (still.camera !== null && camera && !cam)) continue
      if (cam && !this.maskReady(cam.image as ImageBitmap)) continue
      const out = this.composed.get(key)?.canvas ?? document.createElement('canvas')
      composeJoinStill(scratchTarget('gpu', w, h), out, w, h, win, scene, { screen: shot, camera: cam }, background)
      this.composed.delete(key)
      this.composed.set(key, { canvas: out, project })
      made = true
    }
    // The oldest go first.
    for (const [k, c] of this.composed) {
      if (this.composed.size <= KEEP) break
      c.canvas.width = c.canvas.height = 0
      this.composed.delete(k)
    }
    if (made) this.onReady()
  }

  /** The still of frame k* for `instant` on a track (asked for when it is not there yet). */
  private frameOf(track: { times: TrackTimes; stills: FreezeStills }, instant: number, held: boolean): FrameImage | null {
    const { index } = stillFrame(track.times, instant, held, -Infinity)
    // A quarter frame into k*: the seek path's frame for it (the middle of that frame).
    const at = (track.times.starts[index] ?? 0) + track.times.half / 2
    const bitmap = track.stills.get(at)
    return bitmap ? { image: bitmap, width: bitmap.width, height: bitmap.height } : null
  }

  /** Whether a camera still's person mask is ready (segmenting it now when not). */
  private maskReady(still: ImageBitmap): boolean {
    if (!this.segment || this.masked.has(still)) return true
    if (!this.segmenting.has(still)) {
      this.segmenting.add(still)
      void this.segment(still)
        .catch(() => undefined)
        .then(() => {
          this.masked.add(still)
          this.schedule()
        })
    }
    return false
  }

  dispose(): void {
    if (this.disposed) return
    this.disposed = true
    if (this.timer !== null) clearTimeout(this.timer)
    this.screen?.stills?.dispose()
    this.camera?.stills?.dispose()
    for (const c of this.composed.values()) c.canvas.width = c.canvas.height = 0
    this.composed.clear()
    releaseScratch()
  }
}

const keyOf = (w: JoinWindow, width: number, height: number): string => `${w.clip}|${width}x${height}`
