/**
 * A small job queue for the copy pack (docs/design/publish-pack.md §4.6): at most `limit` jobs run at
 * once, in the order they were added; a waiting job can be taken out and a running one is told to stop
 * through its signal. A cancelled job settles at once, but keeps its slot until its work has really
 * stopped, so no more than `limit` requests are ever out. Pure (no timers, no window).
 */

export interface QueueJob<T> {
  id: string
  /** Starts the work; `signal` aborts when the job is cancelled. */
  run: (signal: AbortSignal) => Promise<T>
}

export interface JobQueue {
  /** Adds a job (cancelling one with the same id); resolves or rejects with it. A cancelled job rejects with a CancelledError. */
  add<T>(job: QueueJob<T>): Promise<T>
  /** Cancels job `id`, waiting or running; false when there is none. */
  cancel(id: string): boolean
  cancelAll(): void
  /** Ids running now (not cancelled), and waiting in order. */
  readonly running: readonly string[]
  readonly waiting: readonly string[]
  /** Jobs whose work has not settled yet, cancelled ones included (never more than the limit). */
  readonly busy: number
}

export class CancelledError extends Error {
  constructor() {
    super('Stopped')
    this.name = 'CancelledError'
  }
}

interface Entry {
  id: string
  run: (signal: AbortSignal) => Promise<unknown>
  controller: AbortController
  settled: boolean
  resolve: (v: unknown) => void
  reject: (e: unknown) => void
}

export function createQueue(limit = 2): JobQueue {
  const waiting: Entry[] = []
  const running = new Set<Entry>()
  const settle = (e: Entry, how: () => void): void => {
    if (e.settled) return
    e.settled = true
    how()
  }
  const pump = (): void => {
    while (running.size < limit && waiting.length) {
      const e = waiting.shift()!
      running.add(e)
      let work: Promise<unknown>
      try {
        work = e.run(e.controller.signal)
      } catch (err) {
        work = Promise.reject(err)
      }
      const done = (how: () => void): void => {
        running.delete(e)
        settle(e, how)
        pump()
      }
      work.then(
        (v) => done(() => (e.controller.signal.aborted ? e.reject(new CancelledError()) : e.resolve(v))),
        (err) => done(() => e.reject(e.controller.signal.aborted ? new CancelledError() : err))
      )
    }
  }
  const live = (e: Entry): boolean => !e.controller.signal.aborted
  const cancel = (id: string): boolean => {
    const i = waiting.findIndex((e) => e.id === id)
    if (i >= 0) {
      const [e] = waiting.splice(i, 1)
      e.controller.abort()
      settle(e, () => e.reject(new CancelledError()))
      return true
    }
    const r = [...running].find((e) => e.id === id && live(e))
    if (!r) return false
    // Settled now; the slot frees when its work stops (the signal tells it to).
    r.controller.abort()
    settle(r, () => r.reject(new CancelledError()))
    return true
  }
  return {
    add<T>(job: QueueJob<T>): Promise<T> {
      cancel(job.id)
      return new Promise<T>((resolve, reject) => {
        waiting.push({ id: job.id, run: job.run, controller: new AbortController(), settled: false, resolve: resolve as (v: unknown) => void, reject })
        pump()
      })
    },
    cancel,
    cancelAll() {
      for (const e of [...waiting]) cancel(e.id)
      for (const e of [...running]) cancel(e.id)
    },
    get running() {
      return [...running].filter(live).map((e) => e.id)
    },
    get waiting() {
      return waiting.map((e) => e.id)
    },
    get busy() {
      return running.size
    }
  }
}
