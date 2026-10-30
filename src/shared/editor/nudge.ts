/**
 * Nudging the selected items by frames (E-09, docs/design/versions.md §4): one frame is the
 * editor's frame (1/30 s of source time, as the step keys move the playhead), ten with Shift.
 * The move is the multi-select move (groupMove.ts): limited by the recording's ends, other zooms
 * and freeze frames' clips, refused when a freeze frame cannot take the frame. Pure.
 */
import type { Project } from '../types'
import { groupAccepts, groupMovePlan, moveGroup, type StopReason } from './groupMove'
import type { ItemKey } from './multiSelect'

/** One frame of the editor, in seconds (Editor.tsx stepBack / stepForward). */
export const NUDGE_FRAME = 1 / 30

export interface NudgeResult {
  project: Project
  /** Seconds the items moved (negative: earlier); 0 when they could not move. */
  moved: number
  /** Why the move came out shorter than asked, or did not happen. */
  stopped: StopReason | null
}

/** Items `keys` moved by `frames` frames (negative: earlier), as far as their limits allow. */
export function nudgeItems(p: Project, keys: readonly ItemKey[], frames: number): NudgeResult {
  const want = frames * NUDGE_FRAME
  const plan = groupMovePlan(p, keys)
  if (plan.initial.size === 0 || !Number.isFinite(want) || want === 0) return { project: p, moved: 0, stopped: null }
  const d = Math.min(plan.max, Math.max(plan.min, want))
  const stopped = Math.abs(d - want) > 1e-9 ? (want < d ? plan.minWhy : plan.maxWhy) : null
  if (Math.abs(d) < 1e-9) return { project: p, moved: 0, stopped }
  if (!groupAccepts(p, plan, d)) return { project: p, moved: 0, stopped: 'freeze-taken' }
  const project = moveGroup(p, plan, d)
  return { project, moved: project === p ? 0 : d, stopped }
}

/** The undo key of nudging `keys`: presses less than the merge window apart are one undo step (§4.4). */
export const nudgeUndoKey = (keys: readonly ItemKey[]): string => `nudge:${[...keys].sort().join(',')}`

/** "Moved 1 item 1 frame later", "Moved 3 items 10 frames earlier". */
export function nudgedNotice(items: number, frames: number): string {
  const n = Math.abs(frames)
  return `Moved ${items} item${items === 1 ? '' : 's'} ${n} frame${n === 1 ? '' : 's'} ${frames > 0 ? 'later' : 'earlier'}`
}
