/**
 * Smooth cuts, the pure part (docs/design/editing-polish.md §5, §19.1 tests 8–15 and 74): the cuts,
 * the join each one draws with, the windows, A*'s frame and the decoder feeds, the video time of the
 * preview's frames, the punch-in and the poses.
 */
import { describe, expect, it } from 'vitest'
import { createProject } from '../src/shared/engine/project'
import { editToVideo, planOf, videoFrames, type FreezePlan } from '../src/shared/engine/freeze'
import { planFeed } from '../src/shared/render/feedPlan'
import { frameIndexAt } from '../src/shared/render/frameTiming'
import { presentationIndex, type VideoSample } from '../src/shared/render/mp4'
import {
  askTime,
  cutsOf,
  FLASH_GAP,
  frameVideoTime,
  joinAt,
  joinFeed,
  joinPlan,
  joinPose,
  punchAt,
  punchedCamera,
  resolvedJoin,
  stillFrame,
  trackTimes,
  type JoinWindow,
  type TrackTimes
} from '../src/shared/render/joins'
import { clampCamera, type Camera } from '../src/shared/engine/zoom'
import type { Rect } from '../src/shared/engine/layout'
import type { Clip, CutJoin, Freeze, LayoutSegment, Project, ProjectJoins } from '../src/shared/types'

// The renderer's compositor (DOM types) is loaded by path, so the node typecheck does not follow it.
const COMPOSITOR = '../src/renderer/src/render/compositor'
const { viewSource } = (await import(/* @vite-ignore */ COMPOSITOR)) as {
  viewSource: (c: Camera, rect: Rect) => { sx: number; sy: number; sw: number; sh: number; dx: number; dy: number; dw: number; dh: number } | null
}

function base(over: Partial<Project> = {}): Project {
  const p = createProject({
    id: 'p',
    name: 'p',
    duration: 60,
    width: 1280,
    height: 720,
    hasWebcam: true,
    hasAudio: true,
    webcamOffset: 0,
    zooms: [],
    cursorValid: true,
    capture: { method: 'chromium', cursorInVideo: true, region: null }
  })
  p.webcam = { show: true, corner: 'bottom-right', size: 0.24, shape: 'circle' }
  return { ...p, ...over }
}

const clip = (id: string, start: number, end: number, speed = 1): Clip => ({ id, start, end, speed })
const seg = (id: string, start: number, end: number, layout: LayoutSegment['layout']): LayoutSegment => ({ id, start, end, layout })

/** Clips of `lengths` seconds with a 1 s cut between each (B's id is 'c<i>'). */
function cutClips(lengths: number[]): Clip[] {
  let t = 0
  return lengths.map((len, i) => {
    const c = clip(`c${i}`, t, t + len)
    t += len + 1
    return c
  })
}

const withJoins = (clips: Clip[], joins: ProjectJoins, over: Partial<Project> = {}): Project => base({ clips, joins, duration: clips[clips.length - 1].end + 1, ...over })

/* ---------- a small seeded generator ---------- */

function rng(seed: number): () => number {
  let s = seed >>> 0
  return () => {
    s = (s + 0x6d2b79f5) >>> 0
    let t = s
    t = Math.imul(t ^ (t >>> 15), t | 1)
    t ^= t + Math.imul(t ^ (t >>> 7), t | 61)
    return ((t ^ (t >>> 14)) >>> 0) / 4294967296
  }
}

/** A random edit: clips with cuts, speed splits and speeds, pause and continue freezes, a camera offset, a style for every cut. */
function randomEdit(r: () => number, joinKinds: CutJoin['kind'][] = ['crossfade', 'slide', 'dip', 'smooth', 'punch', 'cut']): Project {
  const clips: Clip[] = []
  let t = r() * 0.5
  const n = 2 + Math.floor(r() * 7)
  for (let i = 0; i < n; i++) {
    const len = 0.1 + r() * (r() < 0.3 ? 0.4 : 3)
    const speed = [0.5, 1, 1, 1.5, 2][Math.floor(r() * 5)]
    clips.push(clip(`k${i}`, t, t + len, speed))
    const touching = r() < 0.2
    t += len + (touching ? 0 : r() < 0.15 ? 1e-5 + r() * 0.01 : 0.05 + r() * 2)
  }
  const end = t + 1
  const freezes: Freeze[] = []
  const nf = Math.floor(r() * 3)
  for (let i = 0; i < nf; i++) {
    const c = clips[Math.floor(r() * clips.length)]
    const at = Math.round((c.start + r() * (c.end - c.start)) * 1000) / 1000
    if (at >= c.end) continue
    freezes.push({ id: `f${i}`, at, length: Math.round((0.5 + r() * 2) * 10) / 10, sound: r() < 0.5 ? 'pause' : 'continue' })
  }
  const kind = joinKinds[Math.floor(r() * joinKinds.length)]
  const all: CutJoin = { kind }
  if (kind === 'dip') all.duration = 0.2 + r()
  if (kind === 'crossfade' || kind === 'smooth') all.duration = 0.05 + r() * 0.45
  if (kind === 'slide') all.duration = 0.25 + r() * 0.45
  return base({ clips, freezes, joins: { all }, duration: end, webcamOffset: Math.round((r() - 0.5) * 1000) / 1000 })
}

/* ---------- test 8: the cuts ---------- */

describe('cutsOf (test 8)', () => {
  const noFreezes = planOf({ clips: [], freezes: undefined })

  it('counts gaps between clips, never trims or touching speed splits', () => {
    // A trimmed start (the first clip starts at 2) and a trimmed end are not cuts.
    const clips = [clip('a', 2, 5), clip('b', 5, 7, 2), clip('c', 9, 12)]
    const cuts = cutsOf(clips, noFreezes)
    expect(cuts).toEqual([{ index: 2, clip: 'c', edit: 3 + 1, video: 3 + 1 }])
  })

  it('takes a gap of 1e-6 s as no cut and one of 2e-6 s as a cut', () => {
    expect(cutsOf([clip('a', 0, 1), clip('b', 1 + 1e-6, 2)], noFreezes)).toEqual([])
    expect(cutsOf([clip('a', 0, 1), clip('b', 1 + 2e-6, 2)], noFreezes)).toHaveLength(1)
  })

  it('gives T in video time, the holds before it included; a hold at B starts T', () => {
    const clips = [clip('a', 0, 4), clip('b', 6, 10), clip('c', 12, 15)]
    const freezes: Freeze[] = [
      { id: 'h1', at: 1, length: 2, sound: 'pause' },
      { id: 'h2', at: 12, length: 3, sound: 'pause' }
    ]
    const plan = planOf({ clips, freezes })
    const cuts = cutsOf(clips, plan)
    expect(cuts.map((c) => c.edit)).toEqual([4, 8])
    // The hold at 1 s comes before both cuts; the hold at c's start (12) is at the second cut: T is its start.
    expect(cuts[0].video).toBe(6)
    expect(cuts[1].video).toBe(10)
    expect(plan.holds.find((h) => h.id === 'h2')!.start).toBe(10)
    expect(cuts[1].video).toBe(editToVideo(plan, 8))
  })
})

/* ---------- test 9: the join of a cut ---------- */

describe('resolvedJoin (test 9)', () => {
  const clips = cutClips([4, 4, 4, 0.1, 4])

  it('gives a cut its own style over every cut\'s, and none for its own hard cut', () => {
    const p = withJoins(clips, { all: { kind: 'crossfade' }, cuts: [{ clip: 'c2', kind: 'dip', duration: 0.6 }, { clip: 'c4', kind: 'cut' }] })
    expect(resolvedJoin(p, 1)).toEqual({ kind: 'crossfade', duration: 0.15 })
    expect(resolvedJoin(p, 2)).toEqual({ kind: 'dip', duration: 0.6, color: '#000000' })
    expect(resolvedJoin(p, 4)).toBeNull()
    // No cut before the first clip.
    expect(resolvedJoin(p, 0)).toBeNull()
  })

  it('clamps a crossfade to half of B and makes one under two frames at 30 fps a hard cut', () => {
    const short = cutClips([4, 0.4, 4])
    const clamped = resolvedJoin(withJoins(short, { all: { kind: 'crossfade', duration: 0.5 } }), 1)!
    expect(clamped.kind).toBe('crossfade')
    expect(clamped.duration).toBeCloseTo(0.2, 12)
    // A 0.1 s clip with a 0.15 s crossfade gets 0.05 s, under 2/30: a hard cut.
    const p = withJoins(clips, { all: { kind: 'crossfade', duration: 0.15 } })
    expect(resolvedJoin(p, 3)).toBeNull()
    expect(resolvedJoin(p, 4)).toEqual({ kind: 'crossfade', duration: 0.15 })
  })

  it('bounds a dip\'s half by both clips', () => {
    const p = withJoins(cutClips([0.3, 4, 0.5]), { all: { kind: 'dip', duration: 1.2 } })
    // Cut 1: A is 0.3 s, so each half is 0.15 s.
    expect(resolvedJoin(p, 1)).toEqual({ kind: 'dip', duration: 0.3, color: '#000000' })
    // Cut 2: B is 0.5 s, each half 0.25 s.
    expect(resolvedJoin(p, 2)).toEqual({ kind: 'dip', duration: 0.5, color: '#000000' })
  })

  it('turns a slide into a crossfade of at most 0.5 s with Calm motion', () => {
    const slide = { all: { kind: 'slide' as const, duration: 0.7, from: 'left' as const } }
    expect(resolvedJoin(withJoins(cutClips([4, 4]), slide), 1)).toEqual({ kind: 'slide', duration: 0.7, from: 'left' })
    const calm = withJoins(cutClips([4, 4]), slide)
    const calmed = { ...calm, effects: { ...calm.effects, calm: true } }
    expect(resolvedJoin(calmed, 1)).toEqual({ kind: 'crossfade', duration: 0.5 })
  })

  it('never returns smooth', () => {
    const r = rng(9)
    for (let i = 0; i < 300; i++) {
      const p = randomEdit(r, ['smooth'])
      for (let k = 0; k < p.clips.length; k++) expect(resolvedJoin(p, k)?.kind ?? 'none').not.toBe('smooth')
    }
  })
})

/* ---------- test 10: the flash rule ---------- */

describe('the flash rule (test 10)', () => {
  it('draws dips with T at 0.5, 1.2, 1.9 and 3.5 s as dip, crossfade, dip, dip', () => {
    // Clips of 0.5, 0.7, 0.7, 1.6 and 2 s: B starts at edit 0.5, 1.2, 1.9 and 3.5.
    const clips = cutClips([0.5, 0.7, 0.7, 1.6, 2])
    const p = withJoins(clips, { all: { kind: 'dip', duration: 0.2 } })
    expect(cutsOf(clips, planOf(p)).map((c) => Number(c.video.toFixed(6)))).toEqual([0.5, 1.2, 1.9, 3.5])
    expect([1, 2, 3, 4].map((i) => resolvedJoin(p, i)?.kind)).toEqual(['dip', 'crossfade', 'dip', 'dip'])
    expect(FLASH_GAP).toBe(1)
    expect(resolvedJoin(p, 2)).toEqual({ kind: 'crossfade', duration: 0.15 })
  })
})

/* ---------- test 11: windows ---------- */

describe('join windows (test 11)', () => {
  const linear = (ws: readonly JoinWindow[], v: number): JoinWindow | null => ws.find((w) => w.from <= v && v < w.to) ?? null

  it('never overlap, and joinAt is a linear scan, for 1,000 random edits with freezes', () => {
    const r = rng(11)
    for (let n = 0; n < 1000; n++) {
      const p = randomEdit(r)
      const ws = joinPlan(p)
      for (let i = 1; i < ws.length; i++) expect(ws[i].from).toBeGreaterThanOrEqual(ws[i - 1].to)
      for (const w of ws) {
        expect(w.to).toBeGreaterThan(w.from)
        // p is 0 at the start and below 1 at the end.
        expect(joinAt(ws, w.from)).toEqual({ window: w, p: 0 })
        const end = joinAt(ws, w.to - 1e-9)
        expect(end?.window).toBe(w)
        expect(end!.p).toBeLessThan(1)
      }
      const last = ws.length ? ws[ws.length - 1].to + 1 : 5
      for (let k = 0; k < 40; k++) {
        const v = r() * last
        expect(joinAt(ws, v)?.window ?? null).toBe(linear(ws, v))
      }
    }
  })

  it('places a crossfade at [T, T + d) and a dip at [T − h, T + h)', () => {
    const clips = cutClips([4, 4, 4])
    const p = withJoins(clips, { all: { kind: 'crossfade' }, cuts: [{ clip: 'c2', kind: 'dip', duration: 0.6, color: '#ffffff' }] })
    const [a, b] = joinPlan(p)
    expect(a).toMatchObject({ kind: 'crossfade', index: 1, clip: 'c1', at: 4, from: 4, to: 4.15 })
    expect(a.still).toEqual({ screen: 4 - 1e-6, held: false, camera: 4 - 1e-6 })
    expect(b).toMatchObject({ kind: 'dip', index: 2, at: 8, still: null, color: '#ffffff' })
    expect(b.from).toBeCloseTo(7.7, 12)
    expect(b.to).toBeCloseTo(8.3, 12)
    expect(joinAt(joinPlan(p), 8)!.p).toBeCloseTo(0.5, 12)
  })

  it('has nothing for a project without joins (old projects)', () => {
    const p = base({ clips: cutClips([4, 4]) })
    expect(joinPlan(p)).toEqual([])
    expect(resolvedJoin(p, 1)).toBeNull()
    expect(punchAt(p, 6)).toBe(1)
  })

  it('takes the still of a continue freeze that holds A\'s end, and no camera when it is not shown', () => {
    const clips = cutClips([4, 4])
    const freezes: Freeze[] = [{ id: 'f', at: 2, length: 3, sound: 'continue' }]
    const p = withJoins(clips, { all: { kind: 'crossfade' } }, { freezes, webcam: { show: false, corner: 'bottom-right', size: 0.24, shape: 'circle' } })
    expect(joinPlan(p)[0].still).toEqual({ screen: 2, held: true, camera: null })
  })
})

/* ---------- test 12 and 74: still frames, the feed and the decoder ---------- */

/** A constant-rate track's samples (decode order = presentation order, a key every 30 frames). */
function samplesAt(fps: number, seconds: number): VideoSample[] {
  const d = fps === 29.97 ? 1001 / 30000 : 1 / fps
  const n = Math.ceil(seconds / d) + 2
  return Array.from({ length: n }, (_, k) => ({ offset: k, size: 1, time: k * d, duration: d, key: k % 30 === 0 }))
}

/** The decoder's own rule for a time (feedPlan's presentationIndex with half a median frame of slack). */
const decoderIndex = (samples: VideoSample[], t: number): number => presentationIndex(samples, t, samples[0].duration / 2)

/**
 * DecoderFrameSource's rules over a feed (frameSource.ts): planFeed, the `unique` list, the
 * matchPtr check and the skip test. Every position is got in order, as the export's loop gets them.
 * Returns the presentation index each position got.
 */
function runDecoder(samples: VideoSample[], feed: number[]): number[] {
  const plan = planFeed(samples, feed)
  const unique = [...new Set(plan.wanted)]
  // Fed samples come out in presentation order (no B-frames here: decode order is presentation order).
  const out = [...new Set(plan.feed)].sort((a, b) => a - b)
  let o = 0
  let matchPtr = 0
  const ready = new Set<number>()
  let current: number | null = null
  const got: number[] = []
  for (let i = 0; i < feed.length; i++) {
    const p = plan.wanted[i]
    if (current !== p) {
      if (!ready.has(p)) {
        const passed = matchPtr >= unique.length || unique[matchPtr] > p
        if (passed) throw new Error('The video decoder skipped a frame')
        while (!ready.has(p)) {
          if (o >= out.length) throw new Error('The video decoder did not return a frame')
          const f = out[o++]
          while (matchPtr < unique.length && unique[matchPtr] < f) matchPtr++
          if (matchPtr < unique.length && unique[matchPtr] === f) {
            ready.add(f)
            matchPtr++
          }
          if (f > p && !ready.has(p)) throw new Error('The video decoder skipped a frame')
        }
      }
      ready.delete(p)
      current = p
    }
    got.push(p)
  }
  return got
}

const SCREEN_RATES = [24, 25, 29.97, 30, 60]
const CAMERA_RATES = [15, 24, 30, 60]
const OUTPUT_RATES = [10, 15, 24, 25, 29.97, 30, 50, 60, 120]

describe('still frames and the feeds (tests 12 and 74)', () => {
  it('picks the frame that holds the instant and asks for it under both decoder rules', () => {
    for (const fps of SCREEN_RATES) {
      const samples = samplesAt(fps, 20)
      const track = trackTimes(samples, 60, 20)
      const r = rng(Math.round(fps * 100))
      for (let n = 0; n < 500; n++) {
        const u = r() * 19
        const aStart = u - r() * 3
        const { index, ask } = stillFrame(track, u, false, aStart)
        expect(track.starts[index]).toBeLessThanOrEqual(u)
        if (index + 1 < track.starts.length) expect(track.starts[index + 1]).toBeGreaterThan(u)
        expect(index).toBeGreaterThanOrEqual(stillFrame(track, aStart, false, aStart).index)
        expect(ask).toBe(askTime(track, index))
        expect(decoderIndex(samples, ask)).toBe(index)
        // The seeking path on a constant-rate track (frameIndexAt) shows the same frame.
        expect(frameIndexAt(ask, 1 / samples[0].duration)).toBe(index)
        // Under a continue freeze: the decoder's own rule at the freeze's picture.
        expect(stillFrame(track, u, true, aStart).index).toBe(decoderIndex(samples, u))
      }
    }
    // Never before the frame that holds A's start.
    const grid = trackTimes(null, 30, 10)
    expect(stillFrame(grid, 1.0, false, 2.0).index).toBe(60)
  })

  it('falls back to a constant-rate grid at the fallback rate', () => {
    const grid = trackTimes(null, 30, 2)
    expect(grid.half).toBeCloseTo(1 / 60, 12)
    expect(grid.starts[3]).toBeCloseTo(0.1, 12)
    expect(grid.starts.length).toBeGreaterThanOrEqual(61)
    const real = trackTimes(samplesAt(25, 2), 60, 2)
    expect(real.half).toBeCloseTo(0.02, 12)
  })

  it('keeps both feeds in order for every rate, shares frames, and never makes the decoder skip', () => {
    let windows = 0
    let shared = 0
    let inserted = 0
    let hard = 0
    let edits = 0
    for (const out of OUTPUT_RATES) {
      const r = rng(Math.round(out * 1000))
      for (let n = 0; n < 200; n++) {
        const screenFps = SCREEN_RATES[(n + Math.floor(out)) % SCREEN_RATES.length]
        const cameraFps = CAMERA_RATES[n % CAMERA_RATES.length]
        const p = randomEdit(r, ['crossfade', 'slide', 'dip', 'smooth'])
        const plan = planOf(p)
        const ws = joinPlan(p)
        const { times, pictures } = videoFrames(p.clips, plan, out)
        const cameraTimes = times.map((t) => t - p.webcamOffset)
        const screenSamples = samplesAt(screenFps, p.duration + 3)
        const cameraSamples = samplesAt(cameraFps, p.duration + 3)
        const screen = trackTimes(screenSamples, 60, p.duration)
        const camera = trackTimes(cameraSamples, 30, p.duration)
        const feed = joinFeed({ pictures, cameraTimes, windows: ws, fps: out, screen, camera })
        edits++
        const idxS = feed.screen.map((t) => decoderIndex(screenSamples, t))
        const idxC = feed.camera.map((t) => decoderIndex(cameraSamples, t))
        const ordered = (idx: number[]): boolean => idx.every((k, j) => j === 0 || k >= idx[j - 1])
        expect(ordered(idxS)).toBe(true)
        expect(ordered(idxC)).toBe(true)
        // Every output frame draws its own picture and camera time.
        expect(feed.draw.screen).toHaveLength(times.length)
        const drawsOwn = times.every(
          (_, i) => feed.screen[feed.draw.screen[i]] === pictures[i] && feed.camera[feed.draw.camera[i]] === cameraTimes[i] && (i === 0 || feed.draw.screen[i] > feed.draw.screen[i - 1])
        )
        expect(drawsOwn).toBe(true)
        // Test 74: the decoder's own rules over the feeds never throw.
        const gotS = runDecoder(screenSamples, feed.screen)
        const gotC = runDecoder(cameraSamples, feed.camera)
        const origS = pictures.map((t) => decoderIndex(screenSamples, t))
        const origC = cameraTimes.map((t) => decoderIndex(cameraSamples, t))
        for (const s of feed.stills) {
          const w = ws[s.window]
          const i0 = Math.ceil(w.at * out - 1e-9)
          const aStart = p.clips[w.index - 1].start
          const kS = stillFrame(screen, w.still!.screen, w.still!.held, aStart).index
          // Each still's copied frame is k*, reached before the window's first frame.
          expect(gotS[s.screen]).toBe(kS)
          expect(s.screen).toBeLessThanOrEqual(feed.draw.screen[i0])
          // A still shares an existing entry of the same frame.
          const first = origS.indexOf(kS)
          if (first >= 0) {
            shared++
            expect(s.screen).toBe(feed.draw.screen[first])
          } else inserted++
          if (w.still!.camera !== null) {
            const kC = stillFrame(camera, w.still!.camera, false, aStart - p.webcamOffset).index
            expect(gotC[s.camera!]).toBe(kC)
            expect(s.camera!).toBeLessThanOrEqual(feed.draw.camera[i0])
            const firstC = origC.indexOf(kC)
            if (firstC >= 0) expect(s.camera).toBe(feed.draw.camera[firstC])
          }
        }
        // Inserted entries are only the stills' own.
        expect(feed.screen.length - times.length).toBeLessThanOrEqual(feed.stills.length)
        for (const [n0, w] of ws.entries()) {
          if (!w.still) continue
          windows++
          const i0 = Math.ceil(w.at * out - 1e-9)
          const has = feed.stills.some((s) => s.window === n0)
          if (i0 >= times.length || !(i0 / out < w.to - 1e-9)) {
            // A window with no output frame adds no still.
            expect(has).toBe(false)
            continue
          }
          const kS = stillFrame(screen, w.still.screen, w.still.held, -Infinity).index
          const reachedS = origS.findIndex((k) => k >= kS)
          const kC = w.still.camera === null ? null : stillFrame(camera, w.still.camera, false, -Infinity).index
          const reachedC = kC === null ? 0 : origC.findIndex((k) => k >= kC)
          const late = (reachedS < 0 ? times.length : reachedS) > i0 || (reachedC < 0 ? times.length : reachedC) > i0
          // A still the feed reaches only after i0 makes its window hard; otherwise it is there.
          expect(has).toBe(!late)
          if (late) hard++
        }
      }
    }
    expect(edits).toBe(1800)
    expect(windows).toBeGreaterThan(1000)
    expect(shared).toBeGreaterThan(0)
    expect(inserted).toBeGreaterThan(0)
    void hard
  }, 60000)

  it('shares an entry, inserts one and makes a window hard in the cases the design names', () => {
    const screen: TrackTimes = trackTimes(null, 30, 20)
    const w = (at: number, screenAt: number): JoinWindow => ({ index: 1, clip: 'b', kind: 'crossfade', from: at, to: at + 0.15, at, still: { screen: screenAt, held: false, camera: null } })
    // A's last frame drawn asks for frame 30 (1.0 s); the still is frame 29 (just before 1.0): inserted before it.
    const pictures = [0.9, 0.94, 1.0, 5.0, 5.03]
    const f = joinFeed({ pictures, cameraTimes: null, windows: [w(3 / 30, 1 - 1e-6)], fps: 30, screen, camera: null })
    expect(f.screen).toHaveLength(6)
    expect(f.stills).toEqual([{ window: 0, screen: 2, camera: null }])
    expect(f.screen[2]).toBe(askTime(screen, 29))
    expect(Array.from(f.draw.screen)).toEqual([0, 1, 3, 4, 5])
    // A still on a frame some output frame already asks for shares its entry.
    const g = joinFeed({ pictures, cameraTimes: null, windows: [w(3 / 30, 0.95 + 1e-3)], fps: 30, screen, camera: null })
    expect(g.screen).toEqual(pictures)
    expect(g.stills).toEqual([{ window: 0, screen: 1, camera: null }])
    // Reached only after the window's first frame: hard (no still at all).
    const h = joinFeed({ pictures, cameraTimes: null, windows: [w(1 / 30, 1.0 - 1e-6)], fps: 30, screen, camera: null })
    expect(h.stills).toEqual([])
    expect(h.screen).toEqual(pictures)
    // No output frame inside the window: no still.
    const tiny: JoinWindow = { ...w(3 / 30 + 0.001, 0.95), to: 3 / 30 + 0.002 }
    expect(joinFeed({ pictures, cameraTimes: null, windows: [tiny], fps: 30, screen, camera: null }).stills).toEqual([])
  })
})

/* ---------- test 13: the preview's video time ---------- */

describe('frameVideoTime (test 13)', () => {
  const clips = [clip('a', 0, 4), clip('b', 6, 10)]
  const freezes: Freeze[] = [{ id: 'h', at: 6, length: 2, sound: 'pause' }]
  const plan: FreezePlan = planOf({ clips, freezes })

  it('is the hold\'s start plus the time spent in it inside a hold', () => {
    expect(frameVideoTime(clips, plan, 6, { start: 4, elapsed: 0.7 }, null)).toBeCloseTo(4.7, 12)
  })

  it('reads T + length for the first frame after a hold at T', () => {
    expect(frameVideoTime(clips, plan, 6, null, null)).toBe(4)
    expect(frameVideoTime(clips, plan, 6, null, 6)).toBe(6)
    // Further on, editToVideo counts the hold already.
    expect(frameVideoTime(clips, plan, 7, null, 6)).toBe(editToVideo(plan, 5))
  })

  it('equals editToVideo without holds', () => {
    const none = planOf({ clips, freezes: [] })
    for (const t of [0, 1.5, 3.99, 6, 8.25, 9.9]) {
      const o = t < 4 ? t : 4 + (t - 6)
      expect(frameVideoTime(clips, none, t, null, null)).toBeCloseTo(editToVideo(none, o), 12)
    }
    // In a cut: where playback goes on from.
    expect(frameVideoTime(clips, none, 5, null, null)).toBe(4)
  })
})

/* ---------- test 14: the punch-in ---------- */

describe('punchAt and punchedCamera (test 14)', () => {
  it('toggles on punched cuts and ends on any other cut', () => {
    const clips = cutClips([2, 2, 2, 2, 2])
    const p = withJoins(clips, { cuts: [{ clip: 'c1', kind: 'punch' }, { clip: 'c2', kind: 'punch' }, { clip: 'c3', kind: 'crossfade' }, { clip: 'c4', kind: 'punch' }] })
    expect(clips.map((c) => punchAt(p, c.start + 0.5))).toEqual([1, 1.1, 1, 1, 1.1])
    // A cut is not drawn: punchAt there is 1.
    expect(punchAt(p, clips[1].start - 0.5)).toBe(1)
  })

  it('counts Smooth\'s punch-ins, keeps the state over a speed split, and uses the join\'s scale', () => {
    const clips = [clip('a', 0, 2), clip('b', 3, 4), clip('b2', 4, 5, 2), clip('c', 6, 8)]
    const led = { layouts: [seg('L', 0, 8, 'camera-only')] }
    const p = withJoins(clips, { all: { kind: 'smooth', scale: 1.15 } }, led)
    expect(clips.map((c) => punchAt(p, c.start + 0.25))).toEqual([1, 1.15, 1.15, 1])
    const q = withJoins(clips, { all: { kind: 'punch', scale: 1.2 } })
    expect(punchAt(q, 4.5)).toBe(1.2)
  })

  it('gives a hold its held frame\'s clip', () => {
    const clips = cutClips([2, 2])
    const p = withJoins(clips, { all: { kind: 'punch' } }, { freezes: [{ id: 'h', at: 3, length: 2, sound: 'pause' }] })
    expect(punchAt(p, 3)).toBe(1.1)
  })

  it('scales the camera about its centre, leaves it alone where the camera is punched instead, and stays in the recording', () => {
    const clips = cutClips([2, 2])
    const p = withJoins(clips, { all: { kind: 'punch' } })
    const cam = { scale: 2, cx: 0.4, cy: 0.6 }
    expect(punchedCamera(cam, p, 3.5)).toEqual({ scale: 2.2, cx: 0.4, cy: 0.6 })
    // No punch at t: the same object.
    expect(punchedCamera(cam, p, 1)).toBe(cam)
    for (const layout of ['camera-only', 'camera-large', 'side-by-side'] as const) {
      const q = withJoins(clips, { all: { kind: 'punch' } }, { layouts: [seg('L', 0, 6, layout)] })
      expect(punchAt(q, 3.5)).toBe(1.1)
      expect(punchedCamera(cam, q, 3.5)).toBe(cam)
    }
    const r = rng(14)
    for (let n = 0; n < 1000; n++) {
      const scale = 1 + r() * 4
      const half = 0.5 / scale
      const c = { scale, cx: half + r() * (1 - 2 * half), cy: half + r() * (1 - 2 * half) }
      const out = punchedCamera(c, p, 3.5)
      expect(out.scale).toBeCloseTo(scale * 1.1, 12)
      expect(out.cx).toBeCloseTo(c.cx, 12)
      expect(out.cy).toBeCloseTo(c.cy, 12)
      const rect = { x: 0, y: 0, w: 1000, h: 600 }
      const v = viewSource(out, rect)!
      // The whole view comes from inside the recording and fills the rect.
      expect(v.sx).toBeGreaterThanOrEqual(-1e-12)
      expect(v.sy).toBeGreaterThanOrEqual(-1e-12)
      expect(v.sx + v.sw).toBeLessThanOrEqual(1 + 1e-12)
      expect(v.sy + v.sh).toBeLessThanOrEqual(1 + 1e-12)
      expect(v.dw).toBeCloseTo(1000, 6)
      // A random centre too: the centre is kept, and the view only shrinks inside the one given.
      const given = { scale, cx: r(), cy: r() }
      const wild = punchedCamera(given, p, 3.5)
      expect(wild).toEqual({ scale: scale * 1.1, cx: given.cx, cy: given.cy })
      expect(wild.cx - 0.5 / wild.scale).toBeGreaterThanOrEqual(given.cx - 0.5 / given.scale)
      expect(wild.cx + 0.5 / wild.scale).toBeLessThanOrEqual(given.cx + 0.5 / given.scale)
    }
  })

  it('keeps the view of a followed frame where it is (a 9:16 view of a 16:9 recording near its edge)', () => {
    const clips = cutClips([2, 2])
    const p = withJoins(clips, { all: { kind: 'punch' } })
    // A followed view's camera is bounded by its base (clampCamera with base), not the whole recording.
    const near = { scale: 1, cx: 0.1477, cy: 0.5 }
    expect(punchedCamera(near, p, 3.5)).toEqual({ scale: 1.1, cx: 0.1477, cy: 0.5 })
    const r = rng(41)
    for (let n = 0; n < 1000; n++) {
      const followed = { w: 0.05 + r() * 0.95, h: 0.05 + r() * 0.95 }
      const c = clampCamera({ scale: 1 + r() * 4, cx: r(), cy: r() }, followed)
      const out = punchedCamera(c, p, 3.5)
      expect(out).toEqual({ scale: c.scale * 1.1, cx: c.cx, cy: c.cy })
      // The followed view's source stays inside the recording.
      const hx = (0.5 * followed.w) / out.scale
      const hy = (0.5 * followed.h) / out.scale
      expect(out.cx - hx).toBeGreaterThanOrEqual(-1e-12)
      expect(out.cx + hx).toBeLessThanOrEqual(1 + 1e-12)
      expect(out.cy - hy).toBeGreaterThanOrEqual(-1e-12)
      expect(out.cy + hy).toBeLessThanOrEqual(1 + 1e-12)
    }
  })
})

/* ---------- test 15: the poses ---------- */

describe('joinPose (test 15)', () => {
  const win = (kind: JoinWindow['kind'], over: Partial<JoinWindow> = {}): JoinWindow => ({ index: 1, clip: 'b', kind, from: 1, to: 2, at: 1, still: null, ...over })

  it('fades A* out linearly in a crossfade', () => {
    for (const p of [0, 0.25, 0.5, 0.9]) expect(joinPose({ window: win('crossfade'), p }, 1920, 1080)).toEqual({ live: { dx: 0, dy: 0 }, still: { alpha: 1 - p, dx: 0, dy: 0 }, fill: null })
  })

  it('keeps the two pictures of a slide exactly one frame apart, covering it', () => {
    const W = 1920
    const H = 1080
    for (const dir of ['right', 'left', 'top', 'bottom'] as const) {
      for (const p of [0, 0.1, 0.37, 0.5, 0.8, 0.999]) {
        const pose = joinPose({ window: win('slide', { dir }), p }, W, H)
        const gapX = pose.live.dx - pose.still!.dx
        const gapY = pose.live.dy - pose.still!.dy
        expect(pose.still!.alpha).toBe(1)
        if (dir === 'right') expect(gapX).toBeCloseTo(W, 9)
        if (dir === 'left') expect(gapX).toBeCloseTo(-W, 9)
        if (dir === 'top') expect(gapY).toBeCloseTo(-H, 9)
        if (dir === 'bottom') expect(gapY).toBeCloseTo(H, 9)
        // At the start B is a whole frame away; it moves in, never past its place.
        if (dir === 'right' || dir === 'left') expect(Math.abs(pose.live.dx)).toBeLessThanOrEqual(W)
        else expect(Math.abs(pose.live.dy)).toBeLessThanOrEqual(H)
      }
      expect(Math.abs(joinPose({ window: win('slide', { dir }), p: 0 }, W, H).still!.dx)).toBe(0)
    }
  })

  it('fills a dip\'s colour at 0 at its ends and 1 in its middle', () => {
    const w = win('dip', { color: '#ffffff' })
    expect(joinPose({ window: w, p: 0 }, 10, 10).fill).toEqual({ color: '#ffffff', alpha: 0 })
    expect(joinPose({ window: w, p: 0.5 }, 10, 10).fill).toEqual({ color: '#ffffff', alpha: 1 })
    expect(joinPose({ window: w, p: 0.25 }, 10, 10).fill!.alpha).toBeCloseTo(0.5, 12)
    expect(joinPose({ window: w, p: 1 }, 10, 10).fill!.alpha).toBe(0)
    expect(joinPose({ window: w, p: 0.5 }, 10, 10).still).toBeNull()
  })
})

