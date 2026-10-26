/**
 * The timeline's snapping session (E-05, docs/design/snapping.md §4.4): one controller per
 * Timeline, with a stable identity. Each drag handler calls `begin` once at pointerdown; the
 * session then snaps each move (shared/editor/snapping.ts), unless snapping is off or Alt is held,
 * tracks the target holding the edge and moves the guide.
 *
 * Contracts commit: the snapping preference is implemented; the controller's sessions return
 * their inputs unchanged until E-05 lands (TODO(E-05) below), so every drag behaves as before.
 */
import type { PointerEvent as ReactPointerEvent, RefObject } from 'react'
import type { ClickRow } from '../../../shared/engine/inputData'
import type { DragMode, SnapExclude, SnapTarget, Span } from '../../../shared/editor/snapping'

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
  /** A point drag (trim edge, range end, chapter, scrub); targets outside `limit` are ignored. */
  at(ev: PointerEvent, t: number, limit?: { min: number; max: number }): number
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

/** A session that snaps nothing. */
const PASS_THROUGH_SESSION: SnapSession = {
  span: (_ev, _initial, _mode, dt, resolve) => resolve(dt),
  at: (_ev, t) => t
}

const PASS_THROUGH: SnapController = { begin: () => PASS_THROUGH_SESSION }

/** The Timeline's snapping controller, built once (refs keep it current). */
export function useSnapController(deps: {
  pxRef: RefObject<number>
  scrollerRef: RefObject<HTMLDivElement>
  clickRows: readonly ClickRow[]
  guideRef: RefObject<SnapGuideHandle>
}): SnapController {
  // TODO(E-05): index at begin, Alt and the toggle gate, the current target, the guide.
  void deps
  return PASS_THROUGH
}
