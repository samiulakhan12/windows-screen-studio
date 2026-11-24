/**
 * Following found text over time (docs/design/auto-blur.md §5.8): the walks that turn a hit at its
 * read frame into a path, forward until the text is shown to be gone and backward to when it
 * appeared. Every hit of a span is walked together, one analysed frame at a time, against the
 * helper's follow session (the Matcher). Pure apart from the Matcher it is given; runs in main.
 *
 * The Matcher's conventions (the helper's follow session, P2): a track's parts are templates cut at
 * the frame of its last `track` call. A candidate places them at the template's place moved by
 * (dx, dy) video pixels after scaling by `scale` about the centre of the union of the track's parts.
 * Candidates are cumulative from the template, never from the frame before. `match` answers, per
 * track, each part's score at the best candidate (null when a part is off the frame), that candidate
 * (null when the parts do not agree within 2 px), refined to where the parts matched, and the best
 * score of the candidates whose match lands more than 2 px from it (one clear best match). Calls come
 * with t in the walk's direction, several at one t allowed. `checkRead` reads one area at one frame
 * alone (a check read, §5.4 point 8).
 *
 * Boxes are video pixels ([x, y, w, h]); the placements a walk returns are normalised to the frame.
 */
import type { NormRect } from '../types'
import type { Placement } from './coverPath'
import { foldText } from './detect/clean'
import { areaOf, bottom, changedShare, changedUnder, clip, frameNear, intersect, overlaps, regionsAt, right, tileChanged, tileGrid, union, type LookData, type Size } from './look'
import type { ReadHints } from './plan'
import type { Box, Candidate, ReadResult, TrackMatch } from './protocol'

/** A walked text: its placements (normalised), its time and how it was followed. */
export interface Track {
  placements: Placement[]
  start: number
  end: number
  /** Part of it covers an area because the text could not be placed there. */
  lost: boolean
  /** Followed by template only (no reads), or from reads further apart than usual. */
  thin: boolean
  /** Where it was lost: "start end" pairs joined by ";", source seconds. */
  lostSpans: string
  /** This start was found again by the walk of start `joined`, which covers it in this direction. */
  joined?: number
  /** The walk was stopped before it finished (Stop): it runs to the recording's end or start as a lost area. */
  unfinished?: boolean
  /** Places a forward walk found its text again after losing it: the walk backward from each corrects the path (§5.8). */
  reanchors?: Placed[]
  /** The hits of reads this walk found its text again in (re-anchored on): they need no walk of their own. */
  consumed?: string[]
}

/** The helper's follow session and a check read, as a walk uses them (see the file's comment). */
export interface Matcher {
  track(track: number, t: number, parts: readonly Box[]): Promise<void>
  match(t: number, tracks: readonly { track: number; parts: readonly number[]; candidates: readonly Candidate[] }[]): Promise<TrackMatch[]>
  checkRead(t: number, area: Box): Promise<ReadResult | null>
}

/** A hit to follow from its read. */
export interface Placed {
  /** The hit's id (its read and its place in it): a walk that finds it again takes it in. */
  id: string
  /** Its group key: its own text folded (main's memory only, §5.7). */
  key: string
  /** Its own text, for holdsText. */
  own: string
  /** The read's frame (source seconds). */
  t: number
  /** The cover box. */
  box: Box
  /** The own box cut into parts (partsOf). */
  parts: Box[]
  /** The line it is on (the typing rule's line band starts at its left edge). */
  line: Box
  /** A backward walk from here stops at this time without needing evidence (a re-anchor's correction). */
  until?: number
}

/** One read as the walks see it: its areas, its lines' readings folded, its hits. */
export interface IndexedRead {
  t: number
  areas: Box[]
  lines: { box: Box; texts: string[] }[]
  hits: { id: string; key: string; box: Box; parts: Box[] }[]
  /** A failed read proves nothing. */
  failed?: boolean
}

export interface ReadIndex {
  reads: readonly IndexedRead[]
  /** No reader: evidence of absence is the template alone (§5.9), and every track is thin. */
  templateOnly?: boolean
  /** Forward walks also ask for check reads (Follow, which has no plan of reads to give evidence). */
  checkForward?: boolean
}

export interface WalkOptions {
  /** The recording's length (the end of a walk that never ends). */
  duration?: number
  /** Stop: checked every frame; the walks not finished then run on as lost areas. */
  stopped?: () => boolean
}

/* ---------- rules ---------- */

/** A part placed: at least one part this good, */
const PLACE_SCORE = 0.6
/** and the best candidate this far ahead of the next. */
const CLEAR_BY = 0.15
/** Below this, no part of the text is there (evidence of absence). */
const ABSENT_SCORE = 0.5
/** Changed frames from C checked for the end frame e (§5.8). */
const END_FRAMES = 16
/** Zoom inside the recorded app: the scales tried about the region's centre (§5.8 step 6). */
const ZOOMS = [0.8, 0.9, 1.1, 1.25]
/** A typing band still this long ends a burst of typing (§5.8). */
const BAND_STILL_S = 1.0
/** Part width at most this many line heights, at most 3 parts (§5.8). */
const PART_LINES = 6
const MAX_PARTS = 3
/** Most candidates of one template search. */
const MAX_SEARCH = 1200
/** A read covers a box when this share of it lies in the read's areas. */
const COVERED = 0.95
/** Most check reads one walk asks for (each about 0.1 unit, §5.4); past them it waits for planned reads and stops. */
const MAX_CHECKS = 8

/** The own box cut into equal parts no wider than 6 line heights each, at most 3. */
export function partsOf(own: Box, lineHeight: number): Box[] {
  const h = Math.max(1, lineHeight)
  const n = Math.max(1, Math.min(MAX_PARTS, Math.ceil(own[2] / (PART_LINES * h))))
  const w = own[2] / n
  return Array.from({ length: n }, (_v, i) => [own[0] + i * w, own[1], w, own[3]] as Box)
}

/** The edit distance from `p` to the closest substring of `s` (Sellers), stopping early past `max`. */
function substringDistance(p: string, s: string, max: number): number {
  const n = p.length
  let prev = new Array<number>(n + 1)
  let cur = new Array<number>(n + 1)
  for (let i = 0; i <= n; i++) prev[i] = i
  let best = prev[n]
  for (let j = 1; j <= s.length; j++) {
    cur[0] = 0
    for (let i = 1; i <= n; i++) cur[i] = Math.min(prev[i] + 1, cur[i - 1] + 1, prev[i - 1] + (p[i - 1] === s[j - 1] ? 0 : 1))
    best = Math.min(best, cur[n])
    if (best <= max) return best
    ;[prev, cur] = [cur, prev]
  }
  return best
}

/**
 * Whether a line holds a text (§5.8), generously because reading is not exact: the line has the
 * folded text; or, for a text of 12 characters or more, a third of it; for 5-11 characters, the text
 * within edit distance 1 or any run of 4 of its characters; for a shorter text, the text itself.
 */
export function holdsText(own: string, line: string): boolean {
  const o = foldText(own)
  const l = foldText(line)
  if (!o || !l) return false
  if (l.includes(o)) return true
  const n = o.length
  if (n >= 12) {
    const k = Math.ceil(n / 3)
    return [o.slice(0, k), o.slice(k, 2 * k), o.slice(2 * k)].some((p) => p.length >= 4 && l.includes(p))
  }
  if (n >= 5) {
    for (let i = 0; i + 4 <= n; i++) if (l.includes(o.slice(i, i + 4))) return true
    return substringDistance(o, l, 1) <= 1
  }
  return false
}

/** `box` moved by a candidate: scaled about its centre, then shifted. */
function moved(box: Box, c: Candidate): Box {
  const s = c.scale > 0 ? c.scale : 1
  const cx = box[0] + box[2] / 2
  const cy = box[1] + box[3] / 2
  return [cx + s * (box[0] - cx) + c.dx, cy + s * (box[1] - cy) + c.dy, box[2] * s, box[3] * s]
}

/**
 * A lost area (§5.8 step 5, finding 4): the 2-D union of the box, the box moved by every candidate
 * and every changed region the box (or a moved box) overlaps, whatever the candidates scored. Never
 * a band along one axis: a move outside every candidate still lands inside it, because the text stays
 * inside the region that changed.
 */
export function lostBox(box: Box, candidates: readonly Candidate[], changed: readonly Box[]): Box {
  const placed = [box, ...candidates.map((c) => moved(box, c))]
  let out = box
  for (const p of placed) out = union(out, p)
  for (const r of changed) if (placed.some((p) => overlaps(r, p))) out = union(out, r)
  return out
}

/* ---------- placements ---------- */

const toNorm = (b: Box, size: Size): NormRect => {
  const c = clip(b, size)
  return { x: c[0] / size.width, y: c[1] / size.height, w: c[2] / size.width, h: c[3] / size.height }
}
const fromNorm = (r: NormRect, size: Size): Box => [r.x * size.width, r.y * size.height, r.w * size.width, r.h * size.height]
const normUnion = (a: NormRect, b: NormRect): NormRect => {
  const x = Math.min(a.x, b.x)
  const y = Math.min(a.y, b.y)
  return { x, y, w: Math.max(a.x + a.w, b.x + b.w) - x, h: Math.max(a.y + a.h, b.y + b.h) - y }
}

/** The box a list of placements (time order) holds at `t`: the last at or before it, or null before the first. */
function heldAt(list: readonly Placement[], t: number): NormRect | null {
  let lo = 0
  let hi = list.length
  while (lo < hi) {
    const m = (lo + hi) >> 1
    if (list[m].t <= t + 1e-9) lo = m + 1
    else hi = m
  }
  return lo ? list[lo - 1].box : null
}

/** Placements in time order, those at one time joined into one holding both. */
function tidy(list: readonly Placement[]): Placement[] {
  const sorted = [...list].sort((a, b) => a.t - b.t)
  const out: Placement[] = []
  for (const p of sorted) {
    const last = out[out.length - 1]
    if (last && Math.abs(last.t - p.t) < 1e-9) last.box = normUnion(last.box, p.box)
    else out.push({ t: p.t, box: { ...p.box } })
  }
  return out
}

/** The union of two placement lists (each holds its box from one placement to the next, within its own [from, to)). */
export function unionPlacements(a: readonly Placement[], b: readonly Placement[], bFrom = -Infinity, bTo = Infinity): Placement[] {
  const A = tidy(a)
  const B = tidy(b)
  if (!B.length) return A
  if (!A.length) return B
  const times = [...new Set([...A.map((p) => p.t), ...B.map((p) => p.t)])].sort((x, y) => x - y)
  const out: Placement[] = []
  for (const t of times) {
    const x = heldAt(A, t)
    const y = t >= bFrom && t < bTo ? heldAt(B, t) : null
    const box = x && y ? normUnion(x, y) : (x ?? y)
    if (box) out.push({ t, box })
  }
  return out
}

/** Two directions of one text joined: the backward walk's placements, then the forward walk's. */
export function joinTracks(back: Track, fwd: Track): Track {
  const spans = [back.lostSpans, fwd.lostSpans].filter(Boolean).join(';')
  return {
    placements: tidy([...back.placements, ...fwd.placements]),
    start: Math.min(back.start, fwd.start),
    end: Math.max(back.end, fwd.end),
    lost: back.lost || fwd.lost,
    thin: back.thin || fwd.thin,
    lostSpans: spans,
    ...(back.unfinished || fwd.unfinished ? { unfinished: true } : {}),
    ...(fwd.reanchors?.length ? { reanchors: fwd.reanchors } : {}),
    ...(back.consumed?.length || fwd.consumed?.length ? { consumed: [...(back.consumed ?? []), ...(fwd.consumed ?? [])] } : {})
  }
}

/* ---------- the walk ---------- */

interface Xf {
  dx: number
  dy: number
  scale: number
}

interface Walker {
  index: number
  start: Placed
  at: number
  active: boolean
  done: boolean
  joined?: number
  /** The template: the frame it was cut at, its parts and box, and their centre. */
  tpl: { t: number; parts: Box[]; box: Box; cx: number; cy: number }
  /** Where the template is now (the last placement). */
  off: Xf
  /** The moves the regions under it made since it was lost. */
  drift: { dx: number; dy: number }
  /** Speed (pixels a frame, time-forward) from the last two placements. */
  v: { dx: number; dy: number }
  box: Box
  lost: boolean
  lostFrom: number
  lostSpans: [number, number][]
  placements: Placement[]
  lastPlaced: number
  lastOff: Xf
  /** Forward: the first changed frame with no match since the last placement, and the best part score at each changed frame since. */
  C: number | null
  history: [number, number][]
  /** A read lacked the text there and the template search failed: proven once the next change fails too. */
  pending: number | null
  /** Backward: the step before this one failed to place (a still frame next asks for a check read). */
  justFailed: boolean
  /** The typing rule's hold (forward): the burst's end and the band's last change. */
  hold: { until: number; lastChange: number } | null
  holdEnd: number
  /** Backward: frames up to this index (exclusive, walking down) are skipped (the typing piece covers them). */
  skipTo: number
  /** The move of the region it moved with at its last step (the backward walk's exit test). */
  region: Box | null
  result: { start: number; end: number } | null
  unfinished: boolean
  /** No reader: the template search decides at this failed frame. */
  bare: boolean
  reanchors: Placed[]
  consumed: string[]
  checks: number
}

const ident: Xf = { dx: 0, dy: 0, scale: 1 }
const sameXf = (a: Xf, b: Xf): boolean => Math.abs(a.dx - b.dx) < 0.25 && Math.abs(a.dy - b.dy) < 0.25 && Math.abs(a.scale - b.scale) < 1e-6
const centre = (boxes: readonly Box[]): [number, number] => {
  let u = boxes[0]
  for (const b of boxes) u = union(u, b)
  return [u[0] + u[2] / 2, u[1] + u[3] / 2]
}
const xfBox = (w: Walker, b: Box, xf: Xf): Box => [w.tpl.cx + xf.scale * (b[0] - w.tpl.cx) + xf.dx, w.tpl.cy + xf.scale * (b[1] - w.tpl.cy) + xf.dy, b[2] * xf.scale, b[3] * xf.scale]
/** A zoom by s about (zx, zy) applied after xf. */
const zoomed = (w: Walker, xf: Xf, s: number, zx: number, zy: number): Xf => ({ scale: xf.scale * s, dx: (1 - s) * (zx - w.tpl.cx) + s * xf.dx, dy: (1 - s) * (zy - w.tpl.cy) + s * xf.dy })

/** Share of `box` inside the union of `areas` (areas of one read barely overlap). */
function coverage(areas: readonly Box[], box: Box): number {
  const a = areaOf(box)
  if (!a) return 0
  let inside = 0
  for (const r of areas) {
    const i = intersect(r, box)
    if (i) inside += areaOf(i)
  }
  return Math.min(1, inside / a)
}

const floorMs = (t: number): number => Math.floor(t * 1000 + 1e-6) / 1000

/**
 * Walks every hit of a span together, frame by frame, in one direction (§5.8). Forward: a box holds
 * while nothing under it changes; it follows a clear match among the moves of the regions under it,
 * no move and the speed guide; it becomes a lost area (lostBox) when nothing is clear, and is placed
 * again by one clear match; it ends only with evidence of absence (its region changed, the next read
 * covering it lacks the text, the template search fails everywhere at every scale, and the next change
 * does not bring it back), one analysed frame after the first changed frame with no part at 0.5.
 * Backward: the box at f is the box at the next analysed frame moved back by the move between them
 * (finding 3); it goes on, placed or lost, through tooltips and toasts, until evidence of absence
 * going back (a read or a check read lacking the text), a page change with no match, the text leaving
 * its region or the frame, or the first frame; the cover then starts one source frame after the frame
 * proven absent, with the union of the boxes on both sides (§4.2). Text typed or deleted in place
 * follows the typing rule. A read finding the same text again re-anchors a walk; a start it finds is
 * taken in (`joined`). Returns one Track per start.
 */
export async function walkSpan(starts: readonly Placed[], dir: 1 | -1, look: LookData, reads: ReadIndex, m: Matcher, hints: ReadHints, size: Size, options: WalkOptions = {}): Promise<Track[]> {
  const frames = look.frames
  const n = frames.length
  const fps = look.fps > 0 ? look.fps : 60
  const frameS = 1 / fps
  const duration = options.duration ?? (n ? frames[n - 1].t + look.step / fps : 0)
  const { tile } = tileGrid(look)
  const ids = new Map<string, number>()
  const walkers: Walker[] = starts.map((s, index) => {
    ids.set(s.id, index)
    const parts = s.parts.length ? s.parts : [s.box]
    const [cx, cy] = centre(parts)
    return {
      index,
      start: s,
      at: Math.max(0, frameNear(look, s.t)),
      active: false,
      done: false,
      tpl: { t: s.t, parts, box: s.box, cx, cy },
      off: ident,
      drift: { dx: 0, dy: 0 },
      v: { dx: 0, dy: 0 },
      box: s.box,
      lost: false,
      lostFrom: s.t,
      lostSpans: [],
      placements: [],
      lastPlaced: -1,
      lastOff: ident,
      C: null,
      history: [],
      pending: null,
      justFailed: false,
      hold: null,
      holdEnd: -Infinity,
      skipTo: Infinity,
      region: null,
      result: null,
      unfinished: false,
      bare: false,
      reanchors: [],
      consumed: [],
      checks: 0
    }
  })
  if (!n || !walkers.length) return walkers.map((w) => finish(w))

  // Reads by frame.
  const readsAt = new Map<number, IndexedRead[]>()
  for (const r of reads.reads) {
    const i = frameNear(look, r.t)
    if (i < 0 || Math.abs(frames[i].t - r.t) > (look.step / fps) / 2 + 1e-6) continue
    const list = readsAt.get(i)
    if (list) list.push(r)
    else readsAt.set(i, [r])
  }

  const inTyping = (t: number): { start: number; until: number } | null => {
    for (const b of hints.typing) if (t >= b.t - 0.3 && t <= b.end + 0.3) return { start: b.t, until: b.end }
    for (const b of hints.textCursor) if (t >= b.t && t <= b.end) return { start: b.t, until: Math.min(b.end, t + 0.3) }
    for (const p of hints.pastes) if (Math.abs(t - p) <= 0.3) return { start: p, until: p + 0.3 }
    return null
  }

  /** Sets the walker's box at frame f; when it changes, the box it had is kept at the frame walked from (so union keys fall between the two, §4.2). */
  const setBox = (w: Walker, f: number, box: Box): void => {
    const from = f - dir
    const last = w.placements[w.placements.length - 1]
    if (box[0] === w.box[0] && box[1] === w.box[1] && box[2] === w.box[2] && box[3] === w.box[3] && last) return
    if (from >= 0 && from < n && (!last || Math.abs(last.t - frames[from].t) > 1e-9)) w.placements.push({ t: frames[from].t, box: toNorm(w.box, size) })
    w.placements.push({ t: frames[f].t, box: toNorm(box, size) })
    w.box = box
  }

  const place = (w: Walker, f: number, xf: Xf): void => {
    if (w.lastPlaced >= 0 && f !== w.lastPlaced) {
      const k = f - w.lastPlaced
      w.v = { dx: (xf.dx - w.lastOff.dx) / k, dy: (xf.dy - w.lastOff.dy) / k }
    }
    w.off = xf
    w.lastOff = xf
    setBox(w, f, xfBox(w, w.tpl.box, xf))
    if (w.lost) {
      const t = frames[f].t
      w.lostSpans.push(dir === 1 ? [w.lostFrom, t] : [t, w.lostFrom])
    }
    w.lost = false
    w.C = null
    w.history = []
    w.pending = null
    w.justFailed = false
    w.hold = null
    w.drift = { dx: 0, dy: 0 }
    w.lastPlaced = f
  }

  const anchor = async (w: Walker, f: number, box: Box, parts: Box[]): Promise<void> => {
    const ps = parts.length ? parts : [box]
    const [cx, cy] = centre(ps)
    w.tpl = { t: frames[f].t, parts: ps, box, cx, cy }
    await m.track(w.index, frames[f].t, ps)
    w.lastPlaced = -1
    place(w, f, ident)
  }

  const becomeLost = (w: Walker, f: number): void => {
    if (w.lost) return
    w.lost = true
    w.lostFrom = frames[f].t
  }

  /** The moves at the frame that separates f from the frame walked from, relative, in the walk's direction. */
  const stepFrame = (f: number): number => (dir === 1 ? f : f + 1)
  const movesFor = (f: number, area: Box): { rel: Candidate[]; best: Candidate | null; region: Box | null } => {
    const cf = stepFrame(f)
    const rel: Candidate[] = []
    let best: Candidate | null = null
    let bestScore = -Infinity
    let region: Box | null = null
    for (const mv of frames[cf]?.moves ?? []) {
      const before: Box = [mv.box[0] - mv.dx, mv.box[1] - mv.dy, mv.box[2], mv.box[3]]
      if (!overlaps(mv.box, area) && !overlaps(before, area)) continue
      const all: [number, number, number][] = [[mv.dx, mv.dy, mv.score], ...mv.alt]
      for (const [dx, dy, score] of all) {
        const c = { dx: dir * dx, dy: dir * dy, scale: 1 }
        rel.push(c)
        if (score > bestScore) {
          bestScore = score
          best = c
          region = mv.box
        }
      }
    }
    return { rel, best, region }
  }

  const predicted = (w: Walker): Xf => (w.lost ? { dx: w.off.dx + w.drift.dx, dy: w.off.dy + w.drift.dy, scale: w.off.scale } : w.off)

  const candidatesFor = (w: Walker, f: number, rel: readonly Candidate[]): Xf[] => {
    const pred = predicted(w)
    const k = f - (w.lastPlaced >= 0 ? w.lastPlaced : f)
    const list: Xf[] = [...rel.map((c) => ({ dx: pred.dx + c.dx, dy: pred.dy + c.dy, scale: pred.scale })), pred, w.off, { dx: w.off.dx + w.v.dx * k, dy: w.off.dy + w.v.dy * k, scale: w.off.scale }]
    const out: Xf[] = []
    for (const c of list) if (!out.some((o) => sameXf(o, c))) out.push(c)
    return out
  }

  /** Candidates searching the whole of `area` (and around), at scale 1 on a grid and at the zoom scales about its centre. */
  const searchCandidates = (w: Walker, area: Box): Xf[] => {
    const s = w.off.scale
    const b = xfBox(w, w.tpl.box, { dx: 0, dy: 0, scale: s })
    const zone = clip([area[0] - b[2] / 2, area[1] - b[3] / 2, area[2] + b[2], area[3] + b[3]], size)
    let step = 16 * hints.scale
    while (Math.ceil(zone[2] / step) * Math.ceil(zone[3] / step) > MAX_SEARCH) step *= 1.25
    const out: Xf[] = []
    for (let y = zone[1]; y <= bottom(zone) - b[3] / 2; y += step) for (let x = zone[0]; x <= right(zone) - b[2] / 2; x += step) out.push({ dx: x - b[0], dy: y - b[1], scale: s })
    const pred = predicted(w)
    const zx = area[0] + area[2] / 2
    const zy = area[1] + area[3] / 2
    for (const z of ZOOMS) out.push(zoomed(w, pred, z, zx, zy))
    return out
  }

  const maxPart = (r: TrackMatch | undefined): number => (r ? r.parts.reduce<number>((mx, p) => (p !== null && p > mx ? p : mx), 0) : 0)
  const clear = (r: TrackMatch | undefined): boolean => !!r && !!r.best && maxPart(r) >= PLACE_SCORE && maxPart(r) - r.second >= CLEAR_BY

  const lineBand = (w: Walker): Box => {
    const b = w.start.box
    return [Math.min(w.start.line[0], b[0]), b[1], size.width - Math.min(w.start.line[0], b[0]), b[3]]
  }

  /** The changed tiles of frame `cf` inside `area`, as boxes (video pixels). */
  const changedBoxes = (cf: number, area: Box): Box[] => {
    const { cols } = tileGrid(look)
    const out: Box[] = []
    const c0 = Math.max(0, Math.floor(area[0] / tile))
    const r0 = Math.max(0, Math.floor(area[1] / tile))
    const c1 = Math.min(cols - 1, Math.ceil(right(area) / tile) - 1)
    const r1 = Math.min(Math.ceil(size.height / tile) - 1, Math.ceil(bottom(area) / tile) - 1)
    for (let r = r0; r <= r1; r++) for (let c = c0; c <= c1; c++) if (tileChanged(frames[cf], r * cols + c)) out.push(clip([c * tile, r * tile, tile, tile], size))
    return out
  }

  /** Whether the changes at frame `cf` near the walker lie inside its line band (text typed or deleted in place). */
  const bandOnly = (w: Walker, cf: number): boolean => {
    const band = lineBand(w)
    const lh = Math.max(1, w.start.line[3])
    const near = clip([band[0], band[1] - 2 * lh, band[2], band[3] + 4 * lh], size)
    const changed = changedBoxes(cf, near)
    return changed.length > 0 && changed.every((c) => overlaps(c, band))
  }

  /** Forward: the end of a walk whose text was shown gone at S (§5.8). */
  const endForward = (w: Walker, S: number): void => {
    let e = S
    const from = w.C ?? S
    let checked = 0
    for (const [f, score] of w.history) {
      if (f < from) continue
      if (++checked > END_FRAMES) break
      if (score < ABSENT_SCORE) {
        e = f
        break
      }
    }
    let end = e + 1 < n ? frames[e + 1].t : duration
    if (w.holdEnd > end) end = w.holdEnd
    w.result = { start: w.start.t, end }
    w.placements = tidy(w.placements).filter((p) => p.t < end - 1e-9)
    // At e the text is gone from every candidate: a fading glyph stays where it was, in the box held
    // before e (never the whole lost area). Not when its region moved since it was last placed (a
    // scroll carrying it out of view): there it is cut at the frame's edge, not fading, and only the
    // lost area holds it (found end to end, a scrolled email showed for one frame).
    const te = frames[e].t
    const at = w.placements.findIndex((p) => Math.abs(p.t - te) < 1e-9)
    const movedSince = w.drift.dx !== 0 || w.drift.dy !== 0
    if (at > 0 && w.holdEnd <= te && !movedSince) w.placements[at] = { t: te, box: w.placements[at - 1].box }
    w.done = true
  }

  /** Backward: the start of a walk whose text was shown absent at frame S (§4.2, §5.8). */
  const startBackward = (w: Walker, S: number, before: Box | null): void => {
    const start = Math.min(w.start.t, floorMs(frames[S].t + frameS))
    const sorted = tidy(w.placements)
    const nextT = S + 1 < n ? frames[S + 1].t : frames[S].t
    const next = heldAt(sorted, nextT) ?? toNorm(w.box, size)
    // The text is not at S: the first source frame after it needs the box at S + 1, with the box moved back there when the text came from outside.
    const box = before ? normUnion(next, toNorm(before, size)) : next
    w.placements = [...sorted.filter((p) => p.t > start + 1e-9), { t: start, box }]
    w.result = { start, end: w.start.t }
    w.done = true
  }

  const fail = (w: Walker, f: number, r: TrackMatch | undefined, rel: readonly Candidate[], best: Candidate | null, region: Box | null): void => {
    const cf = stepFrame(f)
    const t = frames[f].t
    if (dir === -1) {
      // A page change with no match: the text came with the page. A change the look pass saw as a move
      // of the text's region (a scroll, a drag) is no page change: the text moved with it. Found end to
      // end: a fast scroll that brought the text in was taken for a page change, and the cover started
      // after the scroll, with the text already on screen.
      if (changedShare(frames[cf], look) >= 0.3 && !best) {
        startBackward(w, f, null)
        return
      }
      // The text moved out of the region it moved with, or out of the frame: it scrolled or was dragged
      // into view. Lost, it is where its last placed box moved with the region's moves since.
      if (best) {
        const back = w.lost ? moved(xfBox(w, w.tpl.box, w.off), { dx: w.drift.dx + best.dx, dy: w.drift.dy + best.dy, scale: best.scale }) : moved(w.box, best)
        const outside = right(back) <= 0 || bottom(back) <= 0 || back[0] >= size.width || back[1] >= size.height || (region !== null && !overlaps(back, region))
        if (outside) {
          startBackward(w, f, clip(back, size))
          return
        }
      }
    }
    // Text typed or deleted in place, inside a burst of typing: the band's union holds until the band is still for 1 s.
    if (dir === 1 && (w.hold || (inTyping(t) && bandOnly(w, cf)))) {
      const typing = inTyping(t)
      const until = Math.max(w.hold?.until ?? -Infinity, typing?.until ?? t)
      becomeLost(w, f)
      let box = w.box
      for (const c of changedBoxes(cf, lineBand(w))) box = union(box, c)
      setBox(w, f, box)
      w.hold = { until, lastChange: t }
      return
    }
    // Forward, the backward rule's mirror: the region the text moved with carried it out of the frame
    // (scrolled or dragged out of view), from where it was last placed: it is gone from here on. Found
    // end to end: without it, text scrolled off the screen was lost, its lost area the whole scrolled
    // region, to the end of the recording (a template search over a whole page always finds a part).
    if (dir === 1 && best && !w.hold && w.pending === null) {
      const gone = moved(xfBox(w, w.tpl.box, w.off), { dx: w.drift.dx + best.dx, dy: w.drift.dy + best.dy, scale: best.scale })
      if (right(gone) <= 0 || bottom(gone) <= 0 || gone[0] >= size.width || gone[1] >= size.height) {
        endForward(w, f)
        return
      }
    }
    if (w.pending !== null && dir === 1) {
      endForward(w, w.pending)
      return
    }
    if (w.pending !== null && dir === -1) {
      startBackward(w, w.pending, null)
      return
    }
    becomeLost(w, f)
    const pred = predicted(w)
    const rels = [...rel, { dx: pred.dx - w.off.dx, dy: pred.dy - w.off.dy, scale: 1 }]
    const regions = regionsAt(look, cf)
    setBox(w, f, clip(lostBox(w.box, rels, regions), size))
    if (best) w.drift = { dx: w.drift.dx + best.dx, dy: w.drift.dy + best.dy }
    if (dir === 1) {
      if (w.C === null) w.C = f
      w.history.push([f, maxPart(r)])
    }
    w.justFailed = true
    if (reads.templateOnly) w.bare = true
  }

  const order: number[] = []
  if (dir === 1) {
    const from = Math.min(...walkers.map((w) => w.at))
    for (let f = from; f < n; f++) order.push(f)
  } else {
    const from = Math.max(...walkers.map((w) => w.at))
    for (let f = from; f >= 0; f--) order.push(f)
  }

  let stoppedAt = -1
  for (const f of order) {
    if (options.stopped?.()) {
      stoppedAt = f
      break
    }
    const t = frames[f].t
    const live = walkers.filter((w) => w.active && !w.done && !(dir === -1 && f > w.skipTo))
    if (!walkers.some((w) => !w.done && (w.active || w.joined === undefined))) break

    // 1. Steps: a box holds while nothing under it changed; otherwise every candidate is matched, all tracks at once.
    const asks: { w: Walker; rel: Candidate[]; best: Candidate | null; region: Box | null; xfs: Xf[] }[] = []
    const checks: Walker[] = []
    for (const w of live) {
      if (dir === -1 && w.skipTo !== Infinity && f === w.skipTo) continue
      const cf = stepFrame(f)
      if (cf < 0 || cf >= n) continue
      if (changedUnder(frames[cf], look, w.box) === 0) {
        if ((dir === -1 || reads.checkForward) && w.lost && !w.hold && w.justFailed && w.pending === null && !reads.templateOnly && w.checks < MAX_CHECKS) checks.push(w)
        w.justFailed = false
        // The typing hold ends once the burst is over and the band has been still for 1 s.
        if (dir === 1 && w.hold && t >= w.hold.until && t - w.hold.lastChange >= BAND_STILL_S) {
          w.holdEnd = t
          w.hold = null
          w.C = f
        }
        continue
      }
      const { rel, best, region } = movesFor(f, w.box)
      asks.push({ w, rel, best, region, xfs: candidatesFor(w, f, rel) })
    }
    if (asks.length) {
      const res = await m.match(
        t,
        asks.map((a) => ({ track: a.w.index, parts: a.w.tpl.parts.map((_p, i) => i), candidates: a.xfs }))
      )
      const zoom: typeof asks = []
      for (const a of asks) {
        const r = res.find((x) => x.track === a.w.index)
        if (clear(r)) {
          place(a.w, f, r!.best!)
          a.w.region = a.region
          continue
        }
        // Zoom inside the recorded app: the whole region changed with no move.
        const cf = stepFrame(f)
        const whole = regionsAt(look, cf).find((g) => overlaps(g, a.w.box) && areaOf(intersect(g, a.w.box) ?? [0, 0, 0, 0]) >= 0.5 * areaOf(a.w.box))
        if (whole && !a.rel.length) zoom.push({ ...a, region: whole })
        else fail(a.w, f, r, a.rel, a.best, a.region)
      }
      if (zoom.length) {
        const zr = await m.match(
          t,
          zoom.map((a) => {
            const pred = predicted(a.w)
            const g = a.region!
            return { track: a.w.index, parts: a.w.tpl.parts.map((_p, i) => i), candidates: ZOOMS.map((s) => zoomed(a.w, pred, s, g[0] + g[2] / 2, g[1] + g[3] / 2)) }
          })
        )
        for (const a of zoom) {
          const r = zr.find((x) => x.track === a.w.index)
          if (clear(r)) place(a.w, f, r!.best!)
          else fail(a.w, f, r, a.rel, a.best, null)
        }
      }
    }

    // 2. Reads at this frame: the same text found again re-anchors; a read lacking it is evidence once the template fails everywhere.
    const searches: Walker[] = []
    for (const r of readsAt.get(f) ?? []) {
      if (r.failed) continue
      for (const w of walkers) {
        if (!w.active || w.done || (dir === -1 && f > w.skipTo)) continue
        let same = r.hits.filter((h) => h.key === w.start.key && h.id !== w.start.id && overlaps(h.box, w.box))
        // A lost text the read does not see where it was lost, but sees elsewhere (and no other walk is there): it jumped.
        if (!same.length && w.lost && !w.hold && coverage(r.areas, w.box) >= COVERED && !r.lines.some((l) => overlaps(l.box, w.box) && l.texts.some((x) => holdsText(w.start.own, x))))
          same = r.hits.filter((h) => h.key === w.start.key && h.id !== w.start.id && !walkers.some((o) => o !== w && o.active && !o.done && overlaps(o.box, h.box)))
        if (same.length) {
          const h = same.reduce((a, b) => (areaOf(intersect(a.box, w.box) ?? [0, 0, 0, 0]) >= areaOf(intersect(b.box, w.box) ?? [0, 0, 0, 0]) ? a : b))
          const other = ids.get(h.id)
          if (other !== undefined && other !== w.index && !walkers[other].active) walkers[other].joined = w.index
          w.consumed.push(h.id)
          const wasLost = w.lost
          const held = w.box
          const since = wasLost ? w.lostFrom : w.tpl.t
          await anchor(w, f, h.box, h.parts)
          if (dir === 1 && (wasLost || !(h.box[0] >= held[0] && h.box[1] >= held[1] && right(h.box) <= right(held) && bottom(h.box) <= bottom(held)))) {
            const s = w.start
            w.reanchors.push({ id: `${h.id}~${w.index}`, key: s.key, own: s.own, t, box: h.box, parts: h.parts, line: s.line, until: since })
          }
          continue
        }
        if (!w.lost || w.hold || w.pending !== null || reads.templateOnly || coverage(r.areas, w.box) < COVERED) continue
        const holds = r.lines.some((l) => overlaps(l.box, w.box) && l.texts.some((x) => holdsText(w.start.own, x)))
        if (!holds && !searches.includes(w)) searches.push(w)
      }
    }

    // 3. Check reads (backward, and forward for Follow): a still frame right after a failed step reads the lost area alone.
    for (const w of checks) {
      if (w.done || !w.lost) continue
      w.checks++
      const res = await m.checkRead(t, w.box)
      if (!res) continue
      const line = res.lines.find((l) => overlaps(l.box, w.box) && l.variants.some((v) => holdsText(w.start.own, v.text)))
      if (line) {
        const box = intersect(line.box, w.box) ?? line.box
        await anchor(w, f, box, partsOf(box, line.box[3]))
      } else if (!searches.includes(w)) searches.push(w)
    }

    // Without the reader, a failed frame's template search alone is the evidence.
    for (const w of walkers) {
      if (!w.bare) continue
      w.bare = false
      if (!w.done && !searches.includes(w)) searches.push(w)
    }

    // 4. Template searches: no part at 0.5 anywhere in the region, at any scale.
    if (searches.length) {
      const res = await m.match(
        t,
        searches.map((w) => ({ track: w.index, parts: w.tpl.parts.map((_p, i) => i), candidates: searchCandidates(w, w.box) }))
      )
      for (const w of searches) {
        const r = res.find((x) => x.track === w.index)
        if (maxPart(r) >= ABSENT_SCORE) continue
        // The first evidence holds (the frame nearest the text); later evidence only waits behind it.
        if (!reads.templateOnly) w.pending ??= f
        else if (dir === 1) endForward(w, f)
        else startBackward(w, f, null)
      }
    }

    // 5. Starts at this frame that no walk took in.
    for (const w of walkers) {
      if (w.active || w.done || w.at !== f || w.joined !== undefined) continue
      w.active = true
      await m.track(w.index, t, w.tpl.parts)
      w.placements.push({ t, box: toNorm(w.box, size) })
      w.lastPlaced = f
      if (w.start.until !== undefined && dir === -1 && w.start.until >= t) {
        w.result = { start: t, end: t }
        w.done = true
        continue
      }
      if (dir === -1) typingBack(w, f)
    }

    // A correction walk stops where it was asked to.
    if (dir === -1)
      for (const w of walkers)
        if (w.active && !w.done && w.start.until !== undefined && t <= w.start.until) {
          w.result = { start: t, end: w.start.t }
          w.done = true
        }
  }

  /** The typing rule going back from a start (§5.8): text that grew in its line band just before its read is covered back to the burst's start with one box. */
  function typingBack(w: Walker, R: number): void {
    const band = lineBand(w)
    let first = -1
    let last = frames[R].t
    let elsewhere = false
    let changes = 0
    const tiles: Box[] = []
    for (let j = R; j >= 1; j--) {
      const tj = frames[j].t
      const lh = Math.max(1, w.start.line[3])
      const near = clip([band[0], band[1] - 2 * lh, band[2], band[3] + 4 * lh], size)
      const changed = changedBoxes(j, near)
      const inBand = changed.filter((c) => overlaps(c, band))
      if (inBand.length) {
        if (last - tj >= BAND_STILL_S && first >= 0) break
        first = j
        last = tj
        changes++
        tiles.push(...inBand)
        if (changed.length > inBand.length) elsewhere = true
      } else if (last - tj >= BAND_STILL_S) break
    }
    if (first < 0) return
    const burst = hints.typing.find((b) => b.t <= frames[R].t + 0.3 && b.end >= frames[first].t - 0.3)
    const covered = !!burst || hints.pastes.some((p) => p >= frames[first].t - 0.3 && p <= frames[R].t) || hints.textCursor.some((s) => s.t <= frames[R].t && s.end >= frames[first].t)
    // Without a typing hint, text that grew in its band over several changes (one change is text appearing).
    if (!covered && (elsewhere || changes < 2)) return
    let startIndex = first - 1 >= 0 ? first - 1 : 0
    if (burst) startIndex = Math.min(startIndex, Math.max(0, frameNear(look, burst.t) - 1))
    let box = w.box
    for (const c of tiles) box = union(box, c)
    box = clip(box, size)
    const t0 = frames[startIndex].t
    w.placements.push({ t: t0, box: toNorm(box, size) })
    w.lostSpans.push([t0, frames[R].t])
    w.box = box
    w.lost = true
    w.lostFrom = t0
    w.justFailed = true
    w.skipTo = startIndex
  }

  function finish(w: Walker): Track {
    let start = w.result?.start ?? w.start.t
    let end = w.result?.end ?? w.start.t
    if (!w.result && w.active) {
      if (dir === 1) end = duration
      else start = 0
    }
    if (w.lost && !w.result && w.active) w.lostSpans.push(dir === 1 ? [w.lostFrom, end] : [start, w.lostFrom])
    // Forward: what was placed before the end. Backward: from the start, the box the walk reached there holding back to it.
    const placements = tidy(w.placements).filter((p) => (dir === 1 ? p.t < end - 1e-9 : p.t >= start - 1e-9))
    if (dir === -1 && (!placements.length || placements[0].t > start + 1e-9)) placements.unshift({ t: start, box: toNorm(w.box, size) })
    const lost = w.lostSpans.length > 0
    const out: Track = { placements, start, end, lost, thin: !!reads.templateOnly, lostSpans: spansOf(w.lostSpans) }
    if (w.joined !== undefined) out.joined = w.joined
    if (w.unfinished) out.unfinished = true
    if (w.reanchors.length) out.reanchors = w.reanchors
    if (w.consumed.length) out.consumed = w.consumed
    return out
  }

  // Walks not finished.
  for (const w of walkers) {
    if (!w.active || w.done) continue
    if (stoppedAt >= 0) {
      // Stop: the cover runs on as a lost area over its last box and the region it was moving with.
      w.unfinished = true
      let box = w.box
      for (const g of regionsAt(look, stoppedAt)) if (overlaps(g, box)) box = union(box, g)
      if (w.region) box = union(box, w.region)
      becomeLost(w, stoppedAt)
      setBox(w, stoppedAt, clip(box, size))
      continue
    }
    if (w.pending !== null) {
      if (dir === 1) endForward(w, w.pending)
      else startBackward(w, w.pending, null)
    }
  }
  return walkers.map((w) => finish(w))
}

/** Spans as "start end" pairs joined by ";" (3 decimals, outward). */
function spansOf(spans: readonly [number, number][]): string {
  return spans
    .filter(([a, b]) => b > a)
    .sort((a, b) => a[0] - b[0])
    .map(([a, b]) => `${floorMs(a)} ${Math.ceil(b * 1000 - 1e-6) / 1000}`)
    .join(';')
}

/** The box of a placement list at `t`, in video pixels (tests and callers that check covers). */
export function boxOfTrack(track: Pick<Track, 'placements' | 'start' | 'end'>, t: number, size: Size): Box | null {
  if (t < track.start || t >= track.end) return null
  const sorted = tidy(track.placements)
  const b = heldAt(sorted, t) ?? sorted[0]?.box
  return b ? fromNorm(b, size) : null
}

/**
 * Both walks of every start (§5.8): the backward walk from the latest start down, the forward walk
 * from the earliest up, each start's two tracks joined; then a re-anchored forward walk's correction
 * walked back to where it was lost, its path joined in (the lost area stays). `open` gives the
 * matcher of one session in one direction over [from, to]; it is closed after its walk.
 */
export async function followAll(
  starts: readonly Placed[],
  look: LookData,
  reads: ReadIndex,
  open: (dir: 1 | -1, from: number, to: number) => Promise<Matcher & { close(): Promise<void> }>,
  hints: ReadHints,
  size: Size,
  options: WalkOptions = {}
): Promise<Track[]> {
  if (!starts.length) return []
  const duration = options.duration ?? (look.frames.length ? look.frames[look.frames.length - 1].t + look.step / look.fps : 0)
  const latest = Math.max(...starts.map((s) => s.t))
  const earliest = Math.min(...starts.map((s) => s.t))
  const walk = async (dir: 1 | -1, list: readonly Placed[], from: number, to: number): Promise<Track[]> => {
    const m = await open(dir, from, to)
    try {
      return await walkSpan(list, dir, look, reads, m, hints, size, { ...options, duration })
    } finally {
      await m.close()
    }
  }
  const back = await walk(-1, starts, latest, 0)
  const fwd = options.stopped?.() ? starts.map((s) => ({ placements: [{ t: s.t, box: toNorm(s.box, size) }], start: s.t, end: duration, lost: true, thin: !!reads.templateOnly, lostSpans: `${floorMs(s.t)} ${duration}`, unfinished: true }) as Track) : await walk(1, starts, earliest, duration)
  const tracks = starts.map((s, i) => {
    const b = back[i]
    const f = fwd[i]
    const empty = (t: Track): boolean => t.joined !== undefined
    if (empty(b) && empty(f)) return { ...f, placements: [], start: s.t, end: s.t, joined: f.joined, consumed: [...(b.consumed ?? []), ...(f.consumed ?? [])] }
    if (empty(b)) return { ...joinTracks({ ...f, placements: [], start: s.t, end: s.t, lostSpans: '' }, f), joined: b.joined }
    if (empty(f)) return { ...joinTracks(b, { ...b, placements: [], start: s.t, end: s.t, lostSpans: '' }), joined: f.joined }
    return joinTracks(b, f)
  })
  // Corrections of re-anchored forward walks, walked back to where each was lost.
  const fixes: { track: number; placed: Placed }[] = []
  tracks.forEach((t, i) => (t.reanchors ?? []).forEach((p) => fixes.push({ track: i, placed: p })))
  if (fixes.length && !options.stopped?.()) {
    const from = Math.max(...fixes.map((x) => x.placed.t))
    const fixed = await walk(-1, fixes.map((x) => x.placed), from, Math.min(...fixes.map((x) => x.placed.until ?? 0)))
    fixes.forEach((x, k) => {
      const t = tracks[x.track]
      const fx = fixed[k]
      t.placements = unionPlacements(t.placements, fx.placements, fx.start, fx.end)
    })
  }
  return tracks.map((t) => {
    const { reanchors: _r, ...rest } = t
    void _r
    return rest
  })
}
