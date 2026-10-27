/**
 * Whether the clip track shows the audio waveform (E-04): a per-user view preference, on by
 * default. It is not part of the video, so it lives in localStorage, not in the project, and is
 * read synchronously, so the first paint never flashes.
 */
import { useSyncExternalStore } from 'react'

/** localStorage key of the toggle: 'off' hidden, anything else (or nothing) shown. */
const KEY = 'editor-waveform'

const listeners = new Set<() => void>()
/** The toggle's value while it could not be stored (storage blocked): kept for this session. */
let unstored: boolean | null = null

export function waveformShown(): boolean {
  if (unstored !== null) return unstored
  try {
    return localStorage.getItem(KEY) !== 'off'
  } catch {
    return true
  }
}

export function setWaveformShown(on: boolean): void {
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
export const useWaveformShown = (): boolean => useSyncExternalStore(subscribe, waveformShown)
