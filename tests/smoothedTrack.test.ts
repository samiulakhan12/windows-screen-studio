import { describe, expect, it } from 'vitest'
import { cursorAt, SmoothedTrack } from '../src/shared/engine/cursor'
import { clamp, lerp } from '../src/shared/engine/math'
import type { CursorSample } from '../src/shared/types'

/** The spring simulation exactly as written before: cursorAt (a binary search) for every step. */
function reference(samples: CursorSample[], duration: number, smoothing: number, hz = 120): { xs: Float32Array; ys: Float32Array } {
  const n = Math.max(1, Math.ceil(duration * hz) + 1)
  const xs = new Float32Array(n)
  const ys = new Float32Array(n)
  const omega = lerp(40, 5, clamp(smoothing, 0, 1))
  const dt = 1 / hz
  let x = samples[0].x
  let y = samples[0].y
  let vx = 0
  let vy = 0
  for (let i = 0; i < n; i++) {
    const target = cursorAt(samples, i * dt)!
    const ax = omega * omega * (target.x - x) - 2 * omega * vx
    const ay = omega * omega * (target.y - y) - 2 * omega * vy
    vx += ax * dt
    vy += ay * dt
    x += vx * dt
    y += vy * dt
    xs[i] = x
    ys[i] = y
  }
  return { xs, ys }
}

/** Rests and eased moves sampled at 60 Hz, with repeated timestamps and a sample before 0. */
function track(seconds: number): CursorSample[] {
  let seed = 3
  const rnd = (): number => (seed = (seed * 1103515245 + 12345) & 0x7fffffff) / 0x7fffffff
  const out: CursorSample[] = [{ t: -0.05, x: 0.2, y: 0.3 }]
  let t = 0.3
  let x = 0.2
  let y = 0.3
  while (t < seconds) {
    const x1 = rnd()
    const y1 = rnd()
    const x0 = x
    const y0 = y
    for (let k = 0; k <= 1 && t < seconds; k += 0.1, t += 1 / 60) {
      x = x0 + (x1 - x0) * k
      y = y0 + (y1 - y0) * k
      out.push({ t, x, y })
      if (rnd() < 0.1) out.push({ t, x: x + 0.01, y })
    }
    t += 0.5 + rnd() * 2
  }
  return out
}

describe('SmoothedTrack (F7)', () => {
  it('gives exactly the path of the per-step binary search', () => {
    for (const [seconds, smoothing] of [[20, 0.6], [45, 0], [30, 1]]) {
      const samples = track(seconds)
      const ref = reference(samples, seconds + 1, smoothing)
      const got = new SmoothedTrack(samples, seconds + 1, smoothing)
      expect(Array.from(got.xs)).toEqual(Array.from(ref.xs))
      expect(Array.from(got.ys)).toEqual(Array.from(ref.ys))
    }
  })

  it('reads the samples in one forward pass, not a search per step', () => {
    const samples = track(600)
    let reads = 0
    const counted = new Proxy(samples, {
      get(target, prop, receiver) {
        if (typeof prop === 'string' && /^\d+$/.test(prop)) reads++
        return Reflect.get(target, prop, receiver)
      }
    })
    const track_ = new SmoothedTrack(counted, 600, 0.6)
    // About one read per step and per sample (a binary search per step reads ~log2(n) times as many).
    expect(reads).toBeLessThan((track_.xs.length + samples.length) * 6)
  })
})
