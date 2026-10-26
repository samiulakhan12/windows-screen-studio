import { describe, expect, it } from 'vitest'
import { regionToRect, sanitizeRegion, toolbarPosition } from '../src/main/recording/placement'
import { parseInputHasAudio, parseInputSize, parseProgressFrame, summarizeFfmpegLog } from '../src/main/recording/proxyRunner'
import { ChunkPipe } from '../src/shared/recording/chunkPipe'
import { friendlyError, RecorderError, SOURCE_GONE, stripIpcPrefix } from '../src/shared/recording/errors'
import { pickMime, screenBitrate, screenMimes } from '../src/shared/recording/mime'
import { boxFromPoints, isUsable, isUsableRegion, MIN_SIZE, moveBox, pixelSize, resizeBox, toNormRect } from '../src/shared/recording/regionGeometry'

describe('MediaRecorder format choice', () => {
  it('prefers H.264, then VP8, then VP9', () => {
    const supported = new Set(['video/webm;codecs=vp8,opus', 'video/webm;codecs=vp9,opus', 'video/webm;codecs=h264,opus'])
    expect(pickMime(screenMimes(true), (m) => supported.has(m))).toBe('video/webm;codecs=h264,opus')
    supported.delete('video/webm;codecs=h264,opus')
    expect(pickMime(screenMimes(true), (m) => supported.has(m))).toBe('video/webm;codecs=vp8,opus')
    expect(screenMimes(false)[0]).toBe('video/webm;codecs=h264')
  })

  it('skips H.264 when not allowed (odd frame sizes)', () => {
    expect(screenMimes(false, false)[0]).toBe('video/webm;codecs=vp8')
  })

  it('caps the bitrate for large screens', () => {
    expect(screenBitrate(1920, 1080)).toBe(Math.round(1920 * 1080 * 60 * 0.1))
    expect(screenBitrate(3840, 2160)).toBe(32e6)
    expect(screenBitrate(320, 200)).toBe(4e6)
  })
})

describe('friendly errors', () => {
  it('strips the IPC wrapper', () => {
    expect(stripIpcPrefix("Error invoking remote method 'recording:prepare': Error: A recording is already in progress.")).toBe(
      'A recording is already in progress.'
    )
  })

  it('explains missing devices instead of an empty message', () => {
    const err = friendlyError({ name: 'OverconstrainedError', message: '' }, 'microphone')
    expect(err.message).toMatch(/microphone is not connected/)
  })

  it('points to the Windows privacy setting when access is blocked', () => {
    const err = friendlyError({ name: 'NotAllowedError', message: 'Permission denied' }, 'camera')
    expect(err.privacy).toBe('camera')
    expect(err.message).toMatch(/Privacy & security › Camera/)
  })

  it('maps a vanished capture source', () => {
    expect(friendlyError({ name: 'NotFoundError', message: '' }, 'screen').message).toBe(SOURCE_GONE)
  })

  it('keeps messages that are already friendly', () => {
    const e = new RecorderError('Nice message')
    expect(friendlyError(e)).toBe(e)
    expect(friendlyError(new Error('')).message).toBe('Recording failed for an unknown reason.')
  })
})

describe('ChunkPipe', () => {
  const blob = (bytes: number[], delay = 0) => ({
    size: bytes.length,
    arrayBuffer: () => new Promise<ArrayBuffer>((r) => setTimeout(() => r(new Uint8Array(bytes).buffer), delay))
  })

  it('delivers chunks in order even when reading them takes different times', async () => {
    const got: number[] = []
    const pipe = new ChunkPipe(async (d) => void got.push(d[0]), () => undefined)
    pipe.push(blob([1], 20))
    pipe.push(blob([2], 0))
    pipe.push(blob([3], 5))
    await pipe.flush()
    expect(got).toEqual([1, 2, 3])
    expect(pipe.bytes).toBe(3)
  })

  it('stops after the first failure and reports it once', async () => {
    const errors: unknown[] = []
    let calls = 0
    const pipe = new ChunkPipe(
      async () => {
        calls++
        throw new Error('disk full')
      },
      (e) => errors.push(e)
    )
    pipe.push(blob([1]))
    pipe.push(blob([2]))
    await pipe.flush()
    expect(calls).toBe(1)
    expect(errors).toHaveLength(1)
    expect(pipe.error).toBeInstanceOf(Error)
  })
})

describe('region overlay geometry', () => {
  const bounds = { w: 1000, h: 500 }

  it('builds a box from a drag in any direction, inside the display', () => {
    expect(boxFromPoints({ x: 300, y: 200 }, { x: 100, y: 50 }, bounds)).toEqual({ x: 100, y: 50, w: 200, h: 150 })
    expect(boxFromPoints({ x: 900, y: 400 }, { x: 1200, y: 700 }, bounds)).toEqual({ x: 900, y: 400, w: 100, h: 100 })
  })

  it('moves and resizes without leaving the display or collapsing', () => {
    const box = { x: 100, y: 100, w: 200, h: 100 }
    expect(moveBox(box, 900, -500, bounds)).toEqual({ x: 800, y: 0, w: 200, h: 100 })
    expect(resizeBox(box, 'se', 50, 20, bounds)).toEqual({ x: 100, y: 100, w: 250, h: 120 })
    expect(resizeBox(box, 'w', 500, 0, bounds)).toEqual({ x: 268, y: 100, w: 32, h: 100 })
    expect(resizeBox(box, 'n', 0, -500, bounds)).toEqual({ x: 100, y: 0, w: 200, h: 200 })
  })

  it('normalises and sizes the result', () => {
    const box = { x: 250, y: 125, w: 500, h: 250 }
    expect(toNormRect(box, bounds)).toEqual({ x: 0.25, y: 0.25, w: 0.5, h: 0.5 })
    expect(pixelSize({ x: 0, y: 0, w: 333, h: 101 }, 1.5)).toEqual({ width: 498, height: 150 })
    expect(isUsable({ x: 0, y: 0, w: 10, h: 100 })).toBe(false)
  })
})

describe('region validation and toolbar placement', () => {
  const fullHd = { width: 1920, height: 1080 }

  it('rejects malformed or tiny regions and clamps to the display', () => {
    expect(sanitizeRegion(null, fullHd)).toBeNull()
    expect(sanitizeRegion({ x: 'a', y: 0, w: 1, h: 1 }, fullHd)).toBeNull()
    expect(sanitizeRegion({ x: 0, y: 0, w: 20 / 1920, h: 0.5 }, fullHd)).toBeNull()
    expect(sanitizeRegion({ x: 0.5, y: -0.1, w: 0.8, h: 0.5 }, fullHd)).toEqual({ x: 0.5, y: 0, w: 0.5, h: 0.5 })
  })

  it('accepts exactly what the picker offers: one minimum-size rule (seams-6)', () => {
    for (const display of [fullHd, { width: 3840, height: 2160 }, { width: 1366, height: 768 }]) {
      const bounds = { w: display.width, h: display.height }
      // The smallest box the overlay enables "Record this area" for…
      const smallest = { x: display.width - MIN_SIZE, y: 10, w: MIN_SIZE, h: MIN_SIZE }
      expect(isUsable(smallest)).toBe(true)
      // …is accepted by the main process (it used to require 2% of the display).
      expect(sanitizeRegion(toNormRect(smallest, bounds), display)).not.toBeNull()
      expect(isUsableRegion(toNormRect(smallest, bounds), bounds)).toBe(true)
      // A box the overlay refuses is refused by main too.
      const tooSmall = { x: 0, y: 0, w: MIN_SIZE - 2, h: 200 }
      expect(isUsable(tooSmall)).toBe(false)
      expect(sanitizeRegion(toNormRect(tooSmall, bounds), display)).toBeNull()
    }
    // The case from the review: 35 x 200 DIP on a 1920-wide display.
    expect(sanitizeRegion(toNormRect({ x: 100, y: 100, w: 35, h: 200 }, { w: 1920, h: 1080 }), fullHd)).not.toBeNull()
  })

  it('maps a region to DIP on its display', () => {
    expect(regionToRect({ x: 0.5, y: 0.5, w: 0.25, h: 0.5 }, { x: 1920, y: 0, width: 1600, height: 900 })).toEqual({
      x: 2720,
      y: 450,
      width: 400,
      height: 450
    })
  })

  it('places the toolbar bottom-centre, or next to a region instead of over it', () => {
    const wa = { x: 0, y: 0, width: 1920, height: 1040 }
    const size = { width: 360, height: 64 }
    expect(toolbarPosition(wa, size)).toEqual({ x: 780, y: 952 })
    expect(toolbarPosition(wa, size, { x: 100, y: 100, width: 400, height: 300 })).toEqual({ x: 120, y: 412 })
    expect(toolbarPosition(wa, size, { x: 100, y: 600, width: 400, height: 420 })).toEqual({ x: 120, y: 524 })
    expect(toolbarPosition(wa, size, { x: 0, y: 0, width: 1920, height: 1040 })).toEqual({ x: 780, y: 952 })
  })

  it('never puts the bar under the speaker notes, and keeps it out of the recorded area when it can', () => {
    const wa = { x: 0, y: 0, width: 1920, height: 1040 }
    const bar = { width: 600, height: 64 }
    const notes = { x: 680, y: 8, width: 560, height: 240 }
    const hits = (p: { x: number; y: number }, r: { x: number; y: number; width: number; height: number }): boolean =>
      p.x < r.x + r.width && r.x < p.x + bar.width && p.y < r.y + r.height && r.y < p.y + bar.height
    // An area from `top` to the bottom: no room below it, and the spot above it is under the notes,
    // so the bar goes to the left of the notes at that height, outside the area (on Windows before
    // 10 version 2004 a bar inside it is a black box in the video).
    for (const top of [80, 130, 200, 300, 320]) {
      const area = { x: 0, y: top, width: 1920, height: 1040 - top }
      expect(hits(toolbarPosition(wa, bar, area), notes)).toBe(true)
      const p = toolbarPosition(wa, bar, area, [notes])
      expect(p).toEqual({ x: 68, y: top - 64 - 12 })
      expect(hits(p, notes)).toBe(false)
      expect(hits(p, area)).toBe(false)
    }
    // No room to the left: to the right.
    const right = { x: 300, y: 8, width: 560, height: 240 }
    expect(toolbarPosition(wa, bar, { x: 0, y: 300, width: 1920, height: 740 }, [right])).toEqual({ x: 872, y: 224 })
    // An area at the top: the spot below it is under the notes too, so beside them below the area.
    expect(toolbarPosition(wa, bar, { x: 0, y: 0, width: 1920, height: 170 }, [notes])).toEqual({ x: 68, y: 182 })
    // The whole screen: nothing is outside it, so the bottom-centre, clear of the notes.
    expect(toolbarPosition(wa, bar, { x: 0, y: 0, width: 1920, height: 1040 }, [notes])).toEqual({ x: 660, y: 952 })
    // Nothing clear of both: outside the area wins over clear of the notes.
    const wide = { x: 0, y: 8, width: 1920, height: 240 }
    const below = toolbarPosition(wa, bar, { x: 0, y: 300, width: 1920, height: 740 }, [wide])
    expect(hits(below, { x: 0, y: 300, width: 1920, height: 740 })).toBe(false)
    expect(below).toEqual({ x: 660, y: 224 })
    // Spots that are clear stay as they were.
    expect(toolbarPosition(wa, bar, { x: 100, y: 400, width: 400, height: 300 }, [notes])).toEqual(toolbarPosition(wa, bar, { x: 100, y: 400, width: 400, height: 300 }))
    // Notes moved to the bottom centre: the bar goes just above them.
    const low = { x: 680, y: 790, width: 560, height: 240 }
    expect(toolbarPosition(wa, bar, null, [low])).toEqual({ x: 660, y: 790 - 64 - 12 })
  })

  it('keeps the bar on the recorded display when the notes are on another one', () => {
    const bar = { width: 600, height: 64 }
    const within = (p: { x: number; y: number }, w: { x: number; y: number; width: number; height: number }): boolean =>
      p.x >= w.x && p.y >= w.y && p.x + bar.width <= w.x + w.width && p.y + bar.height <= w.y + w.height
    // A 1920 x 1080 display left of a taller primary and lower than it; the notes at the top
    // centre of the primary; a full-height area: the bar stays at the bottom centre of the
    // recorded display (just below the notes would be above it, on no display at all).
    const left = { x: -1920, y: 360, width: 1920, height: 1040 }
    const p = toolbarPosition(left, bar, { x: -1920, y: 360, width: 1200, height: 1080 }, [{ x: 1000, y: 8, width: 560, height: 240 }])
    expect(p).toEqual({ x: -1260, y: 1312 })
    expect(within(p, left)).toBe(true)
    // A portrait display on the right, raised, with the notes at its top; a nearly full area.
    const wa = { x: 0, y: 0, width: 1920, height: 1040 }
    const q = toolbarPosition(wa, bar, { x: 0, y: 40, width: 1920, height: 960 }, [{ x: 2180, y: -420, width: 560, height: 240 }])
    expect(q).toEqual({ x: 660, y: 952 })
    expect(within(q, wa)).toBe(true)
  })
})

describe('ffmpeg output parsing', () => {
  it('reads the frame count from progress output', () => {
    expect(parseProgressFrame('frame=120')).toBe(120)
    expect(parseProgressFrame('frame=  7')).toBe(7)
    expect(parseProgressFrame('fps=59.9')).toBeNull()
    expect(parseProgressFrame('out_time_us=1500000')).toBeNull()
  })

  const log = [
    "Input #0, matroska,webm, from 'screen.webm':",
    '  Stream #0:0(eng): Video: h264 (Constrained Baseline), yuv420p(progressive), 1920x1080, SAR 1:1 DAR 16:9, 60 fps',
    '  Stream #0:1(eng): Audio: opus, 48000 Hz, stereo, fltp',
    "Output #0, mp4, to 'screen.mp4':",
    '  Stream #0:0: Video: h264, yuv420p, 1280x720'
  ].join('\n')

  it('finds the input video size and audio', () => {
    expect(parseInputSize(log)).toEqual({ width: 1920, height: 1080 })
    expect(parseInputHasAudio(log)).toBe(true)
    expect(parseInputHasAudio(log.replace(/.*Audio.*\n/, ''))).toBe(false)
  })

  it('summarises a failure with its last meaningful line', () => {
    expect(summarizeFfmpegLog('blah\n[matroska,webm @ 0x1] EBML header parsing failed\nscreen.webm: Invalid data found when processing input\n')).toBe(
      'screen.webm: Invalid data found when processing input'
    )
  })
})
