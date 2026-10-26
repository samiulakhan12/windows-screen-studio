import { useState, type PointerEvent as ReactPointerEvent } from 'react'
import {
  browserBarCrop,
  CROP_ASPECTS,
  cropRatio,
  dragCrop,
  fitCropAspect,
  SMALL_CROP_PX,
  snapCrop,
  taskbarCrop,
  type CropAspect,
  type CropDraft
} from '../../../shared/editor/cropEdit'
import type { RegionHandle } from '../../../shared/editor/zoomEdit'
import { cropPixels, FULL_FRAME } from '../../../shared/engine/crop'
import type { Rect } from '../../../shared/engine/layout'
import type { CaptureInfo, NormRect } from '../../../shared/types'
import { blurActiveControl, releaseFocus } from './focus'
import { followPointer } from './pointer'
import './crop.css'
import './zoom.css'

/** The recording's size in recorded pixels: what a crop is measured and snapped in. */
type Size = { width: number; height: number }

/** The crop tool on the preview: the draft being edited and what it does (Editor.tsx holds the draft). */
export interface CropTool {
  draft: CropDraft
  onDraft: (d: CropDraft) => void
  /** Applies the draft (one undo step). */
  onDone: () => void
}

const HANDLES: RegionHandle[] = ['nw', 'n', 'ne', 'e', 'se', 's', 'sw', 'w']
/** Overlay pixels within which a dragged edge snaps to the edge of the recording. */
const MAGNET_PX = 8
const NO_MAGNET = { x: 0, y: 0 }

const sizeText = (r: NormRect, size: Size): string => {
  const px = cropPixels(r, size.width, size.height)
  return `${px.w} × ${px.h}`
}

/**
 * The crop being edited, over the whole recording (the preview shows it unzoomed, flat and without
 * the camera): the part cut away dimmed, a box to move with 8 handles to resize, its size in
 * recorded pixels, and thirds while dragging. Drags work in recorded pixels: aspect locks (Shift
 * keeps the shape when free), at least MIN_CROP_PX a side, edges snapping to the recording's edges
 * within a few screen pixels. Double-clicking the box applies it.
 */
export function CropEditor({ recorded, rect, draft, onDraft, onDone }: { recorded: Size; rect: Rect } & CropTool): JSX.Element {
  const [dragging, setDragging] = useState(false)
  const r = draft.rect
  const left = rect.x + r.x * rect.w
  const top = rect.y + r.y * rect.h
  const width = r.w * rect.w
  const height = r.h * rect.h

  const onDown = (handle: RegionHandle) => (e: ReactPointerEvent<HTMLElement>) => {
    if (e.button !== 0) return
    e.preventDefault()
    e.stopPropagation()
    releaseFocus(e.target)
    const sx = e.clientX
    const sy = e.clientY
    const initial = draft.rect
    const locked = cropRatio(draft.aspect, recorded.width, recorded.height)
    // The box's own shape: what Shift keeps, and what a move keeps while the magnet shifts it.
    const own = (initial.w * recorded.width) / (initial.h * recorded.height)
    const magnet = { x: MAGNET_PX / Math.max(1, rect.w), y: MAGNET_PX / Math.max(1, rect.h) }
    setDragging(true)
    followPointer(
      e,
      (ev) => {
        const ratio = locked ?? (ev.shiftKey ? own : null)
        const next = dragCrop(initial, handle, (ev.clientX - sx) / rect.w, (ev.clientY - sy) / rect.h, recorded, ratio)
        // A move snaps by moving the whole box; a locked resize only rounds (its anchor corner stays).
        const snapped = handle === 'move' ? snapCrop(next, recorded, magnet, own) : snapCrop(next, recorded, ratio ? NO_MAGNET : magnet, ratio)
        onDraft({ ...draft, rect: snapped })
      },
      () => setDragging(false)
    )
  }

  return (
    <div className="crop-editor" data-testid="crop-editor">
      <div className="crop-shade" style={{ left: rect.x, top: rect.y, width: rect.w, height: top - rect.y }} />
      <div className="crop-shade" style={{ left: rect.x, top: top + height, width: rect.w, height: rect.y + rect.h - top - height }} />
      <div className="crop-shade" style={{ left: rect.x, top, width: left - rect.x, height }} />
      <div className="crop-shade" style={{ left: left + width, top, width: rect.x + rect.w - left - width, height }} />
      <div
        className="crop-box"
        style={{ left, top, width, height }}
        onPointerDown={onDown('move')}
        onDoubleClick={(e) => {
          e.stopPropagation()
          onDone()
        }}
        data-testid="crop-box"
        title="Drag to move · edges and corners resize · Enter to apply, Esc to cancel"
      >
        {dragging && (
          <>
            <span className="crop-third v" style={{ left: '33.333%', top: 0, bottom: 0 }} />
            <span className="crop-third v" style={{ left: '66.667%', top: 0, bottom: 0 }} />
            <span className="crop-third h" style={{ top: '33.333%', left: 0, right: 0 }} />
            <span className="crop-third h" style={{ top: '66.667%', left: 0, right: 0 }} />
          </>
        )}
        <span className="crop-size">{sizeText(r, recorded)}</span>
        {HANDLES.map((h) => (
          <span
            key={h}
            className="region-handle crop-handle"
            data-handle={h}
            data-testid={`crop-handle-${h}`}
            style={{ left: h.includes('w') ? 0 : h.includes('e') ? '100%' : '50%', top: h.includes('n') ? 0 : h.includes('s') ? '100%' : '50%' }}
            onPointerDown={onDown(h)}
          />
        ))}
      </div>
    </div>
  )
}

const ASPECT_LABELS: Record<CropAspect, string> = { free: 'Free', original: 'Original', '16:9': '16:9', '4:3': '4:3', '1:1': '1:1', '9:16': '9:16' }

/**
 * The crop tool's bar under the preview: aspect locks, the taskbar and browser-bar presets, the
 * size, Reset, Cancel and Done. Every button hands the keyboard back afterwards, so Enter then
 * applies and Esc cancels (a focused button would take the Enter).
 */
export function CropBar({
  recorded,
  draft,
  capture,
  scale,
  onDraft,
  onDone,
  onCancel
}: {
  recorded: Size
  draft: CropDraft
  capture: CaptureInfo
  /** Display scale of the recorded monitor (cursor.json), for the presets. */
  scale: number | undefined
  onCancel: () => void
} & CropTool): JSX.Element {
  const { width: W, height: H } = recorded
  const p = { capture, width: W, height: H }
  const act =
    (fn: () => void) =>
    (): void => {
      fn()
      blurActiveControl()
    }
  const chooseAspect = (aspect: CropAspect): void => {
    const ratio = cropRatio(aspect, W, H)
    onDraft({ rect: ratio ? snapCrop(fitCropAspect(draft.rect, ratio, recorded), recorded, NO_MAGNET, ratio) : draft.rect, aspect })
  }
  // A preset moves one edge and frees the shape.
  const preset = (r: NormRect | null) => (): void => {
    if (r) onDraft({ rect: snapCrop(r, recorded, NO_MAGNET, null), aspect: 'free' })
  }
  const taskbar = taskbarCrop(draft.rect, p, scale)
  const browserBar = browserBarCrop(draft.rect, p, scale)
  const scaling = Math.round((typeof scale === 'number' && scale > 0 ? scale : 1) * 100)
  const taskbarCut = taskbar ? Math.round((1 - taskbar.y - taskbar.h) * H) : 0
  const browserCut = browserBar ? Math.round(browserBar.y * H) : 0
  // Why the browser bar is not offered: an area below the top of the screen, else a short recording.
  const lowArea = (capture.target ?? (capture.region ? 'area' : 'screen')) === 'area' && (capture.region?.y ?? 0) !== 0
  const px = cropPixels(draft.rect, W, H)
  const small = px.h < SMALL_CROP_PX && (px.w < W || px.h < H)

  return (
    <div className="crop-bar" data-testid="crop-bar">
      <div className="crop-bar-row">
        <div className="chips" role="group" aria-label="Crop shape">
          {CROP_ASPECTS.map((a) => (
            <button
              key={a}
              className={`chip ${draft.aspect === a ? 'active' : ''}`}
              aria-pressed={draft.aspect === a}
              title={a === 'free' ? 'Any shape. Hold Shift while dragging to keep the current shape' : a === 'original' ? `The recording's own shape (${W} × ${H})` : `Keep the shape at ${a}`}
              onClick={act(() => chooseAspect(a))}
            >
              {ASPECT_LABELS[a]}
            </button>
          ))}
        </div>
        <button
          className="btn small"
          disabled={!taskbar}
          title={taskbar ? `Cut the bottom ${taskbarCut} px: the Windows taskbar at ${scaling}% scaling` : 'This recording does not show the taskbar'}
          onClick={act(preset(taskbar))}
          data-testid="crop-taskbar"
        >
          Hide taskbar
        </button>
        <button
          className="btn small"
          disabled={!browserBar}
          title={
            browserBar
              ? `Cut the top ${browserCut} px: tabs and address bar of a maximised browser`
              : lowArea
                ? 'Only for screen or window recordings, or areas at the top of the screen'
                : 'This recording is too short to show a browser bar'
          }
          onClick={act(preset(browserBar))}
          data-testid="crop-browserbar"
        >
          Hide browser bar
        </button>
        <span className="crop-bar-size" data-testid="crop-size">
          {px.w} × {px.h} px
        </span>
        <div className="crop-bar-actions">
          <button className="btn small ghost" title="Whole recording" onClick={act(() => onDraft({ rect: { ...FULL_FRAME }, aspect: 'free' }))} data-testid="crop-reset">
            Reset
          </button>
          <button className="btn small ghost" title="Esc" onClick={act(onCancel)} data-testid="crop-cancel">
            Cancel
          </button>
          <button className="btn small primary" title="Enter" onClick={act(onDone)} data-testid="crop-done">
            Done
          </button>
        </div>
      </div>
      {small && (
        <p className="hint crop-bar-hint">
          Only {px.w} × {px.h} px: larger exports will be upscaled and may look soft.
        </p>
      )}
    </div>
  )
}
