import {
  forwardRef,
  memo,
  useCallback,
  useEffect,
  useImperativeHandle,
  useLayoutEffect,
  useMemo,
  useRef,
  useState,
  type PointerEvent as ReactPointerEvent
} from 'react'
import { annotationLanes, dragAnnotationTimes } from '../../../shared/editor/annotations'
import { timelineGaps, type Gap } from '../../../shared/editor/clips'
import {
  clampScale,
  fitScale,
  followScroll,
  formatTick,
  overlaps,
  renderWindow,
  scrollForZoom,
  tickStep,
  ticksIn,
  ZOOM_STEP
} from '../../../shared/editor/timelineScale'
import { orPress, withShortcut } from '../../../shared/editor/shortcuts'
import { clamp } from '../../../shared/engine/math'
import { formatTime } from '../../../shared/engine/project'
import { keptBounds, setTrimEnd, setTrimStart } from '../../../shared/engine/timeline'
import { DEFAULT_ZOOM_STYLE, dragZoomTimes, zoomDragBounds, zoomTargetScale, zoomTimings, type ZoomStyle } from '../../../shared/engine/zoom'
import { formatLevel } from '../../../shared/editor/zoomEdit'
import type { Annotation, ClickEvent, Clip, ZoomSegment } from '../../../shared/types'
import { Icon } from '../components/Icon'
import { useEditor } from './context'
import { EditorIcon } from './EditorIcon'
import { releaseFocus } from './focus'
import { useKeymap } from './keymapContext'
import { followPointer } from './pointer'
import type { Selection } from './selection'
import './zoom.css'

export interface TimelineHandle {
  zoomIn(): void
  zoomOut(): void
  fit(): void
}

interface Props {
  duration: number
  clips: Clip[]
  zooms: ZoomSegment[]
  /** Project zoom style: transitions and which zooms pan into the next one. */
  zoomStyle?: ZoomStyle
  annotations: Annotation[]
  clicks: ClickEvent[]
  selection: Selection
  onSelect: (sel: Selection) => void
  /** Double-click on the zoom track: a zoom starting at `t`. */
  onAddZoom: (t: number) => void
  onAddText: (t: number) => void
  onRestore: (start: number, end: number) => void
  onCutRange: (start: number, end: number) => void
}

type Zoom = { fit: true } | { fit: false; px: number }
type Range = { start: number; end: number }

/** Space before 0 s and after the end, so handles and the playhead at the edges stay fully visible (matches .tl-content padding). */
const GUTTER = 10

/** Grabbable edge width of a segment: never more than a quarter of it, so its middle always moves it. */
const edgeWidth = (w: number): number => Math.max(3, Math.min(8, w * 0.25))

/**
 * Source-time timeline: ruler, kept clips with hatched cuts, zoom and text tracks.
 * Horizontally zoomable (Ctrl+wheel, buttons) and scrollable; only items near the
 * visible window are rendered, and the playhead moves without re-rendering.
 */
export const Timeline = memo(
  forwardRef<TimelineHandle, Props>(function Timeline(props, ref) {
    const { duration, clips, zooms, annotations, clicks, selection, onSelect } = props
    const { store, player } = useEditor()
    const keymap = useKeymap()
    const scrollerRef = useRef<HTMLDivElement>(null)
    const contentRef = useRef<HTMLDivElement>(null)
    const playheadRef = useRef<HTMLDivElement>(null)
    const dragging = useRef(false)
    const [viewport, setViewport] = useState(0)
    const [zoom, setZoom] = useState<Zoom>({ fit: true })
    const [win, setWin] = useState<Range>({ start: 0, end: duration })
    const [draftRange, setDraftRange] = useState<Range | null>(null)
    const pendingScroll = useRef<number | null>(null)

    const fit = fitScale(viewport - 2 * GUTTER, duration)
    const px = zoom.fit ? fit : clampScale(zoom.px, fit)
    const pxRef = useRef(px)
    pxRef.current = px
    const width = Math.max(viewport, duration * px + 2 * GUTTER)

    /* ---------- viewport, scroll and render window ---------- */

    useLayoutEffect(() => {
      const el = scrollerRef.current
      if (!el) return
      const measure = (): void => setViewport(el.clientWidth)
      measure()
      const ro = new ResizeObserver(measure)
      ro.observe(el)
      return () => ro.disconnect()
    }, [])

    const updateWindow = useCallback(() => {
      const el = scrollerRef.current
      if (!el || viewport === 0) return
      const want = renderWindow(el.scrollLeft, viewport, pxRef.current, duration)
      const visible = { start: el.scrollLeft / pxRef.current, end: (el.scrollLeft + viewport) / pxRef.current }
      setWin((cur) => {
        // Re-render only when the visible part gets close to the edge of what is rendered.
        const margin = (viewport * 0.5) / pxRef.current
        const covered = cur.start <= Math.max(0, visible.start - margin) && cur.end >= Math.min(duration, visible.end + margin)
        return covered && cur.end - cur.start <= (want.end - want.start) * 2 + 1e-6 ? cur : want
      })
    }, [viewport, duration])

    const lastTime = useRef(-1)
    const placePlayhead = useCallback(
      (follow: boolean) => {
        const x = player.time * pxRef.current
        if (playheadRef.current) playheadRef.current.style.transform = `translateX(${x}px)`
        const el = scrollerRef.current
        if (!follow || !el || dragging.current) return
        const next = followScroll(x + GUTTER, el.scrollLeft, el.clientWidth)
        if (next !== null) el.scrollLeft = next
      },
      [player]
    )

    useEffect(() => {
      const onPlayer = (): void => {
        // Follow only real playhead movement, not unrelated notifications.
        const moved = player.time !== lastTime.current
        lastTime.current = player.time
        placePlayhead(moved)
      }
      onPlayer()
      return player.subscribe(onPlayer)
    }, [player, placePlayhead])

    useLayoutEffect(() => {
      const el = scrollerRef.current
      if (el && pendingScroll.current !== null) {
        el.scrollLeft = pendingScroll.current
        pendingScroll.current = null
      }
      placePlayhead(false)
      updateWindow()
    }, [px, viewport, updateWindow, placePlayhead])

    useEffect(() => {
      const el = scrollerRef.current
      if (!el) return
      let raf = 0
      const onScroll = (): void => {
        if (raf) return
        raf = requestAnimationFrame(() => {
          raf = 0
          updateWindow()
        })
      }
      el.addEventListener('scroll', onScroll, { passive: true })
      return () => {
        el.removeEventListener('scroll', onScroll)
        cancelAnimationFrame(raf)
      }
    }, [updateWindow])

    /* ---------- zooming the timeline ---------- */

    const setScale = useCallback(
      (next: number, anchorX?: number) => {
        const el = scrollerRef.current
        if (!el) return
        const target = clampScale(next, fit)
        const anchor = anchorX ?? (() => {
          // Zoom around the playhead when it is visible, else around the middle.
          const x = player.time * pxRef.current + GUTTER - el.scrollLeft
          return x >= 0 && x <= el.clientWidth ? x : el.clientWidth / 2
        })()
        pendingScroll.current = scrollForZoom(pxRef.current, target, el.scrollLeft, anchor - GUTTER)
        setZoom(target <= fit * 1.0001 ? { fit: true } : { fit: false, px: target })
      },
      [fit, player]
    )

    const fitAll = useCallback(() => {
      pendingScroll.current = 0
      setZoom({ fit: true })
    }, [])

    useImperativeHandle(
      ref,
      () => ({
        zoomIn: () => setScale(pxRef.current * ZOOM_STEP),
        zoomOut: () => setScale(pxRef.current / ZOOM_STEP),
        fit: fitAll
      }),
      [setScale, fitAll]
    )

    useEffect(() => {
      const el = scrollerRef.current
      if (!el) return
      const onWheel = (e: WheelEvent): void => {
        if (e.ctrlKey || e.metaKey) {
          e.preventDefault()
          const r = el.getBoundingClientRect()
          setScale(pxRef.current * Math.exp(-e.deltaY * 0.002), e.clientX - r.left)
        } else if (Math.abs(e.deltaX) < Math.abs(e.deltaY) && el.scrollWidth > el.clientWidth) {
          // A plain mouse wheel scrolls the timeline sideways.
          e.preventDefault()
          el.scrollLeft += e.deltaY
        }
      }
      el.addEventListener('wheel', onWheel, { passive: false })
      return () => el.removeEventListener('wheel', onWheel)
    }, [setScale])

    /* ---------- pointer helpers ---------- */

    const timeAt = useCallback(
      (clientX: number): number => {
        const r = contentRef.current!.getBoundingClientRect()
        return clamp((clientX - r.left - GUTTER) / pxRef.current, 0, duration)
      },
      [duration]
    )

    /** Follows a pointer drag; `onMove` runs once the pointer moved more than `slop` px. */
    const track = (
      e: ReactPointerEvent,
      onMove: (ev: PointerEvent) => void,
      onEnd?: (moved: boolean) => void,
      slop = 0
    ): void => {
      e.preventDefault()
      e.stopPropagation()
      releaseFocus()
      dragging.current = true
      const sx = e.clientX
      let moved = false
      followPointer(
        e,
        (ev) => {
          if (!moved && Math.abs(ev.clientX - sx) <= slop) return
          moved = true
          onMove(ev)
        },
        () => {
          dragging.current = false
          onEnd?.(moved)
        }
      )
    }

    const scrub = (e: ReactPointerEvent): void => {
      player.seek(timeAt(e.clientX))
      track(e, (ev) => player.seek(timeAt(ev.clientX)))
    }

    /* ---------- clip track ---------- */

    const gaps = useMemo(() => timelineGaps(clips, duration), [clips, duration])
    const range = draftRange ?? (selection?.kind === 'range' ? selection : null)

    const onClipTrackDown = (e: ReactPointerEvent): void => {
      if (e.button !== 0) return
      if (e.shiftKey || e.altKey) {
        const anchor = timeAt(e.clientX)
        setDraftRange({ start: anchor, end: anchor })
        let last: Range = { start: anchor, end: anchor }
        track(
          e,
          (ev) => {
            const t = timeAt(ev.clientX)
            last = { start: Math.min(anchor, t), end: Math.max(anchor, t) }
            setDraftRange(last)
          },
          () => {
            setDraftRange(null)
            onSelect(last.end - last.start > 0.05 ? { kind: 'range', ...last } : null)
          }
        )
        return
      }
      const target = e.target as HTMLElement
      const clipEl = target.closest<HTMLElement>('[data-clip]')
      const gapEl = target.closest<HTMLElement>('[data-gap-start]')
      if (clipEl) onSelect({ kind: 'clip', id: clipEl.dataset.clip! })
      else if (gapEl) onSelect({ kind: 'gap', start: Number(gapEl.dataset.gapStart), end: Number(gapEl.dataset.gapEnd) })
      else onSelect(null)
      scrub(e)
    }

    const onTrimDown = (edge: 'start' | 'end') => (e: ReactPointerEvent) => {
      if (e.button !== 0) return
      const initial = clips
      const from = edge === 'start' ? initial[0].start : initial[initial.length - 1].end
      const sx = e.clientX
      store.beginGesture()
      track(
        e,
        (ev) => {
          const dt = (ev.clientX - sx) / pxRef.current
          const next = edge === 'start' ? setTrimStart(initial, from + dt) : setTrimEnd(initial, from + dt, duration)
          store.update((p) => ({ ...p, clips: next }), `trim-${edge}`)
          const b = keptBounds(next)
          player.seek(edge === 'start' ? b.start : b.end)
        },
        () => store.endGesture()
      )
    }

    /* ---------- zoom and text segments ---------- */

    const dragMode = (e: ReactPointerEvent): 'move' | 'start' | 'end' => {
      const r = (e.currentTarget as HTMLElement).getBoundingClientRect()
      const edge = edgeWidth(r.width)
      if (e.clientX - r.left < edge) return 'start'
      if (r.right - e.clientX < edge) return 'end'
      return 'move'
    }

    const onZoomDown = (z: ZoomSegment) => (e: ReactPointerEvent) => {
      if (e.button !== 0) return
      onSelect({ kind: 'zoom', id: z.id })
      const mode = dragMode(e)
      const bounds = zoomDragBounds(zooms, z.id, duration)
      const initial = { start: z.start, end: z.end }
      const sx = e.clientX
      store.beginGesture()
      track(
        e,
        (ev) => {
          const times = dragZoomTimes(initial, mode, (ev.clientX - sx) / pxRef.current, bounds)
          store.update((p) => ({ ...p, zooms: p.zooms.map((x) => (x.id === z.id ? { ...x, ...times, auto: false } : x)) }), `zoom-drag:${z.id}`)
        },
        () => store.endGesture(),
        3
      )
    }

    const onAnnotationDown = (a: Annotation) => (e: ReactPointerEvent) => {
      if (e.button !== 0) return
      onSelect({ kind: 'annotation', id: a.id })
      const mode = dragMode(e)
      const initial = { start: a.start, end: a.end }
      const sx = e.clientX
      store.beginGesture()
      track(
        e,
        (ev) => {
          const times = dragAnnotationTimes(initial, mode, (ev.clientX - sx) / pxRef.current, duration)
          store.update((p) => ({ ...p, annotations: p.annotations.map((x) => (x.id === a.id ? { ...x, ...times } : x)) }), `annotation-drag:${a.id}`)
        },
        (moved) => {
          store.endGesture()
          // A plain click on a text item also moves the playhead into it, so it shows on the preview.
          if (!moved && (player.time < a.start || player.time >= a.end)) player.seek(a.start + Math.min(0.5, (a.end - a.start) / 2))
        },
        3
      )
    }

    // A double-click on empty track space is two quick pointerdowns at the same spot.
    // Detected here, before the first click's scrub, rather than with dblclick.
    const lastDown = useRef({ at: 0, x: 0, kind: '' })
    const isSecondClick = (e: ReactPointerEvent, kind: string): boolean => {
      const d = lastDown.current
      const second = d.kind === kind && e.timeStamp - d.at < 450 && Math.abs(e.clientX - d.x) < 6
      lastDown.current = second ? { at: 0, x: 0, kind: '' } : { at: e.timeStamp, x: e.clientX, kind }
      return second
    }

    const onBackgroundDown = (kind: 'zoom' | 'text') => (e: ReactPointerEvent) => {
      if (e.button !== 0) return
      if (isSecondClick(e, kind)) {
        e.preventDefault()
        const t = timeAt(e.clientX)
        if (kind === 'zoom') props.onAddZoom(t)
        else props.onAddText(t)
        return
      }
      onSelect(null)
      scrub(e)
    }

    /* ---------- render ---------- */

    const step = tickStep(px)
    const ticks = ticksIn(win.start, win.end, step)
    const selId = selection && 'id' in selection ? selection.id : null
    // The selected item stays mounted even when scrolled away, so a drag in progress keeps its element.
    const visibleZooms = zooms.filter((z) => overlaps(z, win) || z.id === selId)
    const zoomStyle = props.zoomStyle ?? DEFAULT_ZOOM_STYLE
    const timings = useMemo(() => zoomTimings(zooms, zoomStyle), [zooms, zoomStyle])
    // Pairs of zooms the camera pans between without zooming out: drawn joined, with a link.
    const links = useMemo(() => {
      const sorted = [...zooms].sort((a, b) => a.start - b.start)
      const out: { from: ZoomSegment; to: ZoomSegment }[] = []
      for (let i = 0; i + 1 < sorted.length; i++) if (timings.get(sorted[i].id)?.toNext) out.push({ from: sorted[i], to: sorted[i + 1] })
      return out
    }, [zooms, timings])
    const lanes = useMemo(() => annotationLanes(annotations), [annotations])
    const visibleAnnotations = annotations.filter((a) => overlaps(a, win) || a.id === selId)
    const visibleClicks = clicks.filter((c) => c.t >= win.start && c.t <= win.end)
    const kept = keptBounds(clips)
    const laneH = 100 / lanes.count

    return (
      <div className="timeline">
        <div className="tl-head">
          <span className="tl-hint">
            Click a track to move the playhead · Shift+drag on the clip to select a range · Double-click a track to add
          </span>
          <div className="tl-zoom" role="group" aria-label="Timeline zoom">
            <button className="btn ghost icon-btn" onClick={() => setScale(px / ZOOM_STEP)} disabled={zoom.fit} title="Zoom out timeline (-)" aria-label="Zoom out timeline">
              <EditorIcon name="minus" size={16} />
            </button>
            <button className="btn ghost icon-btn" onClick={() => setScale(px * ZOOM_STEP)} title="Zoom in timeline (+ or Ctrl+wheel)" aria-label="Zoom in timeline">
              <EditorIcon name="plus" size={16} />
            </button>
            <button className="btn ghost" onClick={fitAll} disabled={zoom.fit} title="Fit the whole recording">
              <EditorIcon name="fit" size={14} /> Fit
            </button>
          </div>
        </div>
        <div className="tl-body">
          <div className="tl-labels">
            <div className="tl-label ruler-label" />
            <div className="tl-label clip-label" title="Clip: cut, split and speed">
              <Icon name="film" size={16} />
            </div>
            <div className="tl-label" title="Zoom">
              <Icon name="zoom" size={16} />
            </div>
            <div className="tl-label" title="Text">
              <EditorIcon name="text" size={16} />
            </div>
          </div>
          <div className="tl-scroller" ref={scrollerRef} data-testid="timeline-scroller">
            <div className="tl-content" ref={contentRef} style={{ width }} data-px-per-sec={px}>
              <div className="tl-ruler" onPointerDown={(e) => e.button === 0 && scrub(e)}>
                {ticks.map((t) => (
                  <span key={t} className="tick" style={{ left: t * px }}>
                    {formatTick(t, step)}
                  </span>
                ))}
              </div>

              <div className="tl-track clip-track" onPointerDown={onClipTrackDown} title="Click to move the playhead, Shift+drag to select a range to cut">
                {clips
                  .filter((c) => overlaps(c, win))
                  .map((c) => {
                    const w = (c.end - c.start) * px
                    return (
                      <div
                        key={c.id}
                        data-clip={c.id}
                        data-start={c.start}
                        data-end={c.end}
                        data-speed={c.speed}
                        className={`clip-block ${selId === c.id ? 'selected' : ''} ${c.speed !== 1 ? 'fast' : ''}`}
                        style={{ left: c.start * px, width: w }}
                      >
                        {c.speed !== 1 && w > 28 && <span className="speed-badge">{+c.speed.toFixed(2)}×</span>}
                      </div>
                    )
                  })}
                {gaps.map((g) => (
                  <GapBlock
                    key={`${g.kind}:${g.start}`}
                    gap={g}
                    px={px}
                    selected={selection?.kind === 'gap' && Math.abs(selection.start - g.start) < 1e-6}
                    onRestore={props.onRestore}
                  />
                ))}
                {visibleClicks.map((c, i) => (
                  <span key={i} className="click-marker" style={{ left: c.t * px }} />
                ))}
                <div className="trim-handle start" style={{ left: kept.start * px }} onPointerDown={onTrimDown('start')} title="Drag to trim the start" />
                <div className="trim-handle end" style={{ left: kept.end * px }} onPointerDown={onTrimDown('end')} title="Drag to trim the end" />
                {range && (
                  <div className="range-sel" style={{ left: range.start * px, width: (range.end - range.start) * px }} data-testid="range-selection">
                    {!draftRange && (range.end - range.start) * px > 64 && (
                      <button
                        className="range-cut"
                        onPointerDown={(e) => e.stopPropagation()}
                        onClick={() => props.onCutRange(range.start, range.end)}
                        title={withShortcut('Cut the selected range', keymap.deleteSelection)}
                      >
                        <EditorIcon name="scissors" size={13} /> Cut
                      </button>
                    )}
                  </div>
                )}
              </div>

              <div className="tl-track zoom-track" onPointerDown={onBackgroundDown('zoom')} title="Double-click to add a zoom">
                {links
                  .filter((l) => overlaps({ start: l.from.end - 1, end: l.to.start + 1 }, win))
                  .map(({ from, to }) => (
                    <div
                      key={`link:${from.id}`}
                      className="zoom-link"
                      data-zoom-link={`${from.id}>${to.id}`}
                      style={{ left: Math.min(from.end, to.start) * px, width: Math.max(0, to.start - from.end) * px }}
                      title="The camera pans from this zoom straight into the next one"
                    >
                      <PanIcon />
                    </div>
                  ))}
                {visibleZooms.map((z) => {
                  const w = (z.end - z.start) * px
                  const scale = zoomTargetScale(z)
                  const tm = timings.get(z.id)
                  const kind = z.focus.mode === 'region' ? ' · region' : z.focus.mode === 'fixed' ? ' · fixed' : ''
                  return (
                    <div
                      key={z.id}
                      data-zoom={z.id}
                      data-start={z.start}
                      data-end={z.end}
                      data-scale={scale}
                      data-linked-next={tm?.toNext ? 'true' : undefined}
                      data-linked-prev={tm?.fromPrev ? 'true' : undefined}
                      className={`seg zoom-seg ${selId === z.id ? 'selected' : ''} ${z.auto ? 'auto' : ''} ${scale < 1 ? 'pullback' : ''} ${tm?.toNext ? 'linked-next' : ''} ${tm?.fromPrev ? 'linked-prev' : ''}`}
                      style={{ left: z.start * px, width: w, ['--edge' as string]: `${edgeWidth(w)}px` }}
                      onPointerDown={onZoomDown(z)}
                      title={`${formatTime(z.start)} – ${formatTime(z.end)} · ${formatLevel(scale)}${scale < 1 ? ' pull back' : ''} · ${z.auto ? 'automatic' : 'edited'} zoom${tm?.toNext ? ' · pans to the next zoom' : ''}`}
                    >
                      {tm && w > 24 && (
                        <>
                          <span className={`zoom-ramp in ${tm.fromPrev ? 'pan' : ''}`} style={{ width: Math.min(w / 2, tm.tin * px) }} />
                          {tm.tout > 0 && <span className="zoom-ramp out" style={{ width: Math.min(w / 2, tm.tout * px) }} />}
                        </>
                      )}
                      <span className="edge left" />
                      {w > 34 && (
                        <span className="seg-label">
                          {formatLevel(scale)}
                          {w > 70 ? kind : ''}
                          {z.auto && w > 110 ? ' · auto' : ''}
                        </span>
                      )}
                      <span className="edge right" />
                    </div>
                  )
                })}
                {zooms.length === 0 && <span className="tl-empty">{orPress('Double-click to add a zoom', keymap.addZoom)}</span>}
              </div>

              <div className="tl-track text-track" onPointerDown={onBackgroundDown('text')} title="Double-click to add text">
                {visibleAnnotations.map((a) => {
                  const w = (a.end - a.start) * px
                  const lane = lanes.lanes.get(a.id) ?? 0
                  return (
                    <div
                      key={a.id}
                      data-annotation={a.id}
                      data-start={a.start}
                      data-end={a.end}
                      className={`seg text-seg ${selId === a.id ? 'selected' : ''}`}
                      style={{ left: a.start * px, width: w, top: `${lane * laneH}%`, height: `${laneH}%`, ['--edge' as string]: `${edgeWidth(w)}px` }}
                      onPointerDown={onAnnotationDown(a)}
                      title={a.text}
                    >
                      <span className="edge left" />
                      {w > 30 && <span className="seg-label">{a.text || 'Text'}</span>}
                      <span className="edge right" />
                    </div>
                  )
                })}
                {annotations.length === 0 && <span className="tl-empty">{orPress('Double-click to add text', keymap.addText)}</span>}
              </div>

              <div className="playhead" ref={playheadRef} onPointerDown={(e) => e.button === 0 && scrub(e)} />
            </div>
          </div>
        </div>
      </div>
    )
  })
)

/** Arrow between two linked zooms: the camera pans across. */
function PanIcon(): JSX.Element {
  return (
    <svg width={12} height={12} viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2.4" strokeLinecap="round" strokeLinejoin="round" aria-hidden="true">
      <path d="M4 12h15M14 6l6 6-6 6" />
    </svg>
  )
}

const GapBlock = memo(function GapBlock({
  gap,
  px,
  selected,
  onRestore
}: {
  gap: Gap
  px: number
  selected: boolean
  onRestore: (start: number, end: number) => void
}): JSX.Element {
  const w = (gap.end - gap.start) * px
  const label = gap.kind === 'cut' ? 'Cut' : 'Trimmed'
  return (
    <div
      className={`gap-block ${gap.kind} ${selected ? 'selected' : ''}`}
      data-gap-start={gap.start}
      data-gap-end={gap.end}
      style={{ left: gap.start * px, width: w }}
      title={`${label}: ${formatTime(gap.start)} – ${formatTime(gap.end)} (${(gap.end - gap.start).toFixed(1)} s not in the video)`}
    >
      {gap.kind === 'cut' && w >= 22 && (
        <button
          className="gap-restore"
          aria-label="Restore this cut"
          title="Restore this cut"
          onPointerDown={(e) => e.stopPropagation()}
          onClick={() => onRestore(gap.start, gap.end)}
        >
          <EditorIcon name="restore" size={12} />
        </button>
      )}
    </div>
  )
})
