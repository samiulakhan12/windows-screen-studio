import { useMemo, useRef, useSyncExternalStore, type PointerEvent as ReactPointerEvent } from 'react'
import { AUTO_TITLE_SUFFIX } from '../../../shared/editor/directorCopy'
import { addLayoutAt, dragLayout, dragLayoutTimes, layoutDragBounds, LAYOUT_OPTIONS, layoutLabel, layoutShowTime, stayAround } from '../../../shared/editor/layouts'
import { sameSpan, type SnapExclude } from '../../../shared/editor/snapping'
import { overlaps } from '../../../shared/editor/timelineScale'
import { layoutRamps, segmentCorner } from '../../../shared/engine/layout'
import { clamp } from '../../../shared/engine/math'
import { formatTime } from '../../../shared/engine/project'
import { CORNER_NAMES } from '../../../shared/recording/cameraBubble'
import type { CameraLayout, Corner, LayoutSegment, Project } from '../../../shared/types'
import { Icon } from '../components/Icon'
import { useEditor } from './context'
import { releaseFocus } from './focus'
import { LayoutGlyph } from './layoutGlyphs'
import type { PreviewPlayer } from './player'
import { followPointer } from './pointer'
import type { Selection } from './selection'
import type { SnapController } from './snapControl'
import './camera.css'

export interface TrackSlotProps {
  /** Pixels per second of source time. */
  px: number
  /** Source-time window that is rendered (items outside it may be skipped). */
  win: { start: number; end: number }
  duration: number
  selection: Selection
  onSelect: (sel: Selection) => void
  /**
   * The timeline's scrub for a press on empty track space: moves the playhead with the pointer,
   * as on every track (the timeline does not scroll after the playhead while it is dragged).
   */
  scrub: (e: ReactPointerEvent) => void
  /** The timeline's snapping: each drag begins a session at pointerdown and snaps its moves. */
  snap: SnapController
}

/** Layout a double-click on the track adds (the Camera panel then shows the others). */
export const ADDED_LAYOUT: CameraLayout = 'side-by-side'

const NO_LAYOUTS: LayoutSegment[] = []
/** Grabbable edge width of a block: never more than a quarter of it, so its middle always moves it (as on the other tracks). */
const edgeWidth = (w: number): number => Math.max(3, Math.min(8, w * 0.25))
const shortLabel = (layout: CameraLayout): string => LAYOUT_OPTIONS.find((o) => o.value === layout)?.short ?? layoutLabel(layout)

/** A small frame with the camera's dot in `corner`: the corner a layout change puts the camera in. */
export function CornerGlyph({ corner }: { corner: Corner }): JSX.Element {
  const x = corner.endsWith('left') ? 4.5 : 13.5
  const y = corner.startsWith('top') ? 4.5 : 9.5
  return (
    <svg className="corner-glyph" width="18" height="14" viewBox="0 0 18 14" aria-hidden="true">
      <rect x="0.75" y="0.75" width="16.5" height="12.5" rx="2" fill="none" stroke="currentColor" strokeWidth="1.2" opacity="0.7" />
      <circle cx={x} cy={y} r="2.6" fill="currentColor" />
    </svg>
  )
}

/**
 * Moves the playhead so the preview shows layout change `id` settled, past its change in (unless
 * it already does). While playing, only to a change the playhead is not in: one just added there plays.
 */
export function showLayout(player: PreviewPlayer, project: Project, id: string): void {
  const seg = project.layouts?.find((s) => s.id === id)
  const at = seg ? layoutShowTime(project, seg, player.time, player.playing) : null
  if (at !== null) player.seek(at)
}

/** Whether the open recording has a camera (and its video): the layout track and its label show only then. */
const useHasCamera = (): boolean => {
  const { store, player } = useEditor()
  return useSyncExternalStore(store.subscribe, () => store.state.hasWebcam) && player.webcam !== null
}

/**
 * Timeline track of camera layout changes (shown only for recordings with a camera): a block per
 * segment, labelled with its layout and shaded where it animates in and out. Click selects (and
 * shows it on the preview), drag moves, the edges trim, a double-click on free time adds one.
 */
export function LayoutTrack({ px, win, duration, selection, onSelect, scrub, snap }: TrackSlotProps): JSX.Element | null {
  const { store, player } = useEditor()
  const hasCamera = useHasCamera()
  const layouts = useSyncExternalStore(store.subscribe, () => store.state.layouts) ?? NO_LAYOUTS
  const shown = useSyncExternalStore(store.subscribe, () => store.state.webcam.show)
  const clips = useSyncExternalStore(store.subscribe, () => store.state.clips)
  // Ramps depend on the default corner too: a change to the corner the camera already is in has none.
  const corner = useSyncExternalStore(store.subscribe, () => store.state.webcam.corner)
  const trackRef = useRef<HTMLDivElement>(null)
  const lastDown = useRef({ at: 0, x: 0 })
  const ramps = useMemo(() => {
    const scene = { layouts, clips, duration, hasWebcam: true, webcam: { ...store.state.webcam, show: true } }
    return new Map(layouts.map((s) => [s.id, layoutRamps(scene, s)]))
  }, [layouts, clips, duration, store, corner])
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
      // Added as at the playhead there (the same rule as the Camera panel and the commands).
      const r = addLayoutAt(store.state, ADDED_LAYOUT, timeAt(e.clientX))
      if (!r.ok) {
        if (r.id) onSelect({ kind: 'layout', id: r.id })
        return
      }
      store.update((p) => ({ ...p, layouts: r.layouts }))
      onSelect({ kind: 'layout', id: r.segment.id })
      showLayout(player, store.state, r.segment.id)
      return
    }
    onSelect(null)
    scrub(e)
  }

  const onSegmentDown = (s: LayoutSegment) => (e: ReactPointerEvent<HTMLElement>) => {
    if (e.button !== 0) return
    onSelect({ kind: 'layout', id: s.id })
    const r = e.currentTarget.getBoundingClientRect()
    const edge = edgeWidth(r.width)
    const mode = e.clientX - r.left < edge ? 'start' : r.right - e.clientX < edge ? 'end' : 'move'
    const bounds = layoutDragBounds(store.state.layouts ?? [], s.id, duration)
    // A change cut out of a camera position takes the position's pieces next to it along, so no gap opens in it.
    const around = stayAround(store.state.layouts ?? [], s)
    const initial = { start: s.start, end: s.end }
    const sx = e.clientX
    // Its own edges and the pieces' edges that follow them are not targets.
    const exclude: SnapExclude[] = [{ owner: `layout:${s.id}` }]
    if (around.before) exclude.push({ owner: `layout:${around.before.id}`, edge: 'end' })
    if (around.after) exclude.push({ owner: `layout:${around.after.id}`, edge: 'start' })
    const session = snap.begin(e, { exclude })
    store.beginGesture()
    drag(
      e,
      (ev) => {
        const times = session.span(ev, initial, mode, (ev.clientX - sx) / px, (d) => dragLayoutTimes(initial, mode, d, bounds))
        store.update((p) => (sameSpan(p.layouts?.find((x) => x.id === s.id), times) ? p : { ...p, layouts: dragLayout(p.layouts, s.id, times, around) }), `layout-drag:${s.id}`)
      },
      (moved) => {
        store.endGesture()
        // A plain click shows the layout on the preview, past its change in.
        if (!moved) showLayout(player, store.state, s.id)
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
          const corner = segmentCorner(s)
          // A change of corner alone (the default layout) is named by its corner.
          const label = corner && s.layout === 'default' ? CORNER_NAMES[corner] : shortLabel(s.layout)
          // Made by the camera director (any edit by hand clears the mark: then it is the user's).
          const auto = s.auto === true
          return (
            <div
              key={s.id}
              data-layout={s.id}
              data-layout-kind={s.layout}
              data-corner={corner}
              data-start={s.start}
              data-end={s.end}
              data-auto={auto ? 'true' : undefined}
              className={`seg layout-seg ${s.layout} ${auto ? 'auto' : ''} ${selId === s.id ? 'selected' : ''}`}
              style={{ left: s.start * px, width: w, ['--edge' as string]: `${edgeWidth(w)}px` }}
              onPointerDown={onSegmentDown(s)}
              title={`${layoutLabel(s.layout)}${corner ? ` · camera ${CORNER_NAMES[corner].toLowerCase()}` : ''} · ${formatTime(s.start)} – ${formatTime(s.end)}${auto ? AUTO_TITLE_SUFFIX : ''}`}
            >
              {ramp && w > 24 && (
                <>
                  {ramp.in > 0 && <span className="layout-ramp in" style={{ width: Math.min(w / 2, ramp.in * px) }} />}
                  {ramp.out > 0 && <span className="layout-ramp out" style={{ width: Math.min(w / 2, ramp.out * px) }} />}
                </>
              )}
              <span className="edge left" />
              {w > 30 && (corner && s.layout === 'default' ? <CornerGlyph corner={corner} /> : <LayoutGlyph layout={s.layout} size={18} />)}
              {corner && s.layout !== 'default' && w > 54 && <CornerGlyph corner={corner} />}
              {w > 84 && <span className="seg-label">{auto && w > 110 ? `${label} · auto` : label}</span>}
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
