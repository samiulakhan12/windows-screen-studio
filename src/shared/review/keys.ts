/**
 * The keys of Review mode's list (docs/design/review-mode.md §4.3): ↓/N next, ↑/P previous,
 * Home/End first and last, K keep, Delete/Backspace remove. Keys are read by name as the editor's
 * shortcuts read them (shortcuts.ts eventKeyName), so on another alphabet's layout the key where N
 * is still moves on, instead of going on to the editor as Snapping. Pure.
 */
import { eventKeyName, type KeyInput } from '../editor/shortcuts'

export type ListAction = 'next' | 'previous' | 'first' | 'last' | 'keep' | 'remove'

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

/** What a key pressed in the list does, or null when it goes on to the editor (Ctrl, Alt and Meta chords too). */
export function listKey(e: KeyInput): ListKey | null {
  if (e.ctrlKey || e.altKey || e.metaKey) return null
  const name = eventKeyName(e)
  return (name && LIST_KEYS.get(name)) || null
}
