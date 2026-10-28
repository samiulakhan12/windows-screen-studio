/**
 * Whether the preview shows the apps' safe zones, and for which app (docs/design/vertical-video.md
 * §2.8): a per-user view preference, off by default. It is not part of the video, so it lives in
 * localStorage (key 'editor-safe-zones': 'off' or a SafeChoice; anything else is off), never in
 * the project, like the waveform toggle (waveformPref.ts), and is read synchronously, so the first
 * paint never flashes.
 */
import { useSyncExternalStore } from 'react'
import type { SafeChoice } from '../../../shared/render/safeZones'

/** localStorage key of the preference. */
const KEY = 'editor-safe-zones'
const VALUES: readonly string[] = ['off', 'all', 'tiktok', 'reels', 'shorts']

const listeners = new Set<() => void>()
/** The value while it could not be stored (storage blocked): kept for this session. */
let unstored: SafeChoice | 'off' | null = null
/** The app last shown in this session, so turning the zones off and on again (G) keeps it. */
let lastShown: SafeChoice = 'all'

const valid = (v: unknown): v is SafeChoice | 'off' => typeof v === 'string' && VALUES.includes(v)

export function safeZoneChoice(): SafeChoice | 'off' {
  if (unstored !== null) return unstored
  try {
    const v = localStorage.getItem(KEY)
    return valid(v) ? v : 'off'
  } catch {
    return 'off'
  }
}

export function setSafeZoneChoice(v: SafeChoice | 'off'): void {
  const next = valid(v) ? v : 'off'
  if (next !== 'off') lastShown = next
  try {
    localStorage.setItem(KEY, next)
    unstored = null
  } catch {
    unstored = next
  }
  for (const l of [...listeners]) l()
}

/** Shows the zones (the app last shown, All three at first) or hides them: the G key and the toggle under the preview. */
export function toggleSafeZones(): void {
  const cur = safeZoneChoice()
  if (cur !== 'off') lastShown = cur
  setSafeZoneChoice(cur === 'off' ? lastShown : 'off')
}

function subscribe(l: () => void): () => void {
  listeners.add(l)
  return () => {
    listeners.delete(l)
  }
}

/** The choice, re-rendering when it changes (in this window). */
export function useSafeZoneChoice(): SafeChoice | 'off' {
  return useSyncExternalStore(subscribe, safeZoneChoice)
}
