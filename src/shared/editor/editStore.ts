import { History } from '../engine/history'

/**
 * Observable undo/redo store for the document being edited (a Project).
 * Every edit goes through `update`, so autosave, undo and the UI all see the
 * same present state.
 *
 * Coalescing: consecutive updates with the same `key` inside the history's
 * merge window become one undo step (typing, arrow keys on a slider). While a
 * pointer gesture is open (`beginGesture`..`endGesture`, e.g. a timeline drag
 * or a slider drag) same-key updates merge however long the user pauses, and
 * ending the gesture always closes the step.
 *
 * `settle` brings each state an edit makes (`update`, `replace`) into line
 * with itself before it is kept (data that follows the edit, part of the same
 * undo step); undo and redo go back to states already settled.
 */
export class EditStore<T> {
  private readonly history: History<T>
  private readonly listeners = new Set<() => void>()
  private gestures = 0
  private lastKey: string | null = null
  private lastAt = 0
  /** Increments on every change of the present state (edits, undo, redo, replace). */
  revision = 0

  constructor(
    initial: T,
    limit = 200,
    mergeWindowMs = 800,
    private readonly clock: () => number = Date.now,
    private readonly settle: (next: T, prev: T) => T = (next) => next
  ) {
    this.history = new History(initial, limit, mergeWindowMs)
  }

  get state(): T {
    return this.history.present
  }

  get canUndo(): boolean {
    return this.history.canUndo
  }

  get canRedo(): boolean {
    return this.history.canRedo
  }

  subscribe = (listener: () => void): (() => void) => {
    this.listeners.add(listener)
    return () => this.listeners.delete(listener)
  }

  getSnapshot = (): T => this.history.present

  update = (fn: (state: T) => T, key?: string): void => {
    const prev = this.history.present
    const next = this.settled(fn(prev), prev)
    if (next === prev) return
    const now = this.clock()
    const holding = this.gestures > 0 && key !== undefined && key === this.lastKey
    // Passing the previous timestamp keeps a held gesture inside the merge window.
    const at = holding ? this.lastAt : now
    this.history.push(next, key, at)
    this.lastKey = key ?? null
    this.lastAt = at
    this.changed()
  }

  /** Changes the present without an undo step (automatic corrections). */
  replace = (fn: (state: T) => T): void => {
    const prev = this.history.present
    const next = this.settled(fn(prev), prev)
    if (next === prev) return
    this.history.replace(next)
    this.changed()
  }

  undo = (): boolean => {
    this.seal()
    if (this.history.undo() === null) return false
    this.changed()
    return true
  }

  redo = (): boolean => {
    this.seal()
    if (this.history.redo() === null) return false
    this.changed()
    return true
  }

  beginGesture = (): void => {
    this.gestures++
  }

  endGesture = (): void => {
    this.gestures = Math.max(0, this.gestures - 1)
    if (this.gestures === 0) this.seal()
  }

  /** Closes the current merge run so the next edit is a separate undo step. */
  seal = (): void => {
    this.history.seal()
    this.lastKey = null
  }

  private settled(next: T, prev: T): T {
    return next === prev ? next : this.settle(next, prev)
  }

  private changed(): void {
    this.revision++
    for (const l of [...this.listeners]) l()
  }
}
