/**
 * The editor's two clipboards (E-06, docs/design/multi-select.md §2.3 D3, §8): copied items and a
 * copied look. They live in this window's memory for its session (across projects too) and are
 * never written to the system clipboard, so the user's text clipboard is left alone and nothing
 * from outside is ever read as items.
 */
import { useSyncExternalStore } from 'react'
import type { ItemClipboard } from '../../../shared/editor/groupClipboard'
import type { Look } from '../../../shared/editor/groupEdit'

interface Cell<T> {
  get(): T | null
  set(v: T): void
  subscribe(l: () => void): () => void
}

function cell<T>(): Cell<T> {
  let value: T | null = null
  const listeners = new Set<() => void>()
  return {
    get: () => value,
    set(v) {
      value = v
      for (const l of [...listeners]) l()
    },
    subscribe(l) {
      listeners.add(l)
      return () => {
        listeners.delete(l)
      }
    }
  }
}

export const itemClipboard: Cell<ItemClipboard> = cell<ItemClipboard>()
export const lookClipboard: Cell<Look> = cell<Look>()

/** The copied look, following changes (Paste look buttons enable and say what they would paste). */
export function useLookClipboard(): Look | null {
  return useSyncExternalStore(lookClipboard.subscribe, lookClipboard.get)
}
