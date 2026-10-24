// windows-9: every epoch time the renderer shares with the main process (Date.now())
// and the native helper (system time) must be on the wall clock, even after it drifted
// away from performance.timeOrigin (time sync, resume from sleep).
import { afterEach, describe, expect, it, vi } from 'vitest'

afterEach(() => {
  vi.restoreAllMocks()
  vi.resetModules()
})

describe('epochNow', () => {
  it('follows Date.now() after syncEpoch, even when timeOrigin has drifted', async () => {
    let perf = 1_000_000
    // performance.now() advances 0.05 ms per read; the wall clock was stepped 250 ms
    // ahead of performance.timeOrigin + performance.now() (e.g. by a time sync).
    vi.spyOn(performance, 'now').mockImplementation(() => (perf += 0.05))
    const wall = (): number => performance.timeOrigin + perf + 250
    vi.spyOn(Date, 'now').mockImplementation(() => Math.floor(wall()))
    const { epochNow, syncEpoch } = await import('../src/shared/recording/epochClock')
    syncEpoch()
    const truth = wall()
    expect(Math.abs(epochNow() - truth)).toBeLessThan(0.3)
  })

  it('does not hang when the clock does not move', async () => {
    vi.spyOn(performance, 'now').mockReturnValue(5)
    vi.spyOn(Date, 'now').mockReturnValue(1_700_000_000_000)
    const { epochNow, syncEpoch } = await import('../src/shared/recording/epochClock')
    syncEpoch()
    expect(epochNow()).toBe(1_700_000_000_000)
  })
})
