import { useMemo, useRef, useSyncExternalStore, type PointerEvent as ReactPointerEvent } from 'react'
import { trimGraphic } from '../../../shared/editor/graphicsEdit'
import { GRAPHIC_NAMES } from '../../../shared/editor/groupEdit'
import { itemKey } from '../../../shared/editor/multiSelect'
import { itemLanes } from '../../../shared/editor/shapes'
import { sameSpan } from '../../../shared/editor/snapping'
import { overlaps } from '../../../shared/editor/timelineScale'
import { dragAnnotationTimes } from '../../../shared/editor/annotations'
import { formatTime } from '../../../shared/engine/project'
import type { Graphic } from '../../../shared/types'
import { useEditor } from './context'
import { EditorIcon } from './EditorIcon'
import { releaseFocus } from './focus'
import { showGraphic } from './graphicItems'
import { useGroup } from './groupContext'
import type { TrackSlotProps } from './LayoutTrack'
import { GraphicKindIcon, graphicLabel } from './panels/GraphicsPanel'
import { followPointer } from './pointer'
import './panels/graphics.css'

const NO_GRAPHICS: Graphic[] = []

/** Grabbable edge width of a block: never more than a quarter of it, so its middle always moves it (as Timeline.tsx). */
const edgeWidth = (w: number): number => Math.max(3, Math.min(8, w * 0.25))

/** `g` at `times`, a list card's items moved with it (as graphicsEdit's moves do). */
function retimed(g: Graphic, times: { start: number; end: number }): Graphic {
  const dt = times.start - g.start
  if (g.kind === 'list' && dt !== 0 && times.end - times.start === g.end - g.start) return { ...g, ...times, items: g.items.map((it) => ({ ...it, at: it.at + dt })) }
  return { ...g, ...times }
}

/**
 * The Graphics row (docs/design/captions-studio.md §2.11), under the caption row and hidden while
 * the project has no graphics: blocks with an icon and their text that move and trim like text
 * blocks (one undo step per gesture), multi-select, snapping, copy and paste and Delete as the other
 * group kinds. A click selects a block and shows it on the preview.
 */
export function GraphicsTrack({ px, win, duration, selection, onSelect, scrub, snap, multi }: TrackSlotProps): JSX.Element | null {
  const { store, player } = useEditor()
  const group = useGroup()
  const graphics = useSyncExternalStore(store.subscribe, () => store.state.graphics) ?? NO_GRAPHICS
  const pxRef = useRef(px)
  pxRef.current = px
  const lanes = useMemo(() => itemLanes(graphics), [graphics])
  if (!graphics.length) return null
  const selId = selection?.kind === 'graphic' ? selection.id : null

  const dragMode = (e: ReactPointerEvent): 'move' | 'start' | 'end' => {
    const r = (e.currentTarget as HTMLElement).getBoundingClientRect()
    const edge = edgeWidth(r.width)
    if (e.clientX - r.left < edge) return 'start'
    if (r.right - e.clientX < edge) return 'end'
    return 'move'
  }

  const onBlockDown = (g: Graphic) => (e: ReactPointerEvent) => {
    if (e.button !== 0) return
    const mode = dragMode(e)
    if (multi?.press(e, itemKey('graphic', g.id), mode)) return
    onSelect({ kind: 'graphic', id: g.id })
    e.preventDefault()
    e.stopPropagation()
    releaseFocus()
    const initial = { start: g.start, end: g.end }
    const sx = e.clientX
    const s = snap.begin(e, { exclude: [{ owner: `graphic:${g.id}` }] })
    let moved = false
    store.beginGesture()
    followPointer(
      e,
      (ev) => {
        if (!moved && Math.abs(ev.clientX - sx) <= 3) return
        moved = true
        const times = s.span(ev, initial, mode, (ev.clientX - sx) / pxRef.current, (d) => dragAnnotationTimes(initial, mode, d, duration))
        store.update((p) => {
          const now = p.graphics?.find((x) => x.id === g.id)
          if (!now || sameSpan(now, times)) return p
          if (mode === 'move') return { ...p, graphics: (p.graphics ?? []).map((x) => (x.id === g.id ? retimed(x, { start: times.start, end: times.start + (now.end - now.start) }) : x)) }
          return trimGraphic(p, g.id, mode, mode === 'start' ? times.start : times.end)
        }, `graphic-drag:${g.id}`)
      },
      () => {
        store.endGesture()
        // A plain click also moves the playhead into the graphic, so it shows on the preview.
        if (!moved) showGraphic(player, store.state, g)
      }
    )
  }

  const onBackgroundDown = (e: ReactPointerEvent): void => {
    if (multi?.background(e, 'graphics')) return
    if (e.button !== 0) return
    onSelect(null)
    scrub(e)
  }

  const groupSize = group.group.keys.length
  const memberClass = (id: string): string => {
    const key = itemKey('graphic', id)
    return group.keys.has(key) ? ` selected in-group${group.group.anchor === key ? ' anchor' : ''}` : ''
  }
  const groupHint = (id: string): string => (group.keys.has(itemKey('graphic', id)) ? ` · selected: drag to move all ${groupSize}, Ctrl+click to leave it out` : groupSize || !multi ? '' : ' · Ctrl+click to select several')
  const laneH = 100 / lanes.count

  return (
    <div className="tl-track graphics-track" data-testid="graphics-track" onPointerDown={onBackgroundDown} title="Pop-ups made from captions">
      {graphics
        .filter((g) => overlaps(g, win) || g.id === selId)
        .map((g) => {
          const w = (g.end - g.start) * px
          const lane = lanes.lanes.get(g.id) ?? 0
          const label = graphicLabel(g)
          return (
            <div
              key={g.id}
              data-graphic={g.id}
              data-start={g.start}
              data-end={g.end}
              className={`seg graphic-seg ${g.kind}${g.auto ? ' auto' : ''} ${selId === g.id ? 'selected' : ''}${memberClass(g.id)}`}
              style={{ left: g.start * px, width: w, top: `${lane * laneH}%`, height: `${laneH}%`, ['--edge' as string]: `${edgeWidth(w)}px` }}
              onPointerDown={onBlockDown(g)}
              title={`${label} · ${GRAPHIC_NAMES[g.kind]}${g.auto ? ' (automatic)' : ''} · ${formatTime(g.start)} – ${formatTime(g.end)}${groupHint(g.id)}`}
            >
              <span className="edge left" />
              {w > 22 && lanes.count <= 2 && (
                <span className="seg-icon">
                  <GraphicKindIcon kind={g.kind} size={13} />
                </span>
              )}
              {w > 50 && <span className="seg-label">{label}</span>}
              <span className="edge right" />
            </div>
          )
        })}
    </div>
  )
}

/** Its row label in the timeline's label column, shown with the row. */
export function GraphicsTrackLabel(): JSX.Element | null {
  const { store } = useEditor()
  const has = useSyncExternalStore(store.subscribe, () => !!store.state.graphics?.length)
  if (!has) return null
  return (
    <div className="tl-label graphics-label" title="Pop-ups">
      <EditorIcon name="burst" size={16} />
    </div>
  )
}
