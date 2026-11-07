/**
 * The preview's A* stills (docs/design/editing-polish.md §5.7): the frames that hold A's end on the
 * screen and camera proxies, asked for with the export's own seek rule, composed ahead of their
 * windows.
 *
 * Contracts step: the exported signature of part P1 (§17.1), a stub that holds no still (every
 * join draws as a hard cut). Part P1 writes the body.
 */
import type { JoinWindow } from '../../../shared/render/joins'
import type { RenderScene } from '../render/compositor'

export class JoinStills {
  constructor(screenUrl: string, webcamUrl: string | null, onReady: () => void, segment?: (still: ImageBitmap) => Promise<void>) {
    void screenUrl
    void webcamUrl
    void onReady
    void segment
  }

  /** Asks for the stills of `windows` (the next three cuts after the playhead) and composes them as they arrive. */
  prepare(windows: readonly JoinWindow[], scene: RenderScene, w: number, h: number): void {
    void windows
    void scene
    void w
    void h
  }

  /** A* of `window` at w × h when it is ready, else null (the frame draws a hard cut). */
  still(window: JoinWindow, w: number, h: number): CanvasImageSource | null {
    void window
    void w
    void h
    return null
  }

  dispose(): void {}
}
