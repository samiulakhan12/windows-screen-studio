/**
 * Long work in steps over several tasks (docs/design/review-mode.md §4.3): Remove all over thousands
 * of speed-ups takes seconds, so the panel takes its steps (removeSteps) a slice of time at a time,
 * the page drawing in between, and makes the result one edit at the end, holding the store's undo
 * and redo meanwhile (heldInSlices). Pure apart from the tasks and the store it is given.
 */

export interface Tasks {
  /** Runs `fn` in a task of its own, later. */
  post: (fn: () => void) => void
  /** Milliseconds, for the length of a slice. */
  now: () => number
}

/** Work going on in slices: `stop` ends it with `done` never called; `finish` takes the steps left at once and calls `done`. */
export interface Work {
  stop: () => void
  finish: () => void
}

/** When `done` may be called (inSlices): not while `open` says no; `whenOpen` then calls back once it may. */
export interface Gate {
  open: () => boolean
  whenOpen: (fn: () => void) => void
}

/**
 * Takes the steps `start(base)` makes for the state `read()` gives, in tasks of about `slice` ms
 * each, and calls `done(base, value)` with what they give. A task that finds the state changed
 * (another edit) starts over from the new one, so `value` is always made from `base`, the state
 * when `done` is called. With a `gate` that is shut once the steps are done, `done` waits for it to
 * open (in a task of its own, the state looked at again). `finish` does not wait.
 */
export function inSlices<S, T>(
  read: () => S,
  start: (base: S) => Iterator<unknown, T, undefined>,
  done: (base: S, value: T) => void,
  tasks: Tasks,
  slice = 25,
  gate?: Gate
): Work {
  let stopped = false
  let base = read()
  let steps = start(base)
  /** What the steps gave for `base`, once they are done. */
  let result: { value: T } | null = null
  /** Takes steps until `until` says to stop ('more'), or they are done: `done` called ('done'), or waiting for the gate ('shut'). */
  const take = (until: () => boolean, wait: boolean): 'more' | 'shut' | 'done' => {
    if (read() !== base) {
      base = read()
      steps = start(base)
      result = null
    }
    while (result === null) {
      const r = steps.next()
      if (r.done) result = { value: r.value }
      else if (until()) return 'more'
    }
    if (wait && gate && !gate.open()) return 'shut'
    stopped = true
    done(base, result.value)
    return 'done'
  }
  const run = (): void => {
    if (stopped) return
    const end = tasks.now() + slice
    const now = take(() => tasks.now() >= end, true)
    if (now === 'more') tasks.post(run)
    else if (now === 'shut') gate!.whenOpen(() => tasks.post(run))
  }
  tasks.post(run)
  return {
    stop: () => {
      stopped = true
    },
    finish: () => {
      if (!stopped) take(() => false, false)
    }
  }
}

/** What heldInSlices needs of the edit store (shared/editor/editStore.ts). */
export interface HeldStore<S> {
  readonly state: S
  readonly revision: number
  hold: (finish?: () => void) => (made?: boolean) => void
  /** Whether a pointer gesture (a drag) is open, and what runs once none is. */
  readonly gesturing: boolean
  afterGestures: (fn: () => void) => void
}

/**
 * inSlices on the store's state, holding the store while it works: undo and redo asked for
 * meanwhile (and what is handed to its `whenFree`) wait, and are done in order once `done` has
 * made the work's edit, as if asked for after it (so Ctrl+Z undoes it, never the step before).
 * `done` waits while a pointer gesture is open: a drag's next move, worked out from the state at
 * its start, would write over the edit; once it ends the work goes on from the state it left.
 * `stop` ends the work with nothing changed (`done` never called) and lets the store go: what
 * waited is then done as if the edit had been made, so an undo that would have taken it back does
 * nothing (the step before it stays) and the redo list stays as it was. `finish` (also the store's
 * `finish`) makes the edit at once.
 */
export function heldInSlices<S, T>(
  store: HeldStore<S>,
  start: (base: S) => Iterator<unknown, T, undefined>,
  done: (base: S, value: T) => void,
  tasks: Tasks,
  slice = 25
): Work {
  let work: Work | null = null
  const release = store.hold(() => work?.finish())
  work = inSlices(
    () => store.state,
    start,
    (base, value) => {
      const before = store.revision
      try {
        done(base, value)
      } finally {
        release(store.revision !== before)
      }
    },
    tasks,
    slice,
    { open: () => !store.gesturing, whenOpen: store.afterGestures }
  )
  const { finish } = work
  return {
    stop: () => {
      work?.stop()
      release(false)
    },
    finish
  }
}
