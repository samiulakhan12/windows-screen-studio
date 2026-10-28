/**
 * Moving several items together (E-06, docs/design/multi-select.md §4.8, §4.9): the block limits
 * of a group, which deltas its freeze frames accept, the move itself (one project out, the same
 * project when nothing changes), the Starts at / ±1 s moves and the shared Length. Pure.
 */
import type { Project } from '../types'
import type { ItemKey } from './multiSelect'

/** Why a group move stops: the recording's start or end, a zoom in the way, a freeze frame's clip or frame, or a full group. */
export type StopReason = 'start' | 'end' | 'zoom' | 'freeze-clip' | 'freeze-in-cut' | 'freeze-taken' | 'full'

export interface GroupMovePlan {
  keys: readonly ItemKey[]
  /** Each member's times at the press (points: start === end). */
  initial: ReadonlyMap<ItemKey, { start: number; end: number }>
  /** Allowed delta (source seconds): min <= 0 <= max. */
  min: number
  max: number
  minWhy: StopReason | null
  maxWhy: StopReason | null
  /** The group's outer times. */
  span: { start: number; end: number }
  /** Selected freeze ids, in anchor order. */
  freezes: readonly string[]
}

export function groupMovePlan(p: Project, keys: readonly ItemKey[]): GroupMovePlan {
  void p
  return { keys, initial: new Map(), min: 0, max: 0, minWhy: null, maxWhy: null, span: { start: 0, end: 0 }, freezes: [] }
}

export function groupAccepts(p: Project, plan: GroupMovePlan, delta: number): boolean {
  void p
  void plan
  void delta
  return true
}

export function moveGroup(p: Project, plan: GroupMovePlan, delta: number, exact?: { from: number; to: number } | null): Project {
  void plan
  void delta
  void exact
  return p
}

export function groupSnapPoints(plan: GroupMovePlan, grabbed: ItemKey): number[] {
  void plan
  void grabbed
  return []
}

export function setGroupStart(p: Project, keys: readonly ItemKey[], t: number): { project: Project; moved: number; stopped: StopReason | null } {
  void keys
  void t
  return { project: p, moved: 0, stopped: null }
}

export function setGroupLength(p: Project, keys: readonly ItemKey[], length: number): { project: Project; clamped: number } {
  void keys
  void length
  return { project: p, clamped: 0 }
}
