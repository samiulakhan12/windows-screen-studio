import { useEffect, useState, type KeyboardEvent as ReactKeyboardEvent, type PointerEvent as ReactPointerEvent } from 'react'
import { moveOverlay, overlayLabel, resizeOverlay, rotationToward, type OverlayHandle } from '../../../shared/editor/overlays'
import { overlayBox, overlayVisibleAt } from '../../../shared/render/imageOverlays'
import type { ImageOverlay, Project } from '../../../shared/types'
import { holdGesture, useEditor } from './context'
import { releaseFocus } from './focus'
import { followPointer } from './pointer'
import type { Selection } from './selection'
import './overlays.css'

const HANDLES: OverlayHandle[] = ['nw', 'n', 'ne', 'e', 'se', 's', 'sw', 'w']

/** The axis-aligned bounds (preview px) of an overlay's rotated box: what Ctrl+click on the preview hits (E-06). */
export function overlayBounds(o: ImageOverlay, box: { w: number; h: number }): { x: number; y: number; w: number; h: number } {
  const b = overlayBox(o, box.w, box.h)
  const c = Math.abs(Math.cos(b.angle))
  const s = Math.abs(Math.sin(b.angle))
  const w = b.w * c + b.h * s
  const h = b.w * s + b.h * c
  return { x: b.cx - w / 2, y: b.cy - h / 2, w, h }
}

/** The rotate handle's centre, out from the box's edge, and its radius (overlays.css). */
const ROTATE_REACH = 21
const ROTATE_RADIUS = 7
/** The top of the preview, where the hint ("<name> · drag to place it · Done") covers the handles. */
const HINT_BAND = 48

/**
 * Where the rotate handle goes on a box (preview px): above it, else below it when that spot is
 * off the preview or under the hint (a logo in a top corner), else just inside its bottom edge (an
 * image as tall as the frame). `along` is the handle's centre from the box's, down the box's own axis.
 */
function rotateHandlePlace(b: { cx: number; cy: number; h: number; angle: number }, frame: { w: number; h: number }): { place: 'above' | 'below' | 'inside'; along: number } {
  const fits = (along: number): boolean => {
    const x = b.cx - Math.sin(b.angle) * along
    const y = b.cy + Math.cos(b.angle) * along
    return x >= ROTATE_RADIUS && x <= frame.w - ROTATE_RADIUS && y >= HINT_BAND && y <= frame.h - ROTATE_RADIUS
  }
  const out = b.h / 2 + ROTATE_REACH
  if (fits(-out)) return { place: 'above', along: -out }
  if (fits(out)) return { place: 'below', along: out }
  return { place: 'inside', along: b.h / 2 - ROTATE_REACH }
}

/**
 * Handles for the selected image overlay on the preview, exactly where the compositor draws it
 * (the same overlayBox, rotated about its centre): drag the box to move it, a handle to resize
 * (Shift keeps its shape), the round handle above it (below it near the top of the frame) to
 * rotate (Shift: 15° steps). With the box focused, the arrow keys move it by one pixel (Shift:
 * ten). Shown while the playhead is inside it.
 */
export function OverlayEditor({ project, selection, box, onDone }: { project: Project; selection: Selection | undefined; box: { w: number; h: number }; onDone: () => void }): JSX.Element | null {
  const { store, player } = useEditor()
  const overlay = selection?.kind === 'overlay' ? ((project.overlays ?? []).find((o) => o.id === selection.id) ?? null) : null
  const [visible, setVisible] = useState(false)
  useEffect(() => {
    if (!overlay) return
    const check = (): void => setVisible(overlayVisibleAt(overlay, player.time))
    check()
    return player.subscribe(check)
  }, [overlay, player])
  if (!overlay || !visible || box.w === 0) return null

  const o = overlay
  const frame = { w: box.w, h: box.h }
  const b = overlayBox(o, box.w, box.h)
  const set = (patch: Partial<ImageOverlay>, key: string): void => store.update((p) => ({ ...p, overlays: (p.overlays ?? []).map((x) => (x.id === o.id ? { ...x, ...patch } : x)) }), `${key}:${o.id}`)

  /** Follows a drag from the box or a handle; `apply` gets the pointer's movement in preview pixels. */
  const drag = (apply: (dx: number, dy: number, ev: PointerEvent) => void) => (e: ReactPointerEvent<HTMLElement>) => {
    // Ctrl+press goes on to the preview, which adds or removes items (E-06); Shift keeps the shape.
    if (e.button !== 0 || e.ctrlKey || e.metaKey) return
    e.preventDefault()
    e.stopPropagation()
    releaseFocus(e.target)
    const sx = e.clientX
    const sy = e.clientY
    holdGesture(store)
    followPointer(e, (ev) => apply(ev.clientX - sx, ev.clientY - sy, ev))
  }

  const handle = rotateHandlePlace(b, frame)
  const rotate = (e: ReactPointerEvent<HTMLElement>): void => {
    const stage = (e.currentTarget.closest('.overlay-editor') as HTMLElement).getBoundingClientRect()
    const centre = { x: stage.left + b.cx, y: stage.top + b.cy }
    // A handle below the centre points at the image's bottom: its mirror through the centre at the top.
    const flip = handle.along > 0
    drag((_dx, _dy, ev) => {
      const at = flip ? { x: 2 * centre.x - ev.clientX, y: 2 * centre.y - ev.clientY } : { x: ev.clientX, y: ev.clientY }
      set({ rotation: rotationToward(centre, at, ev.shiftKey) }, 'overlay-rotation')
    })(e)
  }

  const onKey = (e: ReactKeyboardEvent<HTMLElement>): void => {
    const step = e.shiftKey ? 10 : 1
    const d = { ArrowLeft: [-step, 0], ArrowRight: [step, 0], ArrowUp: [0, -step], ArrowDown: [0, step] }[e.key]
    if (!d) return
    e.preventDefault()
    e.stopPropagation()
    set(moveOverlay(o, d[0], d[1], frame), 'overlay-geom')
  }

  const label = overlayLabel(o)
  return (
    <div className="overlay-editor" data-testid="overlay-editor" data-item={o.id}>
      <div
        className="overlay-box"
        role="group"
        tabIndex={0}
        aria-label={`${label}: drag to move, arrow keys move it`}
        title="Drag to move · handles resize (Shift: keep the shape) · round handle rotates"
        style={{ left: b.cx - b.w / 2, top: b.cy - b.h / 2, width: b.w, height: b.h, transform: b.angle ? `rotate(${o.rotation}deg)` : undefined }}
        onPointerDown={drag((dx, dy) => set(moveOverlay(o, dx, dy, frame), 'overlay-geom'))}
        onKeyDown={onKey}
        data-testid="overlay-box"
      >
        {HANDLES.map((h) => (
          <span
            key={h}
            className="overlay-handle"
            data-handle={h}
            style={{ left: h.includes('w') ? 0 : h.includes('e') ? '100%' : '50%', top: h.includes('n') ? 0 : h.includes('s') ? '100%' : '50%' }}
            onPointerDown={drag((dx, dy, ev) => set(resizeOverlay(o, h, dx, dy, frame, ev.shiftKey), 'overlay-geom'))}
          />
        ))}
        <span
          className={handle.place === 'above' ? 'overlay-rotate' : `overlay-rotate ${handle.place}`}
          data-testid="overlay-rotate"
          title="Drag to rotate (Shift: 15° steps)"
          onPointerDown={rotate}
        />
      </div>
      <div className="pick-hint shape-hint" onPointerDown={(e) => e.stopPropagation()}>
        {label} · drag to place it ·{' '}
        <button className="link" onClick={onDone}>
          Done
        </button>
      </div>
    </div>
  )
}
