import { useEffect, useMemo, useState } from 'react'
import { displayTime } from '../../../shared/editor/clips'
import { layoutsApply, sceneContentRect, type Rect, type SceneLayout } from '../../../shared/engine/layout'
import type { Project } from '../../../shared/types'
import { useEditor } from './context'

const sameRect = (a: Rect, b: Rect): boolean => a.x === b.x && a.y === b.y && a.w === b.w && a.h === b.h

/**
 * Where the recording is in the preview overlay (px) at the playhead: what drawFrame computes
 * for the camera layout in effect, so handles and picks line up with the drawn frame. Follows
 * the playhead (the frame shown, past a cut), but re-renders only when the rectangle actually
 * changes: never for a project without camera layouts.
 */
export function useSceneRect(project: Project, w: number, h: number, vw: number, vh: number): Rect {
  const { player } = useEditor()
  const follows = layoutsApply(project) && (project.layouts?.length ?? 0) > 0
  const still = useMemo(() => (follows ? null : sceneContentRect(project, w, h, vw, vh, 0)), [follows, project, w, h, vw, vh])
  const [moving, setMoving] = useState<Rect | null>(null)

  useEffect(() => {
    if (!follows) return
    const update = (): void => {
      const next = sceneContentRect(project, w, h, vw, vh, displayTime(project.clips, player.time))
      setMoving((cur) => (cur && sameRect(cur, next) ? cur : next))
    }
    update()
    return player.subscribe(update)
  }, [follows, player, project, w, h, vw, vh])

  return still ?? moving ?? sceneContentRect(project, w, h, vw, vh, displayTime(project.clips, player.time))
}

/**
 * The whole layout of the preview's frame at the playhead (docs/design/vertical-video.md §8.2):
 * the screen (the virtual rectangle while following), the camera and the follow geometry, as
 * drawFrame computes them. Re-renders only while a layout change moves the slot, as
 * useSceneRect does; useSceneRect then reads its screen.
 *
 * CONTRACT (part P3): the signature is frozen; the body is to be written.
 */
export function useSceneView(project: Project, w: number, h: number, vw: number, vh: number): SceneLayout {
  void project
  void w
  void h
  void vw
  void vh
  throw new Error('not implemented')
}
