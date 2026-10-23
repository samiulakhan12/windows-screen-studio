import { afterEach, describe, expect, it, vi } from 'vitest'
import { rawReadback } from '../src/shared/render/codec'
import { frameCovers, frameIndexAt, frameRate, frameSeekTime, MissCounter } from '../src/shared/render/frameTiming'
import { presentationIndex, type VideoSample } from '../src/shared/render/mp4'
import { BLOCK, RangeReader } from '../src/shared/render/rangeReader'

/** A constant-rate track: frame k starts at k / fps. */
const cfr = (fps: number, frames: number): VideoSample[] =>
  Array.from({ length: frames }, (_, k) => ({ offset: 0, size: 0, time: k / fps, duration: 1 / fps, key: k % 15 === 0 }))

describe('element seeking at the proxy frame rate (audit-A-2 / seams-4)', () => {
  it('reads the frame rate from the sample durations', () => {
    expect(frameRate(cfr(30, 90))).toBeCloseTo(30)
    expect(frameRate(cfr(60, 90))).toBeCloseTo(60)
    expect(frameRate([])).toBeNull()
  })

  for (const sourceFps of [30, 60, 25]) {
    for (const exportFps of [30, 60]) {
      it(`a ${sourceFps} fps source exported at ${exportFps} fps: every seek shows the decoder path's frame`, () => {
        const track = cfr(sourceFps, sourceFps * 4)
        // Export times as the timeline makes them, also shifted by a webcam offset (not on any frame grid).
        for (const offset of [0, 0.0123, -0.4]) {
          for (let i = 0; i < exportFps * 3; i++) {
            const t = i / exportFps + 0.5 - offset
            const decoder = presentationIndex(track, t, 1 / sourceFps / 2)
            const want = frameIndexAt(t, sourceFps)
            // Exactly half way between two frames (every other frame of a 30 fps webcam at
            // 60 fps) either is right; the decoder path's pick then depends on rounding.
            const half = t * sourceFps + 0.5
            const tie = Math.abs(half - Math.round(half)) < 1e-6
            expect(Math.abs(want - decoder)).toBeLessThanOrEqual(tie ? 1 : 0)
            const target = frameSeekTime(t, sourceFps)
            // The seek lands in the middle of that frame, never on a boundary...
            expect(target * sourceFps - want).toBeCloseTo(0.5, 6)
            // ...and the frame's own timestamp verifies at once (no 100 ms wait), its neighbours do not.
            expect(frameCovers(track[want].time, target, sourceFps)).toBe(true)
            if (want > 0) expect(frameCovers(track[want - 1].time, target, sourceFps)).toBe(false)
            if (want + 1 < track.length) expect(frameCovers(track[want + 1].time, target, sourceFps)).toBe(false)
          }
        }
      })
    }
  }

  it('the old fixed 60 fps check rejects every other frame of a 30 fps webcam', () => {
    // What seams-4 measured: target = t + 1/120, accepted window 1/60 wide.
    const track = cfr(30, 120)
    let misses = 0
    for (let i = 0; i < 120; i++) {
      const t = i / 60
      const target = t + 0.5 / 60
      const shown = track[presentationIndex(track, target, 0)]
      if (!frameCovers(shown.time, target, 60)) misses++
    }
    expect(misses).toBe(60)
  })

  it('stops verifying when 3 of the last 8 frames miss, also when they alternate', () => {
    const alternating = new MissCounter()
    const results = [true, false, true, false, true, false]
    expect(results.map((r) => alternating.record(r))).toEqual([true, true, true, true, true, false])
    expect(alternating.checking).toBe(false)
    // Occasional misses (a slow seek now and then) keep checking on.
    const sporadic = new MissCounter()
    for (let i = 0; i < 200; i++) sporadic.record(i % 10 !== 0)
    expect(sporadic.checking).toBe(true)
  })
})

describe('RangeReader (perf-4)', () => {
  afterEach(() => vi.unstubAllGlobals())

  /** A fake media server over `size` bytes; logs every ranged fetch. */
  function serve(size: number): { fetched: number[]; bytes: number } {
    const log = { fetched: [] as number[], bytes: 0 }
    vi.stubGlobal('fetch', async (_url: string, init: { headers: { Range: string } }) => {
      const [, a, b] = /bytes=(\d+)-(\d+)/.exec(init.headers.Range)!
      const start = Number(a)
      const end = Math.min(size - 1, Number(b))
      log.fetched.push(start / BLOCK)
      log.bytes += end - start + 1
      const body = new Uint8Array(end - start + 1).map((_, k) => (start + k) & 0xff)
      return {
        ok: true,
        status: 206,
        headers: { get: (h: string) => (h === 'Content-Range' ? `bytes ${start}-${end}/${size}` : null) },
        arrayBuffer: async () => body.buffer
      }
    })
    return log
  }

  it('fetches each block exactly once when samples are read in order, across block boundaries', async () => {
    const size = 40 * BLOCK + 12345
    const log = serve(size)
    const reader = await RangeReader.open('studio-media://p/screen.mp4')
    let offset = 0
    for (let n = 0; offset < size; n++) {
      // 37 KB samples, plus an occasional large keyframe.
      const length = Math.min(size - offset, n % 50 === 0 ? 600_000 : 37_000)
      const got = await reader.read(offset, length)
      expect(got.length).toBe(length)
      expect(got[0]).toBe(offset & 0xff)
      expect(got[length - 1]).toBe((offset + length - 1) & 0xff)
      offset += length
    }
    expect(log.fetched).toEqual(Array.from({ length: 41 }, (_, k) => k))
    expect(log.bytes).toBe(size)
  })

  it('keeps only the blocks around the read position', async () => {
    serve(20 * BLOCK)
    const reader = await RangeReader.open('studio-media://p/screen.mp4')
    for (let offset = 0; offset < 19 * BLOCK; offset += 100_000) await reader.read(offset, 100_000)
    const blocks = (reader as unknown as { blocks: Map<number, unknown> }).blocks
    expect(blocks.size).toBeLessThanOrEqual(3)
  })

  it('retries a block whose fetch failed', async () => {
    const log = serve(4 * BLOCK)
    const reader = await RangeReader.open('studio-media://p/screen.mp4')
    const real = globalThis.fetch
    let fail = true
    vi.stubGlobal('fetch', async (...args: Parameters<typeof fetch>) => {
      if (fail) {
        fail = false
        throw new Error('network')
      }
      return real(...args)
    })
    await expect(reader.read(BLOCK, 10)).rejects.toThrow('network')
    expect((await reader.read(BLOCK, 10)).length).toBe(10)
    expect(log.fetched).toEqual([0, 1])
  })
})

describe('raw frame readback (perf-2)', () => {
  it('copies 32-bit canvas frames as they are and converts anything else to RGBX', () => {
    expect(rawReadback('BGRA')).toEqual({ pixelFormat: 'bgra' })
    expect(rawReadback('BGRX')).toEqual({ pixelFormat: 'bgr0' })
    expect(rawReadback('RGBA')).toEqual({ pixelFormat: 'rgba' })
    expect(rawReadback('RGBX')).toEqual({ pixelFormat: 'rgb0' })
    expect(rawReadback('NV12')).toEqual({ copyFormat: 'RGBX', pixelFormat: 'rgb0' })
    expect(rawReadback(null)).toEqual({ copyFormat: 'RGBX', pixelFormat: 'rgb0' })
  })
})
