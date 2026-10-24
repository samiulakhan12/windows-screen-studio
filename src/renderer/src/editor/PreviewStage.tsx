import { memo, useCallback, useEffect, useLayoutEffect, useRef, useState, type PointerEvent as ReactPointerEvent } from 'react'
import { annotationVisibleAt } from '../../../shared/editor/annotations'
import { dragRegion, formatLevel, regionFromPoints, setZoomRegion, type Box as RegionBox, type RegionHandle, type ZoomRegion } from '../../../shared/editor/zoomEdit'
import { styleContentRect, outputSize, type Rect } from '../../../shared/engine/layout'
import { clamp } from '../../../shared/engine/math'
import { cameraFor, zoomTargetScale } from '../../../shared/engine/zoom'
import type { Annotation, Project, ZoomSegment } from '../../../shared/types'
import { cardRect } from '../render/compositor'
import { holdGesture, useEditor } from './context'
import { releaseFocus } from './focus'
import { followPointer } from './pointer'
import './zoom.css'

interface Props {
  project: Project
  /** Zoom whose focus is being picked on the preview, if any. */
  pickZoom: ZoomSegment | null
  selectedAnnotation: Annotation | null
  onTogglePlay: () => void
  onExitPick: () => void
}

interface Box {
  w: number
  h: number
}

const CLICK_SLOP = 4

/**
 * The preview canvas, sized to fill the stage at the output aspect ratio. Its
 * backing store follows devicePixelRatio but never exceeds the recording's own
 * resolution, so HiDPI screens get a sharp preview without wasted pixels.
 * Overlays: picking a zoom's focus point, and moving the selected text.
 */
export const PreviewStage = memo(function PreviewStage({ project, pickZoom, selectedAnnotation, onTogglePlay, onExitPick }: Props): JSX.Element {
  const { store, player } = useEditor()
  const wrapRef = useRef<HTMLDivElement>(null)
  const canvasRef = useRef<HTMLCanvasElement>(null)
  const [box, setBox] = useState<Box>({ w: 0, h: 0 })
  const out = outputSize(project.style.aspectRatio, project.width, project.height, project.height)

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
  const vw = player.screen.videoWidth || project.width
  const vh = player.screen.videoHeight || project.height
  const rect = styleContentRect(box.w, box.h, vw, vh, project.style)

  /** Normalised source position under a pointer (the preview shows the unzoomed frame while picking). */
  const sourceAt = (clientX: number, clientY: number, el: HTMLElement): { x: number; y: number } => {
    const r = el.getBoundingClientRect()
    return { x: (clientX - r.left - rect.x) / rect.w, y: (clientY - r.top - rect.y) / rect.h }
  }

  const setRegion = (id: string, box: RegionBox): void => {
    store.update((p) => ({ ...p, zooms: p.zooms.map((z) => (z.id === id ? setZoomRegion(z, box) : z)) }), `zoom-region:${id}`)
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
      const x = clamp((clientX - r.left - rect.x) / rect.w, 0, 1)
      const y = clamp((clientY - r.top - rect.y) / rect.h, 0, 1)
      const id = pickZoom.id
      store.update(
        (p) => ({ ...p, zooms: p.zooms.map((z) => (z.id === id ? { ...z, focus: { mode: 'fixed', x, y }, auto: false } : z)) }),
        `zoom-focus:${id}`
      )
    },
    [pickZoom, rect.x, rect.y, rect.w, rect.h, store]
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
          {!pickZoom && selectedAnnotation && <AnnotationHandle annotation={selectedAnnotation} box={box} />}
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
