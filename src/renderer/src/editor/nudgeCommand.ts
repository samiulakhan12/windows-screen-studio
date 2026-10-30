/**
 * The nudge commands in the editor (E-09, docs/design/versions.md §4): the selected items move by
 * frames in one store.update each, keyed so that a run of presses is one undo step, and one notice
 * says how far the run moved them (or why they stopped).
 */
import type { EditStore } from '../../../shared/editor/editStore'
import type { ItemKey } from '../../../shared/editor/multiSelect'
import { movedNotice } from '../../../shared/editor/multiSelectCopy'
import { nudgedNotice, nudgeItems, nudgeUndoKey, type NudgeResult } from '../../../shared/editor/nudge'
import type { Project } from '../../../shared/types'

/** The run of presses the notice counts: same items, presses less than this apart (the undo merge window). */
const RUN_MS = 800
let run: { key: string; frames: number; at: number } | null = null

/** Moves `keys` by `frames` frames and says so. */
export function nudgeSelected(store: EditStore<Project>, keys: readonly ItemKey[], frames: number, notice: (text: string) => void, now: number = performance.now()): void {
  const undoKey = nudgeUndoKey(keys)
  let r: NudgeResult | null = null
  store.update((p) => (r = nudgeItems(p, keys, frames)).project, undoKey)
  const done = r as NudgeResult | null
  if (!done) return
  if (done.stopped) {
    run = null
    notice(movedNotice(done.moved, done.stopped) ?? '')
    return
  }
  const same = run && run.key === undoKey && now - run.at <= RUN_MS && Math.sign(run.frames) === Math.sign(frames)
  run = { key: undoKey, frames: (same ? run!.frames : 0) + frames, at: now }
  notice(nudgedNotice(keys.length, run.frames))
}
