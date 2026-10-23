import { memo, useCallback, useEffect, useLayoutEffect, useRef, useState, type PointerEvent as ReactPointerEvent } from 'react'
import { annotationVisibleAt } from '../../../shared/editor/annotations'
import { contentRect, outputSize } from '../../../shared/engine/layout'
import { clamp } from '../../../shared/engine/math'
import type { Annotation, Project, ZoomSegment } from '../../../shared/types'
import { holdGesture, useEditor } from './context'
import { releaseFocus } from './focus'
import { followPointer } from './pointer'

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

  useEffect(() => {
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
  const rect = contentRect(box.w, box.h, vw, vh, project.style.padding)

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
          {pickZoom && <FocusPicker zoom={pickZoom} rect={rect} onDone={onExitPick} />}
          {!pickZoom && selectedAnnotation && <AnnotationHandle annotation={selectedAnnotation} box={box} />}
        </div>
      </div>
    </div>
  )
})

function FocusPicker({ zoom, rect, onDone }: { zoom: ZoomSegment; rect: { x: number; y: number; w: number; h: number }; onDone: () => void }): JSX.Element {
  const fx = zoom.focus.mode === 'fixed' ? zoom.focus.x : 0.5
  const fy = zoom.focus.mode === 'fixed' ? zoom.focus.y : 0.5
  // Same clamping as cameraAt: the zoomed viewport never leaves the recording.
  const half = 0.5 / zoom.scale
  const cx = clamp(fx, half, 1 - half)
  const cy = clamp(fy, half, 1 - half)
  return (
    <>
      <div
        className="focus-viewport"
        style={{
          left: rect.x + (cx - half) * rect.w,
          top: rect.y + (cy - half) * rect.h,
          width: rect.w / zoom.scale,
          height: rect.h / zoom.scale
        }}
      />
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
