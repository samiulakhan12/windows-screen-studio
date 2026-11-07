/**
 * The export's side of smooth cuts (docs/design/editing-polish.md §5.8): which feed positions hold
 * a still, the copies of the still frames as the feeds reach them, A* composed once both copies of
 * a window are there (the camera's person mask prepared first), and the join each output frame
 * draws. The decoder sources and the canvas work are given by the exporter, so this is tested with
 * fakes.
 */
import { joinAt, type JoinFeed, type JoinWindow } from '../../../shared/render/joins'
import type { FrameExtras, FrameImage } from '../render/compositor'

export interface JoinExportDeps {
  /** A copy of `frame` into a plain canvas (one drawImage): it stays valid after the source moves on. */
  copy(frame: FrameImage): FrameImage
  /** The camera copy's person mask (blurred backgrounds), before it is composed. */
  prepareMask(frame: FrameImage): Promise<void>
  /** A* of `window` composed from the copies (composeJoinStill on the scratch target, into a canvas of its own). */
  compose(window: JoinWindow, stills: { screen: FrameImage; camera: FrameImage | null }): CanvasImageSource
  /** Lets go of a copy or of a composed A* that is no longer needed. */
  drop(image: CanvasImageSource): void
}

interface Pending {
  window: number
  screen: FrameImage | null
  camera: FrameImage | null
  /** The camera's copy is still to come (the window has a camera still). */
  wantsCamera: boolean
}

export class ExportJoins {
  private readonly byScreen = new Map<number, Pending[]>()
  private readonly byCamera = new Map<number, Pending[]>()
  private readonly pending: Pending[] = []
  private readonly composed = new Map<number, CanvasImageSource>()
  /** Positions that only a still asks for (inserted into the feeds): got, copied and passed. */
  private readonly onlyScreen = new Set<number>()
  private readonly onlyCamera = new Set<number>()
  private readonly positions: Map<JoinWindow, number>

  constructor(
    feed: JoinFeed,
    private readonly windows: readonly JoinWindow[],
    private readonly deps: JoinExportDeps
  ) {
    this.positions = new Map(windows.map((w, i) => [w, i]))
    const drawnS = new Set(feed.draw.screen)
    const drawnC = new Set(feed.draw.camera)
    for (const s of feed.stills) {
      const p: Pending = { window: s.window, screen: null, camera: null, wantsCamera: s.camera !== null }
      this.pending.push(p)
      push(this.byScreen, s.screen, p)
      if (!drawnS.has(s.screen)) this.onlyScreen.add(s.screen)
      if (s.camera !== null) {
        push(this.byCamera, s.camera, p)
        if (!drawnC.has(s.camera)) this.onlyCamera.add(s.camera)
      }
    }
  }

  /** Whether position `pos` of a feed is there for a still only (no output frame draws it). */
  stillOnly(kind: 'screen' | 'camera', pos: number): boolean {
    return (kind === 'screen' ? this.onlyScreen : this.onlyCamera).has(pos)
  }

  /** The frame a feed gave at `pos`: copied for each still there. */
  took(kind: 'screen' | 'camera', pos: number, frame: FrameImage | null): void {
    const list = (kind === 'screen' ? this.byScreen : this.byCamera).get(pos)
    if (!list || !frame) return
    for (const p of list) {
      if (kind === 'screen' && !p.screen) p.screen = this.deps.copy(frame)
      if (kind === 'camera' && !p.camera) p.camera = this.deps.copy(frame)
    }
  }

  /** Composes A* of every window whose copies are all there (the camera's mask first), then drops the copies. */
  async ready(): Promise<void> {
    for (let k = 0; k < this.pending.length; k++) {
      const p = this.pending[k]
      if (!p.screen || (p.wantsCamera && !p.camera)) continue
      this.pending.splice(k--, 1)
      if (p.camera) await this.deps.prepareMask(p.camera)
      this.composed.set(p.window, this.deps.compose(this.windows[p.window], { screen: p.screen, camera: p.camera }))
      this.deps.drop(p.screen.image)
      if (p.camera) this.deps.drop(p.camera.image)
    }
  }

  /**
   * The join output frame at video time `video` is in, with its A* (null: none was composed, the
   * frame draws a hard cut, or a dip, which needs none); null outside every window. A* of windows
   * that ended is let go.
   */
  joinAt(video: number): FrameExtras['join'] {
    for (const [w, image] of this.composed) {
      if (this.windows[w].to <= video) {
        this.deps.drop(image)
        this.composed.delete(w)
      }
    }
    const at = joinAt(this.windows, video)
    if (!at) return null
    return { at, still: this.composed.get(this.positions.get(at.window) ?? -1) ?? null }
  }

  dispose(): void {
    for (const image of this.composed.values()) this.deps.drop(image)
    this.composed.clear()
    for (const p of this.pending) {
      if (p.screen) this.deps.drop(p.screen.image)
      if (p.camera) this.deps.drop(p.camera.image)
    }
    this.pending.length = 0
  }
}

function push<K, V>(map: Map<K, V[]>, key: K, value: V): void {
  const list = map.get(key)
  if (list) list.push(value)
  else map.set(key, [value])
}
