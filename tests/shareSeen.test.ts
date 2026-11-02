import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'
import { SEEN_MS, switchOn, whenOnScreen } from '../src/shared/share/onScreen'

type Callback = (entries: { isIntersecting: boolean }[]) => void

/** A stand-in for IntersectionObserver that the test drives by hand. */
function fakeObserver(): { Observer: new (cb: Callback) => { observe(el: object): void; disconnect(): void }; show: (on: boolean) => void; watching: () => number } {
  const live = new Set<Callback>()
  class Observer {
    constructor(private cb: Callback) {
      live.add(cb)
    }
    observe(): void {}
    disconnect(): void {
      live.delete(this.cb)
    }
  }
  const show = (on: boolean): void => {
    for (const cb of [...live]) cb([{ isIntersecting: on }])
  }
  return { Observer, show, watching: () => live.size }
}

describe('Settings › Share counts as seen', () => {
  beforeEach(() => vi.useFakeTimers())
  afterEach(() => vi.useRealTimers())

  it('only once the found folders stay on screen, not when Settings opens scrolled elsewhere', () => {
    const io = fakeObserver()
    let seen = 0
    whenOnScreen({}, () => seen++, io.Observer)
    io.show(false)
    vi.advanceTimersByTime(5000)
    expect(seen).toBe(0)
    io.show(true)
    vi.advanceTimersByTime(SEEN_MS)
    io.show(true)
    vi.advanceTimersByTime(SEEN_MS)
    expect(seen).toBe(1)
    expect(io.watching()).toBe(0)
  })

  it('not when the page is still loading and pushes them past for a moment, or on a quick scroll past', () => {
    const io = fakeObserver()
    let seen = 0
    whenOnScreen({}, () => seen++, io.Observer)
    io.show(true)
    vi.advanceTimersByTime(10)
    io.show(false)
    vi.advanceTimersByTime(5000)
    expect(seen).toBe(0)
    expect(io.watching()).toBe(1)
  })

  it('stops watching when Settings closes first', () => {
    const io = fakeObserver()
    let seen = 0
    const stop = whenOnScreen({}, () => seen++, io.Observer)
    io.show(true)
    stop()
    vi.advanceTimersByTime(5000)
    io.show(true)
    vi.advanceTimersByTime(5000)
    expect(seen).toBe(0)
  })
})

describe('the "Use" switches of Settings › Share', () => {
  it('show found folders on before their list is seen, so a switch does not turn on under the user', () => {
    // Not yet offered (main says off) but shown as they will be once seen.
    expect(switchOn({ on: false, source: 'app' }, false)).toBe(true)
    expect(switchOn({ on: false, source: 'usual' }, false)).toBe(true)
    // Once seen, as main says: on, or turned off by the user.
    expect(switchOn({ on: true, source: 'app' }, true)).toBe(true)
    expect(switchOn({ on: false, source: 'app' }, true)).toBe(false)
  })

  it("show a folder of the user's own as it is", () => {
    expect(switchOn({ on: false, source: 'picked' }, false)).toBe(false)
    expect(switchOn({ on: true, source: 'picked' }, false)).toBe(true)
    expect(switchOn({ on: false, source: 'picked' }, true)).toBe(false)
  })
})
