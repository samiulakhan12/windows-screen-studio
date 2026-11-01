/**
 * Long work in steps over several tasks (docs/design/review-mode.md §4.3): Remove all over thousands
 * of speed-ups takes seconds, so the panel takes its steps (removeSteps) a slice of time at a time,
 * the page drawing in between, and makes the result one edit at the end. Pure apart from the tasks
 * it is given.
 */

export interface Tasks {
  /** Runs `fn` in a task of its own, later. */
  post: (fn: () => void) => void
  /** Milliseconds, for the length of a slice. */
  now: () => number
}

/**
 * Takes the steps `start(base)` makes for the state `read()` gives, in tasks of about `slice` ms
 * each, and calls `done(base, value)` with what they give. A task that finds the state changed
 * (another edit) starts over from the new one, so `value` is always made from `base`, the state
 * when `done` is called. Returns a function that stops it: `done` is then never called.
 */
export function inSlices<S, T>(
  read: () => S,
  start: (base: S) => Iterator<unknown, T, undefined>,
  done: (base: S, value: T) => void,
  tasks: Tasks,
  slice = 25
): () => void {
  let stopped = false
  let base = read()
  let steps = start(base)
  const run = (): void => {
    if (stopped) return
    if (read() !== base) {
      base = read()
      steps = start(base)
    }
    const until = tasks.now() + slice
    for (;;) {
      const r = steps.next()
      if (r.done) {
        stopped = true
        done(base, r.value)
        return
      }
      if (tasks.now() >= until) break
    }
    tasks.post(run)
  }
  tasks.post(run)
  return () => {
    stopped = true
  }
}
