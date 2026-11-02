/**
 * Graphics and the caption block on the preview (docs/design/captions-studio.md §2.5, §2.11, §10.5),
 * paused only: a click on a graphic selects it, dragging moves it (one undo step, merge key
 * `graphic-pos:<id>`; it is then "Placed by you"), the focused handle moves it with the arrow keys
 * (1% of the frame, Shift 10%; one undo step per key press). Dragging the captions sets their place
 * (one undo step; not a pick of a look); a plain click on them still plays or pauses, and Ctrl or
 * Shift+click goes on to the preview (E-06). And the label of a gallery look previewed on the video.
 */
import { useMemo, useSyncExternalStore, type KeyboardEvent as ReactKeyboardEvent, type PointerEvent as ReactPointerEvent } from 'react'
import { captionsOf } from '../../../shared/captions/settings'
import { placeGraphicAt } from '../../../shared/editor/graphicsEdit'
import { clamp } from '../../../shared/engine/math'
import type { Rect } from '../../../shared/engine/layout'
import type { Graphic, Project } from '../../../shared/types'
import { graphicRects } from '../render/graphicsLayer'
import { studioBlockAt } from '../render/studioLayer'
import { useEditor } from './context'
import { releaseFocus } from './focus'
import { graphicLabel } from './panels/GraphicsPanel'
import { followPointer } from './pointer'
import { previewLabel, usePreviewLook } from './previewLook'
import type { Selection } from './selection'

/** A canvas context to measure text with (hit tests lay text out as the drawing does). */
let measureCtx: CanvasRenderingContext2D | null = null
const measure = (): CanvasRenderingContext2D => (measureCtx ??= document.createElement('canvas').getContext('2d')!)

/** A graphic's centre moved by (dx, dy) of the frame, kept inside it (normalised). */
export function nudged(centre: { x: number; y: number }, dx: number, dy: number): { x: number; y: number } {
  return { x: clamp(centre.x + dx, 0, 1), y: clamp(centre.y + dy, 0, 1) }
}

/** The arrow keys' move (§2.11): 1% of the frame, Shift 10%; null for other keys. */
export function arrowStep(e: Pick<KeyboardEvent, 'key' | 'shiftKey' | 'ctrlKey' | 'altKey' | 'metaKey'>): { dx: number; dy: number } | null {
  if (e.ctrlKey || e.altKey || e.metaKey) return null
  const s = e.shiftKey ? 0.1 : 0.01
  if (e.key === 'ArrowLeft') return { dx: -s, dy: 0 }
  if (e.key === 'ArrowRight') return { dx: s, dy: 0 }
  if (e.key === 'ArrowUp') return { dx: 0, dy: -s }
  if (e.key === 'ArrowDown') return { dx: 0, dy: s }
  return null
}

/** The centre of `rect` in a `w` x `h` frame, normalised. */
const centreOf = (r: Rect, w: number, h: number): { x: number; y: number } => ({ x: (r.x + r.w / 2) / w, y: (r.y + r.h / 2) / h })

/**
 * Handles over the graphics shown at the playhead and over the caption block, laid out on the
 * preview box (`box` CSS px) of the output frame (`out` px).
 */
export function GraphicHandles({
  project,
  box,
  out,
  selection,
  onSelect,
  onTogglePlay,
  paused
}: {
  project: Project
  box: { w: number; h: number }
  out: { w: number; h: number }
  selection?: Selection
  onSelect?: (sel: Selection) => void
  /** A plain click on the captions (no drag): plays or pauses, as a click on the preview does. */
  onTogglePlay?: () => void
  paused: boolean
}): JSX.Element | null {
  const { store, player } = useEditor()
  const t = useSyncExternalStore(player.subscribe, () => player.time)
  const k = out.w > 0 ? box.w / out.w : 0
  const rects = useMemo(() => (paused && project.graphics?.length && k > 0 ? graphicRects(measure(), project, t, out.w, out.h) : []), [paused, project, t, out.w, out.h, k])
  const block = useMemo(() => (paused && project.captions?.studio && captionsOf(project).show && k > 0 ? studioBlockAt(measure(), project, t, out.w, out.h) : null), [paused, project, t, out.w, out.h, k])
  if (!paused || k <= 0) return null
  const byId = new Map((project.graphics ?? []).map((g) => [g.id, g]))
  const selectedId = selection?.kind === 'graphic' ? selection.id : null

  const place = (id: string, centre: { x: number; y: number }, key?: string): void => store.update((p) => placeGraphicAt(p, id, centre), key)

  const onGraphicDown = (g: Graphic, r: Rect) => (e: ReactPointerEvent<HTMLElement>) => {
    if (e.button !== 0) return
    e.preventDefault()
    e.stopPropagation()
    releaseFocus(e.target)
    onSelect?.({ kind: 'graphic', id: g.id })
    const start = g.place === 'auto' ? centreOf(r, out.w, out.h) : g.place
    const sx = e.clientX
    const sy = e.clientY
    let moved = false
    store.beginGesture()
    followPointer(
      e,
      (ev) => {
        if (!moved && Math.hypot(ev.clientX - sx, ev.clientY - sy) <= 3) return
        moved = true
        place(g.id, nudged(start, (ev.clientX - sx) / k / out.w, (ev.clientY - sy) / k / out.h), `graphic-pos:${g.id}`)
      },
      () => store.endGesture()
    )
  }

  const onGraphicKey = (g: Graphic, r: Rect) => (e: ReactKeyboardEvent) => {
    const step = arrowStep(e)
    if (!step) return
    e.preventDefault()
    e.stopPropagation()
    const from = g.place === 'auto' ? centreOf(r, out.w, out.h) : g.place
    // One undo step per key press: no merge key.
    store.seal()
    place(g.id, nudged(from, step.dx, step.dy))
  }

  const onCaptionDown = (b: Rect) => (e: ReactPointerEvent<HTMLElement>) => {
    // Ctrl or Shift+click adds or removes the item under the pointer (E-06): the preview does that.
    if (e.button !== 0 || e.ctrlKey || e.metaKey || e.shiftKey) return
    e.preventDefault()
    e.stopPropagation()
    releaseFocus(e.target)
    const start = centreOf(b, out.w, out.h)
    const sx = e.clientX
    const sy = e.clientY
    let moved = false
    store.beginGesture()
    followPointer(
      e,
      (ev) => {
        if (!moved && Math.hypot(ev.clientX - sx, ev.clientY - sy) <= 3) return
        moved = true
        const at = nudged(start, (ev.clientX - sx) / k / out.w, (ev.clientY - sy) / k / out.h)
        store.update((p) => {
          const c = captionsOf(p)
          if (!c.studio) return p
          // A drag places the block; it leaves the legacy anchors, as Position does (§5.8).
          const { legacyAnchor: _a, ...layout } = c.studio.layout
          void _a
          return { ...p, captions: { ...c, studio: { ...c.studio, layout: { ...layout, place: at } } } }
        }, 'caption-drag')
      },
      (ev) => {
        store.endGesture()
        if (!moved && ev.type === 'pointerup') onTogglePlay?.()
      }
    )
  }

  return (
    <>
      {block && (
        <div
          className="caption-block-handle"
          data-testid="caption-block-handle"
          style={{ left: block.box.x * k, top: block.box.y * k, width: block.box.w * k, height: block.box.h * k }}
          title="Drag the captions to place them, or click to play or pause; Layout › Position puts them back"
          onPointerDown={onCaptionDown(block.box)}
        />
      )}
      {rects.map(({ id, rect: r }) => {
        const g = byId.get(id)
        if (!g) return null
        return (
          <button
            key={id}
            type="button"
            className={`graphic-handle ${selectedId === id ? 'selected' : ''}`}
            data-testid="graphic-handle"
            data-graphic-handle={id}
            style={{ left: r.x * k, top: r.y * k, width: r.w * k, height: r.h * k }}
            aria-label={`${graphicLabel(g)}: drag or use the arrow keys to move it`}
            aria-pressed={selectedId === id}
            onPointerDown={onGraphicDown(g, r)}
            onFocus={() => selectedId !== id && onSelect?.({ kind: 'graphic', id })}
            onKeyDown={onGraphicKey(g, r)}
          />
        )
      })}
    </>
  )
}

/** "Previewing Bold Pop · Enter uses it" over the preview while a gallery tile previews its look (§2.5). */
export function PreviewLookLabel(): JSX.Element | null {
  const look = usePreviewLook()
  if (!look) return null
  return (
    <div className="preview-look-label" role="status" data-testid="preview-look-label">
      {previewLabel(look)}
    </div>
  )
}
