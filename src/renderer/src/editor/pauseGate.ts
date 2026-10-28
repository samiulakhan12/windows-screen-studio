/**
 * Pause for a running export (F-12): the export loop waits here before each frame while paused.
 * Nothing is killed and nothing is written meanwhile; ffmpeg simply waits for its next frame.
 */
export class PauseGate {
  private waiters: (() => void)[] = []
  private pausedNow = false
  private listeners = new Set<(paused: boolean) => void>()

  get paused(): boolean {
    return this.pausedNow
  }

  pause(): void {
    if (this.pausedNow) return
    this.pausedNow = true
    this.emit()
  }

  resume(): void {
    if (!this.pausedNow) return
    this.pausedNow = false
    const waiting = this.waiters
    this.waiters = []
    waiting.forEach((w) => w())
    this.emit()
  }

  /** Resolves at once when running; else when resumed or `signal` aborts. True when it waited. */
  async wait(signal?: AbortSignal): Promise<boolean> {
    if (!this.pausedNow || signal?.aborted) return false
    await new Promise<void>((resolve) => {
      const done = (): void => {
        signal?.removeEventListener('abort', done)
        resolve()
      }
      this.waiters.push(done)
      signal?.addEventListener('abort', done, { once: true })
    })
    return true
  }

  /** Calls `listener` on every pause and resume; returns the unsubscribe. */
  subscribe(listener: (paused: boolean) => void): () => void {
    this.listeners.add(listener)
    return () => this.listeners.delete(listener)
  }

  private emit(): void {
    for (const l of this.listeners) l(this.pausedNow)
  }
}
