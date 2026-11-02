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
 * undo step); undo and redo go back to states already settled. A held
 * gesture's run (its same-key updates) is settled once, when it closes
 * (the gesture ends, another edit, undo, redo), against the state before it:
 * a drag works out each move from where it started, and must not lose what a
 * passing move would settle away.
 *
 * Holding (`hold`): long work that makes one edit at its end from the state it started on (Review
 * mode's Remove all over thousands of rows, a slice of time at a time) holds the store while it
 * works. Undo and redo asked for meanwhile, and what is handed to `whenFree`, wait and are then
 * done in order, after the work's own edit, as if asked for once it was done: Ctrl+Z then undoes
 * that edit, and the step before it, or the redo list, is never taken by the wait. A redo with
 * nothing to bring back once the work's edit is made (it empties the redo list, as any edit does) is
 * refused at once (false). Other edits are not held (the work lands on top of them, its edit made
 * on the state they leave); an undo takes back at once such an edit made after the last thing that
 * waits, and a redo brings back one it took while the work goes on (once the work's edit is made,
 * that empties the redo list too). Work let go without its edit (stopped,
 * or it found nothing to change) leaves what waited to be done as if the edit had been made: an
 * undo that would take it back, or a redo it would have found nothing for, does nothing, and the
 * step before it and the redo list stay. `finish` has the work make its edit at once (the editor
 * closing saves it). Held work does not make its edit while a pointer gesture is open
 * (`gesturing`, `afterGestures`): the drag's next move, worked out from where it started, would
 * write over it.
 */
export class EditStore<T> {
  private readonly history: History<T>
  private readonly listeners = new Set<() => void>()
  /** Told when `canUndo` or `canRedo` may have changed (subscribeHistory). */
  private readonly historyListeners = new Set<() => void>()
  private holds = 0
  /** What waits for the store to be let go, in the order it was asked for. */
  private readonly waiting: (() => void)[] = []
  /** What finishes each work that holds the store at once (its edit made, the store let go). */
  private readonly finishers = new Set<() => void>()
  /**
   * While held: steps made by other edits since the last thing that waits (less those undone), and
   * those undone since that redo brings back.
   */
  private ownSteps = 0
  private ownRedos = 0
  /**
   * While held: the steps the undos that wait leave for a redo after them, less the redos that wait
   * for them (the work's edit empties the redo list first; so does a Keep or Remove that waits).
   */
  private waitRedos = 0
  /**
   * While what waited for work let go without its edit is done: that edit's place in the history
   * (`W`) among the steps made meanwhile (`R`), above the history as it was, and in the redo list.
   */
  private phantom: { past: ('W' | 'R')[]; future: ('W' | 'R')[] } | null = null
  private gestures = 0
  /** What waits for the pointer gestures open to end (afterGestures). */
  private readonly gestureEnds: (() => void)[] = []
  private lastKey: string | null = null
  private lastAt = 0
  /** The state before the held gesture run whose states wait to be settled (none: null). */
  private unsettled: T | null = null
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

  /** Whether an undo would be done: while held, always (it waits for the work's edit, which it then takes back). */
  get canUndo(): boolean {
    return this.holds > 0 || this.history.canUndo
  }

  /** Whether a redo would be done: while held, one that brings back an edit made meanwhile, or one that waits after an undo that waits. */
  get canRedo(): boolean {
    return this.holds > 0 ? this.ownRedos > 0 || this.waitRedos > 0 : this.history.canRedo
  }

  /** Calls `listener` whenever `canUndo` or `canRedo` may have changed (an edit, undo, redo, the store held or let go, an undo or redo that waits). */
  subscribeHistory = (listener: () => void): (() => void) => {
    this.historyListeners.add(listener)
    return () => this.historyListeners.delete(listener)
  }

  subscribe = (listener: () => void): (() => void) => {
    this.listeners.add(listener)
    return () => this.listeners.delete(listener)
  }

  getSnapshot = (): T => this.history.present

  update = (fn: (state: T) => T, key?: string): void => {
    const held = this.gestures > 0 && key !== undefined
    const holding = held && key === this.lastKey
    // Another edit closes a held run: it is made on the run's state settled, which takes the run's
    // place (in its own undo step) unless the edit changes nothing (the run goes on).
    const closing = holding ? null : this.unsettled
    const prev = closing === null ? this.history.present : this.settled(this.history.present, closing)
    const out = fn(prev)
    const next = held ? out : this.settled(out, prev)
    if (next === prev) return
    if (closing !== null) {
      this.unsettled = null
      if (prev !== this.history.present) this.history.replace(prev)
    }
    if (held) this.unsettled ??= prev
    const now = this.clock()
    // Passing the previous timestamp keeps a held gesture inside the merge window.
    const at = holding ? this.lastAt : now
    const step = this.history.push(next, key, at)
    if (this.holds > 0) {
      if (step) this.ownSteps++
      this.ownRedos = 0
    }
    if (this.phantom) {
      if (step) this.phantom.past.push('R')
      this.phantom.future = []
    }
    this.lastKey = key ?? null
    this.lastAt = at
    this.changed()
  }

  /** Changes the present without an undo step (automatic corrections). */
  replace = (fn: (state: T) => T): void => {
    const prev = this.history.present
    const out = fn(prev)
    const next = this.unsettled === null ? this.settled(out, prev) : out
    if (next === prev) return
    this.history.replace(next)
    this.changed()
  }

  /**
   * Goes back a step; false when there is none. While the store is held it waits (true), unless an
   * edit was made meanwhile since the last thing that waits: that is taken back at once.
   */
  undo = (): boolean => {
    if (this.holds > 0) {
      if (this.ownSteps > 0) {
        if (!this.step('undo')) return false
        this.ownSteps--
        this.ownRedos++
        return true
      }
      this.wait(() => void this.undo(), 'undo')
      return true
    }
    const ph = this.phantom
    if (ph && ph.past[ph.past.length - 1] === 'W') {
      // Takes back the edit the work did not make: nothing changes.
      ph.past.pop()
      ph.future.push('W')
      return true
    }
    if (!this.step('undo')) return false
    if (ph) {
      ph.past.pop()
      ph.future.push('R')
    }
    return true
  }

  /**
   * Goes forward a step; false when there is none. While the store is held it waits (true) for an
   * undo that waits before it, unless an undo since the last thing that waits took back an edit made
   * meanwhile: that comes back at once. Else it is refused at once (false): the work's edit, made
   * before it, empties the redo list.
   */
  redo = (): boolean => {
    if (this.holds > 0) {
      if (this.ownRedos > 0) {
        if (!this.step('redo')) return false
        this.ownRedos--
        this.ownSteps++
        return true
      }
      if (this.waitRedos === 0) return false
      this.wait(() => void this.redo(), 'redo')
      return true
    }
    const ph = this.phantom
    if (!ph) return this.step('redo')
    const top = ph.future.pop()
    // Nothing to redo above the edit the work did not make (it would have emptied the redo list).
    if (top === undefined) return false
    // That edit itself: nothing changes.
    if (top === 'R' && !this.step('redo')) return false
    ph.past.push(top)
    return true
  }

  /**
   * Has `fn` wait for the store to be let go; an undo or redo after it waits too (it comes after
   * `fn`). `what` it is: an undo leaves a step for a redo after it, a redo takes one, anything else
   * (a Keep or Remove, an edit) empties the redo list.
   */
  private wait(fn: () => void, what: 'undo' | 'redo' | 'other'): void {
    this.waiting.push(fn)
    this.ownSteps = 0
    this.ownRedos = 0
    this.waitRedos = what === 'undo' ? this.waitRedos + 1 : what === 'redo' ? this.waitRedos - 1 : 0
    this.historyChanged()
  }

  private step(way: 'undo' | 'redo'): boolean {
    this.seal()
    if ((way === 'undo' ? this.history.undo() : this.history.redo()) === null) return false
    this.changed()
    return true
  }

  /** Whether something holds the store (undo, redo and `whenFree` wait). */
  get held(): boolean {
    return this.holds > 0
  }

  /**
   * Holds the store until the function returned is called (once; again does nothing), `made` false
   * when the holder let it go without its edit (stopped, or nothing to change). Then, once nothing
   * holds it, what waited is done in order (as if after that edit, when it was not made); a waiting
   * step that holds it again leaves the rest waiting for that. `finish`, when given, has the holder
   * make its edit and let go at once (`finish` below).
   */
  hold = (finish?: () => void): ((made?: boolean) => void) => {
    if (this.holds === 0) {
      this.ownSteps = 0
      this.ownRedos = 0
      this.waitRedos = 0
    }
    this.holds++
    if (finish) this.finishers.add(finish)
    this.historyChanged()
    let held = true
    return (made = true) => {
      if (!held) return
      held = false
      if (finish) this.finishers.delete(finish)
      this.holds--
      if (this.holds > 0) return
      this.phantom = made ? null : { past: ['W'], future: [] }
      try {
        while (this.holds === 0 && this.waiting.length > 0) this.waiting.shift()!()
      } finally {
        this.phantom = null
        this.historyChanged()
      }
    }
  }

  /** Has each work holding the store that can finish at once do so (its edit made, what waited then done). */
  finish = (): void => {
    for (const f of [...this.finishers]) f()
  }

  /** Runs `fn` now, or, while the store is held, once it is let go, in turn with the undo and redo that wait. */
  whenFree = (fn: () => void): void => {
    if (this.holds > 0) this.wait(fn, 'other')
    else fn()
  }

  beginGesture = (): void => {
    this.gestures++
  }

  endGesture = (): void => {
    this.gestures = Math.max(0, this.gestures - 1)
    if (this.gestures > 0) return
    this.seal()
    while (this.gestures === 0 && this.gestureEnds.length > 0) this.gestureEnds.shift()!()
  }

  /** Whether a pointer gesture is open (a drag: each move writes a state worked out from where it started). */
  get gesturing(): boolean {
    return this.gestures > 0
  }

  /** Runs `fn` once no pointer gesture is open: at once when none is, else as the last one ends (its run settled). */
  afterGestures = (fn: () => void): void => {
    if (this.gestures === 0) fn()
    else this.gestureEnds.push(fn)
  }

  /** Closes the current merge run so the next edit is a separate undo step. */
  seal = (): void => {
    this.settleRun()
    this.history.seal()
    this.lastKey = null
  }

  private settled(next: T, prev: T): T {
    return next === prev ? next : this.settle(next, prev)
  }

  /** Settles the held run's last state in its own undo step. */
  private settleRun(): void {
    const before = this.unsettled
    if (before === null) return
    this.unsettled = null
    const present = this.history.present
    const next = this.settled(present, before)
    if (next === present) return
    this.history.replace(next)
    this.changed()
  }

  private changed(): void {
    this.revision++
    for (const l of [...this.listeners]) l()
    this.historyChanged()
  }

  private historyChanged(): void {
    for (const l of [...this.historyListeners]) l()
  }
}
