/**
 * Which frames and areas Find reads (docs/design/auto-blur.md §5.3, §5.4, §5.11): the hints of
 * cursor.json, the detector's buckets and how areas are packed into them, the plan of reads with its
 * budget and thinning, and the estimates the dialog and the progress line show. Pure.
 */
import type { CursorTrack } from '../types'
import { areaOf, bottom, changedShare, changedUnder, clip, frameAtOrAfter, overlaps, pad, regionsAt, right, tileChanged, tileGrid, union, type LookData, type Size } from './look'
import type { Box } from './protocol'

/* ---------- hints (§5.3) ---------- */

export interface ReadHints {
  /** Typing bursts (source seconds; no key content). */
  typing: { t: number; end: number }[]
  /** Clicks, normalised to the recorded frame. */
  clicks: { t: number; x: number; y: number }[]
  /** Times of Ctrl+V, Ctrl+Shift+V and Shift+Insert. */
  pastes: number[]
  /** Spans the cursor was the I-beam (a text field under it). */
  textCursor: { t: number; end: number }[]
  /** Whether click positions can be trusted (window captures have none). */
  valid: boolean
  /** The display scale of the recorded monitor (1 = 100%); every size in screen pixels is multiplied by it. */
  scale: number
}

const PASTE = new Set(['ctrl+v', 'ctrl+shift+v', 'shift+insert', 'shift+ins'])
const finite = (v: unknown): v is number => typeof v === 'number' && Number.isFinite(v)

/** The hints of a cursor track (§5.3), whatever its `valid` says (window captures' times hold). */
export function hintsOf(cursor: CursorTrack | null): ReadHints {
  if (!cursor) return { typing: [], clicks: [], pastes: [], textCursor: [], valid: false, scale: 1 }
  const typing = (cursor.typing ?? []).filter((b) => finite(b.t) && finite(b.end) && b.end >= b.t).map((b) => ({ t: b.t, end: b.end }))
  const clicks = (cursor.clicks ?? []).filter((c) => finite(c.t) && finite(c.x) && finite(c.y)).map((c) => ({ t: c.t, x: c.x, y: c.y }))
  const pastes = (cursor.keys ?? []).filter((k) => finite(k.t) && typeof k.label === 'string' && PASTE.has(k.label.replace(/\s+/g, '').toLowerCase())).map((k) => k.t)
  const textCursor: { t: number; end: number }[] = []
  const shapes = (cursor.shapes ?? []).filter((s) => finite(s.t))
  shapes.forEach((s, i) => {
    if (s.shape !== 'text') return
    const next = shapes.slice(i + 1).find((n) => n.shape !== 'text')
    textCursor.push({ t: s.t, end: next ? next.t : Infinity })
  })
  const scale = finite(cursor.scale) && cursor.scale > 0 ? Math.min(4, Math.max(1, cursor.scale)) : 1
  const byT = <T extends { t: number }>(a: T, b: T): number => a.t - b.t
  return { typing: typing.sort(byT), clicks: clicks.sort(byT), pastes: pastes.sort((a, b) => a - b), textCursor, valid: cursor.valid === true, scale }
}

/* ---------- buckets and packing (§5.4, §5.5) ---------- */

/** The detector's fixed plans: their sizes and costs against the largest (tract-buckets.txt). */
export const BUCKETS: readonly { w: number; h: number; units: number }[] = Object.freeze([
  Object.freeze({ w: 640, h: 352, units: 0.1 }),
  Object.freeze({ w: 960, h: 544, units: 0.2 }),
  Object.freeze({ w: 1920, h: 1088, units: 1 })
])

/** Space kept between areas packed into one bucket. */
const PACK_GAP = 32
/** Overlap of the tiles a large area is cut into. */
const TILE_OVERLAP = 64

/** Whether `areas` fit in a w × h bucket by shelf packing (tallest first, a 32 px gap between them, none cut). */
function shelfFits(areas: readonly Box[], w: number, h: number): boolean {
  const sorted = [...areas].sort((a, b) => b[3] - a[3] || b[2] - a[2])
  let x = 0
  let y = 0
  let shelf = 0
  for (const a of sorted) {
    if (a[2] > w || a[3] > h) return false
    if (x > 0 && x + a[2] > w) {
      y += shelf + PACK_GAP
      x = 0
      shelf = 0
    }
    if (y + a[3] > h) return false
    x += a[2] + PACK_GAP
    shelf = Math.max(shelf, a[3])
  }
  return true
}

/** The smallest bucket holding `a`, or -1 when none does. */
const smallestFor = (a: Box): number => BUCKETS.findIndex((b) => a[2] <= b.w && a[3] <= b.h)

/** An area larger than the largest bucket cut into its tiles (overlapping by 64 px). */
function cutLarge(a: Box): Box[] {
  const big = BUCKETS[BUCKETS.length - 1]
  const out: Box[] = []
  const stepX = big.w - TILE_OVERLAP
  const stepY = big.h - TILE_OVERLAP
  for (let y = a[1]; ; y += stepY) {
    const h = Math.min(big.h, bottom(a) - y)
    for (let x = a[0]; ; x += stepX) {
      const w = Math.min(big.w, right(a) - x)
      out.push([x, y, w, h])
      if (x + w >= right(a)) break
    }
    if (y + h >= bottom(a)) break
  }
  return out
}

/** First-fit decreasing of `areas` into buckets of size `target` (areas that do not fit it go alone to their smallest bucket). */
function packInto(areas: readonly Box[], target: number): { bucket: number; areas: Box[] }[] {
  const bins: { bucket: number; areas: Box[] }[] = []
  const sorted = [...areas].sort((a, b) => areaOf(b) - areaOf(a))
  for (const a of sorted) {
    const own = smallestFor(a)
    if (own > target) {
      bins.push({ bucket: own, areas: [a] })
      continue
    }
    const bin = bins.find((b) => b.bucket === target && shelfFits([...b.areas, a], BUCKETS[target].w, BUCKETS[target].h))
    if (bin) bin.areas.push(a)
    else bins.push({ bucket: target, areas: [a] })
  }
  // A bin holding one area alone goes down to that area's own smallest bucket.
  for (const b of bins) if (b.areas.length === 1) b.bucket = Math.min(b.bucket, smallestFor(b.areas[0]))
  return bins
}

const unitsOf = (bins: readonly { bucket: number }[]): number => Math.round(bins.reduce((s, b) => s + BUCKETS[b.bucket].units, 0) * 1000) / 1000

/**
 * How a read's areas run on the detector's buckets (§5.4): each area padded up to the smallest
 * bucket that holds it, an area larger than 1920×1088 cut into 1920×1088 tiles overlapping by 64 px,
 * and small areas that fit together in one bucket packed into it (shelf packing, a 32 px gap, no area
 * cut). Of the packings into each bucket size, the one costing the fewest units.
 */
export function packAreas(areas: readonly Box[]): { bucket: number; areas: Box[] }[] {
  const all: Box[] = []
  for (const a of areas) {
    if (!(a[2] > 0 && a[3] > 0)) continue
    if (smallestFor(a) < 0) all.push(...cutLarge(a))
    else all.push([a[0], a[1], a[2], a[3]])
  }
  if (!all.length) return []
  let best: { bucket: number; areas: Box[] }[] | null = null
  for (let target = 0; target < BUCKETS.length; target++) {
    const bins = packInto(all, target)
    if (!best || unitsOf(bins) < unitsOf(best) - 1e-9) best = bins
  }
  return best!
}

/** The units a read of `areas` costs. */
export function readUnits(areas: readonly Box[]): number {
  return unitsOf(packAreas(areas))
}

/* ---------- the plan (§5.4) ---------- */

export interface PlannedRead {
  t: number
  areas: Box[]
  packed: { bucket: number; areas: Box[] }[]
  why: 'first' | 'settle' | 'inPlace' | 'reveal' | 'typing' | 'periodic' | 'check' | 'partial'
  units: number
  /** Made by thinning (reads further apart than usual): covers from it are marked thin. */
  thin: boolean
}

export interface ReadPlan {
  reads: PlannedRead[]
  /** The units of every read, check and partial reads included once they are added. */
  units: number
  /** How many reads thinning took out (merged into others or spaced further apart). */
  thinned: number
  /** Spans whose reads were thinned: "start end" pairs joined by ";", source seconds. */
  thinSpans: string
}

/** Gap after a burst before its settle read; burst changes closer than this are one burst (§5.4). */
const SETTLE_S = 0.3
/** Padding of a settle area, in screen pixels (times the display scale). */
const SETTLE_PAD = 64
/** A move lasting longer than this gets reveal reads. */
const REVEAL_AFTER_S = 1.0
/** Size of a typing read's box around the click, in screen pixels. */
const TYPING_BOX = { w: 640, h: 200 }
/** A click this long before a typing burst marks the field. */
const CLICK_BEFORE_S = 5
/** Settle and typing areas closer than this are always read once. */
const USUAL_MERGE_S = 1
/** A page change: this share of the frame changed (SCREEN_RULES.page). */
export const PAGE_SHARE = 0.3

interface Level {
  reveal: number
  periodic: number
  merge: number
}

/** The thinning ladder (§5.4 point 7): the usual plan, then each step in order until the plan fits. */
const LADDER: readonly Level[] = [
  { reveal: 0.75, periodic: 60, merge: USUAL_MERGE_S },
  { reveal: 1.5, periodic: 60, merge: USUAL_MERGE_S },
  { reveal: 1.5, periodic: 120, merge: USUAL_MERGE_S },
  { reveal: 1.5, periodic: 120, merge: 3 },
  { reveal: 1.5, periodic: 120, merge: 5 }
]

/** The budget in units (§5.4): ceil(duration / 8) × min(2, W·H / (1920·1080)). 150 for 20 minutes at 1080p. */
export function readBudget(duration: number, size: Size): number {
  const d = finite(duration) && duration > 0 ? duration : 0
  const ratio = Math.min(2, Math.max(0, (size.width * size.height) / (1920 * 1080)))
  return Math.ceil(d / 8) * ratio
}

/** Boxes joined where they overlap (the union of a list of areas). */
export function joinAreas(areas: readonly Box[]): Box[] {
  const out: Box[] = []
  for (const a of areas) {
    let cur: Box = [a[0], a[1], a[2], a[3]]
    for (let i = 0; i < out.length; i++) {
      if (!overlaps(out[i], cur)) continue
      cur = union(out[i], cur)
      out.splice(i, 1)
      i = -1
    }
    out.push(cur)
  }
  return out
}

/** The bounding boxes of the components of a set of tiles (8-connected), in video pixels. */
function tileBoxes(tiles: Uint8Array, data: LookData): Box[] {
  const { cols, rows, tile } = tileGrid(data)
  const seen = new Uint8Array(tiles.length)
  const out: Box[] = []
  const stack: number[] = []
  for (let i = 0; i < tiles.length; i++) {
    if (!tiles[i] || seen[i]) continue
    let c0 = cols
    let r0 = rows
    let c1 = -1
    let r1 = -1
    seen[i] = 1
    stack.push(i)
    while (stack.length) {
      const j = stack.pop()!
      const x = j % cols
      const y = (j - x) / cols
      c0 = Math.min(c0, x)
      r0 = Math.min(r0, y)
      c1 = Math.max(c1, x)
      r1 = Math.max(r1, y)
      for (let dy = -1; dy <= 1; dy++)
        for (let dx = -1; dx <= 1; dx++) {
          const nx = x + dx
          const ny = y + dy
          if (nx < 0 || ny < 0 || nx >= cols || ny >= rows) continue
          const k = ny * cols + nx
          if (tiles[k] && !seen[k]) {
            seen[k] = 1
            stack.push(k)
          }
        }
    }
    out.push(clip([c0 * tile, r0 * tile, (c1 - c0 + 1) * tile, (r1 - r0 + 1) * tile], data.size))
  }
  return out
}

/** Marks every tile of `box` (video pixels; null: the whole frame) that changed at frame `index` in `into`. */
function markChanged(into: Uint8Array, data: LookData, index: number, box: Box | null): void {
  const { cols, rows, tile } = tileGrid(data)
  const frame = data.frames[index]
  const c0 = box ? Math.max(0, Math.floor(box[0] / tile)) : 0
  const r0 = box ? Math.max(0, Math.floor(box[1] / tile)) : 0
  const c1 = box ? Math.min(cols - 1, Math.ceil(right(box) / tile) - 1) : cols - 1
  const r1 = box ? Math.min(rows - 1, Math.ceil(bottom(box) / tile) - 1) : rows - 1
  for (let r = r0; r <= r1; r++) for (let c = c0; c <= c1; c++) if (tileChanged(frame, r * cols + c)) into[r * cols + c] = 1
}

interface Burst {
  box: Box
  /** Its changed tiles: 1, and 2 for those its latest growth added (its newest); 3 while a frame adds them. */
  tiles: Uint8Array
  first: number
  last: number
  lastIndex: number
  /** The tiles its latest growth added. */
  newest: number[]
  /** The analysed frame before its first change, since it last grew, of a tile older than its newest (null: none). */
  peak: number | null
  /** A region of it moved (a real move, §5.8 step 2): a scroll or a drag, not a change in place. */
  moved: boolean
}

/** A look move this strong is its region's real move (§5.8 step 2). */
const REAL_MOVE = 0.5
/** A line of text lies in one or two rows of look tiles (8 look pixels; a line is about 5 at any size and display scale): at most this many is a line. */
const LINE_ROWS = 3

/**
 * Settle reads (§5.4 point 2): one after each burst of changes in a region. A burst the recording ends
 * in is read at its last source frame (`end`), which shows the most of what came in: at 60 fps the last
 * analysed frame can be one before it, and a line a scroll was bringing in at the bottom edge, cut
 * there, was misread ("+1.415.555.4187") and never found.
 *
 * In-place reads (§5.4 point 2): a burst on one line (at most three rows of tiles) that, after it last
 * grew, changed a tile older than the ones that growth added (the text in it deleted or changed in
 * place, not typed on) and went on changing for 0.3 s or more, with no region of it moving, is also
 * read at the analysed frame before that change, where it showed the most of what came in, over its
 * line band: its padded area from the frame's left edge, where the label of a typed value stands on
 * its line, before it. A zoom or a page changing in place is no line; the reads of its page read it.
 * Found end to end: a key typed into a terminal and deleted again was one burst, read once after it
 * was deleted, over an area that cut its label ("CCESS_KEY=Q"), so it was never found.
 */
function settleReads(data: LookData, scale: number, end?: number): { settle: PlannedRead[]; inPlace: PlannedRead[] } {
  const frames = data.frames
  const out: PlannedRead[] = []
  const inPlace: PlannedRead[] = []
  const open: Burst[] = []
  const { cols, rows, tile } = tileGrid(data)
  const close = (b: Burst): void => {
    // The first analysed frame at least 0.3 s after the burst, when the region is still there; the
    // frame just before the next burst when that burst comes sooner.
    let i = Math.min(frameAtOrAfter(data, b.last + SETTLE_S), frames.length - 1)
    if (i > b.lastIndex && changedUnder(frames[i], data, b.box) > 0) i -= 1
    const areas = tileBoxes(b.tiles, data).map((a) => pad(a, SETTLE_PAD * scale, data.size))
    const at = frames[Math.max(i, b.lastIndex)].t
    const ending = b.lastIndex === frames.length - 1 && end !== undefined && end > at
    out.push(read(ending ? end : at, joinAreas(areas), 'settle'))
    if (b.moved || b.peak === null || b.last - frames[b.peak].t < SETTLE_S - 1e-9 || rowsOf(b.tiles) > LINE_ROWS) return
    inPlace.push(read(frames[b.peak].t, joinAreas(areas.map((a): Box => [0, a[1], right(a), a[3]])), 'inPlace'))
  }
  /** How many rows of tiles a burst's tiles span. */
  const rowsOf = (tiles: Uint8Array): number => {
    let r0 = rows
    let r1 = -1
    for (let j = 0; j < tiles.length; j++)
      if (tiles[j]) {
        const r = Math.floor(j / cols)
        if (r < r0) r0 = r
        if (r > r1) r1 = r
      }
    return r1 - r0 + 1
  }
  /** The changed tiles of `box` at frame `i` new to the burst (marked 3), and whether one older than its newest changed. */
  const mark = (b: Burst, i: number, box: Box): { added: number[]; older: boolean } => {
    const frame = frames[i]
    const c0 = Math.max(0, Math.floor(box[0] / tile))
    const r0 = Math.max(0, Math.floor(box[1] / tile))
    const c1 = Math.min(cols - 1, Math.ceil(right(box) / tile) - 1)
    const r1 = Math.min(rows - 1, Math.ceil(bottom(box) / tile) - 1)
    const added: number[] = []
    let older = false
    for (let r = r0; r <= r1; r++)
      for (let c = c0; c <= c1; c++) {
        const j = r * cols + c
        if (!tileChanged(frame, j)) continue
        if (!b.tiles[j]) {
          b.tiles[j] = 3
          added.push(j)
        } else if (b.tiles[j] === 1) older = true
      }
    return { added, older }
  }
  // The first analysed frame has every tile changed (nothing came before it): the first read reads it.
  for (let i = 1; i < frames.length; i++) {
    const t = frames[i].t
    for (let k = open.length - 1; k >= 0; k--) if (t - open[k].last >= SETTLE_S) close(open.splice(k, 1)[0])
    const now = new Map<Burst, { added: number[]; older: boolean }>()
    for (const region of regionsAt(data, i)) {
      const grown: Box = [region[0] - 2 * 8 * data.k, region[1] - 2 * 8 * data.k, region[2] + 4 * 8 * data.k, region[3] + 4 * 8 * data.k]
      let hit = open.find((b) => overlaps(b.box, grown))
      if (!hit) {
        hit = { box: region, tiles: new Uint8Array(cols * rows), first: t, last: t, lastIndex: i, newest: [], peak: null, moved: false }
        open.push(hit)
      }
      hit.box = union(hit.box, region)
      hit.last = t
      hit.lastIndex = i
      if (frames[i].moves.some((m) => (m.dx || m.dy) && m.score >= REAL_MOVE && overlaps(m.box, region))) hit.moved = true
      const m = mark(hit, i, region)
      const mine = now.get(hit) ?? { added: [], older: false }
      now.set(hit, { added: [...mine.added, ...m.added], older: mine.older || m.older })
      // Bursts that now touch are one: the tiles the other brings are new to it at this frame.
      for (let k = open.length - 1; k >= 0; k--) {
        const o = open[k]
        if (o === hit || !overlaps(o.box, hit.box)) continue
        hit.box = union(hit.box, o.box)
        const into = now.get(hit)!
        for (let j = 0; j < o.tiles.length; j++)
          if (o.tiles[j] && !hit.tiles[j]) {
            hit.tiles[j] = 3
            into.added.push(j)
          }
        into.older ||= now.get(o)?.older ?? false
        now.delete(o)
        hit.moved ||= o.moved
        hit.first = Math.min(hit.first, o.first)
        open.splice(k, 1)
      }
    }
    // Once a frame for each burst it changed: it grew (what it added is its newest), or it changed in
    // place, the frame before being the most it showed.
    for (const [b, s] of now) {
      if (s.added.length) {
        for (const j of b.newest) if (b.tiles[j] === 2) b.tiles[j] = 1
        for (const j of s.added) b.tiles[j] = 2
        b.newest = s.added
        b.peak = null
      } else if (s.older && b.peak === null) b.peak = i - 1
    }
  }
  for (const b of open) close(b)
  return { settle: out, inPlace }
}

interface Scroll {
  box: Box
  start: number
  last: number
  dx: number
  dy: number
  lastReveal: number
}

/** Scroll reveals (§5.4 point 3): during a move lasting over 1.0 s, every `every` seconds, the strip that came into its region. */
function revealReads(data: LookData, every: number, scale: number): PlannedRead[] {
  const out: PlannedRead[] = []
  const open: Scroll[] = []
  const line = 32 * scale
  for (let i = 0; i < data.frames.length; i++) {
    const f = data.frames[i]
    for (let k = open.length - 1; k >= 0; k--) if (f.t - open[k].last > SETTLE_S) open.splice(k, 1)
    for (const m of f.moves) {
      if (!m.dx && !m.dy) continue
      let s = open.find((o) => overlaps(o.box, m.box))
      if (!s) {
        s = { box: m.box, start: f.t, last: f.t, dx: 0, dy: 0, lastReveal: f.t }
        open.push(s)
      }
      s.box = union(s.box, m.box)
      s.last = f.t
      s.dx += m.dx
      s.dy += m.dy
      if (f.t - s.start <= REVEAL_AFTER_S || f.t - s.lastReveal < every - 1e-9) continue
      const strips: Box[] = []
      const b = m.box
      if (s.dy) {
        const h = Math.min(b[3], Math.abs(s.dy) + line)
        strips.push(s.dy < 0 ? [b[0], bottom(b) - h, b[2], h] : [b[0], b[1], b[2], h])
      }
      if (s.dx) {
        const w = Math.min(b[2], Math.abs(s.dx) + line)
        strips.push(s.dx < 0 ? [right(b) - w, b[1], w, b[3]] : [b[0], b[1], w, b[3]])
      }
      out.push(read(f.t, joinAreas(strips.map((x) => clip(x, data.size))), 'reveal'))
      s.dx = 0
      s.dy = 0
      s.lastReveal = f.t
    }
  }
  return out
}

/** Typing reads (§5.4 point 4): 0.3 s after each typing burst ends and after each paste. */
function typingReads(data: LookData, hints: ReadHints): PlannedRead[] {
  const out: PlannedRead[] = []
  const events = [...hints.typing.map((b) => ({ from: b.t, at: b.end + SETTLE_S })), ...hints.pastes.map((p) => ({ from: p, at: p + SETTLE_S }))]
  const { cols, rows } = tileGrid(data)
  for (const e of events) {
    const i = frameAtOrAfter(data, e.at)
    if (i >= data.frames.length) continue
    let areas: Box[] = []
    const click = hints.valid ? [...hints.clicks].reverse().find((c) => c.t <= e.from && e.from - c.t <= CLICK_BEFORE_S) : undefined
    if (click) {
      const w = TYPING_BOX.w * hints.scale
      const h = TYPING_BOX.h * hints.scale
      const cx = click.x * data.size.width
      const cy = click.y * data.size.height
      areas = [clip([cx - w / 2, cy - h / 2, w, h], data.size)]
    } else {
      const tiles = new Uint8Array(cols * rows)
      for (let j = frameAtOrAfter(data, e.from); j <= i; j++) markChanged(tiles, data, j, null)
      areas = joinAreas(tileBoxes(tiles, data).map((a) => pad(a, SETTLE_PAD * hints.scale, data.size)))
    }
    if (areas.length) out.push(read(data.frames[i].t, areas, 'typing'))
  }
  return out
}

/** The first frame (§5.4 point 1): the first analysed frame after the page changes of the opening (black frames, a screen fading in). */
function firstRead(data: LookData): PlannedRead | null {
  const frames = data.frames
  if (!frames.length) return null
  let i = 0
  for (;;) {
    if (frames[i].t > frames[0].t + 10) break
    let next = -1
    for (let j = i + 1; j < frames.length && frames[j].t <= frames[i].t + 1; j++) if (changedShare(frames[j], data) >= PAGE_SHARE) next = j
    if (next < 0) break
    i = next
  }
  return read(frames[i].t, [[0, 0, data.size.width, data.size.height]], 'first')
}

/** Periodic reads (§5.4 point 5): the whole frame in each `every`-second window in which no read covered half of it. */
function periodicReads(data: LookData, reads: readonly PlannedRead[], every: number): PlannedRead[] {
  const frames = data.frames
  if (!frames.length) return []
  const end = frames[frames.length - 1].t
  const half = (data.size.width * data.size.height) / 2
  const out: PlannedRead[] = []
  for (let w = 0; w * every <= end; w++) {
    const from = w * every
    const to = from + every
    const covered = reads.some((r) => r.t >= from && r.t < to && r.areas.reduce((s, a) => s + areaOf(a), 0) >= half)
    if (covered) continue
    let i = frameAtOrAfter(data, Math.min(end, from + every / 2))
    if (i >= frames.length) i = frames.length - 1
    if (frames[i].t < from) continue
    out.push(read(frames[i].t, [[0, 0, data.size.width, data.size.height]], 'periodic'))
  }
  return out
}

/** Settle and typing reads less than `gap` seconds apart whose areas overlap, read once at the later one's frame over the union of their areas (§5.4 point 6). */
function mergeReads(reads: readonly PlannedRead[], gap: number): { reads: PlannedRead[]; spans: [number, number][] } {
  // Merges further apart than the usual 1 s are thinning: their spans are recorded.
  const out: PlannedRead[] = []
  const spans: [number, number][] = []
  // Each read's earliest merged time: a merged read never reaches back further than `gap` (no chains).
  const earliest = new Map<PlannedRead, number>()
  for (const r of [...reads].sort((a, b) => a.t - b.t)) {
    let cur: PlannedRead = { ...r, areas: [...r.areas] }
    let from = r.t
    for (let k = out.length - 1; k >= 0; k--) {
      const o = out[k]
      if (cur.t - o.t >= gap) break
      if (cur.t - (earliest.get(o) ?? o.t) >= gap) continue
      if (!o.areas.some((a) => cur.areas.some((b) => overlaps(a, b)))) continue
      cur = { ...cur, areas: joinAreas([...o.areas, ...cur.areas]), why: cur.why === 'typing' || o.why === 'typing' ? 'typing' : cur.why, thin: cur.thin || o.thin }
      if (cur.t - o.t >= USUAL_MERGE_S) from = Math.min(from, earliest.get(o) ?? o.t)
      out.splice(k, 1)
      earliest.set(cur, Math.min(earliest.get(cur) ?? cur.t, earliest.get(o) ?? o.t))
    }
    if (from < cur.t) spans.push([from, cur.t])
    out.push(cur)
  }
  return { reads: out, spans }
}

function read(t: number, areas: Box[], why: PlannedRead['why']): PlannedRead {
  const packed = packAreas(areas)
  return { t, areas, packed, why, units: unitsOf(packed), thin: false }
}

/** Spans joined where they overlap, as "start end" pairs joined by ";" (3 decimals). */
export function spansText(spans: readonly [number, number][]): string {
  const sorted = spans.filter(([a, b]) => b > a).sort((a, b) => a[0] - b[0])
  const out: [number, number][] = []
  for (const [a, b] of sorted) {
    const last = out[out.length - 1]
    if (last && a <= last[1]) last[1] = Math.max(last[1], b)
    else out.push([a, b])
  }
  return out.map(([a, b]) => `${Math.floor(a * 1000) / 1000} ${Math.ceil(b * 1000) / 1000}`).join(';')
}

/** The spans of a spans text. */
export function spansOf(text: string): [number, number][] {
  if (!text) return []
  const out: [number, number][] = []
  for (const pair of text.split(';')) {
    const [a, b] = pair.split(' ').map(Number)
    if (finite(a) && finite(b) && b > a) out.push([a, b])
  }
  return out
}

/** One level of the ladder: every read, merged and sorted. */
function planAt(look: LookData, hints: ReadHints, level: Level, base: { first: PlannedRead | null; settle: PlannedRead[]; inPlace: PlannedRead[]; typing: PlannedRead[] }): { reads: PlannedRead[]; spans: [number, number][] } {
  const reveal = revealReads(look, level.reveal, hints.scale)
  const merged = mergeReads([...base.settle, ...base.typing], level.merge)
  const spans: [number, number][] = [...merged.spans]
  // In-place reads are never merged: the settle read of their own burst comes after what they read was changed.
  const fixed = [...(base.first ? [base.first] : []), ...merged.reads, ...base.inPlace, ...reveal]
  const periodic = periodicReads(look, fixed, level.periodic)
  if (level.reveal > 0.75) for (const r of reveal) spans.push([Math.max(0, r.t - level.reveal), r.t])
  if (level.periodic > 60) for (const r of periodic) spans.push([Math.max(0, r.t - level.periodic / 2), r.t + level.periodic / 2])
  const reads = [...fixed, ...periodic].sort((a, b) => a.t - b.t || (a.why === 'first' ? -1 : 0))
  return { reads, spans }
}

/**
 * The reads of a recording (§5.4): the first frame, settle reads after bursts of changes and in-place
 * reads of bursts changed in place after they grew, scroll reveals, typing reads, periodic reads, with
 * settle and typing areas less than 1 s apart read once. Over `budget` units it thins, in this order,
 * until it fits: reveals every 1.5 s, periodic reads every 120 s, then settle and typing areas merged
 * when less than 3 s apart, then 5 s; in-place reads count against it and are never merged. A read is never
 * dropped: merging keeps every area, so a plan still over the budget after the last step (even past
 * twice the budget) runs whole. The thinned spans are recorded and the reads made by thinning marked.
 * `end` is the time of the recording's last source frame, where a burst it ends in is read.
 */
export function planReads(look: LookData, hints: ReadHints, size: Size, fps: number, budget: number, end?: number): ReadPlan {
  void size
  void fps
  if (!look.frames.length) return { reads: [], units: 0, thinned: 0, thinSpans: '' }
  const bursts = settleReads(look, hints.scale, end)
  const base = { first: firstRead(look), settle: bursts.settle, inPlace: bursts.inPlace, typing: typingReads(look, hints) }
  const usual = planAt(look, hints, LADDER[0], base)
  let chosen = usual
  let level = 0
  const sum = (rs: readonly PlannedRead[]): number => Math.round(rs.reduce((s, r) => s + r.units, 0) * 1000) / 1000
  while (sum(chosen.reads) > budget + 1e-9 && level < LADDER.length - 1) {
    level++
    chosen = planAt(look, hints, LADDER[level], base)
  }
  const spans = level > 0 ? chosen.spans : []
  const thinSet = spansOf(spansText(spans))
  const reads = chosen.reads.map((r) => (level > 0 && thinSet.some(([a, b]) => r.t >= a - 1e-6 && r.t <= b + 1e-6) && r.why !== 'first' ? { ...r, thin: true } : r))
  return { reads, units: sum(reads), thinned: Math.max(0, usual.reads.length - reads.length), thinSpans: spansText(spans) }
}

/** Adds a read Find asked for while it runs (a check read or the rest of a partial read, §5.4 point 8) to the plan's units and reads. */
export function addRead(plan: ReadPlan, t: number, areas: readonly Box[], why: 'check' | 'partial'): PlannedRead {
  const r = read(t, [...areas], why)
  plan.reads.push(r)
  plan.units = Math.round((plan.units + r.units) * 1000) / 1000
  return r
}

/* ---------- estimates (§5.11) ---------- */

/** Decode time of one 1080p frame on one thread (decode-speed.txt), until this PC's own is known. */
const DECODE_MS = 1.85
/** Speed-up of the look pass's two decoding threads. */
const DECODE_THREADS = 1.8
/** One unit with its lines and careful re-reads, on one thread (§5.6). */
export const UNIT_SECONDS = 2.9
/** Decode of one half-size follow frame of a 1080p recording (decode-speed.txt). */
const FOLLOW_MS = 3.05
/** Share of the frames follow sessions decode (§5.11). */
const FOLLOW_SHARE = 0.15

const areaRatio = (size: Size): number => Math.max(0.05, (size.width * size.height) / (1920 * 1080))

/** Find's first estimate in seconds (§5.11): frames × d / 1.8 + readBudget × 2.9 s + 0.05 × duration. */
export function firstEstimate(duration: number, fps: number, size: Size, decodeMs: number | null): number {
  const d = finite(duration) && duration > 0 ? duration : 0
  const rate = finite(fps) && fps > 0 ? fps : 60
  const perFrame = (finite(decodeMs) && decodeMs > 0 ? decodeMs : DECODE_MS) * areaRatio(size)
  return (d * rate * perFrame) / 1000 / DECODE_THREADS + readBudget(d, size) * UNIT_SECONDS + 0.05 * d
}

/**
 * Find's second estimate in seconds, after the look pass (§5.11): the plan's units at the read speed
 * measured on this run's first reads (seconds a unit; 2.9 s until measured), the follow sessions'
 * decoding and matching, and the rules.
 */
export function secondEstimate(plan: ReadPlan, look: LookData, measured: { readSeconds: number | null }): number {
  const perUnit = finite(measured.readSeconds) && measured.readSeconds > 0 ? measured.readSeconds : UNIT_SECONDS
  const frames = look.frames
  const duration = frames.length ? frames[frames.length - 1].t + look.step / Math.max(1, look.fps) : 0
  const follow = (FOLLOW_SHARE * duration * look.fps * FOLLOW_MS * areaRatio(look.size)) / 1000 + 0.0083 * duration
  return plan.units * perUnit + follow + 0.02 * plan.units
}
