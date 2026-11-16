/**
 * What the editor says about selecting several items and acting on them (E-06,
 * docs/design/multi-select.md §5.6). Pure, so the wording is tested in one place.
 */
import { commandTitle } from './commands'
import { fmt } from '../i18n/fmt'
import { t, type MessageKey } from '../i18n/t'
import type { StopReason } from './groupMove'
import { groupLabel, parseItemKey, type ItemKey } from './multiSelect'

/** Kinds that stay one at a time, and why (§3). */
export type RefusedKind = 'clip' | 'click' | 'caption' | 'layout'

/** Why each kind stays one at a time, in the UI language (made when read, never when the module loads). */
export const REFUSAL_TEXT: Readonly<Record<RefusedKind, string>> = Object.freeze({
  get clip(): string {
    return t('editor.multiSelect.refusal.clip')
  },
  get click(): string {
    return t('editor.multiSelect.refusal.click', { command: commandTitle('findStrayClicks') })
  },
  get caption(): string {
    return t('editor.multiSelect.refusal.caption')
  },
  get layout(): string {
    return t('editor.multiSelect.refusal.layout')
  }
})

/** Why a group stops, as the end of "The selection stops here: …" and "Moved 0.6 s later: …". */
const STOP_WHY: Readonly<Record<Exclude<StopReason, 'freeze-in-cut' | 'full'>, MessageKey>> = {
  start: 'editor.multiSelect.why.start',
  end: 'editor.multiSelect.why.end',
  zoom: 'editor.multiSelect.why.zoom',
  'freeze-clip': 'editor.multiSelect.why.freezeClip',
  'freeze-taken': 'editor.multiSelect.why.freezeTaken'
}

/** The notice the first time a group drag is held back by a limit. */
export function stopNotice(why: StopReason): string {
  if (why === 'freeze-in-cut') return t('editor.multiSelect.freezeInCut')
  if (why === 'full') return t('editor.multiSelect.full')
  return t('editor.multiSelect.stopsHere', { why: t(STOP_WHY[why]) })
}

/** "0.6 s"; a move too short for that keeps a figure that is not 0 ("0.02 s", "less than 0.01 s"). */
const secs = (v: number): string => {
  const a = Math.abs(v)
  if (a >= 0.05) return `${fmt.number(+a.toFixed(1))} s`
  return a >= 0.005 ? `${fmt.number(+a.toFixed(2))} s` : t('editor.multiSelect.lessThan', { s: fmt.number(0.01) })
}

/** After Starts at or ±1 s: what happened when a limit cut the move short (null when it went as asked). */
export function movedNotice(moved: number, stopped: StopReason | null): string | null {
  if (!stopped) return null
  if (stopped === 'freeze-in-cut' || stopped === 'full') return stopNotice(stopped)
  const why = t(STOP_WHY[stopped])
  if (Math.abs(moved) < 1e-9) return t('editor.multiSelect.notMoved', { why })
  return t(moved > 0 ? 'editor.multiSelect.movedLater' : 'editor.multiSelect.movedEarlier', { s: secs(moved), why })
}

/** After Ctrl+A: "Selected all 12 text items · Ctrl + A again selects every item", "Selected every item (24)". */
export function selectAllNotice(scope: 'track' | 'all' | 'none', keys: readonly ItemKey[], againKey: string | null): string {
  if (scope === 'none') return t('editor.multiSelect.selectNone')
  if (scope === 'all') return t('editor.multiSelect.selectEvery', { n: fmt.count(keys.length) })
  const label = groupLabel(keys)
  // Shapes and spotlights share a track: more than one kind of item reads as items on the shapes track.
  const kinds = new Set(keys.map((k) => parseItemKey(k)?.kind).filter((k) => k !== undefined))
  const what = kinds.size > 1 ? t('editor.multiSelect.shapesTrack', { count: keys.length, n: fmt.count(keys.length) }) : label
  if (keys.length === 1) {
    const only = label.replace(/^1 /, '')
    return againKey ? t('editor.multiSelect.selectOnlyAgain', { what: only, keys: againKey }) : t('editor.multiSelect.selectOnly', { what: only })
  }
  return againKey ? t('editor.multiSelect.selectAllAgain', { what, keys: againKey }) : t('editor.multiSelect.selectAll', { what })
}

/** "Deleted 5 items" / "Cut 5 items", with the undo hint (keys.undoHint, which starts " · "). */
export function removedNotice(verb: 'Deleted' | 'Cut', n: number, undo: string): string {
  return `${t(verb === 'Deleted' ? 'editor.multiSelect.deleted' : 'editor.multiSelect.cut', { count: n, n: fmt.count(n) })}${undo}`
}

/**
 * Why there is no look to paste (Paste look's disabled reason and the notice), naming the key that
 * copies one: `copyKey` is its label from the user's keymap ("Ctrl + Shift + C"), null when the
 * command has none, and then the item's Copy look button is named instead.
 */
export function copyLookFirst(copyKey: string | null): string {
  return copyKey ? t('editor.multiSelect.copyLookFirst', { keys: copyKey }) : t('editor.multiSelect.copyLookFirstButton')
}

/** Ctrl+V with nothing copied: `copyKey` is the label of the key that copies items, null when there is none (then the palette command is named). */
export function nothingCopiedNotice(copyKey: string | null): string {
  return copyKey ? t('editor.multiSelect.nothingCopied', { keys: copyKey }) : t('editor.multiSelect.nothingCopiedPalette', { command: commandTitle('copyItems') })
}
