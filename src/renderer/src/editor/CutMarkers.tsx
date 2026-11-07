/**
 * The timeline's cut markers (docs/design/editing-polish.md §2.1, §12): over the clip track's top
 * edge, one 12 px glyph of each cut's style in a 24 × 24 px button, whatever the width of its cut
 * block; markers closer than 12 px are one with a count. A click, Enter or Space selects the (first)
 * cut, which opens its Cut style; from the keyboard the focus goes to that section.
 */
import { memo, useMemo, useSyncExternalStore, type PointerEvent } from 'react'
import { cutMarkers } from '../../../shared/editor/timelineCuts'
import type { JoinKind } from '../../../shared/types'
import { useEditor } from './context'
import type { Selection } from './selection'
import './panels/cuts.css'

/** The glyphs (§2.1): never colour alone, each style has its shape. */
function Glyph({ kind }: { kind: JoinKind }): JSX.Element {
  const common = { width: 12, height: 12, viewBox: '0 0 12 12', 'aria-hidden': true as const, fill: 'none', stroke: 'currentColor', strokeWidth: 1.5 }
  switch (kind) {
    case 'smooth':
      return (
        <svg {...common}>
          <rect x="1.5" y="1.5" width="9" height="9" />
          <path d="M1.5 10.5 10.5 1.5" />
        </svg>
      )
    case 'crossfade':
      return (
        <svg {...common}>
          <rect x="1" y="1" width="6.5" height="6.5" />
          <rect x="4.5" y="4.5" width="6.5" height="6.5" />
        </svg>
      )
    case 'dip':
      return (
        <svg {...common}>
          <circle cx="6" cy="6" r="3.5" fill="currentColor" />
        </svg>
      )
    case 'slide':
      return (
        <svg {...common}>
          <path d="M1.5 6h8.5M7 3l3 3-3 3" />
        </svg>
      )
    case 'punch':
      return (
        <svg {...common}>
          <rect x="1.5" y="1.5" width="9" height="9" />
          <path d="M6 3.5v5M3.5 6h5" />
        </svg>
      )
    default:
      return (
        <svg {...common}>
          <path d="M6 1v10" />
        </svg>
      )
  }
}

export const CutMarkers = memo(function CutMarkers({
  px,
  win,
  selection,
  onSelect
}: {
  px: number
  win: { start: number; end: number }
  selection: Selection
  onSelect: (sel: Selection) => void
}): JSX.Element | null {
  const { store } = useEditor()
  const clips = useSyncExternalStore(store.subscribe, () => store.state.clips)
  const joins = useSyncExternalStore(store.subscribe, () => store.state.joins)
  const freezes = useSyncExternalStore(store.subscribe, () => store.state.freezes)
  // The markers read only the clips, the styles and the freezes (for the cut numbers' video times).
  const markers = useMemo(() => cutMarkers({ ...store.state, clips, joins, freezes }, px, win), [store, clips, joins, freezes, px, win])
  if (markers.length === 0) return null
  const selected = selection?.kind === 'gap' ? selection.end : null
  return (
    <>
      {markers.map((m) => (
        <button
          key={m.index}
          type="button"
          className={`cut-marker ${selected !== null && Math.abs(selected - m.gap.end) < 1e-6 ? 'selected' : ''}`}
          data-testid="cut-marker"
          data-index={m.index}
          data-kind={m.kind}
          style={{ left: m.x }}
          aria-label={m.name}
          title={m.name}
          // The clip track's own press (scrub, range) is not this one's.
          onPointerDown={(e: PointerEvent) => e.stopPropagation()}
          onClick={(e) => {
            onSelect({ kind: 'gap', start: m.gap.start, end: m.gap.end })
            // From the keyboard (a click with no pointer), the focus goes to the cut's style.
            if (e.detail === 0) window.setTimeout(() => document.querySelector<HTMLElement>('[data-testid="cut-style"] input:checked')?.focus(), 0)
          }}
        >
          <span className="cut-marker-glyph">
            <Glyph kind={m.kind} />
          </span>
          {m.count > 1 && (
            <span className="cut-marker-count" aria-hidden="true">
              {m.count}
            </span>
          )}
        </button>
      ))}
    </>
  )
})
