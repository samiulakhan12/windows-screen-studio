/**
 * Whether the preview shows the apps' safe zones, and for which app (docs/design/vertical-video.md
 * §2.8): a per-user view preference, off by default. It is not part of the video, so it lives in
 * localStorage (key 'editor-safe-zones': 'off' or a SafeChoice; anything else is off), never in
 * the project, like the waveform toggle (waveformPref.ts).
 *
 * CONTRACT (part P3): signatures are frozen; bodies are to be written.
 */
import type { SafeChoice } from '../../../shared/render/safeZones'

export function safeZoneChoice(): SafeChoice | 'off' {
  throw new Error('not implemented')
}

export function setSafeZoneChoice(v: SafeChoice | 'off'): void {
  void v
  throw new Error('not implemented')
}

/** The choice, re-rendering when it changes (in this window). */
export function useSafeZoneChoice(): SafeChoice | 'off' {
  throw new Error('not implemented')
}
