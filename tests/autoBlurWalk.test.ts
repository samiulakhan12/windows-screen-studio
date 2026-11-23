import { describe, expect, it } from 'vitest'
import { stepKeys } from '../src/shared/privacy/coverPath'
import { foldText } from '../src/shared/privacy/detect/clean'
import { intersect } from '../src/shared/privacy/look'
import { followAll, holdsText, lostBox, partsOf, walkSpan, type IndexedRead, type Matcher, type Placed, type ReadIndex, type Track } from '../src/shared/privacy/paths'
import { hintsOf, type ReadHints } from '../src/shared/privacy/plan'
import type { Box, LookMove } from '../src/shared/privacy/protocol'
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
})

/** Unused helpers kept typed for the scripts above. */
export type { FrameScript, LookMove }
