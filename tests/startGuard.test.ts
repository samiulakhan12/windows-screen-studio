import { describe, expect, it } from 'vitest'
import { startGuard, waitThenStart } from '../src/shared/jobs/startGuard'

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

/** A probe that ends when `end` is called. */
function slowProbe(): { probe: Promise<void>; end: () => void } {
  let end = (): void => undefined
  const probe = new Promise<void>((r) => (end = r))
  return { probe, end }
}

describe('waitThenStart', () => {
  it('shows the wait, then starts the export the dialog shows when the probe ends, not the one of the click', async () => {
    const shown: boolean[] = []
    const click = waitThenStart({ waiting: (on) => shown.push(on), open: () => true })
    const started: string[] = []
    let dialog = (): Promise<void> => Promise.resolve(void started.push('HEVC'))
    const { probe, end } = slowProbe()
    const first = click(probe, () => dialog)
    expect(shown).toEqual([true])
    // The user switches Codec to H.264 while the button says Checking this PC…, and clicks again.
    dialog = () => Promise.resolve(void started.push('H.264'))
    await click(probe, () => dialog)
    expect(started).toEqual([])
    end()
    await first
    expect(shown).toEqual([true, false])
    expect(started).toEqual(['H.264'])
  })

  it('starts at once when no probe is waited for, and nothing when the dialog cannot export', async () => {
    const shown: boolean[] = []
    const click = waitThenStart({ waiting: (on) => shown.push(on), open: () => true })
    let runs = 0
    await click(null, () => async () => void runs++)
    expect(runs).toBe(1)
    const { probe, end } = slowProbe()
    const waited = click(probe, () => null)
    end()
    await waited
    expect(runs).toBe(1)
    expect(shown).toEqual([true, false])
  })

  it('starts nothing when the dialog was closed during the wait', async () => {
    let open = true
    const shown: boolean[] = []
    const click = waitThenStart({ waiting: (on) => shown.push(on), open: () => open })
    let runs = 0
    const { probe, end } = slowProbe()
    const waited = click(probe, () => async () => void runs++)
    open = false
    end()
    await waited
    expect(runs).toBe(0)
    expect(shown).toEqual([true])
  })
})
