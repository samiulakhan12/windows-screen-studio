import { useEffect, useState, useSyncExternalStore, type KeyboardEvent as ReactKeyboardEvent, type PointerEvent as ReactPointerEvent } from 'react'
import { displayTime } from '../../../shared/editor/clips'
import { editCoverBox, nudgeCovers, type BoxEdit } from '../../../shared/editor/coverEdit'
import { parseItemKey } from '../../../shared/editor/multiSelect'
import { frameCamera } from '../../../shared/engine/frameView'
import { boxAt } from '../../../shared/privacy/coverPath'
import { PRIVACY_COPY } from '../../../shared/privacy/copy'
import { punchedCamera } from '../../../shared/render/joins'
import { t } from '../../../shared/i18n/t'
import type { Cover, Project } from '../../../shared/types'
import { pausedScene } from '../editor/calloutView'
import { holdGesture, useEditor } from '../editor/context'
import { releaseFocus } from '../editor/focus'
import { useGroup } from '../editor/groupContext'
import { followPointer } from '../editor/pointer'
import type { Selection } from '../editor/selection'
import { subscribeWholePath, wholePathOn } from './coverCommands'
import type { SceneView } from './stubProps'
import './covers.css'

type Handle = 'move' | 'nw' | 'n' | 'ne' | 'e' | 'se' | 's' | 'sw' | 'w'
const HANDLES: readonly Exclude<Handle, 'move'>[] = ['nw', 'n', 'ne', 'e', 'se', 's', 'sw', 'w']

/** The edit a handle's drag by (dx, dy) of the whole frame makes: the middle moves the box, an edge or corner moves its edges (at every key, §2.2). */
export function handleEdit(handle: Handle, dx: number, dy: number): BoxEdit {
  if (handle === 'move') return { move: { dx, dy } }
  const edges: NonNullable<BoxEdit['edges']> = {}
  if (handle.includes('w')) edges.left = dx
  if (handle.includes('e')) edges.right = dx
  if (handle.includes('n')) edges.top = dy
  if (handle.includes('s')) edges.bottom = dy
  return { edges }
}

/** The covers the arrow keys move: a group's covers, else the selected one. */
function selectedCovers(selection: Selection, groupKeys: readonly string[]): string[] {
  if (groupKeys.length >= 2) return groupKeys.map((k) => parseItemKey(k)).filter((k) => k?.kind === 'cover').map((k) => k!.id)
  return selection?.kind === 'cover' ? [selection.id] : []
}

/**
 * The selected cover's box and eight handles on the preview (docs/design/auto-blur.md §2.2), where
 * the compositor draws it at the playhead (through the camera, zoomed or not), paused only. Dragging
 * the middle moves the box (from the playhead's span, or the whole path with *Change the whole
 * path*); an edge or corner moves those edges at every key. A drag is one undo step. The arrow keys
 * move the selected covers' whole paths by one pixel of the recording (Shift: ten).
 */
export function CoverHandles(props: { project: Project; selection: Selection; view: SceneView }): JSX.Element | null {
  const { store, player } = useEditor()
  const group = useGroup()
  const whole = useSyncExternalStore(subscribeWholePath, wholePathOn)
  // Drawn again when the playhead stops somewhere else, or starts or stops moving (never every frame of playback).
  const [key, setKey] = useState('')
  useEffect(() => {
    const check = (): void => setKey(player.moving ? 'moving' : `${player.time}`)
    check()
    return player.subscribe(check)
  }, [player])
  void key
  const sel = props.selection
  const cover: Cover | undefined = sel?.kind === 'cover' && group.group.keys.length < 2 ? props.project.covers?.find((c) => c.id === sel.id) : undefined
  const scene = cover && !player.moving ? pausedScene(player) : null
  const time = displayTime(props.project.clips, player.time)
  const box = cover && scene ? boxAt(cover, time) : null
  if (!cover || !scene || !box) return null

  const cam = punchedCamera(frameCamera(scene, props.view, time), scene.project, time)
  const rect = props.view.screen
  const vx = cam.cx - 0.5 / cam.scale
  const vy = cam.cy - 0.5 / cam.scale
  const sx = cam.scale * rect.w
  const sy = cam.scale * rect.h
  const toPx = (x: number, y: number): { x: number; y: number } => ({ x: rect.x + (x - vx) * sx, y: rect.y + (y - vy) * sy })
  // The view is the crop's: a move of the view is a move of the whole frame scaled by the crop.
  const crop = scene.crop ?? null
  const cw = crop?.w ?? 1
  const ch = crop?.h ?? 1
  const a = toPx(box.x, box.y)
  const b = toPx(box.x + box.w, box.y + box.h)
  const id = cover.id

  const drag = (handle: Handle) => (e: ReactPointerEvent<Element>) => {
    if (e.button !== 0) return
    // Ctrl+press goes on to the preview, which adds or removes items (E-06).
    if (e.ctrlKey || e.metaKey) return
    e.preventDefault()
    e.stopPropagation()
    releaseFocus(e.target)
    const p0 = store.state
    const startX = e.clientX
    const startY = e.clientY
    holdGesture(store)
    followPointer(e, (ev) => {
      const dx = ((ev.clientX - startX) / sx) * cw
      const dy = ((ev.clientY - startY) / sy) * ch
      // Each move from where the drag started: the moves never add up.
      const moved = editCoverBox(p0, id, time, handleEdit(handle, dx, dy), whole).covers?.find((c) => c.id === id)
      if (!moved) return
      store.update((p) => (p.covers ? { ...p, covers: p.covers.map((c) => (c.id === id ? moved : c)) } : p), `cover-geom:${id}`)
    })
  }

  const onKeyDown = (e: ReactKeyboardEvent): void => {
    const d = { ArrowLeft: [-1, 0], ArrowRight: [1, 0], ArrowUp: [0, -1], ArrowDown: [0, 1] }[e.key]
    if (!d) return
    e.preventDefault()
    e.stopPropagation()
    const step = e.shiftKey ? 10 : 1
    const ids = selectedCovers(props.selection, group.group.keys)
    store.update((p) => nudgeCovers(p, ids, d[0] * step, d[1] * step), `cover-nudge:${ids.join(',')}`)
  }

  return (
    <div
      className="cover-handles"
      data-testid="cover-handles"
      data-cover={id}
      role="group"
      aria-label={t(PRIVACY_COPY.cover.title)}
      tabIndex={0}
      onKeyDown={onKeyDown}
      style={{ left: a.x, top: a.y, width: b.x - a.x, height: b.y - a.y }}
      onPointerDown={drag('move')}
    >
      {HANDLES.map((h) => (
        <span
          key={h}
          className="cover-handle"
          data-handle={h}
          style={{ left: h.includes('w') ? 0 : h.includes('e') ? '100%' : '50%', top: h.includes('n') ? 0 : h.includes('s') ? '100%' : '50%' }}
          onPointerDown={drag(h)}
        />
      ))}
    </div>
  )
}
