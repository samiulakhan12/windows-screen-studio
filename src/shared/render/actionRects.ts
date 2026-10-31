/**
 * The action on screen over a caption's time (docs/design/captions-studio.md §8.6): the cursor
 * every 0.1 s, clicks and typing places, in output pixels after zoom and pan, padded by 0.08 u,
 * cut time skipped. Captions and graphics keep clear of it.
 *
 * CONTRACT (part P1): the signature is frozen; the body is to be written.
 */
import type { Rect } from '../engine/layout'
import type { ViewScene } from '../engine/frameView'
import type { AutoZoomSettings, Clip, CursorTrack } from '../types'

/** The body of a frozen signature part P1 writes. */
function notImplemented(name: string, ...args: unknown[]): never {
  void args
  throw new Error(`${name}: not implemented (Captions Studio part P1)`)
}

export function actionRects(scene: ViewScene, cursor: CursorTrack | null, zoom: AutoZoomSettings, w: number, h: number, vw: number, vh: number, t0: number, t1: number, clips: Clip[]): { t: number; rect: Rect }[] {
  return notImplemented('actionRects', scene, cursor, zoom, w, h, vw, vh, t0, t1, clips)
}
