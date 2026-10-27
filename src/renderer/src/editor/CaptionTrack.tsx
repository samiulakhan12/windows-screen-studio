import { useRef, useSyncExternalStore, type PointerEvent as ReactPointerEvent } from 'react'
import { captionDragBounds, dragCaptionTimes, retimeWords } from '../../../shared/captions/edit'
import { sameSpan } from '../../../shared/editor/snapping'
import { overlaps } from '../../../shared/editor/timelineScale'
import { formatTime } from '../../../shared/engine/project'
import type { CaptionSegment } from '../../../shared/types'
import { requestCaptions, showCaption } from './captionItems'
import { useEditor } from './context'
import { EditorIcon } from './EditorIcon'
import { releaseFocus } from './focus'
import type { TrackSlotProps } from './LayoutTrack'
import { followPointer } from './pointer'
import './captions.css'

const NO_CAPTIONS: CaptionSegment[] = []

/** Grabbable edge width of a block: never more than a quarter of it, so its middle always moves it (as on the other tracks). */
const edgeWidth = (w: number): number => Math.max(3, Math.min(8, w * 0.25))

/** The transcript's captions, straight from the store (only a change to them re-renders the track). */
const useCaptions = (): CaptionSegment[] => {
  const { store } = useEditor()
  return useSyncExternalStore(store.subscribe, () => store.state.transcript?.segments) ?? NO_CAPTIONS
}

/**
 * Timeline track of the transcript's captions (shown once the recording has a transcript): a
 * block per caption labelled with its text. A click selects it (the Captions tab shows it) and
 * moves the playhead into it, a drag moves it, the edges trim it (never over its neighbours),
 * and a double-click puts the cursor in its text in the Captions tab.
 */
export function CaptionTrack({ px, win, duration, selection, onSelect, scrub, snap }: TrackSlotProps): JSX.Element | null {
  const { store, player } = useEditor()
  const captions = useCaptions()
  const shown = useSyncExternalStore(store.subscribe, () => store.state.captions?.show !== false)
  const lastDown = useRef({ at: 0, x: 0, id: '' })
  if (!store.state.transcript) return null

  const onBackgroundDown = (e: ReactPointerEvent): void => {
    if (e.button !== 0) return
    onSelect(null)
    scrub(e)
  }

  const onCaptionDown = (seg: CaptionSegment) => (e: ReactPointerEvent<HTMLElement>) => {
    if (e.button !== 0) return
    e.preventDefault()
    e.stopPropagation()
    releaseFocus()
    onSelect({ kind: 'caption', id: seg.id })
    // A double-click is two quick pointerdowns on the same caption (as on the other tracks).
    const d = lastDown.current
    const second = d.id === seg.id && e.timeStamp - d.at < 450 && Math.abs(e.clientX - d.x) < 6
    lastDown.current = second ? { at: 0, x: 0, id: '' } : { at: e.timeStamp, x: e.clientX, id: seg.id }
    if (second) {
      requestCaptions({ kind: 'focus', id: seg.id })
      return
    }
    const r = e.currentTarget.getBoundingClientRect()
    const edge = edgeWidth(r.width)
    const mode = e.clientX - r.left < edge ? 'start' : r.right - e.clientX < edge ? 'end' : 'move'
    const bounds = captionDragBounds(store.state.transcript?.segments ?? [], seg.id, duration)
    const initial = { start: seg.start, end: seg.end }
    const sx = e.clientX
    let moved = false
    const s = snap.begin(e, { exclude: [{ owner: `caption:${seg.id}` }] })
    store.beginGesture()
    followPointer(
      e,
      (ev) => {
        if (!moved && Math.abs(ev.clientX - sx) <= 3) return
        moved = true
        const times = s.span(ev, initial, mode, (ev.clientX - sx) / px, (d) => dragCaptionTimes(initial, mode, d, bounds))
        store.update(
          (p) =>
            p.transcript && !sameSpan(p.transcript.segments.find((x) => x.id === seg.id), times)
              ? { ...p, transcript: { ...p.transcript, segments: p.transcript.segments.map((x) => (x.id === seg.id ? retimeWords(seg, times) : x)) } }
              : p,
          `caption-drag:${seg.id}`
        )
      },
      () => {
        store.endGesture()
        // A plain click moves the playhead into the caption, so it shows on the preview.
        if (!moved) {
          const list = store.state.transcript?.segments ?? []
          showCaption(player, list, list.findIndex((x) => x.id === seg.id), store.state.clips)
        }
      }
    )
  }

  const selId = selection?.kind === 'caption' ? selection.id : null
  return (
    <div
      className={`tl-track caption-track ${shown ? '' : 'captions-off'}`}
      onPointerDown={onBackgroundDown}
      title={shown ? 'Captions' : 'Captions are hidden: they show on the video once Show captions is on (Captions tab)'}
      data-testid="caption-track"
    >
      {captions
        .filter((s) => overlaps(s, win) || s.id === selId)
        .map((s) => {
          const w = (s.end - s.start) * px
          return (
            <div
              key={s.id}
              data-caption={s.id}
              data-start={s.start}
              data-end={s.end}
              className={`seg caption-seg ${selId === s.id ? 'selected' : ''}`}
              style={{ left: s.start * px, width: w, ['--edge' as string]: `${edgeWidth(w)}px` }}
              onPointerDown={onCaptionDown(s)}
              title={`${s.text} · ${formatTime(s.start)} – ${formatTime(s.end)} · double-click to edit the text`}
            >
              <span className="edge left" />
              {w > 24 && <span className="seg-label">{s.text}</span>}
              <span className="edge right" />
            </div>
          )
        })}
      {captions.length === 0 && <span className="tl-empty">No captions left: generate them again in the Captions tab</span>}
    </div>
  )
}

/** Its row label in the timeline's label column, or null when the track is hidden. */
export function CaptionTrackLabel(): JSX.Element | null {
  const { store } = useEditor()
  const has = useSyncExternalStore(store.subscribe, () => !!store.state.transcript)
  if (!has) return null
  return (
    <div className="tl-label caption-label" title="Captions">
      <EditorIcon name="captions" size={16} />
    </div>
  )
}
