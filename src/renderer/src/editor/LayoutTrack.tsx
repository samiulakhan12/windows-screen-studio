import { useMemo, useRef, useSyncExternalStore, type PointerEvent as ReactPointerEvent } from 'react'
import { addLayoutAt, dragLayoutTimes, layoutDragBounds, LAYOUT_OPTIONS, layoutLabel } from '../../../shared/editor/layouts'
import { overlaps } from '../../../shared/editor/timelineScale'
import { layoutRamps, LAYOUT_TRANSITION } from '../../../shared/engine/layout'
import { clamp } from '../../../shared/engine/math'
import { formatTime } from '../../../shared/engine/project'
import type { CameraLayout, LayoutSegment } from '../../../shared/types'
import { Icon } from '../components/Icon'
import { useEditor } from './context'
import { releaseFocus } from './focus'
import { LayoutGlyph } from './layoutGlyphs'
import { followPointer } from './pointer'
import type { Selection } from './selection'
import './camera.css'

export interface TrackSlotProps {
  /** Pixels per second of source time. */
  px: number
  /** Source-time window that is rendered (items outside it may be skipped). */
  win: { start: number; end: number }
  duration: number
  selection: Selection
  onSelect: (sel: Selection) => void
}

/** Layout a double-click on the track adds (the Camera panel then shows the others). */
export const ADDED_LAYOUT: CameraLayout = 'side-by-side'

const NO_LAYOUTS: LayoutSegment[] = []
/** Grabbable edge width of a block: never more than a quarter of it, so its middle always moves it (as on the other tracks). */
const edgeWidth = (w: number): number => Math.max(3, Math.min(8, w * 0.25))
const shortLabel = (layout: CameraLayout): string => LAYOUT_OPTIONS.find((o) => o.value === layout)?.short ?? layoutLabel(layout)

/** Whether the open recording has a camera: the layout track and its label show only then. */
const useHasCamera = (): boolean => {
  const { store } = useEditor()
  return useSyncExternalStore(store.subscribe, () => store.state.hasWebcam)
}

/**
 * Timeline track of camera layout changes (shown only for recordings with a camera): a block per
 * segment, labelled with its layout and shaded where it animates in and out. Click selects (and
 * shows it on the preview), drag moves, the edges trim, a double-click on free time adds one.
 */
export function LayoutTrack({ px, win, duration, selection, onSelect }: TrackSlotProps): JSX.Element | null {
  const { store, player } = useEditor()
  const hasCamera = useHasCamera()
  const layouts = useSyncExternalStore(store.subscribe, () => store.state.layouts) ?? NO_LAYOUTS
  const shown = useSyncExternalStore(store.subscribe, () => store.state.webcam.show)
  const clips = useSyncExternalStore(store.subscribe, () => store.state.clips)
  const trackRef = useRef<HTMLDivElement>(null)
  const lastDown = useRef({ at: 0, x: 0 })
  const ramps = useMemo(() => {
    const scene = { layouts, clips, duration, hasWebcam: true, webcam: { ...store.state.webcam, show: true } }
    return new Map(layouts.map((s) => [s.id, layoutRamps(scene, s)]))
  }, [layouts, clips, duration, store])
  if (!hasCamera) return null

  const timeAt = (clientX: number): number => {
    const r = trackRef.current!.getBoundingClientRect()
    return clamp((clientX - r.left) / px, 0, duration)
  }

  /** Follows a pointer drag; `onMove` runs once the pointer moved more than 3 px. */
  const drag = (e: ReactPointerEvent, onMove: (ev: PointerEvent) => void, onEnd: (moved: boolean) => void): void => {
    e.preventDefault()
    e.stopPropagation()
    releaseFocus()
    const sx = e.clientX
    let moved = false
    followPointer(
      e,
      (ev) => {
        if (!moved && Math.abs(ev.clientX - sx) <= 3) return
        moved = true
        onMove(ev)
      },
      () => onEnd(moved)
    )
  }

  const onBackgroundDown = (e: ReactPointerEvent): void => {
    if (e.button !== 0) return
    // A double-click is two quick pointerdowns at the same spot (as on the other tracks).
    const d = lastDown.current
    const second = e.timeStamp - d.at < 450 && Math.abs(e.clientX - d.x) < 6
    lastDown.current = second ? { at: 0, x: 0 } : { at: e.timeStamp, x: e.clientX }
    if (second) {
      e.preventDefault()
      const added = addLayoutAt(store.state.layouts, ADDED_LAYOUT, timeAt(e.clientX), duration)
      if (!added) return
      store.update((p) => ({ ...p, layouts: added.layouts }))
      onSelect({ kind: 'layout', id: added.segment.id })
      return
    }
    onSelect(null)
    player.seek(timeAt(e.clientX))
    drag(e, (ev) => player.seek(timeAt(ev.clientX)), () => undefined)
  }

  const onSegmentDown = (s: LayoutSegment) => (e: ReactPointerEvent<HTMLElement>) => {
    if (e.button !== 0) return
    onSelect({ kind: 'layout', id: s.id })
    const r = e.currentTarget.getBoundingClientRect()
    const edge = edgeWidth(r.width)
    const mode = e.clientX - r.left < edge ? 'start' : r.right - e.clientX < edge ? 'end' : 'move'
    const bounds = layoutDragBounds(store.state.layouts ?? [], s.id, duration)
    const initial = { start: s.start, end: s.end }
    const sx = e.clientX
    store.beginGesture()
    drag(
      e,
      (ev) => {
        const times = dragLayoutTimes(initial, mode, (ev.clientX - sx) / px, bounds)
        store.update((p) => ({ ...p, layouts: (p.layouts ?? []).map((x) => (x.id === s.id ? { ...x, ...times } : x)) }), `layout-drag:${s.id}`)
      },
      (moved) => {
        store.endGesture()
        // A plain click shows the layout on the preview, past its change in.
        if (!moved && (player.time < s.start || player.time >= s.end)) player.seek(s.start + Math.min(LAYOUT_TRANSITION, (s.end - s.start) / 2))
      }
    )
  }

  const selId = selection?.kind === 'layout' ? selection.id : null
  return (
    <div
      ref={trackRef}
      className={`tl-track layout-track ${shown ? '' : 'camera-off'}`}
      onPointerDown={onBackgroundDown}
      title={shown ? 'Double-click to change the camera layout here' : 'The camera is hidden: layouts apply once it is shown (Camera panel)'}
      data-testid="layout-track"
    >
      {layouts
        .filter((s) => overlaps(s, win) || s.id === selId)
        .map((s) => {
          const w = (s.end - s.start) * px
          const ramp = ramps.get(s.id)
          return (
            <div
              key={s.id}
              data-layout={s.id}
              data-layout-kind={s.layout}
              data-start={s.start}
              data-end={s.end}
              className={`seg layout-seg ${s.layout} ${selId === s.id ? 'selected' : ''}`}
              style={{ left: s.start * px, width: w, ['--edge' as string]: `${edgeWidth(w)}px` }}
              onPointerDown={onSegmentDown(s)}
              title={`${layoutLabel(s.layout)} · ${formatTime(s.start)} – ${formatTime(s.end)}`}
            >
              {ramp && w > 24 && (
                <>
                  {ramp.in > 0 && <span className="layout-ramp in" style={{ width: Math.min(w / 2, ramp.in * px) }} />}
                  {ramp.out > 0 && <span className="layout-ramp out" style={{ width: Math.min(w / 2, ramp.out * px) }} />}
                </>
              )}
              <span className="edge left" />
              {w > 30 && <LayoutGlyph layout={s.layout} size={18} />}
              {w > 84 && <span className="seg-label">{shortLabel(s.layout)}</span>}
              <span className="edge right" />
            </div>
          )
        })}
      {layouts.length === 0 && <span className="tl-empty">Double-click to change the camera layout here, or use the Camera panel</span>}
    </div>
  )
}

/** Its row label in the timeline's label column, or null when the track is hidden. */
export function LayoutTrackLabel(): JSX.Element | null {
  const hasCamera = useHasCamera()
  if (!hasCamera) return null
  return (
    <div className="tl-label" title="Camera layout">
      <Icon name="camera" size={16} />
    </div>
  )
}
