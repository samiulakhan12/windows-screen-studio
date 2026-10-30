/**
 * A small job queue for the copy pack (docs/design/publish-pack.md §4.6): at most `limit` jobs run at
 * once, in the order they were added; a waiting job can be taken out and a running one is told to stop
 * through its signal. Pure (no timers, no window).
 */

export interface QueueJob<T> {
  id: string
  /** Starts the work; `signal` aborts when the job is cancelled. */
  run: (signal: AbortSignal) => Promise<T>
}

export interface JobQueue {
  /** Adds a job; resolves or rejects with it. A cancelled job rejects with a CancelledError. */
  add<T>(job: QueueJob<T>): Promise<T>
  /** Cancels job `id`, waiting or running; false when there is none. */
  cancel(id: string): boolean
  cancelAll(): void
  /** Ids running now, and waiting in order. */
  readonly running: readonly string[]
  readonly waiting: readonly string[]
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
  resolve: (v: unknown) => void
  reject: (e: unknown) => void
}

export function createQueue(limit = 2): JobQueue {
  const waiting: Entry[] = []
  const running = new Map<string, Entry>()
  const pump = (): void => {
    while (running.size < limit && waiting.length) {
      const e = waiting.shift()!
      running.set(e.id, e)
      let work: Promise<unknown>
      try {
        work = e.run(e.controller.signal)
      } catch (err) {
        work = Promise.reject(err)
      }
      work.then(
        (v) => finish(e, () => (e.controller.signal.aborted ? e.reject(new CancelledError()) : e.resolve(v))),
        (err) => finish(e, () => e.reject(e.controller.signal.aborted ? new CancelledError() : err))
      )
    }
  }
  const finish = (e: Entry, settle: () => void): void => {
    if (running.get(e.id) === e) running.delete(e.id)
    settle()
    pump()
  }
  const cancel = (id: string): boolean => {
    const i = waiting.findIndex((e) => e.id === id)
    if (i >= 0) {
      const [e] = waiting.splice(i, 1)
      e.controller.abort()
      e.reject(new CancelledError())
      return true
    }
    const r = running.get(id)
    if (!r) return false
    // Settled at once; its work stops through the signal, and the slot frees now.
    running.delete(id)
    r.controller.abort()
    r.reject(new CancelledError())
    pump()
    return true
  }
  return {
    add<T>(job: QueueJob<T>): Promise<T> {
      cancel(job.id)
      return new Promise<T>((resolve, reject) => {
        waiting.push({ id: job.id, run: job.run, controller: new AbortController(), resolve: resolve as (v: unknown) => void, reject })
        pump()
      })
    },
    cancel,
    cancelAll() {
      for (const e of [...waiting]) cancel(e.id)
      for (const id of [...running.keys()]) cancel(id)
    },
    get running() {
      return [...running.keys()]
    },
    get waiting() {
      return waiting.map((e) => e.id)
    }
  }
}
