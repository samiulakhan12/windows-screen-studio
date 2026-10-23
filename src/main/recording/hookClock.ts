/**
 * Converts libuiohook event times to epoch milliseconds.
 *
 * Hook events carry a precise time (X server time on Linux, GetTickCount on Windows:
 * 32-bit milliseconds with an unknown origin) but reach JavaScript in delayed
 * batches. The offset to the epoch is estimated as the smallest observed
 * (receivedAt - eventTime): delivery delay is never negative, so the minimum is the
 * closest estimate. Ticks are unwrapped across the 32-bit rollover.
 */
export class HookClock {
  private last: number | null = null
  private unwrapped = 0
  private offset = Number.POSITIVE_INFINITY

  /** Records an event and returns its unwrapped tick; convert later with toEpoch(). */
  observe(tick: number, receivedAt: number): number {
    if (this.last === null) {
      this.unwrapped = tick
    } else {
      // Signed 32-bit difference handles the rollover.
      this.unwrapped += (tick - this.last) | 0
    }
    this.last = tick
    this.offset = Math.min(this.offset, receivedAt - this.unwrapped)
    return this.unwrapped
  }

  get synced(): boolean {
    return Number.isFinite(this.offset)
  }

  toEpoch(unwrappedTick: number): number {
    return unwrappedTick + (Number.isFinite(this.offset) ? this.offset : 0)
  }
}
