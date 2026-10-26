import { useMemo, useRef, useSyncExternalStore, type PointerEvent as ReactPointerEvent } from 'react'
import { itemLanes } from '../../../shared/editor/shapes'
import { orPress } from '../../../shared/editor/shortcuts'
import { sameSpan } from '../../../shared/editor/snapping'
import { overlaps } from '../../../shared/editor/timelineScale'
import { dragTitleTimes, TITLE_STYLES } from '../../../shared/editor/titles'
import { clamp } from '../../../shared/engine/math'
import { formatTime } from '../../../shared/engine/project'
import type { Chapter, TitleCard, TitleCardStyle } from '../../../shared/types'
import { useEditor } from './context'
import { releaseFocus } from './focus'
import { useKeymap } from './keymapContext'
import type { TrackSlotProps } from './LayoutTrack'
import { followPointer } from './pointer'
import { addChapterAt, addTitleAt, showTitle } from './titleItems'
import './titles.css'

const NO_TITLES: TitleCard[] = []
const NO_CHAPTERS: Chapter[] = []

/** Grabbable edge width of a block: never more than a quarter of it, so its middle always moves it (as Timeline.tsx). */
const edgeWidth = (w: number): number => Math.max(3, Math.min(8, w * 0.25))

const styleLabel = (style: TitleCardStyle): string => TITLE_STYLES.find((s) => s.value === style)?.label ?? 'Title'

/**
 * Timeline track of title cards, with chapter flags along its top: blocks move and trim like
 * the text track, flags drag to move a chapter, a click selects (and shows it on the preview),
 * a double-click on empty space adds a title card, or a chapter in the flag strip.
 */
export function TitleTrack({ px, win, duration, selection, onSelect, scrub, snap }: TrackSlotProps): JSX.Element {
  const services = useEditor()
  const { store, player } = services
  const keymap = useKeymap()
  // Straight from the store, so only a change to them re-renders the track.
  const titles = useSyncExternalStore(store.subscribe, () => store.state.titles) ?? NO_TITLES
  const chapters = useSyncExternalStore(store.subscribe, () => store.state.chapters) ?? NO_CHAPTERS
  const pxRef = useRef(px)
  pxRef.current = px
  const trackRef = useRef<HTMLDivElement>(null)
  const selId = selection && 'id' in selection ? selection.id : null
  const lanes = useMemo(() => itemLanes(titles), [titles])

  /** Source time under a pointer (the track starts at 0 s). */
  const timeAt = (clientX: number): number => {
    const r = trackRef.current!.getBoundingClientRect()
    return clamp((clientX - r.left) / pxRef.current, 0, duration)
  }

  /** Follows a pointer drag; `onMove` runs once it moved more than `slop` px. */
  const track = (e: ReactPointerEvent, onMove: (ev: PointerEvent) => void, onEnd?: (moved: boolean) => void, slop = 0): void => {
    e.preventDefault()
    e.stopPropagation()
    releaseFocus()
    const sx = e.clientX
    let moved = false
    followPointer(
      e,
      (ev) => {
        if (!moved && Math.abs(ev.clientX - sx) <= slop) return
        moved = true
        onMove(ev)
      },
      () => onEnd?.(moved)
    )
  }

  const dragMode = (e: ReactPointerEvent): 'move' | 'start' | 'end' => {
    const r = (e.currentTarget as HTMLElement).getBoundingClientRect()
    const edge = edgeWidth(r.width)
    if (e.clientX - r.left < edge) return 'start'
    if (r.right - e.clientX < edge) return 'end'
    return 'move'
  }

  const onTitleDown = (card: TitleCard) => (e: ReactPointerEvent) => {
    if (e.button !== 0) return
    onSelect({ kind: 'title', id: card.id })
    const mode = dragMode(e)
    const initial = { start: card.start, end: card.end }
    const sx = e.clientX
    const s = snap.begin(e, { exclude: [{ owner: `title:${card.id}` }] })
    store.beginGesture()
    track(
      e,
      (ev) => {
        const times = s.span(ev, initial, mode, (ev.clientX - sx) / pxRef.current, (d) => dragTitleTimes(initial, mode, d, duration))
        store.update((p) => (sameSpan(p.titles?.find((x) => x.id === card.id), times) ? p : { ...p, titles: (p.titles ?? []).map((x) => (x.id === card.id ? { ...x, ...times } : x)) }), `title-drag:${card.id}`)
      },
      (moved) => {
        store.endGesture()
        // A plain click also moves the playhead into the card, so it shows on the preview.
        if (!moved) showTitle(player, store.state.clips, card)
      },
      3
    )
  }

  const onChapterDown = (c: Chapter) => (e: ReactPointerEvent) => {
    if (e.button !== 0) return
    onSelect({ kind: 'chapter', id: c.id })
    const sx = e.clientX
    const s = snap.begin(e, { exclude: [{ owner: `chapter:${c.id}` }] })
    store.beginGesture()
    track(
      e,
      (ev) => {
        const t = s.at(ev, clamp(c.t + (ev.clientX - sx) / pxRef.current, 0, duration), { min: 0, max: duration })
        store.update((p) => (p.chapters?.find((x) => x.id === c.id)?.t === t ? p : { ...p, chapters: (p.chapters ?? []).map((x) => (x.id === c.id ? { ...x, t } : x)) }), `chapter-drag:${c.id}`)
      },
      (moved) => {
        store.endGesture()
        // A plain click goes to the chapter.
        if (!moved) player.seek(c.t)
      },
      3
    )
  }

  // A double-click on empty track space is two quick pointerdowns at the same spot (detected
  // before the first click's scrub, as the other tracks do).
  const lastDown = useRef({ at: 0, x: 0, lane: '' })
  const isSecondClick = (e: ReactPointerEvent, lane: string): boolean => {
    const d = lastDown.current
    const second = d.lane === lane && e.timeStamp - d.at < 450 && Math.abs(e.clientX - d.x) < 6
    lastDown.current = second ? { at: 0, x: 0, lane: '' } : { at: e.timeStamp, x: e.clientX, lane }
    return second
  }

  const onBackgroundDown = (lane: 'title' | 'chapter') => (e: ReactPointerEvent) => {
    if (e.button !== 0) return
    if (isSecondClick(e, lane)) {
      e.preventDefault()
      const at = timeAt(e.clientX)
      if (lane === 'title') addTitleAt(services, { at, onSelect })
      else addChapterAt(services, { at, onSelect })
      return
    }
    onSelect(null)
    scrub(e)
  }

  const visibleTitles = titles.filter((c) => overlaps(c, win) || c.id === selId)
  const visibleChapters = chapters.filter((c) => (c.t >= win.start - 2 && c.t <= win.end) || c.id === selId)
  const laneH = 100 / lanes.count

  return (
    <div className="tl-track title-track" ref={trackRef} data-testid="title-track">
      <div className="chapter-strip" onPointerDown={onBackgroundDown('chapter')} title="Chapters · double-click to add one">
        {visibleChapters.map((c) => (
          <div
            key={c.id}
            data-chapter={c.id}
            data-t={c.t}
            className={`chapter-flag ${selId === c.id ? 'selected' : ''}`}
            style={{ left: c.t * px }}
            onPointerDown={onChapterDown(c)}
            title={`${c.title || 'Chapter'} · ${formatTime(c.t)} · drag to move`}
          >
            <span className="chapter-name">{c.title || 'Chapter'}</span>
          </div>
        ))}
        {chapters.length === 0 && <span className="tl-empty chapter-empty">{orPress('Double-click to add a chapter', keymap.addChapter)}</span>}
      </div>
      <div className="title-lane" onPointerDown={onBackgroundDown('title')} title="Double-click to add a title card">
        {visibleTitles.map((c) => {
          const w = (c.end - c.start) * px
          const lane = lanes.lanes.get(c.id) ?? 0
          const name = c.title.trim() || c.subtitle?.trim() || 'Title'
          return (
            <div
              key={c.id}
              data-title={c.id}
              data-start={c.start}
              data-end={c.end}
              className={`seg title-seg ${c.style} ${selId === c.id ? 'selected' : ''}`}
              style={{ left: c.start * px, width: w, top: `${lane * laneH}%`, height: `${laneH}%`, ['--edge' as string]: `${edgeWidth(w)}px` }}
              onPointerDown={onTitleDown(c)}
              title={`${name} · ${styleLabel(c.style)} · ${formatTime(c.start)} – ${formatTime(c.end)}`}
            >
              <span className="edge left" />
              {w > 22 && lanes.count <= 2 && (
                <span className="seg-icon">
                  <TitleStyleIcon style={c.style} size={13} />
                </span>
              )}
              {w > 50 && <span className="seg-label">{name}</span>}
              <span className="edge right" />
            </div>
          )
        })}
        {titles.length === 0 && <span className="tl-empty">{orPress('Double-click to add a title card', keymap.addTitle)}</span>}
      </div>
    </div>
  )
}

/** Its row label in the timeline's label column (the track is always shown). */
export function TitleTrackLabel(): JSX.Element {
  return (
    <div className="tl-label title-label" title="Title cards and chapters">
      <TitleStyleIcon style="centered" size={16} />
    </div>
  )
}

/** A frame with the title where each style puts it. */
export function TitleStyleIcon({ style, size = 16 }: { style: TitleCardStyle; size?: number }): JSX.Element {
  const text = style === 'lower-third' ? 'M6 15.5h8M6 13h5' : style === 'big' ? 'M7 9.5h10M7 13h10' : 'M8 10.5h8M10 13.5h4'
  return (
    <svg width={size} height={size} viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="1.8" strokeLinecap="round" strokeLinejoin="round" aria-hidden="true" className="icon">
      <rect x="3" y="5" width="18" height="14" rx="2.5" />
      <path d={text} strokeWidth={style === 'big' ? 2.6 : 1.8} />
    </svg>
  )
}
