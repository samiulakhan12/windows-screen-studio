import { describe, expect, it } from 'vitest'
import { PauseGate } from '../src/renderer/src/editor/pauseGate'
import { progressShare } from '../src/renderer/src/editor/exportJobs'

const tick = (): Promise<void> => new Promise((r) => setTimeout(r, 5))

describe('PauseGate', () => {
  it('lets a running export through at once', async () => {
    expect(await new PauseGate().wait()).toBe(false)
  })

  it('holds while paused and lets go on resume, saying it waited', async () => {
    const gate = new PauseGate()
    const seen: boolean[] = []
    gate.subscribe((p) => seen.push(p))
    gate.pause()
    let done: boolean | null = null
    void gate.wait().then((w) => (done = w))
    await tick()
    expect(done).toBeNull()
    gate.resume()
    await tick()
    expect(done).toBe(true)
    expect(seen).toEqual([true, false])
  })

  it('lets go when the export is cancelled while paused', async () => {
    const gate = new PauseGate()
    const abort = new AbortController()
    gate.pause()
    const waited = gate.wait(abort.signal)
    abort.abort()
    expect(await waited).toBe(true)
    expect(gate.paused).toBe(true)
    expect(await gate.wait(abort.signal)).toBe(false)
  })
})

describe('progressShare', () => {
  it('reports frames while rendering, unknown while finalizing, and pause only while rendering', () => {
    expect(progressShare({ phase: 'rendering', frame: 30, frames: 120 })).toEqual({ fraction: 0.25, pausable: true })
    expect(progressShare({ phase: 'finalizing', frame: 120, frames: 120 })).toEqual({ fraction: null, pausable: false })
    expect(progressShare({ phase: 'preparing', frame: 0, frames: 120 })).toEqual({ fraction: 0, pausable: false })
    expect(progressShare(null)).toEqual({ fraction: 0, pausable: false })
  })
})
