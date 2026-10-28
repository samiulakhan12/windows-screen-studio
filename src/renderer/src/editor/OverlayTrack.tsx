import { useMemo, useRef, useState, useSyncExternalStore, type PointerEvent as ReactPointerEvent } from 'react'
import { dragOverlayTimes, overlayLabel } from '../../../shared/editor/overlays'
import { itemKey } from '../../../shared/editor/multiSelect'
import { itemLanes } from '../../../shared/editor/shapes'
import { sameSpan } from '../../../shared/editor/snapping'
import { overlaps } from '../../../shared/editor/timelineScale'
import { clamp } from '../../../shared/engine/math'
import { formatTime } from '../../../shared/engine/project'
import type { ImageOverlay } from '../../../shared/types'
import { useEditor } from './context'
import { EditorIcon } from './EditorIcon'
import { releaseFocus } from './focus'
import { useGroup } from './groupContext'
import type { TrackSlotProps } from './LayoutTrack'
import { ipcMessage, pickOverlay, showOverlay } from './overlayItems'
import { followPointer } from './pointer'
import './overlays.css'

const NO_OVERLAYS: ImageOverlay[] = []

/** Grabbable edge width of a block: never more than a quarter of it, so its middle always moves it (as Timeline.tsx). */
const edgeWidth = (w: number): number => Math.max(3, Math.min(8, w * 0.25))

/**
 * Timeline track of image overlays and stickers: blocks move and trim like text, a click selects
 * one (and shows it on the preview), a double-click on empty space opens "Add image…" there.
 */
export function OverlayTrack({ px, win, duration, selection, onSelect, scrub, snap, multi }: TrackSlotProps): JSX.Element | null {
  const services = useEditor()
  const { store, player } = services
  const group = useGroup()
  // Straight from the store, so only a change to them re-renders the track.
  const overlays = useSyncExternalStore(store.subscribe, () => store.state.overlays) ?? NO_OVERLAYS
  const pxRef = useRef(px)
  pxRef.current = px
  const trackRef = useRef<HTMLDivElement>(null)
  const [error, setError] = useState<string | null>(null)
  const selId = selection?.kind === 'overlay' ? selection.id : null
  const lanes = useMemo(() => itemLanes(overlays), [overlays])

  const timeAt = (clientX: number): number => {
    const r = trackRef.current!.getBoundingClientRect()
    return clamp((clientX - r.left) / pxRef.current, 0, duration)
  }

  const dragMode = (e: ReactPointerEvent): 'move' | 'start' | 'end' => {
    const r = (e.currentTarget as HTMLElement).getBoundingClientRect()
    const edge = edgeWidth(r.width)
    if (e.clientX - r.left < edge) return 'start'
    if (r.right - e.clientX < edge) return 'end'
    return 'move'
  }

  const onOverlayDown = (o: ImageOverlay) => (e: ReactPointerEvent) => {
    if (e.button !== 0) return
    if (multi?.press(e, itemKey('overlay', o.id), dragMode(e))) return
    e.preventDefault()
    e.stopPropagation()
    releaseFocus()
    onSelect({ kind: 'overlay', id: o.id })
    const mode = dragMode(e)
    const initial = { start: o.start, end: o.end }
    const sx = e.clientX
    const s = snap.begin(e, { exclude: [{ owner: `overlay:${o.id}` }] })
    let moved = false
    store.beginGesture()
    followPointer(
      e,
      (ev) => {
        if (!moved && Math.abs(ev.clientX - sx) <= 3) return
        moved = true
        const times = s.span(ev, initial, mode, (ev.clientX - sx) / pxRef.current, (d) => dragOverlayTimes(initial, mode, d, duration))
        store.update(
          (p) =>
            sameSpan(
              p.overlays?.find((x) => x.id === o.id),
              times
            )
              ? p
              : { ...p, overlays: (p.overlays ?? []).map((x) => (x.id === o.id ? { ...x, ...times } : x)) },
          `overlay-drag:${o.id}`
        )
      },
      () => {
        store.endGesture()
        // A plain click also moves the playhead into the image, so it shows on the preview.
        if (!moved) showOverlay(player, store.state.clips, o)
      }
    )
  }

  // A double-click on empty track space is two quick pointerdowns at the same spot (as the other tracks).
  const lastDown = useRef({ at: 0, x: 0 })
  const onBackgroundDown = (e: ReactPointerEvent): void => {
    if (multi?.background(e, 'images')) return
    if (e.button !== 0) return
    const d = lastDown.current
    const second = e.timeStamp - d.at < 450 && Math.abs(e.clientX - d.x) < 6
    lastDown.current = second ? { at: 0, x: 0 } : { at: e.timeStamp, x: e.clientX }
    if (second) {
      e.preventDefault()
      const at = timeAt(e.clientX)
      setError(null)
      pickOverlay(services, { at, onSelect }).catch((err: unknown) => setError(ipcMessage(err)))
      return
    }
    onSelect(null)
    scrub(e)
  }

  /** Classes and tooltip ends of blocks in the group (E-06). */
  const groupSize = group.group.keys.length
  const memberClass = (id: string): string => {
    const key = itemKey('overlay', id)
    return group.keys.has(key) ? ` selected in-group${group.group.anchor === key ? ' anchor' : ''}` : ''
  }
  const groupHint = (id: string): string =>
    group.keys.has(itemKey('overlay', id)) ? ` · selected: drag to move all ${groupSize}, Ctrl+click to leave it out` : groupSize || !multi ? '' : ' · Ctrl+click to select several'

  // Like the caption and camera tracks, the row shows once the project has images (the Images tab,
  // a drop or a paste adds the first one), so projects without them keep the timeline's height.
  if (overlays.length === 0) return null

  const visible = overlays.filter((o) => overlaps(o, win) || o.id === selId)
  const laneH = 100 / lanes.count

  return (
    <div className="tl-track overlay-track" ref={trackRef} onPointerDown={onBackgroundDown} title="Double-click to add an image" data-testid="overlay-track">
      {visible.map((o) => {
        const w = (o.end - o.start) * px
        const lane = lanes.lanes.get(o.id) ?? 0
        const name = overlayLabel(o)
        return (
          <div
            key={o.id}
            data-overlay={o.id}
            data-start={o.start}
            data-end={o.end}
            className={`seg overlay-seg ${o.sticker ? 'sticker' : ''} ${selId === o.id ? 'selected' : ''}${memberClass(o.id)}`}
            style={{ left: o.start * px, width: w, top: `${lane * laneH}%`, height: `${laneH}%`, ['--edge' as string]: `${edgeWidth(w)}px` }}
            onPointerDown={onOverlayDown(o)}
            title={`${name} · ${formatTime(o.start)} – ${formatTime(o.end)}${groupHint(o.id)}`}
          >
            <span className="edge left" />
            {w > 22 && lanes.count <= 2 && (
              <span className="seg-icon">
                <EditorIcon name="image" size={13} />
              </span>
            )}
            {w > 50 && <span className="seg-label">{name}</span>}
            <span className="edge right" />
          </div>
        )
      })}
      {error && <span className="tl-empty overlay-track-error">{error}</span>}
    </div>
  )
}

/** Its row label in the timeline's label column (the track is always shown). */
export function OverlayTrackLabel(): JSX.Element | null {
  const { store } = useEditor()
  const has = useSyncExternalStore(store.subscribe, () => (store.state.overlays?.length ?? 0) > 0)
  if (!has) return null
  return (
    <div className="tl-label overlay-label" title="Images and stickers">
      <EditorIcon name="image" size={16} />
    </div>
  )
}
