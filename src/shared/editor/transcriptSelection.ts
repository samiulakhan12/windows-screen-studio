/**
 * The selection in the Transcript tab (docs/design/edit-by-text.md §1): word indices, an anchor
 * where it started and a focus that moves. View state only, never saved. Pure, so the keys and
 * clicks are unit-tested.
 */
import type { TranscriptWord, WordSpan } from './transcript'

export interface WordSelection {
  anchor: number
  focus: number
}

/** The first and last selected word. */
export const selectionSpan = (sel: WordSelection): WordSpan => [Math.min(sel.anchor, sel.focus), Math.max(sel.anchor, sel.focus)]

/** A click on word `index`: that word alone, or (Shift) from the anchor to it. */
export function clickSelection(sel: WordSelection | null, index: number, shift: boolean): WordSelection {
  return shift && sel ? { anchor: sel.anchor, focus: index } : { anchor: index, focus: index }
}

export type SelectionKey = 'ArrowLeft' | 'ArrowRight' | 'ArrowUp' | 'ArrowDown' | 'Home' | 'End'

export const SELECTION_KEYS: readonly string[] = ['ArrowLeft', 'ArrowRight', 'ArrowUp', 'ArrowDown', 'Home', 'End']

/**
 * The selection after a key: Left/Right one word, Up/Down to the first word of the previous / next
 * caption (Up inside a caption goes to its own first word first), Home/End the first / last word.
 * With Shift the focus moves and the anchor stays; without it the new word is selected alone.
 * Null when there are no words.
 */
export function moveSelection(sel: WordSelection | null, key: SelectionKey, shift: boolean, words: readonly TranscriptWord[]): WordSelection | null {
  const n = words.length
  if (n === 0) return null
  const from = sel ? Math.min(Math.max(sel.focus, 0), n - 1) : -1
  let to: number
  if (from < 0) to = key === 'End' || key === 'ArrowLeft' || key === 'ArrowUp' ? n - 1 : 0
  else if (key === 'ArrowLeft') to = Math.max(0, from - 1)
  else if (key === 'ArrowRight') to = Math.min(n - 1, from + 1)
  else if (key === 'Home') to = 0
  else if (key === 'End') to = n - 1
  else if (key === 'ArrowDown') {
    to = from
    while (to < n && words[to].caption === words[from].caption) to++
    if (to >= n) to = n - 1
  } else {
    let first = from
    while (first > 0 && words[first - 1].caption === words[from].caption) first--
    if (first < from) to = first
    else if (first === 0) to = 0
    else {
      to = first - 1
      while (to > 0 && words[to - 1].caption === words[first - 1].caption) to--
    }
  }
  return shift && sel ? { anchor: sel.anchor, focus: to } : { anchor: to, focus: to }
}

/** Every word selected (Ctrl+A), or null when there are none. */
export const selectAll = (words: readonly TranscriptWord[]): WordSelection | null => (words.length ? { anchor: 0, focus: words.length - 1 } : null)

/** The selection still inside a word list of `n` words (a new transcript can be shorter), or null. */
export function validWordSelection(sel: WordSelection | null, n: number): WordSelection | null {
  if (!sel || n === 0) return null
  const fix = (i: number): number => Math.min(Math.max(i, 0), n - 1)
  const anchor = fix(sel.anchor)
  const focus = fix(sel.focus)
  return anchor === sel.anchor && focus === sel.focus ? sel : { anchor, focus }
}
