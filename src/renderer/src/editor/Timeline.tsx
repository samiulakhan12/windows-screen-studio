import { useRef, type PointerEvent as ReactPointerEvent } from 'react'
import { clamp } from '../../../shared/engine/math'
import { formatTime } from '../../../shared/engine/project'
import type { ClickEvent, Project } from '../../../shared/types'
import { Icon } from '../components/Icon'

interface Props {
  project: Project
  update: (fn: (p: Project) => Project) => void
  time: number
  onSeek: (t: number) => void
  clicks: ClickEvent[]
  selectedZoom: string | null
  setSelectedZoom: (id: string | null) => void
  onAddZoom: (t: number) => void
}

const MIN_ZOOM = 0.6
const MIN_CLIP = 0.5

function tickStep(duration: number): number {
  return [1, 2, 5, 10, 15, 30, 60, 120, 300].find((s) => duration / s <= 12) ?? 600
}

export function Timeline({ project, update, time, onSeek, clicks, selectedZoom, setSelectedZoom, onAddZoom }: Props): JSX.Element {
  const areaRef = useRef<HTMLDivElement>(null)
  const { duration, trim } = project
  const pct = (t: number): string => `${(clamp(t, 0, duration) / duration) * 100}%`

  const timeAt = (clientX: number): number => {
    const r = areaRef.current!.getBoundingClientRect()
    return clamp(((clientX - r.left) / r.width) * duration, 0, duration)
  }

  /** Pointer drag reporting the time delta (seconds) since the drag started. */
  const drag = (e: ReactPointerEvent, onMove: (dt: number, t: number) => void): void => {
    e.preventDefault()
    e.stopPropagation()
    const el = e.currentTarget as HTMLElement
    el.setPointerCapture(e.pointerId)
    const startX = e.clientX
    const width = areaRef.current!.getBoundingClientRect().width
    const move = (ev: PointerEvent): void => onMove(((ev.clientX - startX) / width) * duration, timeAt(ev.clientX))
    const up = (): void => {
      el.removeEventListener('pointermove', move)
      el.removeEventListener('pointerup', up)
      el.removeEventListener('pointercancel', up)
    }
    el.addEventListener('pointermove', move)
    el.addEventListener('pointerup', up)
    el.addEventListener('pointercancel', up)
  }

  const scrub = (e: ReactPointerEvent): void => {
    onSeek(timeAt(e.clientX))
    drag(e, (_dt, t) => onSeek(t))
  }

  const dragTrim = (edge: 'start' | 'end') => (e: ReactPointerEvent) => {
    const initial = { ...trim }
    drag(e, (dt) => {
      const next =
        edge === 'start'
          ? { start: clamp(initial.start + dt, 0, initial.end - MIN_CLIP), end: initial.end }
          : { start: initial.start, end: clamp(initial.end + dt, initial.start + MIN_CLIP, duration) }
      update((p) => ({ ...p, trim: next }))
      onSeek(edge === 'start' ? next.start : next.end)
    })
  }

  const dragZoom = (id: string, mode: 'move' | 'start' | 'end') => (e: ReactPointerEvent) => {
    setSelectedZoom(id)
    const seg = project.zooms.find((z) => z.id === id)
    if (!seg) return
    const others = project.zooms.filter((z) => z.id !== id)
    const lower = Math.max(0, ...others.filter((z) => z.end <= seg.start + 1e-6).map((z) => z.end))
    const upper = Math.min(duration, ...others.filter((z) => z.start >= seg.end - 1e-6).map((z) => z.start))
    const initial = { start: seg.start, end: seg.end }
    drag(e, (dt) => {
      let { start, end } = initial
      if (mode === 'move') {
        const len = end - start
        start = clamp(start + dt, lower, upper - len)
        end = start + len
      } else if (mode === 'start') {
        start = clamp(start + dt, lower, end - MIN_ZOOM)
      } else {
        end = clamp(end + dt, start + MIN_ZOOM, upper)
      }
      update((p) => ({ ...p, zooms: p.zooms.map((z) => (z.id === id ? { ...z, start, end, auto: false } : z)) }))
    })
  }

  const step = tickStep(duration)
  const ticks = Array.from({ length: Math.floor(duration / step) + 1 }, (_, i) => i * step)

  return (
    <div className="timeline">
      <div className="tl-labels">
        <div className="tl-label ruler-label" />
        <div className="tl-label" title="Clip">
          <Icon name="film" size={16} />
        </div>
        <div className="tl-label" title="Zoom">
          <Icon name="zoom" size={16} />
        </div>
      </div>
      <div className="tl-area" ref={areaRef}>
        <div className="tl-ruler" onPointerDown={scrub}>
          {ticks.map((t) => (
            <span key={t} className="tick" style={{ left: pct(t) }}>
              {formatTime(t, false)}
            </span>
          ))}
        </div>

        <div className="tl-track">
          <div className="clip-bar" />
          <div className="trim-shade" style={{ left: 0, width: pct(trim.start) }} />
          <div className="trim-shade" style={{ left: pct(trim.end), right: 0 }} />
          <div className="trim-window" style={{ left: pct(trim.start), width: `calc(${pct(trim.end)} - ${pct(trim.start)})` }}>
            <div className="trim-handle start" onPointerDown={dragTrim('start')} title="Trim start" />
            <div className="trim-handle end" onPointerDown={dragTrim('end')} title="Trim end" />
          </div>
          {clicks
            .filter((c) => c.button === 'left')
            .map((c, i) => (
              <span key={i} className="click-marker" style={{ left: pct(c.t) }} />
            ))}
        </div>

        <div
          className="tl-track zoom-track"
          onDoubleClick={(e) => onAddZoom(timeAt(e.clientX) + 0.7)}
          onPointerDown={(e) => {
            if (e.target === e.currentTarget) setSelectedZoom(null)
          }}
          title="Double-click to add a zoom"
        >
          {project.zooms.map((z) => (
            <div
              key={z.id}
              className={`zoom-seg ${selectedZoom === z.id ? 'selected' : ''}`}
              style={{ left: pct(z.start), width: `calc(${pct(z.end)} - ${pct(z.start)})` }}
              onPointerDown={dragZoom(z.id, 'move')}
            >
              <span className="edge left" onPointerDown={dragZoom(z.id, 'start')} />
              <span className="zoom-label">
                <Icon name="zoom" size={12} /> {z.scale.toFixed(1)}×{z.focus.mode === 'fixed' ? ' · fixed' : ''}
              </span>
              <span className="edge right" onPointerDown={dragZoom(z.id, 'end')} />
            </div>
          ))}
          {project.zooms.length === 0 && <span className="tl-empty">Double-click to add a zoom, or press Z</span>}
        </div>

        <div className="playhead" style={{ left: pct(time) }} onPointerDown={scrub} />
      </div>
    </div>
  )
}
