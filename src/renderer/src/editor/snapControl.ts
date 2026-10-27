/**
 * The timeline's snapping session (E-05, docs/design/snapping.md §4.4): one controller per
 * Timeline, with a stable identity. Each drag handler calls `begin` once at pointerdown; the
 * session then snaps each move (shared/editor/snapping.ts), unless snapping is off or Alt is held,
 * tracks the target holding the edge and moves the guide.
 */
import { useRef, useState, type PointerEvent as ReactPointerEvent, type RefObject } from 'react'
import type { ClickRow } from '../../../shared/engine/inputData'
import {
  buildSnapIndex,
  projectFreezeTargets,
  projectSnapSources,
  snapAt,
  snapSpan,
  type DragMode,
  type SnapExclude,
  type SnapIndex,
  type SnapLimit,
  type SnapTarget,
  type SnapView,
  type Span
} from '../../../shared/editor/snapping'
import { useEditor, type EditorServices } from './context'

/** localStorage key of the snapping toggle: '0' off, anything else (or nothing) on. */
export const SNAP_PREF_KEY = 'editor-snapping'

const listeners = new Set<() => void>()
/** The toggle's value while it could not be stored (storage blocked): kept for this session. */
let unstored: boolean | null = null

/** The per-user snapping toggle (on by default), read synchronously at pointerdown. */
export const snapPref: { get(): boolean; set(on: boolean): void; toggle(): boolean; subscribe(l: () => void): () => void } = {
  get(): boolean {
    if (unstored !== null) return unstored
    try {
      return localStorage.getItem(SNAP_PREF_KEY) !== '0'
    } catch {
      return true
    }
  },
  set(on: boolean): void {
    try {
      localStorage.setItem(SNAP_PREF_KEY, on ? '1' : '0')
      unstored = null
    } catch {
      unstored = on
    }
    for (const l of [...listeners]) l()
  },
  /** Flips the toggle; returns the new state. */
  toggle(): boolean {
    const on = !snapPref.get()
    snapPref.set(on)
    return on
  },
  subscribe(l: () => void): () => void {
    listeners.add(l)
    return () => {
      listeners.delete(l)
    }
  }
}

/** What a drag tells the controller at pointerdown. */
export interface SnapBegin {
  /** Its own edges (and edges that move with it), never targets. */
  exclude?: readonly SnapExclude[]
  /** The playhead is not a target (scrubbing, trimming). */
  noPlayhead?: boolean
  /** Snapping starts once the pointer has moved this far from the press (px); default 0. */
  slopPx?: number
}

/** One drag's snapping: each move's raw values in, the values to write out. */
export interface SnapSession {
  /** A span drag: `resolve` is the drag helper with its bounds (it still clamps). */
  span(ev: PointerEvent, initial: Span, mode: DragMode, dt: number, resolve: (dt: number) => Span): Span
  /** A point drag (trim edge, range end, chapter, freeze, scrub); targets outside `limit`, or that it does not accept, are ignored. */
  at(ev: PointerEvent, t: number, limit?: SnapLimit): number
}

/** The timeline's snapping controller (stable identity). */
export interface SnapController {
  begin(e: ReactPointerEvent, spec?: SnapBegin): SnapSession
}

/** The snapping guide on the timeline (implemented by E-05's SnapGuide component). */
export interface SnapGuideHandle {
  show(t: number, pxPerSec: number, target: SnapTarget): void
  hide(): void
}

/** Space before 0 s: the .tl-content padding (Timeline.tsx GUTTER). */
const GUTTER = 10

interface SnapDeps {
  pxRef: RefObject<number>
  scrollerRef: RefObject<HTMLDivElement>
  clickRows: readonly ClickRow[]
  guideRef: RefObject<SnapGuideHandle>
}

/** A controller reading its dependencies through `deps()` at each press and move. */
function createSnapController(deps: () => SnapDeps & EditorServices): SnapController {
  // One drag at a time: a new press ends the session before it.
  let endActive: (() => void) | null = null

  return {
    begin(e, spec = {}) {
      endActive?.()
      const { store, player, clickRows, guideRef } = deps()
      const on = snapPref.get()
      const index: SnapIndex | null = on
        ? buildSnapIndex(
            projectSnapSources(store.state, clickRows, {
              // A moving playhead cannot be caught; scrubbing and trimming move it themselves.
              playhead: spec.noPlayhead || player.moving ? null : player.time,
              layouts: store.state.hasWebcam && player.webcam !== null,
              freezes: projectFreezeTargets(store.state, spec.exclude)
            }),
            spec.exclude
          )
        : null
      const sx = e.clientX
      const id = e.pointerId
      const slop = spec.slopPx ?? 0
      let current: SnapTarget | null = null
      let open = true
      let freed = slop <= 0

      const hide = (): void => {
        current = null
        guideRef.current?.hide()
      }
      // Releasing Alt alone could move focus to the window menu (docs/design/snapping.md risk 1).
      const onKey = (ev: KeyboardEvent): void => {
        if (ev.key === 'Alt') ev.preventDefault()
      }
      const end = (ev?: PointerEvent): void => {
        if (!open || (ev && ev.pointerId !== id)) return
        open = false
        if (endActive === end) endActive = null
        hide()
        window.removeEventListener('pointerup', end, true)
        window.removeEventListener('pointercancel', end, true)
        window.removeEventListener('keydown', onKey, true)
        window.removeEventListener('keyup', onKey, true)
      }
      window.addEventListener('pointerup', end, true)
      window.addEventListener('pointercancel', end, true)
      window.addEventListener('keydown', onKey, true)
      window.addEventListener('keyup', onKey, true)
      endActive = end

      /** The view of this move, or null while it goes unsnapped (off, Alt, within the slop, ended). */
      const viewOf = (ev: PointerEvent): SnapView | null => {
        if (!freed && Math.abs(ev.clientX - sx) >= slop) freed = true
        if (!index || !open || ev.altKey || !freed) return null
        const { pxRef, scrollerRef } = deps()
        const px = pxRef.current ?? 0
        const el = scrollerRef.current
        // Only the part of the timeline on screen catches: the timeline does not scroll during a drag.
        const visible = el && px > 0 ? { start: (el.scrollLeft - GUTTER) / px, end: (el.scrollLeft + el.clientWidth - GUTTER) / px } : null
        return { pxPerSec: px, current, visible }
      }
      const show = (target: SnapTarget | null, pxPerSec: number): void => {
        current = target
        if (target) guideRef.current?.show(target.t, pxPerSec, target)
        else guideRef.current?.hide()
      }

      return {
        span(ev, initial, mode, dt, resolve) {
          const view = viewOf(ev)
          if (!index || !view) {
            hide()
            return resolve(dt)
          }
          const r = snapSpan(index, initial, mode, dt, view, resolve)
          show(r.target, view.pxPerSec)
          return r.times
        },
        at(ev, t, limit) {
          const view = viewOf(ev)
          if (!index || !view) {
            hide()
            return t
          }
          const r = snapAt(index, t, view, limit)
          show(r.target, view.pxPerSec)
          return r.t
        }
      }
    }
  }
}

/** The Timeline's snapping controller, built once (refs keep it current). */
export function useSnapController(deps: SnapDeps): SnapController {
  const services = useEditor()
  const ref = useRef({ ...deps, ...services })
  ref.current = { ...deps, ...services }
  const [controller] = useState(() => createSnapController(() => ref.current))
  return controller
}
