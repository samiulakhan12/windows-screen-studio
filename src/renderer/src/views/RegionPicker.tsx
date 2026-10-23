import { useCallback, useEffect, useRef, useState, type PointerEvent as ReactPointerEvent } from 'react'
import {
  boxFromPoints,
  HANDLES,
  isUsable,
  moveBox,
  pixelSize,
  resizeBox,
  toNormRect,
  type Box,
  type Handle
} from '../recorder/regionGeometry'
import './RegionPicker.css'

type Drag = { mode: 'new' | 'move' | Handle; from: { x: number; y: number }; start: Box | null }

/**
 * Full-screen transparent overlay (one display) where the user drags the area to
 * record. Esc cancels, Enter confirms. The result goes back to the main process.
 */
export function RegionPicker(): JSX.Element {
  const [box, setBox] = useState<Box | null>(null)
  const drag = useRef<Drag | null>(null)
  const [dragging, setDragging] = useState(false)
  const bounds = { w: window.innerWidth, h: window.innerHeight }
  const usable = isUsable(box)

  const finish = useCallback((result: Box | null) => {
    window.api.finishRegion(result ? toNormRect(result, { w: window.innerWidth, h: window.innerHeight }) : null)
  }, [])

  useEffect(() => {
    const onKey = (e: KeyboardEvent): void => {
      if (e.key === 'Escape') finish(null)
      else if (e.key === 'Enter' && isUsable(box)) finish(box)
    }
    window.addEventListener('keydown', onKey)
    return () => window.removeEventListener('keydown', onKey)
  }, [box, finish])

  const begin = (mode: Drag['mode']) => (e: ReactPointerEvent) => {
    if (e.button !== 0) return
    e.stopPropagation()
    ;(e.currentTarget as Element).setPointerCapture(e.pointerId)
    drag.current = { mode, from: { x: e.clientX, y: e.clientY }, start: box }
    setDragging(true)
    if (mode === 'new') setBox({ x: e.clientX, y: e.clientY, w: 0, h: 0 })
  }

  const onMove = (e: ReactPointerEvent): void => {
    const d = drag.current
    if (!d) return
    const dx = e.clientX - d.from.x
    const dy = e.clientY - d.from.y
    if (d.mode === 'new') setBox(boxFromPoints(d.from, { x: e.clientX, y: e.clientY }, bounds))
    else if (d.mode === 'move' && d.start) setBox(moveBox(d.start, dx, dy, bounds))
    else if (d.start) setBox(resizeBox(d.start, d.mode as Handle, dx, dy, bounds))
  }

  const onUp = (): void => {
    const d = drag.current
    drag.current = null
    setDragging(false)
    // A click without a real drag keeps the previous selection.
    if (d?.mode === 'new' && !isUsable(box)) setBox(d.start)
  }

  const px = box ? pixelSize(box, window.devicePixelRatio || 1) : null
  const actionsBelow = !!box && box.y + box.h + 64 < bounds.h

  return (
    <div className={`region-root ${box ? 'has-box' : ''}`} onPointerDown={begin('new')} onPointerMove={onMove} onPointerUp={onUp}>
      {!box && (
        <div className="region-help">
          <strong>Drag to select the area to record</strong>
          <span>
            <kbd>Enter</kbd> to confirm · <kbd>Esc</kbd> to cancel
          </span>
        </div>
      )}
      {box && (
        <div className="region-box" style={{ left: box.x, top: box.y, width: box.w, height: box.h }} onPointerDown={begin('move')}>
          {px && (
            <span className={`region-size ${box.y < 30 ? 'inside' : ''}`}>
              {px.width} × {px.height}
            </span>
          )}
          {!dragging &&
            HANDLES.map((h) => <span key={h} className={`region-handle ${h}`} onPointerDown={begin(h)} />)}
        </div>
      )}
      {box && usable && !dragging && (
        <div
          className="region-actions"
          style={{
            left: Math.min(Math.max(8, box.x + box.w / 2 - 130), bounds.w - 268),
            top: actionsBelow ? box.y + box.h + 12 : Math.max(8, box.y + box.h - 56)
          }}
          onPointerDown={(e) => e.stopPropagation()}
        >
          <button className="region-btn" onClick={() => finish(null)}>
            Cancel
          </button>
          <button className="region-btn primary" onClick={() => finish(box)}>
            Record this area
          </button>
        </div>
      )}
    </div>
  )
}
