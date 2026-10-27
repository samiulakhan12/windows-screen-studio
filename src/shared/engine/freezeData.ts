/**
 * Freeze frames as stored in project.json (E-11, docs/design/freeze-frame.md §3): read back
 * sanitised, so every list the editor and the export see is sorted, unique, inside the recording
 * and within the limits. Implemented and frozen in the contracts commit.
 */
import type { Freeze } from '../types'
import { DEFAULT_FREEZE_SOUND, FREEZE, FREEZE_EPS, MAX_FREEZES } from './freeze'
import { clamp } from './math'

/** Longest freeze id kept. */
const MAX_ID = 64

/** One stored freeze, sanitised; null when it cannot be one (no id, no finite anchor). */
function readFreeze(raw: unknown, duration: number): Freeze | null {
  if (!raw || typeof raw !== 'object' || Array.isArray(raw)) return null
  const f = raw as Partial<Record<keyof Freeze, unknown>>
  if (typeof f.id !== 'string' || f.id.length < 1 || f.id.length > MAX_ID) return null
  if (typeof f.at !== 'number' || !Number.isFinite(f.at)) return null
  // Rounded to 1 ms, then clamped: an anchor at a recording end that is not whole ms stays on it.
  const at = clamp(Math.round(f.at * 1000) / 1000, 0, duration)
  const length = typeof f.length === 'number' && Number.isFinite(f.length) ? clamp(Math.round(f.length * 10) / 10, FREEZE.min, FREEZE.max) : FREEZE.default
  const sound = f.sound === 'continue' ? 'continue' : DEFAULT_FREEZE_SOUND
  return { id: f.id, at, length, sound }
}

/**
 * The freezes of a stored project: each one with a string id (1..64 characters) and a finite
 * anchor, the anchor rounded to 1 ms inside [0, duration], the length in tenths within
 * [FREEZE.min, FREEZE.max] (FREEZE.default when not a number), the sound 'pause' unless it is
 * 'continue'. Sorted by anchor; of two anchors closer than FREEZE_EPS, or two equal ids, the first
 * is kept; at most MAX_FREEZES. Undefined when none is left (or `raw` is not a list), so the
 * project gets no `freezes` key. Idempotent.
 */
export function readFreezes(raw: unknown, duration: number): Freeze[] | undefined {
  if (!Array.isArray(raw)) return undefined
  const read = raw.map((f) => readFreeze(f, duration)).filter((f): f is Freeze => f !== null)
  // Array.prototype.sort is stable: of two equal anchors the earlier entry stays first.
  read.sort((a, b) => a.at - b.at)
  const out: Freeze[] = []
  const ids = new Set<string>()
  for (const f of read) {
    if (out.length >= MAX_FREEZES) break
    if (ids.has(f.id)) continue
    const prev = out[out.length - 1]
    if (prev && f.at - prev.at < FREEZE_EPS) continue
    ids.add(f.id)
    out.push(f)
  }
  return out.length ? out : undefined
}

/**
 * Freezes kept within a recording of `duration` seconds (correctProjectMedia, when the media's
 * real length differs from the project's): readFreezes' rules again. The same array when nothing
 * changes; undefined when none is left.
 */
export function clampFreezes(list: readonly Freeze[], duration: number): Freeze[] | undefined {
  const next = readFreezes(list, duration)
  if (!next) return undefined
  const same =
    next.length === list.length &&
    next.every((f, i) => {
      const g = list[i]
      return f.id === g.id && f.at === g.at && f.length === g.length && f.sound === g.sound
    })
  return same ? (list as Freeze[]) : next
}
