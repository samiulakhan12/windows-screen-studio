/**
 * Whether the clip track shows frames of the recording (E-07, docs/design/versions.md §3.3): a per-user view preference, on by
 * default. It is not part of the video, so it lives in localStorage, not in the project, and is
 * read synchronously, so the first paint never flashes.
 */
import { useSyncExternalStore } from 'react'

/** localStorage key of the toggle: 'off' hidden, anything else (or nothing) shown. */
const KEY = 'editor-filmstrip'

const listeners = new Set<() => void>()
/** The toggle's value while it could not be stored (storage blocked): kept for this session. */
let unstored: boolean | null = null

export function filmstripShown(): boolean {
  if (unstored !== null) return unstored
  try {
    return localStorage.getItem(KEY) !== 'off'
  } catch {
    return true
  }
}

export function setFilmstripShown(on: boolean): void {
  try {
    localStorage.setItem(KEY, on ? 'on' : 'off')
    unstored = null
  } catch {
    unstored = on
  }
  for (const l of [...listeners]) l()
}

function subscribe(l: () => void): () => void {
  listeners.add(l)
  return () => {
    listeners.delete(l)
  }
}

/** The toggle, re-rendering when it changes. */
export const useFilmstripShown = (): boolean => useSyncExternalStore(subscribe, filmstripShown)
