import { useEffect, useMemo, useState } from 'react'
import { displayTime } from '../../../shared/editor/clips'
import { layoutsApply, sceneContentRect, type Rect } from '../../../shared/engine/layout'
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
