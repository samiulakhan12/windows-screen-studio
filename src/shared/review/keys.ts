/**
 * The keys of Review mode's list (docs/design/review-mode.md §4.3): ↓/N next, ↑/P previous,
 * Home/End first and last, K keep, Delete/Backspace remove. Keys are read by name as the editor's
 * shortcuts read them (shortcuts.ts eventKeyName), so on another alphabet's layout the key where N
 * is still moves on, instead of going on to the editor as Snapping. Pure.
 */
import { eventKeyName, type KeyInput, type ShortcutIndex } from '../editor/shortcuts'
import type { ReviewKind } from './copy'

/** 'peek': V on a private row turns Peek while reviewing on and off (docs/design/auto-blur.md §2.8). */
export type ListAction = 'next' | 'previous' | 'first' | 'last' | 'keep' | 'remove' | 'peek'

export interface ListKey {
  action: ListAction
  /** Held down, it acts again (the arrows, Home and End); a held letter or Delete acts once. */
  again: boolean
}

const LIST_KEYS = new Map<string, ListKey>([
  ['Down', { action: 'next', again: true }],
  ['N', { action: 'next', again: false }],
  ['Up', { action: 'previous', again: true }],
  ['P', { action: 'previous', again: false }],
  ['Home', { action: 'first', again: true }],
  ['End', { action: 'last', again: true }],
  ['K', { action: 'keep', again: false }],
  ['Delete', { action: 'remove', again: false }],
  ['Backspace', { action: 'remove', again: false }]
])

/**
 * What a key pressed in the list does, or null when it goes on to the editor: Ctrl, Alt and Meta
 * chords, and Shift with a letter that has a shortcut of its own in `shortcuts` (Shift+P is
 * Polish). Shift with any other letter is the letter, as the editor reads it: Shift+N would be
 * Snapping there, so it moves on here.
 */
export function listKey(e: KeyInput, shortcuts: ShortcutIndex, selected?: { kind: ReviewKind } | null): ListKey | null {
  if (e.ctrlKey || e.altKey || e.metaKey) return null
  const name = eventKeyName(e)
  if (!name || (e.shiftKey && /^[A-Z]$/.test(name) && shortcuts.has(`Shift+${name}`))) return null
  // V peeks only on a private row; anywhere else it goes on to the editor as before.
  if (name === 'V') return !e.shiftKey && selected?.kind === 'private' ? { action: 'peek', again: false } : null
  return LIST_KEYS.get(name) ?? null
}
