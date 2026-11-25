/**
 * Pop-up notifications (docs/design/auto-blur.md §6.13), found from the look data alone: boxes that
 * slide in at a corner of a whole-screen recording, stay still and go 2-30 s later. Imported videos,
 * area and window recordings never run it. Stacked notices are covered each, and their union while two
 * or more show (finding 5). Pure.
 */
import type { Project } from '../types'
import { clip, regionsAt, tileChanged, tileGrid, type LookData } from './look'
import type { Box } from './protocol'

export interface Notice {
  start: number
  end: number
  box: Box
  /** The union of a stack of notices, for the time two or more show. */
  stacked: boolean
}

/** A notice's changed tiles fill this much of its box. */
const FILL = 0.8
/** Width and height as shares of the frame. */
const WIDTH = [0.12, 0.3]
const HEIGHT = [0.05, 0.35]
/** Its right edge this near the frame's right edge; its top or bottom this near the frame's. */
const RIGHT_EDGE = 0.03
const TOP_BOTTOM = 0.15
/** Its life. */
const LIFE = [2, 30]
/** While it shows, fewer than this share of its tiles change in any second. */
const STILL = 0.1
/** Sliding in or out: the frames of this long after the first change are one appearance. */
const SLIDE_S = 0.5
/** Most of its tiles change when it goes. */
const GONE = 0.5
/** A push starts with the toast's going: the next toast and the toast moving to the slot beside start together. */
const PUSH_S = 0.17
/** A stack of toasts is at most this share of the frame's height (Windows shows three). */
const STACK_HEIGHT = 0.6

/** Whether Find looks for notifications in this project: whole-screen recordings, never an imported video. */
export function noticesApply(project: Pick<Project, 'capture' | 'source'>): boolean {
  if (project.source) return false
  const target = project.capture?.target ?? (project.capture?.region ? 'area' : 'screen')
  return target === 'screen'
}

interface TileBox {
  c0: number
  r0: number
  c1: number
  r1: number
}

/**
 * The notifications of a recording (§6.13): each changed region that appears in one analysed frame
 * from still surroundings (its tiles filling 80% or more of its box), is 12-30% of the frame's width
 * and 5-35% of its height, sits within 3% of the right edge and 15% of the top or bottom, stays still
 * (no moves, under 10% of its tiles changing a second) and goes 2-30 s later or at the recording's
 * end. Each is covered for its whole life from the frame it starts sliding in; the union of a stack
 * is covered while two or more show. Nothing for an imported video or an area or window recording.
 */
export function findNotices(look: LookData, project: Pick<Project, 'capture' | 'source'>): Notice[] {
  if (!noticesApply(project) || !look.frames.length) return []
  const frames = look.frames
  const n = frames.length
  const { cols, rows, tile } = tileGrid(look)
  const W = look.size.width
  const H = look.size.height
  const fps = look.fps > 0 ? look.fps : 60
  const end = frames[n - 1].t + look.step / fps
  const toTiles = (b: Box): TileBox => ({ c0: Math.max(0, Math.floor(b[0] / tile)), r0: Math.max(0, Math.floor(b[1] / tile)), c1: Math.min(cols - 1, Math.ceil((b[0] + b[2]) / tile) - 1), r1: Math.min(rows - 1, Math.ceil((b[1] + b[3]) / tile) - 1) })
  const count = (i: number, b: TileBox): number => {
    let k = 0
    for (let r = b.r0; r <= b.r1; r++) for (let c = b.c0; c <= b.c1; c++) if (tileChanged(frames[i], r * cols + c)) k++
    return k
  }
  const tilesOf = (b: TileBox): number => (b.c1 - b.c0 + 1) * (b.r1 - b.r0 + 1)
  const overlapOf = (a: TileBox, b: TileBox): number => Math.max(0, Math.min(a.c1, b.c1) - Math.max(a.c0, b.c0) + 1) * Math.max(0, Math.min(a.r1, b.r1) - Math.max(a.r0, b.r0) + 1)
  /**
   * The changed tiles of frame `i` in `b` that are its own: those of regions lying half or more inside
   * it. A region mostly outside it is a neighbour's, a toast stacking next to it sliding in or out over
   * the row of tiles they share (each toast's shadow reaches into the other's tiles).
   */
  const ownCount = (i: number, b: TileBox): number => {
    let k = 0
    for (const g of regionsAt(look, i).map(toTiles)) {
      const o = overlapOf(g, b)
      if (o && 2 * o >= tilesOf(g)) k += count(i, { c0: Math.max(g.c0, b.c0), r0: Math.max(g.r0, b.r0), c1: Math.min(g.c1, b.c1), r1: Math.min(g.r1, b.r1) })
    }
    return k
  }
  const ring = (b: TileBox): TileBox => ({ c0: Math.max(0, b.c0 - 2), r0: Math.max(0, b.r0 - 2), c1: Math.min(cols - 1, b.c1 + 2), r1: Math.min(rows - 1, b.r1 + 2) })
  const boxOf = (b: TileBox): Box => clip([b.c0 * tile, b.r0 * tile, (b.c1 - b.c0 + 1) * tile, (b.r1 - b.r0 + 1) * tile], look.size)
  const shaped = (b: Box): boolean => {
    const w = b[2] / W
    const h = b[3] / H
    const nearRight = W - (b[0] + b[2]) <= RIGHT_EDGE * W
    const nearTop = b[1] <= TOP_BOTTOM * H
    const nearBottom = H - (b[1] + b[3]) <= TOP_BOTTOM * H
    return w >= WIDTH[0] && w <= WIDTH[1] && h >= HEIGHT[0] && h <= HEIGHT[1] && nearRight && (nearTop || nearBottom)
  }
  const moved = (i: number, b: Box): boolean => frames[i].moves.some((m) => (m.dx || m.dy) && m.box[0] < b[0] + b[2] && b[0] < m.box[0] + m.box[2] && m.box[1] < b[1] + b[3] && b[1] < m.box[1] + m.box[3])

  /** The first source frame a change seen at analysed frame `i` can show in: the one after the analysed frame before. */
  const firstShown = (i: number): number => (i > 0 ? Math.min(frames[i].t, frames[i - 1].t + 1 / fps) : frames[i].t)
  /** The regions of frame `k` overlapping `b`, as tile boxes. */
  const touching = (k: number, b: TileBox): TileBox[] => regionsAt(look, k).map(toTiles).filter((g) => g.c0 <= b.c1 && b.c0 <= g.c1 && g.r0 <= b.r1 && b.r0 <= g.r1)
  const joined = (a: TileBox, b: TileBox): TileBox => ({ c0: Math.min(a.c0, b.c0), r0: Math.min(a.r0, b.r0), c1: Math.max(a.c1, b.c1), r1: Math.max(a.r1, b.r1) })
  /** A region along the stack's column (its columns within two tiles of the stack's), the stack staying within STACK_HEIGHT of the frame. */
  const alongStack = (g: TileBox, stack: TileBox): boolean => g.c0 >= stack.c0 - 2 && g.c1 <= stack.c1 + 2 && (Math.max(stack.r1, g.r1) - Math.min(stack.r0, g.r0) + 1) * tile <= STACK_HEIGHT * H
  /**
   * Whether a notice's going at frame `gone` is a push: the next toast arriving in its slot and moving it to
   * the slot beside (how Windows stacks them, the newest at the bottom), or the stack closing a gap. Its own
   * change reaches beyond its box, along its column, within PUSH_S of its going, by half its height or more
   * within SLIDE_S. The stack's box then, or null.
   */
  const pushOf = (gone: number, box: TileBox): TileBox | null => {
    let stack = box
    let early = false
    for (let k = gone; k < n && frames[k].t - frames[gone].t <= SLIDE_S; k++)
      for (const g of touching(k, box)) {
        if (!alongStack(g, stack)) continue
        if ((g.r0 < box.r0 || g.r1 > box.r1) && frames[k].t - frames[gone].t <= PUSH_S) early = true
        stack = joined(stack, g)
      }
    return early && 2 * (box.r0 - stack.r0 + stack.r1 - box.r1) >= box.r1 - box.r0 + 1 ? stack : null
  }

  const found: Notice[] = []
  const used = new Set<string>()
  for (let i = 1; i < n; i++) {
    for (const region of regionsAt(look, i)) {
      const tb = toTiles(region)
      const key = `${i}:${tb.c0}:${tb.r0}`
      if (used.has(key)) continue
      // Appears from still surroundings, rectangular.
      if (count(i, tb) < FILL * tilesOf(tb)) continue
      const around = ring(tb)
      if (count(i, around) - count(i, tb) > 0) continue
      // Sliding in: the next frames' regions that touch it, within half a second, are the same appearance.
      let box = tb
      let j = i + 1
      // The regions of its sliding in: never an appearance of their own once it is found.
      const slid: string[] = []
      for (; j < n && frames[j].t - frames[i].t <= SLIDE_S; j++) {
        const grow = regionsAt(look, j)
          .map(toTiles)
          .filter((g) => g.c0 <= box.c1 + 1 && box.c0 <= g.c1 + 1 && g.r0 <= box.r1 + 1 && box.r0 <= g.r1 + 1)
        if (!grow.length) break
        for (const g of grow) {
          slid.push(`${j}:${g.c0}:${g.r0}`)
          box = { c0: Math.min(box.c0, g.c0), r0: Math.min(box.r0, g.r0), c1: Math.max(box.c1, g.c1), r1: Math.max(box.r1, g.r1) }
        }
      }
      const px = boxOf(box)
      if (!shaped(px)) continue
      // Still while it shows, until most of it changes (it goes).
      const total = tilesOf(box)
      let gone = -1
      let still = true
      let windowStart = j < n ? frames[j].t : end
      let windowCount = 0
      for (let k = j; k < n; k++) {
        const c = ownCount(k, box)
        if (c >= GONE * total) {
          gone = k
          break
        }
        if (moved(k, px)) {
          still = false
          break
        }
        if (frames[k].t - windowStart >= 1) {
          windowStart = frames[k].t
          windowCount = 0
        }
        windowCount += c
        if (windowCount >= STILL * total) {
          still = false
          break
        }
      }
      if (!still) continue
      const stack = gone >= 0 ? pushOf(gone, box) : null
      if (stack) {
        // Pushed: the toast moved to the slot beside and the next one took its slot; neither went. The stack
        // is covered over every slot it reaches, from the push until its last change, the last toast going:
        // a change over it keeps it, as toasts arrive, go and close up (a push along its column grows it).
        // Its changes are never appearances. A toast lives 30 s at most, so a stack with no change for
        // longer has gone with its last change; one the recording ends within 30 s of its last change is
        // covered to the end.
        let box2 = stack
        let lastEvent = gone
        let k = gone
        let quiet = false
        for (; k < n; k++) {
          if (frames[k].t - frames[lastEvent].t > LIFE[1]) {
            quiet = true
            break
          }
          const over = touching(k, box2)
          if (!over.length) continue
          lastEvent = k
          for (const g of over) {
            used.add(`${k}:${g.c0}:${g.r0}`)
            if (alongStack(g, box2)) box2 = joined(box2, g)
          }
        }
        const until = quiet && lastEvent + 1 < n ? frames[lastEvent + 1].t : end
        if (until - frames[i].t < LIFE[0]) continue
        for (let k2 = i; k2 < j; k2++) used.add(`${k2}:${box.c0}:${box.r0}`)
        for (const s of slid) used.add(s)
        found.push({ start: firstShown(i), end: firstShown(gone), box: px, stacked: false })
        found.push({ start: firstShown(gone), end: until, box: boxOf(box2), stacked: false })
        continue
      }
      // Sliding out: the frames of half a second after it starts going. Its going is never an appearance.
      let last = gone
      if (gone >= 0) for (let k = gone + 1; k < n && frames[k].t - frames[gone].t <= SLIDE_S && ownCount(k, box) > 0; k++) last = k
      if (gone >= 0) for (let k = gone; k <= last; k++) for (const g of touching(k, box)) used.add(`${k}:${g.c0}:${g.r0}`)
      const until = gone < 0 ? end : last + 1 < n ? frames[last + 1].t : end
      const life = (gone < 0 ? end : frames[gone].t) - frames[i].t
      if (life < LIFE[0] || life > LIFE[1]) continue
      for (let k = i; k < j; k++) used.add(`${k}:${box.c0}:${box.r0}`)
      for (const s of slid) used.add(s)
      found.push({ start: firstShown(i), end: until, box: px, stacked: false })
    }
  }
  found.sort((a, b) => a.start - b.start)
  // Stacks: notices whose boxes touch or overlap and whose lives overlap; their union while two or more show.
  const stacks: Notice[] = []
  for (let a = 0; a < found.length; a++)
    for (let b = a + 1; b < found.length; b++) {
      const A = found[a]
      const B = found[b]
      const from = Math.max(A.start, B.start)
      const to = Math.min(A.end, B.end)
      if (!(to > from)) continue
      const touch = A.box[0] <= B.box[0] + B.box[2] && B.box[0] <= A.box[0] + A.box[2] && A.box[1] <= B.box[1] + B.box[3] && B.box[1] <= A.box[1] + A.box[3]
      if (!touch) continue
      const x = Math.min(A.box[0], B.box[0])
      const y = Math.min(A.box[1], B.box[1])
      const u: Box = [x, y, Math.max(A.box[0] + A.box[2], B.box[0] + B.box[2]) - x, Math.max(A.box[1] + A.box[3], B.box[1] + B.box[3]) - y]
      const same = stacks.find((s) => s.start < to && from < s.end && s.box[0] <= u[0] + u[2] && u[0] <= s.box[0] + s.box[2] && s.box[1] <= u[1] + u[3] && u[1] <= s.box[1] + s.box[3])
      if (same) {
        const sx = Math.min(same.box[0], u[0])
        const sy = Math.min(same.box[1], u[1])
        same.box = [sx, sy, Math.max(same.box[0] + same.box[2], u[0] + u[2]) - sx, Math.max(same.box[1] + same.box[3], u[1] + u[3]) - sy]
        same.start = Math.min(same.start, from)
        same.end = Math.max(same.end, to)
      } else stacks.push({ start: from, end: to, box: u, stacked: true })
    }
  return [...found, ...stacks].sort((a, b) => a.start - b.start || Number(a.stacked) - Number(b.stacked))
}
