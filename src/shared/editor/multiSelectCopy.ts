/**
 * What the editor says about selecting several items and acting on them (E-06,
 * docs/design/multi-select.md §5.6). Pure, so the wording is tested in one place.
 */
import { commandInfo } from './commands'
import type { StopReason } from './groupMove'
import { groupLabel, type ItemKey } from './multiSelect'

/** Kinds that stay one at a time, and why (§3). */
export type RefusedKind = 'clip' | 'click' | 'caption' | 'layout'

export const REFUSAL_TEXT: Readonly<Record<RefusedKind, string>> = {
  clip: 'Clips and cuts are selected one at a time',
  click: 'Recorded clicks are ignored one at a time, or with Find stray clicks',
  caption: 'Captions are edited one at a time, or all at once in the Captions tab',
  layout: "Camera layouts are changed one at a time; the director's tools redo many at once"
}

/** Why a group stops, as the end of "The selection stops here: …" and "Moved 0.6 s later: …". */
const STOP_WHY: Readonly<Record<Exclude<StopReason, 'freeze-in-cut' | 'full'>, string>> = {
  start: 'the start of the recording',
  end: 'the end of the recording',
  zoom: 'a zoom is in the way',
  'freeze-clip': 'a freeze frame stays in its clip (drag it alone to move it past a cut)',
  'freeze-taken': 'a freeze frame is already on that frame'
}

/** The notice the first time a group drag is held back by a limit. */
export function stopNotice(why: StopReason): string {
  if (why === 'freeze-in-cut') return "A selected freeze frame is in a cut, so the selection can't move. Ctrl+click it to leave it out"
  if (why === 'full') return 'The selection already fills the recording'
  return `The selection stops here: ${STOP_WHY[why]}`
}

const secs = (v: number): string => `${+Math.abs(v).toFixed(1)} s`

/** After Starts at or ±1 s: what happened when a limit cut the move short (null when it went as asked). */
export function movedNotice(moved: number, stopped: StopReason | null): string | null {
  if (!stopped) return null
  if (stopped === 'freeze-in-cut' || stopped === 'full') return stopNotice(stopped)
  if (Math.abs(moved) < 1e-9) return `Not moved: ${STOP_WHY[stopped]}`
  return `Moved ${secs(moved)} ${moved > 0 ? 'later' : 'earlier'}: ${STOP_WHY[stopped]}`
}

/** After Ctrl+A: "Selected all 12 text items · Ctrl + A again selects every item", "Selected every item (24)". */
export function selectAllNotice(scope: 'track' | 'all' | 'none', keys: readonly ItemKey[], againKey: string | null): string {
  if (scope === 'none') return 'No items to select yet'
  if (scope === 'all') return `Selected every item (${keys.length})`
  const label = groupLabel(keys)
  // Shapes and spotlights share a track.
  const what = label.includes(' · ') ? `${keys.length} items on the shapes track` : label
  const again = againKey ? ` · ${againKey} again selects every item` : ''
  return keys.length === 1 ? `Selected the only ${label.replace(/^1 /, '')}${again}` : `Selected all ${what}${again}`
}

/** "Deleted 5 items" / "Cut 5 items", with the undo hint. */
export function removedNotice(verb: 'Deleted' | 'Cut', n: number, undo: string): string {
  return `${verb} ${n} item${n === 1 ? '' : 's'}${undo}`
}

/**
 * Why there is no look to paste (Paste look's disabled reason and the notice), naming the key that
 * copies one: `copyKey` is its label from the user's keymap ("Ctrl + Shift + C"), null when the
 * command has none, and then the item's Copy look button is named instead.
 */
export function copyLookFirst(copyKey: string | null): string {
  return copyKey ? `Copy a look first: select one item and press ${copyKey}` : 'Copy a look first: select one item and press its Copy look button'
}

/** Ctrl+V with nothing copied: `copyKey` is the label of the key that copies items, null when there is none (then the palette command is named). */
export function nothingCopiedNotice(copyKey: string | null): string {
  return copyKey ? `Nothing copied yet: select items and press ${copyKey}` : `Nothing copied yet: select items and run "${commandInfo('copyItems').title}" from the command palette`
}
