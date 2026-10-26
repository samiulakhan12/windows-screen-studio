import { CaptionTrack, CaptionTrackLabel } from './CaptionTrack'
import { ClipWaveform, useWaveformHint } from './ClipWaveform'
import { LayoutTrack, LayoutTrackLabel } from './LayoutTrack'
import { TitleTrack, TitleTrackLabel } from './TitleTrack'
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
  useSyncExternalStore,
  type PointerEvent as ReactPointerEvent
} from 'react'
import { annotationLanes, dragAnnotationTimes } from '../../../shared/editor/annotations'
import { timelineGaps, type Gap } from '../../../shared/editor/clips'
import { dragShapeTimes, isPrivacyKind, itemLanes, shapeLabel } from '../../../shared/editor/shapes'
import { sameClips, sameSpan, SNAP } from '../../../shared/editor/snapping'
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
import { orPress, shortcutLabel, withShortcut } from '../../../shared/editor/shortcuts'
import { cropOf, zoomInView } from '../../../shared/engine/crop'
import { clamp } from '../../../shared/engine/math'
import { formatTime } from '../../../shared/engine/project'
import { keptBounds, MIN_CLIP, setTrimEnd, setTrimStart } from '../../../shared/engine/timeline'
import { DEFAULT_ZOOM_STYLE, dragZoomTimes, zoomDragBounds, zoomSettingsOf, zoomTargetScale, zoomTimings, type ZoomStyle } from '../../../shared/engine/zoom'
import { formatLevel } from '../../../shared/editor/zoomEdit'
import type { ClickRow } from '../../../shared/engine/inputData'
import type { ScrollSession } from '../../../shared/engine/scroll'
import type { Annotation, Clip, CursorTrack, Shape, ShapeKind, Spotlight, ZoomSegment } from '../../../shared/types'
import { Icon } from '../components/Icon'
import { useEditor } from './context'
import { EditorIcon } from './EditorIcon'
import { releaseFocus } from './focus'
import { FreezeMarks } from './FreezeMarks'
import { useKeymap } from './keymapContext'
import { addShapeAt, revealItem } from './playheadItems'
import { followPointer } from './pointer'
import { clickState, clickTooltip, type Selection } from './selection'
import { ShapeIcon } from './shapeIcons'
import { useSnapController, type SnapGuideHandle } from './snapControl'
import { SnapButton, SnapGuide } from './SnapGuide'
import './shapes.css'
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
  /** Every recorded in-video click with its ignore state: selectable markers on the clip track. */
  clickRows: ClickRow[]
  /** Straightened cursor moves: thin bars along the bottom of the clip track. */
  pathBars?: readonly { t0: number; t1: number }[]
  /** Long scrolls auto zoom zooms out for: faint bands on the zoom track. */
  scrollBands?: readonly ScrollSession[]
  /** Selects a click (and shows it on the preview). */
  onSelectClick: (ms: number) => void
  /** The recording's cursor: an arrow added on the shapes track points at it. */
  cursor?: CursorTrack
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

const NO_SHAPES: Shape[] = []
const NO_SPOTLIGHTS: Spotlight[] = []

/** A shape or spotlight as the shapes track shows it. */
interface TrackItem {
  type: 'shape' | 'spotlight'
  id: string
  start: number
  end: number
  label: string
  icon: Parameters<typeof ShapeIcon>[0]['name']
  /** Look of its block: annotation shapes, privacy shapes or spotlights. */
  look: 'mark' | 'privacy' | 'spotlight'
  /** What fades it in and out (the playhead is put past that to show the item). */
  kind: ShapeKind | 'spotlight'
}

function trackItems(shapes: Shape[], spotlights: Spotlight[]): TrackItem[] {
  return [
    ...shapes.map((s): TrackItem => ({
      type: 'shape',
      id: s.id,
      start: s.start,
      end: s.end,
      label: shapeLabel(s.kind),
      icon: s.kind,
      look: isPrivacyKind(s.kind) ? 'privacy' : 'mark',
      kind: s.kind
    })),
    ...spotlights.map((s): TrackItem => ({
      type: 'spotlight',
      id: s.id,
      start: s.start,
      end: s.end,
      label: s.mode === 'cursor' ? 'Cursor spotlight' : 'Spotlight',
      icon: s.mode === 'cursor' ? 'spotlight-cursor' : 'spotlight-region',
      look: 'spotlight',
      kind: 'spotlight'
    }))
  ]
}

/**
 * Source-time timeline: ruler, kept clips with hatched cuts, zoom, text and shape tracks.
 * Horizontally zoomable (Ctrl+wheel, buttons) and scrollable; only items near the
 * visible window are rendered, and the playhead moves without re-rendering.
 */
export const Timeline = memo(
  forwardRef<TimelineHandle, Props>(function Timeline(props, ref) {
    const { duration, clips, zooms, annotations, clickRows, selection, onSelect } = props
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
    // Shapes and spotlights come straight from the store: only a change to them re-renders the timeline.
    const shapes = useSyncExternalStore(store.subscribe, () => store.state.shapes) ?? NO_SHAPES
    const spotlights = useSyncExternalStore(store.subscribe, () => store.state.spotlights) ?? NO_SPOTLIGHTS
    // Whether right clicks start auto zooms: what the click markers' tooltips promise.
    const rightClicks = useSyncExternalStore(store.subscribe, () => zoomSettingsOf(store.state).auto.rightClicks)
    // The crop: zoom levels are relative to the part of the recording that is shown.
    const crop = useSyncExternalStore(store.subscribe, () => store.state.crop)

    const fit = fitScale(viewport - 2 * GUTTER, duration)
    const px = zoom.fit ? fit : clampScale(zoom.px, fit)
    const pxRef = useRef(px)
    pxRef.current = px
    const guideRef = useRef<SnapGuideHandle>(null)
    const snap = useSnapController({ pxRef, scrollerRef, clickRows, guideRef })
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
      // The press goes exactly where it is; moving on snaps (once past a small slop).
      const s = snap.begin(e, { noPlayhead: true, slopPx: SNAP.scrubSlopPx })
      track(e, (ev) => player.seek(s.at(ev, timeAt(ev.clientX))))
    }

    /* ---------- clip track ---------- */

    const gaps = useMemo(() => timelineGaps(clips, duration), [clips, duration])
    const range = draftRange ?? (selection?.kind === 'range' ? selection : null)

    const onClipTrackDown = (e: ReactPointerEvent): void => {
      if (e.button !== 0) return
      if (e.shiftKey || e.altKey) {
        // Shift+drag ranges snap, both ends; Alt+drag ranges never do.
        const s = e.shiftKey && !e.altKey ? snap.begin(e) : null
        const anchor = s ? s.at(e.nativeEvent, timeAt(e.clientX)) : timeAt(e.clientX)
        setDraftRange({ start: anchor, end: anchor })
        let last: Range = { start: anchor, end: anchor }
        track(
          e,
          (ev) => {
            const t = s ? s.at(ev, timeAt(ev.clientX)) : timeAt(ev.clientX)
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

    /** A click marker: selects the click (no scrub, no range); Shift+drag still selects a range. */
    const onClickMarkerDown = (row: ClickRow) => (e: ReactPointerEvent) => {
      if (e.button !== 0 || e.shiftKey || e.altKey) return
      e.preventDefault()
      e.stopPropagation()
      releaseFocus()
      props.onSelectClick(row.ms)
    }

    const onTrimDown = (edge: 'start' | 'end') => (e: ReactPointerEvent) => {
      if (e.button !== 0) return
      const initial = clips
      const from = edge === 'start' ? initial[0].start : initial[initial.length - 1].end
      const sx = e.clientX
      // Only targets the trim can reach; the playhead follows the trimmed edge, so it is none.
      const limit = edge === 'start' ? { min: 0, max: initial[initial.length - 1].end - MIN_CLIP } : { min: initial[0].start + MIN_CLIP, max: duration }
      const s = snap.begin(e, { exclude: [{ owner: `trim:${edge}` }], noPlayhead: true })
      store.beginGesture()
      track(
        e,
        (ev) => {
          const t = s.at(ev, from + (ev.clientX - sx) / pxRef.current, limit)
          const next = edge === 'start' ? setTrimStart(initial, t) : setTrimEnd(initial, t, duration)
          store.update((p) => (sameClips(p.clips, next) ? p : { ...p, clips: next }), `trim-${edge}`)
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
      const s = snap.begin(e, { exclude: [{ owner: `zoom:${z.id}` }] })
      store.beginGesture()
      track(
        e,
        (ev) => {
          const times = s.span(ev, initial, mode, (ev.clientX - sx) / pxRef.current, (d) => dragZoomTimes(initial, mode, d, bounds))
          store.update((p) => {
            const cur = p.zooms.find((x) => x.id === z.id)
            if (cur && !cur.auto && sameSpan(cur, times)) return p
            return { ...p, zooms: p.zooms.map((x) => (x.id === z.id ? { ...x, ...times, auto: false } : x)) }
          }, `zoom-drag:${z.id}`)
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
      const s = snap.begin(e, { exclude: [{ owner: `annotation:${a.id}` }] })
      store.beginGesture()
      track(
        e,
        (ev) => {
          const times = s.span(ev, initial, mode, (ev.clientX - sx) / pxRef.current, (d) => dragAnnotationTimes(initial, mode, d, duration))
          store.update((p) => (sameSpan(p.annotations.find((x) => x.id === a.id), times) ? p : { ...p, annotations: p.annotations.map((x) => (x.id === a.id ? { ...x, ...times } : x)) }), `annotation-drag:${a.id}`)
        },
        (moved) => {
          store.endGesture()
          // A plain click on a text item also moves the playhead into it, so it shows on the preview.
          if (!moved && (player.time < a.start || player.time >= a.end)) player.seek(a.start + Math.min(0.5, (a.end - a.start) / 2))
        },
        3
      )
    }

    const onShapeDown = (item: TrackItem) => (e: ReactPointerEvent) => {
      if (e.button !== 0) return
      onSelect({ kind: item.type, id: item.id })
      const mode = dragMode(e)
      const initial = { start: item.start, end: item.end }
      const sx = e.clientX
      const key = `${item.type}-drag:${item.id}`
      const s = snap.begin(e, { exclude: [{ owner: `${item.type}:${item.id}` }] })
      store.beginGesture()
      track(
        e,
        (ev) => {
          const times = s.span(ev, initial, mode, (ev.clientX - sx) / pxRef.current, (d) => dragShapeTimes(initial, mode, d, duration))
          if (item.type === 'shape') store.update((p) => (sameSpan(p.shapes?.find((x) => x.id === item.id), times) ? p : { ...p, shapes: (p.shapes ?? []).map((x) => (x.id === item.id ? { ...x, ...times } : x)) }), key)
          else store.update((p) => (sameSpan(p.spotlights?.find((x) => x.id === item.id), times) ? p : { ...p, spotlights: (p.spotlights ?? []).map((x) => (x.id === item.id ? { ...x, ...times } : x)) }), key)
        },
        (moved) => {
          store.endGesture()
          // A plain click also moves the playhead into the item, so it shows (and can be edited) on the preview.
          if (!moved) revealItem(player, clips, item, item.kind)
        },
        3
      )
    }

    /** Double-click on the shapes track: an arrow, fully shown at `t` (or as near it as the end allows). */
    const addArrowAt = (t: number): void => void addShapeAt({ store, player }, 'arrow', props.cursor ?? null, { at: t, onSelect })

    // A double-click on empty track space is two quick pointerdowns at the same spot.
    // Detected here, before the first click's scrub, rather than with dblclick.
    const lastDown = useRef({ at: 0, x: 0, kind: '' })
    const isSecondClick = (e: ReactPointerEvent, kind: string): boolean => {
      const d = lastDown.current
      const second = d.kind === kind && e.timeStamp - d.at < 450 && Math.abs(e.clientX - d.x) < 6
      lastDown.current = second ? { at: 0, x: 0, kind: '' } : { at: e.timeStamp, x: e.clientX, kind }
      return second
    }

    const onBackgroundDown = (kind: 'zoom' | 'text' | 'shape') => (e: ReactPointerEvent) => {
      if (e.button !== 0) return
      if (isSecondClick(e, kind)) {
        e.preventDefault()
        const t = timeAt(e.clientX)
        if (kind === 'zoom') props.onAddZoom(t)
        else if (kind === 'text') props.onAddText(t)
        else addArrowAt(t)
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
    const items = useMemo(() => trackItems(shapes, spotlights), [shapes, spotlights])
    const itemLaneMap = useMemo(() => itemLanes(items), [items])
    const visibleItems = items.filter((it) => overlaps(it, win) || it.id === selId)
    const itemLaneH = 100 / itemLaneMap.count
    const visibleClicks = clickRows.filter((r) => r.click.t >= win.start && r.click.t <= win.end)
    const selectedClick = selection?.kind === 'click' ? selection.ms : null
    const visibleBars = (props.pathBars ?? []).filter((m) => overlaps({ start: m.t0, end: m.t1 }, win))
    const visibleBands = (props.scrollBands ?? []).filter((b) => overlaps(b, win))
    const kept = keptBounds(clips)
    const laneH = 100 / lanes.count

    return (
      <div className="timeline">
        <div className="tl-head">
          <span className="tl-hint">
            Click a track to move the playhead · Shift+drag on the clip to select a range · Double-click a track to add · Hold Alt while dragging to place freely
          </span>
          <SnapButton />
          <div className="tl-zoom" role="group" aria-label="Timeline zoom">
            <button className="btn ghost icon-btn" onClick={() => setScale(px / ZOOM_STEP)} disabled={zoom.fit} title={withShortcut('Zoom out timeline', keymap.timelineZoomOut)} aria-label="Zoom out timeline">
              <EditorIcon name="minus" size={16} />
            </button>
            <button className="btn ghost icon-btn" onClick={() => setScale(px * ZOOM_STEP)} title={zoomInTitle(keymap.timelineZoomIn)} aria-label="Zoom in timeline">
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
            <div className="tl-label zoom-label" title="Zoom">
              <Icon name="zoom" size={16} />
            </div>
            <div className="tl-label text-label" title="Text">
              <EditorIcon name="text" size={16} />
            </div>
            <div className="tl-label shape-label" title="Shapes, blur and spotlights">
              <EditorIcon name="shapes" size={16} />
            </div>
            <TitleTrackLabel />
            <CaptionTrackLabel />
            <LayoutTrackLabel />
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

              <div className="tl-track clip-track" onPointerDown={onClipTrackDown} title={`Click to move the playhead, Shift+drag to select a range to cut${useWaveformHint()}`}>
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
                <ClipWaveform px={px} win={win} duration={duration} />
                {gaps.map((g) => (
                  <GapBlock
                    key={`${g.kind}:${g.start}`}
                    gap={g}
                    px={px}
                    selected={selection?.kind === 'gap' && Math.abs(selection.start - g.start) < 1e-6}
                    onRestore={props.onRestore}
                  />
                ))}
                {visibleBars.map((m) => (
                  <span
                    key={`path:${m.t0}`}
                    className="path-bar"
                    data-testid="path-bar"
                    data-start={m.t0}
                    data-end={m.t1}
                    style={{ left: m.t0 * px, width: Math.max(2, (m.t1 - m.t0) * px) }}
                  />
                ))}
                {visibleClicks.map((r, i) => {
                  const state = clickState(r)
                  return (
                    <span
                      key={`${r.ms}:${i}`}
                      className={`click-marker ${r.click.button === 'left' ? '' : 'minor'} ${selectedClick === r.ms ? 'selected' : ''}`}
                      data-click-ms={r.ms}
                      data-state={state}
                      data-button={r.click.button}
                      style={{ left: r.click.t * px }}
                      title={clickTooltip(r, keymap.deleteSelection, rightClicks)}
                      onPointerDown={onClickMarkerDown(r)}
                    />
                  )
                })}
                <FreezeMarks px={px} win={win} duration={duration} clips={clips} selection={selection} onSelect={onSelect} snap={snap} />
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
                {visibleBands.map((b) => (
                  <span
                    key={`scroll:${b.start}`}
                    className="scroll-band"
                    data-testid="scroll-band"
                    data-start={b.start}
                    data-end={b.end}
                    style={{ left: b.start * px, width: Math.max(2, (b.end - b.start) * px) }}
                    title={`Scrolling ${formatTime(b.start)} – ${formatTime(b.end)}: auto zoom shows the whole page while it moves`}
                  />
                ))}
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
                  const scale = zoomTargetScale(zoomInView(crop ? cropOf(store.state) : null, z))
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

              <div className="tl-track shape-track" onPointerDown={onBackgroundDown('shape')} title="Double-click to add an arrow" data-testid="shape-track">
                {visibleItems.map((it) => {
                  const w = (it.end - it.start) * px
                  const lane = itemLaneMap.lanes.get(it.id) ?? 0
                  return (
                    <div
                      key={it.id}
                      data-shape={it.type === 'shape' ? it.id : undefined}
                      data-spotlight={it.type === 'spotlight' ? it.id : undefined}
                      data-start={it.start}
                      data-end={it.end}
                      className={`seg shape-seg ${it.look} ${selId === it.id ? 'selected' : ''}`}
                      style={{ left: it.start * px, width: w, top: `${lane * itemLaneH}%`, height: `${itemLaneH}%`, ['--edge' as string]: `${edgeWidth(w)}px` }}
                      onPointerDown={onShapeDown(it)}
                      title={`${it.label} · ${formatTime(it.start)} – ${formatTime(it.end)}`}
                    >
                      <span className="edge left" />
                      {w > 22 && itemLaneMap.count <= 2 && (
                        <span className="seg-icon">
                          <ShapeIcon name={it.icon} size={13} />
                        </span>
                      )}
                      {w > 64 && <span className="seg-label">{it.label}</span>}
                      <span className="edge right" />
                    </div>
                  )
                })}
                {items.length === 0 && <span className="tl-empty">Double-click to add an arrow, or use the Shapes panel for boxes, blur and spotlights</span>}
              </div>

              <TitleTrack px={px} win={win} duration={duration} selection={selection} onSelect={onSelect} scrub={scrub} snap={snap} />
              <CaptionTrack px={px} win={win} duration={duration} selection={selection} onSelect={onSelect} scrub={scrub} snap={snap} />
              <LayoutTrack px={px} win={win} duration={duration} selection={selection} onSelect={onSelect} scrub={scrub} snap={snap} />

              <SnapGuide ref={guideRef} />
              <div className="playhead" ref={playheadRef} onPointerDown={(e) => e.button === 0 && scrub(e)} />
            </div>
          </div>
        </div>
      </div>
    )
  })
)

/** "Zoom in timeline (+ or Ctrl+wheel)" with the first key bound now (Ctrl+wheel always zooms). */
const zoomInTitle = (keys: readonly string[]): string => `Zoom in timeline (${keys.length ? `${shortcutLabel(keys[0])} or ` : ''}Ctrl+wheel)`

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
