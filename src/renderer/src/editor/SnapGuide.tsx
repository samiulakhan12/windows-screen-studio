import { forwardRef, useImperativeHandle, useRef, useSyncExternalStore } from 'react'
import { withShortcut } from '../../../shared/editor/shortcuts'
import { snapLabel } from '../../../shared/editor/snapping'
import { EditorIcon } from './EditorIcon'
import { useKeymap } from './keymapContext'
import { snapPref, type SnapGuideHandle } from './snapControl'
import './snap.css'

/** Space before 0 s: the .tl-content padding (Timeline.tsx GUTTER). */
const GUTTER = 10

/**
 * The line and label showing what a dragged edge snapped to ("Cut · 0:04.0"). Moved by direct DOM
 * writes, like the playhead, so a drag does not re-render the timeline for it.
 */
export const SnapGuide = forwardRef<SnapGuideHandle>(function SnapGuide(_props, ref) {
  const lineRef = useRef<HTMLDivElement>(null)
  const labelRef = useRef<HTMLSpanElement>(null)

  useImperativeHandle(
    ref,
    () => ({
      show(t, pxPerSec, target) {
        const line = lineRef.current
        const label = labelRef.current
        if (!line || !label) return
        const x = t * pxPerSec
        line.style.transform = `translateX(${x}px)`
        line.dataset.kind = target.kind
        line.dataset.t = String(target.t)
        label.textContent = snapLabel(target)
        line.hidden = false
        // The label goes left of the line where it would run past the visible part of the timeline.
        const scroller = line.parentElement?.parentElement
        const right = scroller ? scroller.scrollLeft + scroller.clientWidth : Infinity
        label.classList.toggle('flip', GUTTER + x + label.offsetWidth + 4 > right)
      },
      hide() {
        const line = lineRef.current
        if (!line || line.hidden) return
        line.hidden = true
        delete line.dataset.kind
        delete line.dataset.t
      }
    }),
    []
  )

  return (
    <div className="snap-guide" ref={lineRef} data-testid="snap-guide" hidden>
      <span className="snap-label" ref={labelRef} />
    </div>
  )
})

/** The magnet in the timeline header: turns snapping on and off (remembered on this computer). */
export function SnapButton(): JSX.Element {
  const on = useSyncExternalStore(snapPref.subscribe, snapPref.get)
  const keymap = useKeymap()
  const title = on
    ? 'Snapping on: edges and the playhead snap to cuts, clicks, chapters and other items. Hold Alt while dragging to place freely'
    : 'Snapping off: items move freely. Click to snap to cuts, clicks, chapters and other items'
  return (
    <button
      className="btn ghost icon-btn tl-snap"
      aria-pressed={on}
      aria-label="Snapping"
      data-testid="snap-toggle"
      title={withShortcut(title, keymap.toggleSnapping)}
      onClick={() => snapPref.toggle()}
    >
      <EditorIcon name="magnet" size={16} />
    </button>
  )
}
