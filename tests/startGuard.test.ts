import { describe, expect, it } from 'vitest'
import { startGuard } from '../src/shared/jobs/startGuard'

/*
 * The export dialog's Export buttons (output-and-languages §2.1): the HEVC probe and the save dialog
 * may take seconds before the export shows its progress. A second click meanwhile must not open a
 * second dialog, whose export would replace or cancel the first one.
 */

/** A step that waits until `done` is called, counting how often it ran. */
function slowStep<T>(value: T): { ask: () => Promise<T>; done: () => void; runs: () => number } {
  let runs = 0
  let resolve: (() => void) | null = null
  const ask = (): Promise<T> => {
    runs++
    return new Promise<T>((r) => (resolve = () => r(value)))
  }
  return { ask, done: () => resolve?.(), runs: () => runs }
}

describe('startGuard', () => {
  it('runs one start at a time: a second click while the first waits does nothing', async () => {
    const guard = startGuard(() => false)
    const step = slowStep('/v/out.mp4')
    const first = guard(step.ask)
    const second = guard(step.ask)
    expect(await second).toBeNull()
    step.done()
    expect(await first).toBe('/v/out.mp4')
    expect(step.runs()).toBe(1)
  })

  it('lets the next start through once the first has its answer, or failed', async () => {
    const guard = startGuard(() => false)
    expect(await guard(async () => null)).toBeNull()
    expect(await guard(async () => 'again')).toBe('again')
    await expect(guard(async () => Promise.reject(new Error('probe failed')))).rejects.toThrow('probe failed')
    expect(await guard(async () => 'after')).toBe('after')
  })

  it('starts nothing while an export runs', async () => {
    let running = true
    const guard = startGuard(() => running)
    let asked = 0
    expect(await guard(async () => ++asked)).toBeNull()
    running = false
    expect(await guard(async () => ++asked)).toBe(1)
  })
})
