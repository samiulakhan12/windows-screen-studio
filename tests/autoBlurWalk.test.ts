import { describe, expect, it } from 'vitest'
import { stepKeys } from '../src/shared/privacy/coverPath'
import { foldText } from '../src/shared/privacy/detect/clean'
import { areaOf, intersect } from '../src/shared/privacy/look'
import { followAll, holdsText, lostBox, partsOf, walkSpan, type IndexedRead, type Matcher, type Placed, type ReadIndex, type Track } from '../src/shared/privacy/paths'
import { hintsOf, type ReadHints } from '../src/shared/privacy/plan'
import type { Box, LookMove, ReadResult } from '../src/shared/privacy/protocol'
import type { CursorTrack } from '../src/shared/types'
import { HD, inside, lookOf, move, ScriptedMatcher, type FrameScript, type Planted } from './autoBlurScanFixtures'

/*
 * Following found text (docs/design/auto-blur.md §5.8, §4.2; §17.1 tests 141-148 and 229-232): the
 * walks run against a scripted matcher over planted texts, and every check is made on the path
 * stepKeys writes, at every source frame.
 */

const NO_HINTS: ReadHints = hintsOf(null)
const KEY = 'secret'

const start = (t: number, b: Box, line: Box = b, id = 'h0', own = 'priya.raman@example.com'): Placed => ({ id, key: KEY, own, t, box: b, parts: partsOf(b, b[3]), line })
const readIndex = (reads: IndexedRead[] = [], templateOnly = false): ReadIndex => ({ reads, ...(templateOnly ? { templateOnly } : {}) })
const readOf = (t: number, areas: Box[], lines: { box: Box; text: string }[] = [], hits: IndexedRead['hits'] = []): IndexedRead => ({ t, areas, lines: lines.map((l) => ({ box: l.box, texts: [foldText(l.text)] })), hits })
const matcherOf = (planted: Planted[], opts: ConstructorParameters<typeof ScriptedMatcher>[2] = {}): ScriptedMatcher => new ScriptedMatcher(planted, () => KEY, opts)

/** The box the cover's path (stepKeys of its placements) draws at source time t, in video pixels; null outside its time. */
function pathBox(track: Track, fps: number): (t: number) => Box | null {
  const keys = stepKeys(track.placements, fps)
  return (t) => {
    if (t < track.start - 1e-9 || t >= track.end - 1e-9 || !keys.length) return null
    let k = keys[0]
    for (const x of keys) if (x.t <= t + 1e-9) k = x
    return [k.x * HD.width, k.y * HD.height, k.w * HD.width, k.h * HD.height]
  }
}

/** A box equal to the expected one within a hundredth of a pixel. */
const near = (b: Box | null, e: Box): boolean => !!b && b.every((v, i) => Math.abs(v - e[i]) < 0.01)

/** Source frame times in [from, to). */
const sourceFrames = (fps: number, from: number, to: number): number[] => {
  const out: number[] = []
  for (let i = Math.ceil(from * fps - 1e-9); i / fps < to - 1e-9; i++) out.push(Math.round((i / fps) * 1e6) / 1e6)
  return out
}

/** Every source frame of [from, to) at which the planted text (or its part inside `clipTo`) is not inside the cover. */
function uncovered(track: Track, fps: number, planted: Planted, from: number, to: number, clipTo: Box | null = null): number[] {
  const at = pathBox(track, fps)
  return sourceFrames(fps, from, to).filter((t) => {
    const p = planted.at(t)
    if (!p) return false
    const visible = clipTo ? intersect(p, clipTo) : p
    if (!visible) return false
    const b = at(t)
    return !b || !inside(visible, b, 1)
  })
}

describe('auto-blur P4: following', () => {
  it('141. walkSpan forward on a scripted matcher: holds without changes; follows a clear move; refuses an ambiguous one (two within 0.15) and becomes lost', async () => {
    const T: Box = [400, 300, 200, 30]
    // Nothing changes: the box holds, no match is asked, the cover runs to the end.
    const still: Planted = { key: KEY, text: 'x', at: () => T }
    const quiet = lookOf(HD, 30, 4)
    const m0 = matcherOf([still])
    const [held] = await walkSpan([start(1, T)], 1, quiet, readIndex(), m0, NO_HINTS, HD)
    expect(m0.calls).toHaveLength(0)
    expect(held.placements).toHaveLength(1)
    expect(held.end).toBeCloseTo(4, 6)
    expect(held.lost).toBe(false)

    // The text moves right 20 px a frame from 2 s to 3 s inside its region; the look sees the move.
    const region: Box = [288, 224, 1024, 192]
    const x = (t: number): number => 400 + 20 * Math.max(0, Math.min(30, Math.round((t - 2) * 30)))
    const moving: Planted = { key: KEY, text: 'x', at: (t) => [x(t), 300, 200, 30] }
    const look = lookOf(HD, 30, 4, (_i, t) => (t >= 2 && t <= 3 + 1e-9 && t > 2 - 1e-9 && Math.round((t - 2) * 30) >= 1 ? { changed: [region], moves: [move(region, 20, 0)] } : {}))
    const [followed] = await walkSpan([start(1, T)], 1, look, readIndex(), matcherOf([moving]), NO_HINTS, HD)
    expect(followed.lost).toBe(false)
    expect(uncovered(followed, 30, moving, 1, 4)).toEqual([])
    const at = pathBox(followed, 30)
    expect(near(at(3.5), [1000, 300, 200, 30])).toBe(true)
    // Before the move the box is the text's own: the union with the next box is only between the two frames of a move (§4.2).
    expect(near(at(1.9), T)).toBe(true)
    expect(near(at(2), T)).toBe(true)
    expect(near(at(2 + 1 / 30), [420, 300, 200, 30])).toBe(true)

    // From 2.5 s two candidates score within 0.15 (0.9 and 0.8): not placed, the cover becomes a lost area that still holds the text.
    const [ambiguous] = await walkSpan([start(1, T)], 1, look, readIndex(), matcherOf([moving], { second: (t) => (t >= 2.5 - 1e-9 ? 0.8 : undefined) }), NO_HINTS, HD)
    expect(ambiguous.lost).toBe(true)
    expect(Number(ambiguous.lostSpans.split(' ')[0])).toBeCloseTo(2.5, 2)
    expect(uncovered(ambiguous, 30, moving, 1, 4)).toEqual([])
    expect(ambiguous.end).toBeCloseTo(4, 6)
  })

  it('142. Lost areas (finding 4): a diagonal move with no clear candidate gives a 2-D union box, never a band along one axis; a move outside every candidate, with one candidate at 0.45, still leaves the planted text inside the lost area in every frame (the changed region is in the union)', async () => {
    // lostBox itself: the box, the box moved by every candidate, every changed region it overlaps.
    const b: Box = [100, 100, 100, 20]
    expect(lostBox(b, [{ dx: 0, dy: 30, scale: 1 }], [])).toEqual([100, 100, 100, 50])
    expect(lostBox(b, [{ dx: 0, dy: 30, scale: 1 }, { dx: 40, dy: 0, scale: 1 }], [])).toEqual([100, 100, 140, 50])
    expect(lostBox(b, [], [[150, 110, 400, 300], [900, 900, 10, 10]])).toEqual([100, 100, 450, 310])

    // A diagonal drag (+20, +20 a frame at 60 fps); the look's profiles offer a vertical move and a horizontal one only.
    const region: Box = [192, 192, 1024, 704]
    const pos = (t: number): number => Math.max(0, Math.min(60, Math.round((t - 1) * 60)))
    const diagonal: Planted = { key: KEY, text: 'x', at: (t) => [300 + 10 * pos(t), 300 + 10 * pos(t), 200, 30] }
    const look = lookOf(HD, 60, 3, (_i, t) => (t > 1 && t <= 2 + 1e-9 ? { changed: [region], moves: [move(region, 0, 20, 0.9, [[20, 0, 0.85]])] } : {}))
    const [drag] = await walkSpan([start(0.5, [300, 300, 200, 30])], 1, look, readIndex(), matcherOf([diagonal]), NO_HINTS, HD)
    expect(drag.lost).toBe(true)
    expect(uncovered(drag, 60, diagonal, 0.5, 3)).toEqual([])
    const lostAt = pathBox(drag, 60)(1.5)!
    expect(lostAt[2]).toBeGreaterThan(400)
    expect(lostAt[3]).toBeGreaterThan(400)

    // A jump of (+600, +300) outside every candidate; the one candidate scores 0.45.
    const jump: Planted = { key: KEY, text: 'x', at: (t) => (t < 1 ? [300, 300, 200, 30] : [900, 600, 200, 30]) }
    const jumpLook = lookOf(HD, 60, 3, (_i, t) => (Math.abs(t - 1) < 1e-6 ? { changed: [[288, 288, 832, 352]], moves: [move([288, 288, 832, 352], 0, 20, 0.45)] } : {}))
    const [jumped] = await walkSpan([start(0.5, [300, 300, 200, 30])], 1, jumpLook, readIndex(), matcherOf([jump], { miss: 0.45 }), NO_HINTS, HD)
    expect(jumped.lost).toBe(true)
    expect(uncovered(jumped, 60, jump, 0.5, 3)).toEqual([])
  })

  it('143. The speed guide: a scroll whose profile is ambiguous keeps the last speed as a candidate', async () => {
    const list: Box = [192, 0, 832, 1024]
    const k = (t: number): number => Math.max(0, Math.min(45, Math.round((t - 1) * 30)))
    const text: Planted = { key: KEY, text: 'x', at: (t) => [400, 900 - 20 * k(t), 200, 30] }
    // Up to 1.5 s the look sees the scroll's 20 px; after it, only two wrong candidates (5 and 40 px).
    const look = lookOf(HD, 60, 3, (_i, t) => {
      if (!(t > 1 && t <= 2.5 + 1e-9)) return {}
      return { changed: [list], moves: [t < 1.5 ? move(list, 0, -20) : move(list, 0, -5, 0.9, [[0, -40, 0.88]])] }
    })
    const m = matcherOf([text])
    const [scroll] = await walkSpan([start(0.5, [400, 900, 200, 30])], 1, look, readIndex(), m, NO_HINTS, HD)
    expect(scroll.lost).toBe(false)
    expect(uncovered(scroll, 60, text, 0.5, 3)).toEqual([])
    expect(near(pathBox(scroll, 60)(2.8), [400, 0, 200, 30])).toBe(true)
    // The speed guide was among the candidates of an ambiguous frame.
    const late = m.calls.find((c) => c.t > 2)!
    expect(late.candidates[0].some((c) => Math.abs(c.dy - (-20 * k(late.t))) < 0.5)).toBe(true)
  })

  it('144. Evidence of absence: a cover ends only when the next read lacks the text and the template search fails at every scale; it ends one analysed frame after the first changed frame with no match; with a match it goes on; after an in-app zoom, a read that gives a six-digit code with one misread digit keeps the cover going', async () => {
    const T: Box = [400, 300, 200, 30]
    const field: Box = [384, 288, 256, 64]
    // Deleted at 3 s; a read at 3.5 s over the field sees other text; a change at 4 s fails too.
    const deleted: Planted = { key: KEY, text: 'x', at: (t) => (t < 3 ? T : null) }
    const look = lookOf(HD, 30, 6, (_i, t) => (Math.abs(t - 3) < 1e-6 || Math.abs(t - 4) < 1e-6 ? { changed: [field] } : {}))
    const later = readOf(3.5, [[300, 200, 600, 300]], [{ box: [400, 300, 150, 30], text: 'Saved' }])
    const [ended] = await walkSpan([start(1, T)], 1, look, readIndex([later]), matcherOf([deleted]), NO_HINTS, HD)
    expect(ended.end).toBeCloseTo(3 + 1 / 30, 4)
    expect(uncovered(ended, 30, deleted, 1, 6)).toEqual([])
    // No read: no evidence, the cover goes on.
    const [noRead] = await walkSpan([start(1, T)], 1, look, readIndex(), matcherOf([deleted]), NO_HINTS, HD)
    expect(noRead.end).toBeCloseTo(6, 4)
    // The read lacks the text but the template search finds it in the region: the cover goes on.
    const movedAway: Planted = { key: KEY, text: 'x', at: (t) => (t < 3 ? T : [700, 400, 200, 30]) }
    const wide = lookOf(HD, 30, 6, (_i, t) => (Math.abs(t - 3) < 1e-6 ? { changed: [[384, 288, 544, 160]] } : {}))
    const [goesOn] = await walkSpan([start(1, T)], 1, wide, readIndex([readOf(3.5, [[300, 200, 800, 400]])]), matcherOf([movedAway]), NO_HINTS, HD)
    expect(goesOn.end).toBeCloseTo(6, 4)
    expect(uncovered(goesOn, 30, movedAway, 1, 6)).toEqual([])

    // An in-app zoom at 2 s (placed at 1.25), then the template stops matching at 3 s; the read at 3.5 s reads the code with one digit wrong.
    const region: Box = [320, 320, 640, 320]
    const code: Box = [400, 400, 200, 40]
    const zoomedCode: Box = [340, 380, 250, 50]
    const codeText: Planted = { key: KEY, text: '482913', at: (t) => (t < 2 ? code : t < 3 ? zoomedCode : null) }
    const zoomLook = lookOf(HD, 30, 6, (_i, t) => (Math.abs(t - 2) < 1e-6 || Math.abs(t - 3) < 1e-6 ? { changed: [region] } : {}))
    const misread = readOf(3.5, [[0, 0, 1920, 1080]], [{ box: zoomedCode, text: '482918' }])
    const [kept] = await walkSpan([start(1, code, code, 'h0', '482913')], 1, zoomLook, readIndex([misread]), matcherOf([codeText]), NO_HINTS, HD)
    expect(kept.end).toBeCloseTo(6, 4)
    expect(near(pathBox(kept, 30)(2.5), zoomedCode)).toBe(true)
    // The same read reading something else ends it.
    const [gone] = await walkSpan([start(1, code, code, 'h0', '482913')], 1, zoomLook, readIndex([readOf(3.5, [[0, 0, 1920, 1080]], [{ box: zoomedCode, text: 'Welcome' }])]), matcherOf([codeText]), NO_HINTS, HD)
    expect(gone.end).toBeCloseTo(3 + 1 / 30, 4)
  })

  it('145. Re-anchoring: a read finding the group again corrects the path backward and keeps the lost area', async () => {
    const T0: Box = [400, 300, 200, 30]
    const T1: Box = [900, 600, 200, 30]
    const jump: Planted = { key: KEY, text: 'x', at: (t) => (t < 2 ? T0 : T1) }
    // The look sees the change at the old place only; the text lands where nothing was seen to change.
    const look = lookOf(HD, 30, 5, (_i, t) => (Math.abs(t - 2) < 1e-6 ? { changed: [[384, 288, 256, 64]] } : {}))
    const r0 = readOf(1, [[0, 0, 1920, 1080]], [{ box: T0, text: 'priya.raman@example.com' }], [{ id: 'h0', key: KEY, box: T0, parts: partsOf(T0, 30) }])
    const r1 = readOf(3, [[0, 0, 1920, 1080]], [{ box: T1, text: 'priya.raman@example.com' }], [{ id: 'h1', key: KEY, box: T1, parts: partsOf(T1, 30) }])
    const sessions: { dir: number; from: number; to: number }[] = []
    const open = async (dir: 1 | -1, from: number, to: number): Promise<Matcher & { close(): Promise<void> }> => {
      sessions.push({ dir, from, to })
      const m = matcherOf([jump])
      return Object.assign(m, { close: async () => undefined })
    }
    const [track] = await followAll([start(1, T0)], look, readIndex([r0, r1]), open, NO_HINTS, HD, { duration: 5 })
    const at = pathBox(track, 30)
    // Placed again where the read found it.
    expect(near(at(3.5), T1)).toBe(true)
    // Between the loss and the read, the path holds the corrected place and the lost area both.
    for (const t of [2.1, 2.5, 2.9]) {
      expect(inside(T1, at(t)!), `corrected at ${t}`).toBe(true)
      expect(inside(T0, at(t)!), `lost area kept at ${t}`).toBe(true)
    }
    expect(track.lost).toBe(true)
    expect(uncovered(track, 30, jump, 0, 5)).toEqual([])
    // A third session walked back from the read: the correction.
    expect(sessions.map((s) => s.dir)).toEqual([-1, 1, -1])
  })

  it('Forward, text scrolled out of the frame ends its cover there, the mirror of the backward rule (found end to end: it was lost, its lost area the whole page, to the end of the recording)', async () => {
    const page: Box = [0, 0, 1920, 1080]
    // From 1 s the whole page scrolls up 40 px an analysed frame (30 fps): the text, at 300, is gone after 9 frames.
    const yAt = (t: number): number => 300 - 40 * Math.max(0, Math.round((t - 1) * 30))
    const text: Planted = { key: KEY, text: 'x', at: (t) => (yAt(t) + 30 > 0 ? [400, yAt(t), 200, 30] : null) }
    const look = lookOf(HD, 30, 6, (_i, t) => (Math.round((t - 1) * 30) >= 1 && t < 3 ? { changed: [page], moves: [move(page, 0, -40)] } : {}))
    const [track] = await walkSpan([start(0.5, [400, 300, 200, 30])], 1, look, readIndex(), matcherOf([text]), NO_HINTS, HD)
    const leaves = sourceFrames(30, 0.5, 6).find((t) => text.at(t) === null)!
    expect(track.end).toBeLessThanOrEqual(leaves + 2 / 30 + 1e-9)
    expect(uncovered(track, 30, text, 0.5, leaves, page)).toEqual([])
  })

  it('Forward, text cut at the frame edge by a scroll is not a fading glyph: the frame it stops matching at stays covered (found end to end)', async () => {
    const page: Box = [0, 0, 1920, 1080]
    const yAt = (t: number): number => 300 - 40 * Math.max(0, Math.round((t - 1) * 30))
    const shown: Planted = { key: KEY, text: 'x', at: (t) => (yAt(t) + 30 > 0 ? [400, yAt(t), 200, 30] : null) }
    // Cut at the top edge, the template no longer matches: the matcher sees the text only while it is whole.
    const whole: Planted = { key: KEY, text: 'x', at: (t) => (yAt(t) >= 0 ? [400, yAt(t), 200, 30] : null) }
    const look = lookOf(HD, 30, 6, (_i, t) => (Math.round((t - 1) * 30) >= 1 && t < 3 ? { changed: [page], moves: [move(page, 0, -40)] } : {}))
    const [track] = await walkSpan([start(0.5, [400, 300, 200, 30])], 1, look, readIndex(), matcherOf([whole]), NO_HINTS, HD)
    const leaves = sourceFrames(30, 0.5, 6).find((t) => shown.at(t) === null)!
    expect(track.end).toBeLessThanOrEqual(leaves + 2 / 30 + 1e-9)
    expect(uncovered(track, 30, shown, 0.5, leaves, page)).toEqual([])
  })

  it('Backward, a fast scroll that brought the text in is no page change: the cover starts where the text came into the frame, even with no match while it moved (found end to end)', async () => {
    const page: Box = [0, 0, 1920, 1080]
    // From 1 s to 2 s the page scrolls up into view, 36 px an analysed frame (30 fps), the text with it, to rest at 300.
    const yAt = (t: number): number => 300 + 36 * Math.max(0, 30 - Math.round((t - 1) * 30))
    const shown = (t: number): Box | null => (yAt(t) < 1080 ? [400, yAt(t), 200, 30] : null)
    const seen: Planted = { key: KEY, text: 'x', at: shown }
    // Moving that fast, the template finds nothing: the matcher sees the text only once it rests.
    const resting: Planted = { key: KEY, text: 'x', at: (t) => (t >= 2 - 1e-9 ? shown(t) : null) }
    const look = lookOf(HD, 30, 4, (_i, t) => {
      const k = Math.round((t - 1) * 30)
      return k >= 1 && k <= 30 ? { changed: [page], moves: [move(page, 0, -36)] } : {}
    })
    const R = 3
    const [track] = await walkSpan([start(R, [400, 300, 200, 30])], -1, look, readIndex(), matcherOf([resting]), NO_HINTS, HD)
    const appeared = sourceFrames(30, 0, R).find((t) => seen.at(t) !== null)!
    expect(track.start).toBeLessThanOrEqual(appeared + 1e-9)
    expect(uncovered({ ...track, end: R }, 30, seen, track.start, R, page)).toEqual([])
  })

  it('146. The backward walk (finding 3): a scroll before the first read is followed back with the move between f and the next analysed frame; the cover covers the text in every source frame from its appearance, which is where the box left its region', async () => {
    const list: Box = [192, 192, 832, 576]
    // A jerky scroll from 1 s: the content moves up 10 px, then 40 px, then 10 px… an analysed frame (60 fps).
    const N = 16
    const ys: number[] = [800]
    for (let k = 1; k <= N; k++) ys.push(ys[k - 1] - (k % 2 ? 40 : 10))
    const yAt = (t: number): number => {
      const s = Math.round((t - 1) * 60)
      if (s <= 0) return 800
      if (s >= 2 * N) return ys[N]
      const k = Math.floor(s / 2)
      return s % 2 ? ys[k] + (ys[k + 1] - ys[k]) / 2 : ys[k]
    }
    const text: Planted = { key: KEY, text: 'x', at: (t) => {
      const b: Box = [400, yAt(t), 200, 30]
      return intersect(b, list) ? b : null
    } }
    const look = lookOf(HD, 60, 4, (i, t) => {
      const k = Math.round((t - 1) * 30)
      if (k < 1 || k > N) return {}
      void i
      return { changed: [list], moves: [move(list, 0, ys[k] - ys[k - 1])] }
    })
    const R = 3
    const [track] = await walkSpan([start(R, [400, ys[N], 200, 30])], -1, look, readIndex(), matcherOf([text]), NO_HINTS, HD)
    expect(track.lost).toBe(false)
    const appeared = sourceFrames(60, 0, R).find((t) => text.at(t) !== null)!
    expect(track.start).toBeLessThanOrEqual(appeared + 1e-9)
    expect(track.start).toBeGreaterThan(appeared - 2 / 60)
    expect(uncovered({ ...track, end: R }, 60, text, track.start, R, list)).toEqual([])
  })

  it('147. Zoom: a whole-region change matched at scale 1.25 places the cover', async () => {
    const region: Box = [320, 320, 640, 320]
    const code: Box = [400, 400, 200, 40]
    const zoomed: Planted = { key: KEY, text: 'x', at: (t) => (t < 2 ? code : [340, 380, 250, 50]) }
    const look = lookOf(HD, 30, 4, (_i, t) => (Math.abs(t - 2) < 1e-6 ? { changed: [region] } : {}))
    const m = matcherOf([zoomed])
    const [track] = await walkSpan([start(1, code)], 1, look, readIndex(), m, NO_HINTS, HD)
    expect(track.lost).toBe(false)
    expect(near(pathBox(track, 30)(2.5), [340, 380, 250, 50])).toBe(true)
    expect(m.calls.some((c) => c.candidates[0].some((x) => Math.abs(x.scale - 1.25) < 1e-9))).toBe(true)
  })

  it('148. Toasts over a cover: the cover is lost under the toast and placed again after it', async () => {
    const T: Box = [1500, 900, 300, 40]
    const toast: Box = [1440, 832, 448, 192]
    const text: Planted = { key: KEY, text: 'x', at: (t) => (t >= 3 && t < 6 ? null : T) }
    const look = lookOf(HD, 30, 9, (_i, t) => (Math.abs(t - 3) < 1e-6 || Math.abs(t - 6) < 1e-6 ? { changed: [toast] } : {}))
    // The settle read under the toast reads the toast's own text.
    const settle = readOf(3.4, [[1376, 768, 544, 312]], [{ box: [1460, 850, 400, 30], text: 'New message from Sam' }])
    const [track] = await walkSpan([start(1, T)], 1, look, readIndex([settle]), matcherOf([text]), NO_HINTS, HD)
    expect(track.lost).toBe(true)
    const [from, to] = track.lostSpans.split(';')[0].split(' ').map(Number)
    expect(from).toBeCloseTo(3, 3)
    expect(to).toBeCloseTo(6, 3)
    expect(track.end).toBeCloseTo(9, 4)
    const at = pathBox(track, 30)
    expect(inside(T, at(4.5)!)).toBe(true)
    expect(near(at(7), T)).toBe(true)
  })

  it('229. Walks write union keys: walkSpan on a scripted 60 fps fast scroll (1,500 px/s) returns placements whose stepKeys path covers the planted text on every source frame', async () => {
    const list: Box = [192, 64, 832, 960]
    const yAt = (t: number): number => 900 - 25 * Math.max(0, Math.min(36, Math.round((t - 1) * 60)))
    const text: Planted = { key: KEY, text: 'x', at: (t) => {
      const b: Box = [400, yAt(t), 200, 30]
      return intersect(b, list) ? b : null
    } }
    const look = lookOf(HD, 60, 2.5, (_i, t) => (t > 1 && t <= 1.6 + 1e-9 ? { changed: [list], moves: [move(list, 0, -50)] } : {}))
    const R = 1.2
    const open = async (): Promise<Matcher & { close(): Promise<void> }> => Object.assign(matcherOf([text]), { close: async () => undefined })
    const [track] = await followAll([start(R, [400, yAt(R), 200, 30])], look, readIndex(), open, NO_HINTS, HD, { duration: 2.5 })
    // 25 px a source frame: between two analysed frames the text is half a move from both.
    expect(uncovered(track, 60, text, 0, 2.5, list)).toEqual([])
    // The same placements without union keys would leave every other source frame of the scroll uncovered.
    const keys = stepKeys(track.placements, 60)
    expect(keys.filter((k) => Math.round(k.t * 60) % 2 === 1).length).toBeGreaterThan(5)
  })

  it('230. Backward evidence: a tooltip over the text for 1.5 s before its first read does not start the cover after the tooltip; the walk asks for a check read before the earliest frame with no match, and starts the cover one source frame after the frame the check read proved empty; a page change with no match stops it at once', async () => {
    const T: Box = [400, 300, 200, 30]
    const tip: Box = [352, 256, 320, 128]
    const text: Planted = { key: KEY, text: 'x', at: (t) => (t < 1 || (t >= 3 && t < 4.5) ? null : T) }
    const look = lookOf(HD, 60, 6, (_i, t) => (Math.abs(t - 1) < 1e-6 ? { changed: [[384, 288, 256, 64]] } : Math.abs(t - 3) < 1e-6 || Math.abs(t - 4.5) < 1e-6 ? { changed: [tip] } : {}))
    // A settle read under the tooltip reads the tooltip only.
    const under = readOf(3.4, [[288, 192, 448, 256]], [{ box: [360, 270, 300, 24], text: 'Copy to clipboard' }])
    const m = matcherOf([text])
    const [track] = await walkSpan([start(4.6, T)], -1, look, readIndex([under]), m, NO_HINTS, HD)
    expect(track.start).toBeLessThan(1)
    // The check read whose emptiness counted: at the analysed frame before the earliest one with no match (0.9667 s).
    const last = m.checks[m.checks.length - 1]
    expect(last.t).toBeCloseTo(56 / 60, 4)
    expect(track.start).toBeLessThanOrEqual(last.t + 1 / 60)
    expect(track.start).toBeGreaterThan(last.t + 1 / 60 - 0.0011)
    expect(uncovered({ ...track, end: 4.6 }, 60, text, 0, 4.6)).toEqual([])
    // The text appears with a page change: no check read, the cover starts one source frame after the frame with no match.
    const page = lookOf(HD, 60, 6, (_i, t) => (Math.abs(t - 1) < 1e-6 ? { changed: [[0, 0, 1920, 1080]] } : Math.abs(t - 3) < 1e-6 || Math.abs(t - 4.5) < 1e-6 ? { changed: [tip] } : {}))
    const m2 = matcherOf([text])
    const [paged] = await walkSpan([start(4.6, T)], -1, page, readIndex([under]), m2, NO_HINTS, HD)
    expect(paged.start).toBeLessThanOrEqual(58 / 60 + 1 / 60)
    expect(paged.start).toBeGreaterThan(58 / 60 + 1 / 60 - 0.0011)
    expect(m2.checks.filter((c) => c.t < 1)).toEqual([])
    // A walk asks for at most 8 check reads: a pointer passing over text the template never matches (not typing: it changes beyond the line).
    const blink = lookOf(HD, 60, 4, (i) => (i % 3 === 0 && i > 0 ? { changed: [[384, 224, 256, 192]] } : {}))
    const m3 = matcherOf([{ key: KEY, text: 'x', at: () => null }], { check: (t) => ({ t, lines: [{ box: T, quad: [], variants: [{ model: 'tiny', text: 'priya.raman@example.com', conf: 0.9, spans: [] }], ring: '#000000', spread: 0 }], qr: [] }) })
    const [blinked] = await walkSpan([start(3, T)], -1, blink, readIndex(), m3, NO_HINTS, HD)
    expect(m3.checks.length).toBe(8)
    expect(blinked.start).toBe(0)
  })

  it('231. Holding the text: holdsText accepts one misread character of a 5-11 character text, a run of 4 of its characters, and a third of a longer one; it refuses an unrelated line', () => {
    expect(holdsText('482913', 'Code: 482918')).toBe(true)
    expect(holdsText('482913', 'Code: 4829')).toBe(true)
    expect(holdsText('Hunter2!x', 'pwd Hunter2!y')).toBe(true)
    expect(holdsText('priya.raman@example.com', 'From: priya.rama')).toBe(true)
    expect(holdsText('ghp_4Rk9TzQ2mWb7XcV1nL8pJd3Hs6Fy0aEu', 'expires Wb7XcV1nL8pJ')).toBe(true)
    expect(holdsText('ghp_4Rk9TzQ2mWb7XcV1nL8pJd3Hs6Fy0aEu', 'token ghp_9999')).toBe(false)
    expect(holdsText('482913', 'Welcome back, Sam')).toBe(false)
    expect(holdsText('482913', '17 50 62')).toBe(false)
    expect(holdsText('4821', 'pin 4827')).toBe(false)
    expect(holdsText('4821', 'pin 4821')).toBe(true)
    // Folded: O/0, l/1 and spaces do not matter.
    expect(holdsText('A1B2C3D4E5', 'a l b 2 c 3 d 4 e 5')).toBe(true)
  })

  it('232. Typed text: a code typed one character every 0.2 s inside a typing burst before its first read is covered from the burst’s start with one box over the line band (marked lost); text deleted inside a burst stays covered until the band has been still for 1.0 s', async () => {
    const line: Box = [600, 500, 600, 40]
    const cell = (i: number): Box => [620 + 20 * i, 505, 20, 30]
    const own: Box = [620, 505, 120, 30]
    const cover: Box = [610, 495, 140, 50]
    const typedAt = (i: number): number => 2 + 0.2 * i
    const deletedAt = (i: number): number => 5 + 0.2 * i
    const text: Planted = { key: KEY, text: '482913', at: (t) => (t >= typedAt(5) && t < deletedAt(0) ? own : null) }
    const look = lookOf(HD, 30, 10, (_i, t) => {
      const changed: Box[] = []
      for (let i = 0; i < 6; i++) if (Math.abs(t - typedAt(i)) < 1e-6 || Math.abs(t - deletedAt(i)) < 1e-6) changed.push(cell(i))
      return { changed }
    })
    const hints = hintsOf({ samples: [], clicks: [], valid: true, typing: [{ t: 2, end: 3 }, { t: 5, end: 6 }] } as CursorTrack)
    const s = { ...start(3.6, cover, line, 'h0', '482913'), parts: partsOf(own, 30) }
    // Backward: covered from the burst's start, one box over the typed band.
    const [back] = await walkSpan([s], -1, look, readIndex([readOf(3.6, [[0, 0, 1920, 1080]], [{ box: line, text: '482913' }])]), matcherOf([text]), hints, HD)
    expect(back.start).toBeLessThanOrEqual(2)
    expect(back.lost).toBe(true)
    const [lostFrom] = back.lostSpans.split(';')[0].split(' ').map(Number)
    expect(lostFrom).toBeLessThanOrEqual(2)
    const at = pathBox({ ...back, end: 3.6 }, 30)
    for (let i = 0; i < 6; i++) for (const t of [typedAt(i), typedAt(i) + 0.1]) expect(inside(own, at(t)!), `typed ${i} at ${t}`).toBe(true)
    expect(near(at(2.5), at(3.5)!)).toBe(true)
    // Forward: deleted one character every 0.2 s from 5 s inside a burst; a read at 8 s lacks it.
    const [fwd] = await walkSpan([s], 1, look, readIndex([readOf(8, [[0, 0, 1920, 1080]], [{ box: line, text: 'Enter the code' }])]), matcherOf([text]), hints, HD)
    expect(fwd.end).toBeGreaterThanOrEqual(deletedAt(5) + 1)
    const f = pathBox(fwd, 30)
    for (const t of [5, 5.5, 6, 6.5, 6.9]) expect(inside(own, f(t)!), `deleting at ${t}`).toBe(true)
  })

  it('Text deleted one key a frame with no typing hint stays covered over its line band until the band has been still for 1.0 s, the backward rule\'s mirror; cleared at once, its cover ends as before (found end to end: a key typed into a terminal and deleted again was taken for gone once its last characters matched no part, and its first character showed in the last frame)', async () => {
    const line: Box = [600, 500, 600, 40]
    const cell = (i: number): Box => [620 + 20 * i, 505, 20, 30]
    const own: Box = [620, 505, 120, 30]
    const cover: Box = [610, 495, 140, 50]
    const typedAt = (i: number): number => 2 + 0.2 * i
    const deletedAt = (i: number): number => 5 + i / 30
    const s = { ...start(3.6, cover, line, 'h0', '482913'), parts: partsOf(own, 30) }
    const lacking = readIndex([readOf(8, [[0, 0, 1920, 1080]], [{ box: line, text: 'Enter the code' }])])
    const walk = (clearedAtOnce: boolean) => {
      const text: Planted = { key: KEY, text: '482913', at: (t) => (t >= typedAt(5) && t < deletedAt(0) ? own : null) }
      const look = lookOf(HD, 30, 10, (_i, t) => {
        const changed: Box[] = []
        for (let i = 0; i < 6; i++) if (Math.abs(t - typedAt(i)) < 1e-6) changed.push(cell(i))
        if (clearedAtOnce && Math.abs(t - deletedAt(0)) < 1e-6) changed.push(own)
        if (!clearedAtOnce) for (let i = 0; i < 6; i++) if (Math.abs(t - deletedAt(i)) < 1e-4) changed.push(cell(5 - i))
        return { changed }
      })
      return walkSpan([s], 1, look, lacking, matcherOf([text]), NO_HINTS, HD)
    }
    // Deleted one key a frame from 5 s, no cursor data: covered over the band while it goes, and for 1 s after.
    const [fwd] = await walk(false)
    expect(fwd.end).toBeGreaterThanOrEqual(deletedAt(5) + 1 - 1e-6)
    const f = pathBox(fwd, 30)
    for (let i = 0; i <= 5; i++) expect(inside(own, f(deletedAt(i))!), `deleting ${i}`).toBe(true)
    expect(inside(own, f(deletedAt(5) + 0.5)!)).toBe(true)
    // Cleared in one change, no burst: the read at 8 s is evidence, and the cover ends one analysed frame after it went.
    const [once] = await walk(true)
    expect(once.end).toBeLessThan(deletedAt(0) + 0.1)
  })

  /** A matcher scoring each candidate by where it puts the text's own box (`own`) at t, searching ±8 px around it; second is the best score of a place more than 2 px from the best. */
  const placeMatcher = (own: Box, score: (t: number, at: Box) => number, check: (t: number, area: Box) => ReadResult | null = () => null): Matcher & { asked: number[] } => {
    const cx = own[0] + own[2] / 2
    const cy = own[1] + own[3] / 2
    const asked: number[] = []
    return {
      asked,
      track: async () => undefined,
      match: async (t, asks) =>
        asks.map((a) => {
          asked.push(a.candidates.length)
          // Each candidate's window (±8 px, as the helper's ±4 template pixels) is searched too: its other places can be the second.
          const places = a.candidates.flatMap((c) => [[0, 0], [8, 0], [-8, 0], [0, 8], [0, -8]].map(([x, y]) => ({ ...c, dx: c.dx + x, dy: c.dy + y })))
          const scored = places.map((c) => ({ c, s: score(t, [cx + c.scale * (own[0] - cx) + c.dx, cy + c.scale * (own[1] - cy) + c.dy, own[2] * c.scale, own[3] * c.scale]) }))
          if (!scored.length) return { track: a.track, parts: a.parts.map(() => null), best: null, second: 0 }
          const top = scored.reduce((x, y) => (y.s > x.s ? y : x))
          const second = scored.filter((x) => Math.abs(x.c.dx - top.c.dx) > 2 || Math.abs(x.c.dy - top.c.dy) > 2).reduce((m, x) => Math.max(m, x.s), 0)
          return { track: a.track, parts: a.parts.map(() => top.s), best: top.c, second }
        }),
      checkRead: async (t, area) => check(t, area)
    }
  }
  const at = (a: Box, b: Box): boolean => Math.abs(a[0] - b[0]) <= 2 && Math.abs(a[1] - b[1]) <= 2

  it('Evidence of absence on a page of other text: the template search finds the text only where it would place it (one clear match, or a part at 0.85), and never on a line the read read (found end to end: a search over a page of text always found a part at 0.5, and the cover blacked out the video to its end)', async () => {
    const T: Box = [400, 300, 200, 30]
    const page: Box = [0, 0, 1920, 1080]
    const line: Box = [800, 600, 300, 30]
    // A cut to another page at 2 s; the read at 2.5 s reads it whole: one line, a near copy of the text's look (0.9), and other text everywhere else (0.7).
    const look = lookOf(HD, 30, 4, (_i, t) => (Math.abs(t - 2) < 1e-6 ? { changed: [page] } : {}))
    const read = readOf(2.5, [page], [{ box: line, text: 'Quarterly report' }])
    // Where the text was, the new page shows other content too, scoring as little as such places do (0.4).
    const busy = (t: number, b: Box): number => (t < 2 ? (at(b, T) ? 0.95 : 0.3) : intersect(b, line) && areaOf(intersect(b, line)!) >= 0.5 * areaOf(b) ? 0.9 : Math.abs(b[0] - T[0]) <= 8 && Math.abs(b[1] - T[1]) <= 8 ? 0.4 : 0.7)
    const [gone] = await walkSpan([start(1, T)], 1, look, readIndex([read]), placeMatcher(T, busy), NO_HINTS, HD)
    expect(gone.end).toBeCloseTo(2 + 1 / 30, 4)
    // The text itself on the new page, unread, matches clearly where the search reaches it (0.97 against 0.7): no evidence, the lost area holds it to the end.
    const moved: Box = [1200, 800, 200, 30]
    const there = (t: number, b: Box): number => (t >= 2 && Math.abs(b[0] - moved[0]) <= 40 && Math.abs(b[1] - moved[1]) <= 40 ? 0.97 : busy(t, b))
    const [kept] = await walkSpan([start(1, T)], 1, look, readIndex([read]), placeMatcher(T, there), NO_HINTS, HD)
    expect(kept.end).toBeCloseTo(4, 4)
    expect(uncovered(kept, 30, { key: KEY, text: 'x', at: (t) => (t < 2 ? T : moved) }, 1, 4)).toEqual([])
  })

  it('A weak move is no move: a page change the look pass scored 0.2 neither carries the text out of the frame nor stops the zoom trial (found end to end: the spurious moves of every page change ended covers by chance and kept zooms from being tried)', async () => {
    const T: Box = [400, 300, 200, 30]
    const page: Box = [0, 0, 1920, 1080]
    // The page changes at 2 s, the text now elsewhere and no read after: the cover must hold it. The look pass scores its best shift 0.2.
    const relaid: Planted = { key: KEY, text: 'x', at: (t) => (t < 2 ? T : [1200, 800, 200, 30]) }
    const look = lookOf(HD, 30, 4, (_i, t) => (Math.abs(t - 2) < 1e-6 ? { changed: [page], moves: [move(page, 0, -900, 0.2)] } : {}))
    const [held] = await walkSpan([start(1, T)], 1, look, readIndex(), matcherOf([relaid]), NO_HINTS, HD)
    expect(held.end).toBeCloseTo(4, 4)
    expect(uncovered(held, 30, relaid, 1, 4)).toEqual([])
    // An in-app zoom whose region the look pass gives a weak shift: the zoom trial still places the cover.
    const region: Box = [320, 320, 640, 320]
    const code: Box = [400, 400, 200, 40]
    const zoomed: Planted = { key: KEY, text: 'x', at: (t) => (t < 2 ? code : [340, 380, 250, 50]) }
    const zoomLook = lookOf(HD, 30, 4, (_i, t) => (Math.abs(t - 2) < 1e-6 ? { changed: [region], moves: [move(region, 0, 150, 0.25)] } : {}))
    const [track] = await walkSpan([start(1, code)], 1, zoomLook, readIndex(), matcherOf([zoomed]), NO_HINTS, HD)
    expect(track.lost).toBe(false)
    expect(near(pathBox(track, 30)(2.5), [340, 380, 250, 50])).toBe(true)
  })

  it('A copy of the text further away never outbids where the text was going: a list showing one email on every twelfth row is followed row by row, and text leaving the frame is not moved onto a copy (found end to end: every walk on such a list was ambiguous and lost over the whole column)', async () => {
    const column: Box = [0, 0, 352, 1080]
    const period = 336
    const yAt = (t: number): number => 500 - 8 * Math.max(0, Math.round((t - 1) * 30))
    // Copies 336 px apart scroll up 8 px an analysed frame; the look pass offers the scroll and its aliases.
    const copies = (t: number): Box[] => [-2, -1, 0, 1, 2].map((k) => [16, yAt(t) + k * period, 200, 24] as Box)
    const look = lookOf(HD, 30, 4, (_i, t) => (Math.round((t - 1) * 30) >= 1 ? { changed: [column], moves: [move(column, 0, -8, 0.98, [[0, period - 8, 0.92], [0, -period - 8, 0.9]])] } : {}))
    const score = (t: number, b: Box): number => (copies(t).some((c) => at(b, c) && c[1] >= 0 && c[1] + 24 <= 1080) ? 1 : 0.2)
    const own: Box = [16, 500, 200, 24]
    const [followed] = await walkSpan([start(0.5, own)], 1, look, readIndex(), placeMatcher(own, score), NO_HINTS, HD)
    const mine: Planted = { key: KEY, text: 'x', at: (t) => (yAt(t) + 24 > 0 ? [16, yAt(t), 200, 24] : null) }
    expect(followed.lost).toBe(false)
    expect(near(pathBox(followed, 30)(2), [16, yAt(2), 200, 24])).toBe(true)
    // Its own row reaches the top edge and leaves: covered until then, never moved onto the copy below.
    const leaves = sourceFrames(30, 0.5, 4).find((t) => mine.at(t) === null)!
    expect(uncovered(followed, 30, mine, 0.5, leaves, [0, 0, 1920, 1080])).toEqual([])
    expect(followed.end).toBeLessThanOrEqual(leaves + 2 / 30 + 1e-9)
  })

  it('Text a scroll carries out of the frame between two analysed frames is covered in the source frames between them (found end to end: at 60 fps the frame between showed it cut at the edge)', async () => {
    const page: Box = [0, 0, 1920, 1080]
    // 60 fps, every second frame analysed; the page scrolls up 40 px a source frame from 1 s: placed whole at one analysed frame, the text is
    // cut at the top edge in the source frame after it and gone by the next analysed frame.
    const yAt = (t: number): number => 100 - 40 * Math.max(0, Math.round((t - 1) * 60))
    const shown: Planted = { key: KEY, text: 'x', at: (t) => (yAt(t) + 30 > 0 ? [400, yAt(t), 200, 30] : null) }
    const whole: Planted = { key: KEY, text: 'x', at: (t) => (yAt(t) >= 0 ? [400, yAt(t), 200, 30] : null) }
    const look = lookOf(HD, 60, 3, (_i, t) => (Math.round((t - 1) * 60) >= 1 && t < 2 ? { changed: [page], moves: [move(page, 0, -80)] } : {}))
    const [track] = await walkSpan([start(0.5, [400, 100, 200, 30])], 1, look, readIndex(), matcherOf([whole]), NO_HINTS, HD)
    const leaves = sourceFrames(60, 0.5, 3).find((t) => shown.at(t) === null)!
    expect(uncovered(track, 60, shown, 0.5, leaves, page)).toEqual([])
  })

  it('A text partly under a tooltip is still there: a part at 0.5 where the walker\'s own motion puts it is evidence of the text, however busy the page (found end to end: a tooltip over an email before its first read started the cover a frame late)', async () => {
    const T: Box = [400, 300, 200, 30]
    const tip: Box = [352, 256, 320, 128]
    // Until 1 s a tooltip hides part of the text: it matches 0.7 where it is, the busy page 0.6 everywhere else.
    const look = lookOf(HD, 60, 5, (_i, t) => (Math.abs(t - 1) < 1e-6 ? { changed: [tip] } : {}))
    const score = (t: number, b: Box): number => (at(b, T) ? (t < 1 ? 0.7 : 0.95) : 0.6)
    // A check read under the tooltip reads the tooltip's own words only.
    const check = (t: number): ReadResult => ({ t, lines: [{ box: [360, 270, 300, 24], quad: [], variants: [{ model: 'tiny', text: 'Copied to the clipboard', conf: 0.9, spans: [] }], ring: '#000000', spread: 0 }], qr: [] })
    const [track] = await walkSpan([start(2, T)], -1, look, readIndex(), placeMatcher(T, score, check), NO_HINTS, HD)
    expect(track.start).toBe(0)
    expect(uncovered({ ...track, end: 2 }, 60, { key: KEY, text: 'x', at: () => T }, 0, 2)).toEqual([])
  })

  it('Near first counts the region\'s real move as the walker\'s own: a scroll of more than a line a frame is followed, never a similar line where the text was (found end to end: a grid of recovery codes scrolled 35 px a frame and the cover stayed on the row above for five frames)', async () => {
    const T: Box = [400, 600, 200, 30]
    const page: Box = [0, 0, 1920, 1080]
    // From 1 s the page scrolls up 40 px an analysed frame for ten frames; a similar line sits 8 px above where the text was.
    const k = (t: number): number => Math.max(0, Math.min(10, Math.round((t - 1) * 30)))
    const mine: Planted = { key: KEY, text: 'x', at: (t) => [400, 600 - 40 * k(t), 200, 30] }
    const look = lookOf(HD, 30, 3, (_i, t) => (k(t) >= 1 && Math.round((t - 1) * 30) <= 10 ? { changed: [page], moves: [move(page, 0, -40)] } : {}))
    const score = (t: number, b: Box): number => (at(b, mine.at(t)!) ? 0.95 : t >= 1 && k(t) === 1 && at(b, [400, 592, 200, 30]) ? 0.71 : 0.5)
    const [track] = await walkSpan([start(0.5, T)], 1, look, readIndex(), placeMatcher(T, score), NO_HINTS, HD)
    expect(uncovered(track, 30, mine, 0.5, 3)).toEqual([])
  })

  /*
   * A1's scroll-ins, as the helper and the look pass see them. A page scrolls up into view from below,
   * 36 px an analysed frame (30 fps) for 30 frames from 1 s, until its top rests at the frame's top. The
   * look pass finds the move of the page's strip at the bottom only once it is 6 tiles (192 px) tall,
   * and the old page above it has its own region, separated by rows that did not change. The template
   * is cut padded (5 px here), so the text matches only while that padding is inside the frame; the
   * cover box is padded 6 px.
   */
  const SCROLL_FPS = 30
  const scrollStep = (t: number): number => Math.max(0, Math.min(30, Math.round((t - 1) * SCROLL_FPS)))
  const scrollInLook = (opts: { missing?: number[] } = {}): ReturnType<typeof lookOf> =>
    lookOf(HD, SCROLL_FPS, 4, (_i, t) => {
      const k = Math.round((t - 1) * SCROLL_FPS)
      if (k < 1 || k > 30) return {}
      const h = 36 * k
      const old: Box = [0, 0, 1920, Math.max(0, 1080 - h - 64)]
      const strip: Box = [0, 1080 - h, 1920, h]
      const moves: LookMove[] = []
      if (old[3] > 0) moves.push(move(old, 0, -36))
      if (h >= 192 && !opts.missing?.includes(k)) moves.push(move(strip, 0, -36))
      return { changed: old[3] > 0 ? [old, strip] : [strip], moves }
    })
  /** A text at `y` on the page that scrolls in: its own box at time t. */
  const onIncoming = (y: number) => (t: number): Box => [400, 1080 - 36 * scrollStep(t) + y, 200, 30]
  /** A start whose cover box is its own box padded 6 px. */
  const padded = (t: number, own: Box): Placed => ({ id: 'h0', key: KEY, own: 'priya.raman@example.com', t, box: [own[0] - 6, own[1] - 6, own[2] + 12, own[3] + 12], parts: partsOf(own, own[3]), line: own })
  /** Scores where the text is, while its template (its own box padded 5 px) is inside the frame; `ridge` frames match 0.9 there and 0.8 along its own line. */
  const whereMatchable = (where: (t: number) => Box | null, ridge?: (t: number) => boolean) => (t: number, b: Box): number => {
    const w = where(t)
    if (!w || w[1] - 5 < 0 || w[1] + w[3] + 5 > 1080 || w[0] - 5 < 0) return 0.3
    if (at(b, w)) return ridge?.(t) ? 0.9 : 0.95
    // The text's own line beside it (8 px along): its ridge, as gradient NCC gives one for a line of text.
    return ridge?.(t) && Math.abs(b[1] - w[1]) <= 2 && Math.abs(b[0] - w[0]) <= 8 ? 0.8 : 0.3
  }
  const FRAME: Box = [0, 0, 1920, 1080]

  it('Backward, a text scrolling in at the frame\'s bottom edge is followed by its own speed while the look pass has no move for its strip, held while it is cut at the edge, and the cover starts where it is wholly out (found end to end: A1\'s covers started one or two frames late on the first frames of each scroll)', async () => {
    const own = onIncoming(40)
    const text: Planted = { key: KEY, text: 'x', at: own }
    const [track] = await walkSpan([padded(3, own(3))], -1, scrollInLook(), readIndex(), placeMatcher(own(3), whereMatchable(own)), NO_HINTS, HD)
    // At 1 + 2/30 s the text shows whole (1048-1078) but its template is cut: the cover holds it there.
    const appeared = sourceFrames(SCROLL_FPS, 0, 3).find((t) => own(t)[1] < 1080)!
    expect(track.start).toBeLessThanOrEqual(appeared + 1e-9)
    expect(uncovered({ ...track, end: 3 }, SCROLL_FPS, text, 0, 3, FRAME)).toEqual([])
  })

  it('A box that holds still keeps the speed guide current: the first move after still frames is the speed of one frame, not spread over them (found end to end: after a pause the guide put a text scrolling in a tenth of the way, and its cover started frames late)', async () => {
    // A text at 300 on the incoming page; the look pass misses the strip's move at step 29 (the second step back from the rest).
    const own = onIncoming(300)
    const text: Planted = { key: KEY, text: 'x', at: own }
    const [track] = await walkSpan([padded(3, own(3))], -1, scrollInLook({ missing: [29] }), readIndex(), placeMatcher(own(3), whereMatchable(own)), NO_HINTS, HD)
    expect(uncovered({ ...track, end: 3 }, SCROLL_FPS, text, 0, 3, FRAME)).toEqual([])
  })

  it('Backward, a page change starts the cover only where no part matches where the walker\'s own motion puts the text: a match there that is not clear of its own line is no page change (found end to end: a token on a half-pixel step matched 0.88 against its line\'s 0.75 and the cover started early)', async () => {
    const own = onIncoming(300)
    const text: Planted = { key: KEY, text: 'x', at: own }
    // At step 19 the look pass misses the strip's move and the match there is 0.9 against its own line's 0.8.
    const [track] = await walkSpan([padded(3, own(3))], -1, scrollInLook({ missing: [20] }), readIndex(), placeMatcher(own(3), whereMatchable(own, (t) => Math.abs(t - (1 + 19 / 30)) < 1e-6)), NO_HINTS, HD)
    expect(uncovered({ ...track, end: 3 }, SCROLL_FPS, text, 0, 3, FRAME)).toEqual([])
  })

  it('A text whose padded template its own motion takes out of the frame is never placed by a zoom or a copy elsewhere, even with its ink still inside (found end to end: a code at the bottom edge was placed by a zoom 140 px away and its cover started late)', async () => {
    const own = onIncoming(40)
    const text: Planted = { key: KEY, text: 'x', at: own }
    const plain = placeMatcher(own(3), whereMatchable(own))
    // The zoom candidates find a clear place elsewhere, as the helper did on a page of text.
    const zoomy: Matcher = {
      ...plain,
      match: async (t, asks) => {
        const base = await plain.match(t, asks)
        return base.map((r, i) => (asks[i].candidates.length && asks[i].candidates.every((c) => c.scale !== 1) ? { ...r, parts: r.parts.map(() => 0.8), best: { dx: -150, dy: 0, scale: 0.8 }, second: 0.3 } : r))
      }
    }
    const [track] = await walkSpan([padded(3, own(3))], -1, scrollInLook(), readIndex(), zoomy, NO_HINTS, HD)
    expect(uncovered({ ...track, end: 3 }, SCROLL_FPS, text, 0, 3, FRAME)).toEqual([])
  })

  it('A text resting over the frame\'s edge, its padding beyond it, that moves along the edge is matched where it went, never held as cut at the edge (its own motion does not take it out of the frame)', async () => {
    // Near the bottom edge, its cover box 2 px past it; at 1 s a horizontal scroll moves it 600 px, the look pass offering 300 px first and 600 px second.
    const own = (t: number): Box => [400 + (t >= 1 - 1e-9 ? 600 : 0), 1046, 200, 30]
    const text: Planted = { key: KEY, text: 'x', at: own }
    const band: Box = [0, 960, 1920, 120]
    const look = lookOf(HD, SCROLL_FPS, 3, (_i, t) => (Math.abs(t - 1) < 1e-6 ? { changed: [band], moves: [move(band, 300, 0, 0.9, [[600, 0, 0.85]])] } : {}))
    const score = (t: number, b: Box): number => (at(b, own(t)) ? 0.95 : 0.3)
    const [track] = await walkSpan([padded(0.5, own(0.5))], 1, look, readIndex(), placeMatcher(own(0.5), score), NO_HINTS, HD)
    expect(track.lost).toBe(false)
    expect(uncovered(track, SCROLL_FPS, text, 0.5, 3, FRAME)).toEqual([])
  })

  it('Forward, a text the old page carries out at the top after its region is too short for a move is followed by its own speed, held while cut, and its cover ends one frame after it is wholly out (found end to end: lost there, its cover lasted to the end)', async () => {
    // The old page scrolls up 36 px a frame from 1 s; its region (above rows that do not change) has a move only while 192 px or taller (to step 22).
    const own = (t: number): Box => [400, 950 - 36 * scrollStep(t), 200, 30]
    const text: Planted = { key: KEY, text: 'x', at: own }
    const look = lookOf(HD, SCROLL_FPS, 4, (_i, t) => {
      const k = Math.round((t - 1) * SCROLL_FPS)
      if (k < 1 || k > 30) return {}
      const old: Box = [0, 0, 1920, Math.max(0, 1080 - 36 * k - 64)]
      const strip: Box = [0, 1080 - 36 * k, 1920, 36 * k]
      return { changed: old[3] > 0 ? [old, strip] : [strip], moves: [...(old[3] >= 192 ? [move(old, 0, -36)] : []), move(strip, 0, -36)] }
    })
    const [track] = await walkSpan([padded(0.5, own(0.5))], 1, look, readIndex(), placeMatcher(own(0.5), whereMatchable(own)), NO_HINTS, HD)
    const leaves = sourceFrames(SCROLL_FPS, 0.5, 4).find((t) => own(t)[1] + 30 <= 0)!
    expect(track.end).toBeLessThanOrEqual(leaves + 2 / SCROLL_FPS + 1e-9)
    expect(uncovered(track, SCROLL_FPS, text, 0.5, leaves, FRAME)).toEqual([])
  })

  it('A list scrolling under a sticky header keeps its own move when the shift of a whole period scores a little higher at a frame: each row is followed row by row, never moved onto its copy a period away (found end to end: the look pass scored the shift of 336 px above the scroll at one frame in eight, and every walk on the list was lost over the whole column)', async () => {
    const column: Box = [0, 32, 352, 1048]
    const period = 336
    // The rows scroll up 10 px an analysed frame from 1 s; at every fourth frame the shift of a whole period (-346) scores 0.73 against the scroll's 0.72.
    const k = (t: number): number => Math.max(0, Math.round((t - 1) * 30))
    const yAt = (t: number): number => 700 - 10 * k(t)
    const copies = (t: number): Box[] => [-2, -1, 0, 1].map((j) => [16, yAt(t) + j * period, 200, 24] as Box)
    const look = lookOf(HD, 30, 3, (_i, t) => (k(t) >= 1 ? { changed: [column], moves: [k(t) % 4 === 0 ? move(column, 0, -346, 0.73, [[0, -10, 0.72]]) : move(column, 0, -10, 0.74, [[0, -346, 0.65]])] } : {}))
    const score = (t: number, b: Box): number => (copies(t).some((c) => at(b, c) && c[1] >= 40) ? 1 : 0.2)
    const own: Box = [16, 700, 200, 24]
    const mine: Planted = { key: KEY, text: 'x', at: (t) => [16, yAt(t), 200, 24] }
    const [followed] = await walkSpan([start(0.5, own)], 1, look, readIndex(), placeMatcher(own, score), NO_HINTS, HD)
    expect(followed.lost).toBe(false)
    expect(uncovered(followed, 30, mine, 0.5, 3)).toEqual([])
    expect(near(pathBox(followed, 30)(2.5), mine.at(2.5)!)).toBe(true)
  })
})

/** Unused helpers kept typed for the scripts above. */
export type { FrameScript, LookMove }
