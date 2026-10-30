import { describe, expect, it } from 'vitest'
import { playStretch, type FrameClock, type StretchPlayer } from '../src/shared/review/stretch'
import type { Clip } from '../src/shared/types'

const clips: Clip[] = [
  { id: 'a', start: 0, end: 8, speed: 1 },
  { id: 'b', start: 10.4, end: 20, speed: 1 }
]

class FakePlayer implements StretchPlayer {
  time = 0
  moving = false
  calls: string[] = []
  seek(t: number): void {
    this.time = t
    this.calls.push(`seek ${t}`)
  }
  play(): void {
    this.moving = true
    this.calls.push('play')
  }
  pause(): void {
    this.moving = false
    this.calls.push('pause')
  }
}

function manualClock(): FrameClock & { step(): void } {
  let queue: (() => void)[] = []
  return {
    request: (cb) => (queue.push(cb), queue.length),
    cancel: () => void (queue = []),
    step: () => {
      const q = queue
      queue = []
      for (const cb of q) cb()
    }
  }
}

describe('playStretch', () => {
  it('seeks, plays and pauses at the end of the stretch (output time, across the cut)', () => {
    const player = new FakePlayer()
    const clock = manualClock()
    playStretch(player, () => clips, { from: 6.5, until: 9.5 }, clock)
    expect(player.calls).toEqual(['seek 6.5', 'play'])
    // Across the cut: 11.9 s of source is 9.5 s of output (2.4 s cut).
    for (const t of [6.9, 7.3, 7.7, 10.5, 10.9, 11.3, 11.7]) {
      player.time = t
      clock.step()
      expect(player.moving).toBe(true)
    }
    player.time = 11.9
    clock.step()
    expect(player.calls.at(-1)).toBe('pause')
    expect(player.moving).toBe(false)
  })

  it('ends without pausing when something else stopped or moved playback', () => {
    const player = new FakePlayer()
    const clock = manualClock()
    playStretch(player, () => clips, { from: 6.5, until: 9.5 }, clock)
    player.moving = false
    clock.step()
    player.moving = true
    player.time = 11.95
    clock.step()
    expect(player.calls).toEqual(['seek 6.5', 'play'])
    // A seek back or ahead (a click on the timeline) ends it too, without pausing.
    const p2 = new FakePlayer()
    const c2 = manualClock()
    playStretch(p2, () => clips, { from: 6.5, until: 9.5 }, c2)
    p2.time = 2
    c2.step()
    p2.time = 30
    c2.step()
    expect(p2.calls).toEqual(['seek 6.5', 'play'])
  })

  it('the stop function pauses only while the stretch is playing', () => {
    const player = new FakePlayer()
    const clock = manualClock()
    const stop = playStretch(player, () => clips, { from: 6.5, until: 9.5 }, clock)
    stop()
    expect(player.calls.at(-1)).toBe('pause')
    stop()
    expect(player.calls.filter((c) => c === 'pause')).toHaveLength(1)
  })
})

describe('playStretch: a seek ahead', () => {
  it('ends the stretch and leaves the playback going', () => {
    const player = new FakePlayer()
    const clock = manualClock()
    playStretch(player, () => clips, { from: 6.5, until: 9.5 }, clock)
    player.time = 15
    clock.step()
    player.time = 15.1
    clock.step()
    expect(player.calls).toEqual(['seek 6.5', 'play'])
    expect(player.moving).toBe(true)
  })
})
