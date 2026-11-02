/**
 * The time each row of Review mode's panel shows (docs/design/review-mode.md §4.3): the video time
 * of the item's start (videoTimeAt, freeze frames counted), as m:ss.t. Pure.
 *
 * A 3-hour recording lists thousands of rows over thousands of clips, and the panel reads the times
 * on every change: they are worked out together in one pass over the clips (videoTimesAt) and kept
 * by start for each clips array and freeze plan, so an edit that leaves the clips alone (K on a
 * zoom, a new zoom, a move in the list) reads them back, and only a start not seen yet is worked out.
 */
import { videoTimesAt, type FreezePlan } from '../engine/freeze'
import { formatTime } from '../engine/project'
import type { Clip } from '../types'

const memo = new WeakMap<readonly Clip[], { plan: FreezePlan; byStart: Map<number, string> }>()

/** Each item's time as the panel shows it, in the order of `items`. */
export function rowTimes(items: readonly { start: number }[], clips: Clip[], plan: FreezePlan): string[] {
  let known = memo.get(clips)
  if (!known || known.plan !== plan) memo.set(clips, (known = { plan, byStart: new Map() }))
  const byStart = known.byStart
  const missing: number[] = []
  for (const i of items) if (!byStart.has(i.start)) missing.push(i.start)
  if (missing.length > 0) {
    const times = videoTimesAt(clips, plan, missing)
    missing.forEach((t, k) => byStart.set(t, formatTime(times[k])))
  }
  return items.map((i) => byStart.get(i.start) as string)
}
