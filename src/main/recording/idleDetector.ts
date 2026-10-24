/**
 * Auto-pause: notices when there has been no mouse or keyboard input for a while, and the
 * next input after that.
 *
 * Cheap on purpose: input events (dozens per second while the mouse moves) only store a
 * timestamp. One timer runs at a time; when it fires early because input arrived meanwhile,
 * it is re-armed for the remaining time instead of being reset on every event.
 */

export interface IdleClock {
  now(): number
  setTimeout(cb: () => void, ms: number): unknown
  clearTimeout(handle: unknown): void
}

const realClock: IdleClock = {
  now: () => Date.now(),
  setTimeout: (cb, ms) => setTimeout(cb, ms),
  clearTimeout: (h) => clearTimeout(h as NodeJS.Timeout)
}

export interface IdleCallbacks {
  /** No input for the threshold; `at` is the epoch ms the threshold was reached. */
  onIdle(at: number): void
  /** The first input after onIdle. */
  onActive(at: number): void
}

type State = 'off' | 'watching' | 'idle'

export class IdleDetector {
  private state: State = 'off'
  private last = 0
  private timer: unknown = null

  constructor(
    private readonly thresholdMs: number,
    private readonly callbacks: IdleCallbacks,
    private readonly clock: IdleClock = realClock
  ) {}

  get isIdle(): boolean {
    return this.state === 'idle'
  }

  get watching(): boolean {
    return this.state !== 'off'
  }

  /** Starts (or restarts) watching, counting from `at`. */
  start(at = this.clock.now()): void {
    this.state = 'watching'
    this.last = at
    this.arm(this.thresholdMs)
  }

  /** Mouse or keyboard input happened. */
  activity(at = this.clock.now()): void {
    if (this.state === 'off') return
    if (at > this.last) this.last = at
    if (this.state === 'idle') {
      this.state = 'watching'
      this.arm(this.thresholdMs)
      this.callbacks.onActive(at)
    }
  }

  /** Stops watching (a manual pause, or the end of the recording); start() watches again. */
  stop(): void {
    this.state = 'off'
    this.disarm()
  }

  private arm(ms: number): void {
    this.disarm()
    this.timer = this.clock.setTimeout(() => this.fire(), Math.max(0, ms))
  }

  private disarm(): void {
    if (this.timer !== null) this.clock.clearTimeout(this.timer)
    this.timer = null
  }

  private fire(): void {
    this.timer = null
    if (this.state !== 'watching') return
    const due = this.last + this.thresholdMs
    const now = this.clock.now()
    if (now < due) {
      this.arm(due - now)
      return
    }
    this.state = 'idle'
    this.callbacks.onIdle(due)
  }
}
