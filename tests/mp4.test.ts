import { execFileSync } from 'node:child_process'
import { mkdtempSync, readFileSync, rmSync } from 'node:fs'
import { tmpdir } from 'node:os'
import path from 'node:path'
import { afterAll, describe, expect, it } from 'vitest'
import { ffmpegPath } from '../src/main/ffmpeg'
import { planFeed } from '../src/shared/render/feedPlan'
import { demuxVideoTrack, presentationIndex, type VideoSample } from '../src/shared/render/mp4'

const dir = mkdtempSync(path.join(tmpdir(), 'ssw-mp4-'))
afterAll(() => rmSync(dir, { recursive: true, force: true }))

function encode(name: string, extra: string[]): Uint8Array {
  const file = path.join(dir, name)
  execFileSync(ffmpegPath(), [
    '-v', 'error', '-y', '-f', 'lavfi', '-i', 'testsrc2=size=320x240:rate=60', '-t', '2',
    '-c:v', 'libx264', '-pix_fmt', 'yuv420p', '-g', '15', ...extra, file
  ])
  return new Uint8Array(readFileSync(file))
}

const reader = (bytes: Uint8Array) => async (offset: number, length: number) => bytes.subarray(offset, offset + length)

describe('demuxVideoTrack', () => {
  it('reads a faststart proxy with B-frames (like the app makes)', async () => {
    const bytes = encode('bframes.mp4', ['-preset', 'veryfast', '-movflags', '+faststart'])
    const track = await demuxVideoTrack(reader(bytes), bytes.length)
    expect(track.codec).toMatch(/^avc1\.64/)
    expect(track.codedWidth).toBe(320)
    expect(track.codedHeight).toBe(240)
    expect(track.samples).toHaveLength(120)
    expect(track.samples.filter((s) => s.key)).toHaveLength(8)
    expect(track.samples[0].key).toBe(true)
    // Presentation times after the edit list are exactly i / 60, as a <video> element reports them.
    const times = track.samples.map((s) => s.time).sort((a, b) => a - b)
    times.forEach((t, i) => expect(t).toBeCloseTo(i / 60, 6))
    // Decode order differs from presentation order (B-frames).
    expect(track.samples.some((s, i) => i > 0 && s.time < track.samples[i - 1].time)).toBe(true)
    // Sample bytes are where the table says: every keyframe starts with an H.264 length-prefixed NAL.
    for (const s of track.samples.filter((x) => x.key)) {
      const len = (bytes[s.offset] << 24) | (bytes[s.offset + 1] << 16) | (bytes[s.offset + 2] << 8) | bytes[s.offset + 3]
      expect(len).toBeGreaterThan(0)
      expect(len).toBeLessThanOrEqual(s.size - 4)
    }
  })

  it('finds the moov box at the end of a non-faststart file', async () => {
    const bytes = encode('tail.mp4', ['-preset', 'ultrafast'])
    const track = await demuxVideoTrack(reader(bytes), bytes.length)
    expect(track.samples).toHaveLength(120)
    expect(track.samples.every((s, i) => i === 0 || s.offset > track.samples[i - 1].offset)).toBe(true)
  })

  it('rejects files without a video track', async () => {
    const file = path.join(dir, 'audio.m4a')
    execFileSync(ffmpegPath(), ['-v', 'error', '-y', '-f', 'lavfi', '-i', 'sine', '-t', '0.5', '-c:a', 'aac', file])
    const bytes = new Uint8Array(readFileSync(file))
    await expect(demuxVideoTrack(reader(bytes), bytes.length)).rejects.toThrow(/no video track/)
  })
})

/** A synthetic 60 fps stream: keyframe every `gop`, I/P only (decode order = presentation order). */
function stream(n: number, gop = 15): VideoSample[] {
  return Array.from({ length: n }, (_, i) => ({ offset: i * 100, size: 100, time: i / 60, duration: 1 / 60, key: i % gop === 0 }))
}

describe('presentationIndex', () => {
  const order = stream(10)
  it('picks the frame on a boundary itself, not the previous one', () => {
    expect(presentationIndex(order, 3 / 60, 1 / 120)).toBe(3)
    expect(presentationIndex(order, 3 / 60 - 1e-9, 1 / 120)).toBe(3)
    expect(presentationIndex(order, 3.4 / 60, 1 / 120)).toBe(3)
    expect(presentationIndex(order, 3.6 / 60, 1 / 120)).toBe(4)
  })
  it('clamps outside the stream', () => {
    expect(presentationIndex(order, -1, 1 / 120)).toBe(0)
    expect(presentationIndex(order, 99, 1 / 120)).toBe(9)
  })
})

describe('planFeed', () => {
  it('decodes every frame once for a plain 1:1 export', () => {
    const s = stream(60)
    const times = s.map((x) => x.time)
    const plan = planFeed(s, times)
    expect(plan.wanted).toEqual(s.map((_, i) => i))
    expect(plan.feed).toEqual(s.map((_, i) => i))
  })
  it('skips whole GOPs that a cut removes, restarting at a keyframe', () => {
    const s = stream(120)
    // Frames 0-29, then 90-119 (a cut over 30-89).
    const times = [...Array.from({ length: 30 }, (_, i) => i / 60), ...Array.from({ length: 30 }, (_, i) => (90 + i) / 60)]
    const plan = planFeed(s, times)
    expect(plan.feed.slice(0, 30)).toEqual(Array.from({ length: 30 }, (_, i) => i))
    expect(plan.feed[30]).toBe(90)
    expect(plan.feed).toHaveLength(60)
  })
  it('starts from the preceding keyframe when a cut ends mid-GOP', () => {
    const s = stream(120)
    const plan = planFeed(s, [0, 50 / 60])
    expect(plan.feed).toEqual([0, 45, 46, 47, 48, 49, 50])
  })
  it('repeats a frame for slow motion without decoding it twice', () => {
    const s = stream(30)
    const times = [0, 0.25 / 60, 0.5 / 60, 0.75 / 60, 1 / 60]
    const plan = planFeed(s, times)
    expect(plan.wanted).toEqual([0, 0, 1, 1, 1])
    expect(plan.feed).toEqual([0, 1])
  })
  it('handles B-frames: feeds through the reference that is decoded first', () => {
    // Presentation I0 B1 B2 P3, decode order I0 P3 B1 B2.
    const s: VideoSample[] = [
      { offset: 0, size: 1, time: 0, duration: 1 / 60, key: true },
      { offset: 1, size: 1, time: 3 / 60, duration: 1 / 60, key: false },
      { offset: 2, size: 1, time: 1 / 60, duration: 1 / 60, key: false },
      { offset: 3, size: 1, time: 2 / 60, duration: 1 / 60, key: false }
    ]
    const plan = planFeed(s, [0, 1 / 60, 2 / 60, 3 / 60])
    expect(plan.wanted).toEqual([0, 1, 2, 3])
    expect(plan.feed).toEqual([0, 1, 2, 3])
  })
})
