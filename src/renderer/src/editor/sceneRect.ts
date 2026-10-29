import { useEffect, useMemo, useState } from 'react'
import { displayTime } from '../../../shared/editor/clips'
import { layoutsApply, sceneLayout, type Rect, type SceneLayout } from '../../../shared/engine/layout'
import type { Project } from '../../../shared/types'
import { useEditor } from './context'

const sameRect = (a: Rect, b: Rect): boolean => a.x === b.x && a.y === b.y && a.w === b.w && a.h === b.h

/** Whether two layouts put the screen (and, while following, the slot and the view) in the same place. */
const sameView = (a: SceneLayout, b: SceneLayout): boolean =>
  sameRect(a.screen, b.screen) &&
  (a.follow && b.follow
    ? sameRect(a.follow.slot, b.follow.slot) && a.follow.base.w === b.follow.base.w && a.follow.base.h === b.follow.base.h
    : !a.follow && !b.follow)

/**
 * Where the recording is in the preview overlay (px) at the playhead: what drawFrame computes
 * for the camera layout in effect, so handles and picks line up with the drawn frame. Follows
 * the playhead (the frame shown, past a cut), but re-renders only when the rectangle actually
 * changes: never for a project without camera layouts. While the view follows the action it is
 * the virtual rectangle (docs/design/vertical-video.md §5.2), which the camera maps onto the slot.
 */
export function useSceneRect(project: Project, w: number, h: number, vw: number, vh: number): Rect {
  return useSceneView(project, w, h, vw, vh).screen
}

/**
 * The whole layout of the preview's frame at the playhead (docs/design/vertical-video.md §8.2):
 * the screen (the virtual rectangle while following), the camera and the follow geometry, as
 * drawFrame computes them (sceneLayout: the follow branch never measures the device frame, so the
 * drawn project gives the same layout). Re-renders only while a layout change moves the screen or
 * the slot, never for a project without camera layouts; the camera box is the one of the last
 * such render, so read it only for where the screen and the slot are.
 */
export function useSceneView(project: Project, w: number, h: number, vw: number, vh: number): SceneLayout {
  const { player } = useEditor()
  const changes = layoutsApply(project) && (project.layouts?.length ?? 0) > 0
  const still = useMemo(() => (changes ? null : sceneLayout(project, w, h, vw, vh, 0)), [changes, project, w, h, vw, vh])
  const [moving, setMoving] = useState<SceneLayout | null>(null)

  useEffect(() => {
    if (!changes) return
    const update = (): void => {
      const next = sceneLayout(project, w, h, vw, vh, displayTime(project.clips, player.time))
      setMoving((cur) => (cur && sameView(cur, next) ? cur : next))
    }
    update()
    return player.subscribe(update)
  }, [changes, player, project, w, h, vw, vh])

  return still ?? moving ?? sceneLayout(project, w, h, vw, vh, displayTime(project.clips, player.time))
}
