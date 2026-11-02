import { displayTime } from '../../../shared/editor/clips'
import { addGraphic } from '../../../shared/editor/graphicsEdit'
import { MAX_GRAPHICS } from '../../../shared/captions/studioData'
import { outputToSource } from '../../../shared/engine/timeline'
import { viewingTime } from '../../../shared/render/overlays'
import type { Graphic, Project } from '../../../shared/types'
import { graphicShown } from '../render/graphicsLayer'
import type { EditorServices } from './context'
import type { PreviewPlayer } from './player'
import type { Selection } from './selection'

/*
 * Motion graphics at the playhead (docs/design/captions-studio.md §2.11, §10.5): the one code path
 * for the Graphics tab's Add menu and the timeline's Graphics row. Adding one is one undo step.
 */

/** Said when a project already has the most graphics a project keeps. */
export const GRAPHICS_FULL = `This video already has ${MAX_GRAPHICS} pop-ups.`

/**
 * Moves the playhead to where `g` is shown after its entrance, unless the preview is already inside
 * it: inside the time it shows (graphicShown: a keyword that replaces its chunk while that chunk shows).
 */
export function showGraphic(player: PreviewPlayer, project: Project, g: Graphic): void {
  const { start, end } = graphicShown(project, g)
  if (player.time >= start && player.time < end) return
  const at = outputToSource(project.clips, viewingTime(project.clips, start) + g.enter.duration).time
  player.seek(Math.min(Math.max(at, start), end - 1e-3))
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
  if (g) showGraphic(player, store.state, g)
  return id
}
