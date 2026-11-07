/**
 * The cut markers of the timeline's clip track (docs/design/editing-polish.md §2.1, §12): one marker
 * of fixed size per cut, whatever the width of its cut block (at the fit scale a 10-minute video gives
 * a 1 s cut 1–2 px), a glyph of the cut's style in a 24 × 24 px target; markers closer than 12 px
 * merge into one with a count that selects the first of them. Pure.
 */
import { planOf } from '../engine/freeze'
import { formatTime } from '../engine/project'
import { cutsOf } from '../render/joins'
import type { JoinKind, Project } from '../types'
import { joinName } from './joinsEdit'

/** The glyph's size, the hit target's, and how close two markers may be before they merge (px). */
export const CUT_MARKER = { glyph: 12, target: 24, merge: 12 } as const

export interface CutMarker {
  /** The first cut's position among the edit's cuts (0-based). */
  index: number
  /** How many cuts the marker stands for (1: only its own). */
  count: number
  /** Its centre, in px from the track's left (the middle of the first cut's block). */
  x: number
  /** The first cut's span in the recording (the gap selection it selects). */
  gap: { start: number; end: number }
  /** The style the first cut has: its own, else every cut's, else a hard cut. */
  kind: JoinKind
  /** Its accessible name and tooltip: "Cut 5 of 37: 1:23.4 to 1:25.0, crossfade". */
  name: string
}

/** The markers of `project`'s cuts at `px` pixels per second, those inside `win` (source seconds) when given. */
export function cutMarkers(project: Project, px: number, win?: { start: number; end: number }): CutMarker[] {
  const cuts = cutsOf(project.clips, planOf(project))
  if (cuts.length === 0) return []
  const own = new Map<string, JoinKind>()
  for (const c of project.joins?.cuts ?? []) if (!own.has(c.clip)) own.set(c.clip, c.kind)
  const every = project.joins?.all?.kind ?? 'cut'
  const out: CutMarker[] = []
  cuts.forEach((cut, k) => {
    const gap = { start: project.clips[cut.index - 1].end, end: project.clips[cut.index].start }
    const x = ((gap.start + gap.end) / 2) * px
    const last = out[out.length - 1]
    if (last && x - last.x < CUT_MARKER.merge) {
      last.count++
      return
    }
    out.push({ index: k, count: 1, x, gap, kind: own.get(cut.clip) ?? every, name: '' })
  })
  const lo = win ? win.start * px - CUT_MARKER.target : -Infinity
  const hi = win ? win.end * px + CUT_MARKER.target : Infinity
  return out
    .filter((m) => m.x >= lo && m.x <= hi)
    .map((m) => ({ ...m, name: markerName(m.index + 1, cuts.length, m.gap, m.kind, m.count) }))
}

/** "Cut 5 of 37: 1:23.4 to 1:25.0, crossfade" (and how many more a merged marker stands for). */
export function markerName(n: number, of: number, gap: { start: number; end: number }, kind: JoinKind, count = 1): string {
  const more = count > 1 ? `, and ${count - 1} more ${count - 1 === 1 ? 'cut' : 'cuts'}` : ''
  return `Cut ${n} of ${of}: ${formatTime(gap.start)} to ${formatTime(gap.end)}, ${joinName(kind).toLowerCase()}${more}`
}
