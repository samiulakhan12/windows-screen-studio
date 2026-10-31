import { displayTime } from '../../../shared/editor/clips'
import { addGraphic } from '../../../shared/editor/graphicsEdit'
import { MAX_GRAPHICS } from '../../../shared/captions/studioData'
import { outputToSource } from '../../../shared/engine/timeline'
import { viewingTime } from '../../../shared/render/overlays'
import type { Clip, Graphic } from '../../../shared/types'
import type { EditorServices } from './context'
import type { PreviewPlayer } from './player'
import type { Selection } from './selection'

/*
 * Motion graphics at the playhead (docs/design/captions-studio.md §2.11, §10.5): the one code path
 * for the Graphics tab's Add menu and the timeline's Graphics row. Adding one is one undo step.
 */

/** Said when a project already has the most graphics a project keeps. */
export const GRAPHICS_FULL = `This video already has ${MAX_GRAPHICS} pop-ups.`

/** Moves the playhead to where `g` is shown after its entrance, unless the preview is already inside it. */
export function showGraphic(player: PreviewPlayer, clips: Clip[], g: Pick<Graphic, 'start' | 'end' | 'enter'>): void {
  if (player.time >= g.start && player.time < g.end) return
  const at = outputToSource(clips, viewingTime(clips, g.start) + g.enter.duration).time
  player.seek(Math.min(Math.max(at, g.start), g.end - 1e-3))
}

/**
 * Adds a graphic of `kind` at the playhead (or `opts.at`; in a cut, the next frame shown), placed
 * automatically, selects it and shows it: one undo step. Says why when nothing was added.
 */
export function addGraphicAt(
  { store, player }: EditorServices,
  kind: Graphic['kind'],
  opts: { at?: number; onSelect: (sel: Selection) => void; onNotice?: (message: string) => void }
): string | null {
  if ((store.state.graphics?.length ?? 0) >= MAX_GRAPHICS) {
    opts.onNotice?.(GRAPHICS_FULL)
    return null
  }
  let id = ''
  store.update((p) => {
    const r = addGraphic(p, kind, displayTime(p.clips, opts.at ?? player.time))
    id = r.id
    return r.project
  })
  if (!id) return null
  opts.onSelect({ kind: 'graphic', id })
  const g = store.state.graphics?.find((x) => x.id === id)
  if (g) showGraphic(player, store.state.clips, g)
  return id
}
