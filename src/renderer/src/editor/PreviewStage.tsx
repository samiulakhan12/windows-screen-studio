import { memo, useCallback, useEffect, useLayoutEffect, useMemo, useRef, useState, type PointerEvent as ReactPointerEvent } from 'react'
import { annotationVisibleAt } from '../../../shared/editor/annotations'
import { displayTime } from '../../../shared/editor/clips'
import {
  dragShapeBox,
  drawnBox,
  drawnGeometry,
  isLineKind,
  isPrivacyKind,
  itemVisibleAt,
  moveLine,
  resizeAround,
  setLineEnd,
  shapeBounds,
  shapeLabel
} from '../../../shared/editor/shapes'
import { setZoomRegionInView } from '../../../shared/editor/cropEdit'
import { dragRegion, formatLevel, regionFromPoints, type Box as RegionBox, type RegionHandle, type ZoomRegion } from '../../../shared/editor/zoomEdit'
import { croppedFrameSize, fromCrop, geometryFromCrop } from '../../../shared/engine/crop'
import { outputSize, type Rect } from '../../../shared/engine/layout'
import { useSceneRect } from './sceneRect'
import { clamp } from '../../../shared/engine/math'
import { cameraAt, cameraFor, zoomStyleOf, zoomTargetScale, type Camera } from '../../../shared/engine/zoom'
import { cursorOverVideoAt, spotlightArea, visibleCursorAt } from '../../../shared/render/shapes'
import type { Annotation, NormRect, Project, Shape, Spotlight, ZoomSegment } from '../../../shared/types'
import { cardRect, type RenderScene } from '../render/compositor'
import { holdGesture, useEditor } from './context'
import { topmostHit, toggleKey, type ItemKey, type KeyRect } from '../../../shared/editor/multiSelect'
import { useGroup } from './groupContext'
import { CropEditor, type CropTool } from './CropEditor'
import { OverlayEditor } from './OverlayEditor'
import { releaseFocus } from './focus'
import type { PreviewPlayer } from './player'
import { followPointer } from './pointer'
import type { Selection } from './selection'
import './multiSelect.css'
import './shapes.css'
import './zoom.css'

interface Props {
  project: Project
  /** Zoom whose focus is being picked on the preview, if any. */
  pickZoom: ZoomSegment | null
  selectedAnnotation: Annotation | null
  onTogglePlay: () => void
  onExitPick: () => void
  /** What the preview draws (camera focus, cursor path): shapes are edited through the camera. */
  scene?: RenderScene
  selection?: Selection
  onSelect?: (sel: Selection) => void
  /** The crop tool, while the crop is edited: it replaces the other overlays (the preview shows the whole recording). */
  cropTool?: CropTool | null
}

interface Box {
  w: number
  h: number
}

const CLICK_SLOP = 4

type Pos = { x: number; y: number }

/** The selected shape or spotlight, edited on the preview. */
type EditItem = { type: 'shape'; item: Shape } | { type: 'spotlight'; item: Spotlight }

/**
 * How the preview shows the recording at the playhead: the zoom camera (and, for a cursor
 * spotlight, where the cursor is). Shapes are edited through it, so handles sit exactly on
 * the drawn shape, zoomed or not.
 */
interface StageView {
  cam: Camera
  cursor: Pos | null
  /** A cursor spotlight's cursor is off the recording: the spotlight shows nothing there. */
  cursorOff: boolean
}

/** Maps between the overlay's pixels and normalised source coordinates through a camera. */
interface Mapping {
  toPx: (x: number, y: number) => Pos
  toSource: (px: number, py: number) => Pos
  /** Source units per overlay pixel. */
  ux: number
  uy: number
}

function mappingFor(cam: Camera, rect: Rect): Mapping {
  const vx = cam.cx - 0.5 / cam.scale
  const vy = cam.cy - 0.5 / cam.scale
  const sx = cam.scale * rect.w
  const sy = cam.scale * rect.h
  return {
    toPx: (x, y) => ({ x: rect.x + (x - vx) * sx, y: rect.y + (y - vy) * sy }),
    toSource: (px, py) => ({ x: vx + (px - rect.x) / sx, y: vy + (py - rect.y) / sy }),
    ux: 1 / sx,
    uy: 1 / sy
  }
}

/**
 * The view while `item` can be edited (paused, playhead inside it), else null. Follows the
 * player, but only re-renders when the camera or cursor actually moved.
 */
function useStageView(player: PreviewPlayer, project: Project, scene: RenderScene | undefined, item: EditItem | null): StageView | null {
  const [view, setView] = useState<StageView | null>(null)
  useEffect(() => {
    if (!item || !scene) {
      setView(null)
      return
    }
    let last = ''
    const update = (): void => {
      const t = displayTime(project.clips, player.time)
      if (player.moving || !itemVisibleAt(item.item, t)) {
        if (last !== 'none') setView(null)
        last = 'none'
        return
      }
      // The same camera and cursor position the compositor uses for this frame.
      const cam = cameraAt(project.zooms, t, scene.cursor.valid ? scene.focusPath : null, zoomStyleOf(project))
      const follows = item.type === 'spotlight' && item.item.mode === 'cursor' && scene.cursor.valid
      const cursor = follows ? visibleCursorAt(project, scene.cursor.samples, scene.cursorPath, t) : null
      // The same rule the spotlight layer fades it out by.
      const cursorOff = !!cursor && !cursorOverVideoAt(project, scene.cursor.samples, scene.cursorPath, t)
      const key = `${cam.scale},${cam.cx},${cam.cy},${cursor?.x},${cursor?.y},${cursorOff}`
      if (key === last) return
      last = key
      setView({ cam, cursor, cursorOff })
    }
    update()
    return player.subscribe(update)
  }, [player, project, scene, item])
  return view
}

/**
 * The preview canvas, sized to fill the stage at the output aspect ratio. Its
 * backing store follows devicePixelRatio but never exceeds the recording's own
 * resolution, so HiDPI screens get a sharp preview without wasted pixels.
 * Overlays: picking a zoom's focus point, moving the selected text, and editing the selected
 * shape or spotlight.
 */
export const PreviewStage = memo(function PreviewStage({ project, pickZoom: picking, selectedAnnotation, onTogglePlay, onExitPick, scene, selection, onSelect, cropTool }: Props): JSX.Element {
  const { store, player } = useEditor()
  const wrapRef = useRef<HTMLDivElement>(null)
  const canvasRef = useRef<HTMLCanvasElement>(null)
  const [box, setBox] = useState<Box>({ w: 0, h: 0 })
  // Geometry comes from the project as drawn (cropped: the crop's view and size); edits are
  // mapped back into the full frame through `crop`. The backing store's cap stays the recording's own height.
  const drawn = scene?.project ?? project
  const crop = scene?.crop ?? null
  const out = outputSize(drawn.style.aspectRatio, drawn.width, drawn.height, project.height)
  // The zoom whose focus is picked, as the preview shows it.
  const pickZoom = useMemo(() => (picking ? (drawn.zooms.find((z) => z.id === picking.id) ?? picking) : null), [picking, drawn.zooms])

  useEffect(() => () => player.setFlat(false), [player])

  useLayoutEffect(() => {
    player.attachCanvas(canvasRef.current)
    return () => player.attachCanvas(null)
  }, [player])

  useLayoutEffect(() => {
    const wrap = wrapRef.current
    const canvas = canvasRef.current
    if (!wrap || !canvas) return
    const layout = (): void => {
      const availW = wrap.clientWidth
      const availH = wrap.clientHeight
      if (availW <= 0 || availH <= 0) return
      const ratio = out.width / out.height
      let w = availW
      let h = w / ratio
      if (h > availH) {
        h = availH
        w = h * ratio
      }
      w = Math.floor(w)
      h = Math.floor(h)
      const dpr = window.devicePixelRatio || 1
      const k = Math.min(1, out.width / (w * dpr), out.height / (h * dpr))
      const bw = Math.max(2, Math.round(w * dpr * k))
      const bh = Math.max(2, Math.round(h * dpr * k))
      if (canvas.width !== bw || canvas.height !== bh) {
        canvas.width = bw
        canvas.height = bh
        player.drawNow()
      }
      setBox((b) => (b.w === w && b.h === h ? b : { w, h }))
    }
    layout()
    const ro = new ResizeObserver(layout)
    ro.observe(wrap)
    // A window dragged to a monitor with another scale factor changes devicePixelRatio without a resize.
    let mq = matchMedia(`(resolution: ${window.devicePixelRatio}dppx)`)
    const onDpr = (): void => {
      mq.removeEventListener('change', onDpr)
      mq = matchMedia(`(resolution: ${window.devicePixelRatio}dppx)`)
      mq.addEventListener('change', onDpr)
      layout()
    }
    mq.addEventListener('change', onDpr)
    return () => {
      ro.disconnect()
      mq.removeEventListener('change', onDpr)
    }
  }, [player, out.width, out.height])

  // Source-space rectangle of the recording inside the frame (what drawFrame computes).
  const { width: vw, height: vh } = croppedFrameSize(crop, player.screen.videoWidth, player.screen.videoHeight, drawn)
  const rect = useSceneRect(drawn, box.w, box.h, vw, vh)

  /** Normalised source position under a pointer (the preview shows the unzoomed frame while picking). */
  const sourceAt = (clientX: number, clientY: number, el: HTMLElement): { x: number; y: number } => {
    const r = el.getBoundingClientRect()
    return { x: (clientX - r.left - rect.x) / rect.w, y: (clientY - r.top - rect.y) / rect.h }
  }

  // The selected shape or spotlight, edited on the preview through the camera at the playhead.
  const editItem = useMemo<EditItem | null>(() => {
    if (pickZoom || cropTool || !selection) return null
    if (selection.kind === 'shape') {
      const item = (drawn.shapes ?? []).find((s) => s.id === selection.id)
      return item ? { type: 'shape', item } : null
    }
    if (selection.kind === 'spotlight') {
      const item = (drawn.spotlights ?? []).find((s) => s.id === selection.id)
      return item ? { type: 'spotlight', item } : null
    }
    return null
  }, [pickZoom, cropTool, selection, drawn.shapes, drawn.spotlights])
  const view = useStageView(player, drawn, scene, editItem)
  const mapping = view ? mappingFor(view.cam, rect) : null

  // E-06: a group's members on screen are outlined (paused only); Ctrl+click adds or removes items.
  const group = useGroup()
  const outlines = useGroupOutlines(player, drawn, scene, rect, box, group.keys, group.group.keys.length >= 2 && !pickZoom && !cropTool)

  // Handles are laid out on the flat frame: the 3D tilt is left out while the preview shows
  // some (a zoom's focus being picked, the selected shape or spotlight being edited, a group's
  // outlines). Other selections, playback and text (always drawn flat) keep the tilt.
  const editing = !!pickZoom || !!(editItem && view) || outlines.length > 0
  useEffect(() => player.setFlat(editing), [player, editing])

  /** Dragging on the preview outside the selected item draws it anew there (not a cursor spotlight). */
  const redrawItem = (e: ReactPointerEvent<HTMLElement>, el: HTMLElement): boolean => {
    if (!editItem || !mapping || (editItem.type === 'spotlight' && editItem.item.mode === 'cursor')) return false
    const r = el.getBoundingClientRect()
    const at = (ev: { clientX: number; clientY: number }): Pos => mapping.toSource(ev.clientX - r.left, ev.clientY - r.top)
    const a = at(e)
    const sx = e.clientX
    const sy = e.clientY
    const { type, item } = editItem
    let drew = false
    holdGesture(store)
    followPointer(
      e,
      (ev) => {
        if (!drew && Math.hypot(ev.clientX - sx, ev.clientY - sy) <= CLICK_SLOP) return
        drew = true
        const b = at(ev)
        if (type === 'shape') updateShape(store, crop, item.id, drawnGeometry(item.kind, a, b))
        else updateSpotlight(store, crop, item.id, drawnBox(a, b))
      },
      (ev) => {
        // A plain click still plays or pauses.
        if (!drew && ev.type === 'pointerup' && Math.hypot(ev.clientX - sx, ev.clientY - sy) <= CLICK_SLOP) onTogglePlay()
      }
    )
    return true
  }

  const setRegion = (id: string, box: RegionBox): void => {
    store.update((p) => ({ ...p, zooms: p.zooms.map((z) => (z.id === id ? setZoomRegionInView(crop, z, box) : z)) }), `zoom-region:${id}`)
  }

  /**
   * Pressing outside the box draws a new one (a plain click moves the box there instead);
   * the box keeps the recording's shape, so the zoom frames exactly it, unless Shift is held.
   */
  const drawRegion = (e: ReactPointerEvent<HTMLElement>, el: HTMLElement): void => {
    if (!pickZoom || pickZoom.focus.mode !== 'region') return
    const id = pickZoom.id
    const initial = pickZoom.focus
    const a = sourceAt(e.clientX, e.clientY, el)
    const sx = e.clientX
    const sy = e.clientY
    let drew = false
    holdGesture(store)
    followPointer(
      e,
      (ev) => {
        if (!drew && Math.hypot(ev.clientX - sx, ev.clientY - sy) <= CLICK_SLOP) return
        drew = true
        const box = regionFromPoints(a, sourceAt(ev.clientX, ev.clientY, el), !ev.shiftKey)
        // A tiny box would zoom past the limit: normalizeRegion grows it around its centre.
        setRegion(id, box)
      },
      (ev) => {
        if (!drew && ev.type === 'pointerup') setRegion(id, dragRegion(initial, 'move', clamp(a.x, 0, 1) - (initial.x + initial.w / 2), clamp(a.y, 0, 1) - (initial.y + initial.h / 2)))
      }
    )
  }

  const pickAt = useCallback(
    (clientX: number, clientY: number, el: HTMLElement): void => {
      if (!pickZoom) return
      const r = el.getBoundingClientRect()
      const { x, y } = fromCrop(crop, { x: clamp((clientX - r.left - rect.x) / rect.w, 0, 1), y: clamp((clientY - r.top - rect.y) / rect.h, 0, 1) })
      const id = pickZoom.id
      store.update(
        (p) => ({ ...p, zooms: p.zooms.map((z) => (z.id === id ? { ...z, focus: { mode: 'fixed', x, y }, auto: false } : z)) }),
        `zoom-focus:${id}`
      )
    },
    [pickZoom, crop, rect.x, rect.y, rect.w, rect.h, store]
  )

  const onOverlayDown = (e: ReactPointerEvent<HTMLDivElement>): void => {
    if (e.button !== 0) return
    releaseFocus(e.target)
    const el = e.currentTarget
    if (pickZoom?.focus.mode === 'region') {
      e.preventDefault()
      drawRegion(e, el)
      return
    }
    if (pickZoom) {
      e.preventDefault()
      holdGesture(store)
      pickAt(e.clientX, e.clientY, el)
      followPointer(e, (ev) => pickAt(ev.clientX, ev.clientY, el))
      return
    }
    // E-06: Ctrl+click (or Shift+click) on the paused preview adds or removes the item under the
    // pointer; a miss does nothing (it never plays).
    if ((e.ctrlKey || e.metaKey || e.shiftKey) && !cropTool && scene && !player.moving) {
      e.preventDefault()
      const r = el.getBoundingClientRect()
      const key = topmostHit(previewBoxes(drawn, scene, rect, box, displayTime(drawn.clips, player.time)), e.clientX - r.left, e.clientY - r.top)
      const sx = e.clientX
      const sy = e.clientY
      followPointer(
        e,
        () => undefined,
        (ev) => {
          if (!key || ev.type !== 'pointerup' || Math.hypot(ev.clientX - sx, ev.clientY - sy) > CLICK_SLOP) return
          const next = toggleKey(group.group.keys, group.single, key, group.group.anchor)
          group.select(next.keys, next.anchor)
        }
      )
      return
    }
    if (view && redrawItem(e, el)) {
      e.preventDefault()
      return
    }
    // A plain click toggles playback; a drag does nothing.
    const sx = e.clientX
    const sy = e.clientY
    followPointer(
      e,
      () => undefined,
      (ev) => {
        if (ev.type === 'pointerup' && Math.hypot(ev.clientX - sx, ev.clientY - sy) <= CLICK_SLOP) onTogglePlay()
      }
    )
  }

  return (
    <div className="canvas-wrap" ref={wrapRef}>
      <div className="canvas-box" style={{ width: box.w, height: box.h }}>
        <canvas ref={canvasRef} className="preview-canvas" />
        <div
          className={`preview-overlay ${pickZoom ? 'picking' : ''}`}
          onPointerDown={onOverlayDown}
          title={pickZoom ? undefined : 'Click to play or pause'}
          data-testid="preview-overlay"
        >
          {pickZoom?.focus.mode === 'region' && <RegionEditor zoom={pickZoom} region={pickZoom.focus} rect={rect} onDone={onExitPick} sourceAt={sourceAt} setRegion={setRegion} />}
          {pickZoom && pickZoom.focus.mode !== 'region' && <FocusPicker zoom={pickZoom} rect={rect} onDone={onExitPick} />}
          {!pickZoom && !cropTool && selectedAnnotation && <AnnotationHandle annotation={selectedAnnotation} box={box} />}
          {!pickZoom && !cropTool && <OverlayEditor project={drawn} selection={selection} box={box} onDone={() => onSelect?.(null)} />}
          {editItem && view && mapping && <ShapeEditor edit={editItem} view={view} mapping={mapping} crop={crop} onDone={() => onSelect?.(null)} />}
          {cropTool && <CropEditor recorded={{ width: project.width, height: project.height }} rect={rect} {...cropTool} />}
          {outlines.map((b) => (
            <div
              key={b.key}
              className="group-outline"
              data-testid="group-outline"
              data-key={b.key}
              style={{ left: b.x, top: b.y, width: b.w, height: b.h }}
              title="Selected · click to edit it alone, Ctrl+click to leave it out"
              onPointerDown={(e) => {
                // With Ctrl or Shift the press goes on to the overlay, which adds or removes items.
                if (e.button !== 0 || e.ctrlKey || e.metaKey || e.shiftKey) return
                e.preventDefault()
                e.stopPropagation()
                releaseFocus(e.target)
                group.select([b.key], b.key)
              }}
            />
          ))}
          {outlines.length > 0 && (
            <div className="pick-hint group-hint" data-testid="group-hint">
              {outlines.length === 1 ? '1 selected item' : `${outlines.length} selected items`} on screen · Ctrl+click to add or remove
            </div>
          )}
        </div>
      </div>
    </div>
  )
})

/**
 * Where a zoom's frame lies on the unzoomed preview: zoomed in, the part of the recording
 * that fills the frame; pulled back, where the shrunk recording sits in the frame.
 */
function framedArea(zoom: ZoomSegment, fx: number, fy: number, rect: Rect): Rect {
  // Same camera as cameraAt: the zoomed viewport never leaves the recording.
  const cam = cameraFor(zoomTargetScale(zoom), fx, fy)
  if (cam.scale < 1) return cardRect(rect, cam)
  const half = 0.5 / cam.scale
  return { x: rect.x + (cam.cx - half) * rect.w, y: rect.y + (cam.cy - half) * rect.h, w: rect.w / cam.scale, h: rect.h / cam.scale }
}

function FocusPicker({ zoom, rect, onDone }: { zoom: ZoomSegment; rect: Rect; onDone: () => void }): JSX.Element {
  const fx = zoom.focus.mode === 'fixed' ? zoom.focus.x : 0.5
  const fy = zoom.focus.mode === 'fixed' ? zoom.focus.y : 0.5
  const view = framedArea(zoom, fx, fy, rect)
  return (
    <>
      <div className="focus-viewport" style={{ left: view.x, top: view.y, width: view.w, height: view.h }} />
      <div className="focus-marker" style={{ left: rect.x + fx * rect.w, top: rect.y + fy * rect.h }} />
      <div className="pick-hint">
        Click or drag to set where this zoom looks ·{' '}
        <button
          className="link"
          onPointerDown={(e) => e.stopPropagation()}
          onClick={(e) => {
            e.stopPropagation()
            onDone()
          }}
        >
          Done
        </button>
      </div>
    </>
  )
}

const CORNERS: RegionHandle[] = ['nw', 'ne', 'sw', 'se']

/**
 * Region zoom editor: the box the zoom frames (move it, resize it by its corners, or draw a
 * new one), and dashed, the area the frame will actually show (the box fitted to the frame's
 * shape and kept inside the recording).
 */
function RegionEditor({
  zoom,
  region,
  rect,
  onDone,
  sourceAt,
  setRegion
}: {
  zoom: ZoomSegment
  region: ZoomRegion
  rect: Rect
  onDone: () => void
  sourceAt: (clientX: number, clientY: number, el: HTMLElement) => { x: number; y: number }
  setRegion: (id: string, box: RegionBox) => void
}): JSX.Element {
  const { store } = useEditor()
  const view = framedArea(zoom, region.x + region.w / 2, region.y + region.h / 2, rect)
  const box = { left: rect.x + region.x * rect.w, top: rect.y + region.y * rect.h, width: region.w * rect.w, height: region.h * rect.h }

  const onDown = (handle: RegionHandle) => (e: ReactPointerEvent<HTMLElement>) => {
    if (e.button !== 0) return
    e.preventDefault()
    e.stopPropagation()
    releaseFocus(e.target)
    const frame = (e.currentTarget as HTMLElement).closest<HTMLElement>('.preview-overlay')
    if (!frame) return
    const start = sourceAt(e.clientX, e.clientY, frame)
    const id = zoom.id
    holdGesture(store)
    followPointer(e, (ev) => {
      const p = sourceAt(ev.clientX, ev.clientY, frame)
      setRegion(id, dragRegion(region, handle, p.x - start.x, p.y - start.y, !ev.shiftKey))
    })
  }

  return (
    <>
      <div className="region-view" style={{ left: view.x, top: view.y, width: view.w, height: view.h }} />
      <div className="region-box" style={box} onPointerDown={onDown('move')} data-testid="region-box" title="Drag to move · corners resize (Shift: any shape)">
        <span className="region-label">{formatLevel(zoomTargetScale(zoom))}</span>
        {CORNERS.map((c) => (
          <span
            key={c}
            className="region-handle"
            data-handle={c}
            style={{ left: c.includes('w') ? 0 : '100%', top: c.includes('n') ? 0 : '100%' }}
            onPointerDown={onDown(c)}
          />
        ))}
      </div>
      <div className="pick-hint">
        Drag to draw the area to zoom into (Shift: any shape) ·{' '}
        <button
          className="link"
          onPointerDown={(e) => e.stopPropagation()}
          onClick={(e) => {
            e.stopPropagation()
            onDone()
          }}
        >
          Done
        </button>
      </div>
    </>
  )
}

let measureCtx: CanvasRenderingContext2D | null = null
function textWidth(text: string, px: number, weight: number): number {
  measureCtx ??= document.createElement('canvas').getContext('2d')
  if (!measureCtx) return text.length * px * 0.55
  measureCtx.font = `${weight} ${px}px 'Segoe UI', system-ui, sans-serif`
  return measureCtx.measureText(text).width
}

/**
 * Drag handle for the selected text overlay, drawn as an outline where the
 * compositor renders the text. Shown only while the overlay is on screen.
 */
function AnnotationHandle({ annotation, box }: { annotation: Annotation; box: Box }): JSX.Element | null {
  const { store, player } = useEditor()
  const [visible, setVisible] = useState(() => annotationVisibleAt(annotation, player.time))
  useEffect(() => {
    const check = (): void => setVisible(annotationVisibleAt(annotation, player.time))
    check()
    return player.subscribe(check)
  }, [annotation, player])
  if (!visible || box.w === 0) return null

  const px = annotation.size * Math.min(box.w, box.h)
  const lines = annotation.text.split('\n')
  const weight = annotation.style === 'title' ? 700 : 600
  const w = Math.max(...lines.map((l) => textWidth(l || ' ', px, weight))) + (annotation.style === 'pill' ? px * 1.4 : px * 0.4)
  const h = px * 1.3 * lines.length + (annotation.style === 'pill' ? px * 0.7 : px * 0.2)

  const onDown = (e: ReactPointerEvent<HTMLDivElement>): void => {
    if (e.button !== 0) return
    // Ctrl+press goes on to the preview, which adds or removes items (E-06).
    if (e.ctrlKey || e.metaKey) return
    e.preventDefault()
    e.stopPropagation()
    releaseFocus(e.target)
    const el = e.currentTarget
    const frame = el.parentElement!.getBoundingClientRect()
    const offX = e.clientX - (frame.left + annotation.x * frame.width)
    const offY = e.clientY - (frame.top + annotation.y * frame.height)
    const id = annotation.id
    holdGesture(store)
    followPointer(e, (ev) => {
      const x = clamp((ev.clientX - offX - frame.left) / frame.width, 0, 1)
      const y = clamp((ev.clientY - offY - frame.top) / frame.height, 0, 1)
      store.update((p) => ({ ...p, annotations: p.annotations.map((a) => (a.id === id ? { ...a, x, y } : a)) }), `annotation-pos:${id}`)
    })
  }

  return (
    <div
      className="annotation-handle"
      title="Drag to move the text"
      style={{ left: annotation.x * box.w - w / 2, top: annotation.y * box.h - h / 2, width: w, height: h }}
      onPointerDown={onDown}
    />
  )
}

/* ---------- shapes and spotlights ---------- */

type Store = ReturnType<typeof useEditor>['store']

/** Stores a geometry patch made on the preview: it is in the crop's view (`crop`), stored in the full frame. */
function updateShape(store: Store, crop: NormRect | null, id: string, view: Partial<Shape>): void {
  const patch = geometryFromCrop(crop, view)
  store.update((p) => ({ ...p, shapes: (p.shapes ?? []).map((s) => (s.id === id ? { ...s, ...patch } : s)) }), `shape-geom:${id}`)
}

function updateSpotlight(store: Store, crop: NormRect | null, id: string, view: Partial<Spotlight>): void {
  const patch = geometryFromCrop(crop, view)
  store.update((p) => ({ ...p, spotlights: (p.spotlights ?? []).map((s) => (s.id === id ? { ...s, ...patch } : s)) }), `spot-geom:${id}`)
}

const BOX_HANDLES: RegionHandle[] = ['nw', 'n', 'ne', 'e', 'se', 's', 'sw', 'w']

/**
 * Handles for the selected shape or spotlight, where the compositor draws it: a box with
 * resize handles (boxes, ellipses, highlights, blur, region spotlights), both ends of an
 * arrow or line, or the lit area around the cursor (resized from its corners). Drags are
 * mapped through the camera at the playhead, so they work the same zoomed in.
 */
function ShapeEditor({ edit, view, mapping, crop, onDone }: { edit: EditItem; view: StageView; mapping: Mapping; crop: NormRect | null; onDone: () => void }): JSX.Element {
  const { store } = useEditor()
  const { type, item } = edit

  /** Follows a drag from a handle; `apply` gets the pointer's movement in source units. */
  const drag = (apply: (dx: number, dy: number, ev: PointerEvent) => void) => (e: ReactPointerEvent<Element>) => {
    if (e.button !== 0) return
    // Ctrl+press goes on to the preview, which adds or removes items (E-06); Shift keeps the shape.
    if (e.ctrlKey || e.metaKey) return
    e.preventDefault()
    e.stopPropagation()
    releaseFocus(e.target)
    const sx = e.clientX
    const sy = e.clientY
    holdGesture(store)
    followPointer(e, (ev) => apply((ev.clientX - sx) * mapping.ux, (ev.clientY - sy) * mapping.uy, ev))
  }

  // A cursor spotlight whose cursor is off the recording shows nothing here, so it has no box.
  const offscreen = type === 'spotlight' && item.mode === 'cursor' && view.cursorOff
  let body: JSX.Element | null
  if (offscreen) {
    body = null
  } else if (type === 'shape' && isLineKind(item.kind)) {
    const a = mapping.toPx(item.x, item.y)
    const b = mapping.toPx(item.x + item.w, item.y + item.h)
    const initial = { x: item.x, y: item.y, w: item.w, h: item.h }
    const moveEnd = (end: 'start' | 'end') =>
      drag((dx, dy) => {
        const from = end === 'start' ? { x: initial.x, y: initial.y } : { x: initial.x + initial.w, y: initial.y + initial.h }
        updateShape(store, crop, item.id, setLineEnd(initial, end, { x: from.x + dx, y: from.y + dy }))
      })
    body = (
      <>
        <svg className="shape-lines" aria-hidden="true">
          <line className="guide" x1={a.x} y1={a.y} x2={b.x} y2={b.y} />
          <line className="hit" x1={a.x} y1={a.y} x2={b.x} y2={b.y} onPointerDown={drag((dx, dy) => updateShape(store, crop, item.id, moveLine(initial, dx, dy)))} data-testid="shape-line" />
        </svg>
        <span className="shape-end" data-end="start" style={{ left: a.x, top: a.y }} onPointerDown={moveEnd('start')} title="Drag to move this end" />
        <span className="shape-end" data-end="end" style={{ left: b.x, top: b.y }} onPointerDown={moveEnd('end')} title={item.kind === 'arrow' ? 'Drag to move the arrowhead' : 'Drag to move this end'} />
      </>
    )
  } else {
    const follows = type === 'spotlight' && item.mode === 'cursor'
    const area = type === 'spotlight' ? spotlightArea(item, view.cursor) : shapeBounds(item)
    const a = mapping.toPx(area.x, area.y)
    const b = mapping.toPx(area.x + area.w, area.y + area.h)
    const initial = { x: area.x, y: area.y, w: area.w, h: area.h }
    const resize = (handle: RegionHandle) =>
      drag((dx, dy, ev) => {
        if (follows) updateSpotlight(store, crop, item.id, resizeAround(initial, handle, dx, dy))
        else if (type === 'spotlight') updateSpotlight(store, crop, item.id, dragShapeBox(initial, handle, dx, dy, ev.shiftKey))
        else updateShape(store, crop, item.id, dragShapeBox(initial, handle, dx, dy, ev.shiftKey))
      })
    const round = (type === 'spotlight' && item.shape === 'ellipse') || (type === 'shape' && item.kind === 'ellipse')
    body = (
      <div
        className={`shape-box ${follows ? 'follows' : ''}`}
        style={{ left: a.x, top: a.y, width: b.x - a.x, height: b.y - a.y }}
        onPointerDown={follows ? (e) => e.stopPropagation() : resize('move')}
        data-testid="shape-box"
        title={follows ? 'Follows the cursor: drag a corner to resize' : 'Drag to move · handles resize (Shift: keep the shape)'}
      >
        {round && <span className="shape-box round" style={{ inset: -1.5, pointerEvents: 'none' }} />}
        {follows && <span className="shape-tag">Follows the cursor</span>}
        {(follows ? (['nw', 'ne', 'sw', 'se'] as RegionHandle[]) : BOX_HANDLES).map((h) => (
          <span
            key={h}
            className="shape-handle"
            data-handle={h}
            style={{ left: h.includes('w') ? 0 : h.includes('e') ? '100%' : '50%', top: h.includes('n') ? 0 : h.includes('s') ? '100%' : '50%' }}
            onPointerDown={resize(h)}
          />
        ))}
      </div>
    )
  }

  const label = type === 'shape' ? shapeLabel(item.kind) : item.mode === 'cursor' ? 'Cursor spotlight' : 'Spotlight'
  return (
    <div className="shape-editor" data-testid="shape-editor" data-item={item.id}>
      {body}
      <div className="pick-hint shape-hint" onPointerDown={(e) => e.stopPropagation()}>
        {label} · {offscreen ? 'the cursor is off the recording here' : `drag to place it${type === 'spotlight' && item.mode === 'cursor' ? '' : ', or drag elsewhere to draw it again'}`} ·{' '}
        <button className="link" onClick={onDone}>
          Done
        </button>
      </div>
    </div>
  )
}

/* ---------- several items (E-06, docs/design/multi-select.md §4.6) ---------- */

/** Where the compositor draws a text item on the preview (as AnnotationHandle measures it), in overlay pixels. */
function textBox(a: Annotation, box: Box): { x: number; y: number; w: number; h: number } {
  const px = a.size * Math.min(box.w, box.h)
  const lines = a.text.split('\n')
  const weight = a.style === 'title' ? 700 : 600
  const w = Math.max(...lines.map((l) => textWidth(l || ' ', px, weight))) + (a.style === 'pill' ? px * 1.4 : px * 0.4)
  const h = px * 1.3 * lines.length + (a.style === 'pill' ? px * 0.7 : px * 0.2)
  return { x: a.x * box.w - w / 2, y: a.y * box.h - h / 2, w, h }
}

/**
 * The items on screen at source time `t`, as boxes in overlay pixels, topmost first in the
 * compositor's order: text, then shapes, then blur and pixelate (each in reverse list order), then
 * region spotlights by their lit area. Shapes and spotlights are mapped through the camera.
 */
function previewBoxes(drawn: Project, scene: RenderScene, rect: Rect, box: Box, t: number): KeyRect[] {
  if (box.w === 0) return []
  const cam = cameraAt(drawn.zooms, t, scene.cursor.valid ? scene.focusPath : null, zoomStyleOf(drawn))
  const m = mappingFor(cam, rect)
  const out: KeyRect[] = []
  const mapped = (key: ItemKey, b: { x: number; y: number; w: number; h: number }): void => {
    const a = m.toPx(b.x, b.y)
    const c = m.toPx(b.x + b.w, b.y + b.h)
    out.push({ key, x: Math.min(a.x, c.x), y: Math.min(a.y, c.y), w: Math.abs(c.x - a.x), h: Math.abs(c.y - a.y) })
  }
  for (const a of [...drawn.annotations].reverse()) if (annotationVisibleAt(a, t)) out.push({ key: `annotation:${a.id}`, ...textBox(a, box) })
  const shapes = [...(drawn.shapes ?? [])].reverse().filter((s) => itemVisibleAt(s, t))
  for (const s of shapes) if (!isPrivacyKind(s.kind)) mapped(`shape:${s.id}`, shapeBounds(s))
  for (const s of shapes) if (isPrivacyKind(s.kind)) mapped(`shape:${s.id}`, shapeBounds(s))
  for (const s of drawn.spotlights ?? []) if (s.mode === 'region' && itemVisibleAt(s, t)) mapped(`spotlight:${s.id}`, s)
  return out
}

/** The group's members on screen while the player is paused (re-rendered only when they change). */
function useGroupOutlines(player: PreviewPlayer, drawn: Project, scene: RenderScene | undefined, rect: Rect, box: Box, keys: ReadonlySet<string>, enabled: boolean): KeyRect[] {
  const [boxes, setBoxes] = useState<KeyRect[]>([])
  const { x, y, w, h } = rect
  useEffect(() => {
    if (!enabled || !scene) {
      setBoxes((b) => (b.length ? [] : b))
      return
    }
    let last = ''
    const update = (): void => {
      const next = player.moving ? [] : previewBoxes(drawn, scene, { x, y, w, h }, box, displayTime(drawn.clips, player.time)).filter((b) => keys.has(b.key))
      const sig = next.map((b) => `${b.key}:${b.x.toFixed(1)},${b.y.toFixed(1)},${b.w.toFixed(1)},${b.h.toFixed(1)}`).join(';')
      if (sig === last) return
      last = sig
      setBoxes(next)
    }
    update()
    return player.subscribe(update)
  }, [player, drawn, scene, x, y, w, h, box, keys, enabled])
  return boxes
}
