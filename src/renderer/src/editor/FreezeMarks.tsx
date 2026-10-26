import { memo, useEffect, useMemo, useRef, useSyncExternalStore, type PointerEvent as ReactPointerEvent } from 'react'
import { moveFreeze, setFreezeLength } from '../../../shared/editor/freezeEdit'
import { shortcutLabel } from '../../../shared/editor/shortcuts'
import { outputToSourceRanges } from '../../../shared/editor/smartSpeed'
import { overlaps } from '../../../shared/editor/timelineScale'
import { planOf, type Hold, type Still } from '../../../shared/engine/freeze'
import { viewingTime } from '../../../shared/render/overlays'
import type { Clip, Freeze } from '../../../shared/types'
import { Icon } from '../components/Icon'
import { useEditor } from './context'
import { EditorIcon } from './EditorIcon'
import { releaseFocus } from './focus'
import { useKeymap } from './keymapContext'
import { followPointer } from './pointer'
import type { Selection } from './selection'
import type { SnapController } from './snapControl'
import './freeze.css'

interface Props {
  px: number
  win: { start: number; end: number }
  duration: number
  clips: Clip[]
  selection: Selection
  onSelect: (sel: Selection) => void
  /** The timeline's snapping (E-05): moved anchors and continue ends snap; without it values pass straight through. */
  snap?: SnapController
}

const NO_FREEZES: Freeze[] = []
/** Narrowest block (px), so a short freeze stays easy to grab. */
const MIN_WIDTH = 8

const seconds = (v: number): string => `${v.toFixed(1)} s`

/**
 * Freeze frames on the clip track (E-11, docs/design/freeze-frame.md §5): a hatched strip along its
 * top edge. A pause freeze adds time the source-time timeline has no room for, so its block is drawn
 * over the footage from its frame, as long as the time it adds; a continue freeze covers the footage
 * it holds the picture over; one whose frame is cut is a hollow diamond in the gap. The body moves a
 * freeze, the right edge sets its length; each drag is one undo step.
 */
export const FreezeMarks = memo(function FreezeMarks({ px, win, duration, clips, selection, onSelect, snap }: Props): JSX.Element | null {
  const { store, player } = useEditor()
  const keymap = useKeymap()
  const freezes = useSyncExternalStore(store.subscribe, () => store.state.freezes) ?? NO_FREEZES
  const plan = planOf({ clips, freezes })
  const boxRef = useRef<HTMLDivElement>(null)
  const byId = useMemo(() => new Map(freezes.map((f) => [f.id, f])), [freezes])
  const selId = selection?.kind === 'freeze' ? selection.id : null

  // The held freeze's block fills as it plays (written to the DOM: no re-render per frame).
  useEffect(() => {
    let shown: HTMLElement | null = null
    const update = (): void => {
      const id = player.heldFreeze
      const h = id ? plan.holds.find((x) => x.id === id) : undefined
      const el = h ? boxRef.current?.querySelector<HTMLElement>(`[data-freeze="${CSS.escape(h.id)}"]`) : null
      if (shown && shown !== el) shown.style.removeProperty('--hold-progress')
      shown = el ?? null
      if (el && h) el.style.setProperty('--hold-progress', String(Math.min(1, player.holdElapsed / h.length)))
    }
    update()
    const off = player.subscribe(update)
    return () => {
      off()
      shown?.style.removeProperty('--hold-progress')
    }
  }, [player, plan])

  if (freezes.length === 0) return null

  /** Follows one drag of freeze `f`: `apply` gets the source seconds the pointer moved; one undo step per drag. */
  const drag = (e: ReactPointerEvent, f: Freeze, apply: (dt: number, ev: PointerEvent) => void): void => {
    e.preventDefault()
    e.stopPropagation()
    releaseFocus()
    const sx = e.clientX
    let moved = false
    store.beginGesture()
    followPointer(
      e,
      (ev) => {
        if (!moved && Math.abs(ev.clientX - sx) <= 3) return
        moved = true
        apply((ev.clientX - sx) / px, ev)
      },
      () => {
        store.endGesture()
        // A plain click shows the frozen frame.
        if (!moved) player.seek(f.at)
      }
    )
  }

  /** The body: selects the freeze and moves it to the frame under the pointer. */
  const onBodyDown = (f: Freeze) => (e: ReactPointerEvent) => {
    // Shift or Alt+drag still selects a range on the clip track.
    if (e.button !== 0 || e.shiftKey || e.altKey) return
    onSelect({ kind: 'freeze', id: f.id })
    // The playhead follows the anchor during this drag, so it is no target.
    const session = snap?.begin(e, { exclude: [{ owner: `freeze:${f.id}` }], noPlayhead: true })
    drag(e, f, (dt, ev) => {
      const t = session ? session.at(ev, f.at + dt, { min: 0, max: duration }) : f.at + dt
      store.update((p) => moveFreeze(p, f.id, t), `freeze-move:${f.id}`)
      const at = store.state.freezes?.find((x) => x.id === f.id)?.at
      if (at !== undefined) player.seek(at)
    })
  }

  /** The right edge: the length (a pause freeze's in the timeline's seconds; a continue freeze's in the video's, to the footage under the pointer). */
  const onEdgeDown = (f: Freeze, still: Still | null) => (e: ReactPointerEvent) => {
    if (e.button !== 0) return
    onSelect({ kind: 'freeze', id: f.id })
    const from = still ? outputToSourceRanges(clips, still.editStart, still.editEnd).at(-1)?.end ?? f.at : 0
    const session = still ? snap?.begin(e, { exclude: [{ owner: `freeze:${f.id}` }], noPlayhead: true }) : undefined
    drag(e, f, (dt, ev) => {
      let length = f.length + dt
      if (still) {
        const t = session ? session.at(ev, from + dt, { min: f.at, max: duration }) : from + dt
        length = viewingTime(clips, t) - still.editStart
      }
      store.update((p) => setFreezeLength(p, f.id, length), `freeze-length:${f.id}`)
    })
  }

  const deleteHint = keymap.deleteSelection.length ? `, ${shortcutLabel(keymap.deleteSelection[0])} to remove` : ''
  const blocks: JSX.Element[] = []

  const holdBlock = (h: Hold): void => {
    const f = byId.get(h.id)
    if (!f || (!overlaps({ start: h.at, end: h.at + h.length }, win) && h.id !== selId)) return
    const width = Math.max(MIN_WIDTH, Math.min(h.length, Math.max(0, duration - h.at)) * px)
    blocks.push(
      <div
        key={h.id}
        className={`freeze-block pause ${selId === h.id ? 'selected' : ''}`}
        data-testid="freeze-block"
        data-freeze={h.id}
        data-sound="pause"
        style={{ left: Math.min(h.at, duration) * px, width }}
        title={`Freeze frame: adds ${seconds(h.length)} here, the recording waits. Drag the edge to change${deleteHint}`}
        onPointerDown={onBodyDown(f)}
      >
        <span className="freeze-progress" />
        {width > 44 && (
          <span className="freeze-label">
            <Icon name="pause" size={9} /> +{seconds(h.length)}
          </span>
        )}
        <span className="freeze-edge" onPointerDown={onEdgeDown(f, null)} />
      </div>
    )
  }

  const stillBlocks = (s: Still): void => {
    const f = byId.get(s.id)
    if (!f) return
    const pieces = outputToSourceRanges(clips, s.editStart, s.editEnd)
    if (!pieces.some((r) => overlaps(r, win)) && s.id !== selId) return
    const held = s.editEnd - s.editStart
    pieces.forEach((r, i) => {
      const last = i === pieces.length - 1
      const width = Math.max(MIN_WIDTH, (r.end - r.start) * px)
      blocks.push(
        <div
          key={`${s.id}:${i}`}
          className={`freeze-block continue ${selId === s.id ? 'selected' : ''}`}
          data-testid="freeze-block"
          data-freeze={s.id}
          data-sound="continue"
          style={{ left: r.start * px, width }}
          title={`Freeze frame: the picture holds for ${seconds(held)} while the sound plays on`}
          onPointerDown={onBodyDown(f)}
        >
          {i === 0 && width > 40 && (
            <span className="freeze-label">
              <EditorIcon name="volume" size={10} /> {seconds(held)}
            </span>
          )}
          {last && <span className="freeze-edge" onPointerDown={onEdgeDown(f, s)} />}
        </div>
      )
    })
  }

  plan.holds.forEach(holdBlock)
  plan.stills.forEach(stillBlocks)
  for (const id of plan.inactive) {
    const f = byId.get(id)
    if (!f || ((f.at < win.start || f.at > win.end) && id !== selId)) continue
    blocks.push(
      <span
        key={id}
        className={`freeze-mark inactive ${selId === id ? 'selected' : ''}`}
        data-testid="freeze-inactive"
        data-freeze={id}
        style={{ left: f.at * px }}
        title={`Freeze frame in a cut: not in the video. Restore the cut, or select it and press ${shortcutLabel(keymap.deleteSelection[0] ?? 'Delete')}`}
        onPointerDown={onBodyDown(f)}
      />
    )
  }

  return (
    <div className="freeze-marks" ref={boxRef}>
      {blocks}
    </div>
  )
})
