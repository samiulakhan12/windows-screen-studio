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
/** The closest the rotate handle comes to the box's centre: nearer the pivot, a small slip of the pointer is a big turn. */
const ROTATE_ARM = ROTATE_REACH + ROTATE_RADIUS
/** The top of the preview, where the hint ("<name> · drag to place it · Done") covers the handles. */
const HINT_BAND = 48

interface RotateHandle {
  place: 'above' | 'below' | 'inside'
  /** The handle's centre from the box's, down the box's own axis (preview px; negative is up). */
  along: number
}

/** The stretch [lo, hi] of t where c + t·d lies within [min, max]; lo > hi when there is none. */
function slab(c: number, d: number, min: number, max: number): [number, number] {
  if (Math.abs(d) < 1e-9) return c >= min && c <= max ? [-Infinity, Infinity] : [Infinity, -Infinity]
  const a = (min - c) / d
  const z = (max - c) / d
  return a < z ? [a, z] : [z, a]
}

/**
 * Where the rotate handle goes on a box (preview px): above it, else below it when that spot is
 * off the preview or under the hint (a logo in a top corner), else inside the box as near its
 * bottom edge as the preview shows (an image as tall as the frame, or taller). A small box with
 * neither outside spot clear (turned on its side at the top) keeps the handle outside, on the preview.
 * `stayBelow`: the last turn ended with the handle below, so it stays there while that spot is clear
 * (placed above again, it would jump across the image, away from where the pointer let go).
 */
function rotateHandlePlace(b: { cx: number; cy: number; h: number; angle: number }, frame: { w: number; h: number }, stayBelow = false): RotateHandle {
  /** The stretch of the box's axis on the preview and under `top`, as `along` values. */
  const span = (top: number): [number, number] => {
    const [x0, x1] = slab(b.cx, -Math.sin(b.angle), ROTATE_RADIUS, frame.w - ROTATE_RADIUS)
    const [y0, y1] = slab(b.cy, Math.cos(b.angle), top, frame.h - ROTATE_RADIUS)
    return [Math.max(x0, y0), Math.min(x1, y1)]
  }
  const on = (t: number, [lo, hi]: [number, number]): boolean => t >= lo && t <= hi
  const out = b.h / 2 + ROTATE_REACH
  const clear = span(HINT_BAND)
  if (stayBelow && on(out, clear)) return { place: 'below', along: out }
  if (on(-out, clear)) return { place: 'above', along: -out }
  if (on(out, clear)) return { place: 'below', along: out }
  const near = Math.min(clear[1], b.h / 2 - ROTATE_REACH)
  const along = near >= ROTATE_ARM ? near : Math.min(near, -ROTATE_ARM)
  if (along >= Math.max(clear[0], ROTATE_REACH - b.h / 2)) return { place: 'inside', along }
  const shown = span(ROTATE_RADIUS)
  return !on(-out, shown) && on(out, shown) ? { place: 'below', along: out } : { place: 'above', along: -out }
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
  const [held, setHeld] = useState<RotateHandle | null>(null)
  /** The image whose last turn ended with the handle below it. */
  const [turnedBelow, setTurnedBelow] = useState<string | null>(null)
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

  /** Follows a drag from the box or a handle; `apply` gets the pointer's movement in preview pixels, `hold` hears when it starts and ends. */
  const drag = (apply: (dx: number, dy: number, ev: PointerEvent) => void, hold?: (on: boolean) => void) => (e: ReactPointerEvent<HTMLElement>) => {
    // Ctrl+press goes on to the preview, which adds or removes items (E-06); Shift keeps the shape.
    if (e.button !== 0 || e.ctrlKey || e.metaKey) return
    e.preventDefault()
    e.stopPropagation()
    releaseFocus(e.target)
    const sx = e.clientX
    const sy = e.clientY
    holdGesture(store)
    hold?.(true)
    followPointer(e, (ev) => apply(ev.clientX - sx, ev.clientY - sy, ev), hold && (() => hold(false)))
  }

  // While a turn is held the handle keeps its place: placed again as the image turns, it could
  // jump to the other side of the image, away from the pointer. After it, it keeps its side.
  const handle = held ?? rotateHandlePlace(b, frame, turnedBelow === o.id)
  const rotate = (e: ReactPointerEvent<HTMLElement>): void => {
    const stage = (e.currentTarget.closest('.overlay-editor') as HTMLElement).getBoundingClientRect()
    const centre = { x: stage.left + b.cx, y: stage.top + b.cy }
    // A handle below the centre points at the image's bottom: its mirror through the centre at the top.
    const flip = handle.along > 0
    drag(
      (_dx, _dy, ev) => {
        const at = flip ? { x: 2 * centre.x - ev.clientX, y: 2 * centre.y - ev.clientY } : { x: ev.clientX, y: ev.clientY }
        set({ rotation: rotationToward(centre, at, ev.shiftKey) }, 'overlay-rotation')
      },
      (on) => {
        setHeld(on ? handle : null)
        if (!on) setTurnedBelow(handle.place === 'below' ? o.id : null)
      }
    )(e)
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
          style={{ top: b.h / 2 + handle.along - ROTATE_RADIUS }}
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
