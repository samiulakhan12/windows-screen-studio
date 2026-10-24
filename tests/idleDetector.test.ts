import { describe, expect, it } from 'vitest'
import { IdleDetector, type IdleClock } from '../src/main/recording/idleDetector'

/** A manual clock: timers fire only when advance() passes their time. */
function fakeClock(start = 1_000_000) {
  let now = start
  let nextId = 1
  const timers = new Map<number, { at: number; cb: () => void }>()
  const clock: IdleClock = {
    now: () => now,
    setTimeout: (cb, ms) => {
      const id = nextId++
      timers.set(id, { at: now + ms, cb })
      return id
    },
    clearTimeout: (h) => void timers.delete(h as number)
  }
  const advance = (ms: number): void => {
    const end = now + ms
    for (;;) {
      const due = [...timers.entries()].filter(([, t]) => t.at <= end).sort((a, b) => a[1].at - b[1].at)[0]
      if (!due) break
      timers.delete(due[0])
      now = due[1].at
      due[1].cb()
    }
    now = end
  }
  return { clock, advance, pending: () => timers.size, get now() { return now } }
}

function detector(thresholdMs = 10_000) {
  const c = fakeClock()
  const events: string[] = []
  const d = new IdleDetector(thresholdMs, { onIdle: (at) => events.push(`idle@${at - 1_000_000}`), onActive: (at) => events.push(`active@${at - 1_000_000}`) }, c.clock)
  return { c, d, events }
}

describe('IdleDetector', () => {
  it('reports idle once the threshold passes without input, at the exact instant', () => {
    const { c, d, events } = detector()
    d.start()
    c.advance(9_999)
    expect(events).toEqual([])
    c.advance(1)
    expect(events).toEqual(['idle@10000'])
    expect(d.isIdle).toBe(true)
    // Staying idle reports nothing more and leaves no timer running.
    c.advance(60_000)
    expect(events).toEqual(['idle@10000'])
    expect(c.pending()).toBe(0)
  })

  it('input pushes idle back by the full threshold, without re-arming a timer per event', () => {
    const { c, d, events } = detector()
    d.start()
    for (let i = 0; i < 100; i++) {
      c.advance(50)
      d.activity()
    }
    // 100 events, still a single timer.
    expect(c.pending()).toBe(1)
    c.advance(9_999)
    expect(events).toEqual([])
    c.advance(1)
    expect(events).toEqual(['idle@15000'])
  })

  it('reports the first input after idle, then watches again', () => {
    const { c, d, events } = detector(3_000)
    d.start()
    c.advance(3_000)
    c.advance(2_000)
    d.activity()
    d.activity()
    expect(events).toEqual(['idle@3000', 'active@5000'])
    expect(d.isIdle).toBe(false)
    c.advance(3_000)
    expect(events).toEqual(['idle@3000', 'active@5000', 'idle@8000'])
  })

  it('ignores input while stopped (manual pause) and counts from start() again', () => {
    const { c, d, events } = detector(3_000)
    d.start()
    c.advance(1_000)
    d.stop()
    expect(d.watching).toBe(false)
    expect(c.pending()).toBe(0)
    c.advance(10_000)
    d.activity()
    expect(events).toEqual([])
    d.start()
    c.advance(2_999)
    expect(events).toEqual([])
    c.advance(1)
    expect(events).toEqual(['idle@14000'])
  })

  it('takes late event timestamps into account but never moves backwards', () => {
    const { c, d, events } = detector(3_000)
    d.start()
    c.advance(2_000)
    // A hook event delivered late, stamped 1.5 s in.
    d.activity(c.now - 500)
    // An older one arriving after it changes nothing.
    d.activity(c.now - 1_500)
    c.advance(2_499)
    expect(events).toEqual([])
    c.advance(1)
    expect(events).toEqual(['idle@4500'])
  })
})
